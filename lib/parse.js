function joinText(content) {
  if (!Array.isArray(content)) return ''
  return content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n').trim()
}

export function snippet(text, n = 80) {
  return text.length > n ? text.slice(0, n) + '…' : text
}

// 已知关键词位置时截取前后文（默认前 120 字、后 360 字），截断处加省略号。
// 面板默认只露 7 行，关键词落在第 4–5 行附近。
export function excerptAt(text, idx, len, { before = 120, after = 360 } = {}) {
  if (!text || !Number.isFinite(idx) || idx < 0) return null
  let start = Math.max(0, idx - before)
  let end = Math.min(text.length, idx + (len || 0) + after)
  // 避免切开代理对（emoji 等），否则半个字符会渲染成乱码
  if (start > 0 && text.charCodeAt(start) >= 0xdc00 && text.charCodeAt(start) <= 0xdfff) start++
  if (end < text.length && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end--
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '')
}

export function excerptAround(text, word, opts) {
  if (!text || !word) return null
  const idx = text.toLowerCase().indexOf(word.toLowerCase())
  if (idx < 0) return null
  return excerptAt(text, idx, word.length, opts)
}

// 个别助手记录会把 DSH 的时间上下文拼在正文开头（实测 40 个会话中出现 1 次），
// 只剥离这几个已知前缀行，不碰正文。
const INJECTED_PREAMBLE = [
  /^Time sampled while preparing turn \d+, step \d+:.*$/,
  /^Browser time zone for this request:.*$/,
  /^Elapsed since the preceding model-visible message:.*$/
]
function stripPreamble(text) {
  const lines = text.split('\n')
  let i = 0
  while (i < lines.length && (lines[i].trim() === '' || INJECTED_PREAMBLE.some(re => re.test(lines[i].trim())))) i++
  return lines.slice(i).join('\n').trim()
}

// 注入消息（system-reminder / 技能目录 / 运行时快照 / 时间上下文 / 后台任务通知）
// 也走 user/message 记录；只有 source.kind=user 才是真人发言。
function isUserAuthored(r) {
  return r.data?.source?.kind === 'user'
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
        if (!isUserAuthored(r)) break
        const text = joinText(r.data?.content)
        if (text) messages.push({ seq: r.seq, role: 'user', time: r.time, turn, text })
        break
      }
      case 'assistant/message': {
        if (typeof r.data?.turn === 'number') turn = r.data.turn
        const text = stripPreamble(joinText(r.data?.message?.content))
        if (text) messages.push({ seq: r.seq, role: 'assistant', time: r.time, turn, text })
        break
      }
    }
    if (typeof r.time === 'number') meta.updatedAt = r.time
  }
  return { meta, messages }
}