/** 独立扩展生命周期/传输测试：node dev/extension.test.ts */
import assert from 'node:assert/strict'
import { setImmediate as immediate } from 'node:timers/promises'
import { test } from 'node:test'
import type { Command, Reply, Request } from '../src/shared/protocol.ts'
import { isToken } from '../src/shared/protocol.ts'

const EXT = 'abcdefghijklmnopabcdefghijklmnop'
const TOKEN = '1234567890abcdef1234567890abcdef'
const TOKEN2 = 'fedcba0987654321fedcba0987654321'
const url = (path: string) => `chrome-extension://${EXT}/${path}`
const flush = async () => { await immediate() }
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
type Result = Record<string, unknown>
type Listener = (value: unknown, source: chrome.runtime.MessageSender, respond: (value: unknown) => void) => boolean | void
type Sent = { tabId: number; method: string; params?: Record<string, unknown> | undefined }
let imports = 0

function mockChrome(saved?: unknown, initialAttached: number[] = []) {
  let listener: Listener | undefined
  let removed: ((id: number) => void) | undefined
  let detached: ((source: { tabId: number }, reason: string) => void) | undefined
  const tabs = new Map([1, 2, 3].map((id) => [id, { id, url: `https://example.com/${id}` }]))
  const attached = new Set(initialAttached)
  const store: Record<string, unknown> = saved === undefined ? {} : { handover: saved }
  const events: string[] = []
  const calls: Sent[] = []
  const probes: Sent[] = []
  const controls = {
    attachFailure: new Set<number>(), detachFailure: new Set<number>(), otherAttached: new Set<number>(), setFailure: false,
    createFailure: false, connectFailure: false, document: false,
    getGate: undefined as Promise<void> | undefined,
    attachGate: undefined as Promise<void> | undefined,
    cdp: async (_call: Sent): Promise<unknown> => ({}),
    send: undefined as ((value: Result) => Promise<unknown>) | undefined,
  }
  const api = {
    runtime: {
      id: EXT,
      getURL: url,
      getManifest: () => ({ version: '0.4.0' }),
      onMessage: { addListener: (fn: Listener) => { listener = fn } },
      sendMessage: async (value: Result): Promise<unknown> => {
        events.push(String(value.type))
        if (controls.send) return controls.send(value)
        if (value.type === 'CONNECT' && controls.connectFailure) throw new Error('connect failed')
        return { ok: true }
      },
    },
    storage: { session: {
      get: async () => { await controls.getGate; return { ...store } },
      set: async (value: Record<string, unknown>) => {
        if (controls.setFailure) throw new Error('storage failed')
        Object.assign(store, value)
      },
      remove: async (key: string) => { delete store[key] },
    } },
    offscreen: {
      hasDocument: async () => controls.document,
      createDocument: async () => {
        if (controls.createFailure) throw new Error('offscreen failed')
        controls.document = true
      },
      closeDocument: async () => { controls.document = false },
    },
    tabs: {
      get: async (id: number) => {
        const tab = tabs.get(id)
        if (!tab) throw new Error('No tab with id')
        return { ...tab }
      },
      query: async () => [tabs.get(1)],
      update: async (id: number, update: { url: string }) => {
        events.push(`navigate:${id}`)
        const tab = tabs.get(id)
        assert(tab)
        tab.url = update.url
        return { ...tab }
      },
      onRemoved: { addListener: (fn: (id: number) => void) => { removed = fn } },
    },
    debugger: {
      attach: async (source: { tabId: number }) => {
        events.push(`attach:${source.tabId}`)
        await controls.attachGate
        if (controls.attachFailure.has(source.tabId)) throw new Error('attach denied')
        if (controls.otherAttached.has(source.tabId)) throw new Error('Another debugger is already attached')
        attached.add(source.tabId)
      },
      detach: async (source: { tabId: number }) => {
        events.push(`detach:${source.tabId}`)
        if (controls.detachFailure.has(source.tabId)) throw new Error('detach failed')
        if (!attached.delete(source.tabId)) throw new Error('Debugger is not attached to the tab')
      },
      getTargets: async () => [...tabs.values()].map((tab) => ({ ...tab, tabId: tab.id, attached: attached.has(tab.id) || controls.otherAttached.has(tab.id) })),
      sendCommand: async (source: { tabId: number }, method: string, params?: Record<string, unknown>) => {
        const call: Sent = { tabId: source.tabId, method, params }
        if (method === 'Runtime.evaluate' && params?.expression === 'void 0') {
          probes.push(call)
          if (!attached.has(source.tabId)) throw new Error('Debugger is not attached to the tab')
          return { result: { type: 'undefined' } }
        }
        calls.push(call)
        return controls.cdp(call)
      },
      onDetach: { addListener: (fn: typeof detached) => { detached = fn } },
    },
  }
  async function message(value: Result, from = 'popup.html'): Promise<Result> {
    assert(listener)
    return new Promise((resolve, reject) => {
      let answered = false
      const async = listener!(value, { id: EXT, url: url(from) }, (reply) => {
        answered = true
        resolve(reply as Result)
      })
      if (async !== true && !answered) reject(new Error('Message rejected'))
    })
  }
  return {
    api, controls, tabs, attached, store, events, calls, probes, message,
    remove: (id: number) => { tabs.delete(id); attached.delete(id); removed?.(id) },
    detach: (id: number, remove = true) => { if (remove) attached.delete(id); detached?.({ tabId: id }, 'canceled_by_user') },
  }
}
type Mock = ReturnType<typeof mockChrome>

async function worker(mock = mockChrome()) {
  globalThis.chrome = mock.api as unknown as typeof chrome
  await import(`../src/ext/bg.ts?test=${++imports}`)
  await mock.message({ type: 'PING', tabId: 1 })
  return mock
}
async function begin(mock: Mock, tabId = 1) {
  const result = await mock.message({ type: 'START', tabId, token: 'popup-must-not-generate-this' })
  assert.equal(result.ok, true, String(result.error))
  assert.equal(result.state, 'current')
  assert(isToken(result.token))
  return result.token
}
const request = (token: string, id: string = crypto.randomUUID(), command: Command = { kind: 'state', view: {} }): Request => ({
  version: 1, token, id, deadline: Date.now() + 30_000, command,
})
const exec = (mock: Mock, value: unknown) => mock.message({ type: 'EXEC', request: value }, 'offscreen.html')

test('状态隔离：仅当前 tab 获得 SW 生成的完整 Token', async () => {
  const mock = await worker()
  const token = await begin(mock)
  assert.match(token, /^[a-f0-9]{32}$/)
  assert.deepEqual(mock.store.handover, { tabId: 1, token })
  assert.equal((await mock.message({ type: 'PING', tabId: 1 })).token, token)
  assert.deepEqual(await mock.message({ type: 'PING', tabId: 2 }), { ok: true, state: 'other' })
  await assert.rejects(mock.message({ type: 'EXEC', request: request(token) }), /Message rejected/)
})

test('切换先 detach 旧 tab；旧 EXEC/STOP 和迟到 detach 不会影响新会话', async () => {
  const mock = await worker()
  const old = await begin(mock, 1)
  const token = await begin(mock, 2)
  assert.notEqual(old, token)
  assert(mock.events.indexOf('detach:1') < mock.events.indexOf('attach:2'))
  assert.deepEqual([...mock.attached], [2])
  assert.equal((await exec(mock, request(old))).ok, false)
  assert.equal(mock.calls.length, 0)
  assert.equal((await mock.message({ type: 'STOP', tabId: 1, token: old })).ok, false)
  assert.equal((await mock.message({ type: 'PING', tabId: 2 })).token, token)
  const renewed = await begin(mock, 2)
  mock.detach(2, false)
  await flush()
  assert.equal((await mock.message({ type: 'PING', tabId: 2 })).token, renewed)
})

test('STOP 同步撤权，旧 CDP 回调不能继续下一次 send；执行槽等真实 Promise', async () => {
  const mock = await worker()
  const token = await begin(mock)
  const gate = deferred<unknown>()
  const entered = deferred<void>()
  mock.controls.cdp = async () => { entered.resolve(); return gate.promise }
  const old = exec(mock, request(token, 'click', { kind: 'act', act: { op: 'click', ref: '1' } }))
  await entered.promise
  const stopping = mock.message({ type: 'STOP', tabId: 1, token })
  assert.equal((await exec(mock, request(token, 'revoked'))).ok, false)
  await stopping
  const next = await begin(mock, 2)
  const busy = await exec(mock, request(next, 'busy'))
  assert.equal(busy.ok, false)
  assert.match(String(busy.error), /前一命令尚未结束/)
  assert.equal(mock.calls.length, 1)
  gate.resolve({})
  assert.equal((await old).ok, false)
  assert.equal(mock.calls.length, 1)
  mock.controls.cdp = async () => ({})
  assert.equal((await exec(mock, request(next, 'after-finish'))).ok, true)
  assert.equal(mock.calls.at(-1)?.tabId, 2)
})

for (const failure of ['attach', 'storage', 'offscreen', 'connect']) {
  test(`START ${failure} 失败回滚，不残留新授权/调试器`, async () => {
    const mock = await worker()
    const old = await begin(mock)
    if (failure === 'attach') mock.controls.attachFailure.add(2)
    if (failure === 'storage') mock.controls.setFailure = true
    if (failure === 'offscreen') mock.controls.createFailure = true
    if (failure === 'connect') mock.controls.connectFailure = true
    const result = await mock.message({ type: 'START', tabId: 2 })
    assert.equal(result.ok, false)
    assert.equal((await mock.message({ type: 'PING', tabId: 2 })).state, 'idle')
    assert.equal(mock.store.handover, undefined)
    assert.equal(mock.attached.size, 0)
    assert.equal(mock.controls.document, false)
    assert.equal((await exec(mock, request(old))).ok, false)
    assert.equal(mock.calls.length, 0)
  })
}

test('真实 detach 失败阻止后续接管，修复后仍先清理旧调试器', async () => {
  const mock = await worker()
  await begin(mock)
  mock.controls.detachFailure.add(1)
  assert.equal((await mock.message({ type: 'START', tabId: 2 })).ok, false)
  assert.equal((await mock.message({ type: 'START', tabId: 2 })).ok, false)
  assert(!mock.events.includes('attach:2'))
  mock.controls.detachFailure.clear()
  await begin(mock, 2)
  assert.deepEqual([...mock.attached], [2])
})

test('去重/过期/无效协议均不能再次发 CDP', async () => {
  const mock = await worker()
  const token = await begin(mock)
  const value = request(token, 'only-once')
  assert.equal((await exec(mock, value)).ok, true)
  assert.equal((await exec(mock, value)).ok, false)
  assert.equal((await exec(mock, { ...request(token), deadline: Date.now() - 1 })).ok, false)
  assert.equal((await exec(mock, { ...request(token), version: 2 })).ok, false)
  assert.equal((await exec(mock, request(TOKEN))).ok, false)
  assert.equal(mock.calls.length, 1)
})

test('每次 CDP send 均检查 deadline，迟到结果不继续派发动作', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] })
  const mock = await worker()
  const token = await begin(mock)
  const gate = deferred<unknown>()
  const entered = deferred<void>()
  mock.controls.cdp = async () => { entered.resolve(); return gate.promise }
  const value = request(token, 'deadline', { kind: 'act', act: { op: 'click', ref: '1' } })
  value.deadline = Date.now() + 10
  const running = exec(mock, value)
  await entered.promise
  t.mock.timers.tick(11)
  gate.resolve({})
  const result = await running
  assert.equal(result.ok, false)
  assert.match(String(result.error), /过期/)
  assert.equal(mock.calls.length, 1)
})

test('去重缓存有界且不淘汰尚未过期 id', async () => {
  const mock = await worker()
  const token = await begin(mock)
  for (let i = 0; i < 1024; i += 1) assert.equal((await exec(mock, request(token, String(i)))).ok, true)
  assert.equal((await exec(mock, request(token, 'overflow'))).ok, false)
  assert.equal((await exec(mock, request(token, '0'))).ok, false)
  assert.equal(mock.calls.length, 1024)
})

test('SW 恢复不盲信 attached 缓存；legacy 短 token 被撤销并 detach', async () => {
  const restored = await worker(mockChrome({ tabId: 1, token: TOKEN, attached: true }))
  assert(restored.events.includes('attach:1'))
  assert.equal((await restored.message({ type: 'PING', tabId: 1 })).token, TOKEN)
  assert.deepEqual(restored.store.handover, { tabId: 1, token: TOKEN })
  const legacy = await worker(mockChrome({ tabId: 1, token: '12345678', attached: true }, [1]))
  assert(legacy.events.includes('detach:1'))
  assert.equal(legacy.attached.size, 0)
  assert.equal(legacy.store.handover, undefined)
  assert.equal((await legacy.message({ type: 'PING', tabId: 1 })).state, 'idle')
  assert(!legacy.events.includes('CONNECT'))
})

test('SW 唤醒时首条 EXEC 等待授权恢复，不要求先 PING', async () => {
  const mock = mockChrome({ tabId: 1, token: TOKEN }, [1])
  const gate = deferred<void>()
  mock.controls.getGate = gate.promise
  globalThis.chrome = mock.api as unknown as typeof chrome
  await import(`../src/ext/bg.ts?test=${++imports}`)
  let answered = false
  const first = exec(mock, request(TOKEN, 'wake-up')).then((result) => { answered = true; return result })
  await flush()
  const answeredBeforeRestore = answered
  gate.resolve()
  const result = await first
  await mock.message({ type: 'PING', tabId: 1 })
  assert.equal(answeredBeforeRestore, false, '首条 EXEC 不能在 storage 恢复前被误拒绝')
  assert.equal(result.ok, true)
  assert.equal(mock.calls.length, 1)
})

test('恢复及黄条撤销不把其他 debugger 的 attached 当作本扩展归属', async () => {
  const foreign = mockChrome({ tabId: 1, token: TOKEN })
  foreign.controls.otherAttached.add(1)
  await worker(foreign)
  assert.equal((await foreign.message({ type: 'PING', tabId: 1 })).state, 'idle')
  assert(!foreign.events.includes('detach:1'))
  assert(foreign.controls.otherAttached.has(1))
  const mock = await worker()
  const token = await begin(mock)
  mock.controls.otherAttached.add(1)
  mock.detach(1)
  await flush()
  assert.equal((await mock.message({ type: 'PING', tabId: 1 })).state, 'idle')
  assert.equal((await exec(mock, request(token))).ok, false)
  assert.equal(mock.calls.length, 0)
  assert(mock.controls.otherAttached.has(1))
})

test('恢复与 START 竞争时先撤销旧存储会话，不重新绑定到新 tab', async () => {
  const mock = mockChrome({ tabId: 1, token: TOKEN }, [1])
  const gate = deferred<void>()
  mock.controls.getGate = gate.promise
  globalThis.chrome = mock.api as unknown as typeof chrome
  await import(`../src/ext/bg.ts?test=${++imports}`)
  const starting = mock.message({ type: 'START', tabId: 2 })
  gate.resolve()
  assert.equal((await starting).ok, true)
  assert.deepEqual([...mock.attached], [2])
  assert.equal((await exec(mock, request(TOKEN))).ok, false)
})

test('START 尚在 attach 时切换，只保留最后一次授权', async () => {
  const mock = await worker()
  const gate = deferred<void>()
  mock.controls.attachGate = gate.promise
  const first = mock.message({ type: 'START', tabId: 1 })
  await flush()
  const second = mock.message({ type: 'START', tabId: 2 })
  gate.resolve()
  assert.equal((await first).ok, false)
  assert.equal((await second).ok, true)
  assert.deepEqual([...mock.attached], [2])
})

for (const kind of ['close', 'yellow-bar']) {
  test(`${kind} 撤销 Token，旧 EXEC 不能发 CDP`, async () => {
    const mock = await worker()
    const token = await begin(mock)
    if (kind === 'close') mock.remove(1)
    else mock.detach(1)
    await flush()
    assert.equal((await mock.message({ type: 'PING', tabId: 1 })).state, 'idle')
    assert.equal((await exec(mock, request(token))).ok, false)
    assert.equal(mock.calls.length, 0)
  })
}

test('内部页仅 state 提示和 http/https 导航降级，其他操作明确失败', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const mock = await worker()
  mock.tabs.get(1)!.url = 'chrome://newtab/'
  mock.controls.attachFailure.add(1)
  const token = await begin(mock)
  assert.match(String((await exec(mock, request(token))).data), /内部页面/)
  assert.equal((await exec(mock, request(token, 'script', { kind: 'script', code: '1' }))).ok, false)
  assert.equal((await exec(mock, request(token, 'bad-nav', { kind: 'act', act: { op: 'navigate', url: 'javascript:alert(1)' } }))).ok, false)
  const navigation = exec(mock, request(token, 'nav', { kind: 'act', act: { op: 'navigate', url: 'https://example.com' } }))
  await flush()
  mock.controls.attachFailure.clear()
  t.mock.timers.tick(600)
  await flush()
  assert.equal((await navigation).ok, true)
  assert.equal(mock.tabs.get(1)?.url, 'https://example.com')
})

async function offscreen(mock: Mock) {
  globalThis.chrome = mock.api as unknown as typeof chrome
  await import(`../src/ext/offscreen.ts?test=${++imports}`)
}

test('短轮询：403/HTTP/协议错误后继续，每次 POST Bearer；重复 id 只 EXEC 一次', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const mock = mockChrome()
  const value = request(TOKEN, 'once')
  const replies: Reply[] = []
  let polls = 0
  let executions = 0
  mock.controls.send = async (message) => {
    executions += 1
    assert.deepEqual(message, { type: 'EXEC', request: value })
    return { id: value.id, ok: true, data: 'done' }
  }
  const original = globalThis.fetch
  globalThis.fetch = async (input, options) => {
    assert.equal(options?.method, 'POST')
    assert.equal(new Headers(options.headers).get('Authorization'), `Bearer ${TOKEN}`)
    assert(options.signal)
    if (String(input).endsWith('/reply')) {
      replies.push(JSON.parse(String(options.body)) as Reply)
      return new Response(null, { status: 204 })
    }
    assert.equal(String(input), 'http://127.0.0.1:8737/command')
    assert.equal(options.body, undefined)
    polls += 1
    if (polls === 1) return new Response(null, { status: 403 })
    if (polls === 2) return new Response(null, { status: 500 })
    if (polls === 3) return Response.json({ invalid: true })
    if (polls === 4) return new Response(null, { status: 204 })
    return Response.json(value)
  }
  try {
    await offscreen(mock)
    await mock.message({ type: 'CONNECT', token: TOKEN }, 'bg.js')
    await flush()
    for (let i = 0; i < 5; i += 1) { t.mock.timers.tick(250); await flush() }
    assert.equal(polls, 6)
    assert.equal(executions, 1)
    assert.deepEqual(replies[0], { id: value.id, ok: true, data: 'done' })
    assert.equal(replies[1]?.ok, false)
  } finally {
    await mock.message({ type: 'DISCONNECT' }, 'bg.js')
    await flush()
    globalThis.fetch = original
  }
})

test('同 Token 的恢复 CONNECT 不打断首条 EXEC 或丢失回执', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const mock = mockChrome()
  const value = request(TOKEN, 'restore-first')
  const gate = deferred<Reply>()
  const entered = deferred<void>()
  const replies: Reply[] = []
  let polls = 0
  mock.controls.send = async () => { entered.resolve(); return gate.promise }
  const original = globalThis.fetch
  globalThis.fetch = async (input, options) => {
    if (String(input).endsWith('/reply')) {
      replies.push(JSON.parse(String(options?.body)) as Reply)
      return Response.json({ ok: true })
    }
    return ++polls === 1 ? Response.json(value) : new Response(null, { status: 204 })
  }
  try {
    await offscreen(mock)
    await mock.message({ type: 'CONNECT', token: TOKEN }, 'bg.js')
    await entered.promise
    await mock.message({ type: 'CONNECT', token: TOKEN }, 'bg.js')
    gate.resolve({ id: value.id, ok: true, data: 'restored' })
    await flush()
    assert.deepEqual(replies, [{ id: value.id, ok: true, data: 'restored' }])
    assert.equal(polls, 1)
  } finally {
    gate.resolve({ id: value.id, ok: false, error: 'test cleanup' })
    await mock.message({ type: 'DISCONNECT' }, 'bg.js')
    await flush()
    globalThis.fetch = original
  }
})

test('CONNECT/DISCONNECT 中止旧 fetch；每个 fetch 有时间上限', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const mock = mockChrome()
  const signals: AbortSignal[] = []
  const original = globalThis.fetch
  globalThis.fetch = async (_input, options) => new Promise((_resolve, reject) => {
    const signal = options?.signal
    assert(signal)
    signals.push(signal)
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
  })
  try {
    await offscreen(mock)
    await mock.message({ type: 'CONNECT', token: TOKEN }, 'bg.js')
    await flush()
    await mock.message({ type: 'CONNECT', token: TOKEN2 }, 'bg.js')
    await flush()
    assert.equal(signals[0]?.aborted, true)
    assert.equal(signals[1]?.aborted, false)
    t.mock.timers.tick(2000)
    await flush()
    assert.equal(signals[1]?.aborted, true)
    t.mock.timers.tick(250)
    await flush()
    assert.equal(signals.length, 3)
    await mock.message({ type: 'DISCONNECT' }, 'bg.js')
    assert.equal(signals[2]?.aborted, true)
  } finally {
    await mock.message({ type: 'DISCONNECT' }, 'bg.js')
    await flush()
    globalThis.fetch = original
  }
})

test('offscreen 切换后丢弃迟到 EXEC 应答，不用新 Token 回传旧结果', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const mock = mockChrome()
  const gate = deferred<Reply>()
  const entered = deferred<void>()
  const value = request(TOKEN, 'old')
  const posts: string[] = []
  mock.controls.send = async () => { entered.resolve(); return gate.promise }
  const original = globalThis.fetch
  globalThis.fetch = async (input, options) => {
    posts.push(String(input))
    if (new Headers(options?.headers).get('Authorization') === `Bearer ${TOKEN}`) return Response.json(value)
    return new Response(null, { status: 204 })
  }
  try {
    await offscreen(mock)
    await mock.message({ type: 'CONNECT', token: TOKEN }, 'bg.js')
    await entered.promise
    await mock.message({ type: 'CONNECT', token: TOKEN2 }, 'bg.js')
    gate.resolve({ id: value.id, ok: true, data: 'old result' })
    await flush()
    assert(!posts.some((path) => path.endsWith('/reply')))
  } finally {
    await mock.message({ type: 'DISCONNECT' }, 'bg.js')
    await flush()
    globalThis.fetch = original
  }
})

class Element {
  textContent = ''
  disabled = false
  hidden = false
  classes = new Set<string>()
  handlers = new Map<string, () => void>()
  classList = { toggle: (name: string, on: boolean) => { if (on) this.classes.add(name); else this.classes.delete(name) } }
  addEventListener(name: string, handler: () => void) { this.handlers.set(name, handler) }
  click() { this.handlers.get('click')?.() }
}

test('popup 隔离其他 tab、START 不提供 Token、STOP 带绑定、复制失败不报成功', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const mock = mockChrome()
  const elements = new Map(['go', 'copy', 'dot', 'state', 'notice', 'token', 'token-row', 'divider', 'ver'].map((id) => [id, new Element()]))
  const get = (id: string) => elements.get(id)!
  let result: Result = { ok: true, state: 'other' }
  let denyCopy = true
  let clipboard = ''
  const sent: Result[] = []
  mock.controls.send = async (value) => {
    sent.push(value)
    if (value.type === 'START') result = { ok: true, state: 'current', tabId: 1, token: TOKEN }
    if (value.type === 'STOP') result = { ok: true, state: 'idle' }
    return result
  }
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  let unload = () => {}
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { getElementById: get } })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { addEventListener: (_name: string, fn: () => void) => { unload = fn } } })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async (text: string) => {
    if (denyCopy) throw new Error('permission denied')
    clipboard = text
  } } } })
  try {
    globalThis.chrome = mock.api as unknown as typeof chrome
    await import(`../src/ext/popup.ts?test=${++imports}`)
    await flush()
    assert.equal(get('state').textContent, '其他标签页正在接管')
    assert.equal(get('token-row').hidden, true)
    assert.equal(get('token').textContent, '')
    assert.match(get('notice').textContent, /停止旧接管/)
    get('go').click()
    await flush()
    assert(!Object.hasOwn(sent.find((value) => value.type === 'START')!, 'token'))
    assert.equal(get('token').textContent, TOKEN)
    assert.match(get('notice').textContent, /复制失败/)
    assert.equal(get('copy').disabled, false)
    get('copy').click()
    await flush()
    assert.match(get('notice').textContent, /复制失败/)
    assert(!get('notice').textContent.includes('已复制'))
    denyCopy = false
    get('copy').click()
    await flush()
    assert(clipboard.includes(`npx -y @liyang8246/takeit ${TOKEN} help`))
    assert(clipboard.includes('每条命令临时连接'))
    get('go').click()
    await flush()
    assert.deepEqual(sent.find((value) => value.type === 'STOP'), { type: 'STOP', tabId: 1, token: TOKEN })
    result = { ok: true, state: 'current', tabId: 2, token: TOKEN2 }
    t.mock.timers.tick(1000)
    await flush()
    assert.equal(get('token-row').hidden, true)
    assert.equal(get('token').textContent, '')
  } finally {
    unload()
    for (const [name, descriptor] of [['document', originalDocument], ['window', originalWindow], ['navigator', originalNavigator]] as const) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
  }
})
