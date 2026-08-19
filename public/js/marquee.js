/* ====================================================================
 * marquee.js — 跑马灯公告条（重要通知独占整行滚动）
 * 支持配置：滚动速度（极慢/标准/极速）、滚动方向、通知文字内容。
 * WindowsXP 原版像素点阵字体（宋体 12px 点阵，关闭抗锯齿）。
 * ==================================================================== */
(function (global) {
  'use strict'

  const SPEEDS = { slow: 0.35, standard: 0.9, fast: 2.6 } // px / 帧

  function MarqQueue (trackEl, opts) {
    this.trackEl = trackEl
    this.opts = opts
    this.items = []      // 渲染后的 span 节点（首尾循环）
    this.offset = 0
    this.hovering = false
    this.timer = null
    this.running = false
  }

  MarqQueue.prototype.setTexts = function (texts) {
    const track = this.trackEl
    track.innerHTML = ''
    this.items = texts.map(t => {
      const span = document.createElement('span')
      span.innerHTML = t
      return span
    })
    // 首尾循环：内容复制到足以铺满轨道（至少 2 倍）
    this.fill()
  }

  MarqQueue.prototype.fill = function () {
    const track = this.trackEl
    const parent = track.parentElement
    while (track.scrollWidth < parent.clientWidth * 2 && this.items.length < 200) {
      for (const it of this.items) track.appendChild(it.cloneNode(true))
    }
  }

  MarqQueue.prototype.tick = function (dirSign) {
    const track = this.trackEl
    const parent = track.parentElement
    if (!this.hovering && this.running) {
      const speed = SPEEDS[this.opts.speed] || SPEEDS.standard
      this.offset += speed * dirSign
      // 无缝回卷：内容宽度一半作为循环周期
      const half = track.scrollWidth / 2
      if (this.offset <= -half) this.offset += half
      if (this.offset >= 0) this.offset -= half
      track.style.transform = `translateX(${this.offset}px)`
    }
  }

  function makeQueue (trackEl, cfg, texts, dirSign) {
    const q = new MarqQueue(trackEl, cfg)
    q.setTexts(texts)
    // 等待首帧布局完成再量宽
    requestAnimationFrame(() => {
      q.fill()
      trackEl.style.transform = 'translateX(0)'
    })
    return q
  }

  function start () {
    const cfg = GOVConfig.get('marquee')
    const noticeTrack = document.getElementById('mqNoticeTrack')
    if (!noticeTrack) return // 行情通道已移除；重要通知独占整行

    const noticeSign = (cfg.noticeDirection || 'left') === 'left' ? -1 : 1

    const noticeTexts = (cfg.noticeText || '').split(/【/).filter(Boolean).map(s => '【' + s)

    const noticeQ = makeQueue(noticeTrack, cfg, noticeTexts.length ? noticeTexts : ['【重要通知】暂无通知'], noticeSign)

    noticeQ.running = cfg.noticeEnabled !== false

    // hover 暂停绑在整条通道上（标签 + 滚动区）
    const channel = noticeTrack.closest('.marquee-notice')
    channel.addEventListener('mouseenter', () => { noticeQ.hovering = true })
    channel.addEventListener('mouseleave', () => { noticeQ.hovering = false })

    function frame () {
      noticeQ.tick(noticeSign)
      requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
  }

  /** 配置热更新：重建整个跑马灯 */
  function rebuild () {
    start()
  }

  global.GOVMarquee = { start, rebuild }
})(window)
