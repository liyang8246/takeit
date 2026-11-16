/** 仅轮询临时 CLI；没有命令时不需要常驻本地服务。 */
import type { Reply, Request } from '../shared/protocol.ts'
import { POLL_INTERVAL_MS, PORT } from '../shared/consts.ts'
import { isRecord, isReply, isRequest, isToken } from '../shared/protocol.ts'

const BASE = `http://127.0.0.1:${PORT}`
const MAX_SEEN = 1024
const seen = new Map<string, number>()
let controller: AbortController | undefined
let activeToken: string | undefined

const err = (e: unknown): string => e instanceof Error ? e.message : String(e)

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
    if (signal.aborted) done()
  })
}

async function post(path: '/command' | '/reply', token: string, signal: AbortSignal, body?: Reply): Promise<unknown> {
  const request = new AbortController()
  const abort = () => request.abort()
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  const timer = setTimeout(abort, 2000)
  try {
    const response = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: request.signal,
    })
    if (!response.ok) throw new Error(`CLI HTTP ${response.status}`)
    if (path === '/command' && response.status !== 204) return await response.json()
    return undefined
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
  }
}

async function execute(request: Request, signal: AbortSignal): Promise<Reply> {
  const failure = (error: string): Reply => ({ id: request.id, ok: false, error })
  if (signal.aborted) return failure('接管已撤销，未执行')
  const now = Date.now()
  for (const [id, deadline] of seen) if (deadline <= now) seen.delete(id)
  if (request.deadline <= now) return failure('命令已过期，未执行')
  const key = `${request.token}:${request.id}`
  if (seen.has(key)) return failure('命令重复，未再次执行')
  if (seen.size >= MAX_SEEN) return failure('命令去重缓存已满，请等待已有命令过期')
  seen.set(key, request.deadline)

  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  try {
    const cancelled = new Promise<Reply>((resolve) => {
      abort = () => resolve(failure('接管已撤销；已开始的操作不能保证回滚，请勿自动重试'))
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      timer = setTimeout(() => resolve(failure('命令超时，执行结果未知；请勿自动重试')), Math.min(request.deadline - now, 2_147_483_647))
    })
    // 这里只结束传输等待；SW 仍持有执行槽直到真实 CDP Promise 结束。
    const result: unknown = await Promise.race([chrome.runtime.sendMessage({ type: 'EXEC', request }), cancelled])
    if (!isReply(result) || result.id !== request.id) return failure('SW 返回无效应答；执行结果未知，请勿自动重试')
    return result
  } catch (e) {
    return failure(`执行结果未知: ${err(e)}；请勿自动重试`)
  } finally {
    clearTimeout(timer)
    if (abort) signal.removeEventListener('abort', abort)
  }
}

async function loop(token: string, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    try {
      const value = await post('/command', token, signal)
      if (signal.aborted) return
      if (value !== undefined) {
        if (!isRequest(value) || value.token !== token) throw new Error('无效命令协议或 Token')
        const reply = await execute(value, signal)
        if (signal.aborted) return
        await post('/reply', token, signal, reply)
      }
    } catch {
      // 错误 token、协议错误、CLI 未启动都延迟重试；绝不自动重试已投递命令。
    }
    await wait(POLL_INTERVAL_MS, signal)
  }
}

chrome.runtime.onMessage.addListener((msg: unknown, source, respond) => {
  if (!isRecord(msg) || source.id !== chrome.runtime.id || source.tab) return
  if (msg.type === 'CONNECT' && isToken(msg.token)) {
    // SW 恢复会重发 CONNECT；同一授权不能中止正等待 EXEC 的轮询。
    if (activeToken === msg.token && controller && !controller.signal.aborted) {
      respond({ ok: true })
      return
    }
    controller?.abort()
    activeToken = msg.token
    controller = new AbortController()
    void loop(msg.token, controller.signal)
    respond({ ok: true })
  } else if (msg.type === 'DISCONNECT') {
    controller?.abort()
    controller = undefined
    activeToken = undefined
    respond({ ok: true })
  }
})
