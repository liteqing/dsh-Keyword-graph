import fs from 'node:fs'
import path from 'node:path'

const ID_RE = /^[A-Za-z0-9_-]+$/
const CONFIG_KEYS = ['extraStopwords', 'topN', 'accent']
const DEFAULT_CONFIG = { extraStopwords: [], topN: 25, accent: '#2563eb' }

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}
function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(obj))
  fs.renameSync(tmp, file)
}

export function createStore(dir) {
  const indexDir = path.join(dir, 'index')
  const linksFile = path.join(dir, 'links.json')
  const configFile = path.join(dir, 'config.json')
  const indexPath = (id) => {
    if (!ID_RE.test(id)) throw new Error('非法会话 ID: ' + id)
    return path.join(indexDir, id + '.json')
  }
  const api = {
    writeIndex(idx) { writeJsonAtomic(indexPath(idx.sessionId), idx) },
    readIndex(id) {
      if (!ID_RE.test(id)) return null
      return readJson(indexPath(id), null)
    },
    listIndexes() {
      let names = []
      try { names = fs.readdirSync(indexDir) } catch { return [] }
      return names.filter(n => n.endsWith('.json')).map(n => readJson(path.join(indexDir, n), null)).filter(Boolean)
    },
    computeDf() {
      const df = Object.create(null)
      const all = api.listIndexes()
      for (const idx of all) {
        for (const k of idx.keywords ?? []) df[k.word] = (df[k.word] ?? 0) + 1
      }
      return { df, totalSessions: all.length }
    },
    readLinks() { return readJson(linksFile, []) },
    addLink(a, b) {
      if (!ID_RE.test(a) || !ID_RE.test(b) || a === b) return
      const [x, y] = [a, b].sort()
      const links = api.readLinks()
      if (!links.some(l => l.a === x && l.b === y)) {
        links.push({ a: x, b: y, at: Date.now() })
        writeJsonAtomic(linksFile, links)
      }
    },
    removeLink(a, b) {
      const [x, y] = [a, b].sort()
      writeJsonAtomic(linksFile, api.readLinks().filter(l => !(l.a === x && l.b === y)))
    },
    readConfig() { return { ...DEFAULT_CONFIG, ...readJson(configFile, {}) } },
    writeConfig(patch) {
      const cur = api.readConfig()
      for (const k of CONFIG_KEYS) if (patch[k] !== undefined) cur[k] = patch[k]
      writeJsonAtomic(configFile, cur)
      return cur
    },
    related(id, limit = 8) {
      const cur = api.readIndex(id)
      if (!cur) return []
      const linked = new Set(api.readLinks().filter(l => l.a === id || l.b === id).map(l => l.a === id ? l.b : l.a))
      const curWords = new Map((cur.keywords ?? []).map(k => [k.word, k.score]))
      const out = []
      for (const other of api.listIndexes()) {
        if (other.sessionId === id || linked.has(other.sessionId)) continue
        const shared = []
        let score = 0
        for (const k of other.keywords ?? []) {
          if (curWords.has(k.word)) { shared.push(k.word); score += Math.min(curWords.get(k.word), k.score) }
        }
        if (shared.length) out.push({ sessionId: other.sessionId, title: other.title, shared, score })
      }
      out.sort((a, b) => b.score - a.score || b.shared.length - a.shared.length)
      return out.slice(0, limit)
    },
    cleanOrphans(validIds) {
      for (const idx of api.listIndexes()) {
        if (!validIds.has(idx.sessionId)) {
          try { fs.unlinkSync(indexPath(idx.sessionId)) } catch {}
        }
      }
    }
  }
  return api
}
