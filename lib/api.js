import { buildGraph } from './graph.js'

export function json(res, code, obj) {
  res.statusCode = code
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(obj))
}

const MAX_BODY = 1048576

export async function readBody(req, limit = MAX_BODY) {
  const chunks = []
  let size = 0
  for await (const c of req) {
    size += c.length
    if (size > limit) {
      const err = new Error('请求体过大')
      err.statusCode = 413
      throw err
    }
    chunks.push(c)
  }
  return Buffer.concat(chunks).toString('utf8')
}

const MAX_LINKED = 10
const ID_RE = /^[A-Za-z0-9_-]+$/
const validId = (id) => typeof id === 'string' && ID_RE.test(id)

function parseBody(raw) {
  let obj
  try { obj = JSON.parse(raw || '{}') } catch { return null }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
  return obj
}

function clampTopN(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 25
  return Math.min(30, Math.max(1, Math.round(v)))
}

export function createApi({ store, bridge, findFile }) {
  return async function handle(req, res, url) {
    try {
      const op = url.searchParams.get('op')
      const id = url.searchParams.get('id') ?? ''
      if (op === 'session') {
        const idx = store.readIndex(id)
        if (!idx) {
          const file = findFile(id)
          if (file) bridge.requestIndex(id)
          json(res, 200, { ok: true, status: file ? 'indexing' : 'missing' })
          return
        }
        const linkedIds = [...new Set(store.readLinks()
          .filter(l => l.a === id || l.b === id)
          .map(l => (l.a === id ? l.b : l.a))
          .filter(x => x !== id))].slice(0, MAX_LINKED)
        const linked = linkedIds.map(x => store.readIndex(x)).filter(Boolean)
        json(res, 200, {
          ok: true, status: 'ready', title: idx.title, updatedAt: idx.updatedAt,
          graph: buildGraph(idx, linked), messages: idx.messages, linked: linkedIds
        })
        return
      }
      if (op === 'related') {
        let limit = Number(url.searchParams.get('limit'))
        if (!Number.isFinite(limit) || limit < 1) limit = 8
        limit = Math.min(MAX_LINKED, Math.floor(limit))
        json(res, 200, { ok: true, related: store.related(id, limit) })
        return
      }
      if (op === 'link') {
        const body = parseBody(await readBody(req))
        if (!body) { json(res, 400, { ok: false, error: '非法请求体' }); return }
        const { a, b } = body
        if (!validId(a) || !validId(b) || a === b) { json(res, 400, { ok: false, error: '非法会话 ID' }); return }
        if (req.method === 'POST') {
          const links = store.readLinks()
          const exists = links.some(l => (l.a === a && l.b === b) || (l.a === b && l.b === a))
          if (!exists) {
            const countA = links.filter(l => l.a === a || l.b === a).length
            const countB = links.filter(l => l.a === b || l.b === b).length
            if (countA >= MAX_LINKED || countB >= MAX_LINKED) {
              json(res, 400, { ok: false, error: '关联会话数已达上限（10 条）' })
              return
            }
          }
          store.addLink(a, b)
        } else if (req.method === 'DELETE') store.removeLink(a, b)
        else { json(res, 405, { ok: false, error: '方法不允许' }); return }
        json(res, 200, { ok: true })
        return
      }
      if (op === 'message') {
        const seq = Number(url.searchParams.get('seq'))
        const file = findFile(id)
        if (!file || !Number.isFinite(seq)) { json(res, 404, { ok: false, error: '会话或消息不存在' }); return }
        const result = await bridge.readMessage(id, seq)
        json(res, 200, { ok: true, result })
        return
      }
      if (op === 'status') { json(res, 200, { ok: true, ...bridge.status() }); return }
      if (op === 'config') {
        if (req.method === 'POST') {
          const patch = parseBody(await readBody(req))
          if (!patch) { json(res, 400, { ok: false, error: '非法请求体' }); return }
          if (patch.topN !== undefined) patch.topN = clampTopN(patch.topN)
          json(res, 200, { ok: true, config: store.writeConfig(patch) })
        } else json(res, 200, { ok: true, config: store.readConfig() })
        return
      }
      json(res, 404, { ok: false, error: '未知 op' })
    } catch (err) {
      json(res, (err && err.statusCode) || 500, { ok: false, error: String((err && err.message) || err) })
    }
  }
}
