/**
 * test/v3-check.mjs — v3 修复验证（前端静态改动，热重载即生效）：
 * 页脚浏览器建议 / 访问计数显示 / Markdown 表格渲染。
 */
import { spawn } from 'node:child_process'
import { WebSocket } from 'file:///C:/Users/17151/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/ws/wrapper.mjs'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const CDP_PORT = 9226
const BASE = 'http://127.0.0.1:3081/'

const edge = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run',
  '--user-data-dir=' + process.env.TEMP + '\\gov-v3-profile',
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

let pass = 0
const fails = []
function check (cond, label, extra) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  → ' + JSON.stringify(extra).slice(0, 140)}`)
  if (cond) pass++; else fails.push(label)
}

try {
  const wsUrl = await getWsUrl()
  ws = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject) })
  await sleep(7000)

  check(await evaluate(`document.getElementById('footerBeian').parentElement.textContent.includes('建议使用 IE8')`), '页脚含浏览器建议（IE8/360）')
  check(await evaluate(`/^\\d{6}$/.test(document.getElementById('visitCount').textContent)`), '访问计数为 6 位数字', await evaluate(`document.getElementById('visitCount').textContent`))

  const mdTable = await evaluate(`GOV.renderMarkdown('| 类型 | 名称 |\\n|---|---|\\n| 文件夹 | docs |')`)
  check(mdTable.includes('<table') && mdTable.includes('<th>类型</th>') && mdTable.includes('<td>docs</td>'), 'Markdown 表格渲染为表格', mdTable)

  const mdMixed = await evaluate(`GOV.renderMarkdown("## 标题\\n\\n**加粗** 与 \`代码\`\\n\\n- 项目一\\n- 项目二")`)
  check(mdMixed.includes('<h2') && mdMixed.includes('<b>加粗</b>') && mdMixed.includes('<li>项目一</li>'), 'Markdown 标题/加粗/列表正常', mdMixed)

  // 权限消息不再自动发送：检查页面代码中 submitPrompt 不含 /permission 的 prompt 调用
  const appSrc = await (await fetch(BASE + '/js/app.js')).text()
  check(!appSrc.includes('text: `/permission'), '提交流程不再发送 /permission 消息')

  // 无本地回显
  check(!appSrc.includes('本地回显'), '已移除本地回显（不再双显示）')

  console.log(`\n${pass}/${pass + fails.length} 通过`)
  process.exitCode = fails.length ? 1 : 0
} catch (e) {
  console.error('验证失败：', e.message)
  process.exitCode = 2
} finally {
  try { ws?.close() } catch { /* ignore */ }
  edge.kill()
}
