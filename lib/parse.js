function joinText(content) {
  if (!Array.isArray(content)) return ''
  return content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n').trim()
}

export function snippet(text, n = 80) {
  return text.length > n ? text.slice(0, n) + '…' : text
}

export function extractSession(records) {
  const meta = { sessionId: null, title: null, createdAt: null, updatedAt: null, cwd: null }
  const messages = []
  let turn = 0
  for (const r of records) {
    if (!r || typeof r !== 'object') continue
    switch (r.type) {
      case 'session':
        meta.sessionId = r.id ?? meta.sessionId
        meta.createdAt = r.createdAt ?? meta.createdAt
        meta.cwd = r.cwd ?? meta.cwd
        break
      case 'session/title':
        if (typeof r.data?.title === 'string') meta.title = r.data.title
        break
      case 'turn/start':
        turn = typeof r.data?.turn === 'number' ? r.data.turn : turn + 1
        break
      case 'user/message': {
        const text = joinText(r.data?.content)
        if (text) messages.push({ seq: r.seq, role: 'user', time: r.time, turn, text })
        break
      }
      case 'assistant/message': {
        if (typeof r.data?.turn === 'number') turn = r.data.turn
        const text = joinText(r.data?.message?.content)
        if (text) messages.push({ seq: r.seq, role: 'assistant', time: r.time, turn, text })
        break
      }
    }
    if (typeof r.time === 'number') meta.updatedAt = r.time
  }
  return { meta, messages }
}