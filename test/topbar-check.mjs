/**
 * test/topbar-check.mjs — 诊断顶部工具条位置。
 */
import { spawn } from 'node:child_process'
import { WebSocket } from 'file:///C:/Users/17151/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/ws/wrapper.mjs'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const CDP_PORT = 9227
const BASE = 'http://127.0.0.1:3081/'

const edge = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run',
  '--user-data-dir=' + process.env.TEMP + '\\gov-topbar-profile',
  `--remote-debugging-port=${CDP_PORT}`, '--window-size=1500,2400', BASE,
], { stdio: 'ignore' })
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function getWsUrl () {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
      const list = await res.json()
      const page = list.find(t => t.type === 'page')
      if (page) return page.webSocketDebuggerUrl
    } catch { /* retry */ }
    await sleep(500)
  }
  throw new Error('CDP 未就绪')
}

let ws
let msgId = 1
function evaluate (expression) {
  return new Promise((resolve, reject) => {
    const id = msgId++
    const onMsg = data => {
      const msg = JSON.parse(data.toString())
      if (msg.id === id) { ws.off('message', onMsg); msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result?.result?.value) }
    }
    ws.on('message', onMsg)
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
  })
}

try {
  const wsUrl = await getWsUrl()
  ws = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject) })
  await sleep(7000)

  const info = await evaluate(`(() => {
    const tb = document.querySelector('.topbar')
    const r = tb.getBoundingClientRect()
    const first = document.body.firstElementChild
    return {
      topbarTop: r.top, topbarHeight: r.height,
      firstChildTag: first ? first.tagName + '.' + first.className : null,
      bodyMarginTop: getComputedStyle(document.body).marginTop,
      bodyPaddingTop: getComputedStyle(document.body).paddingTop,
      scrollY: window.scrollY,
      topbarText: tb.textContent.trim().slice(0, 60),
      viewportH: innerHeight,
      allTopbars: document.querySelectorAll('.topbar').length,
    }
  })()`)
  console.log(JSON.stringify(info, null, 2))

  // 截图顶部 400px
  const shot = await new Promise((resolve, reject) => {
    const id = msgId++
    const onMsg = data => {
      const msg = JSON.parse(data.toString())
      if (msg.id === id) { ws.off('message', onMsg); resolve(msg.result?.data) }
    }
    ws.on('message', onMsg)
    ws.send(JSON.stringify({ id, method: 'Page.captureScreenshot', params: { format: 'png', captureBeyondViewport: false, clip: { x: 0, y: 0, width: 1500, height: 400, scale: 1 } } }))
  })
  const { writeFile } = await import('node:fs/promises')
  await writeFile('shots/topbar-debug.png', Buffer.from(shot, 'base64'))
  console.log('已保存 shots/topbar-debug.png')
} catch (e) {
  console.error('诊断失败：', e.message)
} finally {
  try { ws?.close() } catch { /* ignore */ }
  edge.kill()
}
