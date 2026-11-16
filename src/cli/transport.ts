import type { IncomingMessage, Server } from 'node:http'
import type { Command, Reply, Request } from '../shared/protocol.ts'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { DEFAULT_TIMEOUT_MS, PORT, PROTOCOL_VERSION } from '../shared/consts.ts'
import { isCommand, isReply, isToken } from '../shared/protocol.ts'

const MAX_REPLY_BYTES = 32 * 1024 * 1024

interface Options { timeoutMs?: number, port?: number, signal?: AbortSignal }

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    function cleanup(): void {
      server.off('error', failed)
      server.off('listening', ready)
    }
    function failed(error: Error): void {
      cleanup()
      reject(error)
    }
    function ready(): void {
      cleanup()
      resolve()
    }
    server.once('error', failed)
    server.once('listening', ready)
    server.listen({ host: '127.0.0.1', port, exclusive: true })
  })
}

async function close(server: Server): Promise<void> {
  if (!server.listening)
    return
  const closed = new Promise<void>(resolve => server.close(() => resolve()))
  server.closeAllConnections()
  await closed
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let failed = false
    request.on('data', (chunk: Buffer) => {
      if (failed)
        return
      size += chunk.length
      if (size > MAX_REPLY_BYTES) {
        failed = true
        chunks.length = 0
        reject(new Error('回执超过 32 MiB'))
      }
      else {
        chunks.push(chunk)
      }
    })
    request.on('end', () => {
      if (!failed)
        resolve(Buffer.concat(chunks).toString('utf8'))
    })
    request.on('error', reject)
    request.on('aborted', () => reject(new Error('回执连接中断')))
  })
}

/** 端口就是命令锁；从不缓存或重发已交付命令。 */
export async function execute(token: string, command: Command, options: Options = {}): Promise<string> {
  if (!isToken(token) || !isCommand(command))
    throw new Error('无效的 token 或命令')
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const port = options.port ?? PORT
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300_000)
    throw new Error('超时须在 0–300 秒之间')
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('无效端口')

  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(), timeoutMs)
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout.signal])
    : timeout.signal
  const request: Request = {
    version: PROTOCOL_VERSION,
    id: randomUUID(),
    token,
    deadline: Date.now() + timeoutMs,
    command,
  }
  const expired = () => signal.aborted || Date.now() >= request.deadline
  let delivered = false
  let listening = false
  let settle: ((reply: Reply) => void) | undefined
  let rejectResult: ((error: Error) => void) | undefined
  const interrupted = () => new Error(delivered
    ? '命令已送达，但等待结果超时或中断：执行结果未知，请先检查页面，勿自动重试有副作用的操作'
    : listening
      ? '等待扩展超时或中断：请确认此 token 对应的标签页仍在接管'
      : `等待端口 ${port} 超时或中断：其他命令或程序仍在占用端口`)
  const abort = () => rejectResult?.(interrupted())

  const server = createServer((req, res) => {
    const send = (status: number, body: unknown, done?: () => void) => {
      if (res.destroyed)
        return
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'connection': 'close',
      })
      res.end(status === 204
        ? undefined
        : JSON.stringify(body), done)
    }
    void (async () => {
      const origin = req.headers.origin
      if (req.headers.host !== `127.0.0.1:${port}`
        || (origin !== undefined && !/^chrome-extension:\/\/[a-p]{32}$/.test(origin))
        || req.headers.authorization !== `Bearer ${token}`) {
        send(403, { error: 'forbidden' })
        return
      }
      if (expired()) {
        send(410, { error: '命令已过期' })
        return
      }
      if (req.method === 'POST' && req.url === '/command') {
        if (delivered) {
          send(204, null)
          return
        }
        delivered = true
        send(200, request)
        return
      }
      if (req.method !== 'POST' || req.url !== '/reply') {
        send(404, { error: 'not found' })
        return
      }
      let body: unknown
      try {
        body = JSON.parse(await readBody(req))
      }
      catch (error) {
        send(error instanceof Error && error.message.includes('32 MiB')
          ? 413
          : 400, { error: '无效回执' })
        return
      }
      if (expired()) {
        send(410, { error: '命令已过期' })
        return
      }
      if (!delivered || !isReply(body) || body.id !== request.id) {
        send(409, { error: '回执不属于当前命令' })
        return
      }
      send(200, { ok: true }, () => settle?.(body))
    })().catch((error: unknown) => {
      send(500, { error: '连接处理失败' })
      rejectResult?.(error instanceof Error
        ? error
        : new Error(String(error)))
    })
  })
  server.headersTimeout = Math.min(timeoutMs, 5000)
  server.requestTimeout = timeoutMs
  server.keepAliveTimeout = 1

  try {
    while (true) {
      if (expired())
        throw interrupted()
      try {
        await listen(server, port)
        listening = true
        break
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE')
          throw error
        try {
          await delay(100, undefined, { signal })
        }
        catch {
          throw interrupted()
        }
      }
    }
    return await new Promise<string>((resolve, reject) => {
      rejectResult = reject
      settle = (reply) => {
        if (expired())
          reject(interrupted())
        else if (reply.ok)
          resolve(reply.data)
        else reject(new Error(reply.error))
      }
      signal.addEventListener('abort', abort, { once: true })
      if (expired())
        abort()
    })
  }
  finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
    await close(server)
  }
}
