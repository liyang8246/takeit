import assert from 'node:assert/strict'
import { isAct, isCommand, isReply, isRequest, isToken } from '../src/shared/protocol.ts'

const token = 'a'.repeat(32)
const command = { kind: 'act', act: { op: 'click', ref: '15' } }
assert.ok(isToken(token))
for (const value of ['', 'a'.repeat(8), 'g'.repeat(32), null, [], 42]) assert.equal(isToken(value), false)
for (const value of [
  { op: 'click', ref: '0' }, { op: 'click', ref: '1.2' }, { op: 'click', ref: '-1' }, { op: 'click', ref: '9007199254740992' },
  { op: 'type', ref: '1' }, { op: 'type', ref: '1', text: 'x', submit: 1 },
  { op: 'key', key: 'Nope' }, { op: 'scroll', dy: Infinity },
  { op: 'navigate', url: 'javascript:alert(1)' }, { op: 'navigate', url: 'not a URL' },
  { op: 'wait', ms: -1 }, { op: 'wait', ms: 10_001 }, { op: 'wait', ms: NaN },
]) assert.equal(isAct(value), false, JSON.stringify(value))
assert.ok(isAct({ op: 'type', ref: '1', text: '' }))
assert.ok(isAct({ op: 'wait', ms: 0 }))
assert.ok(isAct({ op: 'scroll', dy: -600 }))
assert.ok(isAct({ op: 'navigate', url: 'https://example.com' }))
assert.ok(isCommand(command))
assert.ok(isCommand({ kind: 'state', view: {} }))
assert.ok(isCommand({ kind: 'script', code: '1+1' }))
assert.equal(isCommand({ kind: 'script', code: '  ' }), false)
assert.equal(isCommand({ kind: 'screenshot', full: 'true' }), false)
assert.equal(isCommand({ kind: 'state', view: { id: 'yes' } }), false)
const request = { version: 1, id: 'unique', token, deadline: Date.now() + 1000, command }
assert.ok(isRequest(request))
for (const change of [{ version: 2 }, { token: 'short' }, { deadline: Infinity }, { id: '' }, { command: {} }]) {
  assert.equal(isRequest({ ...request, ...change }), false)
}
assert.ok(isReply({ id: 'x', ok: true, data: '' }))
assert.ok(isReply({ id: 'x', ok: false, error: 'failed' }))
for (const value of [{ id: 'x', ok: true }, { id: 'x', ok: false, data: '' }, { id: 1, ok: true, data: '' }]) assert.equal(isReply(value), false)
console.log('ok  协议验证：token、字段、动作边界与异常数值')
