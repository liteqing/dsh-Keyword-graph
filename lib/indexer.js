import fs from 'node:fs'
import zlib from 'node:zlib'
import * as fzstd from 'fzstd'
import { extractSession, snippet, excerptAt } from './parse.js'
import { buildKeywords, tokenizeWithPositions } from './keywords.js'
import { INDEX_VERSION } from './format.js'
import { createSessionCache } from './session-cache.js'

// 9MB 会话包：fzstd 约 3.5s，Node 内置 zstd 约 50ms。宿主 Node 太老时回退 fzstd。
const nativeDecompress = typeof zlib.zstdDecompressSync === 'function' ? zlib.zstdDecompressSync : null
export const zstdBackend = nativeDecompress ? 'native' : 'fzstd'

const ZSTD_MAGIC = 0xfd2fb528
const SKIPPABLE_MASK = 0xfffffff0
const SKIPPABLE_MAGIC = 0x184d2a50
const trunc = () => new Error('zstd 帧被截断')

/** DSH 会话包是多帧 zstd 拼接（实测 6MB 包 2333 帧），而 Electron 44 内置 Node 24.21 的
 *  zstdDecompressSync 只解第一帧就静默停下，整包解压会得到空内容。按 RFC8878 帧格式逐帧
 *  切开后各自解压；skippable 帧直接跳过。任何解析异常都由调用方回退 fzstd。 */
export function splitZstdFrames(buf) {
  const out = []
  let off = 0
  while (off < buf.length) {
    if (off + 4 > buf.length) throw trunc()
    const magic = buf.readUInt32LE(off)
    if ((magic & SKIPPABLE_MASK) === SKIPPABLE_MAGIC) {
      if (off + 8 > buf.length) throw trunc()
      off += 8 + buf.readUInt32LE(off + 4)
      if (off > buf.length) throw trunc()
      continue
    }
    if (magic !== ZSTD_MAGIC) throw new Error('非法 zstd 帧头')
    const start = off
    off += 4
    if (off >= buf.length) throw trunc()
    const fhd = buf[off++]
    const fcsFlag = fhd >> 6
    const single = (fhd >> 5) & 1
    const checksum = (fhd >> 2) & 1
    if (!single) off += 1 // window descriptor
    off += [0, 1, 2, 4][fhd & 3] // dictionary ID
    off += fcsFlag === 0 ? (single ? 1 : 0) : fcsFlag === 1 ? 2 : fcsFlag === 2 ? 4 : 8
    for (;;) {
      if (off + 3 > buf.length) throw trunc()
      const bh = buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16)
      off += 3
      const type = (bh >> 1) & 3
      if (type === 3) throw new Error('非法 zstd 块类型')
      off += type === 1 ? 1 : bh >>> 3 // RLE 块载荷固定 1 字节
      if (off > buf.length) throw trunc()
      if (bh & 1) break
    }
    if (checksum) off += 4
    if (off > buf.length) throw trunc()
    out.push(buf.subarray(start, off))
  }
  return out
}

export function decompressText(buf, native = nativeDecompress) {
  if (native) {
    try {
      const parts = splitZstdFrames(buf).map(f => native(f))
      return new TextDecoder('utf-8').decode(Buffer.concat(parts))
    } catch { /* 帧解析或逐帧解压失败 → 回退 fzstd，坏文件会在那里抛错 */ }
  }
  return new TextDecoder('utf-8').decode(fzstd.decompress(new Uint8Array(buf)))
}

export function parseJsonl(text) {
  const out = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line)) } catch {}
  }
  return out
}

// 建索引时顺手把提取结果留在内存，之后点主题/展开全文不必再整包解压
const sessionCache = createSessionCache({
  load: (file) => extractSession(parseJsonl(decompressText(fs.readFileSync(file))))
})
export function load(file) {
  return sessionCache.get(file)
}

export function buildIndexFromFile(file, { id, df, totalSessions, config }) {
  const stat = fs.statSync(file)
  const { meta, messages } = load(file)
  const { keywords, edges } = buildKeywords(messages, {
    df, totalSessions,
    topN: config?.topN ?? 25,
    extraStopwords: config?.extraStopwords ?? []
  })
  return {
    formatVersion: INDEX_VERSION,
    sessionId: id,
    workspace: meta.cwd,
    title: meta.title ?? id,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    sourceMtime: stat.mtimeMs,
    sourceSize: stat.size,
    messages: messages.map(m => ({ seq: m.seq, role: m.role, time: m.time, turn: m.turn, snippet: snippet(m.text) })),
    keywords,
    edges
  }
}

export function readMessageFrom(file, seq) {
  const { messages } = load(file)
  const i = messages.findIndex(m => m.seq === seq)
  if (i === -1) return null
  return { message: messages[i], prev: messages[i - 1] ?? null, next: messages[i + 1] ?? null }
}

// 面板预览：按分词精确匹配（mod 不会命中 model），返回关键词居中的消息片段。
export function readExcerptsFrom(file, word, limit = 50) {
  const needle = String(word ?? '').trim().toLowerCase()
  if (!needle) return []
  const { messages } = load(file)
  const out = []
  for (const m of messages) {
    const hit = tokenizeWithPositions(m.text).find(t => t.w === needle)
    if (!hit) continue
    out.push({ seq: m.seq, excerpt: excerptAt(m.text, hit.pos, hit.raw.length) })
    if (out.length >= limit) break
  }
  return out
}

export function startWorkerLoop(port) {
  port.on('message', (msg) => {
    try {
      if (msg.type === 'index-one') {
        const index = buildIndexFromFile(msg.file, msg)
        port.postMessage({ type: 'indexed', id: msg.id, index })
      } else if (msg.type === 'read-message') {
        const result = readMessageFrom(msg.file, msg.seq)
        port.postMessage({ type: 'message', id: msg.id, seq: msg.seq, result })
      } else if (msg.type === 'excerpts') {
        const result = readExcerptsFrom(msg.file, msg.word)
        port.postMessage({ type: 'excerpts', id: msg.id, word: msg.word, result })
      }
    } catch (e) {
      port.postMessage({ type: 'error', id: msg?.id, seq: msg?.seq, word: msg?.word, error: String(e?.message ?? e) })
    }
  })
}

if (process.env.DSH_GRAPH_WORKER === '1') {
  const { parentPort } = await import('node:worker_threads')
  startWorkerLoop(parentPort)
}
