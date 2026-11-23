import test from 'node:test'
import assert from 'node:assert/strict'
import { buildGraph, nodeRadius } from '../lib/graph.js'

const A = {
  sessionId: 'a', title: '会话A',
  keywords: [{ word: '物理', score: 8, msgs: [1, 2] }, { word: 'lrose', score: 5, msgs: [2] }],
  edges: [{ a: 'lrose', b: '物理', weight: 3 }]
}
const B = {
  sessionId: 'b', title: '会话B',
  keywords: [{ word: '物理', score: 4, msgs: [7] }],
  edges: []
}

test('共享主题合并为单节点并连两个会话', () => {
  const { nodes, links } = buildGraph(A, [B])
  const topics = nodes.filter(n => n.kind === 'topic')
  assert.equal(topics.length, 2) // 物理 + lrose，物理不重复
  const phys = topics.find(n => n.label === '物理')
  assert.equal(phys.val, 12)
  assert.deepEqual(phys.msgs, [{ s: 'a', seq: 1 }, { s: 'a', seq: 2 }, { s: 'b', seq: 7 }])
  const members = links.filter(l => l.kind === 'member' && l.source === 't:物理')
  assert.deepEqual(members.map(l => l.target).sort(), ['s:a', 's:b'])
  assert.equal(nodes.filter(n => n.kind === 'session').length, 2)
})

test('共现边跨会话同 pair 合并权重', () => {
  const B2 = { ...B, edges: [{ a: 'lrose', b: '物理', weight: 2 }] }
  const { links } = buildGraph(A, [B2])
  const co = links.filter(l => l.kind === 'cooccur')
  assert.equal(co.length, 1)
  assert.equal(co[0].weight, 5)
})

test('nodeRadius 单调', () => {
  assert.ok(nodeRadius({ kind: 'topic', val: 16 }) > nodeRadius({ kind: 'topic', val: 4 }))
  assert.equal(nodeRadius({ kind: 'session', val: 1 }), 9)
})
