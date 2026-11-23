import test from 'node:test'
import assert from 'node:assert/strict'
import { tokenize, tokenizeWithPositions, buildKeywords, keywordThreshold } from '../lib/keywords.js'

// 动态门槛下，短对话至少要出现 12 次（或 5 轮内爆发 8 次）才可能成为关键词，
// 所以固定语料都按真实短会话的量级造词。
const MSGS = [
  { seq: 1, role: 'user', turn: 1, text: ('物理 '.repeat(7) + 'lrose '.repeat(6)).trim() },
  { seq: 2, role: 'assistant', turn: 1, text: ('物理 '.repeat(6) + 'lrose '.repeat(6)).trim() },
  { seq: 3, role: 'user', turn: 2, text: '再看看情人节皮肤' }
]

test('tokenize 去停用词/短词/纯符号', () => {
  const ws = tokenize('帮我把物理改一下，123 !!!')
  assert.ok(ws.includes('物理'))
  assert.ok(!ws.includes('帮我'))
  assert.ok(!ws.includes('把'))
  assert.ok(!ws.includes('123'))
})

test('tokenizeWithPositions 给出原文位置且递增', () => {
  const tokens = tokenizeWithPositions('帮我把lrose的物理改一下')
  const lrose = tokens.find(t => t.w === 'lrose')
  assert.equal(lrose.pos, 3)
  for (let i = 1; i < tokens.length; i++) assert.ok(tokens[i].pos > tokens[i - 1].pos)
})

test('buildKeywords 词频排序+消息定位+文本距离边', () => {
  const { keywords, edges } = buildKeywords(MSGS, { df: { 物理: 1, lrose: 1, 情人节: 3 }, totalSessions: 4 })
  const top = keywords[0]
  assert.equal(top.word, '物理')           // 本会话 13 次且别处罕见
  assert.deepEqual(top.msgs, [1, 2])
  const e = edges.find(x => (x.a === 'lrose' && x.b === '物理') || (x.a === '物理' && x.b === 'lrose'))
  // 两条消息里最近距离都是 3 → 2 × 1/(1+3/60) ≈ 1.9
  assert.ok(Math.abs(e.weight - 1.9) < 0.02)
  assert.equal(e.dist, 3)
})

test('同消息内距离过远（>窗口）不生成边', () => {
  // 用拉丁词避免中文分词歧义（'情人节' 会被切成 '情人'+'节'）。
  // 两词各出现 8 次（靠局部爆发过门槛），但相隔 8000 字，累计强度仍 < 0.5。
  const far = [{ seq: 1, role: 'user', turn: 1, text: 'physics '.repeat(8) + '，'.repeat(8000) + 'valentine '.repeat(8) }]
  const { keywords, edges } = buildKeywords(far)
  assert.deepEqual(keywords.map(k => k.word).sort(), ['physics', 'valentine'])
  assert.equal(edges.length, 0)
})

test('边降噪：最多 40 条、每词最多 4 条、每个词至少有一条边', () => {
  // 20 个拉丁词，每个出现 12 次（凑够短对话门槛）；相邻距离 6 字、最远 114 字。
  // 重复也让远距离词对的累计强度过阈值，正好压一压降噪上限。
  const round = Array.from({ length: 20 }, (_, i) => 'word' + i).join(' ')
  const text = Array.from({ length: 12 }, () => round).join(' ')
  const { keywords, edges } = buildKeywords([{ seq: 1, role: 'user', turn: 1, text }], { topN: 30 })
  assert.equal(keywords.length, 20)
  assert.ok(edges.length <= 40)
  for (let i = 1; i < edges.length; i++) assert.ok(edges[i - 1].weight >= edges[i].weight)
  assert.ok(edges.every(e => e.weight >= 0.5))
  const degree = new Map()
  for (const e of edges) {
    degree.set(e.a, (degree.get(e.a) ?? 0) + 1)
    degree.set(e.b, (degree.get(e.b) ?? 0) + 1)
  }
  assert.equal(degree.size, 20)                        // 没有孤立关键词
  assert.ok([...degree.values()].every(d => d <= 4))   // 每个词最多 4 条
})

test('关键词保留原始大小写，并带词频与 10 字内上下文描述', () => {
  const { keywords } = buildKeywords([
    { seq: 1, role: 'user', turn: 1, text: 'WestPlay '.repeat(12) + '纹理加载有问题 WestPlay 又出现' }
  ], { topN: 30 })
  const k = keywords.find(x => x.word === 'westplay')
  assert.ok(k)
  assert.equal(k.label, 'WestPlay')
  assert.equal(k.count, 13)
  assert.ok(k.desc.length <= 10)
  assert.ok(k.desc.includes('WestPlay'))
})

test('df 原型链键（constructor）不产生 NaN 分数', () => {
  const msgs = [
    { seq: 1, role: 'user', turn: 1, text: 'constructor '.repeat(8) + '是什么' },
    { seq: 2, role: 'assistant', turn: 1, text: 'constructor '.repeat(4) + '是构造函数' }
  ]
  const { keywords } = buildKeywords(msgs) // 默认 df = {}
  assert.ok(keywords.every(k => Number.isFinite(k.score)))
  const ctor = keywords.find(k => k.word === 'constructor')
  assert.ok(ctor)
  // df=0、totalSessions=1 → idf = ln((1+1)/(0+1)) + 1 = ln2 + 1
  assert.ok(Math.abs(ctor.score - ctor.count * (Math.log(2) + 1)) < 1e-9)
})

test('extraStopwords：配置词命中语料 → 不进关键词与边', () => {
  const stopMsgs = [
    { seq: 1, role: 'user', turn: 1, text: '物理 '.repeat(12) },
    { seq: 2, role: 'assistant', turn: 1, text: 'lrose '.repeat(12) }
  ]
  const { keywords, edges } = buildKeywords(stopMsgs, { df: { 物理: 1, lrose: 1 }, totalSessions: 4, extraStopwords: ['物理'] })
  assert.ok(keywords.length > 0)
  assert.ok(keywords.every(k => k.word !== '物理'))
  assert.ok(edges.every(e => e.a !== '物理' && e.b !== '物理'))
})

test('topN 上限 30', () => {
  // 用拉丁词避免分词器把 '词0' 拆成单字导致关键词为空、测试空转；
  // 每个词出现 12 次，保证全部过短对话门槛。
  const text = Array.from({ length: 60 }, (_, i) => ('word' + i + ' ').repeat(12)).join('')
  const many = [{ seq: 1, role: 'user', turn: 1, text }]
  const { keywords } = buildKeywords(many, { topN: 99 })
  assert.equal(keywords.length, 30)
  assert.equal(new Set(keywords.map(k => k.word)).size, 30)
  const capped = buildKeywords(many).keywords
  assert.equal(capped.length, 25)
  assert.equal(new Set(capped.map(k => k.word)).size, 25)
})

test('门槛公式：随轮次增长，钳制在 12–50；局部爆发阈为其中 60%（8–30）', () => {
  assert.deepEqual(keywordThreshold(0), { minCount: 12, burst: 8 })
  assert.deepEqual(keywordThreshold(6), { minCount: 12, burst: 8 })    // round(7.2)=7 → 下限 8
  assert.deepEqual(keywordThreshold(100), { minCount: 42, burst: 25 })
  assert.deepEqual(keywordThreshold(1000), { minCount: 50, burst: 30 })
})

test('动态门槛：长对话要更高词频；5 轮局部爆发可破格', () => {
  const msgs = []
  // alpha 41 次、beta 42 次，每轮各 1 次；100 轮门槛 42 → alpha 淘汰
  for (let t = 1; t <= 41; t++) {
    msgs.push({ seq: t, role: 'user', turn: t, text: 'alpha beta' })
  }
  msgs.push({ seq: 42, role: 'user', turn: 42, text: 'beta' })
  // gamma 26 次集中在 50–54 轮（爆发阈 25）→ 破格；delta 24 次集中 50–53 轮 → 淘汰
  const burst = { 50: [6, 6], 51: [5, 6], 52: [5, 6], 53: [5, 6], 54: [5, 0] }
  for (const [t, [g, d]] of Object.entries(burst)) {
    msgs.push({ seq: 1000 + Number(t), role: 'user', turn: Number(t), text: ('gamma '.repeat(g) + 'delta '.repeat(d)).trim() })
  }
  msgs.push({ seq: 2000, role: 'user', turn: 100, text: 'filler' })
  const words = buildKeywords(msgs).keywords.map(k => k.word)
  assert.ok(words.includes('beta'))
  assert.ok(words.includes('gamma'))
  assert.ok(!words.includes('alpha'))
  assert.ok(!words.includes('delta'))
})

test('动态门槛：短对话门槛 12；8 次局部爆发可破格，分散 4+4 不行', () => {
  const msgs = []
  for (let t = 1; t <= 6; t++) {
    // alpha 共 7 次且分散（12 门槛淘汰，5 轮窗口也到不了 8）；beta 共 12 次（入选）
    const a = t === 1 ? 2 : 1
    msgs.push({ seq: t, role: 'user', turn: t, text: 'alpha '.repeat(a) + 'beta '.repeat(2) })
  }
  // gamma 8 次集中在第 2–3 轮 → 5 轮窗口爆发破格
  msgs.push({ seq: 20, role: 'user', turn: 2, text: 'gamma '.repeat(4) })
  msgs.push({ seq: 21, role: 'user', turn: 3, text: 'gamma '.repeat(4) })
  // delta 4 次在第 1 轮、4 次在第 6 轮：任何 5 轮窗口都只有 4 次 → 淘汰
  msgs.push({ seq: 30, role: 'user', turn: 1, text: 'delta '.repeat(4) })
  msgs.push({ seq: 31, role: 'user', turn: 6, text: 'delta '.repeat(4) })
  const words = buildKeywords(msgs).keywords.map(k => k.word)
  assert.ok(words.includes('beta'))
  assert.ok(words.includes('gamma'))
  assert.ok(!words.includes('alpha'))
  assert.ok(!words.includes('delta'))
})