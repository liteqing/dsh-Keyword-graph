import test from 'node:test'
import assert from 'node:assert/strict'
import { extractSession, snippet } from '../lib/parse.js'

const RECORDS = [
  { type: 'session', id: 'session-test1', createdAt: 1000, cwd: 'E:\\demo' },
  { type: 'turn/start', seq: 1, time: 1001, data: { turn: 1 } },
  { type: 'user/message', seq: 2, time: 1002, data: { role: 'user', content: [{ type: 'text', text: '帮我把lrose的物理改一下' }] } },
  { type: 'assistant/message', seq: 3, time: 1003, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'reasoning', text: 'thinking' }, { type: 'text', text: '好的，物理参数已调整' }] } } },
  { type: 'tool/call', seq: 4, time: 1004, data: {} },
  { type: 'session/title', seq: 5, time: 1005, data: { title: '物理调整' } },
  { type: 'turn/start', seq: 6, time: 1006, data: { turn: 2 } },
  { type: 'user/message', seq: 7, time: 1007, data: { role: 'user', content: [{ type: 'text', text: '再看看胸臀' }] } }
]

test('extractSession 只取用户/AI文本，带轮次', () => {
  const { meta, messages } = extractSession(RECORDS)
  assert.equal(meta.sessionId, 'session-test1')
  assert.equal(meta.title, '物理调整')
  assert.equal(meta.cwd, 'E:\\demo')
  assert.equal(messages.length, 3)
  assert.deepEqual(messages.map(m => m.role), ['user', 'assistant', 'user'])
  assert.deepEqual(messages.map(m => m.turn), [1, 1, 2])
  assert.equal(messages[1].text, '好的，物理参数已调整') // reasoning 被跳过
  assert.equal(meta.updatedAt, 1007)
})

test('snippet 截断 80 字', () => {
  assert.equal(snippet('短'), '短')
  assert.equal(snippet('x'.repeat(100)), 'x'.repeat(80) + '…')
})

test('坏记录跳过不崩', () => {
  const { messages } = extractSession([null, 42, { type: 'user/message' }, ...RECORDS])
  assert.equal(messages.length, 3)
})