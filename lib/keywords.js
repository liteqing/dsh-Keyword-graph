import { STOPWORDS } from './stopwords.js'

const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })

// 两个词在同一条消息里的字符距离 → 关系强度：距离 0 字记 1 分，60 字记 0.5 分
const PROXIMITY_WINDOW = 60
const MIN_PAIR_WEIGHT = 0.5
const MAX_EDGES = 40
const MAX_DEGREE = 4
const DESC_MAX = 10

// 关键词门槛随对话轮次增长：短会话十几二十次，长会话四五十次。
// 局部爆发（任意连续 5 轮内累计）可按门槛的 60% 破格，避免跨阶段主题被整段平均掉。
const MIN_COUNT_FLOOR = 12
const MIN_COUNT_CEIL = 50
const BURST_TURNS = 5
const BURST_FLOOR = 8
const BURST_CEIL = 30

export function keywordThreshold(maxTurn) {
  const turns = Number.isFinite(maxTurn) ? maxTurn : 0
  const minCount = Math.min(MIN_COUNT_CEIL, Math.max(MIN_COUNT_FLOOR, Math.round(10 + 0.32 * turns)))
  const burst = Math.min(BURST_CEIL, Math.max(BURST_FLOOR, Math.round(minCount * 0.6)))
  return { minCount, burst }
}

// 任意连续 5 轮窗口内的最大出现次数（只在出现过的轮次上滑窗）
function maxBurst(turns) {
  const entries = [...turns.entries()].sort((a, b) => a[0] - b[0])
  let best = 0, sum = 0, j = 0
  for (let i = 0; i < entries.length; i++) {
    while (j < entries.length && entries[j][0] - entries[i][0] < BURST_TURNS) { sum += entries[j][1]; j++ }
    if (sum > best) best = sum
    sum -= entries[i][1]
  }
  return best
}

export function tokenizeWithPositions(text) {
  const out = []
  for (const { segment, index, isWordLike } of segmenter.segment(text)) {
    if (!isWordLike) continue
    const w = segment.toLowerCase()
    if (w.length < 2) continue
    if (STOPWORDS.has(w)) continue
    if (/^[\d\p{P}\p{S}]+$/u.test(w)) continue
    out.push({ w, raw: segment, pos: index })
  }
  return out
}

export function tokenize(text) {
  return tokenizeWithPositions(text).map(t => t.w)
}

// 首次出现处往后截 10 字，作为悬停详情里的对话上下文
function contextDesc(text, pos) {
  if (!text) return ''
  let s = text.slice(pos, pos + DESC_MAX).replace(/\s+/g, ' ').trim()
  if (s.length < 4) s = text.slice(Math.max(0, pos - 4), pos + DESC_MAX - 4).replace(/\s+/g, ' ').trim()
  return s.slice(0, DESC_MAX)
}

function minDistance(xs, ys) {
  let i = 0, j = 0, best = Infinity
  while (i < xs.length && j < ys.length) {
    const d = Math.abs(xs[i] - ys[j])
    if (d < best) best = d
    if (xs[i] < ys[j]) i++
    else j++
  }
  return best
}

export function buildKeywords(messages, { df = {}, totalSessions = 1, topN = 25, extraStopwords = [] } = {}) {
  const extra = new Set(extraStopwords)
  const counts = new Map()
  const tokenized = []
  let maxTurn = 0
  for (const m of messages) {
    const turn = Number.isFinite(m.turn) ? m.turn : 0
    if (turn > maxTurn) maxTurn = turn
    const tokens = tokenizeWithPositions(m.text).filter(t => !extra.has(t.w))
    tokenized.push({ seq: m.seq, tokens })
    for (const t of tokens) {
      let c = counts.get(t.w)
      if (!c) { c = { count: 0, msgs: new Set(), turns: new Map(), label: t.raw, firstSeq: m.seq, firstPos: t.pos }; counts.set(t.w, c) }
      c.count++
      c.msgs.add(m.seq)
      c.turns.set(turn, (c.turns.get(turn) ?? 0) + 1)
    }
  }
  const { minCount, burst } = keywordThreshold(maxTurn)
  // 总次数连爆发阈都不到的词不必滑窗；绝大多数生僻词会在这里被直接排除
  const qualified = [...counts.entries()].filter(([, c]) =>
    c.count >= minCount || (c.count >= burst && maxBurst(c.turns) >= burst))
  const scored = qualified.map(([word, c]) => ({
    word,
    label: c.label,
    count: c.count,
    msgs: [...c.msgs].sort((a, b) => a - b),
    score: c.count * (Math.log((totalSessions + 1) / ((Object.hasOwn(df, word) ? df[word] : 0) + 1)) + 1),
    firstSeq: c.firstSeq,
    firstPos: c.firstPos
  }))
  scored.sort((a, b) => b.score - a.score || b.count - a.count || a.word.localeCompare(b.word))
  const textBySeq = new Map(messages.map(m => [m.seq, m.text]))
  const keywords = scored.slice(0, Math.min(topN, 30)).map(k => ({
    word: k.word,
    label: k.label,
    count: k.count,
    msgs: k.msgs,
    score: k.score,
    desc: contextDesc(textBySeq.get(k.firstSeq), k.firstPos)
  }))
  const top = new Set(keywords.map(k => k.word))
  const pairs = new Map()
  for (const { tokens } of tokenized) {
    const positions = new Map()
    for (const t of tokens) {
      if (!top.has(t.w)) continue
      const arr = positions.get(t.w)
      if (arr) arr.push(t.pos); else positions.set(t.w, [t.pos])
    }
    if (positions.size < 2) continue
    const words = [...positions.keys()].sort()
    for (let i = 0; i < words.length; i++) {
      for (let j = i + 1; j < words.length; j++) {
        const a = words[i], b = words[j]
        const d = minDistance(positions.get(a), positions.get(b))
        if (!Number.isFinite(d)) continue
        const key = a + '\u0000' + b
        let p = pairs.get(key)
        if (!p) { p = { weight: 0, distSum: 0, n: 0 }; pairs.set(key, p) }
        p.weight += 1 / (1 + d / PROXIMITY_WINDOW)
        p.distSum += d
        p.n++
      }
    }
  }
  const sorted = [...pairs.entries()]
    .filter(([, p]) => p.weight >= MIN_PAIR_WEIGHT)
    .map(([key, p]) => {
      const [a, b] = key.split('\u0000')
      return { key, a, b, weight: Math.round(p.weight * 100) / 100, dist: Math.round(p.distSum / p.n) }
    })
    .sort((x, y) => y.weight - x.weight || x.dist - y.dist || x.a.localeCompare(y.a) || x.b.localeCompare(y.b))
  // 降噪：先保证每个词至少一条最强边，再补足到每词 ≤4 条、全局 ≤40 条
  const degree = new Map()
  const picked = []
  const pickedKeys = new Set()
  const push = (e) => {
    picked.push(e)
    pickedKeys.add(e.key)
    degree.set(e.a, (degree.get(e.a) ?? 0) + 1)
    degree.set(e.b, (degree.get(e.b) ?? 0) + 1)
  }
  for (const e of sorted) {
    if (picked.length >= MAX_EDGES) break
    if ((degree.get(e.a) ?? 0) === 0 || (degree.get(e.b) ?? 0) === 0) push(e)
  }
  for (const e of sorted) {
    if (picked.length >= MAX_EDGES) break
    if (pickedKeys.has(e.key)) continue
    if ((degree.get(e.a) ?? 0) >= MAX_DEGREE || (degree.get(e.b) ?? 0) >= MAX_DEGREE) continue
    push(e)
  }
  const edges = picked
    .sort((x, y) => y.weight - x.weight || x.dist - y.dist || x.a.localeCompare(y.a) || x.b.localeCompare(y.b))
    .map(({ a, b, weight, dist }) => ({ a, b, weight, dist }))
  return { keywords, edges }
}