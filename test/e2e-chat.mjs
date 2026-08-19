/**
 * test/e2e-chat.mjs — 端到端对话测试（走 3081 桥 → 真实宿主 apiProxy → 真实 Agent Loop）。
 * 创建会话 → 提交极简 prompt → 监听 events.mux 断言完整事件链。
 * 用法：node test/e2e-chat.mjs [base]
 */
const BASE = process.argv[2] ?? 'http://127.0.0.1:3081'
const uuid = () => crypto.randomUUID()

async function unary (method, payload) {
  const rpcId = uuid()
  const resp = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
  })
  const body = await resp.json()
  if (body.rpcId !== rpcId) throw new Error('rpcId mismatch')
  return body.result
}

const seen = { types: new Set(), chunks: 0, stats: null, text: '' }

console.log('1) 创建会话…')
const created = await unary('session.create', { agentPreset: 'standard' })
if (!created.ok) { console.error('创建失败：', created.error); process.exit(1) }
const sessionId = created.value.sessionId
console.log('   会话：', sessionId, 'agentPreset：', created.value.agentPreset)

console.log('2) 打开事件流…')
const streamPromise = (async () => {
  const resp = await fetch(`${BASE}/api/events.mux`)
  const reader = resp.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let b
    while ((b = buf.indexOf('\n\n')) !== -1) {
      const chunk = buf.slice(0, b)
      buf = buf.slice(b + 2)
      const data = chunk.split('\n').filter(l => l.startsWith('data: ')).map(l => l.slice(6)).join('')
      if (!data) continue
      const frame = JSON.parse(data)
      const p = frame.payload ?? {}
      if (p.type === 'session/event' && p.sessionId === sessionId) {
        const ev = p.event
        seen.types.add(ev.type)
        if (ev.type === 'assistant/chunk' && ev.data?.chunk?.type === 'text-delta') { seen.chunks++; seen.text += ev.data.chunk.text }
        if (ev.type === 'turn/end') { seen.turnEnd = ev.data?.reason }
      }
      if (p.type === 'session/projection' && p.sessionId === sessionId && p.key === 'sessionStats') {
        seen.stats = p.value
      }
    }
    if (seen.turnEnd !== undefined) break
  }
  await reader.cancel()
})()

console.log('3) 提交办理…')
const promptRes = await unary('session.prompt', {
  sessionId,
  mode: 'queue',
  content: [{ type: 'text', text: '请只回复两个字：收到。不要调用任何工具。' }],
})
console.log('   受理：', JSON.stringify(promptRes))

await Promise.race([streamPromise, new Promise((_, rej) => setTimeout(() => rej(new Error('等待事件流超时(120s)')), 120000))])

const okTypes = ['turn/start', 'user/message', 'assistant/chunk', 'assistant/message', 'turn/end']
let pass = 0
for (const t of okTypes) {
  const ok = seen.types.has(t)
  console.log(`${ok ? 'PASS' : 'FAIL'}  事件 ${t}`)
  if (ok) pass++
}
const turnOk = seen.turnEnd && (typeof seen.turnEnd === 'string' ? seen.turnEnd === 'completed' : seen.turnEnd?.kind === 'completed')
console.log(`${turnOk ? 'PASS' : 'FAIL'}  办结原因 success（实际：${JSON.stringify(seen.turnEnd)}）`)
if (turnOk) pass++
const statsOk = seen.stats && seen.stats.turns >= 1 && seen.stats.steps >= 1
console.log(`${statsOk ? 'PASS' : 'FAIL'}  sessionStats 投影（${JSON.stringify(seen.stats)}）`)
if (statsOk) pass++
console.log(`\n回执文本：${JSON.stringify(seen.text.slice(0, 100))}`)
console.log(`${pass}/${okTypes.length + 2} 项通过`)
process.exit(pass === okTypes.length + 2 ? 0 : 1)
