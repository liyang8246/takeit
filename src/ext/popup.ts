import { PACKAGE } from '../shared/consts.ts'
import { isRecord, isToken } from '../shared/protocol.ts'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const go = $<HTMLButtonElement>('go')
const copy = $<HTMLButtonElement>('copy')
const dot = $('dot')
const state = $('state')
const notice = $('notice')
const tokenEl = $('token')
const tokenRow = $('token-row')
const divider = $('divider')

$('ver').textContent = `v${chrome.runtime.getManifest().version}`

let currentTabId: number | undefined
let auth: { tabId: number, token: string } | undefined
let busy = false
let revision = 0
let timer: ReturnType<typeof setTimeout> | undefined

function error(e: unknown) {
  return e instanceof Error
    ? e.message
    : String(e)
}
function promptFor(token: string) {
  return [
    '接管我的浏览器标签页。先运行：',
    `npx -y ${PACKAGE} ${token} help`,
    '每条命令临时连接，执行结束即退出；无需桥接文件或守护进程。',
    'Token 只授权当前接管标签页。命令超时可能已经执行，请勿自动重试。',
  ].join('\n')
}

function render(value: unknown): void {
  auth = undefined
  const valid = isRecord(value) && value.ok === true
  const current = valid && value.state === 'current' && value.tabId === currentTabId && isToken(value.token)
  const other = valid && value.state === 'other'
  tokenRow.hidden = !current
  divider.hidden = !current
  tokenEl.textContent = current
    ? String(value.token)
    : ''
  copy.disabled = !current
  dot.classList.toggle('on', Boolean(current))
  go.classList.toggle('stop', Boolean(current))
  go.textContent = current
    ? '停止接管'
    : other ? '接管当前标签页' : '开始接管'
  go.disabled = currentTabId === undefined || busy
  if (current) {
    auth = {
      tabId: currentTabId!,
      token: String(value.token),
    }
    state.textContent = '当前标签页已接管'
    notice.textContent = value.blocked === true
      ? '内部页面只能导航到 http/https 网页；其他操作不可执行。'
      : '复制提示词交给 agent；每条命令临时连接，无需守护进程。'
  }
  else if (other) {
    state.textContent = '其他标签页正在接管'
    notice.textContent = '接管当前标签页会停止旧接管，并撤销旧 Token。'
  }
  else {
    state.textContent = valid ? '未接管' : '读取接管状态失败'
    notice.textContent = '一次仅接管一个标签页；浏览器重启后需要重新授权。'
  }
}

async function refresh(): Promise<void> {
  if (currentTabId === undefined || busy)
    return
  const mine = ++revision
  const result: unknown = await chrome.runtime.sendMessage({ type: 'PING', tabId: currentTabId }).catch(() => null)
  if (mine === revision && !busy)
    render(result)
}

async function tick(): Promise<void> {
  clearTimeout(timer)
  await refresh()
  timer = setTimeout(() => void tick(), 1000)
}

go.addEventListener('click', () => {
  if (busy || currentTabId === undefined)
    return
  const stopping = auth
  busy = true
  revision += 1
  go.disabled = true
  copy.disabled = true
  state.textContent = stopping ? '停止中…' : '接管中…'
  void (async () => {
    let failure = ''
    try {
      const result: unknown = await chrome.runtime.sendMessage(stopping
        ? { type: 'STOP', tabId: stopping.tabId, token: stopping.token }
        : { type: 'START', tabId: currentTabId })
      if (!isRecord(result) || result.ok !== true) {
        failure = isRecord(result) && typeof result.error === 'string'
          ? result.error
          : '操作失败'
      }
    }
    catch (e) { failure = error(e) }
    finally {
      busy = false
      await refresh()
      if (failure)
        notice.textContent = failure
      else if (!stopping)
        await copyPrompt()
    }
  })()
})

async function copyPrompt(): Promise<void> {
  if (busy || !auth)
    return
  const selected = auth
  copy.disabled = true
  try {
    const result: unknown = await chrome.runtime.sendMessage({ type: 'PING', tabId: selected.tabId })
    if (!isRecord(result) || result.ok !== true || result.state !== 'current' || result.tabId !== selected.tabId || result.token !== selected.token) {
      render(result)
      throw new Error('接管已切换，未复制旧 Token')
    }
    if (busy || auth?.token !== selected.token)
      throw new Error('接管状态已变化，未复制旧 Token')
    await navigator.clipboard.writeText(promptFor(selected.token))
    notice.textContent = '提示词已复制'
  }
  catch (e) { notice.textContent = `复制失败：${error(e)}` }
  finally { copy.disabled = !auth || busy }
}

copy.addEventListener('click', () => {
  void copyPrompt()
})

void (async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    currentTabId = tab?.id
    if (currentTabId === undefined) {
      state.textContent = '找不到当前标签页'
      return
    }
    await tick()
  }
  catch (e) { state.textContent = error(e) }
})()

window.addEventListener('unload', () => clearTimeout(timer))
