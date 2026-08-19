/* ====================================================================
 * store.js — 平台配置中心：全部可配置维度（LocalStorage 持久化），
 * 支持导出为 JSON 卷宗 / 导入 / 恢复出厂设置。
 * 键：dsh.govPortal.v1
 * ==================================================================== */
(function (global) {
  'use strict'

  const KEY = 'dsh.govPortal.v1'

  const DEFAULTS = {
    /* —— 一、漂浮弹窗与公告控制（支持自定义图片铺满弹窗） —— */
    floatNotice: {
      enabled: true,               // 红头重要通知弹窗开关
      speed: 'standard',           // 极慢 slow / 标准 standard / 极速 fast
      x: 120,                      // 初始 X（px）
      y: 320,                      // 初始 Y（px）
      hoverPause: true,            // 鼠标悬停暂停
      image: '',                   // 自定义图片（dataURL/URL）：设置后图片铺满整个弹窗，右上角为关闭叉
      imageWidth: 360,             // 图片模式弹窗宽度（px）
      title: '关于落实2026年第三季度Agent自主调度规范与大模型安全准则的通报',
      body: '各受理窗口、运行班组：为进一步规范 Agent 自主调度行为，落实大模型安全准则，现将第三季度执行要求通报如下：一、严格执行沙箱权限分级管理；二、工具调用全程留痕；三、模型推理参数按工单配置执行。请遵照执行。',
      link: 'http://127.0.0.1:3081/',
      linkText: '点击查阅详情 >>',
    },
    floatQr: {
      enabled: true,               // 矩阵二维码弹窗开关
      speed: 'standard',
      x: 880,
      y: 300,
      hoverPause: true,
      image: '',                   // 自定义图片（dataURL/URL）：设置后图片铺满整个弹窗，右上角为关闭叉
      imageWidth: 340,             // 图片模式弹窗宽度（px）
      qr1Url: '',                  // 留空 = 内置假二维码矩阵；填 URL 则用图片
      qr1Label: '公众号',
      qr2Url: '',
      qr2Label: '客户端',
      note: '扫码关注平台官方公众号与客户端，获取最新办事指南',
    },

    /* —— 二、跑马灯与滚动条 —— */
    marquee: {
      noticeEnabled: true,
      quoteEnabled: true,
      speed: 'standard',           // slow / standard / fast
      noticeDirection: 'left',     // left 向左 / right 向右
      noticeText: '【重要通知】 2026年第三季度模型推理能力与沙箱安全标准已全面上线，请各受理窗口按新标准执行；【通知】 平台新增独立政务办事大厅（端口 3081），与主控台无缝联动；【公告】 运行日志导出通道已开通，详见电子卷宗。',
      quoteDirection: 'right',     // 行情反向滚动
      quotes: [
        { label: 'DeepSeek API 价格', value: '0.55 元/百万输入 tokens', source: '' },
        { label: '英伟达 (NVDA)', value: '642.18', source: '' },
        { label: '纳斯达克指数', value: '45,286.32', source: '' },
        { label: '沪深 300', value: '5,412.66', source: '' },
        { label: '算力租赁指数', value: '1,284.55', source: '' },
      ],
    },

    /* —— 三、界面视觉与个性化 —— */
    theme: 'classic-blue',         // classic-blue 经典政务蓝 / party-red 党政中国红 / eco-green 生态履职绿 / industry-gray 工业监管灰 / custom 自定义
    customColors: {
      primary: '#1879d2',          // 全站主色调
      deep: '#015293',             // 深色/标题
      navEnd: '#0d47a1',           // Header/导航渐变底色（末端）
      borderStrong: '#2e5586',     // 主要公文边框颜色
      red: '#e4393c',              // 主题红
    },
    texts: {
      slogan: '欢迎访问Deepseek Harness平台！',
      title: 'Deepseek Harness 综合智能办事平台',
      subtitle: '至公至正 · 智能协同 · 自主运转',
      footerOrg: '主办单位：DeepSeek Harness 平台运行管理中心',
      footerTech: '技术支持：DeepSeek Harness 工程保障部',
      footerBeian: '赣ICP备00000000号-1　赣公网安备00000000000000号　政府网站标识码：3600000000',
      serviceTech: 'DeepSeek Harness 运行班组',
      stampText: '准予办结',
    },
    seal: {
      style: 'none',               // none 空白（默认）/ red / blue / green / gold / custom（custom 用 customUrl）—— 由用户在【参数配置】中选择
      customUrl: '',               // dataURL 或图片 URL
    },

    /* —— 四、Agent 运行与通信 —— */
    agent: {
      ticketPrefix: 'TASK-YYYYMMDD-',   // 默认工单前缀
      wsUrl: '',                        // WebSocket 连接地址（预留，默认走本插件 SSE 桥）
      wsRetryMs: 3000,                  // 重试间隔
      defaultProvider: '',              // 默认模型 provider（空 = 沿用会话当前）
      defaultModel: '',                 // 默认模型 ID
      defaultEffort: '',                // 默认推理强度
      contextTurns: 20,                 // 上下文轮数限制（0 = 不限制）
      temperature: '',                  // 采样温度（空 = 不干预）
      permissionPreset: 'workspace-write', // 权限预设（/permission 命令切换：workspace-write / danger-full-access 等，动态枚举）
      approvalLevel: 'preset',          // preset = 跟随权限预设 / auto = 全自动执行（danger-full-access）/ confirm = 弹窗逐项审批
      stampOnFinish: true,              // 办结自动盖【准予办结】印章动画
      autoScroll: true,                 // 回执自动滚动
    },

    /* —— 五、其他 —— */
    misc: {
      bigFont: false,                   // 无障碍大字号
      pageLoadingEnabled: true,         // 点击命令时显示短暂白屏加载过渡
      ticketSeq: 1,                     // 工单流水号
    },
  }

  /* 深合并（数组整体替换） */
  function deepMerge (base, patch) {
    const out = { ...base }
    for (const [k, v] of Object.entries(patch ?? {})) {
      if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
        out[k] = deepMerge(base[k], v)
      } else {
        out[k] = v
      }
    }
    return out
  }

  let cache = null

  function load () {
    if (cache) return cache
    try {
      const raw = localStorage.getItem(KEY)
      cache = raw ? deepMerge(JSON.parse(JSON.stringify(DEFAULTS)), JSON.parse(raw)) : JSON.parse(JSON.stringify(DEFAULTS))
    } catch {
      cache = JSON.parse(JSON.stringify(DEFAULTS))
    }
    return cache
  }

  function save (patch) {
    const cfg = load()
    if (patch) deepMerge(cfg, patch)
    try { localStorage.setItem(KEY, JSON.stringify(cfg)) } catch (e) { console.warn('[gov-portal] 配置保存失败：', e) }
    return cfg
  }

  function get (path) {
    const cfg = load()
    return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), cfg)
  }

  function set (path, value) {
    const cfg = load()
    const keys = path.split('.')
    let o = cfg
    for (let i = 0; i < keys.length - 1; i++) {
      if (o[keys[i]] == null || typeof o[keys[i]] !== 'object') o[keys[i]] = {}
      o = o[keys[i]]
    }
    o[keys[keys.length - 1]] = value
    save(cfg)
    return cfg
  }

  function exportJson () {
    const d = new Date()
    const pad = n => String(n).padStart(2, '0')
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
    const doc = {
      type: 'dsh-gov-portal-config',
      version: 1,
      exportedAt: new Date().toISOString(),
      config: JSON.parse(JSON.stringify(load())),
    }
    GOV.downloadText(`gov-portal-config-${stamp}.json`, JSON.stringify(doc, null, 2), 'application/json')
  }

  function importJson (text) {
    let doc
    try { doc = JSON.parse(text) } catch { throw new Error('JSON 卷宗格式错误：无法解析') }
    const cfg = doc?.config ?? doc
    if (!cfg || typeof cfg !== 'object') throw new Error('JSON 卷宗格式错误：缺少 config 对象')
    const next = deepMerge(JSON.parse(JSON.stringify(DEFAULTS)), cfg)
    cache = next
    save(next)
    return next
  }

  function factoryReset () {
    cache = JSON.parse(JSON.stringify(DEFAULTS))
    save(cache)
    return cache
  }

  global.GOVConfig = { KEY, DEFAULTS, load, save, get, set, exportJson, importJson, factoryReset, deepMerge }
})(window)
