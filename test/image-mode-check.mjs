/**
 * test/image-mode-check.mjs — 验证弹窗「自定义图片铺满」模式：
 * 注入图片配置 → 重建弹窗 → 断言图片铺满弹窗且关闭叉位于图片右上角。
 */
import { spawn } from 'node:child_process'
import { WebSocket } from 'file:///C:/Users/17151/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/ws/wrapper.mjs'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const CDP_PORT = 9225
const BASE = 'http://127.0.0.1:3081/'

const edge = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run',
  '--user-data-dir=' + process.env.TEMP + '\\gov-img-profile',
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

const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

let pass = 0
const fails = []
function check (cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`)
  if (cond) pass++; else fails.push(label)
}

try {
  const wsUrl = await getWsUrl()
  ws = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject) })
  await sleep(7000)

  // 1) 注入图片配置并重建弹窗
  await evaluate(`(() => {
    const cfg = GOVConfig.load()
    cfg.floatNotice.image = '${PNG_1PX}'
    cfg.floatNotice.imageWidth = 400
    GOVConfig.save(cfg)
    GOVFloat.rebuild()
    return true
  })()`)
  await sleep(1200)

  // 2) 断言图片模式
  check(await evaluate(`document.querySelector('.float-modal.notice').classList.contains('image-mode')`), '通知弹窗进入图片模式')
  check(await evaluate(`document.querySelector('.float-modal.notice .fm-img-wrap img') !== null`), '图片元素已铺入弹窗')
  check(await evaluate(`(() => {
    const el = document.querySelector('.float-modal.notice')
    const img = el.querySelector('.fm-img-wrap img')
    const close = el.querySelector('.fm-close')
    const iw = img.getBoundingClientRect().width
    const cw = close.getBoundingClientRect().width
    const cr = close.getBoundingClientRect()
    const ir = img.getBoundingClientRect()
    return Math.abs(cr.top - ir.top) < 2 && Math.abs((cr.left + cw) - (ir.left + iw)) < 2
  })()`), '关闭叉位于图片右上角')
  check(await evaluate(`document.querySelector('.float-modal.notice .fm-head') === null && document.querySelector('.float-modal.notice .fm-title') === null`), '图片模式下无文字标题结构')

  // 3) 恢复默认配置
  await evaluate(`(() => {
    const cfg = GOVConfig.load()
    cfg.floatNotice.image = ''
    GOVConfig.save(cfg)
    GOVFloat.rebuild()
    return true
  })()`)
  await sleep(800)
  check(await evaluate(`!document.querySelector('.float-modal.notice').classList.contains('image-mode')`), '清空图片后恢复内置红头样式')

  console.log(`\n${pass}/${pass + fails.length} 通过`)
  process.exitCode = fails.length ? 1 : 0
} catch (e) {
  console.error('验证失败：', e.message)
  process.exitCode = 2
} finally {
  try { ws?.close() } catch { /* ignore */ }
  edge.kill()
}
