/**
 * test/v5-check.mjs - volume actions, live reasoning efforts, government styling and loading transition.
 */
import { spawn } from 'node:child_process'
import { WebSocket } from 'file:///C:/Users/17151/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/ws/wrapper.mjs'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const CDP_PORT = 9237
const BASE = 'http://127.0.0.1:3081/'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function rpc (method, payload = {}) {
  const rpcId = crypto.randomUUID()
  const response = await fetch(`${BASE}api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
  })
  const envelope = await response.json()
  if (!envelope.result?.ok) throw new Error(`${method}: ${envelope.result?.error?.message ?? response.status}`)
  return envelope.result.value
}

const created = await rpc('session.create', { cwd: process.cwd() })
const temporarySessionId = created.sessionId
const edge = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run',
  `--user-data-dir=${process.env.TEMP}\\gov-v5-profile-${Date.now()}`,
  `--remote-debugging-port=${CDP_PORT}`, '--window-size=1500,2400', BASE,
], { stdio: 'ignore' })

async function getWsUrl () {
  for (let index = 0; index < 30; index++) {
    try {
      const list = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then(response => response.json())
      const page = list.find(target => target.type === 'page')
      if (page) return page.webSocketDebuggerUrl
    } catch { /* retry */ }
    await sleep(500)
  }
  throw new Error('CDP did not become ready')
}

let ws
let messageId = 1
function evaluate (expression) {
  return new Promise((resolve, reject) => {
    const id = messageId++
    const onMessage = data => {
      const message = JSON.parse(data.toString())
      if (message.id !== id) return
      ws.off('message', onMessage)
      if (message.error) reject(new Error(message.error.message))
      else resolve(message.result?.result?.value)
    }
    ws.on('message', onMessage)
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
  })
}

let pass = 0
const failures = []
function check (condition, label, detail) {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${condition ? '' : ` -> ${JSON.stringify(detail)}`}`)
  if (condition) pass++
  else failures.push(label)
}

try {
  ws = new WebSocket(await getWsUrl())
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject) })
  await sleep(7000)

  const efforts = await evaluate(`(() => {
    const model = document.getElementById('selModel')
    model.value = 'deepseek-official::deepseek-v4-flash'
    model.dispatchEvent(new Event('change', { bubbles: true }))
    return [...document.getElementById('selEffort').options].map(option => option.value)
  })()`)
  check(['off', 'high', 'max'].every(value => efforts.includes(value)), 'DeepSeek reasoning efforts come from live Harness catalog', efforts)

  await evaluate(`GOVApp.switchTab('volume'); true`)
  await sleep(1200)
  const rowFound = await evaluate(`!!document.querySelector('[data-preview="${temporarySessionId}"]')`)
  check(rowFound, 'Temporary volume appears in electronic archive')

  await evaluate(`document.querySelector('[data-preview="${temporarySessionId}"]').click(); true`)
  await sleep(1200)
  const opened = await evaluate(`({
    hallVisible: getComputedStyle(document.getElementById('page-hall')).display !== 'none',
    sessionId: GOVApp.state.sessionId,
    focused: document.activeElement?.id
  })`)
  check(opened.hallVisible && opened.sessionId === '${temporarySessionId}', 'Review button opens the selected volume in business hall', opened)

  await evaluate(`GOVApp.switchTab('volume'); true`)
  await sleep(700)
  await evaluate(`window.alert = () => {}; document.querySelector('[data-delete="${temporarySessionId}"]').click(); true`)
  await sleep(500)
  const captchaReady = await evaluate(`!!document.querySelector('#delCaptchaCanvas') && !!document.querySelector('#delCaptchaInput')`)
  check(captchaReady, 'Delete button opens image verification')
  await evaluate(`(() => {
    const mask = document.querySelector('.gov-mask')
    mask.querySelector('#delCaptchaInput').value = mask.__captcha
    ;[...mask.querySelectorAll('.dlg-foot button')].find(button => button.textContent === '确定删除').click()
    return true
  })()`)
  await sleep(1300)
  const sessions = await rpc('session.list', {})
  check(!sessions.items.some(item => item.sessionId === temporarySessionId), 'Verified delete archives the volume in Harness')

  await evaluate(`document.getElementById('btnVolumeRefresh').click(); true`)
  await sleep(60)
  check(await evaluate(`document.getElementById('pageLoading').classList.contains('show')`), 'Buttons trigger short white loading transition')
  await evaluate(`GOVConfig.set('misc.pageLoadingEnabled', false); document.getElementById('pageLoading').classList.remove('show'); document.getElementById('btnVolumeRefresh').click(); true`)
  await sleep(60)
  check(await evaluate(`!document.getElementById('pageLoading').classList.contains('show')`), 'Loading transition can be disabled in settings')
  await evaluate(`GOVConfig.set('misc.pageLoadingEnabled', true); GOVApp.switchTab('home'); true`)
  await sleep(700)
  await evaluate(`document.querySelector('#homeNoticeList a[data-notice]').click(); true`)
  await sleep(500)
  check(await evaluate(`getComputedStyle(document.getElementById('page-notice')).display !== 'none' && document.querySelectorAll('.gov-dialog').length === 0`), 'Home notice opens a standalone content page')

  const visual = await evaluate(`({
    navBackground: getComputedStyle(document.querySelector('.navbar')).backgroundImage,
    activeBackground: getComputedStyle(document.querySelector('#mainNav a.active')).backgroundColor,
    buttonRadius: getComputedStyle(document.querySelector('.gov-btn')).borderRadius,
    bannerBackground: getComputedStyle(document.querySelector('.home-banner')).backgroundImage
  })`)
  check(visual.navBackground === 'none' && visual.bannerBackground === 'none' && visual.buttonRadius === '0px', 'Government UI uses flat navigation, white topic band and square controls', visual)

  console.log(`\n${pass}/${pass + failures.length} passed`)
  process.exitCode = failures.length ? 1 : 0
} catch (error) {
  console.error('Verification failed:', error.message)
  process.exitCode = 2
} finally {
  try {
    const sessions = await rpc('session.list', {})
    if (sessions.items.some(item => item.sessionId === temporarySessionId)) await rpc('workspace.archiveSession', { sessionId: temporarySessionId })
  } catch { /* best-effort cleanup */ }
  try { ws?.close() } catch { /* ignore */ }
  edge.kill()
}
