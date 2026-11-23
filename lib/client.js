/**
 * dsh-convo-graph —— 客户端半边：会话顶栏「图谱」标签
 *
 * 数据流：GraphView ⇄ /dsh-graph/api?op=session|related|message|link|config（同源 fetch）
 * 渲染：force-graph（canvas 力导向），vendor 由宿主 /dsh-graph/vendor/* 提供。
 *
 * 控制器裁决落地：
 *   R15：d3-force UMD 依赖 d3-quadtree/d3-dispatch/d3-timer（挂 window.d3），
 *        必须按序先加载这三个，再 d3-force，最后 force-graph（window.ForceGraph），
 *        否则 forceCollide 直接抛错。
 *   R4：nodeCanvasObject 不读 React state（闭包会过期；引擎冷却后 canvas 静止，
 *        hover/选中变化不会自动重绘）→ selRef/cfgRef 镜像 + hoverRef，
 *        onNodeHover / 选中变化后调 FG.refresh() 立即重绘。
 *   生长动画：bornRef 只在引擎 tick 期间生效；数据变化会重建实例并重新加热，
 *        新节点仍能生长出现，不额外加动画循环。
 */
window.__ModuleLoader__.load({
  id: 'dsh-convo-graph',
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
      })), Promise.resolve())
      return vendorPromise
    }
    const radius = (n) => n.kind === 'session' ? 9 : 4 + Math.sqrt(n.val) * 2
    const isDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches
    // 鲸鱼蓝：cfg.accent 可覆盖；默认浅色 #2563eb / 深色 #5b8cff
    const accent = (cfg) => cfg?.accent || (isDark() ? '#5b8cff' : '#2563eb')

    function GraphView({ sessionId }) {
      const boxRef = useRef(null)
      const fgRef = useRef(null)
      const posRef = useRef(new Map())   // 旧节点坐标，增量更新不跳位
      const bornRef = useRef(new Map())  // 新节点生长动画起点
      const sigRef = useRef('')          // 图谱签名：没变化就不重建实例
      const [data, setData] = useState(null)
      const [cfg, setCfg] = useState(null)
      const [sel, setSel] = useState(null)      // 选中的 topic node
      const [full, setFull] = useState(null)    // 消息全文面板
      const [related, setRelated] = useState([])
      const [err, setErr] = useState(null)
      const hoverRef = useRef(null)
      const selRef = useRef(null)        // R4：sel 的镜像，canvas 回调只读 ref
      const cfgRef = useRef(null)        // R4 同类：cfg 镜像，避免 effect 闭包过期

      useEffect(() => { cfgRef.current = cfg }, [cfg])

      const refresh = useCallback(async () => {
        try {
          const [s, r, c] = await Promise.all([
            fetch(API + '?op=session&id=' + encodeURIComponent(sessionId)).then(x => x.json()),
            fetch(API + '?op=related&id=' + encodeURIComponent(sessionId)).then(x => x.json()),
            fetch(API + '?op=config').then(x => x.json())
          ])
          setCfg(c.config); setRelated(r.related ?? []); setErr(null)
          if (s.status === 'ready') {
            const sig = JSON.stringify(s.graph.nodes.map(n => [n.id, n.val])) + '|' + s.graph.links.length + '|' + (s.messages ?? []).length
            if (sig === sigRef.current) return
            sigRef.current = sig
            for (const n of s.graph.nodes) {
              const old = posRef.current.get(n.id)
              if (old) Object.assign(n, { x: old.x, y: old.y, vx: old.vx, vy: old.vy })
              else if (!bornRef.current.has(n.id)) bornRef.current.set(n.id, Date.now())
            }
            setData(s)
          } else setData(prev => prev ?? { status: s.status })
          setErr(null)
        } catch (e) { setErr(String(e.message ?? e)) }
      }, [sessionId])

      useEffect(() => { refresh(); const t = setInterval(refresh, 4000); return () => clearInterval(t) }, [refresh])

      useEffect(() => {
        if (!data?.graph || !boxRef.current) return
        let dead = false
        loadVendor().then(() => {
          if (dead || !boxRef.current) return
          const FG = window.ForceGraph()
          fgRef.current = FG
          FG(boxRef.current)
            .width(boxRef.current.clientWidth).height(boxRef.current.clientHeight)
            .backgroundColor('rgba(0,0,0,0)')
            .nodeId('id').nodeVal(n => radius(n) ** 2)
            .nodeLabel(n => n.label)
            .linkColor(l => l.kind === 'member' ? 'rgba(127,127,127,.35)' : 'rgba(127,127,127,.5)')
            .linkWidth(l => Math.min(3, 0.5 + l.weight * 0.15))
            .nodeCanvasObject((n, ctx2, scale) => {
              const r = radius(n)
              const born = bornRef.current.get(n.id) ?? 0
              const grow = Math.min(1, (Date.now() - born) / 400)
              const hov = hoverRef.current
              const dim = hov && n.id !== hov.id && !(hov.neighbors ?? []).includes(n.id)
              ctx2.globalAlpha = dim ? 0.15 : grow
              // R4：读 selRef/cfgRef，不读 React state（闭包过期）
              const hot = selRef.current?.id === n.id || hov?.id === n.id
              ctx2.fillStyle = n.kind === 'session' ? (isDark() ? '#9aa4b2' : '#556070') : hot ? accent(cfgRef.current) : (isDark() ? '#7d8aa0' : '#8b96a8')
              ctx2.beginPath(); ctx2.arc(n.x, n.y, r * grow, 0, 2 * Math.PI); ctx2.fill()
              if (scale > 0.6) {
                ctx2.fillStyle = isDark() ? '#e6e8eb' : '#2a2f36'
                ctx2.font = `${Math.max(3, 11 / scale)}px sans-serif`
                ctx2.textAlign = 'center'
                ctx2.fillText(n.label, n.x, n.y + r + 12 / scale)
              }
              ctx2.globalAlpha = 1
            })
            .onNodeHover(n => {
              hoverRef.current = n ? { id: n.id, neighbors: (data.graph.links ?? []).filter(l => l.source.id === n.id || l.target.id === n.id || l.source === n.id || l.target === n.id).map(l => (l.source.id ?? l.source) === n.id ? (l.target.id ?? l.target) : (l.source.id ?? l.source)) } : null
              if (boxRef.current) boxRef.current.style.cursor = n ? 'pointer' : 'default'
              FG.refresh()   // R4：引擎冷却后 canvas 静止，hover 淡化需手动重绘
            })
            .onNodeClick(n => {
              if (n.kind === 'topic') {
                selRef.current = n; setSel(n); setFull(null)
                FG.refresh()   // R4：选中鲸鱼蓝立即重绘
              }
              else { FG.centerAt(n.x, n.y, 800); FG.zoom(2.2, 800) }
            })
            .onEngineTick(() => { for (const n of data.graph.nodes) posRef.current.set(n.id, { x: n.x, y: n.y, vx: n.vx, vy: n.vy }) })
          FG.d3Force('collide', window.d3.forceCollide(n => radius(n) + 6))
          FG.d3Force('charge').strength(-120)
          FG.graphData(data.graph)
          const ro = new ResizeObserver(() => FG.width(boxRef.current.clientWidth).height(boxRef.current.clientHeight))
          ro.observe(boxRef.current)
          fgRef.current.__ro = ro
        }).catch(e => setErr(String(e.message ?? e)))
        return () => { dead = true; try { fgRef.current?.__ro?.disconnect(); fgRef.current?._destructor() } catch {} }
      }, [data?.graph, sessionId])   // graph 对象每次 refresh 新建 → 重建实例但坐标已保留

      const openMsg = async (s, seq) => {
        const r = await fetch(API + '?op=message&id=' + encodeURIComponent(s) + '&seq=' + seq).then(x => x.json())
        setFull(r.result)   // API 形状 {ok, result:{message, prev, next}}
      }
      const link = async (other) => {
        await fetch(API + '?op=link', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ a: sessionId, b: other }) })
        refresh()
      }

      const panelMsgs = sel ? (data?.messages ?? []).filter(m => (sel.msgs ?? []).some(x => x.s === sessionId && x.seq === m.seq)) : []
      return h('div', { style: { display: 'flex', height: '100%', color: 'var(--dsw-alias-label-primary)' } },
        h('div', { ref: boxRef, style: { flex: 1, minWidth: 0, position: 'relative' } },
          data?.status === 'indexing' ? h('div', { style: { position: 'absolute', top: 8, left: 8, fontSize: 12, opacity: .7 } }, '索引中…') : null),
        h('div', { style: { width: 320, overflow: 'auto', borderLeft: '.5px solid var(--dsw-alias-border-l2)', padding: 12 } },
          err ? h('div', { style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 12 } }, err) : null,
          sel ? h('div', null,
            h('h3', { style: { margin: '0 0 8px', fontSize: 14 } }, '主题：' + sel.label),
            panelMsgs.map(m => h('div', { key: m.seq, onClick: () => openMsg(sessionId, m.seq), style: { padding: '6px 0', borderBottom: '.5px solid var(--dsw-alias-border-l2)', cursor: 'pointer', fontSize: 12 } },
              h('b', null, m.role === 'user' ? '我' : 'AI'), ' · ', m.snippet))) : null,
          full ? h('div', { style: { marginTop: 10, fontSize: 12, whiteSpace: 'pre-wrap' } },
            full.prev ? h('div', { style: { opacity: .6 } }, '上一条：' + full.prev.text.slice(0, 120)) : null,
            h('div', { style: { margin: '8px 0', padding: 8, background: 'rgba(127,127,127,.08)', borderRadius: 8 } }, full.message.text),
            full.next ? h('div', { style: { opacity: .6 } }, '下一条：' + full.next.text.slice(0, 120)) : null) : null,
          h('h3', { style: { margin: '14px 0 6px', fontSize: 13 } }, '相关会话'),
          related.map(r => h('div', { key: r.sessionId, style: { display: 'flex', justifyContent: 'space-between', gap: 8, padding: '5px 0', fontSize: 12 } },
            h('span', null, r.title, h('span', { style: { opacity: .6 } }, '（' + r.shared.join('、') + '）')),
            h('button', { onClick: () => link(r.sessionId), style: { cursor: 'pointer' } }, '关联')))))
    }

    function apply(ctx) {
      ctx.effect(() => ctx.slots.inject('conversation.view', () =>
        ctx.slots.register({
          name: 'conversation.view', id: 'graph', order: 20,
          label: () => '图谱',
          inject: (sessionId) => ({ sessionId })
        }, GraphView), 'convo-graph: view'), 'convo-graph: view')
    }
    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  }
})
