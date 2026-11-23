import test from 'node:test'
import assert from 'node:assert/strict'
import { tokenize, buildKeywords } from '../lib/keywords.js'

const MSGS = [
  { seq: 1, role: 'user', turn: 1, text: '帮我把lrose的物理改一下，物理太果冻了' },
  { seq: 2, role: 'assistant', turn: 1, text: '物理参数已调整，lrose的胸臀不再果冻' },
  { seq: 3, role: 'user', turn: 2, text: '再看看情人节皮肤' }
]

test('tokenize 去停用词/短词/纯符号', () => {
  const ws = tokenize('帮我把物理改一下，123 !!!')
  assert.ok(ws.includes('物理'))
  assert.ok(!ws.includes('帮我'))
  assert.ok(!ws.includes('把'))
  assert.ok(!ws.includes('123'))
})

test('buildKeywords 词频排序+消息定位+共现边', () => {
  const { keywords, edges } = buildKeywords(MSGS, { df: { 物理: 1, lrose: 1, 情人节: 3 }, totalSessions: 4 })
  const top = keywords[0]
  assert.equal(top.word, '物理')           // 本会话3次且别处罕见
  assert.deepEqual(top.msgs, [1, 2])
  const e = edges.find(x => (x.a === 'lrose' && x.b === '物理') || (x.a === '物理' && x.b === 'lrose'))
  assert.equal(e.weight, 1)                // 同轮共现1次
  assert.ok(keywords.every(k => k.word !== '帮我'))
})

test('topN 上限 30', () => {
  // 用拉丁词避免分词器把 '词0' 拆成单字导致关键词为空、测试空转
  const many = Array.from({ length: 60 }, (_, i) => ({ seq: i, role: 'user', turn: i, text: 'word' + i + ' word' + i }))
  const { keywords } = buildKeywords(many, { topN: 99 })
  assert.equal(keywords.length, 30)
  assert.equal(new Set(keywords.map(k => k.word)).size, 30)
  const capped = buildKeywords(many).keywords
  assert.equal(capped.length, 25)
  assert.equal(new Set(capped.map(k => k.word)).size, 25)
})