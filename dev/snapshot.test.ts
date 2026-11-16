import type { NodesTable, SnapshotDoc } from '../src/ext/cdp.ts'
/**
 * 快照渲染的回归测试: 喂 DOMSnapshot 的列式数据, 断言最终文本。
 * 跑法: node dev/snapshot.test.ts
 */
import assert from 'node:assert/strict'
import { renderSnapshot } from '../src/ext/cdp.ts'

const ELEMENT = 1
const TEXT = 3
const DOC = 9

interface Spec {
  type: number
  name: string
  value?: string
  attrs?: Record<string, string>
  clickable?: boolean
  /** inputValue / textValue */
  live?: string
  /** contentDocumentIndex 指向哪个 document */
  frame?: number
  parent: number
  /** 真正隐藏的子树没有任何布局盒。 */
  hidden?: boolean
  /** display:contents 等只有自己没有布局盒。 */
  noLayout?: boolean
  pseudo?: boolean
  vis?: string
  opacity?: string
  zeroSize?: boolean
}

function fixture(specs: Spec[]): { doc: SnapshotDoc, strings: string[] } {
  const strings: string[] = []
  const sid = (s: string): number => {
    const at = strings.indexOf(s)
    if (at >= 0)
      return at
    strings.push(s)
    return strings.length - 1
  }

  const nodes: NodesTable = {
    parentIndex: [],
    nodeType: [],
    nodeName: [],
    nodeValue: [],
    backendNodeId: [],
    attributes: [],
  }
  const layout: number[] = []
  const styles: number[][] = []
  const bounds: number[][] = []
  const clickable: number[] = []
  const liveIdx: number[] = []
  const liveVal: number[] = []
  const frameIdx: number[] = []
  const frameVal: number[] = []
  const pseudo: number[] = []
  const hidden: boolean[] = []

  specs.forEach((s, i) => {
    nodes.parentIndex.push(s.parent)
    nodes.nodeType.push(s.type)
    nodes.nodeName.push(sid(s.name))
    nodes.nodeValue.push(sid(s.value ?? ''))
    nodes.backendNodeId.push(100 + i)
    nodes.attributes.push(Object.entries(s.attrs ?? {}).flatMap(([k, v]) => [
      sid(k),
      sid(v),
    ]))
    if (s.clickable)
      clickable.push(i)
    if (s.live !== undefined) {
      liveIdx.push(i)
      liveVal.push(sid(s.live))
    }
    if (s.frame !== undefined) {
      frameIdx.push(i)
      frameVal.push(s.frame)
    }
    if (s.pseudo)
      pseudo.push(i)
    hidden[i] = Boolean(s.hidden || hidden[s.parent])
    if (!hidden[i] && !s.noLayout) {
      layout.push(i)
      styles.push([
        sid(s.vis ?? 'visible'),
        sid(s.opacity ?? '1'),
      ])
      bounds.push([
        0,
        0,
        s.zeroSize ? 0 : 100,
        20,
      ])
    }
  })

  return {
    doc: {
      nodes: {
        ...nodes,
        isClickable: { indexes: clickable },
        inputValue: { indexes: liveIdx, values: liveVal },
        contentDocumentIndex: { indexes: frameIdx, values: frameVal },
        pseudoType: {
          indexes: pseudo,
          values: pseudo.map(() => sid('before')),
        },
      },
      layout: { nodeIndex: layout, styles, bounds },
    },
    strings,
  }
}

const LONG_TEXT = '这是一段很长的正文'.repeat(20)
const LONG_TITLE = '很长的标题'.repeat(20)

const main: Spec[] = [
  { type: DOC, name: '#document', parent: -1 },
  { type: ELEMENT, name: 'html', parent: 0 },
  { type: ELEMENT, name: 'head', parent: 1 },
  { type: ELEMENT, name: 'style', parent: 2 },
  {
    type: TEXT,
    name: '#text',
    value: 'body{}',
    parent: 3,
  },
  // body 永远被事件委托标成 isClickable, 不能因此把整页文本吞成一个标签
  {
    type: ELEMENT,
    name: 'body',
    parent: 1,
    clickable: true,
  },

  // 用户给的例子: 单链压进路径, 分叉留一层
  { type: ELEMENT, name: 'div', parent: 5 },
  { type: ELEMENT, name: 'div', parent: 6 },
  { type: ELEMENT, name: 'p', parent: 7 },
  {
    type: TEXT,
    name: '#text',
    value: 'nihao',
    parent: 8,
  },
  { type: ELEMENT, name: 'div', parent: 6 },
  { type: ELEMENT, name: 'div', parent: 10 },
  { type: ELEMENT, name: 'p', parent: 11 },
  {
    type: TEXT,
    name: '#text',
    value: 'nihao',
    parent: 12,
  },

  // 只挂 onclick, 没有 role
  {
    type: ELEMENT,
    name: 'div',
    attrs: { class: 'btn', onclick: 'go()' },
    parent: 5,
  },
  {
    type: TEXT,
    name: '#text',
    value: '换一换',
    parent: 14,
  },
  // 什么属性都没有, 但浏览器说它可点
  {
    type: ELEMENT,
    name: 'div',
    clickable: true,
    parent: 5,
  },
  {
    type: TEXT,
    name: '#text',
    value: '点我',
    parent: 16,
  },
  {
    type: ELEMENT,
    name: 'input',
    attrs: {
      id: 'search-input',
      class: `ipt main ${'x'.repeat(120)}`,
      type: 'text',
      placeholder: '搜索',
    },
    live: '实时值',
    parent: 5,
  },
  // 名字在子节点里的按钮
  { type: ELEMENT, name: 'button', parent: 5 },
  { type: ELEMENT, name: 'span', parent: 19 },
  {
    type: TEXT,
    name: '#text',
    value: '创作中心',
    parent: 20,
  },
  {
    type: ELEMENT,
    name: 'img',
    attrs: { src: '/cover.jpg', alt: '封面图' },
    parent: 5,
  },

  // 样式表隐藏: 没有布局盒
  {
    type: ELEMENT,
    name: 'div',
    hidden: true,
    parent: 5,
  },
  {
    type: TEXT,
    name: '#text',
    value: '不该出现',
    parent: 23,
  },
  {
    type: ELEMENT,
    name: 'iframe',
    frame: 1,
    parent: 5,
  },
  { type: ELEMENT, name: 'script', parent: 5 },
  {
    type: TEXT,
    name: '#text',
    value: 'void 0',
    parent: 26,
  },

  // 有布局盒但 CSS 上不可见
  {
    type: ELEMENT,
    name: 'div',
    vis: 'hidden',
    parent: 5,
  },
  {
    type: TEXT,
    name: '#text',
    value: '隐-不可见',
    parent: 28,
  },
  {
    type: ELEMENT,
    name: 'div',
    opacity: '0',
    parent: 5,
  },
  {
    type: TEXT,
    name: '#text',
    value: '透-不可见',
    parent: 30,
  },
  {
    type: ELEMENT,
    name: 'div',
    zeroSize: true,
    parent: 5,
  },
  {
    type: TEXT,
    name: '#text',
    value: '零-不可见',
    parent: 32,
  },

  // 长文本 / 长 title 一律不截断
  {
    type: ELEMENT,
    name: 'p',
    attrs: { title: LONG_TITLE },
    parent: 5,
  },
  {
    type: TEXT,
    name: '#text',
    value: LONG_TEXT,
    parent: 34,
  },
]

const framed: Spec[] = [
  { type: DOC, name: '#document', parent: -1 },
  { type: ELEMENT, name: 'html', parent: 0 },
  { type: ELEMENT, name: 'body', parent: 1 },
  { type: ELEMENT, name: 'button', parent: 2 },
  {
    type: TEXT,
    name: '#text',
    value: '跨域的按钮',
    parent: 3,
  },
]

const a = fixture(main)
const b = fixture(framed)
const docs = [a.doc, b.doc]
// 两份固件共用一张字符串表。
const merged = [...a.strings]
const remap = b.strings.map((s) => {
  const at = merged.indexOf(s)
  if (at >= 0)
    return at
  merged.push(s)
  return merged.length - 1
})
for (const key of ['nodeName', 'nodeValue'] as const) {
  b.doc.nodes[key] = b.doc.nodes[key].map(v => remap[v] ?? 0)
}
for (const raw of b.doc.nodes.attributes) {
  for (let j = 0; j < raw.length; j += 1) raw[j] = remap[raw[j] ?? 0] ?? 0
}
for (const style of b.doc.layout.styles ?? []) {
  for (let j = 0; j < style.length; j += 1) style[j] = remap[style[j] ?? 0] ?? 0
}

const out = renderSnapshot(docs, merged)
const lines = out.split('\n')
console.log(out)
console.log('---')

const has = (re: RegExp) => lines.some(l => re.test(l))

// 结构
assert.ok(has(/^html>body$/), `body 被事件委托标成 isClickable, 但不该因此变成控件; 首行 ${lines[0]}`)
assert.ok(has(/^\s+uid=\d+ div>p "nihao"$/), 'div>p 应压成一行')
assert.ok(has(/^\s+uid=\d+ div>div>p "nihao"$/), 'div>div>p 应压成一行')
assert.equal(lines.filter(l => l.trim() === 'div').length, 1, '分叉容器留一行分组')
assert.ok(!out.includes('#document'), 'document 不进路径')

// 可交互判定
assert.ok(has(/\bdiv "换一换" onclick\b/), '只挂 onclick 的 div 要保留并标 onclick')
assert.ok(has(/\bdiv "点我"$/), '浏览器说可点 (isClickable) 的 div 也要保留')

// 属性
assert.ok(out.includes('value="实时值"'), 'inputValue 应补成实时值')
assert.ok(out.includes('placeholder="搜索"'), 'placeholder 保留')
assert.ok(!out.includes('body{}') && !out.includes('void 0'), 'script/style 整棵丢掉')
assert.ok(out.includes(`"${LONG_TEXT}"`), '长文本必须完整, 不许截断')
assert.ok(out.includes(`title="${LONG_TITLE}"`), '长 title 必须完整, 不许截断')
assert.ok(!out.includes('不该出现'), '没有布局盒的元素整棵丢掉')
assert.ok(!out.includes('隐-不可见'), 'visibility:hidden 要丢掉')
assert.ok(!out.includes('透-不可见'), 'opacity:0 要丢掉')
assert.ok(!out.includes('零-不可见'), '零尺寸要丢掉')

// 诊断开关: 把被判不可见的也列出来, 并标原因
const diag = renderSnapshot(docs, merged, { hidden: true })
assert.ok(diag.includes('(hidden:no-layout)'), '诊断应标出没有布局盒')
assert.ok(diag.includes('(hidden:visibility)'), '诊断应标出 visibility')
assert.ok(diag.includes('(hidden:opacity)'), '诊断应标出 opacity')
assert.ok(diag.includes('(hidden:size)'), '诊断应标出零尺寸')
assert.ok(!out.includes('(hidden:'), '默认不该出现诊断标记')

// 控件不重复铺后代
assert.equal(lines.filter(l => l.includes('创作中心')).length, 1, 'span 不该另起一行')
assert.ok(has(/\bbutton "创作中心"/), 'span 里的文字要上提到 button')

// iframe
assert.ok(out.includes('跨域的按钮'), 'iframe 内容必须拿到')

// id/class 默认剥掉, 显式要求才带
assert.ok(!out.includes('search-input') && !out.includes('ipt main'), '默认不该出现 id/class')
const withAll = renderSnapshot(docs, merged, { id: true, class: true })
assert.ok(withAll.includes('id="search-input"'), 'with-id 应带出 id')
assert.ok(withAll.includes(`class="ipt main ${'x'.repeat(120)}"`), 'class 必须完整, 不许截断')
const withId = renderSnapshot(docs, merged, { id: true })
assert.ok(withId.includes('id="search-input"') && !withId.includes('ipt main'), '只开 id 时不带 class')

// 协议规范的 index/value 与 Chrome 常见的 indexes/values 必须等价。
const singularDocs = docs.map((doc) => {
  const nodes = { ...doc.nodes }
  for (const key of [
    'inputValue',
    'textValue',
    'isClickable',
    'contentDocumentIndex',
    'pseudoType',
  ] as const) {
    const rare = nodes[key]
    if (rare)
      nodes[key] = { index: rare.indexes ?? [], value: rare.values ?? [] }
  }
  return { ...doc, nodes }
})
assert.equal(renderSnapshot(singularDocs, merged), out)

const values = fixture([
  { type: DOC, name: '#document', parent: -1 },
  {
    type: ELEMENT,
    name: 'input',
    attrs: { value: '旧 HTML 值' },
    live: '用户新值',
    parent: 0,
  },
  {
    type: ELEMENT,
    name: 'input',
    attrs: { value: '已清空的旧值' },
    live: '',
    parent: 0,
  },
  {
    type: ELEMENT,
    name: 'textarea',
    live: '多行实时值',
    parent: 0,
  },
])
const input = values.doc.nodes.inputValue!
values.doc.nodes.textValue = {
  index: [3],
  value: [input.values![2]!],
}
values.doc.nodes.inputValue = {
  index: input.indexes!.slice(0, 2),
  value: input.values!.slice(0, 2),
}
const liveOut = renderSnapshot([values.doc], values.strings)
assert.ok(liveOut.includes('value="用户新值"') && !liveOut.includes('旧 HTML 值'), '实时值覆盖旧 value 属性')
assert.ok(liveOut.includes('value=""') && !liveOut.includes('已清空的旧值'), '空实时值同样覆盖旧属性')
assert.ok(liveOut.includes('value="多行实时值"'), 'textValue 的规范稀疏列名称也应解析')
assert.equal((liveOut.match(/value=/g) ?? []).length, 3, '每个控件只输出一个 value')

const contents = fixture([
  { type: DOC, name: '#document', parent: -1 },
  {
    type: ELEMENT,
    name: 'div',
    noLayout: true,
    parent: 0,
  },
  {
    type: ELEMENT,
    name: 'div',
    noLayout: true,
    parent: 1,
  },
  { type: ELEMENT, name: 'p', parent: 2 },
  {
    type: TEXT,
    name: '#text',
    value: 'contents 的可见后代',
    parent: 3,
  },
  {
    type: ELEMENT,
    name: 'div',
    hidden: true,
    parent: 1,
  },
  {
    type: TEXT,
    name: '#text',
    value: '真正隐藏的后代',
    parent: 5,
  },
  {
    type: ELEMENT,
    name: 'span',
    noLayout: true,
    parent: 1,
  },
  {
    type: TEXT,
    name: '#text',
    value: 'contents 直接可见文本',
    parent: 7,
  },
  { type: ELEMENT, name: 'button', parent: 2 },
  {
    type: TEXT,
    name: '#text',
    value: 'contents 可见按钮',
    parent: 9,
  },
])
for (const view of [
  {},
  { hidden: true },
]) {
  const rendered = renderSnapshot([contents.doc], contents.strings, view)
  assert.ok(rendered.includes('contents 的可见后代'), '多层无布局容器不可裁掉可见后代')
  assert.ok(rendered.includes('contents 可见按钮'), '无布局容器内控件仍应可操作')
  assert.ok(rendered.includes('contents 直接可见文本'), '诊断视图也不能吞无布局容器的可见直接文本')
  assert.ok(!rendered.includes('真正隐藏的后代'), '真正无布局的子树仍应裁掉文本')
}

const names = fixture([
  { type: DOC, name: '#document', parent: -1 },
  { type: ELEMENT, name: 'button', parent: 0 },
  {
    type: TEXT,
    name: '#text',
    value: '可见直接文本',
    parent: 1,
  },
  { type: ELEMENT, name: 'span', parent: 1 },
  {
    type: TEXT,
    name: '#text',
    value: '可见子文本',
    parent: 3,
  },
  { type: ELEMENT, name: 'script', parent: 1 },
  {
    type: TEXT,
    name: '#text',
    value: '泄漏 SCRIPT',
    parent: 5,
  },
  { type: ELEMENT, name: 'style', parent: 1 },
  {
    type: TEXT,
    name: '#text',
    value: '泄漏 STYLE',
    parent: 7,
  },
  { type: ELEMENT, name: 'template', parent: 1 },
  {
    type: TEXT,
    name: '#text',
    value: '泄漏 TEMPLATE',
    parent: 9,
  },
  {
    type: ELEMENT,
    name: 'span',
    hidden: true,
    parent: 1,
  },
  {
    type: TEXT,
    name: '#text',
    value: '泄漏 display:none',
    parent: 11,
  },
  {
    type: ELEMENT,
    name: 'span',
    vis: 'hidden',
    parent: 1,
  },
  {
    type: TEXT,
    name: '#text',
    value: '泄漏 visibility',
    parent: 13,
  },
  {
    type: ELEMENT,
    name: 'span',
    opacity: '0',
    parent: 1,
  },
  {
    type: TEXT,
    name: '#text',
    value: '泄漏 opacity',
    parent: 15,
  },
  {
    type: ELEMENT,
    name: 'span',
    zeroSize: true,
    parent: 1,
  },
  {
    type: TEXT,
    name: '#text',
    value: '泄漏 size',
    parent: 17,
  },
  {
    type: ELEMENT,
    name: 'span',
    noLayout: true,
    parent: 1,
  },
  { type: ELEMENT, name: 'span', parent: 19 },
  {
    type: TEXT,
    name: '#text',
    value: 'contents 名称',
    parent: 20,
  },
  {
    type: ELEMENT,
    name: 'img',
    attrs: { alt: '泄漏隐藏图' },
    hidden: true,
    parent: 1,
  },
  {
    type: ELEMENT,
    name: 'img',
    attrs: { alt: '可见图' },
    parent: 1,
  },
  {
    type: ELEMENT,
    name: 'span',
    pseudo: true,
    parent: 1,
  },
  {
    type: TEXT,
    name: '#text',
    value: '泄漏伪元素',
    parent: 24,
  },
  {
    type: ELEMENT,
    name: 'button',
    hidden: true,
    parent: 1,
  },
  {
    type: TEXT,
    name: '#text',
    value: '泄漏隐藏控件',
    parent: 26,
  },
])
const named = renderSnapshot([names.doc], names.strings)
assert.match(named, /button "可见直接文本 可见子文本 contents 名称 可见图"/)
assert.ok(!named.includes('泄漏'), 'collectText 不得泄漏 DROP / 隐藏 / 伪元素后代')
assert.equal(named.split('\n').length, 1, '隐藏嵌套控件不应使普通按钮展开后代')
names.doc.nodes.pseudoType = {
  index: [24],
  value: [],
}
assert.equal(renderSnapshot([names.doc], names.strings), named, '两种 pseudoType 稀疏列名称等价')

const nested = fixture([
  { type: DOC, name: '#document', parent: -1 },
  { type: ELEMENT, name: 'button', parent: 0 },
  {
    type: 11,
    name: '#document-fragment',
    noLayout: true,
    parent: 1,
  },
  {
    type: ELEMENT,
    name: 'div',
    noLayout: true,
    parent: 2,
  },
  {
    type: ELEMENT,
    name: 'a',
    attrs: { href: '/nested' },
    parent: 3,
  },
  {
    type: TEXT,
    name: '#text',
    value: '内部链接',
    parent: 4,
  },
  {
    type: TEXT,
    name: '#text',
    value: '外层名称',
    parent: 1,
  },
  {
    type: ELEMENT,
    name: 'input',
    live: '影子输入值',
    parent: 2,
  },
])
const nestedOut = renderSnapshot([nested.doc], nested.strings)
assert.match(nestedOut, /uid=101 button/)
assert.match(nestedOut, /uid=104 div>a "内部链接" href="\/nested"/)
assert.match(nestedOut, /uid=107 input value="影子输入值"/)
assert.ok(!nestedOut.includes('#document-fragment'), '影子 fragment 应透明且不吞嵌套控件')
assert.equal(renderSnapshot([], []), '(空页面)')

console.log(`ok  ${lines.length} 行: 原快照回归 + 实时值覆盖/contents/文本裁剪/稀疏列/影子嵌套控件`)
