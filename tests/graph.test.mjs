import test from 'node:test'
import assert from 'node:assert/strict'
import { buildGraph, nodeRadius } from '../lib/graph.js'

const A = {
  sessionId: 'a', title: '会话A',
  keywords: [
    { word: '物理', label: '物理', count: 12, score: 8, msgs: [1, 2] },
    { word: 'lrose', label: 'lrose', count: 5, score: 5, msgs: [2] }
  ],
  edges: [{ a: 'lrose', b: '物理', weight: 3, dist: 10 }]
}
const B = {
  sessionId: 'b', title: '会话B',
  keywords: [{ word: '物理', label: '物理', count: 4, score: 4, msgs: [7] }],
  edges: []
}

test('共享主题合并为单节点并连两个会话', () => {
  const { nodes, links } = buildGraph(A, [B])
  const topics = nodes.filter(n => n.kind === 'topic')
  assert.equal(topics.length, 2)
  const phys = topics.find(n => n.label === '物理')
  assert.equal(phys.word, '物理')  // 面板检索用规范化小写词
  assert.equal(phys.val, 12)
  assert.equal(phys.freq, 16)     // 词频跨会话累加
  assert.deepEqual(phys.msgs, [{ s: 'a', seq: 1 }, { s: 'a', seq: 2 }, { s: 'b', seq: 7 }])
  const members = links.filter(l => l.kind === 'member' && l.source === 't:物理')
  assert.deepEqual(members.map(l => l.target).sort(), ['s:a', 's:b'])
  assert.equal(nodes.filter(n => n.kind === 'session').length, 2)
})

test('共现边跨会话同 pair 合并权重，距离按权重加权平均', () => {
  const B2 = { ...B, edges: [{ a: 'lrose', b: '物理', weight: 2, dist: 20 }] }
  const { links } = buildGraph(A, [B2])
  const co = links.filter(l => l.kind === 'cooccur')
  assert.equal(co.length, 1)
  assert.equal(co[0].weight, 5)
  assert.equal(Math.round(co[0].dist), 14)   // (3*10 + 2*20) / 5
})

test('短对话半径温和：最大词频 16 时上限 10，会话固定 8', () => {
  const { nodes } = buildGraph(A, [B])
  const phys = nodes.find(n => n.id === 't:物理')
  const rose = nodes.find(n => n.id === 't:lrose')
  const gamma = 0.5 + 0.7 * (16 / 80)
  assert.ok(Math.abs(phys.r - 10) < 1e-9)
  assert.ok(Math.abs(rose.r - (4 + 6 * Math.pow(5 / 16, gamma))) < 1e-9)
  assert.ok(nodes.filter(n => n.kind === 'topic').every(n => n.r >= 4 && n.r <= 10 + 1e-9))
  assert.ok(nodes.filter(n => n.kind === 'session').every(n => n.r === 8))
})

test('长对话拉开大小差：76 次≈13px、30 次≈7px，且上限随最大词频抬升', () => {
  const L = {
    sessionId: 'l', title: 'L',
    keywords: [
      { word: 'hot', label: 'hot', count: 76, score: 1, msgs: [] },
      { word: 'mid', label: 'mid', count: 30, score: 1, msgs: [] }
    ],
    edges: []
  }
  const nodes = buildGraph(L).nodes
  const hot = nodes.find(n => n.id === 't:hot')
  const mid = nodes.find(n => n.id === 't:mid')
  const maxR = 10 + 3 * ((76 - 20) / 60)
  const gamma = 0.5 + 0.7 * (76 / 80)
  assert.ok(Math.abs(hot.r - maxR) < 1e-9)
  assert.ok(Math.abs(mid.r - (4 + (maxR - 4) * Math.pow(30 / 76, gamma))) < 1e-9)
  assert.ok(hot.r - mid.r > 5)   // 旧曲线下差 10.7px，现在约 6px
})

test('共现边距离归一化 distNorm：最近 0、最远 1、单边 0', () => {
  const C = {
    sessionId: 'c', title: 'C',
    keywords: [
      { word: 'a', count: 1, score: 1, msgs: [1] },
      { word: 'b', count: 1, score: 1, msgs: [1] },
      { word: 'c', count: 1, score: 1, msgs: [1] }
    ],
    edges: [{ a: 'a', b: 'b', weight: 1, dist: 4 }, { a: 'b', b: 'c', weight: 1, dist: 24 }]
  }
  const co = buildGraph(C).links.filter(l => l.kind === 'cooccur')
  const ab = co.find(l => l.source === 't:a' && l.target === 't:b')
  const bc = co.find(l => l.source === 't:b' && l.target === 't:c')
  assert.equal(ab.distNorm, 0)
  assert.equal(bc.distNorm, 1)
  const single = buildGraph(A).links.find(l => l.kind === 'cooccur')
  assert.equal(single.distNorm, 0)
})

test('nodeRadius 读服务端算好的 r', () => {
  assert.equal(nodeRadius({ kind: 'topic', r: 8 }), 8)
  assert.equal(nodeRadius({ kind: 'session', r: 11 }), 11)
  assert.equal(nodeRadius({ kind: 'topic' }), 4)   // 兜底
})