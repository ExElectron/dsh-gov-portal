/**
 * dsh-gov-portal — Deepseek Harness 综合智能办事平台
 *
 * 一个零依赖的 Cordis 宿主插件：在独立端口（默认 3081）拉起政务风 WebUI，
 * 并把浏览器请求 1:1 桥接到宿主进程内的 `ctx.apiProxy`（dsh-host-apiproxy
 * 的 ApiProxy 实现），从而完整复用 dsh 的会话、模型、权限、模式、统计等
 * 全部 Agent 能力 —— 页面侧不做任何业务硬编码，只实现 wire 协议。
 *
 * wire 协议（与 @deepseek-ai/dsh-host-apiproxy 的 fetch carrier 完全一致）：
 *  - unary：POST /api/<domain>.<method>，body 为 ClientRequest 信封
 *      {type:"client-request", rpcId, method, payload}
 *      响应为 ServerResponse {type:"server-response", rpcId, result:{ok,value}|{ok:false,error}}
 *  - 流：GET /api/events.mux、GET /api/events.host → text/event-stream，
 *      帧以 "\n\n" 分隔，行为 "data: <json>"，json 为
 *      {type:"server-request", rpcId, method, payload}
 *  - 应答：POST /api/respond，body 为 ClientResponse
 *      {type:"client-response", rpcId, result}
 *  - 导出：GET /api/session.export?sessionId=<id>
 */
import http from 'node:http'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

export const name = 'gov-portal'
// inject 依赖由 cordis.patch.yml 的插件行声明（inject: [apiProxy]），
// 这里保持空数组避免覆盖行配置。

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = path.join(__dirname, '..', 'public')

const CONFIG_PATH = path.join(os.homedir(), '.dsh', 'gov-portal.json')

const DEFAULT_CONFIG = {
  /** 本插件监听端口 */
  port: 3081,
  /** 监听地址；改为 0.0.0.0 将允许局域网访问（存在安全风险，请自行评估） */
  host: '127.0.0.1',
  /** apiProxy 缺失时回退转发到主 GUI 的地址（一般无需改动） */
  fallbackBase: 'http://127.0.0.1:3080',
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

const log = (...args) => console.log('[gov-portal]', ...args)

function json(res, status, value, extra = {}) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extra,
  })
  res.end(body)
}

function uuid() {
  return globalThis.crypto?.randomUUID?.() ??
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16)
    })
}

async function readJsonBody(req, limit = 32 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('payload too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  try { return JSON.parse(text) } catch { throw new Error('body is not JSON') }
}

/* ------------------------------------------------------------------ */
/* 插件配置（~/.dsh/gov-portal.json），与前端 localStorage 配置互补    */
/* ------------------------------------------------------------------ */

async function loadConfig() {
  try {
    if (!existsSync(CONFIG_PATH)) return {}
    const raw = JSON.parse(await readFile(CONFIG_PATH, 'utf8'))
    return raw && typeof raw === 'object' ? raw : {}
  } catch (error) {
    log('读取插件配置失败，使用默认值：', error.message)
    return {}
  }
}

async function saveConfig(cfg) {
  await mkdir(path.dirname(CONFIG_PATH), { recursive: true })
  await writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8')
}

/* ------------------------------------------------------------------ */
/* API 桥：把 /api/* 请求分发给 ctx.apiProxy                          */
/* ------------------------------------------------------------------ */

const UNARY_PATTERN = /^\/api\/([a-z][a-zA-Z0-9]*)\.([a-zA-Z][a-zA-Z0-9]*)$/

/** wire 路径域段（单数，如 session.*）→ apiProxy 属性名（复数，如 sessions） */
const DOMAIN_ALIASES = {
  session: 'sessions',
  subagent: 'subagents',
  skill: 'skills',
  agentPreset: 'agentPresets',
  goal: 'goals',
}

/**
 * 把一个 ServerRequest 帧（apiProxy 流方法产出的 {rpcId, payload}）
 * 编码成 SSE 帧字符串。
 */
function encodeSseFrame(method, rpcId, payload) {
  return `data: ${JSON.stringify({ type: 'server-request', rpcId, method, payload })}\n\n`
}

/**
 * 把 apiProxy 的流方法（AsyncIterable）转发为 SSE 响应。
 */
async function pipeSse(iterable, method, res, signal) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25000)
  let aborted = false
  const onAbort = () => { aborted = true }
  signal?.addEventListener?.('abort', onAbort)
  try {
    for await (const frame of iterable) {
      if (aborted || res.writableEnded) break
      res.write(encodeSseFrame(method, frame.rpcId, frame.payload))
    }
  } catch (error) {
    if (!aborted && !res.writableEnded) {
      res.write(encodeSseFrame(method, uuid(), {
        type: 'stream/error',
        error: { code: 'internal', message: String(error?.message ?? error) },
      }))
    }
  } finally {
    clearInterval(heartbeat)
    signal?.removeEventListener?.('abort', onAbort)
    if (!res.writableEnded) res.end()
  }
}

/**
 * 主 API 桥处理器。
 * 优先走宿主进程内 ctx.apiProxy（零网络、零 CORS、1:1 能力）；
 * 若该服务不存在，则把请求原样回退转发到主 GUI（fallbackBase）。
 */
async function handleApi(ctx, req, res, url, config) {
  const api = ctx.apiProxy ?? ctx.get?.('apiProxy', false) ?? ctx.get?.('apiProxy')
  if (!api) {
    if (!config.fallbackBase) return json(res, 502, { error: '宿主 apiProxy 服务不可用' })
    return forwardToFallback(req, res, config.fallbackBase)
  }

  const pathname = url.pathname

  // —— 流：GET /api/events.mux | /api/events.host ——
  if ((pathname === '/api/events.mux' || pathname === '/api/events.host') && req.method === 'GET') {
    const method = pathname.slice(5)
    try {
      const stream = api.events[method === 'events.mux' ? 'mux' : 'host'](
        { rpcId: uuid(), payload: {} },
        req.signal,
      )
      return await pipeSse(stream, method, res, req.signal)
    } catch (error) {
      return json(res, 500, { error: String(error?.message ?? error) })
    }
  }

  // —— 导出：GET|HEAD /api/session.export?sessionId=... ——
  if (pathname === '/api/session.export' && (req.method === 'GET' || req.method === 'HEAD')) {
    try {
      const sessionId = url.searchParams.get('sessionId')
      if (!sessionId) return json(res, 400, { error: 'missing sessionId query parameter' })
      const response = await api.downloads.sessionLog({ sessionId }, req.signal)
      if (req.method === 'HEAD') {
        res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
        return res.end()
      }
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
      if (response.body) {
        for await (const chunk of response.body) res.write(chunk)
      }
      return res.end()
    } catch (error) {
      return json(res, 500, { error: String(error?.message ?? error) })
    }
  }

  if (req.method !== 'POST') return json(res, 404, { error: 'not found' })

  let body
  try {
    body = await readJsonBody(req)
  } catch (error) {
    return json(res, 400, { error: error.message })
  }

  // —— 应答：POST /api/respond ——
  if (pathname === '/api/respond') {
    try {
      const receipt = await api.respond(body)
      return json(res, 200, receipt)
    } catch (error) {
      return json(res, 200, { accepted: false, reason: 'bad-response' })
    }
  }

  // —— 通用 unary：POST /api/<domain>.<method> ——
  const match = UNARY_PATTERN.exec(pathname)
  if (!match) return json(res, 404, { error: `unknown api path ${pathname}` })
  const [, domainRaw, sub] = match
  const domain = DOMAIN_ALIASES[domainRaw] ?? domainRaw
  const handler = api[domain]?.[sub]
  if (typeof handler !== 'function') {
    return json(res, 404, { error: `unknown method ${domainRaw}.${sub}` })
  }
  const rpcId = typeof body?.rpcId === 'string' && body.rpcId ? body.rpcId : uuid()
  const method = `${domain}.${sub}`
  try {
    const outcome = await handler(
      { rpcId, payload: body?.payload ?? {} },
      req.signal,
    )
    return json(res, 200, {
      type: 'server-response',
      rpcId: outcome.rpcId ?? rpcId,
      result: outcome.result ?? { ok: true, value: outcome },
    })
  } catch (error) {
    return json(res, 500, {
      type: 'server-response',
      rpcId,
      result: {
        ok: false,
        error: { code: 'internal', message: String(error?.message ?? error) },
      },
    })
  }
}

/**
 * 回退：把请求原样转发到主 GUI（fallbackBase）。
 * 重写 Host 头以通过主 GUI 的 DNS-rebinding 信任检查。
 */
function forwardToFallback(req, res, base) {
  const target = new URL(req.url, base)
  const headers = { ...req.headers, host: new URL(base).host }
  delete headers['content-length']
  const upstream = http.request(
    {
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: target.pathname + target.search,
      method: req.method,
      headers,
    },
    upstreamRes => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
      upstreamRes.pipe(res)
    },
  )
  upstream.on('error', error => {
    if (!res.headersSent) json(res, 502, { error: `fallback upstream error: ${error.message}` })
    else res.end()
  })
  req.pipe(upstream)
}

/* ------------------------------------------------------------------ */
/* 插件本地端点                                                       */
/* ------------------------------------------------------------------ */

function allowedOrigin(req) {
  const origin = req.headers.origin
  if (!origin) return undefined
  try {
    const host = new URL(origin).hostname
    if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') return origin
  } catch { /* ignore */ }
  return undefined
}

async function handlePluginEndpoint(ctx, req, res, url, state) {
  const origin = allowedOrigin(req)
  const cors = origin ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {}
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-methods': 'GET,POST,PUT,OPTIONS',
      'access-control-allow-headers': 'content-type',
      ...cors,
    })
    return res.end()
  }
  const pathname = url.pathname

  if (pathname === '/plugin/config') {
    if (req.method === 'GET') return json(res, 200, state.config, cors)
    if (req.method === 'PUT') {
      try {
        const body = await readJsonBody(req, 1024 * 1024)
        const port = Number(body.port)
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          return json(res, 400, { error: 'port 必须是 1-65535 的整数' })
        }
        const next = { ...state.config, ...body, port }
        state.config = next
        await saveConfig(next)
        return json(res, 200, {
          saved: true,
          config: next,
          note: '端口等监听参数修改后需重启 dsh（插件）才能生效',
        }, cors)
      } catch (error) {
        return json(res, 400, { error: error.message }, cors)
      }
    }
    return json(res, 405, { error: 'method not allowed' }, cors)
  }

  if (pathname === '/plugin/status') {
    const api = ctx.apiProxy ?? ctx.get?.('apiProxy', false) ?? ctx.get?.('apiProxy')
    const status = {
      plugin: name,
      version: '0.1.0',
      apiProxy: Boolean(api),
      fallbackBase: state.config.fallbackBase,
      port: state.config.port,
      node: process.version,
      pid: process.pid,
      uptimeSeconds: Math.round(process.uptime()),
    }
    return json(res, 200, status, cors)
  }

  // 访问次数统计：每次页面加载读取时 +1，持久化到插件配置文件
  if (pathname === '/plugin/visits') {
    const visits = Number(state.config.visits) || 0
    if (req.method === 'GET') {
      state.config.visits = visits + 1
      void saveConfig(state.config).catch(err => log('访问计数落盘失败：', err.message))
      return json(res, 200, { visits: state.config.visits }, cors)
    }
    if (req.method === 'PUT') {
      // 管理员重置（一般无需使用）
      state.config.visits = 0
      void saveConfig(state.config).catch(() => {})
      return json(res, 200, { visits: 0 }, cors)
    }
    return json(res, 405, { error: 'method not allowed' }, cors)
  }

  return json(res, 404, { error: 'not found' }, cors)
}

/* ------------------------------------------------------------------ */
/* 静态资源（每次从磁盘读取 → 天然支持热重载）                        */
/* ------------------------------------------------------------------ */

async function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname)
  if (rel === '/') rel = '/index.html'
  const target = path.normalize(path.join(PUBLIC_DIR, rel))
  if (!target.startsWith(PUBLIC_DIR + path.sep) && target !== PUBLIC_DIR) {
    return json(res, 403, { error: 'forbidden' })
  }
  try {
    const data = await readFile(target)
    res.writeHead(200, {
      'content-type': MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    })
    res.end(data)
  } catch {
    // 未命中交给 index.html（本页面为单页，路径导航兜底）
    try {
      const data = await readFile(path.join(PUBLIC_DIR, 'index.html'))
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-cache',
      })
      res.end(data)
    } catch {
      json(res, 404, { error: 'not found' })
    }
  }
}

/* ------------------------------------------------------------------ */
/* 插件主体                                                            */
/* ------------------------------------------------------------------ */

export default function GovPortal(ctx, config = {}) {
  const state = { config: null }

  ctx.on('dispose', () => {
    try { state.server?.close() } catch { /* ignore */ }
  })

  // 启动即异步完成配置加载与监听；失败只记录日志，不拖垮整个 dsh。
  void (async () => {
    const fileConfig = await loadConfig()
    const merged = { ...DEFAULT_CONFIG, ...fileConfig, ...config }
    state.config = merged

    const server = http.createServer((req, res) => {
      void (async () => {
        try {
          const url = new URL(req.url, `http://${req.headers.host || `${merged.host}:${merged.port}`}`)
          if (url.pathname.startsWith('/api/')) {
            return await handleApi(ctx, req, res, url, merged)
          }
          if (url.pathname.startsWith('/plugin/')) {
            return await handlePluginEndpoint(ctx, req, res, url, state)
          }
          return await serveStatic(req, res, url)
        } catch (error) {
          if (!res.headersSent) json(res, 500, { error: String(error?.message ?? error) })
          else { try { res.end() } catch { /* ignore */ } }
        }
      })()
    })

    server.on('error', error => {
      log('监听失败：', error.message)
    })

    server.listen(merged.port, merged.host, () => {
      state.server = server
      log(`政务平台已上线：http://${merged.host === '0.0.0.0' ? '127.0.0.1' : merged.host}:${merged.port}/`)
      const api = ctx.apiProxy ?? ctx.get?.('apiProxy', false) ?? ctx.get?.('apiProxy')
      log('apiProxy 桥：', api ? '已接入宿主 API 网关（1:1 能力）' : '未检测到，回退转发主 GUI')
    })
  })()
}
