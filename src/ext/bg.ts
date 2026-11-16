/** 单个全局 tab 授权；浏览器内部页只允许导航到 http/https。 */
import type { Reply, Request } from '../shared/protocol.ts'
import { isRecord, isRequest, isToken } from '../shared/protocol.ts'
import { act, runScript, screenshot, sender, snapshot } from './cdp.ts'

const KEY = 'handover'
const OFFSCREEN = 'offscreen.html'
const MAX_SEEN = 1024

type Session = {
  tabId: number
  token: string
  epoch: number
  attached: boolean
  suspended: boolean
  attachError: string
  seen: Map<string, number>
}
type Attach = { ok: true } | { ok: false; error: string }

let session: Session | undefined
let pending: Session | undefined
let retiring: Session | undefined
let epoch = 0
let lifecycle: Promise<unknown> = Promise.resolve()
let executing = false

const err = (e: unknown): string => e instanceof Error ? e.message : String(e)
const tabId = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function serial<T>(work: () => Promise<T>): Promise<T> {
  const result = lifecycle.then(work)
  lifecycle = result.catch(() => {})
  return result
}

function checkEpoch(s: Session): void {
  if (s.epoch !== epoch) throw new Error('接管已撤销或切换，旧命令不会重试')
}

function check(s: Session, request: Request): void {
  checkEpoch(s)
  if (session !== s || s.token !== request.token) throw new Error('接管已撤销或切换，旧命令不会重试')
  if (s.suspended) throw new Error('调试器已断开，正在核对授权')
  if (request.deadline <= Date.now()) throw new Error('命令已过期；已开始的操作不能保证回滚，请勿自动重试')
}

function revoke(): Session | undefined {
  const old = session
  session = undefined
  epoch += 1
  return old
}

async function save(s?: Session): Promise<void> {
  if (s) await chrome.storage.session.set({ [KEY]: { tabId: s.tabId, token: s.token } })
  else await chrome.storage.session.remove(KEY)
}

async function ensureOffscreen(): Promise<void> {
  if (await chrome.offscreen.hasDocument()) return
  await chrome.offscreen.createDocument({
    url: OFFSCREEN,
    reasons: ['WORKERS'],
    justification: '按需轮询临时 CLI 命令；不运行常驻桥接服务',
  })
}

/** 清理全部尝试；真实 detach 失败不能带着旧调试器继续接管新 tab。 */
async function cleanup(s: Session | undefined = retiring): Promise<void> {
  const errors: string[] = []
  try { await save() } catch (e) { errors.push(err(e)) }
  await chrome.runtime.sendMessage({ type: 'DISCONNECT' }).catch(() => {})
  if (s?.attached) {
    retiring = s
    try {
      await chrome.debugger.detach({ tabId: s.tabId })
      s.attached = false
    } catch (e) {
      if (/not attached|No tab with|Invalid tab/i.test(err(e))) s.attached = false
      else {
        try {
          const targets = await chrome.debugger.getTargets()
          if (targets.some((target) => target.tabId === s.tabId && target.attached)) errors.push(err(e))
          else s.attached = false
        } catch (probeError) { errors.push(err(probeError)) }
      }
    }
    if (!s.attached && retiring === s) retiring = undefined
  }
  try {
    if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument()
  } catch (e) { errors.push(err(e)) }
  if (errors.length) throw new Error(`接管清理失败: ${errors.join('; ')}`)
}

async function ensureAttach(s: Session, guard: () => void): Promise<Attach> {
  guard()
  if (s.attached) return { ok: true }
  const tab = await chrome.tabs.get(s.tabId)
  guard()
  try {
    await chrome.debugger.attach({ tabId: s.tabId }, '1.3')
    s.attached = true
    guard()
    s.attachError = ''
    return { ok: true }
  } catch (e) {
    guard()
    const message = err(e)
    if (/Another debugger/i.test(message)) throw new Error('这个标签页已开着 DevTools，关掉后再接管')
    // 只有明确的浏览器内部页可降级；普通网页的权限/调试器错误不能伪装成成功。
    if (!/^(?:chrome|edge|about|devtools|chrome-search|chrome-native):/i.test(tab.url ?? tab.pendingUrl ?? '')) throw e
    s.attachError = message
    return { ok: false, error: message }
  }
}

async function ownsAttachment(s: Session, guard: () => void): Promise<boolean> {
  guard()
  try {
    await chrome.debugger.sendCommand({ tabId: s.tabId }, 'Runtime.evaluate', { expression: 'void 0', returnByValue: true, timeout: 1000, disableBreaks: true })
    guard()
    return true
  } catch {
    guard()
    return false
  }
}

function status(id: number) {
  if (!session) return { ok: true, state: 'idle' as const }
  if (session.tabId !== id) return { ok: true, state: 'other' as const }
  return { ok: true, state: 'current' as const, tabId: id, token: session.token, blocked: !session.attached }
}

async function activate(id: number, token: string, mine: number, restoring = false) {
  const s: Session = { tabId: id, token, epoch: mine, attached: false, suspended: false, attachError: '', seen: new Map() }
  pending = s
  try {
    if (restoring) {
      const targets = await chrome.debugger.getTargets()
      s.attached = targets.some((target) => target.tabId === id && target.attached)
      checkEpoch(s)
      if (s.attached) s.attached = await ownsAttachment(s, () => checkEpoch(s))
    }
    await ensureAttach(s, () => checkEpoch(s))
    checkEpoch(s)
    await ensureOffscreen()
    checkEpoch(s)
    await save(s)
    checkEpoch(s)
    if (s.attached && !await ownsAttachment(s, () => checkEpoch(s))) throw new Error('调试器已断开，请重新授权')
    session = s
    const connected: unknown = await chrome.runtime.sendMessage({ type: 'CONNECT', token })
    checkEpoch(s)
    if (!isRecord(connected) || connected.ok !== true) throw new Error('无法启动扩展命令轮询')
    return status(id)
  } catch (e) {
    if (session === s) revoke()
    try { await cleanup(s) } catch (cleanupError) { throw new Error(`${err(e)}; ${err(cleanupError)}`) }
    throw e
  } finally {
    if (pending === s) pending = undefined
  }
}

function start(id: number) {
  const old = revoke()
  const mine = epoch
  return serial(async () => {
    await cleanup(old)
    if (mine !== epoch) throw new Error('接管请求已被更新的操作取消')
    return activate(id, crypto.randomUUID().replace(/-/g, ''), mine)
  })
}

function stop(id: number, token: string) {
  if (!session || session.tabId !== id || session.token !== token) {
    return Promise.reject(new Error('会话已撤销或切换，未停止其他接管'))
  }
  const old = revoke()
  return serial(async () => {
    await cleanup(old)
    return { ok: true }
  })
}

function stopTab(id: number): void {
  if (session?.tabId !== id && pending?.tabId !== id) return
  const old = revoke()
  void serial(() => cleanup(old)).catch((e: unknown) => console.error(err(e)))
}

const blockedHint = (s: Session): string => [
  '[page] 当前标签页是浏览器内部页面，无法读取内容。',
  `原因: ${s.attachError || '调试器无法附加'}`,
  '标签页授权仍有效；只能通过 navigate 操作导航到 http/https 网页后再读取。',
].join('\n')

async function exec(value: unknown): Promise<Reply> {
  const id = isRecord(value) && typeof value.id === 'string' ? value.id : ''
  if (!isRequest(value)) return { id, ok: false, error: '无效命令协议' }
  const request = value
  // 唤醒 SW 的首条命令可能早于 storage 恢复，不能误拒绝有效授权。
  await bootReady
  const s = session
  if (!s || s.token !== request.token) return { id, ok: false, error: 'Token 已撤销或不属于当前接管' }
  try {
    check(s, request)
    const now = Date.now()
    for (const [seenId, deadline] of s.seen) if (deadline <= now) s.seen.delete(seenId)
    if (s.seen.has(id)) throw new Error('命令重复，未再次执行')
    // 不淘汰未过期 id，避免有界缓存被刷满后重复执行旧命令。
    if (s.seen.size >= MAX_SEEN) throw new Error('命令去重缓存已满，请等待已有命令过期')
    s.seen.set(id, request.deadline)
    if (executing) throw new Error('前一命令尚未结束，未执行新命令；请勿自动重试')
  } catch (e) { return { id, ok: false, error: err(e) } }

  executing = true
  try {
    const attached = await serial(() => ensureAttach(s, () => check(s, request)))
    check(s, request)
    const command = request.command
    if (!attached.ok) {
      if (command.kind === 'state') return { id, ok: true, data: blockedHint(s) }
      if (command.kind !== 'act' || command.act.op !== 'navigate') throw new Error('浏览器内部页无法执行此操作；只允许 navigate 到 http/https 网页')
      const url = command.act.url
      if (!['http:', 'https:'].includes(new URL(url).protocol)) throw new Error('navigate 只接受 http/https URL')
      await serial(async () => {
        check(s, request)
        await chrome.tabs.update(s.tabId, { url })
        check(s, request)
        await sleep(600)
        const probe = await ensureAttach(s, () => check(s, request))
        if (!probe.ok) throw new Error(`导航后仍无法附加调试器: ${probe.error}`)
      })
      check(s, request)
      return { id, ok: true, data: 'ok' }
    }

    const rawSend = sender(s.tabId)
    const send: typeof rawSend = async (method, params) => {
      check(s, request)
      const result = await rawSend(method, params)
      check(s, request)
      return result
    }
    let data: string
    if (command.kind === 'state') data = await snapshot(send, command.view)
    else if (command.kind === 'script') data = await runScript(send, command.code)
    else if (command.kind === 'screenshot') data = await screenshot(send, command.full)
    else { await act(send, command.act); data = 'ok' }
    check(s, request)
    return { id, ok: true, data }
  } catch (e) {
    return { id, ok: false, error: err(e) }
  } finally { executing = false }
}

chrome.runtime.onMessage.addListener((msg: unknown, source, respond) => {
  if (!isRecord(msg) || source.id !== chrome.runtime.id || source.tab) return
  if (msg.type === 'EXEC') {
    if (source.url !== chrome.runtime.getURL(OFFSCREEN)) return
    void exec(msg.request).then(respond)
    return true
  }
  if (source.url !== chrome.runtime.getURL('popup.html')) return
  let result: Promise<unknown>
  if (msg.type === 'START' && tabId(msg.tabId)) result = start(msg.tabId)
  else if (msg.type === 'STOP' && tabId(msg.tabId) && isToken(msg.token)) result = stop(msg.tabId, msg.token)
  else if (msg.type === 'PING' && tabId(msg.tabId)) result = serial(async () => status(msg.tabId as number))
  else return
  void result.then(respond, (e: unknown) => respond({ ok: false, error: err(e) }))
  return true
})

chrome.tabs.onRemoved.addListener(stopTab)
chrome.debugger.onDetach.addListener((source) => {
  const s = session
  if (!s?.attached || s.tabId !== source.tabId) return
  // 先阻止 CDP；旧 detach 事件若晚于新 attach，不能撤销新会话。
  s.suspended = true
  void (async () => {
    try {
      const owned = await ownsAttachment(s, () => checkEpoch(s))
      if (session !== s) return
      if (owned) {
        s.suspended = false
        return
      }
    } catch { /* 无法确认调试器归属时保守撤权。 */ }
    if (session !== s) return
    const old = revoke()
    await serial(() => cleanup(old))
  })().catch((e: unknown) => console.error(err(e)))
})

// storage.session 只跨 SW 重启保留；浏览器重启后必须重新授权。
const bootEpoch = epoch
const bootReady = serial(async () => {
  const saved: unknown = (await chrome.storage.session.get(KEY))[KEY]
  if (!isRecord(saved) || !tabId(saved.tabId)) {
    await cleanup()
    return
  }
  if (!isToken(saved.token)) {
    const targets = await chrome.debugger.getTargets()
    const legacy: Session = {
      tabId: saved.tabId, token: '', epoch: bootEpoch, attached: targets.some((target) => target.tabId === saved.tabId && target.attached),
      suspended: false, attachError: '', seen: new Map(),
    }
    if (legacy.attached) legacy.attached = await ownsAttachment(legacy, () => {})
    await cleanup(legacy)
    return
  }
  await activate(saved.tabId, saved.token, bootEpoch, true)
}).catch((e: unknown) => console.error(`恢复接管失败: ${err(e)}`))
