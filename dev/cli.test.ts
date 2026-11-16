import assert from 'node:assert/strict'
import { parse } from '../src/cli/args.ts'

const t = 'a'.repeat(32)
for (const argv of [[], ['help'], ['--help'], [t, 'help']]) assert.equal(parse(argv), null)
assert.deepEqual(parse([t, 'state', '--with-id', '--with-hidden', '--timeout', '2']), {
  token: t, command: { kind: 'state', view: { id: true, class: false, hidden: true } }, timeoutMs: 2000,
})
assert.deepEqual(parse([t, 'click', '15'])?.command, { kind: 'act', act: { op: 'click', ref: '15' } })
assert.deepEqual(parse([t, 'type', '15', '中文 带空格 "引号"', '--submit'])?.command, {
  kind: 'act', act: { op: 'type', ref: '15', text: '中文 带空格 "引号"', submit: true },
})
assert.deepEqual(parse([t, 'type', '15', ''])?.command, { kind: 'act', act: { op: 'type', ref: '15', text: '', submit: false } })
assert.deepEqual(parse([t, 'scroll', '-600'])?.command, { kind: 'act', act: { op: 'scroll', dy: -600 } })
assert.deepEqual(parse([t, 'wait', '0'])?.command, { kind: 'act', act: { op: 'wait', ms: 0 } })
assert.deepEqual(parse([t, 'script', '$("title").text()'])?.command, { kind: 'script', code: '$("title").text()' })
assert.deepEqual(parse([t, 'type', '15', '--', '--submit'])?.command, { kind: 'act', act: { op: 'type', ref: '15', text: '--submit', submit: false } })
assert.deepEqual(parse([t, 'script', '--', '--counter'])?.command, { kind: 'script', code: '--counter' })
assert.equal(parse([t, 'screenshot', 'new.png', '--full'])?.output, 'new.png')
assert.deepEqual(parse([t, 'screenshot', 'new.png', '--full'])?.command, { kind: 'screenshot', full: true })
for (const argv of [
  ['badtoken', 'state'], [t], [t, 'unknown'], [t, 'type', '15'], [t, 'type', '15', '--submit'],
  [t, 'script', '--timeout'], [t, 'click', '0'],
  [t, 'state', '--full'], [t, 'state', '--timeout', 'NaN'], [t, 'state', '--timeout', '0'],
  [t, 'state', '--timeout', '301'], [t, 'scroll', ''], [t, 'scroll', 'Infinity'],
  [t, 'wait', '-1'], [t, 'wait', '10001'], [t, 'navigate', 'file:///etc/passwd'],
  [t, 'key', 'Nope'], [t, 'script', ''], [t, 'screenshot', '--full'], [t, 'click', '15', 'extra'],
]) assert.throws(() => parse(argv), JSON.stringify(argv))
console.log('ok  CLI 参数：全部命令、空文本、负数、选项与非法输入')
