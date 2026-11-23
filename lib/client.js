/**
 * dsh-keyword-graph —— 客户端半边：会话顶栏「图谱」标签
 *
 * 数据流：GraphView ⇄ /dsh-graph/api?op=session|related|message|link|config（同源 fetch）
 * 渲染：force-graph（canvas 力导向），vendor 由宿主 /dsh-graph/vendor/* 提供。
 *
 * 控制器裁决落地：
 *   R15：d3-force UMD 依赖 d3-quadtree/d3-dispatch/d3-timer（挂 window.d3），
 *        必须按序先加载这三个，再 d3-force，最后 force-graph（window.ForceGraph）。
 *   R4：nodeCanvasObject 不读 React state（闭包会过期）→ selRef/cfgRef 镜像 + hoverRef。
 *   R19：force-graph 1.52.0 没有 refresh() 方法；用 .autoPauseRedraw(false) 持续重绘。
 *   R22：节点命中用 nodePointerAreaPaint 按真实半径绘制（默认命中是可见圆的 4 倍）。
 *   R23：连线距离来自原文词距（服务端 dist/distNorm），不再按轮共现拍脑袋。
 *   R24：消息定位借用 DSH 官方轮次导航（对话页只有「轮」级锚点，没有消息级）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-keyword-graph',
  factory: (require) => {
    const module = { exports: {} }; const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')
    const { createElement: h, useEffect, useRef, useState, useCallback } = React
    const API = '/dsh-graph/api'
    // R15：顺序不可换 —— quadtree/dispatch/timer → force → force-graph
    const VENDOR = [
      '/dsh-graph/vendor/d3-quadtree.min.js',
      '/dsh-graph/vendor/d3-dispatch.min.js',
      '/dsh-graph/vendor/d3-timer.min.js',
      '/dsh-graph/vendor/d3-force.min.js',
      '/dsh-graph/vendor/force-graph.min.js'
    ]
    let vendorPromise = null
    function loadVendor() {
      if (!vendorPromise) vendorPromise = VENDOR.reduce((p, src) => p.then(() => new Promise((ok, err) => {
        const s = document.createElement('script')
        s.src = src; s.onload = ok; s.onerror = () => err(new Error('加载失败 ' + src))
        document.head.appendChild(s)
      })), Promise.resolve()).catch(e => { vendorPromise = null; throw e })   // R19：失败不缓存 rejection，下次轮询重试
      return vendorPromise
    }
    const radius = (n) => typeof n.r === 'number' ? n.r : n.kind === 'session' ? 8 : 6
    const nodeIdOf = (x) => (x && typeof x === 'object' ? x.id : x)
    // 聚焦时非相关连线只淡化、不隐藏：灰色同款线条保留，读者仍能看见全局结构
    const LINK_GRAY = {
      idle: 'rgba(127,127,127,.40)',
      faded: 'rgba(127,127,127,.20)',
      memberIdle: 'rgba(127,127,127,.16)',
      memberFaded: 'rgba(127,127,127,.10)',
      memberHot: 'rgba(127,127,127,.55)'
    }
    function linkStyle(l, { focus, accent: acc } = {}) {
      const hot = !!focus && (nodeIdOf(l.source) === focus || nodeIdOf(l.target) === focus)
      if (l.kind === 'member') {
        if (!focus) return { color: LINK_GRAY.memberIdle, width: 0.25 }
        return hot ? { color: LINK_GRAY.memberHot, width: 0.7 } : { color: LINK_GRAY.memberFaded, width: 0.25 }
      }
      const base = Math.min(1.3, 0.3 + (Number.isFinite(l.weight) ? l.weight : 0) * 0.32)
      if (focus) return hot ? { color: acc || '#2563eb', width: Math.max(1, base) } : { color: LINK_GRAY.faded, width: base }
      return { color: LINK_GRAY.idle, width: base }
    }
    // 蓝色流动虚线只叠在聚焦的主题线上；会话→主题的归属虚线保持静态
    function flowLink(l, focus) {
      return !!focus && l.kind !== 'member' && (nodeIdOf(l.source) === focus || nodeIdOf(l.target) === focus)
    }
    // 右键取消关联：会话节点直接对应一个关联会话；主题节点只有“独占某个关联会话”时才响应
    function unlinkTarget(n, sessionId) {
      if (!n) return null
      if (n.kind === 'session') return n.sessionId && n.sessionId !== sessionId ? n.sessionId : null
      if (n.kind !== 'topic') return null
      const owners = new Set((n.msgs ?? []).map(m => m && m.s).filter(Boolean))
      if (owners.has(sessionId) || owners.size !== 1) return null
      const [sid] = owners
      return sid !== sessionId ? sid : null
    }
    const isDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches
    // 鲸鱼蓝：cfg.accent 可覆盖；默认浅色 #2563eb / 深色 #5b8cff
    const accent = (cfg) => cfg?.accent || (isDark() ? '#5b8cff' : '#2563eb')
    const MAX_PANEL_MSGS = 50
    // 侧栏宽度可拖动，记住上次宽度
    const PANEL_W_KEY = 'dsh-graph:panelW'
    const PANEL_MIN_W = 240
    const PANEL_MAX_W = 720
    const readPanelW = () => {
      try {
        const v = Number(window.localStorage.getItem(PANEL_W_KEY))
        return Number.isFinite(v) && v >= PANEL_MIN_W ? Math.min(PANEL_MAX_W, v) : 340
      } catch { return 340 }
    }

    // 跨视图缓存：图谱 → 对话 → 图谱 时恢复相机与选中主题
    const viewCache = new Map()

    // 面板样式：固定 id 注入一次，随 DSH 主题变量走
    const STYLE_ID = 'dsh-keyword-graph-style'
    const CSS = `
.dcg-root{box-sizing:border-box;width:100%;height:100%;min-height:0;display:flex;overflow:hidden;color:var(--dsw-alias-label-primary)}
.dcg-canvas{flex:1 1 auto;min-width:0;min-height:0;height:100%;position:relative;overflow:hidden}
.dcg-split{flex:0 0 9px;position:relative;cursor:col-resize;touch-action:none;background:transparent}
.dcg-split::after{content:"";position:absolute;top:0;bottom:0;left:50%;width:1px;transform:translateX(-50%);background:var(--dsw-alias-border-l2);transition:background .12s,width .12s}
.dcg-split:hover::after,.dcg-split[data-dragging="1"]::after{width:2px;background:currentColor;opacity:.45}
.dcg-panel{flex:0 0 340px;width:340px;height:100%;min-height:0;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;padding:12px 12px 20px;font-size:12px;display:flex;flex-direction:column;gap:6px;box-sizing:border-box}
/* 图谱页是独立视图：藏掉悬浮输入框，画布铺满整页；切回对话页时属性消失、输入框自动恢复 */
[data-conversation-scroll]:has([data-conversation-composer-overlay]) [data-composer-seat]{display:none!important}
.dcg-head{display:flex;align-items:center;gap:8px;margin:2px 0 0}
.dcg-title{font-size:13px;font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dcg-chip{font-size:11px;opacity:.6;white-space:nowrap}
.dcg-sub{font-size:11px;opacity:.6;line-height:1.45;margin:0 0 4px}
.dcg-close{border:0;background:transparent;color:inherit;opacity:.55;cursor:pointer;font-size:15px;line-height:1;padding:2px 5px;border-radius:4px}
.dcg-close:hover{opacity:1;background:rgba(127,127,127,.12)}
.dcg-turnrow{display:flex;align-items:center;gap:6px;padding:7px 8px 3px}
.dcg-turn-title{font-size:12px;font-weight:600}
.dcg-turn-stat{font-size:11px;opacity:.55}
.dcg-locate{margin-left:auto;border:0;background:transparent;color:inherit;opacity:.5;cursor:pointer;font-size:12px;padding:2px 6px;border-radius:4px}
.dcg-locate:hover{opacity:1;background:rgba(127,127,127,.14)}
.dcg-group + .dcg-group{margin-top:4px;padding-top:6px;border-top:.5px solid rgba(127,127,127,.16)}
.dcg-body{padding:0 4px 8px 8px;display:flex;flex-direction:column;gap:8px}
.dcg-msg{padding:6px 8px;border-radius:8px;cursor:pointer;transition:background .12s}
.dcg-msg:hover{background:rgba(127,127,127,.08)}
.dcg-msg[data-open="1"]{background:rgba(127,127,127,.05);cursor:zoom-out}
.dcg-role{font-size:10px;padding:1px 5px;border-radius:4px;background:rgba(127,127,127,.15)}
.dcg-text{margin-top:4px;line-height:1.6;white-space:pre-wrap;word-break:break-word;font-size:12px;opacity:.9}
.dcg-clamp{display:-webkit-box;-webkit-line-clamp:7;-webkit-box-orient:vertical;overflow:hidden}
.dcg-mark{background:#fde68a;color:#3b2f00;border-radius:2px;padding:0 1px}
.dcg-loading{font-size:11px;opacity:.5;margin-top:2px}
.dcg-section{margin-top:12px;font-size:11px;opacity:.55}
.dcg-related{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 8px;border-radius:8px}
.dcg-related:hover{background:rgba(127,127,127,.08)}
.dcg-rel-main{min-width:0}
.dcg-rel-title{font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dcg-rel-state{font-size:10px;padding:0 5px;border-radius:999px;border:.5px solid currentColor;opacity:.6;margin-left:6px}
.dcg-rel-shared{font-size:11px;opacity:.55;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dcg-btn{font-size:11px;padding:2px 9px;border-radius:6px;border:.5px solid var(--dsw-alias-border-l2);background:transparent;color:inherit;cursor:pointer;white-space:nowrap}
.dcg-btn:hover{border-color:currentColor}
.dcg-empty{opacity:.55;padding:20px 4px;text-align:center}
.dcg-hint{font-size:11px;opacity:.5;margin-top:2px}
.dcg-error{font-size:12px;color:var(--dsw-alias-state-error-primary)}
.dcg-overlay{position:absolute;font-size:11px;opacity:.5;pointer-events:none}
.dcg-tip{max-width:260px}
.dcg-tip-title{font-weight:600;margin-bottom:2px}
.dcg-tip-meta{font-size:11px;opacity:.75;white-space:normal;line-height:1.45}
`
    function ensureStyles() {
      if (document.getElementById(STYLE_ID)) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.appendChild(style)
    }

    // 右侧面板按轮分组；展开时按需读全文，选中关键词用黄色底高亮
    function groupByTurn(msgs) {
      const out = []
      for (const m of msgs) {
        const turn = Number.isFinite(m.turn) && m.turn > 0 ? m.turn : 0
        const last = out[out.length - 1]
        if (last && last.turn === turn) last.msgs.push(m)
        else out.push({ turn, msgs: [m] })
      }
      return out
    }
    // 与服务端同一套分词规则：只高亮完整词，避免 mod 命中 model、ui 命中 build
    const wordSegmenter = new Intl.Segmenter('zh', { granularity: 'word' })
    function highlightText(text, keyword) {
      if (!text) return text
      const kw = String(keyword ?? '').toLowerCase()
      if (!kw) return text
      const parts = []
      let last = 0
      for (const { segment, index, isWordLike } of wordSegmenter.segment(text)) {
        if (!isWordLike || segment.toLowerCase() !== kw) continue
        if (index > last) parts.push(text.slice(last, index))
        parts.push(h('mark', { key: 'm' + index, className: 'dcg-mark' }, segment))
        last = index + segment.length
      }
      if (!parts.length) return text
      if (last < text.length) parts.push(text.slice(last))
      return parts
    }
    // force-graph 的 nodeLabel 支持返回 HTMLElement：两行详情（全称 / 词频 + 10 字上下文）
    function tooltipNode(n) {
      const wrap = document.createElement('div')
      wrap.className = 'dcg-tip'
      const title = document.createElement('div')
      title.className = 'dcg-tip-title'
      title.textContent = n.label
      wrap.appendChild(title)
      if (n.kind === 'topic') {
        const parts = []
        if (n.freq) parts.push('出现 ' + n.freq + ' 次')
        if (n.desc) parts.push(n.desc)
        if (parts.length) {
          const meta = document.createElement('div')
          meta.className = 'dcg-tip-meta'
          meta.textContent = parts.join(' · ')
          wrap.appendChild(meta)
        }
      }
      return wrap
    }

    // R24：对话页的轮次导航是虚拟列表，DOM 里只有可视按钮；从按钮的 React fiber
    // 上取导航器 props（完整 items + 官方 onNavigate），复用它的懒加载与滚动纠偏。
    function railPropsOf(el) {
      const key = Object.keys(el).find(k => k.startsWith('__reactFiber$'))
      let fiber = key ? el[key] : null
      while (fiber) {
        const p = fiber.memoizedProps
        if (p && Array.isArray(p.items) && typeof p.onNavigate === 'function') return p
        fiber = fiber.return
      }
      return null
    }
    function tryJump(turn) {
      for (const el of document.querySelectorAll('button[data-index]')) {
        const props = railPropsOf(el)
        if (!props) continue
        const item = props.items.find(x => x.turn === turn)
        if (item) { props.onNavigate(item); return true }
      }
      // 兜底 1：可见按钮的 aria-label（「跳转到第 N 轮」/「加载并跳转到第 N 轮」）
      for (const el of document.querySelectorAll('button[aria-label]')) {
        const label = el.getAttribute('aria-label') ?? ''
        const m = label.match(/第\s*(\d+)\s*轮/) ?? label.match(/\bturn\s+(\d+)/i)
        if (m && Number(m[1]) === turn) { el.click(); return true }
      }
      // 兜底 2：已渲染的行直接滚到中间
      const row = document.querySelector('[data-chat-turn="' + turn + '"]')
      if (row) { row.scrollIntoView({ block: 'center' }); return true }
      return false
    }
    function pollJump(turn, deadline) {
      if (tryJump(turn) || Date.now() > deadline) return
      setTimeout(() => pollJump(turn, deadline), 120)
    }
    function flashTurn(turn, color, attempts = 4) {
      const row = document.querySelector('[data-chat-turn="' + turn + '"]')
      if (row) {
        row.style.transition = 'box-shadow .25s'
        row.style.boxShadow = '0 0 0 2px ' + color
        setTimeout(() => { row.style.boxShadow = '' }, 1400)
        return
      }
      if (attempts > 0) setTimeout(() => flashTurn(turn, color, attempts - 1), 350)
    }
    function clickChatTab() {
      for (const el of document.querySelectorAll('button, [role="tab"]')) {
        const text = (el.textContent ?? '').trim()
        if (text === '对话' || text === 'Chat') { el.click(); return }
      }
    }

    function GraphView({ sessionId, openView, completeViewRequest }) {
      ensureStyles()
      const boxRef = useRef(null)
      const panelRef = useRef(null)
      const fgRef = useRef(null)
      const posRef = useRef(new Map())   // 旧节点坐标，增量更新不跳位
      const bornRef = useRef(new Map())  // 新节点生长动画起点
      const sigRef = useRef('')          // 图谱签名：没变化就不重建实例
      const camRef = useRef(null)
      const [data, setData] = useState(null)
      const [cfg, setCfg] = useState(null)
      const [sel, setSel] = useState(null)      // 选中的 topic node
      const [related, setRelated] = useState([])
      const [panelW, setPanelW] = useState(readPanelW)
      const [splitDrag, setSplitDrag] = useState(false)
      const [err, setErr] = useState(null)
      const [excerpts, setExcerpts] = useState([])     // [{ seq, excerpt }]：关键词居中片段
      const [excerptsLoading, setExcerptsLoading] = useState(false)
      const [expanded, setExpanded] = useState(() => new Set())  // 已展开全文的 seq
      const [, setFullVer] = useState(0)          // 全文读回后触发重绘
      const hoverRef = useRef(null)
      const selRef = useRef(null)        // R4：sel 的镜像，canvas 回调只读 ref
      const cfgRef = useRef(null)
      const panelWRef = useRef(panelW)
      const fullCache = useRef(new Map()) // seq → 消息全文（仅内存，不落盘）
      const pendingFull = useRef(new Set())
      const excerptCache = useRef(new Map()) // 会话+词+索引版本 → 片段列表（仅内存）
      const labelAnim = useRef(new Map()) // 节点 id → { v, t }：悬停时标签外移进度 0..1
      const dimAnim = useRef(new Map())   // 节点 id → { v, t }：无关节点的淡化进度 0..1

      const focusId = () => hoverRef.current?.id ?? selRef.current?.id ?? null

      useEffect(() => { cfgRef.current = cfg }, [cfg])
      useEffect(() => { panelWRef.current = panelW }, [panelW])

      // 切会话 = 全新画布：清选中/关联/数据/签名/坐标/生长起点/相机
      useEffect(() => {
        setSel(null); selRef.current = null
        setRelated([]); setData(null)
        setExcerpts([]); setExcerptsLoading(false); setExpanded(new Set())
        fullCache.current.clear(); pendingFull.current.clear()
        excerptCache.current.clear()
        labelAnim.current.clear()
        dimAnim.current.clear()
        sigRef.current = ''
        posRef.current.clear(); bornRef.current.clear()
        camRef.current = null
      }, [sessionId])

      // 新节点出生在已定位邻居旁边；没有邻居则按首次出现时间散开
      const seedPositions = (nodes, links) => {
        const idOf = (x) => typeof x === 'string' ? x : x?.id
        for (const n of nodes) {
          const old = posRef.current.get(n.id)
          if (old) { Object.assign(n, { x: old.x, y: old.y, vx: old.vx, vy: old.vy }); continue }
          if (!bornRef.current.has(n.id)) bornRef.current.set(n.id, Date.now())
          if (n.kind === 'session') { n.x = 0; n.y = 0; continue }
          let anchor = null
          for (const l of links) {
            const a = idOf(l.source), b = idOf(l.target)
            const other = a === n.id ? b : b === n.id ? a : null
            if (other && posRef.current.has(other)) { anchor = posRef.current.get(other); break }
          }
          if (anchor) {
            n.x = anchor.x + (Math.random() - 0.5) * 90
            n.y = anchor.y + (Math.random() - 0.5) * 90
          } else {
            const seq = n.msgs?.[0]?.seq ?? 0
            const ang = (seq * 2.399963) % (Math.PI * 2)
            n.x = Math.cos(ang) * 210
            n.y = Math.sin(ang) * 210
          }
        }
      }

      const refresh = useCallback(async () => {
        try {
          const [s, r, c] = await Promise.all([
            fetch(API + '?op=session&id=' + encodeURIComponent(sessionId)).then(x => x.json()),
            fetch(API + '?op=related&id=' + encodeURIComponent(sessionId)).then(x => x.json()),
            fetch(API + '?op=config').then(x => x.json())
          ])
          setCfg(c.config); setRelated(r.related ?? []); setErr(null)
          if (s.status === 'ready') {
            const sig = JSON.stringify(s.graph.nodes.map(n => [n.id, n.label, Math.round(n.r * 10)])) + '|' + s.graph.links.length + '|' + (s.messages ?? []).length
            if (sig === sigRef.current) {
              setData(prev => prev && prev.status !== 'ready' ? { ...prev, status: 'ready' } : prev)
              return
            }
            sigRef.current = sig
            const live = new Set(s.graph.nodes.map(n => n.id))
            for (const id of labelAnim.current.keys()) if (!live.has(id)) labelAnim.current.delete(id)
            for (const id of dimAnim.current.keys()) if (!live.has(id)) dimAnim.current.delete(id)
            seedPositions(s.graph.nodes, s.graph.links)
            setData(s)
          } else if (s.status === 'missing') {
            sigRef.current = ''
            setData({ status: 'missing' })
          } else {
            setData(prev => prev?.graph ? { ...prev, status: s.status } : { status: s.status })
          }
          setErr(null)
        } catch (e) { setErr(String(e.message ?? e)) }
      }, [sessionId])

      useEffect(() => { refresh(); const t = setInterval(refresh, 4000); return () => clearInterval(t) }, [refresh])

      // 从对话页回到图谱时恢复上次选中的主题（节点按 id 从最新数据重取）
      useEffect(() => {
        if (!data?.graph || selRef.current) return
        const cached = viewCache.get(sessionId)
        if (!cached?.selId) return
        const n = data.graph.nodes.find(x => x.id === cached.selId)
        if (n) { selRef.current = n; setSel(n) }
      }, [data?.graph, sessionId])

      useEffect(() => {
        if (!data?.graph || !boxRef.current) return
        let dead = false
        hoverRef.current = null
        loadVendor().then(() => {
          if (dead || !boxRef.current) return
          const FG = window.ForceGraph()
          fgRef.current = FG
          FG(boxRef.current)
            .width(boxRef.current.clientWidth).height(boxRef.current.clientHeight)
            .backgroundColor('rgba(0,0,0,0)')
            .autoPauseRedraw(false)
            .nodeId('id').nodeVal(n => radius(n) ** 2)
            .nodeLabel(tooltipNode)
            // R22：命中区 = 可见圆（默认是 sqrt(nodeVal)*nodeRelSize = 4 倍半径）
            .nodePointerAreaPaint((n, color, g) => {
              g.fillStyle = color
              g.beginPath(); g.arc(n.x, n.y, radius(n) + 1, 0, 2 * Math.PI); g.fill()
            })
            // 悬停/选中时相关连线变蓝，其余保留灰色同款线条、只降透明度
            .linkColor(l => linkStyle(l, { focus: focusId(), accent: accent(cfgRef.current) }).color)
            .linkWidth(l => linkStyle(l, { focus: focusId(), accent: accent(cfgRef.current) }).width)
            .linkLineDash(l => l.kind === 'member' ? [2, 3] : null)
            // 聚焦主题线只画一列流动的 V 形箭头（替换掉静态蓝线），方向 = 聚焦节点 → 对方节点
            .linkCanvasObjectMode(l => (flowLink(l, focusId()) ? 'replace' : undefined))
            .linkCanvasObject((l, ctx2) => {
              const focus = focusId()
              if (!flowLink(l, focus)) return
              const a = l.source, b = l.target
              if (!a || !b || typeof a.x !== 'number' || typeof b.x !== 'number') return
              const from = nodeIdOf(a) === focus ? a : b
              const to = from === a ? b : a
              const dx = to.x - from.x, dy = to.y - from.y
              const len = Math.hypot(dx, dy)
              if (len < 1) return
              const ux = dx / len, uy = dy / len
              const nx = -uy, ny = ux
              const sx = from.x + ux * (radius(from) + 2), sy = from.y + uy * (radius(from) + 2)
              const ex = to.x - ux * (radius(to) + 2), ey = to.y - uy * (radius(to) + 2)
              const total = (ex - sx) * ux + (ey - sy) * uy
              if (total <= 0) return // 两圆重叠，没有可画线段
              // 实心 V 形箭头（按参考图逐像素取形）：长直身 + 短 45° 尖端/缺口，两翼上下水平切平
              // 长宽按同一比例缩放（本次整体 ×0.5），V 形角度保持不变
              const HY = 0.6, BODY = 3.6, TIP = 0.55
              const SHAPE = [
                [-BODY / 2, -HY], [BODY / 2, -HY], [BODY / 2 + TIP, 0],
                [BODY / 2, HY], [-BODY / 2, HY], [-BODY / 2 + TIP, 0]
              ]
              const SPACING = BODY + TIP, SPEED = 0.025 // 约 25px/s 向对方流动
              const phase = (Date.now() * SPEED) % SPACING
              ctx2.save()
              ctx2.globalAlpha = 0.9
              ctx2.fillStyle = accent(cfgRef.current)
              // 从节点圆内开始画、画到对方圆内为止；节点圆后画会盖住还没探出的部分，
              // 箭头才会贴着节点边缘慢慢“探头”，而不是在圆周外凭空刷新出一支
              for (let d = phase - SPACING; d - BODY / 2 < total; d += SPACING) {
                const cx = sx + ux * d, cy = sy + uy * d
                ctx2.beginPath()
                for (let i = 0; i < SHAPE.length; i++) {
                  const [vx, vy] = SHAPE[i]
                  const px = cx + ux * vx + nx * vy, py = cy + uy * vx + ny * vy
                  if (i) ctx2.lineTo(px, py); else ctx2.moveTo(px, py)
                }
                ctx2.closePath()
                ctx2.fill()
              }
              ctx2.restore()
            })
            .nodeCanvasObject((n, ctx2, scale) => {
              const r = radius(n)
              const born = bornRef.current.get(n.id) ?? 0
              const grow = Math.min(1, (Date.now() - born) / 400)
              const hov = hoverRef.current
              const dim = hov && n.id !== hov.id && !(hov.neighbors ?? []).includes(n.id)
              const hot = selRef.current?.id === n.id || hov?.id === n.id
              // 悬停时标签平滑外移 12px：指数缓动，跟随持续重绘逐帧收敛
              let anim = labelAnim.current.get(n.id)
              const now = Date.now()
              if (!anim) { anim = { v: 0, t: now }; labelAnim.current.set(n.id, anim) }
              const dt = Math.min(64, Math.max(0, now - anim.t)); anim.t = now
              const animTarget = hov?.id === n.id ? 1 : 0
              anim.v += (animTarget - anim.v) * (1 - Math.exp(-dt / 80))
              if (Math.abs(animTarget - anim.v) < 0.002) anim.v = animTarget
              // 无关节点的淡化同样用指数缓动，避免悬停/移开时瞬间跳变
              let dimA = dimAnim.current.get(n.id)
              if (!dimA) { dimA = { v: dim ? 1 : 0, t: now }; dimAnim.current.set(n.id, dimA) }
              const ddt = Math.min(64, Math.max(0, now - dimA.t)); dimA.t = now
              const dimTarget = dim ? 1 : 0
              dimA.v += (dimTarget - dimA.v) * (1 - Math.exp(-ddt / 70))
              if (Math.abs(dimTarget - dimA.v) < 0.004) dimA.v = dimTarget
              ctx2.globalAlpha = grow * (1 - 0.86 * dimA.v)
              const blue = accent(cfgRef.current)
              ctx2.fillStyle = n.kind === 'session' ? blue : hot ? blue : 'rgb(92,92,92)'
              ctx2.beginPath(); ctx2.arc(n.x, n.y, r * grow, 0, 2 * Math.PI); ctx2.fill()
              if (scale >= 0.55 || hot || n.kind === 'session') {
                ctx2.fillStyle = dim ? (isDark() ? '#9aa4b2' : '#556070') : (isDark() ? '#d7dbe0' : '#333a42')
                ctx2.font = `${Math.max(2.5, (n.kind === 'session' ? 11 : 10) / scale)}px sans-serif`
                ctx2.textAlign = 'left'
                ctx2.textBaseline = 'middle'
                ctx2.fillText(n.label, n.x + r * grow + (4 + 12 * anim.v) / scale, n.y)
              }
              ctx2.globalAlpha = 1
            })
            .onNodeHover(n => {
              hoverRef.current = n ? { id: n.id, neighbors: (data.graph.links ?? []).filter(l => l.source.id === n.id || l.target.id === n.id || l.source === n.id || l.target === n.id).map(l => (l.source.id ?? l.source) === n.id ? (l.target.id ?? l.target) : (l.source.id ?? l.source)) } : null
              if (boxRef.current) boxRef.current.style.cursor = n ? 'pointer' : 'default'
            })
            .onNodeClick(n => {
              if (n.kind === 'topic') {
                selRef.current = n; setSel(n)
              } else { FG.centerAt(n.x, n.y, 700); FG.zoom(2.4, 700) }
            })
            .onBackgroundClick(() => { selRef.current = null; setSel(null) })
            .onNodeRightClick(n => {
              const sid = unlinkTarget(n, sessionId)
              if (sid) link(sid, true)
            })
            .onEngineTick(() => { for (const n of data.graph.nodes) posRef.current.set(n.id, { x: n.x, y: n.y, vx: n.vx, vy: n.vy }) })
          // 全图固定 25 主题 + 1 会话；按真实索引离线仿真收敛，让默认 zoom=1 下
          // 最长的一例外接尺寸从约 780px 压到约 600px，刚好铺满画布而不被裁切
          FG.d3Force('collide', window.d3.forceCollide(n => radius(n) + 4).iterations(2))
          FG.d3Force('charge').strength(-200)
          // R23：近词连线短且拉得紧，远词长而松；会话→主题只是归属，弱化
          const linkForce = FG.d3Force('link')
          if (linkForce) {
            linkForce.distance(l => l.kind === 'member' ? 65 : 28 + 80 * (typeof l.distNorm === 'number' ? l.distNorm : 0.5))
            linkForce.strength(l => l.kind === 'member' ? 0.05 : 0.08 + 0.35 * (1 - (typeof l.distNorm === 'number' ? l.distNorm : 0.5)))
          }
          FG.graphData(data.graph)
          const cachedCam = viewCache.get(sessionId)?.cam
          if (cachedCam) {
            FG.zoom(cachedCam.zoom, 0)
            FG.centerAt(cachedCam.center.x, cachedCam.center.y, 0)
          }
          const ro = new ResizeObserver(() => FG.width(boxRef.current.clientWidth).height(boxRef.current.clientHeight))
          ro.observe(boxRef.current)
          fgRef.current.__ro = ro
        }).catch(e => setErr(String(e.message ?? e)))
        return () => {
          dead = true
          // 销毁前记下 zoom/center 与选中，供切回图谱时恢复
          try {
            const fg = fgRef.current
            if (fg) {
              const cam = { zoom: fg.zoom(), center: fg.centerAt() }
              camRef.current = cam
              const c = viewCache.get(sessionId) ?? {}
              c.cam = cam
              c.selId = selRef.current?.id ?? null
              viewCache.set(sessionId, c)
            }
          } catch {}
          try { fgRef.current?.__ro?.disconnect(); fgRef.current?._destructor() } catch {}
        }
      }, [data?.graph, sessionId])

      const link = async (other, unlink) => {
        try {
          const res = await fetch(API + '?op=link', { method: unlink ? 'DELETE' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ a: sessionId, b: other }) })
          const r = await res.json().catch(() => ({}))
          if (!res.ok || !r.ok) { setErr(r.error || '操作失败'); return }
          refresh()
        } catch (e) { setErr(String(e.message ?? e)) }
      }

      // 拖分隔线调整侧栏宽度：画布是 flex:1，ResizeObserver 会自动跟着重排
      const startSplit = (e) => {
        if (e.button !== 0) return
        e.preventDefault()
        const total = e.currentTarget.parentElement?.clientWidth ?? 0
        const startX = e.clientX
        const startW = panelWRef.current
        const maxW = Math.max(PANEL_MIN_W, Math.min(PANEL_MAX_W, total - PANEL_MIN_W))
        const move = (ev) => {
          const w = Math.max(PANEL_MIN_W, Math.min(maxW, startW + startX - ev.clientX))
          panelWRef.current = w
          setPanelW(w)
        }
        const up = () => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
          window.removeEventListener('pointercancel', up)
          setSplitDrag(false)
          document.body.style.cursor = ''
          document.body.style.userSelect = ''
          try { window.localStorage.setItem(PANEL_W_KEY, String(panelWRef.current)) } catch {}
        }
        setSplitDrag(true)
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
        window.addEventListener('pointercancel', up)
        document.body.style.cursor = 'col-resize'
        document.body.style.userSelect = 'none'
      }

      // R24：切到对话页，再借官方轮次导航跳到第 N 轮（旧轮次会自动翻页加载）
      const openTurn = (turn) => {
        if (!Number.isFinite(turn) || turn <= 0) return
        if (typeof openView === 'function') {
          try { openView('chat'); completeViewRequest?.() } catch {}
        } else clickChatTab()
        pollJump(turn, Date.now() + 6000)
        setTimeout(() => flashTurn(turn, accent(cfgRef.current)), 500)
      }

      const selNode = sel ? ((data?.graph?.nodes ?? []).find(n => n.id === sel.id) ?? sel) : null
      const msgBySeq = new Map((data?.messages ?? []).map(m => [m.seq, m]))
      // 面板行来自服务端全文检索（关键词居中片段），不再依赖 80 字摘要是否含词
      const panelRows = selNode
        ? excerpts.slice(0, MAX_PANEL_MSGS).map(x => {
            const m = msgBySeq.get(x.seq) ?? {}
            return { seq: x.seq, excerpt: x.excerpt, role: m.role, turn: m.turn }
          })
        : []
      const groups = groupByTurn(panelRows)
      const hasTopics = (data?.graph?.nodes ?? []).some(n => n.kind === 'topic')

      // 展开某条消息时按需读全文：索引仍只存摘要，全文只在内存缓存，不落盘
      const loadFull = async (msgs) => {
        const todo = msgs.filter(m => !fullCache.current.has(m.seq) && !pendingFull.current.has(m.seq))
        if (!todo.length) return
        for (const m of todo) pendingFull.current.add(m.seq)
        let changed = false
        await Promise.all(todo.map(async (m) => {
          try {
            const r = await fetch(API + '?op=message&id=' + encodeURIComponent(sessionId) + '&seq=' + m.seq).then(x => x.json())
            const text = r?.result?.message?.text
            if (typeof text === 'string') { fullCache.current.set(m.seq, text); changed = true }
          } catch {}
          pendingFull.current.delete(m.seq)
        }))
        if (changed) setFullVer(v => v + 1)
      }

      // 从全文里找到第一个高亮（关键词），把它滚到面板中间
      const scrollToMark = (seq) => {
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const panel = panelRef.current
          const row = panel?.querySelector('[data-seq="' + seq + '"]')
          const target = row?.querySelector('mark') ?? row
          if (!panel || !target) return
          // 只滚面板自身，避免带动外层页面
          const top = target.getBoundingClientRect().top - panel.getBoundingClientRect().top + panel.scrollTop
          panel.scrollTop = top - panel.clientHeight / 2
        }))
      }

      const toggleMsg = async (seq) => {
        const open = expanded.has(seq)
        setExpanded(prev => {
          const next = new Set(prev)
          if (open) next.delete(seq); else next.add(seq)
          return next
        })
        if (open) return
        await loadFull([{ seq }])
        scrollToMark(seq)
      }

      // 换主题：清空展开状态与旧片段，避免短暂显示上一个词的上下文
      useEffect(() => {
        setExpanded(new Set())
        setExcerpts([])
      }, [sel?.id])

      // 选中主题后拉取“关键词居中”的原文片段；同一会话+词+索引版本只取一次
      useEffect(() => {
        if (!sel?.id || sel.kind !== 'topic') { setExcerptsLoading(false); return }
        const word = sel.word ?? sel.label
        const key = sessionId + '\u0000' + word + '\u0000' + (data?.updatedAt ?? '')
        const cached = excerptCache.current.get(key)
        if (cached) { setExcerpts(cached); setExcerptsLoading(false); return }
        let dead = false
        setExcerptsLoading(true)
        fetch(API + '?op=excerpts&id=' + encodeURIComponent(sessionId) + '&word=' + encodeURIComponent(word))
          .then(x => x.json())
          .then(r => {
            if (dead) return
            const list = Array.isArray(r?.result) ? r.result : []
            if (excerptCache.current.size > 30) excerptCache.current.delete(excerptCache.current.keys().next().value)
            excerptCache.current.set(key, list)
            setExcerpts(list)
          })
          .catch(() => { if (!dead) setExcerpts([]) })
          .finally(() => { if (!dead) setExcerptsLoading(false) })
        return () => { dead = true }
      }, [sel?.id, data?.updatedAt, sessionId])

      // 与官方轨迹视图同一契约：该属性让外层 scrollBody 把视图区夹成定高 + overflow:hidden，
      // 否则图谱页会被内容撑高、整页跟着滚动。输入框由 CSS 在本视图激活时隐藏，画布直接铺满。
      return h('div', { className: 'dcg-root', 'data-conversation-composer-overlay': '' },
        h('div', { ref: boxRef, className: 'dcg-canvas' },
          data?.status === 'indexing' ? h('div', { className: 'dcg-overlay', style: { top: 8, left: 10 } }, '索引中…') : null,
          data?.status === 'missing' ? h('div', { className: 'dcg-empty', style: { position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' } }, '会话已不存在或尚未有记录') : null,
          data?.status === 'ready' && !hasTopics ? h('div', { className: 'dcg-empty', style: { position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' } }, '本会话暂未提取到主题') : null,
          hasTopics ? h('div', { className: 'dcg-overlay', style: { bottom: 8, left: 10 } }, '点击主题查看相关对话 · 滚轮缩放 · 拖拽平移') : null),
        h('div', { className: 'dcg-split', title: '拖动调整侧栏宽度', 'data-dragging': splitDrag ? '1' : undefined, onPointerDown: startSplit }),
        h('div', { ref: panelRef, className: 'dcg-panel', style: { flexBasis: panelW + 'px', width: panelW + 'px', maxWidth: 'calc(100% - 240px)' } },
          err ? h('div', { className: 'dcg-error' }, err) : null,
          selNode ? h('div', { className: 'dcg-head' },
            h('span', { className: 'dcg-title' }, '主题：' + selNode.label),
            h('span', { className: 'dcg-chip' }, panelRows.length + ' 条'),
            h('button', { className: 'dcg-close', title: '取消选中', onClick: () => { selRef.current = null; setSel(null) } }, '×')) : null,
          selNode && (selNode.freq || selNode.desc) ? h('div', { className: 'dcg-sub' },
            [selNode.freq ? '出现 ' + selNode.freq + ' 次' : '', selNode.desc].filter(Boolean).join(' · ')) : null,
          selNode ? (groups.length
            ? groups.map(g => {
                const users = g.msgs.filter(m => m.role === 'user').length
                return h('div', { key: 'g' + g.turn, className: 'dcg-group' },
                  h('div', { className: 'dcg-turnrow' },
                    h('span', { className: 'dcg-turn-title' }, g.turn > 0 ? '第 ' + g.turn + ' 轮' : '未标轮次'),
                    h('span', { className: 'dcg-turn-stat' }, '我' + users + ' · AI' + (g.msgs.length - users)),
                    g.turn > 0 ? h('button', {
                      className: 'dcg-locate', title: '在对话页定位第 ' + g.turn + ' 轮',
                      onClick: (e) => { e.stopPropagation(); openTurn(g.turn) }
                    }, '↗') : null),
                  h('div', { className: 'dcg-body' }, g.msgs.map(m => {
                    const full = fullCache.current.get(m.seq)
                    const open = expanded.has(m.seq)
                    return h('div', {
                      key: m.seq, className: 'dcg-msg', 'data-seq': m.seq, 'data-open': open ? '1' : '0',
                      title: open ? '收起全文' : '展开全文并定位关键词',
                      onClick: () => toggleMsg(m.seq)
                    },
                      h('span', { className: 'dcg-role' }, m.role === 'assistant' ? 'AI' : '我'),
                      h('div', { className: open && full ? 'dcg-text' : 'dcg-text dcg-clamp' }, highlightText(open && full ? full : m.excerpt, selNode.label)),
                      open && !full && pendingFull.current.has(m.seq) ? h('div', { className: 'dcg-loading' }, '读取全文…') : null)
                  })))
              })
            : h('div', { className: 'dcg-empty' }, excerptsLoading ? '读取关键词上下文…' : '该主题暂无本会话消息')) : null,
          selNode && excerpts.length > MAX_PANEL_MSGS ? h('div', { className: 'dcg-hint' }, '仅显示前 ' + MAX_PANEL_MSGS + ' 条') : null,
          !selNode ? h('div', { className: 'dcg-empty' }, '点击左侧节点查看主题') : null,
          h('div', { className: 'dcg-section' }, '相关会话'),
          related.length
            ? related.map(r => h('div', { key: r.sessionId, className: 'dcg-related' },
                h('div', { className: 'dcg-rel-main' },
                  h('div', { className: 'dcg-rel-title' }, r.title, r.linked ? h('span', { className: 'dcg-rel-state' }, '已关联') : null),
                  h('div', { className: 'dcg-rel-shared' }, r.shared.length ? '共同：' + r.shared.join('、') : (r.linked ? '已并入当前图谱' : ''))),
                h('button', { className: 'dcg-btn', onClick: () => link(r.sessionId, r.linked) }, r.linked ? '取消关联' : '关联')))
            : h('div', { className: 'dcg-hint' }, '暂无相关会话'),
          related.some(r => r.linked) ? h('div', { className: 'dcg-hint' }, '右键图谱中属于该会话的蓝色节点也可取消关联') : null))
    }

    function apply(ctx) {
      ctx.effect(() => ctx.slots.inject('conversation.view', () =>
        ctx.slots.register({
          name: 'conversation.view', id: 'graph', order: 20,
          label: () => '图谱',
          inject: (sessionId) => ({ sessionId })
        }, GraphView), 'keyword-graph: view'), 'keyword-graph: view')
    }
    exports.apply = apply
    exports.inject = ['slots']
    exports.linkStyle = linkStyle // 纯函数，供 node --test 单测
    exports.flowLink = flowLink
    exports.unlinkTarget = unlinkTarget
    return module.exports
  }
})