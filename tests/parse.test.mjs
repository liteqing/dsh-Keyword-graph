import test from 'node:test'
import assert from 'node:assert/strict'
import { extractSession, snippet, excerptAround } from '../lib/parse.js'

const RECORDS = [
  { type: 'session', id: 'session-test1', createdAt: 1000, cwd: 'E:\\demo' },
  { type: 'turn/start', seq: 1, time: 1001, data: { turn: 1 } },
  { type: 'user/message', seq: 2, time: 1002, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '帮我把lrose的物理改一下' }] } },
  { type: 'assistant/message', seq: 3, time: 1003, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'reasoning', text: 'thinking' }, { type: 'text', text: '好的，物理参数已调整' }] } } },
  { type: 'tool/call', seq: 4, time: 1004, data: {} },
  { type: 'session/title', seq: 5, time: 1005, data: { title: '物理调整' } },
  { type: 'turn/start', seq: 6, time: 1006, data: { turn: 2 } },
  { type: 'user/message', seq: 7, time: 1007, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '再看看胸臀' }] } }
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

test('excerptAround 以关键词为中心截断，两端加省略号', () => {
  const text = '前'.repeat(300) + '物理' + '后'.repeat(300)
  const ex = excerptAround(text, '物理', { before: 100, after: 200 })
  assert.equal(ex, '…' + '前'.repeat(100) + '物理' + '后'.repeat(200) + '…')
})

test('excerptAround 短文本不加省略号、大小写不敏感、找不到返回 null', () => {
  assert.equal(excerptAround('WestPlay 纹理加载有问题', 'westplay'), 'WestPlay 纹理加载有问题')
  assert.equal(excerptAround('没有这个词', '物理'), null)
  // 关键词在结尾附近：只省略开头
  assert.equal(excerptAround('前'.repeat(200) + '物理', '物理', { before: 50, after: 50 }), '…' + '前'.repeat(50) + '物理')
})

test('坏记录跳过不崩', () => {
  const { messages } = extractSession([null, 42, { type: 'user/message' }, ...RECORDS])
  assert.equal(messages.length, 3)
})

test('助手文本开头的 DSH 时间上下文前缀被剥掉', () => {
  const records = [
    { type: 'session', id: 's', createdAt: 1, cwd: '/w' },
    { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
    { type: 'assistant/message', seq: 2, time: 2, data: { turn: 1, message: { content: [{ type: 'text', text: '\nTime sampled while preparing turn 2, step 1: 2026-11-22T20:44:50+08:00[Asia/Shanghai]\nBrowser time zone for this request: Asia/Shanghai.\n\n收尾完成，全部按你说的做了。' }] } } }
  ]
  const { messages } = extractSession(records)
  assert.equal(messages[0].text, '收尾完成，全部按你说的做了。')
})

test('注入消息不入索引：只保留 source.kind=user 的真人发言', () => {
  const records = [
    { type: 'session', id: 's', createdAt: 1, cwd: '/w' },
    { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 2, time: 2, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '真正的提问' }] } },
    { type: 'user/message', seq: 3, time: 3, data: { source: { kind: 'agent-instructions' }, content: [{ type: 'text', text: '<system-reminder>Agents.md 规则</system-reminder>' }] } },
    { type: 'user/message', seq: 4, time: 4, data: { source: { kind: 'skill-catalog' }, content: [{ type: 'text', text: '<system-reminder>可用技能列表</system-reminder>' }] } },
    { type: 'user/message', seq: 5, time: 5, data: { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'Current runtime context. 工作目录……' }] } },
    { type: 'user/message', seq: 6, time: 6, data: { source: { kind: 'time-context' }, content: [{ type: 'text', text: 'Time sampled while preparing turn 1' }] } },
    { type: 'user/message', seq: 7, time: 7, data: { source: { kind: 'tool-jobs' }, content: [{ type: 'text', text: 'background job pwsh-xxx settled' }] } },
    { type: 'user/message', seq: 8, time: 8, data: { source: { kind: 'user-approval' }, content: [{ type: 'text', text: '允许执行？' }] } }
  ]
  const { messages } = extractSession(records)
  assert.deepEqual(messages.map(m => m.seq), [2])
  assert.equal(messages[0].text, '真正的提问')
})