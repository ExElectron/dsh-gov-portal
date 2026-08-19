/**
 * test/e2e-check.mjs — 用 Edge headless + CDP 做运行时端到端验证。
 * 启动 Edge（远程调试端口 9223）打开 3081 页面，等待异步初始化完成后，
 * 通过 Runtime.evaluate 读取关键 DOM 状态并断言。
 * 用法：node test/e2e-check.mjs [url] [edge路径]
 */
import { spawn } from 'node:child_process'
import { WebSocket } from 'file:///C:/Users/17151/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/ws/wrapper.mjs'

const URL_PAGE = process.argv[2] ?? 'http://127.0.0.1:3081/'
const EDGE = process.argv[3] ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const CDP_PORT = 9223

const edge = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--user-data-dir=' + process.env.TEMP + '\\gov-e2e-profile',
  `--remote-debugging-port=${CDP_PORT}`, '--window-size=1500,3200', URL_PAGE,
], { stdio: 'ignore' })

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function getWsUrl () {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
      const list = await res.json()
      const page = list.find(t => t.type === 'page' && t.url.includes('3081'))
      if (page) return page.webSocketDebuggerUrl
    } catch { /* not up yet */ }
    await sleep(500)
  }
  throw new Error('CDP 端点未就绪')
}

function evaluate (ws, id, expression) {
  return new Promise((resolve, reject) => {
    const onMsg = data => {
      const msg = JSON.parse(data.toString())
      if (msg.id === id) { ws.off('message', onMsg); msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result?.result?.value) }
    }
    ws.on('message', onMsg)
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
  })
}

let ws
try {
  const wsUrl = await getWsUrl()
  ws = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject) })
  // 等待页面异步初始化（下拉填充等）
  await sleep(8000)

  const checks = {
    '时钟在走': `document.getElementById('topbarClock').textContent.includes('今天是 2026')`,
    '顶栏使用XP点阵字体': `getComputedStyle(document.getElementById('topbarClock')).fontFamily.toLowerCase().includes('simsun') || getComputedStyle(document.getElementById('topbarClock')).fontFamily.toLowerCase().includes('新宋体')`,
    '跑马灯使用XP点阵字体': `getComputedStyle(document.getElementById('mqNoticeTrack')).fontFamily.toLowerCase().includes('simsun') || getComputedStyle(document.getElementById('mqNoticeTrack')).fontFamily.toLowerCase().includes('新宋体')`,
    '平台标题': `document.getElementById('headerTitle').textContent.includes('Deepseek Harness')`,
    '徽标默认空白': `document.getElementById('headerSeal').classList.contains('none') && document.getElementById('headerSeal').innerHTML.trim() === ''`,
    '绿色状态点已移除': `document.getElementById('statusDot') === null && document.getElementById('statusText') === null`,
    '模式下拉已枚举': `document.getElementById('selPreset').options.length >= 2`,
    '模式含标准/创造': `[...document.getElementById('selPreset').options].map(o=>o.textContent).join('|').includes('标准模式') && [...document.getElementById('selPreset').options].map(o=>o.textContent).join('|').includes('创造模式')`,
    '权限下拉已枚举': `document.getElementById('selPermission').options.length >= 2`,
    '首页通知公告已渲染': `document.getElementById('homeNoticeList').children.length >= 5`,
    '首页办事指南已渲染': `document.getElementById('homeGuideList').children.length >= 5`,
    '首页运行数据网关': `document.getElementById('hdGateway').textContent.includes('已接入')`,
    '首页无emoji卡片': `document.querySelectorAll('.quick-card').length === 0`,
    '首页办事通道网格': `document.querySelectorAll('.channel-grid .ch').length >= 6`,
    '首页横幅存在': `document.getElementById('bannerTitle').textContent.includes('Deepseek Harness')`,
    '跑马灯通道隔离': `getComputedStyle(document.querySelector('.marquee-notice')).overflow === 'hidden' && getComputedStyle(document.querySelector('.mq-view')).overflow === 'hidden'`,
    '跑马灯独占整行(行情已移除)': `document.querySelector('.marquee-quote') === null && document.querySelector('.marquee-notice').getBoundingClientRect().width > document.querySelector('.marquee-bar').getBoundingClientRect().width * 0.9`,
    '跑马灯通知有内容': `document.getElementById('mqNoticeTrack').children.length > 0`,
    '跑马灯通知持续滚动': `document.getElementById('mqNoticeTrack').style.transform !== '' && document.getElementById('mqNoticeTrack').style.transform !== 'translateX(0px)'`,
    '回执欢迎区存在': `document.getElementById('welcomeBox').textContent.includes('综合业务直办大厅')`,
    '办理思路无英文标注': `!document.documentElement.innerHTML.includes('（Thinking）') && !document.documentElement.innerHTML.includes('(Thinking)')`,
    '统计行存在': `document.getElementById('statsBar').textContent.includes('缓存命中')`,
    '页脚文案生效': `document.getElementById('footerOrg').textContent.includes('主办单位')`,
    '漂浮弹窗A已创建': `document.querySelectorAll('.float-modal.notice').length === 1`,
    '漂浮弹窗B已创建': `document.querySelectorAll('.float-modal.qr').length === 1`,
    '弹窗在移动(DVD)': `document.querySelector('.float-modal.notice').style.left !== '' && document.querySelector('.float-modal.notice').style.left !== '-10000px'`,
  }

  let pass = 0
  const fails = []
  for (const [label, expr] of Object.entries(checks)) {
    let value
    try {
      value = await evaluate(ws, 1000 + Object.keys(checks).indexOf(label), expr)
    } catch (e) { value = 'ERR:' + e.message }
    const ok = value === true
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : '  → ' + JSON.stringify(value).slice(0, 120)}`)
    if (ok) pass++; else fails.push(label)
  }
  console.log(`\n${pass}/${Object.keys(checks).length} 通过`)
  process.exitCode = fails.length ? 1 : 0
} catch (e) {
  console.error('E2E 失败：', e.message)
  process.exitCode = 2
} finally {
  try { ws?.close() } catch { /* ignore */ }
  edge.kill()
}
