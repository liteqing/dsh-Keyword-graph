import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStore } from '../lib/store.js'

const dirs = []
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-graph-'))
  dirs.push(d)
  return d
}
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }) })

const idx = (id, words) => ({
  formatVersion: 1, sessionId: id, title: '标题' + id, updatedAt: 1,
  messages: [], edges: [],
  keywords: words.map((w, i) => ({ word: w, score: 10 - i, count: 3, msgs: [1] }))
})

test('索引读写+原子性', () => {
  const s = createStore(tmp())
  s.writeIndex(idx('session-a', ['物理', 'lrose']))
  assert.equal(s.readIndex('session-a').title, '标题session-a')
  assert.equal(s.listIndexes().length, 1)
  assert.equal(s.readIndex('nope'), null)
})

test('非法 id 拒绝', () => {
  const s = createStore(tmp())
  assert.throws(() => s.writeIndex(idx('../evil', [])))
})

test('links 去重+取消', () => {
  const s = createStore(tmp())
  s.addLink('a', 'b'); s.addLink('b', 'a')
  assert.equal(s.readLinks().length, 1)
  s.removeLink('a', 'b')
  assert.equal(s.readLinks().length, 0)
})

test('related 按共享词分数排序且排除已关联', () => {
  const s = createStore(tmp())
  s.writeIndex(idx('cur', ['物理', 'lrose', '模组']))
  s.writeIndex(idx('x', ['物理', 'lrose']))
  s.writeIndex(idx('y', ['模组']))
  s.addLink('cur', 'y')
  const rel = s.related('cur')
  assert.deepEqual(rel.map(r => r.sessionId), ['x'])
  assert.deepEqual(rel[0].shared.sort(), ['lrose', '物理'])
})

test('config 白名单+默认值', () => {
  const s = createStore(tmp())
  assert.equal(s.readConfig().accent, '#2563eb')
  s.writeConfig({ accent: '#ff0000', evil: 1 })
  assert.equal(s.readConfig().accent, '#ff0000')
  assert.equal(s.readConfig().evil, undefined)
})

test('computeDf 与 cleanOrphans', () => {
  const s = createStore(tmp())
  s.writeIndex(idx('a', ['物理']))
  s.writeIndex(idx('b', ['物理', '模组']))
  const { df, totalSessions } = s.computeDf()
  assert.equal(df['物理'], 2)
  assert.equal(totalSessions, 2)
  s.cleanOrphans(new Set(['a']))
  assert.deepEqual(s.listIndexes().map(i => i.sessionId), ['a'])
})
