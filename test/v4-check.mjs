/**
 * test/v4-check.mjs — 验证本轮修改：
 * 工作目录下拉 / 卷宗三按钮 / 删除验证码弹窗 / 新建卷宗确认工作区 / 首页跳转 / 友情链接删除 / 头条引号
 */
import { spawn } from 'node:child_process'
import { WebSocket } from 'file:///C:/Users/17151/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/ws/wrapper.mjs'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const CDP_PORT = 9231
const BASE = 'http://127.0.0.1:3081/'

const edge = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run',
  '--user-data-dir=' + process.env.TEMP + '\\gov-v4-profile',
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

let pass = 0
const fails = []
function check (cond, label, extra) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  → ' + JSON.stringify(extra).slice(0, 160)}`)
  if (cond) pass++; else fails.push(label)
}

try {
  const wsUrl = await getWsUrl()
  ws = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject) })
  await sleep(8000)

  // 1. 工作目录下拉
  check(await evaluate(`document.getElementById('selCwd') !== null && document.getElementById('selCwd').options.length >= 1`), '工作目录下拉存在')
  check(await evaluate(`document.getElementById('selCwd').options.length > 0 && (document.getElementById('selCwd').value.length > 0 || [...document.getElementById('selCwd').options].some(o => o.textContent.includes('选择文件夹')))`), '工作目录下拉已填充（目录或选择项）', await evaluate(`[...document.getElementById('selCwd').options].map(o=>o.textContent).join(' | ')`))
  check(await evaluate(`[...document.getElementById('selCwd').options].some(o => o.textContent.includes('选择文件夹')) && [...document.getElementById('selCwd').options].some(o => o.textContent.includes('新建工作区'))`), '下拉含「选择文件夹」「新建工作区」选项')

  // 2. 卷宗三按钮（无「打开」）
  await evaluate(`[...document.querySelectorAll('#mainNav a')].find(a=>a.dataset.tab==='volume').click(); true`)
  await sleep(1500)
  const btnTexts = await evaluate(`[...document.querySelectorAll('#volumeTable tbody tr td:last-child button')].map(b=>b.textContent).join(',')`)
  check(btnTexts.includes('查阅') && btnTexts.includes('导出') && btnTexts.includes('删除') && !btnTexts.includes('打开'), '卷宗操作按钮为 查阅/导出/删除（无打开）', btnTexts)

  // 3. 删除按钮弹验证码窗
  await evaluate(`document.querySelector('#volumeTable tbody [data-delete]').click(); true`)
  await sleep(600)
  check(await evaluate(`document.querySelector('#delCaptchaCanvas') !== null && document.querySelector('#delCaptchaInput') !== null`), '删除弹窗含图片验证码 + 输入框')

  // 4. 关闭删除弹窗（点取消）
  await evaluate(`[...document.querySelectorAll('.gov-dialog .dlg-foot button')].find(b=>b.textContent==='取消').click(); true`)
  await sleep(400)

  // 5. 新建卷宗弹窗确认工作区
  await evaluate(`document.getElementById('btnVolumeNew').click(); true`)
  await sleep(600)
  check(await evaluate(`document.querySelector('#wsPathInput') !== null && document.querySelector('#wsPickBtn') !== null && document.querySelector('#wsNewBtn') !== null`), '新建卷宗弹窗含工作区选择（路径输入/选文件夹/新建工作区）')
  await evaluate(`[...document.querySelectorAll('.gov-dialog .dlg-foot button')].find(b=>b.textContent==='取消').click(); true`)
  await sleep(400)

  // 6. 首页通知点击 → 详情弹窗
  await evaluate(`[...document.querySelectorAll('#mainNav a')].find(a=>a.dataset.tab==='home').click(); true`)
  await sleep(800)
  await evaluate(`document.querySelector('#homeNoticeList a[data-notice]').click(); true`)
  await sleep(500)
  check(await evaluate(`[...document.querySelectorAll('.gov-dialog .dlg-title')].some(t=>t.textContent.includes('通知详情'))`), '通知点击弹出详情弹窗')
  await evaluate(`[...document.querySelectorAll('.gov-dialog .dlg-foot button')].find(b=>b.textContent==='关闭').click(); true`)
  await sleep(300)

  // 7. 友情链接已删除 + 头条引号
  check(await evaluate(`document.querySelector('.home-links') === null`), '友情链接区块已删除')
  check(await evaluate(`document.getElementById('homeMemo').textContent.includes('“至公至正 · 智能协同 · 自主运转“')`), '头条使用双引号（“至公至正…“）')

  console.log(`\n${pass}/${pass + fails.length} 通过`)
  process.exitCode = fails.length ? 1 : 0
} catch (e) {
  console.error('验证失败：', e.message)
  process.exitCode = 2
} finally {
  try { ws?.close() } catch { /* ignore */ }
  edge.kill()
}
