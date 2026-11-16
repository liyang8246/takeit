import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:net'
import { request as httpRequest } from 'node:http'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { execute } from '../src/cli/transport.ts'
import { isRequest, type Command, type Request } from '../src/shared/protocol.ts'

const TOKEN = 'a'.repeat(32)
const OTHER = 'b'.repeat(32)
const command: Command = { kind: 'state', view: { id: true } }
const cleanup = new AbortController()
const tasks: Promise<string>[] = []
const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()))
const listen = (server: Server, port: number) => new Promise<number>((resolve, reject) => {
  server.once('error', reject)
  server.listen(port, '127.0.0.1', () => {
    const address = server.address()
    if (!address || typeof address === 'string') return reject(new Error('没有测试端口'))
    resolve(address.port)
  })
})
const probe = createServer()
const port = await listen(probe, 0)
await close(probe)
const base = `http://127.0.0.1:${port}`
const headers = (token = TOKEN) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' })

async function fetchReady(path: string, init: RequestInit = {}): Promise<Response> {
  const end = Date.now() + 3000
  while (true) {
    try { return await fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(500) }) } catch (error) {
      if (Date.now() >= end) throw error
      await delay(10)
    }
  }
}
async function claim(token = TOKEN): Promise<Request> {
  const response = await fetchReady('/command', { method: 'POST', headers: headers(token) })
  assert.equal(response.status, 200)
  const body: unknown = await response.json()
  assert.ok(isRequest(body))
  assert.equal(body.token, token)
  return body
}
async function reply(id: string, data = 'snapshot', token = TOKEN): Promise<void> {
  const response = await fetch(`${base}/reply`, {
    method: 'POST', headers: headers(token), body: JSON.stringify({ id, ok: true, data }),
  })
  assert.equal(response.status, 200)
  await response.text()
}
function start(token = TOKEN, timeoutMs = 2000, signal?: AbortSignal): Promise<string> {
  const task = execute(token, command, { port, timeoutMs, signal: signal ? AbortSignal.any([signal, cleanup.signal]) : cleanup.signal })
  tasks.push(task)
  void task.catch(() => {})
  return task
}
async function free(): Promise<void> {
  const server = createServer()
  await listen(server, port)
  await close(server)
}

try {
  const first = start()
  const denied = await fetchReady('/command', { method: 'POST' })
  assert.equal(denied.status, 403)
  assert.ok(!(await denied.text()).includes(TOKEN), '拒绝响应不能泄漏 token')
  const wrong = await fetch(`${base}/command`, { method: 'POST', headers: headers(OTHER) })
  assert.equal(wrong.status, 403)
  const hostile = await fetch(`${base}/command`, { method: 'POST', headers: { ...headers(), origin: 'https://evil.test' } })
  assert.equal(hostile.status, 403)
  const hostStatus = await new Promise<number>((resolve, reject) => {
    const req = httpRequest(`${base}/command`, { method: 'POST', headers: { ...headers(), host: 'evil.test' } }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode ?? 0))
    })
    req.on('error', reject)
    req.end()
  })
  assert.equal(hostStatus, 403)
  const missing = await fetch(`${base}/unknown`, { method: 'POST', headers: headers() })
  assert.equal(missing.status, 404)
  const request = await claim()
  assert.deepEqual(request.command, command)
  const duplicatePoll = await fetch(`${base}/command`, { method: 'POST', headers: headers() })
  assert.equal(duplicatePoll.status, 204, '一次性命令不能重发')
  for (const body of ['{', JSON.stringify({ id: 'old', ok: true, data: 'bad' }), JSON.stringify({ id: request.id, ok: true })]) {
    const response = await fetch(`${base}/reply`, { method: 'POST', headers: headers(), body })
    assert.ok(response.status === 400 || response.status === 409)
  }
  await reply(request.id)
  assert.equal(await first, 'snapshot')
  await free()
  console.log('ok  一次性往返、鉴权/Origin/Host、错误回执、单次投递与端口释放')

  const failure = start()
  const failed = await claim()
  await fetch(`${base}/reply`, {
    method: 'POST', headers: headers(), body: JSON.stringify({ id: failed.id, ok: false, error: '页面执行失败' }),
  })
  await assert.rejects(failure, /页面执行失败/)
  await free()
  console.log('ok  扩展错误传播并释放端口')

  const holder = createServer()
  await listen(holder, port)
  const queued = start()
  await delay(50)
  await close(holder)
  const queuedRequest = await claim()
  await reply(queuedRequest.id, 'after-port-release')
  assert.equal(await queued, 'after-port-release')
  await free()
  console.log('ok  端口被占用时等待，释放后执行')

  const busy = createServer()
  await listen(busy, port)
  try { await assert.rejects(start(TOKEN, 120), /等待端口/) } finally { await close(busy) }
  await free()
  await assert.rejects(start(TOKEN, 120), /等待扩展/)
  await free()
  console.log('ok  占用超时/无扩展超时均退出且无残留监听')

  const timed = start(TOKEN, 200)
  const old = await claim()
  await assert.rejects(timed, /执行结果未知/)
  await free()
  const next = start()
  const current = await claim()
  assert.notEqual(current.id, old.id)
  const late = await fetch(`${base}/reply`, {
    method: 'POST', headers: headers(), body: JSON.stringify({ id: old.id, ok: true, data: 'late' }),
  })
  assert.equal(late.status, 409, '迟到回执不能结束下一条 CLI')
  await reply(current.id, 'current')
  assert.equal(await next, 'current')
  await free()
  console.log('ok  已投递超时标记结果未知，旧回执不能认领新命令')

  const clockCancel = new AbortController()
  const clockTask = start(TOKEN, 2000, clockCancel.signal)
  const clockRequest = await claim()
  const realNow = Date.now
  try {
    Date.now = () => clockRequest.deadline + 1
    const expiredReply = await fetch(`${base}/reply`, {
      method: 'POST', headers: headers(), body: JSON.stringify({ id: clockRequest.id, ok: true, data: 'too late' }),
    })
    assert.equal(expiredReply.status, 410, '即使 timer 尚未调度，也不得接受越过 deadline 的回执')
  } finally {
    Date.now = realNow
    clockCancel.abort()
  }
  await assert.rejects(clockTask, /执行结果未知/)
  await free()
  console.log('ok  截止时间校验不依赖 timer 调度')

  const one = start()
  const oneRequest = await claim()
  const two = start(OTHER)
  await reply(oneRequest.id, 'one')
  assert.equal(await one, 'one')
  const twoRequest = await claim(OTHER)
  const oldToken = await fetch(`${base}/command`, { method: 'POST', headers: headers(TOKEN) })
  assert.equal(oldToken.status, 403)
  await reply(twoRequest.id, 'two', OTHER)
  assert.equal(await two, 'two')
  await free()
  console.log('ok  两个调用竞争端口互斥，不共享 token 或请求 id')

  const cancel = new AbortController()
  const canceled = start(TOKEN, 2000, cancel.signal)
  await claim()
  cancel.abort()
  await assert.rejects(canceled, /执行结果未知/)
  await free()
  const before = new AbortController()
  before.abort()
  await assert.rejects(start(TOKEN, 2000, before.signal), /中断/)
  await free()
  console.log('ok  中断清理，未投递/已投递结果区分')

  const cli = fileURLToPath(new URL('../dist/cli.mjs', import.meta.url))
  async function run(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const child = spawn(process.execPath, [cli, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk: Buffer) => { stderr += String(chunk) })
    const timer = setTimeout(() => child.kill(), 3000)
    try {
      const code = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve) })
      return { code, stdout, stderr }
    } finally { clearTimeout(timer); if (child.exitCode === null) child.kill() }
  }
  const help = await run(['--help'])
  assert.equal(help.code, 0)
  assert.match(help.stdout, /@liyang8246\/takeit/)
  assert.equal(help.stderr, '')
  const invalid = await run([TOKEN, 'click', 'not-a-uid'])
  assert.equal(invalid.code, 1)
  assert.equal(invalid.stdout, '')
  assert.match(invalid.stderr, /参数无效/)
  console.log('ok  新构建 CLI 帮助/参数校验无需扩展即可退出')
  console.log('\n全部一次性传输自检通过')
} finally {
  cleanup.abort()
  await Promise.allSettled(tasks)
}
