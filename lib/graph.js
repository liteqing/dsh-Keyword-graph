export const SESSION_RADIUS = 8
const MIN_TOPIC_RADIUS = 4
const BASE_TOPIC_RADIUS = 10
const TOPIC_RADIUS_SPAN = 3
const clamp01 = (v) => Math.min(1, Math.max(0, v))

export function nodeRadius(node) {
  if (typeof node.r === 'number') return node.r
  return node.kind === 'session' ? SESSION_RADIUS : MIN_TOPIC_RADIUS
}

export function buildGraph(current, linkedIndexes = []) {
  const nodes = new Map()
  const linkMap = new Map()
  const addLink = (source, target, kind, weight, dist) => {
    const key = kind + '|' + source + '|' + target
    const old = linkMap.get(key)
    if (!old) {
      linkMap.set(key, { source, target, kind, weight, ...(kind === 'cooccur' ? { dist } : {}) })
      return
    }
    if (kind === 'cooccur' && typeof dist === 'number' && typeof old.dist === 'number') {
      const total = old.weight + weight
      old.dist = total > 0 ? (old.dist * old.weight + dist * weight) / total : dist
      old.weight = total
    } else {
      old.weight += weight
      if (kind === 'cooccur' && typeof dist === 'number') old.dist = dist
    }
  }
  for (const idx of [current, ...linkedIndexes]) {
    if (!idx) continue
    const sid = 's:' + idx.sessionId
    nodes.set(sid, { id: sid, kind: 'session', label: idx.title ?? idx.sessionId, val: 1, sessionId: idx.sessionId })
    for (const kw of idx.keywords ?? []) {
      const tid = 't:' + kw.word
      let t = nodes.get(tid)
      if (!t) {
        t = { id: tid, kind: 'topic', label: kw.label ?? kw.word, word: kw.word, val: 0, freq: 0, desc: kw.desc ?? '', msgs: [] }
        nodes.set(tid, t)
      } else if (!t.desc && kw.desc) t.desc = kw.desc
      t.val += kw.score
      t.freq += kw.count ?? kw.msgs?.length ?? 0
      for (const seq of kw.msgs ?? []) t.msgs.push({ s: idx.sessionId, seq })
      addLink(tid, sid, 'member', kw.score)
    }
    for (const e of idx.edges ?? []) addLink('t:' + e.a, 't:' + e.b, 'cooccur', e.weight, e.dist)
  }
  const nodeList = [...nodes.values()]
  // 半径按全图最大词频归一化。短对话（maxFreq≤20）保持 4–10px 的温和曲线；
  // 长对话小幅抬高上限（最多 13px）：最小节点固定 4px，区分度从旧版 5 倍收窄到约 3 倍
  const maxFreq = Math.max(0, ...nodeList.filter(n => n.kind === 'topic').map(n => n.freq))
  const maxR = BASE_TOPIC_RADIUS + TOPIC_RADIUS_SPAN * clamp01((maxFreq - 20) / 60)
  const gamma = 0.5 + 0.7 * clamp01(maxFreq / 80)
  for (const n of nodeList) {
    if (n.kind === 'session') n.r = SESSION_RADIUS
    else if (maxFreq > 0) n.r = MIN_TOPIC_RADIUS + (maxR - MIN_TOPIC_RADIUS) * Math.pow(n.freq / maxFreq, gamma)
    else n.r = MIN_TOPIC_RADIUS
  }
  const linkList = [...linkMap.values()]
  const co = linkList.filter(l => l.kind === 'cooccur' && typeof l.dist === 'number')
  if (co.length) {
    const dmin = Math.min(...co.map(l => l.dist))
    const dmax = Math.max(...co.map(l => l.dist))
    for (const l of co) l.distNorm = dmax > dmin ? (l.dist - dmin) / (dmax - dmin) : 0
  }
  return { nodes: nodeList, links: linkList }
}