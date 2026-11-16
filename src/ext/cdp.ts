/**
 * 页面读写走 chrome.debugger 的 CDP。
 * 快照来源是 DOMSnapshot.captureSnapshot 的列式数据: 一次调用同时给出结构、
 * 布局(可见性)、isClickable 和输入框实时值。
 * 渲染规则: 剥掉 id/class/style, 单链容器压进路径, 只留可交互 / 有 alt / 有文本的节点。
 */
import type { Act, View } from '../shared/protocol.ts'

export type Send = (method: string, params?: Record<string, unknown>) => Promise<unknown>

export const sender =
  (tabId: number): Send =>
  async (method, params) =>
    (await chrome.debugger.sendCommand({ tabId }, method, params)) ?? {}


/** 没有语义、只会制造噪音的标签。 */
const DROP = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'TEMPLATE',
  'HEAD',
  'META',
  'LINK',
  'TITLE',
  'BR',
  'PATH',
  'DEFS',
  'G',
  'RECT',
  'CIRCLE',
  'ELLIPSE',
  'LINE',
  'POLYGON',
  'POLYLINE',
  'USE',
  'MASK',
  'CLIPPATH',
  'LINEARGRADIENT',
  'RADIALGRADIENT',
  'STOP',
  'FILTER',
  'SYMBOL',
  'PATTERN',
])

const INTERACTIVE_TAGS = new Set([
  'A',
  'BUTTON',
  'INPUT',
  'SELECT',
  'TEXTAREA',
  'SUMMARY',
  'OPTION',
  'LABEL',
  'DETAILS',
])
const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'checkbox',
  'radio',
  'combobox',
  'menuitem',
  'tab',
  'switch',
  'option',
  'slider',
])
/** 会原样输出的属性; id/class/style/data-* 一律剥掉。 */
const KEEP_ATTRS = new Set([
  'href',
  'src',
  'alt',
  'role',
  'type',
  'placeholder',
  'title',
  'aria-label',
  'aria-expanded',
  'aria-checked',
  'checked',
  'disabled',
  'readonly',
  'name',
  'for',
  'value',
  'tabindex',
])
/** 空值只有这些属性才值得写成裸名字。 */
const BOOLEAN_ATTRS = new Set(['checked', 'disabled', 'readonly', 'required', 'selected', 'multiple', 'open'])

// ---- DOMSnapshot.captureSnapshot 的列式返回 ----
/** 稀疏列。协议里写的是 index/value, 实际应答可能是 indexes/values, 两种都认。 */
type Rare = {
  index?: number[]
  indexes?: number[]
  value?: number[]
  values?: number[]
}
export type NodesTable = {
  parentIndex: number[]
  nodeType: number[]
  nodeName: number[]
  nodeValue: number[]
  backendNodeId: number[]
  attributes: number[][]
  textValue?: Rare
  inputValue?: Rare
  isClickable?: Rare
  contentDocumentIndex?: Rare
  pseudoType?: Rare
}
export type SnapshotDoc = {
  nodes: NodesTable
  layout: { nodeIndex: number[]; styles?: number[][]; bounds?: number[][] }
}

const rareIndex = (r?: Rare): number[] => r?.indexes ?? r?.index ?? []
const rareValue = (r?: Rare): number[] => r?.values ?? r?.value ?? []

/** 一个 document 展开后的查询上下文。 */
type Ctx = {
  t: NodesTable
  layoutPos: Map<number, number>
  styles: number[][]
  bounds: number[][]
  clickable: Set<number>
  pseudo: Set<number>
  live: Map<number, string>
  frameDoc: Map<number, number>
  kids: number[][]
  strings: string[]
}

type Item = {
  /** 压缩后的标签路径, 如 p / div>p / div>div>p */
  label: string
  uid?: number | undefined
  props: string[]
  kids: Item[]
  /** 透明节点: 没有自己的行, 子节点不缩进 */
  ghost?: boolean
}

const squash = (s: string): string => s.replace(/\s+/g, ' ').trim()

const rareMap = (r: Rare | undefined, strings: string[]): Map<number, string> => {
  const idx = rareIndex(r)
  const val = rareValue(r)
  return new Map(idx.map((n, k) => [n, strings[val[k] ?? 0] ?? '']))
}

function contextOf(documents: SnapshotDoc[], docIndex: number, strings: string[]): Ctx | undefined {
  const doc = documents[docIndex]
  if (!doc) return undefined
  const t = doc.nodes
  const kids: number[][] = t.nodeType.map(() => [])
  for (let i = 1; i < t.nodeType.length; i += 1) {
    const p = t.parentIndex[i] ?? -1
    if (p >= 0 && p < kids.length) kids[p]?.push(i)
  }
  const live = rareMap(t.inputValue, strings)
  for (const [i, v] of rareMap(t.textValue, strings)) if (!live.has(i)) live.set(i, v)

  const layoutPos = new Map<number, number>()
  ;(doc.layout?.nodeIndex ?? []).forEach((node, pos) => layoutPos.set(node, pos))

  const frameIdx = rareIndex(t.contentDocumentIndex)
  const frameVal = rareValue(t.contentDocumentIndex)
  return {
    t,
    layoutPos,
    styles: doc.layout?.styles ?? [],
    bounds: doc.layout?.bounds ?? [],
    clickable: new Set(rareIndex(t.isClickable)),
    pseudo: new Set(rareIndex(t.pseudoType)),
    live,
    frameDoc: new Map(frameIdx.map((n, k) => [n, frameVal[k] ?? -1])),
    kids,
    strings,
  }
}

/** 没有布局盒不代表后代不可见 (如 display:contents)。 */
function hiddenReason(c: Ctx, i: number): string | undefined {
  const pos = c.layoutPos.get(i)
  if (pos === undefined) return 'no-layout'
  const style = c.styles[pos] ?? []
  if (c.strings[style[0] ?? -1] === 'hidden') return 'visibility'
  const opacity = c.strings[style[1] ?? -1]
  if (opacity !== undefined && Number(opacity) === 0) return 'opacity'
  const box = c.bounds[pos]
  if (box && ((box[2] ?? 0) === 0 || (box[3] ?? 0) === 0)) return 'size'
  return undefined
}

const tagOf = (c: Ctx, i: number): string => (c.strings[c.t.nodeName[i] ?? 0] ?? '').toUpperCase()
const typeOf = (c: Ctx, i: number): number => c.t.nodeType[i] ?? 0

function attrOf(c: Ctx, i: number): Map<string, string> {
  const m = new Map<string, string>()
  const raw = c.t.attributes[i] ?? []
  for (let j = 0; j + 1 < raw.length; j += 2) {
    const k = c.strings[raw[j] ?? 0]
    if (k) m.set(k.toLowerCase(), c.strings[raw[j + 1] ?? 0] ?? '')
  }
  return m
}

const hasHandler = (attrs: Map<string, string>): boolean => {
  for (const k of attrs.keys()) if (k.length > 2 && k.startsWith('on')) return true
  return false
}

/**
 * 控件: 自己承载语义, 名字取自后代, 并且不再铺后代。
 * 注意 isClickable 不算控件 —— html/body 因为事件委托永远"可点", 一旦当控件
 * 就会把整页文本吞成一个标签。
 */
function isControl(c: Ctx, i: number): boolean {
  const tag = tagOf(c, i)
  if (INTERACTIVE_TAGS.has(tag)) return true
  const attrs = attrOf(c, i)
  return (
    INTERACTIVE_ROLES.has((attrs.get('role') ?? '').toLowerCase()) ||
    hasHandler(attrs) ||
    attrs.has('tabindex') ||
    attrs.get('contenteditable') !== undefined
  )
}

/** 控件里是否还套着别的可点元素 (嵌套链接/按钮), 那种情况必须继续往下铺。 */
function hasNestedControl(c: Ctx, i: number, seen = new Set<number>()): boolean {
  if (seen.has(i)) return false
  seen.add(i)
  for (const child of c.kids[i] ?? []) {
    if (c.pseudo.has(child) || DROP.has(tagOf(c, child))) continue
    const why = hiddenReason(c, child)
    if (why && why !== 'no-layout') continue
    if (!why && typeOf(c, child) === 1 && (c.clickable.has(child) || isControl(c, child))) return true
    if (hasNestedControl(c, child, seen)) return true
  }
  return false
}

/** 控件的名字常在子节点里: <button><span>创作中心</span></button> */
function collectText(c: Ctx, root: number): string {
  const parts: string[] = []

  const walk = (i: number): void => {
    if (c.pseudo.has(i) || DROP.has(tagOf(c, i))) return
    const why = hiddenReason(c, i)
    if (why && why !== 'no-layout') return
    if (typeOf(c, i) === 3) {
      if (why) return
      const t = squash(c.strings[c.t.nodeValue[i] ?? 0] ?? '')
      if (t) parts.push(t)
      return
    }
    if (typeOf(c, i) === 1 && !why) {
      const alt = attrOf(c, i).get('alt')
      if (alt) {
        parts.push(alt)
        return
      }
    }
    for (const child of c.kids[i] ?? []) walk(child)
  }
  for (const child of c.kids[root] ?? []) walk(child)
  return squash(parts.join(' '))
}

function item(c: Ctx, i: number, documents: SnapshotDoc[], view: View, visited: Set<number>): Item | null {
  const type = typeOf(c, i)
  const tag = tagOf(c, i)
  if (c.pseudo.has(i) || DROP.has(tag)) return null
  const why = type === 1 ? hiddenReason(c, i) : undefined
  if (why && why !== 'no-layout') {
    return view.hidden ? { label: `${tag.toLowerCase()}(hidden:${why})`, props: [], kids: [] } : null
  }

  const attrs = type === 1 ? attrOf(c, i) : new Map<string, string>()
  const ownText = squash(
    (c.kids[i] ?? [])
      .filter((k) => typeOf(c, k) === 3 && !c.pseudo.has(k) && !hiddenReason(c, k))
      .map((k) => c.strings[c.t.nodeValue[k] ?? 0] ?? '')
      .join(' '),
  )
  const interactive = type === 1 && !why && isControl(c, i)
  const alt = why ? '' : attrs.get('alt') ?? ''
  // isClickable 只在叶子上算语义: 容器级(html/body/卡片)永远被事件委托标成可点,
  // 认了它就会把整页文本拼成一个标签, 或者给容器发一个没人会点的 uid
  const clickOnly = !why && c.clickable.has(i) && (c.kids[i] ?? []).every((k) => typeOf(c, k) === 3)
  const semantic = type === 1 && (interactive || clickOnly || alt !== '' || ownText !== '')

  // 控件不铺后代 (名字已经取自后代了), 除非里面还套着别的控件
  const kids: Item[] = []
  if (!interactive || hasNestedControl(c, i)) {
    for (const child of c.kids[i] ?? []) {
      const it = item(c, child, documents, view, visited)
      if (it) kids.push(it)
    }
  }

  // iframe: 内容在另一个 document 里
  const sub = c.frameDoc.get(i)
  if (sub !== undefined && sub >= 0 && !visited.has(sub)) {
    const subCtx = contextOf(documents, sub, c.strings)
    if (subCtx) {
      visited.add(sub)
      const it = item(subCtx, 0, documents, view, visited)
      if (it) kids.push(it)
    }
  }

  if (why && view.hidden && !semantic) return { label: `${tag.toLowerCase()}(hidden:${why})`, props: [], kids }

  if (!semantic) {
    // 没有语义的容器: 自己不成行。单链压进子节点的路径, 分叉的才留一层结构
    if (kids.length === 0) return null
    const only = kids[0]
    if (type !== 1) {
      // #document / shadow fragment 是透明的, 不进路径
      return kids.length === 1 && only ? only : { label: '', props: [], kids, ghost: true }
    }
    if (kids.length === 1 && only) {
      return { ...only, label: `${tag.toLowerCase()}>${only.label}` }
    }
    return { label: tag.toLowerCase(), props: [], kids }
  }

  const text = interactive ? collectText(c, i) : ownText
  const props: string[] = []
  // id/class 默认剥掉, 只有显式要求才带上; 既然要了就给完整值, class 截断了没法用于匹配
  if (view.id) {
    const v = attrs.get('id')
    if (v) props.push(`id="${v}"`)
  }
  if (view.class) {
    const v = attrs.get('class')
    if (v) props.push(`class="${v}"`)
  }
  if (text) props.push(`"${text}"`)
  if (alt) props.push(`alt="${alt}"`)
  const live = c.live.get(i)
  for (const [k, v] of attrs) {
    if (!KEEP_ATTRS.has(k) || k === 'alt' || (k === 'value' && live !== undefined)) continue
    if (v === '') {
      if (BOOLEAN_ATTRS.has(k)) props.push(k)
      continue
    }
    props.push(`${k}="${v}"`)
  }
  // 实时值覆盖 HTML 初始值, 包括用户清空后的空字符串。
  if (live !== undefined) props.push(`value="${live}"`)
  const handler = [...attrs.keys()].find((k) => k.startsWith('on'))
  if (handler) props.push(handler)

  const label = why && view.hidden ? `${tag.toLowerCase()}(hidden:${why})` : tag.toLowerCase()
  return { label, uid: why ? undefined : c.t.backendNodeId[i], props, kids }
}

function render(item: Item, depth: number, out: string[]): void {
  if (item.ghost) {
    for (const kid of item.kids) render(kid, depth, out)
    return
  }
  const head = item.uid === undefined ? item.label : `uid=${item.uid} ${item.label}`
  out.push('  '.repeat(depth) + [head, ...item.props].join(' '))
  for (const kid of item.kids) render(kid, depth + 1, out)
}

/** DOMSnapshot -> 文本。纯函数, 便于拿真实结构做回归测试。 */
export function renderSnapshot(documents: SnapshotDoc[], strings: string[], view: View = {}): string {
  const ctx = contextOf(documents, 0, strings)
  if (!ctx) return '(空页面)'
  const root = item(ctx, 0, documents, view, new Set([0]))
  if (!root) return '(没有可见内容)'
  const out: string[] = []
  render(root, 0, out)
  return out.join('\n')
}

export async function snapshot(send: Send, view: View = {}): Promise<string> {
  const raw = (await send('DOMSnapshot.captureSnapshot', {
    computedStyles: ['visibility', 'opacity'],
    includeDOMRects: false,
  })) as { documents?: SnapshotDoc[]; strings?: string[] }
  return renderSnapshot(raw.documents ?? [], raw.strings ?? [], view)
}

type EvalResult = {
  exceptionDetails?: { text?: string; exception?: { description?: string; objectId?: string } }
  result?: { type?: string; value?: unknown; objectId?: string; description?: string; unserializableValue?: string }
}

/** 结果可能是 DOM 节点 / jQuery 对象 / 普通值, 统一转成能读的字符串。 */
async function serialize(send: Send, raw: EvalResult): Promise<string> {
  const result = raw.result
  let out: EvalResult | undefined
  try {
    if (raw.exceptionDetails) {
      const d = raw.exceptionDetails
      throw new Error(d.exception?.description ?? d.text ?? '脚本抛异常')
    }
    if (!result) return ''
    if (result.objectId) {
      out = (await send('Runtime.callFunctionOn', {
        objectId: result.objectId,
        functionDeclaration: `function () {
          try {
            const one = (v) => (v instanceof Node ? v.outerHTML : String(v))
            if (this && this.jquery) return Array.from(this).map(one).join('\\n')
            if (this instanceof Node) return this.outerHTML
            return JSON.stringify(this)
          } catch (e) {
            return String(this)
          }
        }`,
        returnByValue: true,
      })) as EvalResult
      if (out.exceptionDetails) {
        const d = out.exceptionDetails
        throw new Error(d.exception?.description ?? d.text ?? '脚本结果序列化失败')
      }
      return out.result?.value === undefined ? '' : String(out.result.value)
    }
    if (result.type === 'undefined') return ''
    return 'value' in result ? String(result.value) : result.unserializableValue ?? result.description ?? ''
  } finally {
    const ids = new Set([result?.objectId, raw.exceptionDetails?.exception?.objectId,
      out?.result?.objectId, out?.exceptionDetails?.exception?.objectId])
    for (const objectId of ids) {
      // 导航可能已销毁上下文, 清理失败不能覆盖脚本结果或原始异常。
      if (objectId) await send('Runtime.releaseObject', { objectId }).catch(() => {})
    }
  }
}

/** 在页面主世界跑一段 JS。页面没有 jQuery 就先注入一份。 */
export async function runScript(send: Send, code: string): Promise<string> {
  const probe = (await send('Runtime.evaluate', {
    expression: 'typeof window.jQuery',
    returnByValue: true,
    timeout: 10_000,
  })) as EvalResult
  if ((await serialize(send, probe)) !== 'function') {
    const injected = (await send('Runtime.evaluate', {
      expression: __JQUERY__, returnByValue: false, timeout: 10_000,
    })) as EvalResult
    await serialize(send, injected)
  }

  const raw = (await send('Runtime.evaluate', {
    expression: code,
    returnByValue: false,
    awaitPromise: true,
    userGesture: true,
    timeout: 10_000,
  })) as EvalResult
  return serialize(send, raw)
}

/** 截当前视口或整页, 返回 PNG 的 base64。 */
export async function screenshot(send: Send, full: boolean): Promise<string> {
  let clip: Record<string, number> | undefined
  if (full) {
    const metrics = (await send('Page.getLayoutMetrics')) as {
      cssContentSize?: { x: number; y: number; width: number; height: number }
    }
    const size = metrics.cssContentSize
    if (!size || ![size.x, size.y, size.width, size.height].every(Number.isFinite) || size.width <= 0 || size.height <= 0) {
      throw new Error('整页截图失败: 没有有效的 CSS 页面尺寸')
    }
    clip = { x: size.x, y: size.y, width: size.width, height: size.height, scale: 1 }
  }
  const raw = (await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: full,
    ...(clip ? { clip } : {}),
  })) as { data?: string }
  if (!raw.data) throw new Error('截图失败: 没有拿到数据')
  return raw.data
}

const VK: Record<string, number> = {  Enter: 13,
  Tab: 9,
  Escape: 27,
  Backspace: 8,
  Delete: 46,
  ArrowUp: 38,
  ArrowDown: 40,
  ArrowLeft: 37,
  ArrowRight: 39,
}

const refToId = (ref: string): number => {
  const id = Number(ref)
  if (typeof ref !== 'string' || !/^[1-9]\d*$/.test(ref) || !Number.isSafeInteger(id)) {
    throw new Error('ref 必须是 /state 里的正整数 uid, 如 "142"')
  }
  return id
}

/** 取元素布局盒中心: 点这里等于用户点这里。 */
async function center(send: Send, backendNodeId: number): Promise<{ x: number; y: number }> {
  await send('DOM.scrollIntoViewIfNeeded', { backendNodeId })
  const model = (await send('DOM.getBoxModel', { backendNodeId })) as { model?: { content?: number[] } }
  const c = model.model?.content
  if (!c || c.length < 8) throw new Error('元素没有布局盒 (不可见或已脱离文档)')
  const xs = [0, 2, 4, 6].map((i) => c[i] ?? 0)
  const ys = [1, 3, 5, 7].map((i) => c[i] ?? 0)
  return {
    x: xs.reduce((a, b) => a + b, 0) / 4,
    y: ys.reduce((a, b) => a + b, 0) / 4,
  }
}

async function press(send: Send, key: string): Promise<void> {
  const code = VK[key]
  if (typeof code !== 'number') throw new Error(`不支持的 key: ${key} (支持 ${Object.keys(VK).join('/')})`)
  const base = { key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code }
  await send('Input.dispatchKeyEvent', { ...base, type: 'rawKeyDown' })
  if (key === 'Enter') await send('Input.dispatchKeyEvent', { ...base, type: 'char', text: '\r' })
  await send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' })
}

export async function act(send: Send, a: Act): Promise<void> {
  switch (a.op) {
    case 'click': {
      const { x, y } = await center(send, refToId(a.ref))
      const base = { x, y, button: 'left', clickCount: 1 }
      await send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed', buttons: 1 })
      await send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', buttons: 0 })
      return
    }
    case 'type': {
      if (typeof a.text !== 'string') throw new Error('type 需要 text')
      if (a.submit !== undefined && typeof a.submit !== 'boolean') throw new Error('submit 必须是 boolean')
      const id = refToId(a.ref)
      // DOM.focus 对不相交渲染的输入框会报 not focusable, 用真鼠标点一下更可靠
      const { x, y } = await center(send, id)
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 })
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 })
      // 先全选, 否则会追加到旧值后面
      await send('Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        key: 'a',
        code: 'KeyA',
        modifiers: 2,
        windowsVirtualKeyCode: 65,
      })
      await send('Input.insertText', { text: a.text })
      if (a.submit) await press(send, 'Enter')
      return
    }
    case 'key':
      return press(send, a.key)
    case 'scroll':
      if (typeof a.dy !== 'number' || !Number.isFinite(a.dy)) throw new Error('dy 必须是有限数值')
      await send('Runtime.evaluate', { expression: `scrollBy(0, ${a.dy})` })
      return
    case 'navigate': {
      let url: URL
      try {
        if (typeof a.url !== 'string') throw new Error()
        url = new URL(a.url)
      } catch {
        throw new Error('navigate 只接受有效的 http/https URL')
      }
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('navigate 只接受 http/https URL')
      await send('Page.navigate', { url: a.url })
      await new Promise((r) => setTimeout(r, 600))
      return
    }
    case 'wait':
      if (typeof a.ms !== 'number' || !Number.isFinite(a.ms) || a.ms < 0 || a.ms > 10_000) {
        throw new Error('wait ms 必须在 0..10000 范围内')
      }
      await new Promise((r) => setTimeout(r, a.ms))
      return
    default:
      throw new Error('不支持的 act 操作')
  }
}
