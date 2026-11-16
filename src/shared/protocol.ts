import { PROTOCOL_VERSION } from './consts.ts'

export type View = { id?: boolean; class?: boolean; hidden?: boolean }

export type Act =
  | { op: 'click'; ref: string }
  | { op: 'type'; ref: string; text: string; submit?: boolean }
  | { op: 'key'; key: string }
  | { op: 'scroll'; dy: number }
  | { op: 'navigate'; url: string }
  | { op: 'wait'; ms: number }

export type Command =
  | { kind: 'state'; view: View }
  | { kind: 'act'; act: Act }
  | { kind: 'script'; code: string }
  | { kind: 'screenshot'; full: boolean }

export type Request = {
  version: typeof PROTOCOL_VERSION
  id: string
  token: string
  deadline: number
  command: Command
}

export type Reply =
  | { id: string; ok: true; data: string }
  | { id: string; ok: false; error: string }

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const isToken = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{32}$/.test(value)

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const ref = (value: unknown): value is string =>
  typeof value === 'string' && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value))
const flag = (value: unknown): boolean => value === undefined || typeof value === 'boolean'

export function isAct(value: unknown): value is Act {
  if (!isRecord(value)) return false
  switch (value.op) {
    case 'click': return ref(value.ref)
    case 'type': return ref(value.ref) && typeof value.text === 'string' && flag(value.submit)
    case 'key': return typeof value.key === 'string' && ['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(value.key)
    case 'scroll': return finite(value.dy)
    case 'navigate': {
      if (typeof value.url !== 'string') return false
      try { return ['http:', 'https:'].includes(new URL(value.url).protocol) } catch { return false }
    }
    case 'wait': return finite(value.ms) && value.ms >= 0 && value.ms <= 10_000
    default: return false
  }
}

export function isCommand(value: unknown): value is Command {
  if (!isRecord(value)) return false
  switch (value.kind) {
    case 'state': return isRecord(value.view) && flag(value.view.id) && flag(value.view.class) && flag(value.view.hidden)
    case 'act': return isAct(value.act)
    case 'script': return typeof value.code === 'string' && value.code.trim().length > 0
    case 'screenshot': return typeof value.full === 'boolean'
    default: return false
  }
}

export function isRequest(value: unknown): value is Request {
  return isRecord(value) && value.version === PROTOCOL_VERSION &&
    typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 64 &&
    isToken(value.token) && finite(value.deadline) && isCommand(value.command)
}

export function isReply(value: unknown): value is Reply {
  return isRecord(value) && typeof value.id === 'string' &&
    ((value.ok === true && typeof value.data === 'string') ||
      (value.ok === false && typeof value.error === 'string'))
}
