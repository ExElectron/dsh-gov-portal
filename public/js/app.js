/* ====================================================================
 * app.js — 平台主应用：会话 / 事件流渲染 / 统计 / 提交 / 审批 / 卷宗 /
 * 督办流水 / 配置联动。所有 Agent 能力经 DSHApi 1:1 调用宿主 apiProxy。
 * ==================================================================== */
(function (global) {
  'use strict'

  const $ = id => document.getElementById(id)

  /* ================= 应用状态 ================= */
  const S = {
    sessionId: null,
    agentPreset: null,          // 当前会话的 Agent 模式
    modelCatalog: null,         // session.models 返回值
    modelSel: { provider: '', model: '', reasoningEffort: '' },
    presets: [],                // agentPreset.list 结果
    permissionPresets: [],      // [{value,name,description}]
    permissionState: null,      // 会话当前 {preset,sandbox,approval}
    workDir: '',                // 当前选中的工作目录（新建会话时作为 cwd）
    workspaces: [],             // workspace.list 结果
    hostInfo: null,             // host.describe 结果
    stats: emptyStats(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    running: false,
    blank: true,
    turnStart: null,            // 当前轮开始时间戳
    stepViews: new Map(),       // `${turn}.${step}` → {reasoning, text, toolBlocks, el}
    pendingTools: new Map(),    // callId → {el, name}
    title: '',
    lastSeq: -1,
    sessions: [],
    muxTimer: null,
    stopMux: false,
    approvalQueue: [],
    dialogOpen: false,
    loadingOlder: false,
    historyHasMore: false,
    busyMsg: null,
  }

  function emptyStats () {
    return { turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 }
  }

  /* ================= 初始化 ================= */
  function init () {
    GOV.startClock($('topbarClock'))
    applyVisual()
    bindStaticUi()
    GOVMarquee.start()
    GOVFloat.start()
    GOVPanels.buildPolicyPage()
    activateTab('home')
    renderHome() // 首页静态列表先渲染，运行数据随后异步填充
    void (async () => {
      await refreshStatus()
      await Promise.all([loadWorkDir(), loadPresets(), loadPermissionPresets(), loadVolumes(), loadModels()])
      startMux()
    })()
    // 访问次数统计（服务端持久化计数，6 位补零显示）
    void fetch('/plugin/visits')
      .then(r => r.json())
      .then(data => {
        const el = $('visitCount')
        if (el && typeof data.visits === 'number') {
          el.textContent = String(data.visits).padStart(6, '0')
        }
      })
      .catch(() => {})
  }

  /* ================= 视觉应用（主题/文案/徽标/页脚/大字号） ================= */
  function applyVisual () {
    const cfg = GOVConfig.load()
    const root = document.documentElement
    document.body.dataset.theme = cfg.theme === 'custom' ? '' : cfg.theme
    if (cfg.theme === 'custom') {
      const c = cfg.customColors
      const style = document.getElementById('customThemeStyle') || (() => {
        const s = document.createElement('style')
        s.id = 'customThemeStyle'
        document.head.appendChild(s)
        return s
      })()
      style.textContent = `:root {
        --gov-blue: ${c.primary}; --gov-blue-deep: ${c.deep};
        --gov-blue-navy: ${c.navEnd}; --gov-border-strong: ${c.borderStrong};
        --gov-red: ${c.red}; --gov-red-deep: ${c.red};
        --gov-nav-grad: linear-gradient(180deg, ${c.primary} 0%, ${c.navEnd} 100%);
        --gov-btn-primary: linear-gradient(180deg, ${c.primary} 0%, ${c.deep} 100%);
        --gov-btn-primary-hover: linear-gradient(180deg, ${c.primary} 0%, ${c.navEnd} 100%);
      }`
    } else {
      document.getElementById('customThemeStyle')?.remove()
    }
    document.body.classList.toggle('big-font', Boolean(cfg.misc.bigFont))

    const t = cfg.texts
    $('topbarSlogan').textContent = t.slogan
    $('headerTitle').textContent = t.title
    $('headerSubtitle').textContent = t.subtitle
    document.title = t.title
    $('footerOrg').textContent = t.footerOrg
    $('footerTech').textContent = t.footerTech
    $('footerBeian').textContent = t.footerBeian
    $('asideTech').textContent = t.serviceTech
    $('stampEl').textContent = t.stampText

    // 标题左侧图标/公章：默认空白（none），由用户在【参数配置】中选择
    const seal = $('headerSeal')
    seal.classList.toggle('none', cfg.seal.style === 'none')
    if (cfg.seal.style === 'none') {
      seal.innerHTML = ''
    } else if (cfg.seal.style === 'custom' && cfg.seal.customUrl) {
      seal.innerHTML = `<img src="${GOV.escape(cfg.seal.customUrl)}" style="width:84px;height:84px;object-fit:contain" alt="徽标">`
    } else {
      seal.innerHTML = GOV.renderSeal(cfg.seal.style, 84, t.title.split(' ')[0] + '\nHarness')
    }
  }

  /* ================= 静态 UI 绑定 ================= */
  function bindStaticUi () {
    // 政务网站式短暂白屏过渡：所有可点击命令统一触发，遮罩不拦截原操作。
    document.addEventListener('click', event => {
      if (event.target.closest('button, a, [data-goto], [data-act], .ch, .hp')) showPageLoading()
    }, true)

    // 设为首页 / 加入收藏
    $('btnSetHome').addEventListener('click', () => {
      if (!GOV.setHome(location.href)) alert('您的浏览器不支持自动设为首页，请手动在浏览器设置中操作。')
    })
    $('btnFavorite').addEventListener('click', () => {
      if (!GOV.addFavorite(location.href, document.title)) alert('请按 Ctrl+D 将本平台加入收藏夹。')
    })
    // 无障碍大字号
    $('btnAria').addEventListener('click', () => {
      const next = !GOVConfig.get('misc.bigFont')
      GOVConfig.set('misc.bigFont', next)
      applyVisual()
    })
    // 全局搜索
    const doSearch = () => {
      const q = $('globalSearchInput').value.trim()
      switchTab('volume')
      if (q) { $('volumeSearch').value = q; searchVolumes(q) }
    }
    $('globalSearchBtn').addEventListener('click', doSearch)
    $('globalSearchInput').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch() })

    // 导航 tab
    document.querySelectorAll('#mainNav a').forEach(a => {
      a.addEventListener('click', () => switchTab(a.dataset.tab))
    })

    // 首页办事通道（.ch 与政策速览 .hp）
    const handleHomeAction = el => {
      const act = el.dataset.act
      if (el.dataset.goto) switchTab(el.dataset.goto)
      else if (act === 'new-session') void createNewSession()
      else if (act === 'export-log') exportCurrentLog()
      else if (act === 'feedback') showFeedback()
      else if (act === 'main-gui') window.open('http://127.0.0.1:3080/', '_blank')
    }
    document.querySelectorAll('.channel-grid .ch, .home-policy-row .hp').forEach(el => {
      el.addEventListener('click', () => handleHomeAction(el))
    })
    $('bannerMore')?.addEventListener('click', () => switchTab('hall'))
    $('homeHeadlineMore')?.addEventListener('click', () => switchTab('policy'))
    $('noticeBackHome')?.addEventListener('click', () => switchTab('home'))
    $('noticeBackButton')?.addEventListener('click', () => switchTab('home'))

    // 侧栏
    document.querySelectorAll('.aside-links a[data-act]').forEach(a => {
      a.addEventListener('click', () => {
        const act = a.dataset.act
        if (act === 'volume') switchTab('volume')
        else if (act === 'new-session') void createNewSession()
        else if (act === 'export-log') exportCurrentLog()
        else if (act === 'feedback') showFeedback()
        else if (act === 'config') switchTab('config')
        else if (act === 'main-gui') window.open('http://127.0.0.1:3080/', '_blank')
      })
    })

    // 业务大厅
    $('btnSubmit').addEventListener('click', () => void submitPrompt())
    $('btnReset').addEventListener('click', resetForm)
    const ta = $('promptInput')
    ta.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submitPrompt() }
    })
    bindParamSelects()

    // 卷宗
    $('btnVolumeRefresh').addEventListener('click', () => void loadVolumes())
    $('btnVolumeNew').addEventListener('click', () => void createNewSessionWithWorkspaceDialog())
    $('btnVolumeExport').addEventListener('click', exportCurrentLog)
    $('btnVolumeSearch').addEventListener('click', () => searchVolumes($('volumeSearch').value.trim()))
    $('volumeSearch').addEventListener('keydown', e => { if (e.key === 'Enter') searchVolumes($('volumeSearch').value.trim()) })

    // 流水
    $('btnTrailClear').addEventListener('click', clearTrail)
  }

  function showPageLoading (duration = 260) {
    if (GOVConfig.get('misc.pageLoadingEnabled') === false) return
    const layer = $('pageLoading')
    if (!layer) return
    clearTimeout(showPageLoading.timer)
    layer.classList.add('show')
    layer.setAttribute('aria-hidden', 'false')
    showPageLoading.timer = setTimeout(() => {
      layer.classList.remove('show')
      layer.setAttribute('aria-hidden', 'true')
    }, duration)
  }

  function activateTab (name, opts = {}) {
    document.querySelectorAll('.tab-page').forEach(page => { page.style.display = 'none' })
    document.querySelectorAll('#mainNav a').forEach(link => link.classList.toggle('active', link.dataset.tab === name))
    const page = $(`page-${name}`)
    if (page) page.style.display = 'block'
    if (name === 'config') buildConfigPanelWithActions()
    if (name === 'volume') void loadVolumes()
    if (name === 'home') void updateHome()
    return page
  }

  function switchTab (name) {
    showPageLoading()
    setTimeout(() => activateTab(name), 90)
  }

  /* ================= 状态与枚举加载 ================= */
  async function refreshStatus () {
    try {
      const resp = await fetch('/plugin/status')
      const st = await resp.json()
      S.hostStatus = st
      const el = $('hdGateway')
      if (el) el.textContent = st.apiProxy ? '已接入' : '桥接降级'
    } catch (e) {
      const el = $('hdGateway')
      if (el) el.textContent = '检测失败'
    }
  }

  function showFeedback () {
    showDialog('故障申诉直通车', `<div style="line-height:2">如遇平台运行故障，请通过以下渠道反馈：<br>1. 打开主控台（3080）查看宿主运行日志；<br>2. 在【电子卷宗】导出当前会话 JSONL 日志作为附件；<br>3. 描述故障现象、复现步骤与工单编号后提交。</div>`, [['关闭', 'gray', null]])
  }

  async function loadPresets () {
    const res = await DSHApi.agentPresets.list({})
    const sel = $('selPreset')
    sel.innerHTML = ''
    if (!res.ok) {
      sel.innerHTML = '<option value="">（无 Agent 模式）</option>'
      return
    }
    S.presets = res.value.presets ?? []
    for (const p of S.presets) {
      const opt = document.createElement('option')
      opt.value = p.id
      opt.textContent = `${p.name ?? p.id}${p.isDefault ? '（默认）' : ''}${p.trust === 'user' ? ' [用户]' : ''}`
      if (p.broken) opt.textContent += '（不可用）'
      opt.disabled = Boolean(p.broken)
      sel.appendChild(opt)
    }
    const def = S.presets.find(p => p.isDefault)
    sel.value = def?.id ?? ''
    renderHome()
  }

  /** 权限预设：从 settings.describe 的 permission 命名空间 schema 动态枚举 */
  const PERMISSION_LABELS = {
    // 展示别名（UI 说明文本）；提交到宿主 /permission 命令的始终是真实枚举值
    'read-only': 'read-only（只读，禁止文件修改）',
    'workspace-write': 'workspace-write（工作区可写，越权重试需审批）',
    'danger-full-access': 'danger-full-access（全访问免审批）',
  }

  async function loadPermissionPresets () {
    const res = await DSHApi.settings.describe({})
    S.permissionPresets = []
    if (res.ok) {
      const ns = (res.value.namespaces ?? []).find(n => n.ns === 'permission')
      if (typeof ns?.value?.defaultPreset === 'string') S.hostPermissionDefault = ns.value.defaultPreset
      const schema = ns?.schema
      const refs = schema?.refs ?? {}
      const root = refs[schema?.uid]
      // permission ns schema: {defaultPreset: union of const}
      const fieldRef = root?.dict?.defaultPreset
      const node = refs[fieldRef]
      if (node?.type === 'union') {
        for (const id of node.list ?? []) {
          const c = refs[id]
          if (c?.type === 'const') {
            S.permissionPresets.push({ value: c.value, name: PERMISSION_LABELS[c.value] ?? c.value, description: c.meta?.description || '' })
          }
        }
      }
    }
    const sel = $('selPermission')
    sel.innerHTML = ''
    if (!S.permissionPresets.length) {
      // 兜底（宿主未注册 permission 命名空间时）
      S.permissionPresets = [
        { value: 'workspace-write', name: PERMISSION_LABELS['workspace-write'] },
        { value: 'danger-full-access', name: PERMISSION_LABELS['danger-full-access'] },
      ]
    }
    for (const p of S.permissionPresets) {
      const opt = document.createElement('option')
      opt.value = p.value
      opt.textContent = p.name
      sel.appendChild(opt)
    }
    // 默认选择：按配置 approvalLevel 推断
    const level = GOVConfig.get('agent.approvalLevel')
    if (level === 'auto') {
      const full = S.permissionPresets.find(p => p.value === 'danger-full-access')
      sel.value = full?.value ?? S.permissionPresets[0]?.value ?? ''
    } else if (level === 'confirm') {
      const ask = S.permissionPresets.find(p => p.value === 'workspace-write')
      sel.value = ask?.value ?? S.permissionPresets[0]?.value ?? ''
    } else {
      sel.value = GOVConfig.get('agent.permissionPreset') || S.permissionPresets[0]?.value || ''
    }
    if (sel.value) { /* 首页数据由 renderHome 统一渲染 */ }
    renderHome()
  }

  async function bindParamSelects () {
    $('selPreset').addEventListener('change', async () => {
      const id = $('selPreset').value
      if (!S.sessionId || S.blank) { S.agentPreset = id || undefined; return }
      // 会话已开始：agentPreset.select（仅 blank 会话允许）
      const res = await DSHApi.agentPresets.select({ sessionId: S.sessionId, agentPreset: id })
      if (!res.ok) alert(`模式切换失败：${res.error?.message ?? ''}`)
    })
    $('selPermission').addEventListener('change', () => {
      const el = $('selPermission')
      el.title = '权限预设将在新建工单时生效（写入宿主新会话默认，不消耗模型额度）'
      renderHome()
    })
    $('selModel').addEventListener('change', () => {
      refreshEffortSelect()
      void applyModelSelection()
    })
    $('selEffort').addEventListener('change', () => void applyModelSelection())
    // 工作目录下拉
    $('selCwd').addEventListener('change', async () => {
      const v = $('selCwd').value
      if (v === '__pick__') {
        await pickFolderViaNative()
      } else if (v === '__new__') {
        await new Promise(resolve => {
          showWorkspacePicker({
            title: '新建工作区',
            onSubmit: async path => {
              if (path) {
                const wres = await DSHApi.workspace.create({ path })
                if (wres.ok) {
                  if (!S.workspaces.some(w => w.workspaceId === wres.value.workspace.workspaceId)) S.workspaces.push(wres.value.workspace)
                  S.workDir = path
                } else {
                  alert(`工作区创建失败：${wres.error?.message ?? ''}`)
                }
              }
              renderCwdSelect()
              resolve()
            },
            onCancel: () => { renderCwdSelect(); resolve() },
          })
        })
      } else {
        S.workDir = v
      }
    })
  }

  async function pickFolderViaNative () {
    const res = await DSHApi.host.pickDirectory({})
    if (res.ok && res.value.path) {
      S.workDir = res.value.path
    } else if (res.ok && !res.value.path) {
      // 用户取消，无操作
    } else {
      const p = prompt('原生目录选择不可用，请手动输入文件夹完整路径：')
      if (p) S.workDir = p.trim()
    }
    renderCwdSelect()
  }

  async function loadModels () {
    if (!S.sessionId) {
      // 无会话时用全局模型目录预填（创建会话后再 selectModel 落地）
      return loadGlobalModels()
    }
    const res = await DSHApi.sessions.models({ sessionId: S.sessionId })
    if (!res.ok) {
      renderHome()
      return
    }
    S.modelCatalog = res.value
    const cur = res.value.current
    S.modelSel = { provider: cur.provider, model: cur.model, reasoningEffort: cur.reasoningEffort ?? '' }
    const sel = $('selModel')
    sel.innerHTML = ''
    for (const g of res.value.groups ?? []) {
      const og = document.createElement('optgroup')
      og.label = `${g.name}（${g.id}）`
      for (const m of g.models ?? []) {
        const opt = document.createElement('option')
        opt.value = `${g.id}::${m.id}`
        opt.textContent = m.name || m.id
        og.appendChild(opt)
      }
      sel.appendChild(og)
    }
    for (const f of res.value.failures ?? []) {
      const opt = document.createElement('option')
      opt.value = ''
      opt.textContent = `（${f.name} 不可用：${f.message}）`
      opt.disabled = true
      sel.appendChild(opt)
    }
    sel.value = `${cur.provider}::${cur.model}` || sel.options[0]?.value || ''
    refreshEffortSelect()
    renderHome()
  }

  /** 无会话时的全局模型目录预填（llm.models 域） */
  async function loadGlobalModels () {
    const res = await DSHApi.llm.models({})
    if (!res.ok) return
    // 结构：{providers: [{provider, models: [...]}]} 或兼容其它形态
    const list = res.value?.providers ?? res.value?.groups ?? res.value?.items ?? []
    S.globalModelGroups = list
    // llm.models 与 session.models 都返回 groups；统一保存，供推理强度动态枚举。
    S.modelCatalog = { groups: list, failures: res.value?.failures ?? [] }
    const sel = $('selModel')
    sel.innerHTML = ''
    for (const p of list) {
      const og = document.createElement('optgroup')
      og.label = `${p.name ?? p.id ?? ''}（${p.id ?? p.provider ?? ''}）`
      for (const m of p.models ?? []) {
        const opt = document.createElement('option')
        opt.value = `${p.id ?? p.provider}::${m.id}`
        opt.textContent = m.name || m.id
        og.appendChild(opt)
      }
      sel.appendChild(og)
    }
    if (!sel.options.length) sel.innerHTML = '<option value="">（宿主当前未提供模型目录）</option>'
    const configured = GOVConfig.get('agent.defaultProvider') && GOVConfig.get('agent.defaultModel')
      ? `${GOVConfig.get('agent.defaultProvider')}::${GOVConfig.get('agent.defaultModel')}`
      : ''
    if (configured && [...sel.options].some(option => option.value === configured)) sel.value = configured
    if (!sel.value && sel.options.length) sel.selectedIndex = 0
    const [provider, model] = (sel.value || '::').split('::')
    S.modelSel = { provider, model, reasoningEffort: '' }
    refreshEffortSelect()
    renderHome()
  }

  function refreshEffortSelect () {
    const sel = $('selEffort')
    const [provider, model] = ($('selModel').value || '::').split('::')
    const g = (S.modelCatalog?.groups ?? []).find(x => (x.id ?? x.provider) === provider)
    const m = g?.models?.find(x => x.id === model)
    const efforts = m?.reasoning?.efforts ?? []
    sel.innerHTML = ''
    if (!efforts.length) {
      sel.innerHTML = '<option value="">该模型未提供推理强度</option>'
      sel.disabled = true
      return
    }
    sel.disabled = false
    const defaultOption = document.createElement('option')
    defaultOption.value = ''
    defaultOption.textContent = m.reasoning?.defaultEffort
      ? `适配器默认（${m.reasoning.defaultEffort}）`
      : '适配器默认'
    sel.appendChild(defaultOption)
    for (const e of efforts) {
      const opt = document.createElement('option')
      opt.value = e.id
      opt.textContent = `${e.name}${e.description ? ` — ${e.description}` : ''}`
      sel.appendChild(opt)
    }
    const selected = S.modelSel.provider === provider && S.modelSel.model === model
      ? (S.modelSel.reasoningEffort ?? '')
      : (m.reasoning?.defaultEffort ?? '')
    sel.value = [...sel.options].some(option => option.value === selected) ? selected : ''
  }

  async function applyModelSelection () {
    const val = $('selModel').value
    if (!val) return
    const [provider, model] = val.split('::')
    if (!S.sessionId) {
      S.modelSel = { provider, model, reasoningEffort: '' }
      refreshEffortSelect()
      return
    }
    const effort = $('selEffort').value || undefined
    const res = await DSHApi.sessions.selectModel({ sessionId: S.sessionId, provider, model, reasoningEffort: effort })
    if (res.ok) {
      S.modelSel = res.value.selected
      renderHome()
    } else {
      alert(`模型选择失败：${res.error?.message ?? ''}`)
    }
  }

  /* ================= 会话管理 ================= */
  async function ensureSession () {
    if (S.sessionId) return true
    return createNewSession()
  }

  /* —— 工作目录：加载宿主 cwd + 工作区列表 —— */
  async function loadWorkDir () {
    const hres = await DSHApi.host.describe({})
    if (hres.ok) {
      S.hostInfo = hres.value
      if (!S.workDir) S.workDir = hres.value.cwd || ''
    }
    const wres = await DSHApi.workspace.list({})
    if (wres.ok) S.workspaces = wres.value.items ?? []
    renderCwdSelect()
  }

  function renderCwdSelect () {
    const sel = $('selCwd')
    if (!sel) return
    sel.innerHTML = ''
    const cur = S.workDir || S.hostInfo?.cwd || ''
    if (cur) {
      const ws = S.workspaces.find(w => w.path === cur)
      const opt = document.createElement('option')
      opt.value = cur
      opt.textContent = `${ws ? '📁 ' + ws.title : '📁 工作目录'}：${cur}`
      sel.appendChild(opt)
    } else {
      const opt = document.createElement('option')
      opt.value = ''
      opt.textContent = '（未设置工作目录）'
      sel.appendChild(opt)
    }
    for (const w of S.workspaces) {
      if (w.path === cur) continue
      const opt = document.createElement('option')
      opt.value = w.path
      opt.textContent = `📁 ${w.title}`
      sel.appendChild(opt)
    }
    const pick = document.createElement('option')
    pick.value = '__pick__'
    pick.textContent = '＋ 选择文件夹…'
    sel.appendChild(pick)
    const mk = document.createElement('option')
    mk.value = '__new__'
    mk.textContent = '＋ 新建工作区…'
    sel.appendChild(mk)
    sel.value = cur || ''
  }

  function renderWorkspaceList (listEl, inputEl) {
    listEl.innerHTML = ''
    for (const w of S.workspaces) {
      const a = document.createElement('div')
      a.style.cssText = 'padding:5px 8px;cursor:pointer;border-bottom:1px dashed #ddd;font-size:13px'
      a.textContent = `📁 ${w.title}（${w.path}）`
      a.addEventListener('click', () => { if (inputEl) inputEl.value = w.path })
      a.addEventListener('mouseenter', () => { a.style.background = '#f3faff' })
      a.addEventListener('mouseleave', () => { a.style.background = '' })
      listEl.appendChild(a)
    }
    if (!S.workspaces.length) listEl.innerHTML = '<span style="color:#999;font-size:12px">（暂无工作区，可通过「新建工作区」创建）</span>'
  }

  /* —— 工作区/目录选择弹窗（业务大厅「新建工作区」与卷宗「确认工作区」共用） —— */
  function showWorkspacePicker (opts = {}) {
    const title = opts.title || '选择工作目录'
    const bodyHtml = `
      <div style="margin-bottom:8px;font-size:13px;color:#555">工作目录（会话将在此目录下创建与执行）：</div>
      <div style="display:flex;gap:8px;margin-bottom:10px">
        <input type="text" id="wsPathInput" style="flex:1;border:1px solid #999;padding:5px 8px" value="${GOV.escape(S.workDir || '')}" placeholder="留空使用宿主默认目录">
        <button class="gov-btn small gray" id="wsPickBtn">选择文件夹…</button>
        <button class="gov-btn small gray" id="wsNewBtn">新建工作区…</button>
      </div>
      <div style="font-size:13px;color:#555;margin-bottom:4px">现有工作区（点击填入）：</div>
      <div id="wsList" style="max-height:180px;overflow:auto;border:1px solid #eee"></div>`
    const mask = showDialog(title, bodyHtml, [
      ['确认', '', () => {
        const v = mask.querySelector('#wsPathInput').value.trim()
        opts.onSubmit?.(v || undefined)
      }],
      ['取消', 'gray', () => opts.onCancel?.(null)],
    ])
    const inputEl = mask.querySelector('#wsPathInput')
    const listEl = mask.querySelector('#wsList')
    renderWorkspaceList(listEl, inputEl)

    mask.querySelector('#wsPickBtn').addEventListener('click', async () => {
      const res = await DSHApi.host.pickDirectory({})
      if (res.ok && res.value.path) inputEl.value = res.value.path
      else if (res.ok && !res.value.path) { /* 用户取消 */ }
      else { alert(`目录选择不可用：${res.error?.message ?? ''}（可手动输入完整路径）`) }
    })
    mask.querySelector('#wsNewBtn').addEventListener('click', async () => {
      const pick = await DSHApi.host.pickDirectory({})
      let path = pick.ok && pick.value.path ? pick.value.path : null
      if (!path) {
        path = prompt('请输入新工作区文件夹的完整路径：')
        if (!path) return
      }
      const wres = await DSHApi.workspace.create({ path })
      if (wres.ok) {
        if (!S.workspaces.some(w => w.workspaceId === wres.value.workspace.workspaceId)) S.workspaces.push(wres.value.workspace)
        inputEl.value = path
        renderWorkspaceList(listEl, inputEl)
      } else {
        alert(`工作区创建失败：${wres.error?.message ?? ''}（目录需已存在）`)
      }
    })
    return mask
  }

  async function createNewSessionWithWorkspaceDialog () {
    const dir = await new Promise(resolve => {
      showWorkspacePicker({
        title: '新建空白卷宗 · 确认工作区',
        onSubmit: v => resolve(v),
        onCancel: () => resolve(null),
      })
    })
    if (dir === null) return false // 取消
    if (dir !== undefined) S.workDir = dir
    renderCwdSelect()
    return createNewSession()
  }

  async function createNewSession () {
    // 权限预设：把所选权限写入宿主「新会话默认」设置（settings.permission.defaultPreset），
    // 新工单会话创建时宿主即按此预设初始化（零 Token 消耗，不发任何权限消息）。
    const wantPreset = $('selPermission')?.value
    if (wantPreset && wantPreset !== S.hostPermissionDefault) {
      const desc = await DSHApi.settings.describe({})
      if (desc.ok) {
        const pns = desc.value.namespaces.find(n => n.ns === 'permission')
        await DSHApi.settings.update({ ns: 'permission', patch: { defaultPreset: wantPreset }, expectedRevision: pns?.revision })
        S.hostPermissionDefault = wantPreset
      }
    }

    const preset = $('selPreset')?.value || undefined
    const cwd = S.workDir || undefined
    const res = await DSHApi.sessions.create({ agentPreset: preset || undefined, ...(cwd ? { cwd } : {}) })
    if (!res.ok) {
      alert(`工单创建失败：${res.error?.message ?? ''}`)
      return false
    }
    S.sessionId = res.value.sessionId
    S.agentPreset = res.value.agentPreset
    S.blank = true
    S.running = false
    S.stats = emptyStats()
    S.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    S.stepViews.clear()
    S.pendingTools.clear()
    S.lastSeq = -1
    const seq = Number(GOVConfig.get('misc.ticketSeq')) || 1
    const prefix = GOVConfig.get('agent.ticketPrefix') || 'TASK-YYYYMMDD-'
    $('woNo').textContent = GOV.makeTicketNo(prefix, seq)
    GOVConfig.set('misc.ticketSeq', seq + 1)
    $('woSessionId').textContent = S.sessionId.slice(0, 12) + '…'
    setWoStatus('【待受理】', false)
    $('receiptContent').innerHTML = ''
    $('welcomeBox').style.display = 'none'
    resetForm(false)
    $('stampEl').classList.remove('show')
    // 默认模型（若配置）
    const cfg = GOVConfig.get('agent')
    if (cfg.defaultProvider && cfg.defaultModel) {
      await DSHApi.sessions.selectModel({ sessionId: S.sessionId, provider: cfg.defaultProvider, model: cfg.defaultModel, reasoningEffort: cfg.defaultEffort || undefined })
    }
    await loadModels()
    await loadVolumes()
    renderHome()
    // 会话订阅基线（mux 订阅帧会带 lastSeq）
    return true
  }

  function setWoStatus (text, finished) {
    const el = $('woStatus')
    el.textContent = text
    el.classList.toggle('finished', Boolean(finished))
  }

  async function switchSession (sessionId) {
    if (!sessionId || sessionId === S.sessionId) return
    S.sessionId = sessionId
    S.blank = false
    S.running = false
    S.stats = emptyStats()
    S.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    S.stepViews.clear()
    S.pendingTools.clear()
    S.lastSeq = -1
    $('receiptContent').innerHTML = ''
    $('welcomeBox').style.display = 'none'
    $('woSessionId').textContent = sessionId.slice(0, 12) + '…'
    setWoStatus('【已归档】', true)
    await loadHistory(sessionId)
    await loadModels()
    $('trailSessionLabel').textContent = sessionId.slice(0, 12) + '…'
  }

  /* ================= 历史加载与渲染 ================= */
  async function loadHistory (sessionId) {
    const res = await DSHApi.sessions.history({ sessionId, maxMessages: 40 })
    if (!res.ok) return
    const { events, projections } = res.value
    S.historyHasMore = res.value.hasMore
    // 投影基线（统计/权限/标题）
    if (projections?.values) applyProjections(projections.values)
    $('receiptContent').innerHTML = ''
    S.stepViews.clear()
    S.pendingTools.clear()
    for (const entry of events) {
      handleSessionEvent(entry.event, entry.view, { historical: true })
    }
    scrollReceipt(true)
  }

  /** 加载更早历史（卷宗预览/回执前滚） */
  async function loadOlder (sessionId) {
    if (!S.historyHasMore || S.loadingOlder) return
    S.loadingOlder = true
    const beforeSeq = S.lastSeq >= 0 ? S.lastSeq : undefined
    const res = await DSHApi.sessions.history({ sessionId, beforeSeq, maxMessages: 40 })
    S.loadingOlder = false
    if (!res.ok) return
    S.historyHasMore = res.value.hasMore
  }

  /* ================= 事件流 ================= */
  function startMux () {
    S.stopMux = false
    void (async () => {
      while (!S.stopMux) {
        await new Promise(resolve => {
          DSHApi.openStream('events.mux', frame => onMuxFrame(frame), {
            onOpen: () => { /* 流已建立 */ },
            onClose: () => resolve(),
            onError: err => { console.warn('[gov-portal] mux 流中断：', err?.message); resolve() },
          })
        })
        if (!S.stopMux) await new Promise(r => setTimeout(r, Number(GOVConfig.get('agent.wsRetryMs')) || 3000))
      }
    })()
  }

  function onMuxFrame (frame) {
    const p = frame.payload ?? {}
    switch (p.type) {
      case 'session/event':
        if (p.sessionId === S.sessionId) handleSessionEvent(p.event, p.view, {})
        if (p.sessionId === S.sessionId) appendTrail(p.event)
        break
      case 'session/projection':
        if (p.sessionId === S.sessionId) applyProjections({ [p.key]: p.value })
        break
      case 'session/subscribed':
        if (p.sessionId === S.sessionId && !S.lastSeq) S.lastSeq = p.lastSeq
        break
      case 'approval/requested':
        if (p.sessionId === S.sessionId) showApproval(frame.rpcId, p)
        break
      case 'question/requested':
        if (p.sessionId === S.sessionId) showQuestion(frame.rpcId, p)
        break
      case 'session/queue':
        if (p.sessionId === S.sessionId && p.items?.length) {
          const n = p.items.filter(i => i.placement === 'queued').length
          if (n) addTrajectoryLine(`队列中还有 ${n} 项待办，将按序受理…`)
        }
        break
      case 'stream/error':
        addTrajectoryLine(`事件流错误：${p.error?.message ?? ''}`)
        break
      case 'approval/resolved':
      case 'question/resolved':
        break
      default:
        break
    }
  }

  function applyProjections (values) {
    if (!values || typeof values !== 'object') return
    if (values.sessionStats && typeof values.sessionStats === 'object') {
      S.stats = { ...S.stats, ...values.sessionStats }
      updateStatsBar()
    }
    if (values.permissions && typeof values.permissions === 'object') {
      S.permissionState = values.permissions
    }
    if (typeof values.title === 'string' && values.title) S.title = values.title
  }

  /* ================= 会话事件渲染 ================= */
  function handleSessionEvent (ev, view, opts) {
    if (ev?.seq !== undefined && ev.seq > S.lastSeq) S.lastSeq = ev.seq
    const D = ev?.data ?? {}
    switch (ev?.type) {
      case 'user/message': renderUserMessage(D); break
      case 'assistant/chunk': renderChunk(D, opts); break
      case 'assistant/message': renderAssistantMessage(D, opts); break
      case 'tool/call': renderToolCall(D); break
      case 'tool/result': renderToolResult(D); break
      case 'todo/write': renderTodo(D); break
      case 'turn/start':
        S.running = true
        S.turnStart = ev.time
        setWoStatus('【办理中】', false)
        addTrajectoryLine(`第 ${D.turn} 轮开始办理`)
        break
      case 'turn/end': {
        S.running = false
        S.blank = false
        const reason = D.reason
        const kind = typeof reason === 'string' ? reason : reason?.kind
        if (kind === 'completed' || kind === undefined) {
          setWoStatus('【准予办结】', true)
          if (GOVConfig.get('agent.stampOnFinish') && !opts.historical) stamp()
        } else {
          const label = { aborted: '中止', blocked: '受阻', error: '办理失败', 'max-tokens': '输出超限', interrupted: '中断' }[kind] ?? kind ?? '结束'
          setWoStatus(`【${label}】`, true)
          addTrajectoryLine(`本轮结束：${kind ?? '—'}`)
        }
        addTrajectoryLine(`第 ${D.turn} 轮办结`)
        break
      }
      case 'step/start':
        addTrajectoryLine(`第 ${D.turn} 轮第 ${D.step} 步：开始调度模型`)
        break
      case 'step/end':
        addTrajectoryLine(`第 ${D.turn} 轮第 ${D.step} 步：结束`)
        break
      case 'request/header': {
        const cfg = D.header?.config ?? {}
        const text = `请求头（${D.reason}）：${cfg.provider ?? '—'} / ${cfg.model ?? '—'}${cfg.reasoningEffort ? ` · ${cfg.reasoningEffort}` : ''}${cfg.temperature !== undefined ? ` · temp ${cfg.temperature}` : ''}`
        addTrajectoryLine(text)
        break
      }
      case 'request/context':
        addTrajectoryLine(`上下文：${D.provider ?? '—'} / ${D.model ?? '—'}${D.contextWindow ? `（窗口 ${D.contextWindow}）` : ''}`)
        break
      default: {
        // 其余事件：内部噪音事件隐藏，已知事件用中文别名，未知事件保留原名（技术流水）
        const label = TRAIL_EVENT_LABELS[ev?.type]
        if (label !== undefined && label !== null) addTrajectoryLine(label, { silent: opts.historical })
        else if (label === undefined && ev?.type) addTrajectoryLine(ev.type, { silent: opts.historical })
      }
    }
  }

  /* 轨迹事件中文别名（null = 内部噪音，不显示） */
  const TRAIL_EVENT_LABELS = {
    'agent/inbox/spliced': null,
    'session/title': null,
    'session/title-llm-request': null,
    'session/checkpoint': null,
    'session/checkpoint-start': null,
    'session/checkpoint-end': null,
    'compaction/start': '上下文压缩开始',
    'compaction/end': '上下文压缩完成',
    'compaction/summary': '上下文压缩摘要已生成',
    'plan/state': '计划模式状态更新',
    'permission/preset': '权限预设已切换',
    'sandbox/mode': '沙箱模式已变更',
    'approval/policy': '审批策略已变更',
    'goal/created': '长期目标已创建',
    'goal/updated': '长期目标已更新',
  }

  /* —— 用户消息 —— */
  function renderUserMessage (D) {
    if (D?.source?.kind !== 'user') {
      addTrajectoryLine('注入系统上下文')
      return
    }
    const text = blocksToText(D.content)
    if (!text) return
    const div = document.createElement('div')
    div.className = 'rcv-item'
    div.innerHTML = `<div class="rcv-user"><div class="who">申请人提交</div><div class="text">${GOV.escape(text)}</div></div>`
    $('receiptContent').appendChild(div)
    scrollReceipt()
  }

  /* —— chunk 流式累积 —— */
  function renderChunk (D, opts) {
    const key = `${D.turn}.${D.step}`
    let view = S.stepViews.get(key)
    if (!view) {
      view = { reasoning: '', text: '', reasoningEl: null, textEl: null, toolBlocks: [] }
      S.stepViews.set(key, view)
      const holder = document.createElement('div')
      holder.className = 'rcv-item'
      holder.innerHTML = `
        <div class="rcv-thinking" id="think-${key.replace('.', '-')}" style="display:none">
          <summary>办理思路 · 第 ${D.turn} 轮第 ${D.step} 步</summary>
          <div class="thinking-body"></div>
        </div>
        <div class="rcv-assistant"><div class="who">系统回执 · 第 ${D.turn} 轮第 ${D.step} 步</div><div class="text"></div></div>`
      $('receiptContent').appendChild(holder)
      view.holder = holder
      view.reasoningEl = holder.querySelector('.thinking-body')
      view.textEl = holder.querySelector('.rcv-assistant .text')
      view.thinkingBox = holder.querySelector('.rcv-thinking')
      scrollReceipt()
    }
    const chunk = D.chunk ?? {}
    switch (chunk.type) {
      case 'block-start':
        if (chunk.blockType === 'reasoning') view.thinkingBox.style.display = ''
        break
      case 'reasoning-delta':
        view.reasoning += chunk.text ?? ''
        view.reasoningEl.textContent = view.reasoning
        break
      case 'text-delta':
        view.text += chunk.text ?? ''
        view.textEl.textContent = view.text
        break
      case 'tool-call-delta':
        // 工具调用参数流：归属 tool/call 事件渲染，此处忽略
        break
      case 'usage':
        if (chunk.usage) S.usage.stepUsage = chunk.usage
        break
      default:
        break
    }
    if (!opts.historical) scrollReceipt()
  }

  /* —— 完成的 assistant 消息（权威内容，替换该 step 的流式累积） —— */
  function renderAssistantMessage (D, opts) {
    const key = `${D.turn}.${D.step}`
    const view = S.stepViews.get(key)
    // usage 聚合
    if (D.usage) {
      S.usage.input += D.usage.inputTokens ?? 0
      S.usage.output += D.usage.outputTokens ?? 0
      S.usage.cacheRead += D.usage.cacheReadTokens ?? 0
      S.usage.cacheWrite += D.usage.cacheWriteTokens ?? 0
      updateStatsBar()
    }
    const blocks = D.message?.content ?? []
    const hasTool = blocks.some(b => b.type === 'tool-call')
    if (view) {
      // 用权威内容重写文本/思路
      const reasoning = blocks.filter(b => b.type === 'reasoning').map(b => b.text).join('\n')
      const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n')
      if (reasoning) { view.reasoningEl.textContent = reasoning; view.thinkingBox.style.display = '' }
      if (text) view.textEl.innerHTML = GOV.renderMarkdown(text)
      if (!reasoning && !text && !hasTool) view.holder.remove()
      if (!hasTool) S.stepViews.delete(key)
    } else if (!hasTool) {
      const text = blocksToText(blocks)
      if (text) {
        const div = document.createElement('div')
        div.className = 'rcv-item'
        div.innerHTML = `<div class="rcv-assistant"><div class="who">系统回执 · 第 ${D.turn} 轮第 ${D.step} 步</div><div class="text">${GOV.renderMarkdown(text)}</div></div>`
        $('receiptContent').appendChild(div)
        scrollReceipt()
      }
    }
  }

  /* —— 工具调用 —— */
  function renderToolCall (D) {
    const div = document.createElement('div')
    div.className = 'rcv-item'
    let argsPreview = ''
    try { argsPreview = JSON.stringify(JSON.parse(D.arguments ?? '{}')).slice(0, 400) } catch { argsPreview = String(D.arguments ?? '').slice(0, 400) }
    div.innerHTML = `
      <div class="rcv-tool running" id="tool-${GOV.escape(D.callId)}">
        <div class="tool-head"><span class="tname">⚙ ${GOV.escape(D.name ?? 'tool')}</span><span class="tstate">执行中…</span></div>
        <div class="tool-args">${GOV.escape(argsPreview)}</div>
        <div class="tool-result"></div>
      </div>`
    $('receiptContent').appendChild(div)
    S.pendingTools.set(D.callId, { el: div.querySelector('.rcv-tool'), name: D.name })
    scrollReceipt()
  }

  function renderToolResult (D) {
    // ToolResultMessage.content = [ToolResultBlock{toolCallId, content, isError}]
    const block = D.message?.content?.[0] ?? {}
    const callId = block.toolCallId ?? D.message?.toolCallId
    const card = S.pendingTools.get(callId)
    if (card) {
      const text = blocksToText(block.content)
      const isErr = Boolean(D.error) || Boolean(block.isError)
      card.el.classList.remove('running')
      card.el.classList.add(isErr ? 'err' : 'ok')
      card.el.querySelector('.tstate').textContent = isErr ? `失败（${D.error?.code ?? 'error'}）` : '已完成'
      const resEl = card.el.querySelector('.tool-result')
      resEl.textContent = text ? String(text).slice(0, 3000) : (isErr ? String(D.error?.name ?? '') : '（无文本结果）')
      S.pendingTools.delete(callId)
    }
  }

  /* —— todo —— */
  function renderTodo (D) {
    const todos = D.todos ?? []
    if (!todos.length) return
    const rows = todos.map(t =>
      `<tr><td>${GOV.escape(t.content)}</td><td style="width:90px" class="st-${t.status}">${{ pending: '待办', in_progress: '办理中', completed: '已办结' }[t.status] ?? t.status}</td></tr>`).join('')
    const div = document.createElement('div')
    div.className = 'rcv-item rcv-todo'
    div.innerHTML = `<div class="todo-title">☑ 督办事项清单</div><table>${rows}</table>`
    $('receiptContent').appendChild(div)
    scrollReceipt()
  }

  function blocksToText (blocks) {
    if (!Array.isArray(blocks)) return ''
    return blocks.filter(b => b?.type === 'text').map(b => b.text ?? '').join('\n')
  }

  function addTrajectoryLine (text, opts = {}) {
    if (opts.silent) return
    const div = document.createElement('div')
    div.className = 'rcv-trajectory'
    div.textContent = text
    $('receiptContent').appendChild(div)
    scrollReceipt()
  }

  function scrollReceipt (force) {
    if (!GOVConfig.get('agent.autoScroll') && !force) return
    const w = $('receiptWindow')
    w.scrollTop = w.scrollHeight
  }

  /* —— 盖章 —— */
  function stamp () {
    const el = $('stampEl')
    el.classList.remove('show')
    void el.offsetWidth // 重启动画
    el.classList.add('show')
  }

  /* ================= 统计行 ================= */
  function updateStatsBar () {
    const s = S.stats
    $('stTurns').textContent = s.turns
    $('stSteps').textContent = s.steps
    $('stLlm').textContent = GOV.fmtDuration(s.llmMs)
    $('stTool').textContent = GOV.fmtDuration(s.toolMs)
    $('stTtft').textContent = s.ttftSteps ? (s.ttftMs / s.ttftSteps / 1000).toFixed(1) + 's' : '—'
    $('stTps').textContent = s.decodeMs ? (s.decodeTokens / (s.decodeMs / 1000)).toFixed(0) : '—'
    const billed = S.usage.input + S.usage.cacheRead + S.usage.cacheWrite
    $('stCache').textContent = GOV.fmtPct(S.usage.cacheRead, billed)
    $('stIn').textContent = GOV.fmtTokens(billed)
    $('stOut').textContent = GOV.fmtTokens(S.usage.output)
    // TPS = 总 token / 本轮墙面时间
    let tps = '—'
    if (S.turnStart && (billed + S.usage.output) > 0) {
      const wall = (Date.now() - S.turnStart) / 1000
      if (wall > 0) tps = ((billed + S.usage.output) / wall).toFixed(0)
    }
    $('stTps2').textContent = tps
  }

  /* ================= 提交办理 ================= */
  async function submitPrompt () {
    const text = $('promptInput').value.trim()
    if (!text) { $('promptInput').focus(); return }
    const ok = await ensureSession()
    if (!ok) return
    $('btnSubmit').disabled = true

    try {
      // 权限预设：会话创建时已按所选值设置宿主默认；会话内切换通过设置面板完成，
      // 此处不再向会话发送任何权限消息（避免浪费模型 Token）。
      // 温度/上下文轮数 → 写入宿主设置（若有修改）
      const cfg = GOVConfig.get('agent')
      if (cfg.temperature !== '' && cfg.temperature !== null && cfg.temperature !== undefined) {
        await tryApplyTemperature(Number(cfg.temperature))
      }

      // 提交正文（仅此一条消息进入 Agent）
      const res = await DSHApi.sessions.prompt({
        sessionId: S.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      })
      if (!res.ok) {
        addTrajectoryLine(`提交失败：${res.error?.message ?? ''}`)
      } else if (res.value?.command) {
        addTrajectoryLine(`命令已执行：${res.value.command.text ?? ''}`)
      }
      // 不再本地回显：由 user/message 事件权威渲染，避免同一条消息显示两遍
      $('promptInput').value = ''
      $('welcomeBox').style.display = 'none'
    } finally {
      $('btnSubmit').disabled = false
    }
  }

  /** 温度写入：尝试多个可能的宿主设置命名空间（失败静默） */
  async function tryApplyTemperature (temp) {
    const desc = await DSHApi.settings.describe({})
    if (!desc.ok) return
    const candidates = desc.value.namespaces.filter(n => ['agent-default-model', 'llm-defaults', 'agent', 'model'].includes(n.ns))
    for (const ns of candidates) {
      const patch = { temperature: temp }
      const res = await DSHApi.settings.update({ ns: ns.ns, patch, expectedRevision: ns.revision })
      if (res.ok) return
    }
  }

  function resetForm (clearText = true) {
    if (clearText) $('promptInput').value = ''
    const cfg = GOVConfig.get('agent')
    // 复位参数为配置默认
    if (cfg.defaultProvider && cfg.defaultModel && S.modelCatalog) {
      $('selModel').value = `${cfg.defaultProvider}::${cfg.defaultModel}`
      refreshEffortSelect()
      if (cfg.defaultEffort) $('selEffort').value = cfg.defaultEffort
      void applyModelSelection()
    }
    const selP = $('selPermission')
    selP.value = cfg.permissionPreset || selP.options[0]?.value || ''
    const preset = S.presets.find(p => p.isDefault)
    if (preset) $('selPreset').value = preset.id
  }

  /* ================= 审批与问题弹窗 ================= */
  function showDialog (title, bodyHtml, buttons, opts = {}) {
    const layer = $('dialogLayer')
    const mask = document.createElement('div')
    mask.className = 'gov-mask'
    const dlg = document.createElement('div')
    dlg.className = 'gov-dialog'
    dlg.innerHTML = `
      <div class="dlg-title ${opts.red ? 'red' : ''}"><span>${GOV.escape(title)}</span><span class="dlg-close" data-close>×</span></div>
      <div class="dlg-body">${bodyHtml}</div>
      <div class="dlg-foot"></div>`
    const foot = dlg.querySelector('.dlg-foot')
    for (const [label, cls, handler] of buttons) {
      const b = document.createElement('button')
      b.className = `gov-btn ${cls ?? ''}`
      b.textContent = label
      b.addEventListener('click', async () => {
        let keep = false
        if (handler) {
          b.disabled = true
          try {
            keep = (await handler()) === false
          } catch (error) {
            keep = true
            const errorBox = dlg.querySelector('.dialog-action-error') || document.createElement('div')
            errorBox.className = 'dialog-action-error'
            errorBox.textContent = `操作失败：${error?.message ?? error}`
            if (!errorBox.parentNode) dlg.querySelector('.dlg-body').appendChild(errorBox)
          } finally {
            b.disabled = false
          }
        }
        if (!keep) mask.remove()
      })
      foot.appendChild(b)
    }
    dlg.querySelector('[data-close]').addEventListener('click', () => mask.remove())
    mask.appendChild(dlg)
    layer.appendChild(mask)
    return mask
  }

  function showApproval (rpcId, p) {
    const item = { rpcId, payload: p }
    S.approvalQueue.push(item)
    if (S.dialogOpen) return
    processApprovalQueue()
  }

  function processApprovalQueue () {
    const item = S.approvalQueue.shift()
    if (!item) { S.dialogOpen = false; return }
    S.dialogOpen = true
    const p = item.payload
    const body = `
      <div class="kv"><span class="k">会话：</span><span class="v">${GOV.escape((p.sessionId ?? '').slice(0, 12))}…</span></div>
      <div class="kv"><span class="k">工具名称：</span><span class="v"><b>${GOV.escape(p.toolName ?? '—')}</b></span></div>
      ${p.callId ? `<div class="kv"><span class="k">调用编号：</span><span class="v">${GOV.escape(p.callId.slice(0, 12))}…</span></div>` : ''}
      ${p.reason ? `<div class="approval-reason">审批理由：${GOV.escape(p.reason)}</div>` : ''}
      <div style="margin-top:10px;font-size:13px;color:#666">该工具调用需要您的审批。请选择：</div>`
    showDialog('沙箱操作审批', body, [
      ['准予执行（本次）', '', async () => {
        await DSHApi.respond(item.rpcId, { sessionId: p.sessionId, approvalId: p.approvalId, outcome: 'allowed-once' })
        addTrajectoryLine(`已准予工具 ${p.toolName} 本次执行`)
        processApprovalQueue()
      }],
      ['不予批准', 'red', async () => {
        await DSHApi.respond(item.rpcId, { sessionId: p.sessionId, approvalId: p.approvalId, outcome: 'rejected' })
        addTrajectoryLine(`已驳回工具 ${p.toolName} 的调用申请`)
        processApprovalQueue()
      }],
    ], { red: true })
  }

  function showQuestion (rpcId, p) {
    const item = { rpcId, payload: p }
    S.approvalQueue.push(item)
    if (S.dialogOpen) return
    processQuestionQueue()
  }

  function processQuestionQueue () {
    const item = S.approvalQueue.shift()
    if (!item) { S.dialogOpen = false; return }
    S.dialogOpen = true
    const p = item.payload
    const questions = p.questions ?? []
    const body = document.createElement('div')
    body.innerHTML = `<div style="font-size:13px;color:#666;margin-bottom:10px">系统向您确认以下问题（请逐项选择）：</div>`
    const selects = []
    for (const q of questions) {
      const row = document.createElement('div')
      row.style.cssText = 'margin-bottom:12px'
      const opts = (q.options ?? []).map((o, i) => `<option value="${GOV.escape(o.label)}">${GOV.escape(o.label)}${o.description ? ` — ${GOV.escape(o.description)}` : ''}</option>`).join('')
      row.innerHTML = `<div style="font-weight:bold;margin-bottom:4px">${q.multiSelect ? '☑' : '☑'} ${GOV.escape(q.question ?? '')}</div>
        <select class="gov-select" data-qid="${GOV.escape(q.id)}" ${q.multiSelect ? 'multiple size="4"' : ''} style="width:100%;max-width:420px;${q.multiSelect ? 'height:auto' : ''}">${opts}</select>`
      body.appendChild(row)
      selects.push({ id: q.id, el: row.querySelector('select') })
    }
    showDialog('系统咨询 · 请予答复', body.outerHTML, [
      ['提交答复', '', async () => {
        const answers = selects.map(s => ({ id: s.id, selected: [...s.el.selectedOptions].map(o => o.value) }))
        await DSHApi.respond(item.rpcId, { sessionId: p.sessionId, answer: { answers } })
        addTrajectoryLine('已答复系统咨询')
        processQuestionQueue()
      }],
      ['取消', 'gray', async () => {
        await DSHApi.respond(item.rpcId, { sessionId: p.sessionId, answer: { answers: [] } })
        processQuestionQueue()
      }],
    ], { red: false })
  }

  /* ================= 电子卷宗 ================= */
  async function loadVolumes () {
    const res = await DSHApi.sessions.list({})
    const tbody = $('volumeTable').querySelector('tbody')
    if (!res.ok) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:#c00101">读取失败：${GOV.escape(res.error?.message ?? '')}</td></tr>`
      return
    }
    S.sessions = res.value.items ?? []
    renderVolumes(S.sessions)
  }

  function renderVolumes (items) {
    const tbody = $('volumeTable').querySelector('tbody')
    if (!items.length) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#999">暂无会话卷宗</td></tr>'
      $('volumePager').innerHTML = ''
      return
    }
    tbody.innerHTML = ''
    items.forEach((it, i) => {
      const title = (it.projections?.values?.title) || (it.blank ? '（空白卷宗）' : '（无标题）')
      const tr = document.createElement('tr')
      tr.innerHTML = `
        <td class="num">${i + 1}</td>
        <td class="num" title="${GOV.escape(it.sessionId)}">${GOV.escape(it.sessionId.slice(0, 20))}…</td>
        <td>${GOV.escape(String(title).slice(0, 60))}${it.cwd ? `<span style="color:#999;font-size:12px">（${GOV.escape(it.cwd)}）</span>` : ''}</td>
        <td class="num">${GOV.fmtDateTime(it.updatedAt)}</td>
        <td>${it.running ? '<span style="color:#d98a00;font-weight:bold">办理中</span>' : (it.blank ? '空白' : '已归档')}</td>
        <td>
          <button class="gov-btn small" data-preview="${GOV.escape(it.sessionId)}">查阅</button>
          <button class="gov-btn small gray" data-export="${GOV.escape(it.sessionId)}">导出</button>
          <button class="gov-btn small red" data-delete="${GOV.escape(it.sessionId)}">删除</button>
        </td>`
      tbody.appendChild(tr)
    })
    tbody.querySelectorAll('[data-preview]').forEach(b => b.addEventListener('click', () => void openVolumeInHall(b.dataset.preview)))
    tbody.querySelectorAll('[data-export]').forEach(b => b.addEventListener('click', () => DSHApi.exportSessionLog(b.dataset.export)))
    tbody.querySelectorAll('[data-delete]').forEach(b => b.addEventListener('click', () => void confirmDeleteSession(b.dataset.delete)))
    $('volumePager').innerHTML = `共 ${items.length} 卷 · <button class="gov-btn small gray" id="pagerReload">重新加载</button>`
    $('pagerReload')?.addEventListener('click', () => void loadVolumes())
  }

  /* —— 删除会话：图片验证码确认后归档（宿主无物理删除，归档=从卷宗列表移除、日志保留） —— */
  function confirmDeleteSession (sessionId) {
    const item = S.sessions.find(s => s.sessionId === sessionId)
    const title = (item?.projections?.values?.title) || '该会话'
    const body = document.createElement('div')
    body.innerHTML = `
      <div style="font-size:14px;margin-bottom:10px">确认删除卷宗「${GOV.escape(String(title).slice(0, 40))}」？<br>
        <span style="color:#c00101;font-size:13px">删除后该会话将从卷宗列表移除（会话日志保留于宿主存储，可导出恢复）。</span></div>
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:10px">
        <canvas id="delCaptchaCanvas" style="border:1px solid #999;height:40px"></canvas>
        <a href="javascript:void(0)" id="delCaptchaRefresh" style="color:var(--gov-blue-deep);font-size:13px">看不清？点击刷新</a>
      </div>
      <div style="font-size:13px;color:#555">请输入上图验证码以完成图片验证：<input type="text" id="delCaptchaInput" style="border:1px solid #999;padding:4px 6px;width:120px;margin-left:6px" maxlength="6" autocomplete="off"></div>
      <div id="delCaptchaMsg" style="color:#c00101;font-size:13px;margin-top:6px;min-height:18px"></div>`
    const mask = showDialog('删除卷宗 · 图片验证', body.outerHTML, [
      ['确定删除', 'red', async () => {
        const input = mask.querySelector('#delCaptchaInput').value.trim().toUpperCase()
        const code = mask.__captcha
        const msg = mask.querySelector('#delCaptchaMsg')
        if (!input) { msg.textContent = '请输入验证码'; return false }
        if (input !== code) {
          msg.textContent = '验证码错误，请重试'
          mask.__captcha = GOV.makeCaptcha(mask.querySelector('#delCaptchaCanvas'))
          mask.querySelector('#delCaptchaInput').value = ''
          return false // 校验失败，不关闭
        }
        // 验证通过，执行归档删除
        const res = await DSHApi.workspace.archiveSession({ sessionId })
        if (res.ok) {
          if (S.sessionId === sessionId) S.sessionId = null
          await loadVolumes()
          alert('卷宗已删除（归档）')
          return true // 关闭
        } else {
          msg.textContent = `删除失败：${res.error?.message ?? ''}`
          return false
        }
      }],
      ['取消', 'gray', null],
    ], { red: true })
    // 初始化验证码
    mask.__captcha = GOV.makeCaptcha(mask.querySelector('#delCaptchaCanvas'))
    mask.querySelector('#delCaptchaRefresh').addEventListener('click', () => {
      mask.__captcha = GOV.makeCaptcha(mask.querySelector('#delCaptchaCanvas'))
      mask.querySelector('#delCaptchaInput').value = ''
      mask.querySelector('#delCaptchaMsg').textContent = ''
    })
  }

  async function openVolumeInHall (sessionId) {
    const item = S.sessions.find(session => session.sessionId === sessionId)
    await switchSession(sessionId)
    S.blank = Boolean(item?.blank)
    S.running = Boolean(item?.running)
    setWoStatus(item?.running ? '【办理中】' : (item?.blank ? '【待受理】' : '【可继续办理】'), false)
    switchTab('hall')
    setTimeout(() => $('promptInput')?.focus(), 320)
  }

  async function searchVolumes (query) {
    if (!query) { await loadVolumes(); return }
    const res = await DSHApi.sessions.search({ query })
    if (!res.ok) return
    const ids = new Set((res.value.items ?? []).map(i => i.sessionId))
    renderVolumes(S.sessions.filter(s => ids.has(s.sessionId)))
  }

  function exportCurrentLog () {
    if (!S.sessionId) { alert('尚未创建工单会话'); return }
    DSHApi.exportSessionLog(S.sessionId)
  }

  /* ================= 督办流水 ================= */
  function appendTrail (ev) {
    if (ev?.type === 'assistant/chunk') {
      if (!$('chkTrailChunk').checked) return
    }
    const tbody = $('trailTable').querySelector('tbody')
    if (tbody.querySelector('td[colspan]')) tbody.innerHTML = ''
    const D = ev?.data ?? {}
    let summary = ''
    try {
      switch (ev.type) {
        case 'assistant/chunk':
          summary = (D.chunk?.text ?? D.chunk?.reasoningDelta ?? JSON.stringify(D.chunk ?? {})).slice(0, 80)
          break
        case 'assistant/message':
          summary = blocksToText(D.message?.content).slice(0, 80)
          break
        case 'tool/call':
          summary = `name=${D.name} args=${String(D.arguments ?? '').slice(0, 80)}`
          break
        case 'tool/result':
          summary = blocksToText(D.message?.content).slice(0, 80) || JSON.stringify(D.error ?? '')
          break
        case 'turn/end':
          summary = JSON.stringify(D.reason)
          break
        case 'request/header':
          summary = JSON.stringify(D.header?.config ?? {}).slice(0, 120)
          break
        default:
          summary = JSON.stringify(D).slice(0, 120)
      }
    } catch { summary = String(D).slice(0, 120) }
    const tr = document.createElement('tr')
    tr.innerHTML = `<td class="num">${ev.seq}</td><td class="num">${GOV.fmtTime(ev.time)}</td><td class="etype">${GOV.escape(ev.type)}</td><td>${GOV.escape(summary)}</td>`
    tbody.appendChild(tr)
    while (tbody.rows.length > 2000) tbody.deleteRow(0)
    if ($('chkTrailAuto').checked) {
      const sc = $('trailScroll')
      sc.scrollTop = sc.scrollHeight
    }
  }

  function clearTrail () {
    const tbody = $('trailTable').querySelector('tbody')
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#999">流水已清空</td></tr>'
  }

  /* ================= 首页渲染（参照政务网站首页：头条/三栏列表/运行数据） ================= */
  const HOME_NOTICES = [
    ['2026-08-19', '关于平台运行管理规范（试行）发布施行的通知'],
    ['2026-08-18', '关于开展第三季度模型推理能力与沙箱安全标准自查的通知'],
    ['2026-08-15', '关于开通会话卷宗在线导出通道的公告'],
    ['2026-08-12', '关于独立办事大厅（端口 3081）上线试运行的公告'],
    ['2026-08-08', '关于进一步加强 Agent 工具调用全程留痕的通知'],
    ['2026-08-01', '关于公布平台服务监督投诉渠道的公告'],
  ]
  const HOME_GUIDES = [
    ['发起申报', '在业务大厅填写申报需求，选择模型、模式与权限后提交办理'],
    ['查阅卷宗', '在电子卷宗按标题检索、查阅历史会话并导出完整日志'],
    ['督办流水', '在督办流水实时查看轨迹事件与工具调用记录'],
    ['参数配置', '在参数配置中调整界面主题、弹窗、跑马灯与运行参数'],
    ['政策法规', '查阅平台运行管理规范与使用须知'],
    ['故障申诉', '通过故障申诉直通车反馈运行问题'],
  ]

  function renderHome () {
    // 通知公告（点击 → 独立通知正文页）
    const noticeBox = $('homeNoticeList')
    if (noticeBox) {
      noticeBox.innerHTML = HOME_NOTICES.map(([d, t], i) =>
        `<li><span class="date">${d}</span><a data-notice="${i}">${GOV.escape(t)}</a></li>`).join('')
    }
    // 办事指南（点击 → 跳转对应功能页）
    const guideBox = $('homeGuideList')
    if (guideBox) {
      const tabs = { 发起申报: 'hall', 查阅卷宗: 'volume', 督办流水: 'trail', 参数配置: 'config', 政策法规: 'policy', 故障申诉: '' }
      guideBox.innerHTML = HOME_GUIDES.map(([t, d]) => {
        const target = tabs[t]
        return `<li><span class="date">指南</span><a ${target ? `data-goto="${target}"` : 'data-act="feedback"'}>${GOV.escape(t)}：${GOV.escape(d)}</a></li>`
      }).join('')
    }
    bindHomeListEvents()
    // 运行数据（真实）
    const set = (id, v) => { const el = $(id); if (el) el.textContent = v }
    set('hdSessions', String(S.sessions?.length ?? '—'))
    const groups = S.modelCatalog?.groups ?? S.globalModelGroups ?? []
    const modelCount = groups.reduce((n, g) => n + (g.models?.length ?? 0), 0)
    set('hdModels', modelCount ? `${groups.length} 家提供商 / ${modelCount} 个模型` : '加载中…')
    set('hdPresets', S.presets?.length ? `${S.presets.length} 种（${S.presets.map(p => p.name ?? p.id).slice(0, 3).join('、')}${S.presets.length > 3 ? '等' : ''}）` : '加载中…')
    set('hdPermissions', S.permissionPresets?.length ? `${S.permissionPresets.length} 档权限预设` : '加载中…')
    set('hdGateway', S.hostStatus?.apiProxy === true ? '已接入' : (S.hostStatus?.apiProxy === false ? '桥接降级' : '检测中'))
    // 首页标题联动配置文案
    const t = GOVConfig.load().texts
    set('homeHeadline', `${t.title} 正式上线运行`)
    set('homeMemo', `平台面向全部受理窗口开放独立政务办事大厅，全面接入模型推理、沙箱权限、会话卷宗与督办流水等智能化办事能力，实现“${t.subtitle}“的服务目标。`)
    set('bannerTitle', t.title)
    set('bannerSub', t.subtitle)
  }

  /** 首页列表事件委托：通知详情 + 指南跳转 */
  function bindHomeListEvents () {
    const noticeBox = $('homeNoticeList')
    if (noticeBox && !noticeBox.__bound) {
      noticeBox.__bound = true
      noticeBox.addEventListener('click', e => {
        const a = e.target.closest('a[data-notice]')
        if (!a) return
        showNoticeDetail(Number(a.dataset.notice))
      })
    }
    const guideBox = $('homeGuideList')
    if (guideBox && !guideBox.__bound) {
      guideBox.__bound = true
      guideBox.addEventListener('click', e => {
        const a = e.target.closest('a')
        if (!a) return
        if (a.dataset.goto) switchTab(a.dataset.goto)
        else if (a.dataset.act === 'feedback') showFeedback()
      })
    }
  }

  /** 通知详情独立页面 */
  function showNoticeDetail (index) {
    const [date, title] = HOME_NOTICES[index] ?? ['', '（无内容）']
    $('noticePageTitle').textContent = title
    $('noticePageMeta').textContent = `发布日期：${date}　来源：平台运行管理中心　字号：[大] [中] [小]`
    $('noticePageContent').innerHTML = `
      <p>各受理窗口、运行班组：</p>
      <p>为进一步规范平台运行管理，保障模型推理、沙箱权限、会话卷宗及工具调用等业务稳定有序运行，现将有关事项通知如下，请遵照执行。</p>
      <p>一、各受理窗口应严格按照平台运行管理规范办理业务，使用宿主动态提供的模型、模式与权限能力，不得以普通会话消息代替系统权限设置。</p>
      <p>二、办理过程应全程留痕。重要会话应及时通过电子卷宗查阅、续办或导出，涉及工具调用的事项应在督办流水中核验事件记录。</p>
      <p>三、本通知所述要求自发布之日起施行。各受理窗口应及时组织学习并落实到位，如有疑问请联系平台运行管理中心。</p>`
    $('noticePageDate').textContent = date
    switchTab('notice')
  }

  async function updateHome () {
    // 若权限默认值尚未读取，补一次 describe
    if (!S.permissionState) {
      const res = await DSHApi.settings.describe({})
      if (res.ok) {
        const pns = res.value.namespaces.find(n => n.ns === 'permission')
        const def = pns?.value?.defaultPreset
        if (def) S.permissionDefault = def
      }
    }
    renderHome()
  }

  /* ================= 配置面板动作 ================= */
  function bindConfigActions () {
    // 主题按钮（事件委托在每次构建时绑定）
    document.querySelectorAll('.theme-swatch').forEach(b => {
      b.addEventListener('click', () => {
        GOVConfig.set('theme', b.dataset.theme)
        GOVPanels.refreshConfigValues()
        applyVisual()
      })
    })
    // 自定义色 → 自动切自定义主题
    ;['primary', 'deep', 'navEnd', 'borderStrong', 'red'].forEach(k => {
      const el = document.querySelector(`#configPanel [data-bind="customColors.${k}"]`)
      el?.addEventListener('input', () => {
        GOVConfig.set('theme', 'custom')
        GOVPanels.refreshConfigValues()
        applyVisual()
      })
    })
    // 徽标上传
    $('btnSealUpload')?.addEventListener('click', () => $('sealUpload').click())
    $('sealUpload')?.addEventListener('change', e => {
      const file = e.target.files?.[0]
      if (!file) return
      const reader = new FileReader()
      reader.onload = () => {
        GOVConfig.set('seal.customUrl', reader.result)
        GOVConfig.set('seal.style', 'custom')
        GOVPanels.refreshConfigValues()
        applyVisual()
      }
      reader.readAsDataURL(file)
    })
    // 端口保存（写入插件配置，提示重启）
    $('btnSavePort')?.addEventListener('click', async () => {
      const port = Number($('configPanel [data-bind="agent.port"]')?.value)
      if (!Number.isInteger(port) || port < 1 || port > 65535) { alert('端口必须是 1-65535 的整数'); return }
      const resp = await fetch('/plugin/config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      })
      const data = await resp.json().catch(() => ({}))
      if (resp.ok) {
        $('portSaveTip').classList.add('show')
        setTimeout(() => $('portSaveTip').classList.remove('show'), 4000)
        if (data.note) addTrajectoryLine(data.note)
      } else {
        alert(`写入失败：${data.error ?? resp.status}`)
      }
    })
    // 保存全部（含 DSH 原生设置）
    $('btnConfigSave')?.addEventListener('click', async () => {
      GOVPanels.collectForm()
      applyVisual()
      GOVMarquee.rebuild()
      GOVFloat.rebuild()
      const results = await GOVPanels.saveDshSettings()
      const tip = $('configSavedTip')
      tip.textContent = '✓ 已保存' + (results.length ? `（宿主设置：${results.map(r => `${r.ns} ${r.ok ? '成功' : '失败'}`).join('、')}）` : '')
      tip.classList.add('show')
      setTimeout(() => tip.classList.remove('show'), 5000)
      await loadPermissionPresets()
      void loadModels()
    })
    $('btnConfigExport')?.addEventListener('click', () => GOVConfig.exportJson())
    $('btnConfigImport')?.addEventListener('click', () => $('configImportFile').click())
    $('configImportFile')?.addEventListener('change', e => {
      const file = e.target.files?.[0]
      if (!file) return
      const reader = new FileReader()
      reader.onload = () => {
        try {
          GOVConfig.importJson(String(reader.result))
          applyVisual()
          GOVMarquee.rebuild()
          GOVFloat.rebuild()
          GOVPanels.buildConfigPanel()
          alert('配置导入成功，已即时生效。')
        } catch (err) {
          alert(`导入失败：${err.message}`)
        }
      }
      reader.readAsText(file)
      e.target.value = ''
    })
    $('btnConfigReset')?.addEventListener('click', () => {
      if (!confirm('确定恢复出厂设置？当前全部自定义配置将被清除。')) return
      GOVConfig.factoryReset()
      applyVisual()
      GOVMarquee.rebuild()
      GOVFloat.rebuild()
      GOVPanels.buildConfigPanel()
      alert('已恢复出厂设置。')
    })
  }

  /* ================= 配置面板构建（面板 + 操作栏 + DSH 设置） ================= */
  function buildConfigPanelWithActions () {
    GOVPanels.buildConfigPanel()
    // 在面板末尾追加操作栏
    const panel = $('configPanel')
    const bar = document.createElement('div')
    bar.className = 'config-actions'
    bar.innerHTML = `
      <button class="gov-btn" id="btnConfigSave">保存当前配置</button>
      <button class="gov-btn gray" id="btnConfigExport">导出为 JSON 卷宗</button>
      <button class="gov-btn gray" id="btnConfigImport">导入配置</button>
      <input type="file" id="configImportFile" accept="application/json,.json" style="display:none">
      <button class="gov-btn red" id="btnConfigReset">恢复出厂设置</button>
      <span class="config-saved-tip" id="configSavedTip">✓ 已保存</span>
      <span class="tip">配置存储于浏览器本地（键 dsh.govPortal.v1）· 宿主设置提交至 settings.yaml</span>`
    panel.appendChild(bar)
    bindConfigActions()
    GOVPanels.buildDshSettings()
  }

  /* ================= 对外接口 ================= */
  global.GOVApp = {
    init,
    applyVisual,
    switchTab,
    state: S,
  }

  // 初始化
  document.addEventListener('DOMContentLoaded', () => {
    init()
  })
})(window)
