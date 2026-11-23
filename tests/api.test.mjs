import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStore } from '../lib/store.js'
import { createApi } from '../lib/api.js'

function setup(findFile = (id) => '/fake/' + id) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-graph-api-'))
  const store = createStore(dir)
  const indexed = new Set()
  const bridge = {
    requestIndex: (id) => { indexed.add(id) },
    readMessage: async (id, seq) => ({ message: { seq, text: '全文' + seq }, prev: null, next: null }),
    status: () => ({ queue: 0, indexing: null })
  }
  const handle = createApi({ store, bridge, findFile })
  const call = (op, { method = 'GET', body, params = '' } = {}) => {
    const res = { statusCode: 0, payload: null, setHeader() {}, end(p) { this.payload = JSON.parse(p) } }
    const req = { method, headers: { host: '127.0.0.1:9' }, async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(JSON.stringify(body)) } }
    return handle(req, res, new URL('http://x/dsh-graph/api?op=' + op + params)).then(() => res)
  }
  return { store, bridge, call, indexed, dir }
}
const IDX = { formatVersion: 1, sessionId: 'a', title: 'A', messages: [{ seq: 1, role: 'user', snippet: '物理' }], keywords: [{ word: '物理', score: 8, msgs: [1] }], edges: [] }

test('session 未索引→indexing 并触发请求；已索引→ready+graph', async () => {
  const { store, call, indexed } = setup()
  let res = await call('session', { params: '&id=a' })
  assert.equal(res.payload.status, 'indexing')
  assert.ok(indexed.has('a'))
  store.writeIndex(IDX)
  res = await call('session', { params: '&id=a' })
  assert.equal(res.payload.status, 'ready')
  assert.ok(res.payload.graph.nodes.some(n => n.id === 't:物理'))
})

test('link 增删反映到 session.linked', async () => {
  const { store, call } = setup()
  store.writeIndex(IDX)
  store.writeIndex({ ...IDX, sessionId: 'b', title: 'B' })
  await call('link', { method: 'POST', body: { a: 'a', b: 'b' } })
  let res = await call('session', { params: '&id=a' })
  assert.deepEqual(res.payload.linked, ['b'])
  assert.equal(res.payload.graph.nodes.filter(n => n.kind === 'session').length, 2)
  await call('link', { method: 'DELETE', body: { a: 'a', b: 'b' } })
  res = await call('session', { params: '&id=a' })
  assert.deepEqual(res.payload.linked, [])
})

test('message 透传 bridge；未知 op 404', async () => {
  const { call } = setup()
  const res = await call('message', { params: '&id=a&seq=1' })
  assert.equal(res.payload.result.message.text, '全文1')
  const bad = await call('nope')
  assert.equal(bad.statusCode, 404)
})

test('session 文件不存在→missing 且不触发索引请求', async () => {
  const { call, indexed } = setup(() => null)
  const res = await call('session', { params: '&id=a' })
  assert.equal(res.payload.status, 'missing')
  assert.equal(indexed.size, 0)
})

test('session linked 排除自身且去重（R11）', async () => {
  const { store, call, dir } = setup()
  store.writeIndex(IDX)
  fs.writeFileSync(path.join(dir, 'links.json'), JSON.stringify([{ a: 'a', b: 'a', at: 0 }, { a: 'a', b: 'a', at: 1 }]))
  const res = await call('session', { params: '&id=a' })
  assert.deepEqual(res.payload.linked, [])
  assert.equal(res.payload.graph.nodes.filter(n => n.kind === 'session').length, 1)
  assert.equal(res.payload.graph.nodes.find(n => n.id === 't:物理').val, 8)
})

test('config POST 钳制 topN 到 1..30 整数，非法回退 25（R10）', async () => {
  const { call } = setup()
  let res = await call('config', { method: 'POST', body: { topN: 999 } })
  assert.equal(res.payload.config.topN, 30)
  res = await call('config', { method: 'POST', body: { topN: 0 } })
  assert.equal(res.payload.config.topN, 1)
  res = await call('config', { method: 'POST', body: { topN: 'abc' } })
  assert.equal(res.payload.config.topN, 25)
  res = await call('config', { method: 'POST', body: { topN: null } })
  assert.equal(res.payload.config.topN, 25)
  res = await call('config', { method: 'POST', body: { topN: 12.7 } })
  assert.equal(res.payload.config.topN, 13)
  res = await call('config', { method: 'POST', body: { topN: 12, accent: '#ff0000' } })
  assert.equal(res.payload.config.topN, 12)
  assert.equal(res.payload.config.accent, '#ff0000')
  res = await call('config')
  assert.equal(res.payload.config.topN, 12)
  assert.equal(res.payload.config.accent, '#ff0000')
})

test('link 任一端达到 10 条关联即拒绝，已有配对幂等（R10）', async () => {
  const { store, call } = setup()
  store.writeIndex(IDX)
  for (let i = 0; i < 11; i++) store.writeIndex({ ...IDX, sessionId: 's' + i })
  for (let i = 0; i < 10; i++) {
    const r = await call('link', { method: 'POST', body: { a: 'a', b: 's' + i } })
    assert.equal(r.statusCode, 200)
  }
  const res = await call('link', { method: 'POST', body: { a: 'a', b: 's10' } })
  assert.equal(res.statusCode, 400)
  assert.ok(res.payload.error)
  const other = await call('link', { method: 'POST', body: { a: 's10', b: 'a' } })
  assert.equal(other.statusCode, 400)
  assert.equal(store.readLinks().length, 10)
  const dup = await call('link', { method: 'POST', body: { a: 'a', b: 's0' } })
  assert.equal(dup.statusCode, 200)
  assert.equal(store.readLinks().length, 10)
})

test('related limit 钳制 ≤10，默认 8（R10）', async () => {
  const { store, call } = setup()
  store.writeIndex(IDX)
  for (let i = 0; i < 12; i++) store.writeIndex({ ...IDX, sessionId: 'r' + i })
  const res = await call('related', { params: '&id=a&limit=50' })
  assert.equal(res.payload.related.length, 10)
  const res2 = await call('related', { params: '&id=a&limit=3' })
  assert.equal(res2.payload.related.length, 3)
  const res3 = await call('related', { params: '&id=a' })
  assert.equal(res3.payload.related.length, 8)
})

test('link/unlink 非法 id → 400 且不落盘（Task 3 遗留守卫）', async () => {
  const { store, call } = setup()
  store.writeIndex(IDX)
  for (const body of [{ a: 'a', b: '../evil' }, { a: 'a', b: {} }, { a: 1, b: 'a' }, { a: 'a' }, { a: 'a', b: 'a' }]) {
    const res = await call('link', { method: 'POST', body })
    assert.equal(res.statusCode, 400)
    const del = await call('link', { method: 'DELETE', body })
    assert.equal(del.statusCode, 400)
  }
  assert.deepEqual(store.readLinks(), [])
})

test('link 非法 JSON body → 400 json 错误不崩溃', async () => {
  const { store, bridge } = setup()
  const handle = createApi({ store, bridge, findFile: () => null })
  const res = { statusCode: 0, payload: null, setHeader() {}, end(p) { this.payload = JSON.parse(p) } }
  const req = { method: 'POST', headers: {}, async *[Symbol.asyncIterator]() { yield Buffer.from('{bad json') } }
  await handle(req, res, new URL('http://x/dsh-graph/api?op=link'))
  assert.equal(res.statusCode, 400)
  assert.equal(res.payload.ok, false)
  assert.ok(res.payload.error)
})

test('link 非 POST/DELETE → 405；message 非法 seq → 404', async () => {
  const { call } = setup()
  const res = await call('link', { method: 'PUT', body: { a: 'a', b: 'b' } })
  assert.equal(res.statusCode, 405)
  const bad = await call('message', { params: '&id=a&seq=abc' })
  assert.equal(bad.statusCode, 404)
})

test('status 透传 bridge.status', async () => {
  const { call } = setup()
  const res = await call('status')
  assert.equal(res.payload.ok, true)
  assert.equal(res.payload.queue, 0)
  assert.equal(res.payload.indexing, null)
})