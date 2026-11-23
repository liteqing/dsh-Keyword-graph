import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js')
const ACCENT = '#2563eb'

// client.js 是浏览器模块：在 vm 里给一个最小 window.__ModuleLoader__ + react 桩，
// 只取回工厂导出的纯函数（不渲染、不碰 DOM）。
function loadClient() {
  let exported = null
  const requireStub = (name) => name === 'react'
    ? { createElement: () => null, useEffect() {}, useRef: () => ({ current: null }), useState: (v) => [v, () => {}], useCallback: (f) => f }
    : {}
  const sandbox = {
    window: { __ModuleLoader__: { load: ({ factory }) => { exported = factory(requireStub) } } },
    document: { getElementById: () => null, head: { appendChild() {} }, createElement: () => ({}) },
    console
  }
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), vm.createContext(sandbox), { filename: 'client.js' })
  return exported
}

test('linkStyle：选中时非相关主题线保留灰色淡化（不是消失），宽度保持原样', () => {
  const { linkStyle } = loadClient()
  const l = { source: 'a', target: 'b', kind: 'topic', weight: 2 }
  const s = linkStyle(l, { focus: 'x', accent: ACCENT })
  assert.equal(s.color, 'rgba(127,127,127,.20)')
  assert.equal(s.width, linkStyle(l, { focus: null, accent: ACCENT }).width)
  assert.ok(s.width <= 1.3, '连线整体比之前细')
})

test('linkStyle：权重再大，线宽上限也只到 1.3（整体变细）', () => {
  const { linkStyle } = loadClient()
  assert.ok(linkStyle({ kind: 'topic', weight: 50 }, { accent: ACCENT }).width <= 1.3)
})

test('flowLink：只给聚焦的主题线叠流动虚线，成员虚线与无关线不动', () => {
  const { flowLink } = loadClient()
  assert.equal(flowLink({ source: 'a', target: 'b', kind: 'topic' }, 'a'), true)
  assert.equal(flowLink({ source: { id: 'a' }, target: { id: 'b' }, kind: 'topic' }, 'b'), true)
  assert.equal(flowLink({ source: 'a', target: 'b', kind: 'topic' }, 'x'), false)
  assert.equal(flowLink({ source: 's', target: 't', kind: 'member' }, 's'), false)
  assert.equal(flowLink({ source: 'a', target: 'b', kind: 'topic' }, null), false)
})

test('linkStyle：相关主题线用强调色加粗；未聚焦时是常规灰', () => {
  const { linkStyle } = loadClient()
  const l = { source: { id: 'a' }, target: { id: 'b' }, kind: 'topic', weight: 1 }
  assert.equal(linkStyle(l, { focus: 'a', accent: ACCENT }).color, ACCENT)
  const idle = linkStyle(l, { focus: null, accent: ACCENT })
  assert.equal(idle.color, 'rgba(127,127,127,.40)')
})

test('linkStyle：成员虚线被淡化但保留，聚焦相关时略亮', () => {
  const { linkStyle } = loadClient()
  const l = { source: 's', target: 't', kind: 'member' }
  assert.equal(linkStyle(l, { focus: null, accent: ACCENT }).color, 'rgba(127,127,127,.16)')
  const faded = linkStyle(l, { focus: 'x', accent: ACCENT })
  assert.equal(faded.color, 'rgba(127,127,127,.10)')
  assert.equal(faded.width, 0.25)
  assert.equal(linkStyle({ ...l, target: 's' }, { focus: 's', accent: ACCENT }).color, 'rgba(127,127,127,.55)')
})

test('unlinkTarget：右键会话节点可取消其关联，本会话节点不响应', () => {
  const { unlinkTarget } = loadClient()
  assert.equal(unlinkTarget({ kind: 'session', id: 's:other', sessionId: 'other' }, 'cur'), 'other')
  assert.equal(unlinkTarget({ kind: 'session', id: 's:cur', sessionId: 'cur' }, 'cur'), null)
  assert.equal(unlinkTarget(null, 'cur'), null)
})

test('unlinkTarget：仅属于某一个关联会话的主题节点可取消，共享/多会话主题不响应', () => {
  const { unlinkTarget } = loadClient()
  assert.equal(unlinkTarget({ kind: 'topic', msgs: [{ s: 'other', seq: 1 }] }, 'cur'), 'other')
  assert.equal(unlinkTarget({ kind: 'topic', msgs: [{ s: 'cur', seq: 1 }, { s: 'other', seq: 2 }] }, 'cur'), null)
  assert.equal(unlinkTarget({ kind: 'topic', msgs: [{ s: 'cur', seq: 1 }] }, 'cur'), null)
  assert.equal(unlinkTarget({ kind: 'topic', msgs: [{ s: 'a1', seq: 1 }, { s: 'a2', seq: 2 }] }, 'cur'), null)
})