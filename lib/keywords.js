import { STOPWORDS } from './stopwords.js'

const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })

export function tokenize(text) {
  const out = []
  for (const { segment, isWordLike } of segmenter.segment(text)) {
    if (!isWordLike) continue
    const w = segment.toLowerCase()
    if (w.length < 2) continue
    if (STOPWORDS.has(w)) continue
    if (/^[\d\p{P}\p{S}]+$/u.test(w)) continue
    out.push(w)
  }
  return out
}

export function buildKeywords(messages, { df = {}, totalSessions = 1, topN = 25, extraStopwords = [] } = {}) {
  const extra = new Set(extraStopwords)
  const counts = new Map()
  const turnWords = new Map()
  for (const m of messages) {
    for (const w of tokenize(m.text)) {
      if (extra.has(w)) continue
      let c = counts.get(w)
      if (!c) { c = { count: 0, msgs: new Set() }; counts.set(w, c) }
      c.count++
      c.msgs.add(m.seq)
      let tw = turnWords.get(m.turn)
      if (!tw) { tw = new Set(); turnWords.set(m.turn, tw) }
      tw.add(w)
    }
  }
  const scored = [...counts.entries()].map(([word, c]) => ({
    word,
    count: c.count,
    msgs: [...c.msgs].sort((a, b) => a - b),
    score: c.count * (Math.log((totalSessions + 1) / ((Object.hasOwn(df, word) ? df[word] : 0) + 1)) + 1)
  }))
  scored.sort((a, b) => b.score - a.score || b.count - a.count || a.word.localeCompare(b.word))
  const keywords = scored.slice(0, Math.min(topN, 30))
  const top = new Set(keywords.map(k => k.word))
  const pairWeight = new Map()
  for (const tw of turnWords.values()) {
    const ws = [...tw].filter(w => top.has(w)).sort()
    for (let i = 0; i < ws.length; i++)
      for (let j = i + 1; j < ws.length; j++) {
        const key = ws[i] + '\u0000' + ws[j]
        pairWeight.set(key, (pairWeight.get(key) ?? 0) + 1)
      }
  }
  const edges = [...pairWeight.entries()].map(([key, weight]) => {
    const [a, b] = key.split('\u0000')
    return { a, b, weight }
  })
  return { keywords, edges }
}
