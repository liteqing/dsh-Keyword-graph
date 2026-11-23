import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { buildIndexFromFile, readMessageFrom, decompressText } from '../lib/indexer.js'

const RECORDS = [
  { type: 'session', id: 'session-fx', createdAt: 1000, cwd: 'E:\\demo' },
  { type: 'turn/start', seq: 1, time: 1001, data: { turn: 1 } },
  { type: 'user/message', seq: 2, time: 1002, data: { role: 'user', content: [{ type: 'text', text: '物理太果冻了，改一下物理' }] } },
  { type: 'assistant/message', seq: 3, time: 1003, data: { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: '物理已调整完毕' }] } } },
  { type: 'session/title', seq: 4, time: 1004, data: { title: '物理调整' } }
]
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-graph-fx-'))
  const file = path.join(dir, 'session.v4.jsonl.zstd')
  const jsonl = RECORDS.map(r => JSON.stringify(r)).join('\n') + '\n'
  fs.writeFileSync(file, zlib.zstdCompressSync(Buffer.from(jsonl, 'utf8')))
  return file
}

test('buildIndexFromFile 端到端', () => {
  const file = fixture()
  const idx = buildIndexFromFile(file, { id: 'session-fx', df: {}, totalSessions: 1, config: { topN: 25, extraStopwords: [] } })
  assert.equal(idx.formatVersion, 1)
  assert.equal(idx.title, '物理调整')
  assert.equal(idx.messages.length, 2)
  assert.ok(idx.messages[0].snippet.length <= 81)
  assert.ok(idx.keywords.some(k => k.word === '物理'))
  assert.ok(idx.sourceSize > 0)
})

test('readMessageFrom 全文+前后邻居', () => {
  const file = fixture()
  const r = readMessageFrom(file, 3)
  assert.equal(r.message.text, '物理已调整完毕')
  assert.equal(r.prev.seq, 2)
  assert.equal(r.next, null)
  assert.equal(readMessageFrom(file, 999), null)
})

test('写一半的 zstd 抛错（宿主保留旧索引重试）', () => {
  const file = fixture()
  const buf = fs.readFileSync(file)
  const bad = file + '.bad'
  fs.writeFileSync(bad, buf.subarray(0, Math.floor(buf.length / 2)))
  assert.throws(() => decompressText(fs.readFileSync(bad)))
})