/* ====================================================================
 * panels.js — 参数配置面板（政务表格式表单）+ 政策法规页 +
 * DSH 原生系统设置（settings.describe 值驱动通用表单，1:1 调整
 * 原版 DeepSeek Harness 的全部配置能力）。
 * ==================================================================== */
(function (global) {
  'use strict'

  /* ================= 参数配置面板 ================= */

  function row (name, hint, ctrlHtml) {
    return `<tr><td class="cfg-name">${name}${hint ? `<span class="hint">${hint}</span>` : ''}</td><td class="cfg-ctrl">${ctrlHtml}</td></tr>`
  }
  function textInput (path, extra = '') {
    return `<input type="text" data-bind="${path}" ${extra}>`
  }
  function numInput (path, extra = '') {
    return `<input type="number" data-bind="${path}" ${extra}>`
  }
  function colorInput (path) {
    return `<input type="color" data-bind="${path}" value="#1879d2">`
  }
  function selectInput (path, options) {
    return `<select class="gov-select" data-bind="${path}">${options.map(o => `<option value="${o[0]}">${o[1]}</option>`).join('')}</select>`
  }
  function switchInput (path) {
    return `<label class="switch"><input type="checkbox" data-bind="${path}"><span class="slider"></span></label>`
  }
  function sectionTitle (text, sub) {
    return `<div class="config-section"><div class="cs-title">${text}${sub ? `<span style="font-size:12px;color:#888;margin-left:10px;font-weight:normal">${sub}</span>` : ''}</div><table class="gov-table config-table"><tbody>`
  }
  function sectionEnd () {
    return '</tbody></table></div>'
  }

  function buildConfigPanel () {
    const html = `
    ${sectionTitle('一、漂浮弹窗与公告控制', 'DVD 反弹弹窗 · 开关 / 速度 / 初始坐标 / 内容自定义')}
      ${row('红头重要通知弹窗', '开启后在整个视口内匀速碰撞反弹移动', switchInput('floatNotice.enabled'))}
      ${row('矩阵二维码弹窗', '同上', switchInput('floatQr.enabled'))}
      ${row('通知弹窗运动速度', '', selectInput('floatNotice.speed', [['slow', '极慢'], ['standard', '标准'], ['fast', '极速']]))}
      ${row('二维码弹窗运动速度', '', selectInput('floatQr.speed', [['slow', '极慢'], ['standard', '标准'], ['fast', '极速']]))}
      ${row('通知弹窗初始坐标 X / Y', '像素，越界自动钳制', `<span class="pair">${numInput('floatNotice.x', 'style="width:90px"')} ${numInput('floatNotice.y', 'style="width:90px"')}</span>`)}
      ${row('二维码弹窗初始坐标 X / Y', '像素', `<span class="pair">${numInput('floatQr.x', 'style="width:90px"')} ${numInput('floatQr.y', 'style="width:90px"')}</span>`)}
      ${row('鼠标悬停暂停移动', '两弹窗共用；关闭后悬停不暂停', switchInput('floatNotice.hoverPause'))}
      ${row('通知弹窗自定义图片', '设置后图片铺满整个弹窗（关闭叉在图片右上角）；留空使用内置红头文字样式', `<span class="pair">${textInput('floatNotice.image')}<button class="gov-btn small gray" data-upload="floatNotice.image">上传图片</button></span>`)}
      ${row('通知弹窗图片宽度', '像素', numInput('floatNotice.imageWidth', 'style="width:110px"'))}
      ${row('二维码弹窗自定义图片', '设置后图片铺满整个弹窗；留空使用内置二维码矩阵样式', `<span class="pair">${textInput('floatQr.image')}<button class="gov-btn small gray" data-upload="floatQr.image">上传图片</button></span>`)}
      ${row('二维码弹窗图片宽度', '像素', numInput('floatQr.imageWidth', 'style="width:110px"'))}
      ${row('通知标题（内置样式）', '', textInput('floatNotice.title'))}
      ${row('通报正文（内置样式）', '', `<textarea data-bind="floatNotice.body"></textarea>`)}
      ${row('跳转链接（内置样式）', '', textInput('floatNotice.link'))}
      ${row('跳转链接文字（内置样式）', '', textInput('floatNotice.linkText'))}
      ${row('二维码 1 图片地址（内置样式）', '留空使用内置假二维码矩阵', textInput('floatQr.qr1Url'))}
      ${row('二维码 1 标注文本', '', textInput('floatQr.qr1Label'))}
      ${row('二维码 2 图片地址（内置样式）', '', textInput('floatQr.qr2Url'))}
      ${row('二维码 2 标注文本', '', textInput('floatQr.qr2Label'))}
      ${row('二维码说明文字', '', textInput('floatQr.note'))}
    ${sectionEnd()}

    ${sectionTitle('二、跑马灯与滚动条配置', '重要通知独占整行 · 速度 / 方向 / 文字')}
      ${row('重要通知通道', '独占整行滚动显示', switchInput('marquee.noticeEnabled'))}
      ${row('滚动速度', '', selectInput('marquee.speed', [['slow', '极慢'], ['standard', '标准'], ['fast', '极速']]))}
      ${row('通知滚动方向', '', selectInput('marquee.noticeDirection', [['left', '向左'], ['right', '向右']]))}
      ${row('通知文字内容', '用【】分段，每段自动拆分为一条', `<textarea data-bind="marquee.noticeText"></textarea>`)}
    ${sectionEnd()}

    ${sectionTitle('三、界面视觉与个性化风格', '主题色系一键切换 / 自定义主色 / 单位落款与文案 / 徽标')}
      ${row('政务主题色系', '', `<div class="theme-swatches" id="themeSwatches">
        <button class="theme-swatch" data-theme="classic-blue">经典政务蓝（默认）</button>
        <button class="theme-swatch" data-theme="party-red">党政中国红</button>
        <button class="theme-swatch" data-theme="eco-green">生态履职绿</button>
        <button class="theme-swatch" data-theme="industry-gray">工业监管灰</button>
      </div>
      <div style="margin-top:6px;font-size:12px;color:#888">选择自定义颜色后自动切换为「自定义」色系</div>`)}
      ${row('自定义全站主色调', '导航/按钮/强调色', colorInput('customColors.primary'))}
      ${row('自定义深色 / 标题色', '', colorInput('customColors.deep'))}
      ${row('导航渐变底色（末端）', '导航渐变由主色渐变至该色', colorInput('customColors.navEnd'))}
      ${row('主要公文边框颜色', '页首/页脚结构线', colorInput('customColors.borderStrong'))}
      ${row('主题红', '印章/通知/警示', colorInput('customColors.red'))}
      ${row('顶部红字标语', '默认：欢迎访问Deepseek Harness平台！', textInput('texts.slogan'))}
      ${row('平台主标题', '', textInput('texts.title'))}
      ${row('平台副标题', '', textInput('texts.subtitle'))}
      ${row('标题左侧图标 / 公章', '默认空白；可选择预设印章或上传本地图片', `<span class="pair">
        ${selectInput('seal.style', [['none', '无（空白，默认）'], ['red', '红章'], ['blue', '蓝章'], ['green', '绿章'], ['gold', '金章'], ['custom', '自定义图片']])}
        <input type="file" id="sealUpload" accept="image/*" style="display:none">
        <button class="gov-btn small gray" id="btnSealUpload">上传本地图片</button>
        <img id="sealPreview" style="height:34px;display:none">
      </span>`)}
      ${row('印章文字', '办结盖章显示', textInput('texts.stampText'))}
      ${row('页脚·主办单位', '', textInput('texts.footerOrg'))}
      ${row('页脚·技术支持', '', textInput('texts.footerTech'))}
      ${row('页脚·备案号文本', '', textInput('texts.footerBeian'))}
    ${sectionEnd()}

    ${sectionTitle('四、Agent 运行与通信配置', '端口 / 连接 / 工单 / 模型参数 / 权限等级')}
      ${row('本插件运行服务端口', '默认 3081；修改后需重启插件生效', `<span class="pair">${numInput('agent.port', 'style="width:90px"')}<button class="gov-btn small gray" id="btnSavePort">写入插件配置</button><span id="portSaveTip" class="config-saved-tip">已保存（重启后生效）</span></span>`)}
      ${row('连接地址', '留空 = 使用本插件内置事件桥（推荐，与宿主网关同进程）', textInput('agent.wsUrl'))}
      ${row('重连间隔（毫秒）', '', numInput('agent.wsRetryMs', 'style="width:110px"'))}
      ${row('默认工单前缀', '支持年月日占位符', textInput('agent.ticketPrefix'))}
      ${row('默认模型（提供商 / 编号）', '留空 = 跟随会话当前选择；将覆盖业务大厅下拉初值', `<span class="pair">${textInput('agent.defaultProvider', 'style="width:160px" placeholder="提供商"')} ${textInput('agent.defaultModel', 'style="width:240px" placeholder="模型编号"')}</span>`)}
      ${row('默认推理强度', '留空 = 适配器默认', textInput('agent.defaultEffort'))}
      ${row('上下文轮数限制', '0 = 不限制（提示系统压缩策略）', numInput('agent.contextTurns', 'style="width:110px"'))}
      ${row('采样温度', '留空 = 不干预（使用宿主默认）', textInput('agent.temperature'))}
      ${row('沙箱执行权限确认等级', '权限在新建工单时按所选预设生效（写入宿主新会话默认，不消耗模型额度）；全自动执行 → 全访问免审批；弹窗逐项审批 → 工作区可写+逐项审批', selectInput('agent.approvalLevel', [['preset', '跟随权限预设（推荐）'], ['auto', '全自动执行'], ['confirm', '弹窗逐项审批']]))}
      ${row('办结自动盖章动画', '流式输出结束时盖【准予办结】半透明印章', switchInput('agent.stampOnFinish'))}
      ${row('回执窗口自动滚动', '', switchInput('agent.autoScroll'))}
      ${row('页面白屏加载过渡', '点击按钮或页面导航时短暂显示白屏；关闭后立即切换', switchInput('misc.pageLoadingEnabled'))}
    ${sectionEnd()}

    ${sectionTitle('五、宿主原生系统参数', '动态读取宿主设置描述 → 可调整原版 DeepSeek Harness 的全部配置（模型/凭据/沙箱等）')}
      ${row('', '', `<div id="dshSettingsBox"><span style="color:#999">正在读取宿主设置描述…</span></div>`)}
    ${sectionEnd()}
    `
    document.getElementById('configPanel').innerHTML = html
    bindImageUploads()
    refreshConfigValues()
  }

  /* —— 弹窗图片上传（FileReader → dataURL 写入配置） —— */
  function bindImageUploads () {
    document.querySelectorAll('#configPanel [data-upload]').forEach(btn => {
      btn.addEventListener('click', () => {
        const path = btn.dataset.upload
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = 'image/*'
        input.addEventListener('change', () => {
          const file = input.files?.[0]
          if (!file) return
          const reader = new FileReader()
          reader.onload = () => {
            GOVConfig.set(path, reader.result)
            refreshConfigValues()
            global.GOVFloat?.rebuild?.()
          }
          reader.readAsDataURL(file)
        })
        input.click()
      })
    })
  }

  /* —— 读取 store 回填表单 —— */
  function refreshConfigValues () {
    const bind = path => {
      const v = GOVConfig.get(path)
      if (v === undefined || v === null) return ''
      return String(v)
    }
    document.querySelectorAll('#configPanel [data-bind]').forEach(el => {
      const path = el.dataset.bind
      if (el.type === 'checkbox') el.checked = Boolean(GOVConfig.get(path))
      else el.value = bind(path)
    })
    const theme = GOVConfig.get('theme')
    document.querySelectorAll('.theme-swatch').forEach(b => b.classList.toggle('active', b.dataset.theme === theme))
    const sealStyle = GOVConfig.get('seal.style')
    const img = document.getElementById('sealPreview')
    const customUrl = GOVConfig.get('seal.customUrl')
    if (sealStyle === 'custom' && customUrl) {
      img.src = customUrl
      img.style.display = ''
    } else {
      img.style.display = 'none'
    }
  }

  /* —— 收集表单写入 store（返回 config） —— */
  function collectForm () {
    document.querySelectorAll('#configPanel [data-bind]').forEach(el => {
      const path = el.dataset.bind
      if (el.type === 'checkbox') GOVConfig.set(path, el.checked)
      else if (el.type === 'number') GOVConfig.set(path, Number(el.value))
      else GOVConfig.set(path, el.value)
    })
    // 自定义色 → 自动切自定义主题
    const cfg = GOVConfig.load()
    if (cfg.theme !== 'custom') {
      // 主题保持预设；仅当用户直接改色时切换
    }
    return cfg
  }

  /* ================= DSH 原生设置（schema 驱动通用表单） ================= */

  /**
   * schemastery toJSON 信封：{uid, refs:{id:node}}。
   * node：{type, meta:{description,default,role}, value(const), list(union), dict(object), inner(array/dict), sKey(dict)}
   */
  function buildDshSettings () {
    const box = document.getElementById('dshSettingsBox')
    if (!box) return
    void (async () => {
      const res = await DSHApi.settings.describe({})
      if (!res.ok) {
        box.innerHTML = `<span style="color:#c00101">读取失败：${GOV.escape(res.error?.message ?? '')}</span>`
        return
      }
      const { writable, namespaces } = res.value
      if (!namespaces?.length) {
        box.innerHTML = '<span style="color:#999">宿主未注册任何设置命名空间</span>'
        return
      }
      box.innerHTML = ''
      const hint = document.createElement('div')
      hint.style.cssText = 'font-size:12px;color:#888;margin-bottom:8px'
      hint.textContent = `${writable ? '配置可写' : '配置只读'} · 共 ${namespaces.length} 个命名空间 · 修改后点击下方【保存当前配置】一并提交到宿主 settings.yaml`
      box.appendChild(hint)

      for (const ns of namespaces) {
        const section = document.createElement('div')
        section.style.cssText = 'border:1px solid #ddd;margin-bottom:10px'
        const head = document.createElement('div')
        head.style.cssText = 'background:#f7f9fb;padding:6px 10px;font-weight:bold;font-size:13px;display:flex;justify-content:space-between'
        head.innerHTML = `<span>${GOV.escape(ns.ns)}</span><span style="font-weight:normal;color:#888;font-size:12px">生效：${ns.applies === 'live' ? '即时' : '重启后'} · 修订 ${ns.revision}</span>`
        const body = document.createElement('div')
        body.style.cssText = 'padding:8px 10px'
        section.appendChild(head)
        section.appendChild(body)
        box.appendChild(section)

        const env = { ns: ns.ns, refs: ns.schema?.refs ?? {}, secrets: ns.secrets ?? [] }
        const root = env.refs[ns.schema?.uid] ?? fallbackNode(ns.value)
        renderSchemaNode(root, ns.value, [], body, env, 0)
      }

      // 变更记录（委托；ns → patch 树），由【保存当前配置】统一提交
      box.addEventListener('input', e => recordDshEdit(e.target))
      box.addEventListener('change', e => recordDshEdit(e.target))
    })()
  }

  function recordDshEdit (t) {
    if (!t?.dataset?.ns || !t?.dataset?.path) return
    const path = t.dataset.path.split('.').filter(Boolean)
    if (!path.length) return
    let val
    switch (t.dataset.kind) {
      case 'number': val = Number(t.value); break
      case 'boolean': val = t.checked; break
      case 'string-list': val = t.value.split(',').map(s => s.trim()).filter(Boolean); break
      case 'json':
        try { val = JSON.parse(t.value) } catch { return } // JSON 不合法时不记录
        break
      default: val = t.value
    }
    let root = dshSettingsEdits[t.dataset.ns]
    if (!root) root = dshSettingsEdits[t.dataset.ns] = {}
    let o = root
    for (let i = 0; i < path.length - 1; i++) {
      if (o[path[i]] == null || typeof o[path[i]] !== 'object') o[path[i]] = {}
      o = o[path[i]]
    }
    o[path[path.length - 1]] = val
  }

  function fallbackNode (value) {
    if (value === null || value === undefined) return { type: 'any' }
    const t = Array.isArray(value) ? 'array' : typeof value
    return { type: t === 'array' ? 'any' : t }
  }

  function resolveNode (refs, idOrNode) {
    if (typeof idOrNode === 'number') return refs[idOrNode] ?? { type: 'any' }
    return idOrNode ?? { type: 'any' }
  }

  function renderSchemaNode (node, value, path, container, env, depth) {
    const n = resolveNode(env.refs, node)
    const hint = n.meta?.description
    const name = path[path.length - 1] ?? '(root)'
    const secret = (env.secrets ?? []).some(s => s.path.join('.') === path.join('.'))
    const wrap = (inner, labelHtml) => {
      const div = document.createElement('div')
      div.style.cssText = `display:flex;align-items:flex-start;gap:8px;margin:3px 0;font-size:13px;${depth === 0 ? 'flex-wrap:wrap' : ''}`
      div.innerHTML = labelHtml ?? `<span style="min-width:180px;color:#555;flex:none">${secret ? '🔒 ' : ''}${GOV.escape(name)}${hint ? `<br><small style="color:#999;font-weight:normal">${GOV.escape(hint)}</small>` : ''}</span>`
      if (typeof inner === 'string') div.insertAdjacentHTML('beforeend', inner)
      else div.appendChild(inner)
      container.appendChild(div)
    }

    switch (n.type) {
      case 'object': {
        const sub = document.createElement('div')
        sub.style.cssText = 'flex:1;border-left:3px solid #c8d9ee;padding-left:8px;margin:2px 0'
        const dict = n.dict ?? {}
        const keys = Object.keys(dict)
        if (keys.length === 0) sub.innerHTML = '<span style="color:#999">（空对象）</span>'
        for (const k of keys) {
          renderSchemaNode(dict[k], value?.[k], [...path, k], sub, env, depth + 1)
        }
        wrap(sub)
        break
      }
      case 'union': {
        const list = (n.list ?? []).map(id => resolveNode(env.refs, id))
        if (list.length && list.every(x => x.type === 'const')) {
          const opts = list.map(x => [x.value, x.meta?.description || x.value])
          const cur = value ?? ''
          wrap(`<select class="gov-select" style="width:280px;max-width:100%" data-ns="${env.ns}" data-path="${path.join('.')}" data-kind="string">${opts.map(o => `<option value="${GOV.escape(o[0])}" ${String(o[0]) === String(cur) ? 'selected' : ''}>${GOV.escape(o[1])}</option>`).join('')}</select>`)
        } else {
          wrap(jsonEditor(env, path, value))
        }
        break
      }
      case 'const':
        wrap(`<span style="color:#666">${GOV.escape(String(n.value))}${hint ? `（${GOV.escape(hint)}）` : ''}</span>`)
        break
      case 'string':
        wrap(`<input type="${secret ? 'password' : 'text'}" style="border:1px solid #999;padding:4px 6px;width:320px;max-width:100%" value="${GOV.escape(secret ? '' : (value ?? ''))}" placeholder="${secret ? '（密钥已配置，留空保持不变）' : (n.meta?.default !== undefined ? `默认: ${GOV.escape(String(n.meta.default))}` : '')}" data-ns="${env.ns}" data-path="${path.join('.')}" data-kind="string">`)
        break
      case 'number':
        wrap(`<input type="number" style="border:1px solid #999;padding:4px 6px;width:160px" value="${value ?? ''}" placeholder="${n.meta?.default !== undefined ? `默认: ${n.meta.default}` : ''}" data-ns="${env.ns}" data-path="${path.join('.')}" data-kind="number">`)
        break
      case 'boolean':
        wrap(`<label class="switch"><input type="checkbox" ${value ? 'checked' : ''} data-ns="${env.ns}" data-path="${path.join('.')}" data-kind="boolean"><span class="slider"></span></label>`)
        break
      case 'array': {
        const inner = resolveNode(env.refs, n.inner)
        if (inner.type === 'string' || inner.type === 'number' || inner.type === 'const' || inner.type === 'union') {
          const asText = (value ?? []).map(v => typeof v === 'string' ? v : String(v)).join(', ')
          wrap(`<input type="text" style="border:1px solid #999;padding:4px 6px;width:420px;max-width:100%" value="${GOV.escape(asText)}" placeholder="以英文逗号分隔" data-ns="${env.ns}" data-path="${path.join('.')}" data-kind="string-list">`)
        } else {
          const sub = document.createElement('div')
          sub.style.cssText = 'flex:1'
          const items = Array.isArray(value) ? value : []
          items.forEach((item, i) => {
            const cell = document.createElement('div')
            cell.style.cssText = 'border:1px dashed #ddd;padding:6px;margin:4px 0'
            renderSchemaNode(inner, item, [...path, i], cell, env, depth + 1)
            sub.appendChild(cell)
          })
          if (items.length === 0) sub.innerHTML = '<span style="color:#999">（空数组）</span>'
          wrap(sub)
        }
        break
      }
      case 'dict':
      case 'any':
      case 'intersect':
      default:
        wrap(jsonEditor(env, path, value))
        break
    }
  }

  function jsonEditor (env, path, value) {
    const text = value === undefined || value === null ? '' : JSON.stringify(value, null, 1)
    return `<textarea style="border:1px solid #999;padding:4px 6px;width:420px;max-width:100%;min-height:60px;font-family:Consolas,monospace;font-size:12px" data-ns="${env.ns}" data-path="${path.join('.')}" data-kind="json" placeholder="JSON">${GOV.escape(text)}</textarea>`
  }

  const dshSettingsEdits = {}

  function label (text, color) {
    const s = document.createElement('span')
    s.textContent = text
    s.style.color = color || '#999'
    s.style.fontSize = '13px'
    return s
  }
  function checkbox (checked, path) {
    return `<label class="switch"><input type="checkbox" ${checked ? 'checked' : ''}></label>`
  }
  function field (path, inner, icon = '') {
    const div = document.createElement('div')
    div.style.cssText = 'display:flex;align-items:center;gap:8px;margin:3px 0;font-size:13px'
    div.innerHTML = `<span style="min-width:180px;color:#555">${icon}${GOV.escape(path[path.length - 1] ?? '')}</span>${typeof inner === 'string' ? inner : ''}`
    if (typeof inner !== 'string') div.appendChild(inner)
    return div
  }

  /** 把编辑记录提交到宿主 settings（每个 ns 一次 settings.update） */
  async function saveDshSettings () {
    const entries = Object.entries(dshSettingsEdits)
    if (!entries.length) return []
    const results = []
    for (const [ns, patch] of entries) {
      const desc = await DSHApi.settings.describe({})
      const view = desc.ok ? desc.value.namespaces.find(n => n.ns === ns) : undefined
      const res = await DSHApi.settings.update({ ns, patch, expectedRevision: view?.revision })
      results.push({ ns, ok: res.ok, message: res.ok ? '已保存' : (res.error?.message ?? '失败') })
      if (res.ok) delete dshSettingsEdits[ns]
    }
    return results
  }

  /* ================= 政策法规页 ================= */

  function buildPolicyPage () {
    const items = [
      ['第一条', '本平台（Deepseek Harness 综合智能办事平台）为 DeepSeek Harness 的独立政务办事窗口，运行于专用端口（默认 3081），与主控台（默认 3080）同进程联动，共享同一套会话、模型、权限与统计能力。'],
      ['第二条', '平台界面严格遵循政务网站视觉规范：1px 实线边框、直角块面、宋体/黑体公文排版、经典深蓝渐变导航，全面参照中国政府网、地方门户网站等公开样例的设计基准。'],
      ['第三条', '所有 Agent 能力均通过宿主 apiProxy 网关 1:1 调用，平台不伪造、不截留任何模型输出；模型目录、权限预设、Agent 模式、推理强度均由宿主运行时动态枚举。'],
      ['第四条', '沙箱执行权限按预设分级管理：workspace-write（工作区可写，越权重试需审批）与 danger-full-access（全访问免审批）等；审批事项在办事大厅弹窗逐项办理。'],
      ['第五条', '会话事件全程留痕：轮次、步数、工具调用、token 消耗、缓存命中率等指标实时展示于回执窗口下方统计栏，并可在【电子卷宗】导出完整 JSONL 日志。'],
      ['第六条', '本平台参数配置存储于浏览器 LocalStorage（键 dsh.govPortal.v1）与插件配置文件（~/.dsh/gov-portal.json），支持导出/导入 JSON 卷宗与恢复出厂设置。'],
      ['第七条', '本规范自发布之日起施行，由平台运行管理中心负责解释。'],
    ]
    const html = items.map(([no, text]) =>
      `<div style="margin-bottom:14px;line-height:2"><b style="color:var(--gov-blue-deep)">${no}</b>　${GOV.escape(text)}</div>`).join('')
    document.getElementById('policyBody').innerHTML = html
  }

  global.GOVPanels = {
    buildConfigPanel,
    refreshConfigValues,
    collectForm,
    buildDshSettings,
    saveDshSettings,
    buildPolicyPage,
  }
})(window)
