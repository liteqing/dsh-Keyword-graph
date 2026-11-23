export function nodeRadius(node) {
  return node.kind === 'session' ? 9 : 4 + Math.sqrt(node.val) * 2
}

export function buildGraph(current, linkedIndexes = []) {
  const nodes = new Map()
  const linkMap = new Map()
  const addLink = (source, target, kind, weight) => {
    const key = kind + '|' + source + '|' + target
    const old = linkMap.get(key)
    if (old) old.weight += weight
    else linkMap.set(key, { source, target, kind, weight })
  }
  for (const idx of [current, ...linkedIndexes]) {
    if (!idx) continue
    const sid = 's:' + idx.sessionId
    nodes.set(sid, { id: sid, kind: 'session', label: idx.title ?? idx.sessionId, val: 1, sessionId: idx.sessionId })
    for (const kw of idx.keywords ?? []) {
      const tid = 't:' + kw.word
      let t = nodes.get(tid)
      if (!t) { t = { id: tid, kind: 'topic', label: kw.word, val: 0, msgs: [] }; nodes.set(tid, t) }
      t.val += kw.score
      for (const seq of kw.msgs ?? []) t.msgs.push({ s: idx.sessionId, seq })
      addLink(tid, sid, 'member', kw.score)
    }
    for (const e of idx.edges ?? []) addLink('t:' + e.a, 't:' + e.b, 'cooccur', e.weight)
  }
  return { nodes: [...nodes.values()], links: [...linkMap.values()] }
}
