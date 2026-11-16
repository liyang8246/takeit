import { parseArgs } from 'node:util'
import { DEFAULT_TIMEOUT_MS } from '../shared/consts.ts'
import { isCommand, isToken, type Command } from '../shared/protocol.ts'

export type Invocation = { token: string; command: Command; timeoutMs: number; output?: string }

export function parse(argv: string[]): Invocation | null {
  if (argv.length === 0 || ['help', '--help', '-h'].includes(argv[0] ?? '')) return null
  const [token, op, ...args] = argv
  if (!isToken(token)) throw new Error('token 必须是扩展复制的 32 位字符串；请重新复制 prompt')
  if (['help', '--help', '-h'].includes(op ?? '')) return null

  const count: Record<string, number> = {
    state: 0, click: 1, type: 2, key: 1, scroll: 1, navigate: 1, wait: 1, script: 1, screenshot: 1,
  }
  if (op === undefined || count[op] === undefined) throw new Error(`未知命令：${op ?? ''}；运行 takeit help 查看用法`)
  const positional: string[] = []
  let literal = false
  for (let i = 0; i < count[op]; i += 1) {
    let value = args.shift()
    if (!literal && value === '--') { literal = true; value = args.shift() }
    if (value === undefined || (!literal && value.startsWith('--'))) {
      throw new Error(`${op} 缺少参数；以 -- 开头的文本须放在独立的 -- 之后`)
    }
    positional.push(value)
  }
  if (literal && args.length) throw new Error('-- 后只能放命令所需的文本，不能再加选项')
  const options = {
    timeout: { type: 'string' as const },
    ...(op === 'state' ? {
      'with-id': { type: 'boolean' as const },
      'with-class': { type: 'boolean' as const },
      'with-hidden': { type: 'boolean' as const },
    } : {}),
    ...(op === 'type' ? { submit: { type: 'boolean' as const } } : {}),
    ...(op === 'screenshot' ? { full: { type: 'boolean' as const } } : {}),
  }
  const { values } = parseArgs({ args, options, strict: true, allowPositionals: false })
  const seconds = values.timeout === undefined ? DEFAULT_TIMEOUT_MS / 1000 : Number(values.timeout)
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 300) throw new Error('--timeout 须为大于 0 且不超过 300 的秒数')
  const value = positional[0] ?? ''
  let command: Command
  switch (op) {
    case 'state': command = { kind: 'state', view: {
      id: values['with-id'] === true, class: values['with-class'] === true, hidden: values['with-hidden'] === true,
    } }; break
    case 'click': command = { kind: 'act', act: { op, ref: value } }; break
    case 'type': command = { kind: 'act', act: { op, ref: value, text: positional[1] ?? '', submit: values.submit === true } }; break
    case 'key': command = { kind: 'act', act: { op, key: value } }; break
    case 'scroll': command = { kind: 'act', act: { op, dy: value.trim() ? Number(value) : NaN } }; break
    case 'navigate': command = { kind: 'act', act: { op, url: value } }; break
    case 'wait': command = { kind: 'act', act: { op, ms: value.trim() ? Number(value) : NaN } }; break
    case 'script': command = { kind: 'script', code: value }; break
    case 'screenshot':
      if (!value || value.startsWith('--')) throw new Error('screenshot 需要一个未存在的 PNG 输出路径')
      command = { kind: 'screenshot', full: values.full === true }; break
    default: throw new Error(`未知命令：${op}`)
  }
  if (!isCommand(command)) throw new Error(`${op} 参数无效：uid 须为正整数，URL 须为 http/https，wait 范围为 0–10000ms`)
  return { token, command, timeoutMs: seconds * 1000, ...(op === 'screenshot' ? { output: value } : {}) }
}
