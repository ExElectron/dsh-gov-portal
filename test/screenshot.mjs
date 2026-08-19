/**
 * test/screenshot.mjs — 用 Edge headless + CDP 截取平台各面板视图。
 * 用法：node test/screenshot.mjs
 */
import { spawn } from 'node:child_process'
import { WebSocket } from 'file:///C:/Users/17151/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/ws/wrapper.mjs'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const CDP_PORT = 9224
const BASE = 'http://127.0.0.1:3081/'

const edge = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run',
  '--user-data-dir=' + process.env.TEMP + '\\gov-shot-profile',
  `--remote-debugging-port=${CDP_PORT}`, '--window-size=1500,3200', BASE,
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
function send (method, params) {
  return new Promise((resolve, reject) => {
    const id = msgId++
    const onMsg = data => {
      const msg = JSON.parse(data.toString())
      if (msg.id === id) { ws.off('message', onMsg); msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result) }
    }
    ws.on('message', onMsg)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function evaluate (expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  return r.result?.value
}

async function shot (name, tabName) {
  if (tabName) {
    await evaluate(`[...document.querySelectorAll('#mainNav a')].find(a => a.dataset.tab === '${tabName}').click(); true`)
    await sleep(2500)
  }
  const base64 = (await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })).data
  const { writeFile } = await import('node:fs/promises')
  await writeFile(`shots/${name}.png`, Buffer.from(base64, 'base64'))
  console.log('已保存 shots/' + name + '.png')
}

try {
  const wsUrl = await getWsUrl()
  ws = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject) })
  await sleep(7000) // 等待异步初始化
  await shot('hall', null)          // 业务大厅（默认）
  await shot('home', 'home')        // 平台首页
  await shot('volume', 'volume')    // 电子卷宗
  await shot('config', 'config')    // 参数配置
  await shot('policy', 'policy')    // 政策法规
  await evaluate(`[...document.querySelectorAll('#mainNav a')].find(a => a.dataset.tab === 'hall').click(); true`)
  await sleep(1500)
  await shot('trail', 'trail')      // 督办流水
  console.log('截图完成')
} catch (e) {
  console.error('截图失败：', e.message)
} finally {
  try { ws?.close() } catch { /* ignore */ }
  edge.kill()
}
