import fs from 'node:fs'
import * as fzstd from 'fzstd'
import { extractSession, snippet } from './parse.js'
import { buildKeywords } from './keywords.js'

export function decompressText(buf) {
  const out = fzstd.decompress(new Uint8Array(buf))
  return new TextDecoder('utf-8').decode(out)
}

export function parseJsonl(text) {
  const out = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line)) } catch {}
  }
  return out
}

function load(file) {
  return extractSession(parseJsonl(decompressText(fs.readFileSync(file))))
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
    formatVersion: 1,
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

export function startWorkerLoop(port) {
  port.on('message', (msg) => {
    try {
      if (msg.type === 'index-one') {
        const index = buildIndexFromFile(msg.file, msg)
        port.postMessage({ type: 'indexed', id: msg.id, index })
      } else if (msg.type === 'read-message') {
        const result = readMessageFrom(msg.file, msg.seq)
        port.postMessage({ type: 'message', id: msg.id, seq: msg.seq, result })
      }
    } catch (e) {
      port.postMessage({ type: 'error', id: msg.id, error: String(e?.message ?? e) })
    }
  })
}

if (process.env.DSH_GRAPH_WORKER === '1') {
  const { parentPort } = await import('node:worker_threads')
  startWorkerLoop(parentPort)
}