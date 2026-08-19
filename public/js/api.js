/* ====================================================================
 * api.js — DeepSeek Harness wire 协议客户端（与宿主 apiProxy 1:1 对接）
 *
 * 协议（@deepseek-ai/dsh-host-apiproxy fetch carrier，页面零硬编码）：
 *  - unary：POST /api/<domain>.<method>
 *      body   {type:"client-request", rpcId, method, payload}
 *      resp   {type:"server-response", rpcId, result:{ok:true,value}|{ok:false,error:{code,message}}}
 *  - 流：GET /api/events.mux、GET /api/events.host → text/event-stream
 *      帧 = "\n\n" 分隔，行 "data: <json>"，
 *      json = {type:"server-request", rpcId, method:"events.mux", payload: MuxFrame}
 *  - 应答：POST /api/respond  body {type:"client-response", rpcId, result}
 *  - 导出：GET /api/session.export?sessionId=
 * ==================================================================== */
(function (global) {
  'use strict'

  const BASE = '' // 同源（由 3081 插件桥接宿主 apiProxy）

  function uuid () {
    if (global.crypto?.randomUUID) return global.crypto.randomUUID()
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16)
    })
  }

  /** unary 调用：返回 {ok:true, value} | {ok:false, error}（业务错误不抛异常） */
  async function unary (method, payload = {}, signal) {
    const body = { type: 'client-request', rpcId: uuid(), method, payload }
    let resp
    try {
      resp = await fetch(`${BASE}/api/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      })
      if (!resp.ok) return { ok: false, error: { code: 'transport', message: `HTTP ${resp.status}` } }
      const full = await resp.json()
      if (full?.type !== 'server-response') return { ok: false, error: { code: 'transport', message: '响应信封格式错误' } }
      if (full.rpcId !== body.rpcId) return { ok: false, error: { code: 'transport', message: 'rpcId 不匹配' } }
      return full.result
    } catch (error) {
      return { ok: false, error: { code: 'transport', message: String(error?.message ?? error) } }
    }
  }

  /** 通用流：GET /api/<stream>，逐帧回调 onFrame({rpcId, payload}) */
  async function openStream (streamName, onFrame, opts = {}) {
    const { signal, onOpen, onError, onClose } = opts
    const controller = new AbortController()
    const outer = signal
    const onAbort = () => controller.abort()
    outer?.addEventListener?.('abort', onAbort)
    try {
      const resp = await fetch(`${BASE}/api/${streamName}`, { signal: controller.signal })
      if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status}`)
      onOpen?.()
      const reader = resp.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let boundary
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
          const chunk = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const data = chunk.split('\n').filter(l => l.startsWith('data: ')).map(l => l.slice(6)).join('')
          if (!data) continue
          try {
            const full = JSON.parse(data)
            if (full?.type === 'server-request') onFrame({ rpcId: full.rpcId, method: full.method, payload: full.payload })
          } catch (error) {
            console.warn('[gov-portal] 跳过坏帧：', error.message)
          }
        }
      }
    } catch (error) {
      if (outer?.aborted || controller.signal.aborted) return
      onError?.(error)
    } finally {
      outer?.removeEventListener?.('abort', onAbort)
      onClose?.()
    }
  }

  /** 应答 server-request（审批/问题） */
  async function respond (rpcId, value) {
    try {
      const resp = await fetch(`${BASE}/api/respond`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-response', rpcId, result: { ok: true, value } }),
      })
      return await resp.json()
    } catch (error) {
      console.warn('[gov-portal] respond 失败：', error)
      return { accepted: false, reason: 'bad-response' }
    }
  }

  /** 导出会话日志卷宗 */
  function exportSessionLog (sessionId) {
    const a = document.createElement('a')
    a.href = `${BASE}/api/session.export?sessionId=${encodeURIComponent(sessionId)}`
    a.download = `session-${sessionId}.jsonl`
    document.body.appendChild(a)
    a.click()
    a.remove()
  }

  /* ---------- 便捷业务方法（包一层 unary） ---------- */
  const api = {
    unary, openStream, respond, exportSessionLog,
    sessions: {
      list: p => unary('session.list', p),
      create: p => unary('session.create', p),
      history: p => unary('session.history', p),
      models: p => unary('session.models', p),
      selectModel: p => unary('session.selectModel', p),
      prompt: p => unary('session.prompt', p),
      cancel: p => unary('session.cancel', p),
      rename: p => unary('session.rename', p),
      fork: p => unary('session.fork', p),
      updateQueue: p => unary('session.updateQueue', p),
      search: p => unary('session.search', p),
    },
    host: {
      describe: p => unary('host.describe', p),
      pickDirectory: p => unary('host.pickDirectory', p),
      listDirectory: p => unary('host.listDirectory', p),
      createDirectory: p => unary('host.createDirectory', p),
    },
    workspace: {
      list: p => unary('workspace.list', p),
      create: p => unary('workspace.create', p),
      rename: p => unary('workspace.rename', p),
      delete: p => unary('workspace.delete', p),
      archiveSession: p => unary('workspace.archiveSession', p),
    },
    agentPresets: {
      list: p => unary('agentPreset.list', p),
      select: p => unary('agentPreset.select', p),
      read: p => unary('agentPreset.read', p),
    },
    skills: { list: p => unary('skill.list', p) },
    goals: {
      create: p => unary('goal.create', p),
      pause: p => unary('goal.pause', p),
      resume: p => unary('goal.resume', p),
      complete: p => unary('goal.complete', p),
      clear: p => unary('goal.clear', p),
    },
    settings: {
      describe: p => unary('settings.describe', p),
      update: p => unary('settings.update', p),
      replace: p => unary('settings.replace', p),
      mutate: p => unary('settings.mutate', p),
      openDocument: p => unary('settings.openDocument', p),
    },
    llm: {
      providers: p => unary('llm.providers', p),
      models: p => unary('llm.models', p),
    },
    subagents: { list: p => unary('subagent.list', p) },
  }

  global.DSHApi = api
})(window)
