import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { createStore } from './store.js'
import { createApi, json } from './api.js'
import { INDEX_VERSION } from './format.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEBOUNCE_MS = 3000
const MAX_WAIT_MS = 10000
const MAX_BODY = 1048576
const ID_RE = /^[A-Za-z0-9_-]+$/
const validId = (id) => typeof id === 'string' && ID_RE.test(id)

/** R21#1：trailing 防抖 + max-wait 硬上限。纯 trailing 在持续写入（间隔 <delay）时永远
 *  不触发（饿死）；首个事件另起 maxWait 定时器，到点强制触发。触发/取消都清两个定时器。
 *  sched 可注入 fake 时钟做确定性单测。 */
export function createDebounced(fn, delay = DEBOUNCE_MS, maxWait = MAX_WAIT_MS, sched = { setTimeout, clearTimeout }) {
  let timer = null
  let maxTimer = null
  function fire() {
    sched.clearTimeout(timer)
    sched.clearTimeout(maxTimer)
    timer = maxTimer = null
    fn()
  }
  return {
    trigger() {
      sched.clearTimeout(timer)
      timer = sched.setTimeout(fire, delay)
      if (maxTimer === null) maxTimer = sched.setTimeout(fire, maxWait)
    },
    cancel() {
      sched.clearTimeout(timer)
      sched.clearTimeout(maxTimer)
      timer = maxTimer = null
    }
  }
}

// worker + 请求桥（串行队列，避免大会话并发吃满 CPU）。独立导出便于用 fake worker 做确定性单测。
export function createBridge({ store, files, worker }) {
  const pending = new Map() // key → {resolve, promise}
  const queue = []
  let current = null // 在途任务 {id, key, msg}
  let dead = false // worker 致命 error/exit 后置位：不再 post，新请求立即 null
  // 响应 → 请求 key：excerpts 用 word 区分（否则会和同 id 的 index 响应撞 key）
  const keyOf = (msg) => msg.word !== undefined
    ? msg.id + ':x:' + msg.word
    : msg.seq !== undefined ? msg.id + ':' + msg.seq : msg.id
  worker.on('message', (msg) => {
    const key = keyOf(msg)
    const r = pending.get(key)?.resolve
    pending.delete(key)
    if (msg.type === 'indexed') {
      // 落盘失败只记日志不崩宿主（回调内裸抛会打挂整个进程）；索引仍 resolve 给请求方
      try { store.writeIndex(msg.index) } catch (e) { console.error('[convo-graph] 索引落盘失败: ' + (e?.message ?? e)) }
      r?.(msg.index)
    }
    else if (msg.type === 'message') r?.(msg.result)
    else if (msg.type === 'excerpts') r?.(msg.result)
    else r?.(null)
    current = null
    pump()
  })
  // R17：致命 error/exit → 排空全部 pending（含排队者）为 null、清队列、置死标记；
  // 否则 pump 会继续给死 worker postMessage，后续所有请求永久悬挂。
  function failAll() {
    dead = true
    for (const { resolve } of pending.values()) resolve(null)
    pending.clear()
    queue.length = 0
    current = null
  }
  worker.on('error', (e) => { console.warn('[convo-graph] worker 错误: ' + e.message); failAll() })
  worker.on('exit', () => { failAll() })
  function pump() {
    if (dead || current || !queue.length) return
    current = queue.shift()
    worker.postMessage(current.msg)
  }
  function enqueue(msg, key, front = false) {
    if (dead) return Promise.resolve(null)
    // R16：同 key 并发请求复用同一 Promise（共享一次 worker 请求），不覆盖先前 resolve
    const existing = pending.get(key)
    if (existing) return existing.promise
    let resolve
    const promise = new Promise((r) => { resolve = r })
    pending.set(key, { resolve, promise })
    const job = { id: msg.id, key, msg }
    if (front) queue.unshift(job); else queue.push(job)
    pump()
    return promise
  }
  return {
    // R21#2：API 触发的当前会话请求默认插队（front），不排在初始全量扫描 FIFO 后面；
    // watcher/初始扫描传 priority=false 保持尾插。
    requestIndex(id, priority = true) {
      const file = files.get(id)
      if (!file) return
      // R5：同一 id 的 index 请求已在队列/在途 → 不重复入队（fs.watch 抖动防重复劳动）
      if (current?.msg.type === 'index-one' && current.id === id) return
      const qi = queue.findIndex(j => j.msg.type === 'index-one' && j.id === id)
      if (qi >= 0) {
        // 已排队：插队请求把它移到队首（去重守卫仍生效，不新建 pending）
        if (priority && qi > 0) queue.unshift(queue.splice(qi, 1)[0])
        return
      }
      const { df, totalSessions } = store.computeDf()
      enqueue({ type: 'index-one', id, file, df, totalSessions, config: store.readConfig() }, id, priority)
    },
    readMessage(id, seq) {
      const file = files.get(id)
      if (!file) return Promise.resolve(null)
      return enqueue({ type: 'read-message', id, file, seq }, id + ':' + seq)
    },
    excerpts(id, word) {
      const file = files.get(id)
      const w = typeof word === 'string' ? word.trim() : ''
      if (!file || !w) return Promise.resolve(null)
      // 面板交互优先：插到队首，不排在初始全量扫描后面
      return enqueue({ type: 'excerpts', id, file, word: w }, id + ':x:' + w, true)
    },
    status() { return { queue: queue.length, indexing: current?.id ?? null } },
    // 宿主 cleanup 用：terminate 前排空全部 pending，避免在途 HTTP 请求悬挂
    close() { failAll() }
  }
}

export default {
  name: 'dsh-convo-graph',
  inject: ['webServer', 'connection'],
  apply(ctx) {

/** 回环快速通道：Host 是 127.0.0.1/localhost/[::1] 时直接算可信。
 *  非回环不能在这里一刀切 —— DSH 允许 `--host <局域网地址>` 部署，
 *  合法浏览器访问时 Host 必然非回环。完整信任判定见 isTrustedReq。 */
function isLoopbackReq(req) {
  const host = String(req.headers?.host ?? '').toLowerCase()
  const h = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
  return h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1'
}

/** 信任判定沿用 DSH 的 Host/Origin 栅栏：回环、监听绑定地址、trustedHosts 都放行；
 *  连接服务不可用时退回"仅回环"（fail-closed）。放行 Host 不等于放行请求 ——
 *  后面的 requestRejection 仍会校验登录态（未认证返回 401）。 */
function isTrustedReq(req) {
  if (isLoopbackReq(req)) return true
  try {
    const conn = ctx.get('connection') || ctx.connection
    if (conn && typeof conn.isTrusted === 'function') return conn.isTrusted(req) === true
  } catch {}
  return false
}

    // P1-1（Kimi 评审 #8）：这条路以前是 fail-open —— connection 缺失/抛错就**放行** ✗
    // 安全组件的默认值必须是"关"：栅栏不可用 → 拒绝（写操作尤其），只对静态页面留一条活路。
    function rejected(req, res, { strict = true } = {}) {
      if (isTrustedReq(req) === false) {
        json(res, 403, { ok: false, error: '不受信任的访问来源' })
        return true
      }
      try {
        const conn = ctx.get('connection') || ctx.connection
        if (!conn || typeof conn.requestRejection !== 'function') {
          if (!rejected.warned) {
            rejected.warned = true
            console.warn('[convo-graph] 信任栅栏不可用：connection 服务缺失 → 按 fail-closed 处理')
          }
          if (strict) { json(res, 503, { ok: false, error: '信任栅栏不可用，拒绝访问（fail-closed）' }); return true }
          return false
        }
        const code = conn.requestRejection(req)
        if (code === undefined || code === null || code === false) return false
        res.statusCode = typeof code === 'number' ? code : 403
        res.end()
        return true
      } catch (e) {
        if (strict) { json(res, 503, { ok: false, error: '信任栅栏异常，拒绝访问（fail-closed）' }); return true }
        return false
      }
    }

    // 目录常量放在 apply 内读取 env，便于测试用临时 DSH_HOME 挂载（宿主运行时行为不变）
    const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
    const DATA_DIR = path.join(DSH_HOME, 'dsh-graph')
    const SESSIONS_DIR = path.join(DSH_HOME, 'sessions')

    const store = createStore(DATA_DIR)
    const files = new Map() // sessionId(目录名) → zstd 路径
    function scan() {
      files.clear()
      let workspaces = []
      try { workspaces = fs.readdirSync(SESSIONS_DIR) } catch { return }
      for (const ws of workspaces) {
        let sessions = []
        try { sessions = fs.readdirSync(path.join(SESSIONS_DIR, ws)) } catch { continue }
        for (const s of sessions) {
          const f = path.join(SESSIONS_DIR, ws, s, 'session.v4.jsonl.zstd')
          // 非法目录名不入映射：store.writeIndex 对非法 id 抛错，且 API 侧本就无法引用
          if (validId(s) && fs.existsSync(f)) files.set(s, f)
        }
      }
      store.cleanOrphans(new Set(files.keys()))
    }
    scan()

    const worker = new Worker(new URL('./indexer.js', import.meta.url), {
      env: { ...process.env, DSH_GRAPH_WORKER: '1' }
    })
    const bridge = createBridge({ store, files, worker })

    // 已有索引的会话校验 mtime/size 决定是否重算；变化者排队后台建。
    // statSync 包 try：文件可能在 scan 与 stat 之间被删（会话清理竞态）。
    function reindexChanged(before) {
      for (const [id, file] of files) {
        try {
          const st = fs.statSync(file)
          const old = store.readIndex(id)
          if ((before && !before.has(id)) || !old || old.formatVersion !== INDEX_VERSION || old.sourceMtime !== st.mtimeMs || old.sourceSize !== st.size) bridge.requestIndex(id, false)
        } catch {}
      }
    }
    reindexChanged(null)

    // 增量：监听 sessions 目录，防抖（3s trailing + 10s max-wait，持续写入不饿死）后重扫+重算变化者
    const debounced = createDebounced(() => {
      const before = new Map(files)
      scan()
      reindexChanged(before)
    })
    let watcher = null
    try {
      watcher = fs.watch(SESSIONS_DIR, { recursive: true }, () => debounced.trigger())
    } catch (e) { console.warn('[convo-graph] 文件监听不可用: ' + e.message) }

    // R12：api.js 的 session/message op 不校验 id，穿越防线在这里——先校验再查映射
    const handle = createApi({ store, bridge, findFile: (id) => (validId(id) ? files.get(id) ?? null : null) })
    const disposers = []
    function route(kind, pathname, handler) {
      disposers.push(ctx.webServer.register({
        kind, path: pathname,
        handler: async (req, res) => {
          if (rejected(req, res)) return
          try { await handler(req, res) } catch (err) {
            try { json(res, 500, { ok: false, error: String(err?.message ?? err) }) } catch {}
          }
        }
      }))
    }
    route('exact', '/dsh-graph/api', async (req, res) => {
      // R13：content-length 明示超限 → 直接 413；chunked 情况由 api.readBody 计数兜底（同 1MB 上限）
      if (req.method === 'POST' && Number(req.headers?.['content-length']) > MAX_BODY) {
        json(res, 413, { ok: false, error: '请求体过大' })
        return
      }
      await handle(req, res, new URL(req.url, 'http://localhost'))
    })
    // R15：d3-force UMD 依赖 d3-quadtree/d3-dispatch/d3-timer（按全局 d3 取），须在其之前按序加载
    for (const name of ['force-graph.min.js', 'd3-force.min.js', 'd3-quadtree.min.js', 'd3-dispatch.min.js', 'd3-timer.min.js']) {
      route('exact', '/dsh-graph/vendor/' + name, (req, res) => {
        res.statusCode = 200
        res.setHeader('content-type', 'application/javascript; charset=utf-8')
        res.end(fs.readFileSync(path.join(HERE, 'vendor', name)))
      })
    }

    ctx.effect(() => () => {
      debounced.cancel()
      try { watcher?.close() } catch {}
      try { bridge.close() } catch {} // terminate 前排空 pending，全部 resolve null
      try { worker.terminate() } catch {}
      for (const d of disposers) { try { d() } catch {} }
    })
    console.log('[convo-graph] 已挂载：/dsh-graph/api · 数据目录 ' + DATA_DIR)
  }
}
