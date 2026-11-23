import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import vm from 'node:vm'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import plugin, { createBridge, createDebounced } from '../lib/index.js'
import { createStore } from '../lib/store.js'

const VENDOR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'vendor')
const VENDOR_NAMES = ['force-graph.min.js', 'd3-force.min.js', 'd3-quadtree.min.js', 'd3-dispatch.min.js', 'd3-timer.min.js']

const ORIG_HOME = process.env.DSH_HOME
test.after(() => { if (ORIG_HOME === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = ORIG_HOME })

const RECORDS = [
  { type: 'session', id: 'sess-fx', createdAt: 1000, cwd: 'E:\\demo' },
  { type: 'turn/start', seq: 1, time: 1001, data: { turn: 1 } },
  { type: 'user/message', seq: 2, time: 1002, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '物理太果冻了，改一下物理' }] } },
  { type: 'assistant/message', seq: 3, time: 1003, data: { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: '物理已调整完毕' }] } } },
  { type: 'session/title', seq: 4, time: 1004, data: { title: '物理调整' } }
]
function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-graph-host-'))
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true })
  return home
}
function addSession(home, id, records = RECORDS) {
  const dir = path.join(home, 'sessions', 'ws1', id)
  fs.mkdirSync(dir, { recursive: true })
  const jsonl = records.map(r => JSON.stringify(r)).join('\n') + '\n'
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(jsonl, 'utf8')))
}
function mockCtx({ trusted = true, rejection = null, connection = true } = {}) {
  const routes = new Map()
  const cleanups = []
  const conn = { isTrusted: () => trusted, requestRejection: () => rejection }
  const ctx = {
    webServer: { register(r) { routes.set(r.path, r); return () => routes.delete(r.path) } },
    get(name) { return name === 'connection' && connection ? conn : undefined },
    effect(fn) { cleanups.push(fn()) }
  }
  return { ctx, routes, cleanup: () => { for (const c of cleanups) c() } }
}
function mount(home, connOpts) {
  process.env.DSH_HOME = home
  const m = mockCtx(connOpts)
  plugin.apply(m.ctx)
  return m
}
async function call(routes, pathname, { method = 'GET', url, headers = {}, chunks = [] } = {}) {
  const req = {
    method, url: url ?? pathname, headers: { host: '127.0.0.1:1234', ...headers },
    async *[Symbol.asyncIterator]() { for (const c of chunks) yield c }
  }
  const res = { statusCode: 0, headers: {}, body: null, setHeader(k, v) { this.headers[k.toLowerCase()] = v }, end(b) { this.body = b ?? null } }
  await routes.get(pathname).handler(req, res)
  return res
}
const api = (routes, query, opts) => call(routes, '/dsh-graph/api', { url: '/dsh-graph/api?' + query, ...opts })
const payload = (res) => JSON.parse(res.body)
async function poll(fn, timeoutMs = 15000) {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > timeoutMs) throw new Error('poll 超时')
    await new Promise(r => setTimeout(r, 100))
  }
}

test('挂载：name/inject 正确，六条 exact 路由，effect 清理全部卸载', () => {
  assert.equal(plugin.name, 'dsh-keyword-graph')
  assert.deepEqual(plugin.inject, ['webServer', 'connection'])
  const m = mount(makeHome())
  try {
    assert.equal(m.routes.size, 6)
    for (const p of ['/dsh-graph/api', ...VENDOR_NAMES.map(n => '/dsh-graph/vendor/' + n)]) {
      assert.equal(m.routes.get(p)?.kind, 'exact')
    }
  } finally { m.cleanup() }
  assert.equal(m.routes.size, 0)
})

test('信任栅栏：非回环且 isTrusted=false → 403', async () => {
  const m = mount(makeHome(), { trusted: false })
  try {
    const res = await api(m.routes, 'op=status', { headers: { host: 'evil.example.com' } })
    assert.equal(res.statusCode, 403)
    assert.equal(payload(res).ok, false)
  } finally { m.cleanup() }
})

test('信任栅栏：非回环但 isTrusted=true → 放行', async () => {
  const m = mount(makeHome(), { trusted: true })
  try {
    const res = await api(m.routes, 'op=status', { headers: { host: '192.168.1.5:8080' } })
    assert.equal(res.statusCode, 200)
    assert.equal(payload(res).ok, true)
  } finally { m.cleanup() }
})

test('fail-closed：connection 缺失时回环 → 503，非回环 → 403', async () => {
  const m = mount(makeHome(), { connection: false })
  try {
    const loop = await api(m.routes, 'op=status')
    assert.equal(loop.statusCode, 503)
    const lan = await api(m.routes, 'op=status', { headers: { host: '192.168.1.5:8080' } })
    assert.equal(lan.statusCode, 403)
  } finally { m.cleanup() }
})

test('requestRejection 返回 401 → 401 空 body', async () => {
  const m = mount(makeHome(), { rejection: 401 })
  try {
    const res = await api(m.routes, 'op=status')
    assert.equal(res.statusCode, 401)
    assert.equal(res.body, null)
  } finally { m.cleanup() }
})

test('vendor 路由：200 + JS content-type + UMD 内容', async () => {
  const m = mount(makeHome())
  const markers = { 'force-graph.min.js': 'ForceGraph', 'd3-force.min.js': 'forceCollide', 'd3-quadtree.min.js': 'quadtree', 'd3-dispatch.min.js': 'dispatch', 'd3-timer.min.js': 'timer' }
  try {
    for (const name of VENDOR_NAMES) {
      const res = await call(m.routes, '/dsh-graph/vendor/' + name)
      assert.equal(res.statusCode, 200, name)
      assert.match(res.headers['content-type'], /application\/javascript/, name)
      assert.ok(res.body.includes(markers[name]), name)
    }
  } finally { m.cleanup() }
})

test('R15：vendor d3 依赖链按序加载后 forceCollide/forceSimulation 可运行（vm 沙箱）', () => {
  // 浏览器原生定时器在沙箱中用 Node 等价物提供；unref 防止 d3-timer 内部定时器拖住测试进程
  const sandbox = vm.createContext({
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t },
    clearTimeout,
    setInterval: (fn, ms) => { const t = setInterval(fn, ms); t.unref?.(); return t },
    clearInterval
  })
  for (const name of ['d3-quadtree.min.js', 'd3-dispatch.min.js', 'd3-timer.min.js', 'd3-force.min.js']) {
    vm.runInContext(fs.readFileSync(path.join(VENDOR, name), 'utf8'), sandbox, { filename: name })
  }
  const d3 = vm.runInContext('d3', sandbox)
  for (const k of ['quadtree', 'dispatch', 'timer', 'forceCollide', 'forceSimulation']) {
    assert.equal(typeof d3[k], 'function', 'd3.' + k + ' 应为 function')
  }
  const collide = d3.forceCollide(n => n.r + 6)
  const sim = d3.forceSimulation([{}]).force('c', collide)
  assert.doesNotThrow(() => sim.tick())
  sim.stop()
})

test('R12：非法目录名不入映射；穿越/非法 id → missing/404 不崩溃', async () => {
  const home = makeHome()
  addSession(home, 'good-id')
  addSession(home, 'bad.id') // 目录名含点，ID_RE 之外
  const m = mount(home)
  try {
    const bad = await api(m.routes, 'op=session&id=bad.id')
    assert.equal(payload(bad).status, 'missing')
    const trav = await api(m.routes, 'op=session&id=' + encodeURIComponent('../../evil'))
    assert.equal(payload(trav).status, 'missing')
    const msg = await api(m.routes, 'op=message&id=bad.id&seq=2')
    assert.equal(msg.statusCode, 404)
    const msg2 = await api(m.routes, 'op=message&id=' + encodeURIComponent('../evil') + '&seq=2')
    assert.equal(msg2.statusCode, 404)
  } finally { m.cleanup() }
})

test('R13：content-length > 1MB → 413（不读 body）', async () => {
  const m = mount(makeHome())
  try {
    const res = await api(m.routes, 'op=config', {
      method: 'POST', headers: { 'content-length': '1048577' },
      chunks: [Buffer.from('{}')]
    })
    assert.equal(res.statusCode, 413)
    assert.equal(payload(res).ok, false)
  } finally { m.cleanup() }
})

test('R13：chunked 无 content-length 超 1MB → 413', async () => {
  const m = mount(makeHome())
  try {
    const res = await api(m.routes, 'op=link', {
      method: 'POST',
      chunks: [Buffer.alloc(600 * 1024, 97), Buffer.alloc(600 * 1024, 97)]
    })
    assert.equal(res.statusCode, 413)
    assert.equal(payload(res).ok, false)
  } finally { m.cleanup() }
})

test('端到端：真实 worker 建索引 → ready，message 读原文；重挂载 mtime 命中不重算', async () => {
  const home = makeHome()
  addSession(home, 'sess-a')
  const m = mount(home)
  let res
  try {
    res = await poll(async () => {
      const r = await api(m.routes, 'op=session&id=sess-a')
      return payload(r).status === 'ready' ? r : null
    })
    const p = payload(res)
    assert.equal(p.title, '物理调整')
    assert.ok(p.graph.nodes.length > 0)
    const msg = await api(m.routes, 'op=message&id=sess-a&seq=3')
    assert.equal(payload(msg).result.message.text, '物理已调整完毕')
  } finally { m.cleanup() }
  // mtime/size 未变 → 重挂载不重算
  const m2 = mount(home)
  try {
    const st = payload(await api(m2.routes, 'op=status'))
    assert.equal(st.queue, 0)
    assert.equal(st.indexing, null)
  } finally { m2.cleanup() }
  // 源文件变化（size 变）→ 重挂载触发重算
  addSession(home, 'sess-a', [...RECORDS, { type: 'user/message', seq: 5, time: 1005, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '再来一条' }] } }])
  const m3 = mount(home)
  try {
    const st = payload(await api(m3.routes, 'op=status'))
    assert.ok(st.indexing === 'sess-a' || st.queue > 0)
  } finally { m3.cleanup() }
})

test('索引格式版本落后 → 重挂载自动重建（旧索引缺 dist）', async () => {
  const home = makeHome()
  addSession(home, 'sess-a')
  const m = mount(home)
  const file = path.join(home, 'dsh-graph', 'index', 'sess-a.json')
  try {
    await poll(async () => {
      const r = await api(m.routes, 'op=session&id=sess-a')
      return payload(r).status === 'ready' ? r : null
    })
  } finally { m.cleanup() }
  const old = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(old.formatVersion, 5)
  fs.writeFileSync(file, JSON.stringify({ ...old, formatVersion: 2 }))
  const m2 = mount(home)
  try {
    await poll(async () => {
      const cur = JSON.parse(fs.readFileSync(file, 'utf8'))
      return cur.formatVersion === 5 ? cur : null
    })
  } finally { m2.cleanup() }
})

test('watcher 增量：挂载后新增会话，防抖后自动建索引', async () => {
  const home = makeHome()
  const m = mount(home)
  try {
    addSession(home, 'sess-w')
    await poll(async () => {
      const r = await api(m.routes, 'op=session&id=sess-w')
      return payload(r).status === 'ready' ? r : null
    }, 12000)
  } finally { m.cleanup() }
})

// —— createBridge 单测（fake worker，确定性验证 R5/串行/错误路径）——
function fakeWorker() {
  const w = new EventEmitter()
  w.posted = []
  w.postMessage = (m) => w.posted.push(m)
  return w
}
function withTimeout(p, ms = 2000) {
  let t
  return Promise.race([
    p,
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error('promise 悬挂超时')), ms); t.unref?.() })
  ]).finally(() => clearTimeout(t))
}
function bridgeSetup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-graph-bridge-'))
  const store = createStore(dir)
  const files = new Map([['a', '/fake/a'], ['b', '/fake/b']])
  const worker = fakeWorker()
  return { store, files, worker, bridge: createBridge({ store, files, worker }) }
}

test('R5：同 id index 在途/排队不重复入队；完成后可再入队', () => {
  const { worker, bridge } = bridgeSetup()
  bridge.requestIndex('a')
  assert.equal(worker.posted.length, 1)
  assert.deepEqual(bridge.status(), { queue: 0, indexing: 'a' })
  bridge.requestIndex('a') // 在途去重
  assert.equal(worker.posted.length, 1)
  bridge.requestIndex('b')
  bridge.requestIndex('b') // 排队去重
  assert.deepEqual(bridge.status(), { queue: 1, indexing: 'a' })
  worker.emit('message', { type: 'indexed', id: 'a', index: { sessionId: 'a', keywords: [] } })
  assert.equal(worker.posted.length, 2) // b 出队
  assert.equal(bridge.status().indexing, 'b')
  bridge.requestIndex('a') // a 已完成 → 允许重新入队
  assert.equal(bridge.status().queue, 1)
})

test('R5：read-message 在途不挡住同 id 的 index 请求', () => {
  const { worker, bridge } = bridgeSetup()
  bridge.readMessage('a', 2)
  assert.equal(bridge.status().indexing, 'a')
  bridge.requestIndex('a')
  assert.equal(bridge.status().queue, 1) // index 未被 read-message 误去重
  worker.emit('message', { type: 'message', id: 'a', seq: 2, result: null })
  assert.equal(worker.posted.length, 2)
  assert.equal(worker.posted[1].type, 'index-one')
})

test('worker error 消息：index 失败 resolve null 且队列继续；read-message 失败按 id:seq 匹配', async () => {
  const { worker, bridge } = bridgeSetup()
  const p = bridge.readMessage('a', 5)
  worker.emit('message', { type: 'error', id: 'a', seq: 5, error: 'boom' })
  assert.equal(await p, null)
  bridge.requestIndex('b')
  bridge.requestIndex('a')
  assert.equal(worker.posted.length, 2) // read-message 完成后 b 出队
  worker.emit('message', { type: 'error', id: 'b', error: 'boom' })
  assert.equal(bridge.status().indexing, 'a') // 队列继续
  assert.equal(worker.posted.length, 3)
})

test('R17：worker error 事件 → 全部 pending resolve null，队列清空且不再 post', async () => {
  const { worker, bridge } = bridgeSetup()
  const p = bridge.readMessage('a', 1)
  bridge.requestIndex('b')
  worker.emit('error', new Error('worker 崩了'))
  assert.equal(await withTimeout(p), null)
  assert.equal(worker.posted.length, 1) // b 不再发给已死 worker
  assert.deepEqual(bridge.status(), { queue: 0, indexing: null })
})

test('R17：worker exit 后死标记生效，新 requestIndex/readMessage 立即 null', async () => {
  const { worker, bridge } = bridgeSetup()
  const p = bridge.readMessage('a', 3)
  worker.emit('exit', 1)
  assert.equal(await withTimeout(p), null)
  assert.equal(await withTimeout(bridge.readMessage('a', 4)), null)
  bridge.requestIndex('b')
  assert.equal(worker.posted.length, 1) // 仅死前那条；死后不再 post
  assert.deepEqual(bridge.status(), { queue: 0, indexing: null })
  worker.emit('error', new Error('late')) // error/exit 先后到达均幂等不崩
})

test('R16：同 key 并发 readMessage 复用同一 Promise，worker 只收到一条消息', async () => {
  const { worker, bridge } = bridgeSetup()
  const p1 = bridge.readMessage('a', 2)
  const p2 = bridge.readMessage('a', 2)
  assert.equal(worker.posted.length, 1)
  worker.emit('message', { type: 'message', id: 'a', seq: 2, result: { text: 'ok' } })
  const [r1, r2] = await Promise.all([withTimeout(p1), withTimeout(p2)])
  assert.deepEqual(r1, { text: 'ok' })
  assert.deepEqual(r2, { text: 'ok' })
  assert.deepEqual(bridge.status(), { queue: 0, indexing: null })
})

test('excerpts 与同 id 的 index 响应 key 不冲突；未知 id/空词直接 null', async () => {
  const { worker, bridge } = bridgeSetup()
  bridge.requestIndex('a')                       // 在途 index，响应 key 'a'
  const p = bridge.excerpts('a', '物理')         // 排队，响应 key 'a:x:物理'
  worker.emit('message', { type: 'indexed', id: 'a', index: { sessionId: 'a', keywords: [] } })
  assert.equal(worker.posted.length, 2)
  assert.equal(worker.posted[1].type, 'excerpts')
  worker.emit('message', { type: 'excerpts', id: 'a', word: '物理', result: [{ seq: 1, excerpt: '…物理…' }] })
  assert.deepEqual(await withTimeout(p), [{ seq: 1, excerpt: '…物理…' }])
  assert.equal(await bridge.excerpts('zzz', '物理'), null)
  assert.equal(await bridge.excerpts('a', '  '), null)
  assert.deepEqual(bridge.status(), { queue: 0, indexing: null })
})

test('excerpts worker 报错 → 按 id:word 精确 resolve null，不误伤 index 请求', async () => {
  const { worker, bridge } = bridgeSetup()
  bridge.requestIndex('a')
  const p = bridge.excerpts('a', '物理')
  worker.emit('message', { type: 'indexed', id: 'a', index: { sessionId: 'a', keywords: [] } })
  worker.emit('message', { type: 'error', id: 'a', word: '物理', error: 'boom' })
  assert.equal(await withTimeout(p), null)
})

test('writeIndex 落盘失败不崩宿主：try/catch 吞错并以 [keyword-graph] 前缀记录', () => {
  const files = new Map([['a', '/fake/a']])
  const worker = fakeWorker()
  const store = {
    writeIndex() { throw new Error('EACCES: 模拟磁盘故障') },
    computeDf: () => ({ df: {}, totalSessions: 0 }),
    readConfig: () => ({})
  }
  const bridge = createBridge({ store, files, worker })
  const errs = []
  const orig = console.error
  console.error = (...a) => errs.push(a.join(' '))
  try {
    bridge.requestIndex('a')
    assert.doesNotThrow(() => worker.emit('message', { type: 'indexed', id: 'a', index: { sessionId: 'a' } }))
  } finally { console.error = orig }
  assert.ok(errs.some(s => s.includes('[keyword-graph]')), '应以 [keyword-graph] 前缀 console.error')
  assert.deepEqual(bridge.status(), { queue: 0, indexing: null }) // 队列状态正常复位
})

test('cleanup 前排空 pending：bridge.close() 使在途请求 resolve null，后续请求立即 null', async () => {
  const { worker, bridge } = bridgeSetup()
  const p1 = bridge.readMessage('a', 1)
  bridge.requestIndex('b')
  bridge.close()
  assert.equal(await withTimeout(p1), null)
  assert.deepEqual(bridge.status(), { queue: 0, indexing: null })
  assert.equal(await withTimeout(bridge.readMessage('a', 2)), null)
  assert.equal(worker.posted.length, 1) // close 后不再 post
})

// —— R21#1 防抖 max-wait 单测（注入 fake 时钟，确定性验证 trailing + 硬上限）——
function fakeSched() {
  let now = 0, seq = 0
  const timers = new Map()
  return {
    setTimeout(fn, ms) { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id },
    clearTimeout(id) { timers.delete(id) },
    advance(ms) {
      const end = now + ms
      for (;;) {
        let best = null
        for (const [id, t] of timers) if (t.at <= end && (best === null || t.at < timers.get(best).at)) best = id
        if (best === null) break
        const t = timers.get(best)
        timers.delete(best); now = t.at; t.fn()
      }
      now = end
    },
    pending() { return timers.size }
  }
}

test('R21 防抖：trailing 3s 触发，触发后两个定时器都清掉', () => {
  const sched = fakeSched()
  let fired = 0
  const d = createDebounced(() => fired++, 3000, 10000, sched)
  d.trigger()
  sched.advance(2999)
  assert.equal(fired, 0)
  sched.advance(1)
  assert.equal(fired, 1)
  assert.equal(sched.pending(), 0)
})

test('R21 防抖：连续事件间隔 <3s 不再饿死 —— 10s max-wait 强制触发', () => {
  const sched = fakeSched()
  let fired = 0
  const d = createDebounced(() => fired++, 3000, 10000, sched)
  for (let i = 0; i < 5; i++) { d.trigger(); sched.advance(2000) } // 每 2s 一次写入，trailing 永远差 1s
  assert.equal(fired, 1)          // 10s 硬上限到点触发
  assert.equal(sched.pending(), 0) // trailing/max 定时器都清掉
  d.trigger(); sched.advance(3000) // 触发后进入下一轮，可再次正常触发
  assert.equal(fired, 2)
})

test('R21 防抖：cancel 清掉 trailing 与 max-wait 两个定时器', () => {
  const sched = fakeSched()
  let fired = 0
  const d = createDebounced(() => fired++, 3000, 10000, sched)
  d.trigger(); sched.advance(2000); d.trigger()
  d.cancel()
  assert.equal(sched.pending(), 0)
  sched.advance(20000)
  assert.equal(fired, 0)
})

test('R21 插队：API requestIndex 插到队首，watcher 尾插保持 FIFO', () => {
  const { worker, bridge, files } = bridgeSetup()
  files.set('c', '/fake/c')
  bridge.readMessage('a', 1)          // 在途 read-message 占住 worker
  bridge.requestIndex('a', false)     // watcher 语义：尾插 → queue [a]
  bridge.requestIndex('b', false)     // queue [a, b]
  assert.deepEqual(bridge.status(), { queue: 2, indexing: 'a' })
  bridge.requestIndex('c')            // API 语义：插队 → queue [c, a, b]
  assert.equal(bridge.status().queue, 3)
  worker.emit('message', { type: 'message', id: 'a', seq: 1, result: null })
  assert.equal(worker.posted[1].type, 'index-one')
  assert.equal(worker.posted[1].id, 'c') // c 下一个处理，不排在初始扫描后面
})

test('R21 插队：已排队者移到队首不重复入队；在途者原地不动', () => {
  const { worker, bridge, files } = bridgeSetup()
  files.set('c', '/fake/c')
  bridge.requestIndex('a', false)   // 在途 a
  bridge.requestIndex('b', false)   // queue [b]
  bridge.requestIndex('c', false)   // queue [b, c]
  bridge.requestIndex('a')          // 在途 → 原地不动，不重复 post
  assert.equal(worker.posted.length, 1)
  bridge.requestIndex('c')          // 已排队 → 移到队首（去重仍生效）
  assert.equal(bridge.status().queue, 2)
  worker.emit('message', { type: 'indexed', id: 'a', index: { sessionId: 'a', keywords: [] } })
  assert.equal(worker.posted.length, 2)
  assert.equal(worker.posted[1].id, 'c')
  assert.equal(bridge.status().queue, 1)
})

test('readMessage 文件不存在 → null；requestIndex 未知 id 静默', async () => {
  const { worker, bridge } = bridgeSetup()
  assert.equal(await bridge.readMessage('zzz', 1), null)
  bridge.requestIndex('zzz')
  assert.equal(worker.posted.length, 0)
})
