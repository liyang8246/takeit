/** 跑法: node dev/cdp.test.ts；不需要浏览器或扩展环境。 */
import assert from 'node:assert/strict'
import { mock } from 'node:test'
import { runInNewContext } from 'node:vm'
import { act, runScript, screenshot, snapshot, type Send } from '../src/ext/cdp.ts'
import type { Act } from '../src/shared/protocol.ts'

type Params = Record<string, unknown> | undefined
type Step = [method: string, params?: Params | ((params: Params) => void), reply?: unknown]
let cases = 0
let commands = 0

function mockSend(steps: Step[]) {
  const pending = [...steps]
  const send: Send = async (method, params) => {
    const step = pending.shift()
    assert.ok(step, `意外调用 ${method}`)
    assert.equal(method, step[0])
    if (typeof step[1] === 'function') step[1](params)
    else assert.deepEqual(params, step[1], method)
    commands += 1
    if (step[2] instanceof Error) throw step[2]
    return step[2] ?? {}
  }
  return { send, done: () => { assert.equal(pending.length, 0, '预期的 CDP 调用没有完成'); cases += 1 } }
}

const clickSteps: Step[] = [
  ['DOM.scrollIntoViewIfNeeded', { backendNodeId: 142 }],
  ['DOM.getBoxModel', { backendNodeId: 142 }, { model: { content: [10, 20, 50, 20, 50, 60, 10, 60] } }],
  ['Input.dispatchMouseEvent', { x: 30, y: 40, button: 'left', clickCount: 1, type: 'mousePressed', buttons: 1 }],
  ['Input.dispatchMouseEvent', { x: 30, y: 40, button: 'left', clickCount: 1, type: 'mouseReleased', buttons: 0 }],
]
const enter = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }
const enterSteps: Step[] = [
  ['Input.dispatchKeyEvent', { ...enter, type: 'rawKeyDown' }],
  ['Input.dispatchKeyEvent', { ...enter, type: 'char', text: '\r' }],
  ['Input.dispatchKeyEvent', { ...enter, type: 'keyUp' }],
]
{
  const m = mockSend(clickSteps)
  await act(m.send, { op: 'click', ref: '142' })
  m.done()
}
for (const submit of [false, true]) {
  const m = mockSend([
    ...clickSteps,
    ['Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 }],
    ['Input.insertText', { text: '' }],
    ...(submit ? enterSteps : []),
  ])
  await act(m.send, { op: 'type', ref: '142', text: '', submit })
  m.done()
}
{
  const m = mockSend(enterSteps)
  await act(m.send, { op: 'key', key: 'Enter' })
  m.done()
}
{
  const m = mockSend([
    ['Input.dispatchKeyEvent', { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9, type: 'rawKeyDown' }],
    ['Input.dispatchKeyEvent', { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9, type: 'keyUp' }],
    ['Runtime.evaluate', { expression: 'scrollBy(0, -12.5)' }],
  ])
  await act(m.send, { op: 'key', key: 'Tab' })
  await act(m.send, { op: 'scroll', dy: -12.5 })
  m.done()
}
{
  const m = mockSend([
    ['DOM.scrollIntoViewIfNeeded', { backendNodeId: 142 }],
    ['DOM.getBoxModel', { backendNodeId: 142 }, {}],
  ])
  await assert.rejects(act(m.send, { op: 'click', ref: '142' }), /没有布局盒/)
  m.done()
}

const noSend: Send = async (method) => assert.fail(`非法参数不能发出 ${method}`)
for (const ref of ['', '0', '-1', '1.5', '1e2', ' 1', '01', 'Infinity', '9007199254740992', 3, undefined]) {
  await assert.rejects(act(noSend, { op: 'click', ref } as Act), /正整数 uid/)
  await assert.rejects(act(noSend, { op: 'type', ref, text: 'x' } as Act), /正整数 uid/)
}
for (const url of ['javascript:alert(1)', 'file:///tmp/a', 'ftp://example.com', 'https://', 'http://[bad', '/relative', '', undefined]) {
  await assert.rejects(act(noSend, { op: 'navigate', url } as Act), /http\/https URL/)
}
for (const ms of [-1, 10_001, NaN, Infinity, -Infinity, '0', undefined]) {
  await assert.rejects(act(noSend, { op: 'wait', ms } as Act), /0\.\.10000/)
}
for (const dy of [NaN, Infinity, '12', undefined]) {
  await assert.rejects(act(noSend, { op: 'scroll', dy } as Act), /有限数值/)
}
for (const key of ['Unknown', 'constructor', 'toString']) {
  await assert.rejects(act(noSend, { op: 'key', key }), /不支持的 key/)
}
await assert.rejects(act(noSend, { op: 'key' } as Act), /不支持的 key/)
await assert.rejects(act(noSend, { op: 'type', ref: '142', text: 1 } as unknown as Act), /需要 text/)
await assert.rejects(act(noSend, { op: 'type', ref: '142', text: '', submit: 'yes' } as unknown as Act), /boolean/)
await assert.rejects(act(noSend, { op: 'unknown' } as unknown as Act), /不支持的 act/)

const delays: Array<number | undefined> = []
const timer = mock.method(globalThis, 'setTimeout', ((callback: () => void, ms?: number) => {
  delays.push(ms)
  callback()
  return {}
}) as unknown as typeof setTimeout)
try {
  for (const ms of [0, 0.5, 10_000]) await act(noSend, { op: 'wait', ms })
  assert.deepEqual(delays, [0, 0.5, 10_000], 'wait 不得用默认值或截断合法值')
  for (const url of ['https://example.com/path', 'http://example.com', 'HTTPS://example.com']) {
    const m = mockSend([['Page.navigate', { url }]])
    await act(m.send, { op: 'navigate', url })
    m.done()
  }
  assert.deepEqual(delays.slice(3), [600, 600, 600])
} finally {
  timer.mock.restore()
}

{
  const m = mockSend([['Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, { data: 'viewport-png' }]])
  assert.equal(await screenshot(m.send, false), 'viewport-png')
  m.done()
}
{
  const m = mockSend([
    ['Page.getLayoutMetrics', undefined, {
      cssContentSize: { x: -3.5, y: 7.25, width: 1000.5, height: 4500.25 },
      contentSize: { x: 0, y: 0, width: 2001, height: 9000.5 },
      cssVisualViewport: { pageX: 10, pageY: 800, clientWidth: 500, clientHeight: 600 },
    }],
    ['Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: true,
      clip: { x: -3.5, y: 7.25, width: 1000.5, height: 4500.25, scale: 1 },
    }, { data: 'full-png' }],
  ])
  assert.equal(await screenshot(m.send, true), 'full-png', '整页使用 CSS 页面坐标, 不使用滚动偏移或设备像素尺寸')
  m.done()
}
for (const cssContentSize of [undefined, { x: 0, y: 0, width: 0, height: 10 }, { x: NaN, y: 0, width: 10, height: 10 }]) {
  const m = mockSend([['Page.getLayoutMetrics', undefined, { cssContentSize }]])
  await assert.rejects(screenshot(m.send, true), /CSS 页面尺寸/)
  m.done()
}
{
  const m = mockSend([['Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, {}]])
  await assert.rejects(screenshot(m.send, false), /没有拿到数据/)
  m.done()
}
{
  const m = mockSend([['DOMSnapshot.captureSnapshot', { computedStyles: ['visibility', 'opacity'], includeDOMRects: false }, {}]])
  assert.equal(await snapshot(m.send), '(空页面)')
  m.done()
}

const probeParams = { expression: 'typeof window.jQuery', returnByValue: true, timeout: 10_000 }
const probe: Step = ['Runtime.evaluate', probeParams, { result: { type: 'string', value: 'function' } }]
const scriptParams = { expression: 'userCode()', returnByValue: false, awaitPromise: true, userGesture: true, timeout: 10_000 }
for (const [result, expected] of [
  [{ type: 'string', value: '文本' }, '文本'],
  [{ type: 'number', value: 0 }, '0'],
  [{ type: 'boolean', value: false }, 'false'],
  [{ type: 'object', value: null }, 'null'],
  [{ type: 'undefined' }, ''],
  [{ type: 'number', unserializableValue: 'NaN' }, 'NaN'],
  [{ type: 'bigint', unserializableValue: '42n' }, '42n'],
] as const) {
  const m = mockSend([probe, ['Runtime.evaluate', scriptParams, { result }]])
  assert.equal(await runScript(m.send, 'userCode()'), expected)
  m.done()
}

class FakeNode { outerHTML = '<b>node</b>' }
const circular: Record<string, unknown> = {}
circular.self = circular
for (const [value, expected] of [
  [{ answer: 42 }, '{"answer":42}'],
  [new FakeNode(), '<b>node</b>'],
  [Object.assign([new FakeNode(), 17], { jquery: '4.0' }), '<b>node</b>\n17'],
  [circular, '[object Object]'],
] as const) {
  const m = mockSend([
    probe,
    ['Runtime.evaluate', scriptParams, { result: { type: 'object', objectId: 'object-1' } }],
    ['Runtime.callFunctionOn', (params) => {
      assert.equal(params?.objectId, 'object-1')
      assert.equal(params?.returnByValue, true)
      assert.equal(typeof params?.functionDeclaration, 'string')
      const serialize = runInNewContext(`(${params!.functionDeclaration})`, { Node: FakeNode }) as (this: unknown) => unknown
      assert.equal(serialize.call(value), expected, '实际序列化函数应支持普通值/DOM/jQuery/循环对象')
    }, { result: { type: 'string', value: expected } }],
    ['Runtime.releaseObject', { objectId: 'object-1' }],
  ])
  assert.equal(await runScript(m.send, 'userCode()'), expected)
  m.done()
}
{
  const m = mockSend([
    probe,
    ['Runtime.evaluate', scriptParams, {
      result: { objectId: 'eval-error' },
      exceptionDetails: { text: 'Uncaught', exception: { objectId: 'eval-error', description: 'Error: user failure' } },
    }],
    ['Runtime.releaseObject', { objectId: 'eval-error' }],
  ])
  await assert.rejects(runScript(m.send, 'userCode()'), /Error: user failure/)
  m.done()
}
for (const failure of [
  new Error('CDP serialize transport failure'),
  { result: { objectId: 'serialize-error' }, exceptionDetails: { text: 'serialize exception', exception: { objectId: 'serialize-error' } } },
]) {
  const m = mockSend([
    probe,
    ['Runtime.evaluate', scriptParams, { result: { objectId: 'object-1' } }],
    ['Runtime.callFunctionOn', (params) => assert.equal(params?.objectId, 'object-1'), failure],
    ['Runtime.releaseObject', { objectId: 'object-1' }],
    ...(failure instanceof Error ? [] : [['Runtime.releaseObject', { objectId: 'serialize-error' }] as Step]),
  ])
  await assert.rejects(runScript(m.send, 'userCode()'), /serialize/)
  m.done()
}
{
  const m = mockSend([
    probe,
    ['Runtime.evaluate', scriptParams, { result: { objectId: 'object-1' } }],
    ['Runtime.callFunctionOn', (params) => assert.equal(params?.objectId, 'object-1'), { result: { value: 'ok' } }],
    ['Runtime.releaseObject', { objectId: 'object-1' }, new Error('Execution context was destroyed')],
  ])
  assert.equal(await runScript(m.send, 'userCode()'), 'ok', '清理错误不能覆盖原结果')
  m.done()
}
{
  const m = mockSend([['Runtime.evaluate', probeParams, { exceptionDetails: { text: 'probe failed' } }]])
  await assert.rejects(runScript(m.send, 'userCode()'), /probe failed/)
  m.done()
}

const globals = globalThis as typeof globalThis & { __JQUERY__?: string }
const previousJQuery = globals.__JQUERY__
globals.__JQUERY__ = 'installJQuery()'
try {
  const injectedParams = { expression: 'installJQuery()', returnByValue: false, timeout: 10_000 }
  for (const failed of [false, true]) {
    const m = mockSend([
      ['Runtime.evaluate', probeParams, { result: { type: 'string', value: 'undefined' } }],
      ['Runtime.evaluate', injectedParams, failed
        ? { result: { objectId: 'inject-error' }, exceptionDetails: { text: 'inject failed' } }
        : { result: { type: 'undefined' } }],
      ...(failed
        ? [['Runtime.releaseObject', { objectId: 'inject-error' }] as Step]
        : [['Runtime.evaluate', scriptParams, { result: { value: 'injected' } }] as Step]),
    ])
    if (failed) await assert.rejects(runScript(m.send, 'userCode()'), /inject failed/)
    else assert.equal(await runScript(m.send, 'userCode()'), 'injected')
    m.done()
  }
} finally {
  if (previousJQuery === undefined) delete globals.__JQUERY__
  else globals.__JQUERY__ = previousJQuery
}

console.log(`ok  CDP: ${cases} 组 mock / ${commands} 条参数断言 + ref/导航/wait/scroll 边界拒绝`)
