/**
 * test/server-smoke.mjs — 插件冒烟测试：
 * 用 mock ctx 加载 lib/index.js（不依赖 cordis 运行时），验证
 * 1) 静态资源服务（index.html / css / js）
 * 2) /plugin/status 与 /plugin/config
 * 3) API 桥的 envelope 分发、SSE 流、respond、session.export
 * 用法：node test/server-smoke.mjs
 */
import GovPortal from '../lib/index.js'
import http from 'node:http'

let failCount = 0
function assert (cond, label) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`)
  if (!cond) failCount++
}

/* —— mock apiProxy：记录调用、模拟流 —— */
const calls = []
const mockApi = {
  sessions: {
    list: async ({ rpcId, payload }) => ({ rpcId, result: { ok: true, value: { items: [{ sessionId: 'sess-1' }] } } }),
    create: async ({ rpcId, payload }) => ({ rpcId, result: { ok: true, value: { sessionId: 'sess-new', agentPreset: payload?.agentPreset } } }),
    prompt: async ({ rpcId, payload }) => ({ rpcId, result: { ok: true, value: { accepted: true } } }),
  },
  settings: {
    describe: async ({ rpcId }) => ({ rpcId, result: { ok: true, value: { writable: true, namespaces: [{ ns: 'permission', schema: { uid: 1, refs: { 1: { type: 'object', meta: {}, dict: { defaultPreset: 2 } }, 2: { type: 'union', meta: {}, list: [3, 4] }, 3: { type: 'const', meta: { description: '工作区可写' }, value: 'workspace-write' }, 4: { type: 'const', meta: { description: '全访问' }, value: 'danger-full-access' } } }, value: { defaultPreset: 'workspace-write' }, revision: 1, applies: 'live', secrets: [] }] } } }),
  },
  events: {
    mux: async function * ({ rpcId }) {
      yield { rpcId, payload: { type: 'session/event', sessionId: 'sess-1', event: { type: 'turn/start', seq: 1, time: Date.now(), data: { turn: 1 } } } }
      yield { rpcId, payload: { type: 'session/projection', sessionId: 'sess-1', key: 'sessionStats', value: { turns: 1, steps: 2, llmMs: 3000 } } }
    },
    host: async function * () { yield { rpcId, payload: { type: 'host/session-status', sessionId: 'x', running: false } } },
  },
  respond: async (msg) => ({ accepted: true }),
  downloads: {
    sessionLog: async ({ sessionId }) => new Response(JSON.stringify({ ok: 1, sessionId }) + '\n', { status: 200, headers: { 'content-type': 'application/jsonl' } }),
  },
}

const mockCtx = {
  get: name => (name === 'apiProxy' ? mockApi : undefined),
  on: (ev, fn) => { if (ev === 'dispose') mockCtx._dispose = fn },
}

GovPortal(mockCtx, { port: 3181, host: '127.0.0.1' })

const base = 'http://127.0.0.1:3181'
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function fetchText (path, opts) {
  const res = await fetch(base + path, opts)
  const text = await res.text()
  return { status: res.status, headers: res.headers, text }
}

await sleep(600)

/* 1. 静态资源 */
{
  const r = await fetchText('/')
  assert(r.status === 200 && r.text.includes('业务大厅'), 'index.html 200 且含主界面')
  const css = await fetchText('/css/gov.css')
  assert(css.status === 200 && css.text.includes('--gov-red'), 'gov.css 200 且含设计变量')
  const js = await fetchText('/js/app.js')
  assert(js.status === 200 && js.text.includes('GOVApp'), 'app.js 200 且含主应用')
  const nf = await fetchText('/not-exist-page')
  assert(nf.status === 200 && nf.text.includes('<html'), 'SPA 兜底返回 index.html')
}

/* 2. 插件端点 */
{
  const st = await fetchText('/plugin/status')
  const json = JSON.parse(st.text)
  assert(st.status === 200 && json.apiProxy === true && json.port === 3181, 'plugin/status 报告 apiProxy 与端口')
  const cfg = await fetchText('/plugin/config')
  assert(cfg.status === 200 && JSON.parse(cfg.text).port === 3181, 'plugin/config 读取')
}

/* 3. unary 桥 */
{
  const resp = await fetch(base + '/api/session.create', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'rpc-1', method: 'session.create', payload: { agentPreset: 'standard' } }),
  })
  const body = await resp.json()
  if (resp.status !== 200 || body.result?.ok !== true) console.log('DEBUG unary 响应：', resp.status, JSON.stringify(body))
  assert(resp.status === 200 && body.type === 'server-response' && body.rpcId === 'rpc-1' && body.result.ok === true && body.result.value.sessionId === 'sess-new' && body.result.value.agentPreset === 'standard', 'unary 桥：session.create 分发 + 信封回显')
}

/* 4. 业务错误不落 5xx（宿主 RpcResult 透传） */
{
  const resp = await fetch(base + '/api/whatever.unknown', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rpcId: 'x', method: 'whatever.unknown', payload: {} }) })
  const body = await resp.json()
  assert(resp.status === 404, '未知方法返回 404')
}

/* 5. SSE 流（events.mux） */
{
  const resp = await fetch(base + '/api/events.mux')
  assert(resp.status === 200 && (resp.headers.get('content-type') ?? '').includes('text/event-stream'), 'events.mux 是 SSE')
  const reader = resp.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  while (buf.indexOf('\n\n') === -1) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
  }
  const firstChunk = buf.split('\n\n')[0]
  const frame = JSON.parse(firstChunk.split('\n').filter(l => l.startsWith('data: ')).map(l => l.slice(6)).join(''))
  assert(frame.type === 'server-request' && frame.payload?.type === 'session/event', 'SSE 帧结构正确（server-request + MuxFrame）')
  await reader.cancel()
}

/* 6. respond 桥 */
{
  const resp = await fetch(base + '/api/respond', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-response', rpcId: 'rpc-9', result: { ok: true, value: {} } }),
  })
  const body = await resp.json()
  assert(resp.status === 200 && body.accepted === true, 'respond 桥正常')
}

/* 7. session.export 桥 */
{
  const resp = await fetch(base + '/api/session.export?sessionId=sess-1')
  const text = await resp.text()
  assert(resp.status === 200 && text.includes('sess-1'), 'session.export 桥正常')
}

console.log(failCount === 0 ? '\n全部通过 ✔' : `\n${failCount} 项失败 ✘`)
process.exit(failCount === 0 ? 0 : 1)
