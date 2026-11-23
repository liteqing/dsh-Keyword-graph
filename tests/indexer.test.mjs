import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { buildIndexFromFile, readMessageFrom, readExcerptsFrom, decompressText, splitZstdFrames, zstdBackend } from '../lib/indexer.js'

const RECORDS = [
  { type: 'session', id: 'session-fx', createdAt: 1000, cwd: 'E:\\demo' },
  { type: 'turn/start', seq: 1, time: 1001, data: { turn: 1 } },
  { type: 'user/message', seq: 2, time: 1002, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: Array.from({ length: 11 }, () => '物理').join('，') + '，太果冻了' }] } },
  { type: 'assistant/message', seq: 3, time: 1003, data: { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: '物理已调整完毕' }] } } },
  { type: 'session/title', seq: 4, time: 1004, data: { title: '物理调整' } }
]
function fixture(records = RECORDS) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-graph-fx-'))
  const file = path.join(dir, 'session.v4.jsonl.zstd')
  const jsonl = records.map(r => JSON.stringify(r)).join('\n') + '\n'
  fs.writeFileSync(file, zlib.zstdCompressSync(Buffer.from(jsonl, 'utf8')))
  return file
}

test('buildIndexFromFile 端到端', () => {
  const file = fixture()
  const idx = buildIndexFromFile(file, { id: 'session-fx', df: {}, totalSessions: 1, config: { topN: 25, extraStopwords: [] } })
  assert.equal(idx.formatVersion, 5)
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

test('readExcerptsFrom 返回含关键词的消息片段，支持 limit', () => {
  const file = fixture()
  const rows = readExcerptsFrom(file, '物理')
  assert.deepEqual(rows.map(r => r.seq), [2, 3])
  assert.ok(rows.every(r => r.excerpt.includes('物理')))
  assert.deepEqual(readExcerptsFrom(file, '不存在的词'), [])
  assert.equal(readExcerptsFrom(file, '物理', 1).length, 1)
  assert.deepEqual(readExcerptsFrom(file, '  '), [])
})

test('readExcerptsFrom 按分词精确匹配：mod 不命中 model', () => {
  const file = fixture([
    { type: 'session', id: 's', createdAt: 1, cwd: '/w' },
    { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 2, time: 2, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'model 文件目录' }] } },
    { type: 'user/message', seq: 3, time: 3, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'mod 文件目录' }] } }
  ])
  assert.deepEqual(readExcerptsFrom(file, 'mod').map(r => r.seq), [3])
})

test('splitZstdFrames：多帧拼接按帧边界切开', () => {
  const a = zlib.zstdCompressSync(Buffer.from('第一段', 'utf8'))
  const b = zlib.zstdCompressSync(Buffer.from('第二段', 'utf8'))
  const buf = Buffer.concat([a, b])
  const frames = splitZstdFrames(buf)
  assert.equal(frames.length, 2)
  assert.deepEqual(Buffer.concat(frames), buf)
  assert.equal(zlib.zstdDecompressSync(frames[0]).toString('utf8'), '第一段')
  assert.equal(zlib.zstdDecompressSync(frames[1]).toString('utf8'), '第二段')
})

test('splitZstdFrames：跳过 skippable 帧', () => {
  const data = zlib.zstdCompressSync(Buffer.from('x', 'utf8'))
  const skip = Buffer.alloc(8 + 4)
  skip.writeUInt32LE(0x184d2a50, 0)
  skip.writeUInt32LE(4, 4)
  const frames = splitZstdFrames(Buffer.concat([skip, data]))
  assert.equal(frames.length, 1)
  assert.equal(zlib.zstdDecompressSync(frames[0]).toString('utf8'), 'x')
})

test('decompressText：多帧会话包完整解出（Electron 逐帧解压路径）', () => {
  const a = zlib.zstdCompressSync(Buffer.from('{"type":"a"}\n', 'utf8'))
  const b = zlib.zstdCompressSync(Buffer.from('{"type":"b"}\n', 'utf8'))
  const buf = Buffer.concat([a, b])
  assert.equal(decompressText(buf), '{"type":"a"}\n{"type":"b"}\n')
  assert.equal(decompressText(buf, null), '{"type":"a"}\n{"type":"b"}\n')
  // 模拟 Electron 内置 Node：整包传进来只解首帧（静默丢后续帧）
  const electronLike = (x) => zlib.zstdDecompressSync(splitZstdFrames(x)[0])
  assert.equal(decompressText(buf, electronLike), '{"type":"a"}\n{"type":"b"}\n')
})

test('写一半的 zstd 抛错（宿主保留旧索引重试），原生与 fzstd 两条路径都抛', () => {
  const file = fixture()
  const buf = fs.readFileSync(file)
  const bad = file + '.bad'
  fs.writeFileSync(bad, buf.subarray(0, Math.floor(buf.length / 2)))
  assert.throws(() => decompressText(fs.readFileSync(bad)))
  assert.throws(() => decompressText(fs.readFileSync(bad), null))
})

test('decompressText：原生 zstd 与 fzstd 回退结果一致', () => {
  const buf = fs.readFileSync(fixture())
  const text = decompressText(buf)
  assert.match(text, /物理已调整完毕/)
  assert.equal(decompressText(buf, null), text) // 第二参数传 null → 强制走 fzstd
  assert.equal(zstdBackend, typeof zlib.zstdDecompressSync === 'function' ? 'native' : 'fzstd')
})

test('文件追加消息后读取立即可见（会话缓存按 mtime/size 失效）', () => {
  const file = fixture()
  assert.equal(readMessageFrom(file, 5), null)
  const records = [...RECORDS,
    { type: 'user/message', seq: 5, time: 1005, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '追加的消息' }] } }]
  fs.writeFileSync(file, zlib.zstdCompressSync(Buffer.from(records.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8')))
  assert.equal(readMessageFrom(file, 5).message.text, '追加的消息')
  assert.deepEqual(readExcerptsFrom(file, '追加').map(r => r.seq), [5])
})