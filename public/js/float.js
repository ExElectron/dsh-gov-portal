/* ====================================================================
 * float.js — 全局视口漂浮弹窗（DVD 屏保匀速物理碰撞反弹）
 *
 * 弹窗 A：红头重要通知（红白边框、黄色喇叭、右上 [×]）
 * 弹窗 B：官方矩阵二维码（蓝白边框、2 个二维码 + 公众号说明）
 *
 * 行为：在整个浏览器视口内做匀速碰撞反弹（触边反向）；
 *       鼠标 Hover 立即暂停移动，移开继续；点击 [×] 销毁 DOM。
 * 配置：开关、速度（极慢/标准/极速）、初始坐标、悬停暂停、内容自定义。
 * ==================================================================== */
(function (global) {
  'use strict'

  const SPEED_PX = { slow: 0.6, standard: 1.5, fast: 4.2 } // 每帧位移 px（约 60fps）
  const layer = () => document.getElementById('floatLayer')

  function createModal (kind) {
    const cfg = GOVConfig.get(kind === 'notice' ? 'floatNotice' : 'floatQr')
    const el = document.createElement('div')
    el.className = `float-modal ${kind === 'notice' ? 'notice' : 'qr'}`
    el.dataset.kind = kind

    const close = document.createElement('button')
    close.className = 'fm-close'
    close.title = '关闭'
    close.innerHTML = '×'
    close.addEventListener('click', () => {
      el.remove()
      GOVConfig.set(kind === 'notice' ? 'floatNotice.enabled' : 'floatQr.enabled', false)
      global.GOVPanels?.refreshConfigValues?.()
    })

    // —— 图片模式：用户自定义图片铺满整个弹窗，叉号置图片右上角 ——
    if (cfg.image) {
      el.classList.add('image-mode')
      const wrap = document.createElement('div')
      wrap.className = 'fm-img-wrap'
      const img = document.createElement('img')
      img.src = cfg.image
      img.alt = '通知图片'
      img.style.width = `${Number(cfg.imageWidth) || (kind === 'notice' ? 360 : 340)}px`
      img.onerror = () => { img.onerror = null; img.src = '' }
      wrap.appendChild(img)
      wrap.appendChild(close) // 叉号在图片右上角
      el.appendChild(wrap)
      layer().appendChild(el)
      return el
    }

    const head = document.createElement('div')
    head.className = 'fm-head'
    head.innerHTML = kind === 'notice'
      ? '<span class="fm-horn">📢</span>重要通知'
      : '官方矩阵二维码'
    head.appendChild(close)

    const body = document.createElement('div')
    body.className = 'fm-body'
    if (kind === 'notice') {
      body.innerHTML = `
        <div class="fm-title">${GOV.escape(cfg.title || '重要通知')}</div>
        <div class="fm-text">${GOV.escape(cfg.body || '')}</div>
        <a class="fm-link" href="${GOV.escape(cfg.link || '#')}" target="_blank" rel="noopener">${GOV.escape(cfg.linkText || '点击查阅详情 >>')}</a>`
    } else {
      body.innerHTML = `
        <div class="qr-row">
          <div class="qr-cell"><canvas class="qr-canvas"></canvas><div class="qr-label">${GOV.escape(cfg.qr1Label || '公众号')}</div></div>
          <div class="qr-cell"><canvas class="qr-canvas"></canvas><div class="qr-label">${GOV.escape(cfg.qr2Label || '客户端')}</div></div>
        </div>
        <div class="qr-note">${GOV.escape(cfg.note || '')}</div>`
    }
    el.appendChild(head)
    el.appendChild(body)
    layer().appendChild(el)

    // 二维码渲染：自定义 URL 用图片，否则画假二维码矩阵
    if (kind === 'qr') {
      const canvases = el.querySelectorAll('.qr-canvas')
      const urls = [cfg.qr1Url, cfg.qr2Url]
      canvases.forEach((canvas, i) => {
        if (urls[i]) {
          const img = document.createElement('img')
          img.src = urls[i]
          img.width = 96; img.height = 96
          img.onerror = () => { img.remove(); GOV.drawFakeQr(canvas, `gov-qr-${i + 1}`) }
          canvas.replaceWith(img)
        } else {
          GOV.drawFakeQr(canvas, `gov-qr-${i + 1}`)
        }
      })
    }

    return el
  }

  function floatLoop (el, cfg) {
    const speed = SPEED_PX[cfg.speed] || SPEED_PX.standard
    // 反弹上边界：避开顶部工具条（设为首页/标语/日期时间），弹窗不遮挡顶栏
    const TOP_SAFE = 44
    let x = Number.isFinite(Number(cfg.x)) ? Number(cfg.x) : 80
    let y = Number.isFinite(Number(cfg.y)) ? Number(cfg.y) : 300
    let vx = speed
    let vy = speed
    let paused = false
    let last = performance.now()

    // 弹窗创建后量出实际尺寸再入画
    el.style.left = '-10000px'
    el.style.top = '-10000px'
    const rect = () => ({ w: el.offsetWidth || 320, h: el.offsetHeight || 220 })

    const clampStart = () => {
      const { w, h } = rect()
      x = Math.min(Math.max(0, x), Math.max(0, innerWidth - w))
      y = Math.min(Math.max(TOP_SAFE, y), Math.max(TOP_SAFE, innerHeight - h))
      el.style.left = `${x}px`
      el.style.top = `${y}px`
    }
    requestAnimationFrame(clampStart)

    el.addEventListener('mouseenter', () => { if (cfg.hoverPause !== false) paused = true })
    el.addEventListener('mouseleave', () => { paused = false; last = performance.now() })

    function frame (now) {
      if (el.isConnected) {
        const dt = Math.min((now - last) / 16.67, 3) // 帧归一（掉帧补偿，上限 3 帧）
        last = now
        if (!paused) {
          const { w, h } = rect()
          x += vx * dt
          y += vy * dt
          // 视口碰撞反弹（触边反向，不越界；顶部避开工具条）
          if (x <= 0) { x = 0; vx = Math.abs(vx) }
          if (y <= TOP_SAFE) { y = TOP_SAFE; vy = Math.abs(vy) }
          if (x + w >= innerWidth) { x = innerWidth - w; vx = -Math.abs(vx) }
          if (y + h >= innerHeight) { y = innerHeight - h; vy = -Math.abs(vy) }
          el.style.left = `${x}px`
          el.style.top = `${y}px`
        }
        requestAnimationFrame(frame)
      }
    }
    requestAnimationFrame(frame)
  }

  function start () {
    layer().innerHTML = ''
    const noticeCfg = GOVConfig.get('floatNotice')
    const qrCfg = GOVConfig.get('floatQr')
    if (noticeCfg.enabled) {
      const el = createModal('notice')
      floatLoop(el, noticeCfg)
    }
    if (qrCfg.enabled) {
      const el = createModal('qr')
      floatLoop(el, qrCfg)
    }
  }

  /** 配置热更新：重建全部弹窗 */
  function rebuild () {
    start()
  }

  global.GOVFloat = { start, rebuild }
})(window)
