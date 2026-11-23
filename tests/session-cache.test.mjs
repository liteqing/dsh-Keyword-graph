import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createSessionCache } from '../lib/session-cache.js'

function tmpFile(content = 'aaaa') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-graph-cache-'))
  const file = path.join(dir, 'session.v4.jsonl.zstd')
  fs.writeFileSync(file, content)
  return file
}

test('同 mtime+size 命中缓存，loader 只跑一次且返回同一对象', () => {
  const file = tmpFile()
  let n = 0
  const c = createSessionCache({ load: () => ({ v: ++n }) })
  const a = c.get(file)
  const b = c.get(file)
  assert.equal(n, 1)
  assert.equal(a, b)
})

test('mtime 变化 → 重新加载', () => {
  const file = tmpFile()
  let n = 0
  const c = createSessionCache({ load: () => ({ v: ++n }) })
  c.get(file)
  const future = new Date(Date.now() + 5000)
  fs.utimesSync(file, future, future)
  assert.equal(c.get(file).v, 2)
  assert.equal(n, 2)
})

test('size 变化（mtime 不变）→ 重新加载', () => {
  const file = tmpFile('aaaa')
  let n = 0
  const c = createSessionCache({ load: () => ({ v: ++n }) })
  c.get(file)
  const st = fs.statSync(file)
  fs.writeFileSync(file, 'aaaa-bbbb') // 不同长度，mtime 还原成旧的
  fs.utimesSync(file, st.atime, st.mtime)
  assert.equal(c.get(file).v, 2)
})

test('LRU：超过上限淘汰最久未用的，再次访问会重载', () => {
  const files = ['a', 'b', 'c'].map(x => tmpFile(x))
  const calls = new Map()
  const c = createSessionCache({
    max: 2,
    load: (f) => { calls.set(f, (calls.get(f) ?? 0) + 1); return { f } }
  })
  c.get(files[0]); c.get(files[1])   // 缓存 [a, b]
  c.get(files[0])                     // 触摸 a → [b, a]
  c.get(files[2])                     // 存入 c → 淘汰 b
  assert.equal(calls.get(files[1]), 1)
  c.get(files[1])                     // b 已被淘汰 → 重载
  assert.equal(calls.get(files[1]), 2)
  assert.equal(calls.get(files[0]), 1) // a 仍在缓存
})

test('loader 抛错不写缓存，下次仍会重试', () => {
  const file = tmpFile()
  let n = 0
  const c = createSessionCache({ load: () => { n++; if (n === 1) throw new Error('坏包'); return { ok: true } } })
  assert.throws(() => c.get(file), /坏包/)
  assert.equal(c.get(file).ok, true)
  assert.equal(n, 2)
})

test('clear 后强制重新加载', () => {
  const file = tmpFile()
  let n = 0
  const c = createSessionCache({ load: () => ({ v: ++n }) })
  c.get(file)
  c.clear()
  assert.equal(c.get(file).v, 2)
})