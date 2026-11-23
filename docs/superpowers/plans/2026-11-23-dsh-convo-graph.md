# dsh-convo-graph 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 DSH 桌面版做一个插件，在会话顶栏加「图谱」标签，把当前会话归纳成可点击定位消息的主题点线图，手动关联跨会话，纯本地零成本。

**Architecture:** cordis 宿主插件（HTTP API + worker_threads 索引线程 + fs.watch 增量）+ 客户端 conversation.view 插槽标签页（force-graph Canvas 渲染）。索引库为 JSON（关键词→消息 seq + 80 字摘要），原文不复制，点消息时现读 DSH 源文件。

**Tech Stack:** Node ESM、fzstd（纯 JS zstd 解压）、Intl.Segmenter（内置中文分词）、TF-IDF、force-graph + d3-force（vendored UMD）、node --test。

**Spec:** `docs/superpowers/specs/2026-11-23-dsh-convo-graph-design.md`（相对仓库根目录）

## Global Constraints

- 包名 `dsh-convo-graph`；`cordis.patch.yml` 的 `name:` 必须与包名完全一致
- 零原生依赖：npm 依赖仅 `fzstd@0.1.1`（纯 JS）；force-graph / d3-force 以 UMD 静态文件 vendored 进 `lib/vendor/`
- 所有 HTTP 路由过信任栅栏，fail-closed（栅栏不可用=拒绝）；仅回环/DSH 信任来源放行
- 索引不存对话全文；`snippet` = 消息文本前 80 字 + '…'
- topN 默认 25、硬上限 30；关联会话上限 10；主题节点碰撞半径 = nodeRadius+6
- 选中/悬停高亮默认鲸鱼蓝 `#2563eb`，暗主题 `#5b8cff`，config.json `accent` 可改
- 测试命令 `npm test` = `node --test tests/*.test.mjs`；fixtures 全部编造，仓库不含真实对话
- 会话源文件：`~/.dsh/sessions/<工作区编码>/<会话目录>/session.v4.jsonl.zstd`；会话 ID = 会话目录名
- 记录形状（已实测）：`user/message` → `data.content[{type:'text',text}]`；`assistant/message` → `data.message.content[]`（只取 type==='text'，跳过 reasoning）；`session/title` → `data.title`；`session` 头 → `id/createdAt/cwd`；`turn/start` → `data.turn`
- 路由用已验证的 `ctx.webServer.register({kind:'exact', path, handler})`；API 单路径 `/dsh-graph/api?op=…` 分发（不猜未验证的 prefix 匹配）
- 每个任务结束 commit；Windows 环境，路径一律 path.join

---

### Task 1: 项目脚手架 + 会话解析器 parse.js

**Files:**
- Create: `package.json`, `.gitignore`, `lib/parse.js`, `tests/parse.test.mjs`

**Interfaces:**
- Produces: `extractSession(records) → {meta:{sessionId,title,createdAt,updatedAt,cwd}, messages:[{seq,role,time,turn,text}]}`；`snippet(text,n=80)`

- [ ] **Step 1: 脚手架 + git init**

`package.json`：
```json
{
  "name": "dsh-convo-graph",
  "version": "0.1.0",
  "description": "DSH 会话图谱：顶栏图谱标签，当前会话主题点线图，点击定位消息，手动关联跨会话",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./package.json": "./package.json"
  },
  "scripts": { "test": "node --test tests/*.test.mjs" },
  "files": ["lib", "cordis.patch.yml", "README.md", "LICENSE", "tests"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "inject": [], "platform": "web" }
  },
  "license": "MIT",
  "dependencies": { "fzstd": "0.1.1" }
}
```
`.gitignore`：`node_modules/`、`tmp/`。
运行 `git init && npm install`（fzstd 纯 JS，无编译）。

- [ ] **Step 2: 写失败测试** `tests/parse.test.mjs`

```js
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
  { type: 'user/message', seq: 7, time: 1007, data: { role: 'user', content: [{ type: 'text', text: '再看看皮肤' }] } }
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
```

- [ ] **Step 3: 跑测试确认失败**：`npm test` → FAIL（Cannot find module '../lib/parse.js'）

- [ ] **Step 4: 实现** `lib/parse.js`

```js
function joinText(content) {
  if (!Array.isArray(content)) return ''
  return content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n').trim()
}

export function snippet(text, n = 80) {
  return text.length > n ? text.slice(0, n) + '…' : text
}

export function extractSession(records) {
  const meta = { sessionId: null, title: null, createdAt: null, updatedAt: null, cwd: null }
  const messages = []
  let turn = 0
  for (const r of records) {
    if (!r || typeof r !== 'object') continue
    switch (r.type) {
      case 'session':
        meta.sessionId = r.id ?? meta.sessionId
        meta.createdAt = r.createdAt ?? meta.createdAt
        meta.cwd = r.cwd ?? meta.cwd
        break
      case 'session/title':
        if (typeof r.data?.title === 'string') meta.title = r.data.title
        break
      case 'turn/start':
        turn = typeof r.data?.turn === 'number' ? r.data.turn : turn + 1
        break
      case 'user/message': {
        const text = joinText(r.data?.content)
        if (text) messages.push({ seq: r.seq, role: 'user', time: r.time, turn, text })
        break
      }
      case 'assistant/message': {
        if (typeof r.data?.turn === 'number') turn = r.data.turn
        const text = joinText(r.data?.message?.content)
        if (text) messages.push({ seq: r.seq, role: 'assistant', time: r.time, turn, text })
        break
      }
    }
    if (typeof r.time === 'number') meta.updatedAt = r.time
  }
  return { meta, messages }
}
```

- [ ] **Step 5: 跑测试确认通过**：`npm test` → 3 pass
- [ ] **Step 6: Commit**：`git add package.json .gitignore lib/parse.js tests/parse.test.mjs && git commit -m "feat: 会话记录解析器（消息/轮次/标题提取）"`

---

### Task 2: 停用词表 + 关键词算法 keywords.js

**Files:**
- Create: `lib/stopwords.js`, `lib/keywords.js`, `tests/keywords.test.mjs`

**Interfaces:**
- Consumes: Task 1 的 messages 形状 `{seq,role,time,turn,text}`
- Produces: `tokenize(text) → string[]`；`buildKeywords(messages, {df={}, totalSessions=1, topN=25, extraStopwords=[]}) → {keywords:[{word,score,count,msgs:number[]}], edges:[{a,b,weight}]}`（df 为 plain object：词→含该词的会话数）

- [ ] **Step 1: 写失败测试** `tests/keywords.test.mjs`

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { tokenize, buildKeywords } from '../lib/keywords.js'

const MSGS = [
  { seq: 1, role: 'user', turn: 1, text: '帮我把modx的物理改一下，物理太果冻了' },
  { seq: 2, role: 'assistant', turn: 1, text: '物理参数已调整，modx的物理不再果冻' },
  { seq: 3, role: 'user', turn: 2, text: '再看看模型皮肤' }
]

test('tokenize 去停用词/短词/纯符号', () => {
  const ws = tokenize('帮我把物理改一下，123 !!!')
  assert.ok(ws.includes('物理'))
  assert.ok(!ws.includes('帮我'))
  assert.ok(!ws.includes('把'))
  assert.ok(!ws.includes('123'))
})

test('buildKeywords 词频排序+消息定位+共现边', () => {
  const { keywords, edges } = buildKeywords(MSGS, { df: { 物理: 1, lrose: 1, 情人节: 3 }, totalSessions: 4 })
  const top = keywords[0]
  assert.equal(top.word, '物理')           // 本会话3次且别处罕见
  assert.deepEqual(top.msgs, [1, 2])
  const e = edges.find(x => (x.a === 'lrose' && x.b === '物理') || (x.a === '物理' && x.b === 'lrose'))
  assert.equal(e.weight, 1)                // 同轮共现1次
  assert.ok(keywords.every(k => k.word !== '帮我'))
})

test('topN 上限 30', () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ seq: i, role: 'user', turn: i, text: '词' + i + ' 词' + i }))
  const { keywords } = buildKeywords(many, { topN: 99 })
  assert.ok(keywords.length <= 30)
})
```

- [ ] **Step 2: 跑测试确认失败**：`npm test` → FAIL（模块不存在）

- [ ] **Step 3: 实现** `lib/stopwords.js`

```js
export const STOPWORDS = new Set(('的 了 我们 你们 帮我 把 被 和 与 及 或 等 是 在 有 就 都 而 着 过 吗 呢 吧 啊 这个 那个 什么 怎么 如何 可以 需要 使用 进行 通过 对于 关于 以及 因为 所以 但是 而且 如果 虽然 然后 接着 最后 首先 一下 一个 一些 没有 不是 就是 还是 只是 只有 才 再 又 很 太 更 最 已 已经 正在 会 能 可能 应该 必须 这个 那个 这里 那里 现在 今天 明天 昨天 时候 问题 情况 东西 事情 方法 方式 内容 部分 全部 所有 每个 其他 另外 之后 之前 以上 以下 左右 上下 里面 外面 中间 旁边 直接 间接 重新 继续 开始 结束 完成 实现 支持 提供 包含 包括 属于 用于 作为 成为 得到 获得 给出 表示 说明 描述 分析 处理 操作 执行 运行 调用 返回 输入 输出 添加 删除 修改 更新 检查 确认 验证 测试 调试 错误 异常 失败 成功 正确 正常 http https www com cn file path null true false const let var function return import export default class new type string number object array undefined the a an is are was were be been to of in on for with and or not no yes do does did done it its this that these those i you he she we they me him her us them my your his our their').split(/\s+/))
```

- [ ] **Step 4: 实现** `lib/keywords.js`

```js
import { STOPWORDS } from './stopwords.js'

const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })

export function tokenize(text) {
  const out = []
  for (const { segment, isWordLike } of segmenter.segment(text)) {
    if (!isWordLike) continue
    const w = segment.toLowerCase()
    if (w.length < 2) continue
    if (STOPWORDS.has(w)) continue
    if (/^[\d\p{P}\p{S}]+$/u.test(w)) continue
    out.push(w)
  }
  return out
}

export function buildKeywords(messages, { df = {}, totalSessions = 1, topN = 25, extraStopwords = [] } = {}) {
  const extra = new Set(extraStopwords)
  const counts = new Map()   // word → {count, msgs:Set, turns:Map<turn,Set<word>> 共享}
  const turnWords = new Map() // turn → Set<word>
  for (const m of messages) {
    for (const w of tokenize(m.text)) {
      if (extra.has(w)) continue
      let c = counts.get(w)
      if (!c) { c = { count: 0, msgs: new Set() }; counts.set(w, c) }
      c.count++
      c.msgs.add(m.seq)
      let tw = turnWords.get(m.turn)
      if (!tw) { tw = new Set(); turnWords.set(m.turn, tw) }
      tw.add(w)
    }
  }
  const scored = [...counts.entries()].map(([word, c]) => ({
    word,
    count: c.count,
    msgs: [...c.msgs].sort((a, b) => a - b),
    score: c.count * (Math.log((totalSessions + 1) / ((df[word] ?? 0) + 1)) + 1)
  }))
  scored.sort((a, b) => b.score - a.score || b.count - a.count || a.word.localeCompare(b.word))
  const keywords = scored.slice(0, Math.min(topN, 30))
  const top = new Set(keywords.map(k => k.word))
  const pairWeight = new Map()
  for (const tw of turnWords.values()) {
    const ws = [...tw].filter(w => top.has(w)).sort()
    for (let i = 0; i < ws.length; i++)
      for (let j = i + 1; j < ws.length; j++) {
        const key = ws[i] + '\u0000' + ws[j]
        pairWeight.set(key, (pairWeight.get(key) ?? 0) + 1)
      }
  }
  const edges = [...pairWeight.entries()].map(([key, weight]) => {
    const [a, b] = key.split('\u0000')
    return { a, b, weight }
  })
  return { keywords, edges }
}
```

- [ ] **Step 5: 跑测试确认通过**：`npm test` → 全 pass
- [ ] **Step 6: Commit**：`git commit -am "feat: 中文分词+TF-IDF 关键词与共现边"`

---

### Task 3: 索引库 store.js

**Files:**
- Create: `lib/store.js`, `tests/store.test.mjs`

**Interfaces:**
- Consumes: Task 2 的 index 内容字段（keywords/edges/messages/meta）
- Produces: `createStore(dir)` → `{ writeIndex(idx), readIndex(id), listIndexes(), computeDf() → {df, totalSessions}, readLinks(), addLink(a,b), removeLink(a,b), readConfig(), writeConfig(patch), related(id, limit=8), cleanOrphans(validIds) }`；config 默认 `{extraStopwords:[], topN:25, accent:'#2563eb'}`；index 文件 `index/<id>.json`，id 仅允许 `[A-Za-z0-9_-]+`

- [ ] **Step 1: 写失败测试** `tests/store.test.mjs`

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStore } from '../lib/store.js'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-graph-'))
const idx = (id, words) => ({
  formatVersion: 1, sessionId: id, title: '标题' + id, updatedAt: 1,
  messages: [], edges: [],
  keywords: words.map((w, i) => ({ word: w, score: 10 - i, count: 3, msgs: [1] }))
})

test('索引读写+原子性', () => {
  const s = createStore(tmp())
  s.writeIndex(idx('session-a', ['物理', 'lrose']))
  assert.equal(s.readIndex('session-a').title, '标题session-a')
  assert.equal(s.listIndexes().length, 1)
  assert.equal(s.readIndex('nope'), null)
})

test('非法 id 拒绝', () => {
  const s = createStore(tmp())
  assert.throws(() => s.writeIndex(idx('../evil', [])))
})

test('links 去重+取消', () => {
  const s = createStore(tmp())
  s.addLink('a', 'b'); s.addLink('b', 'a')
  assert.equal(s.readLinks().length, 1)
  s.removeLink('a', 'b')
  assert.equal(s.readLinks().length, 0)
})

test('related 按共享词分数排序且排除已关联', () => {
  const s = createStore(tmp())
  s.writeIndex(idx('cur', ['物理', 'lrose', '模组']))
  s.writeIndex(idx('x', ['物理', 'lrose']))
  s.writeIndex(idx('y', ['模组']))
  s.addLink('cur', 'y')
  const rel = s.related('cur')
  assert.deepEqual(rel.map(r => r.sessionId), ['x'])
  assert.deepEqual(rel[0].shared.sort(), ['lrose', '物理'])
})

test('config 白名单+默认值', () => {
  const s = createStore(tmp())
  assert.equal(s.readConfig().accent, '#2563eb')
  s.writeConfig({ accent: '#ff0000', evil: 1 })
  assert.equal(s.readConfig().accent, '#ff0000')
  assert.equal(s.readConfig().evil, undefined)
})

test('computeDf 与 cleanOrphans', () => {
  const s = createStore(tmp())
  s.writeIndex(idx('a', ['物理']))
  s.writeIndex(idx('b', ['物理', '模组']))
  const { df, totalSessions } = s.computeDf()
  assert.equal(df['物理'], 2)
  assert.equal(totalSessions, 2)
  s.cleanOrphans(new Set(['a']))
  assert.deepEqual(s.listIndexes().map(i => i.sessionId), ['a'])
})
```

- [ ] **Step 2: 跑测试确认失败**：`npm test` → FAIL

- [ ] **Step 3: 实现** `lib/store.js`

```js
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
      const df = {}
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
```

- [ ] **Step 4: 跑测试确认通过**：`npm test` → 全 pass
- [ ] **Step 5: Commit**：`git commit -am "feat: JSON 索引库（索引/关联/配置/相关推荐/孤儿清理）"`

---

### Task 4: 索引器 indexer.js（解压+建索引+读原文+worker 协议）

**Files:**
- Create: `lib/indexer.js`, `tests/indexer.test.mjs`

**Interfaces:**
- Consumes: Task 1 `extractSession/snippet`、Task 2 `buildKeywords`
- Produces: `decompressText(buf) → string`；`parseJsonl(text) → records[]`；`buildIndexFromFile(file, {id, df, totalSessions, config}) → index`；`readMessageFrom(file, seq) → {message, prev, next} | null`（message 含全文 text）；`startWorkerLoop(port)`；worker 环境变量 `DSH_GRAPH_WORKER=1` 时自启动；worker 消息协议：收 `{type:'index-one', id, file, df, totalSessions, config}` 回 `{type:'indexed', id, index}`；收 `{type:'read-message', id, file, seq}` 回 `{type:'message', id, seq, result}`；异常回 `{type:'error', id, error}`

- [ ] **Step 1: 写失败测试** `tests/indexer.test.mjs`

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { buildIndexFromFile, readMessageFrom, decompressText } from '../lib/indexer.js'

const RECORDS = [
  { type: 'session', id: 'session-fx', createdAt: 1000, cwd: 'E:\\demo' },
  { type: 'turn/start', seq: 1, time: 1001, data: { turn: 1 } },
  { type: 'user/message', seq: 2, time: 1002, data: { role: 'user', content: [{ type: 'text', text: '物理太果冻了，改一下物理' }] } },
  { type: 'assistant/message', seq: 3, time: 1003, data: { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: '物理已调整完毕' }] } } },
  { type: 'session/title', seq: 4, time: 1004, data: { title: '物理调整' } }
]
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-graph-fx-'))
  const file = path.join(dir, 'session.v4.jsonl.zstd')
  const jsonl = RECORDS.map(r => JSON.stringify(r)).join('\n') + '\n'
  fs.writeFileSync(file, zlib.zstdCompressSync(Buffer.from(jsonl, 'utf8')))
  return file
}

test('buildIndexFromFile 端到端', () => {
  const file = fixture()
  const idx = buildIndexFromFile(file, { id: 'session-fx', df: {}, totalSessions: 1, config: { topN: 25, extraStopwords: [] } })
  assert.equal(idx.formatVersion, 1)
  assert.equal(idx.title, '物理调整')
  assert.equal(idx.messages.length, 2)
  assert.ok(idx.messages[0].snippet.length <= 81)
  assert.ok(idx.keywords.some(k => k.word === '物理'))
  assert.ok(idx.sourceSize > 0)
})

test('readMessageFrom 全文+前后邻居', () => {
  const file = fixture()
  const r = readMessageFrom(file, 3)
  assert.equal(r.message.text, '物理已调整完毕')
  assert.equal(r.prev.seq, 2)
  assert.equal(r.next, null)
  assert.equal(readMessageFrom(file, 999), null)
})

test('写一半的 zstd 抛错（宿主保留旧索引重试）', () => {
  const file = fixture()
  const buf = fs.readFileSync(file)
  const bad = file + '.bad'
  fs.writeFileSync(bad, buf.subarray(0, Math.floor(buf.length / 2)))
  assert.throws(() => decompressText(fs.readFileSync(bad)))
})
```

- [ ] **Step 2: 跑测试确认失败**：`npm test` → FAIL

- [ ] **Step 3: 实现** `lib/indexer.js`

```js
import fs from 'node:fs'
import fzstd from 'fzstd'
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
```

- [ ] **Step 4: 跑测试确认通过**：`npm test` → 全 pass（测试用 node 24 内置 zstd 压缩造 fixture，验证 fzstd 解压）
- [ ] **Step 5: Commit**：`git commit -am "feat: 索引器 worker（fzstd 解压/建索引/按 seq 读原文）"`

---

### Task 5: 图谱数据 shaping graph.js

**Files:**
- Create: `lib/graph.js`, `tests/graph.test.mjs`

**Interfaces:**
- Consumes: Task 3/4 的 index 对象
- Produces: `nodeRadius(node) → number`（session=9；topic=4+sqrt(val)*2）；`buildGraph(current, linkedIndexes) → {nodes, links}`；node 形状 `{id:'s:'+sessionId|'t:'+word, kind:'session'|'topic', label, val, msgs?:[{s,seq}], sessionId?}`；link 形状 `{source, target, kind:'member'|'cooccur', weight}`；共享词合并为单一 topic 节点

- [ ] **Step 1: 写失败测试** `tests/graph.test.mjs`

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildGraph, nodeRadius } from '../lib/graph.js'

const A = {
  sessionId: 'a', title: '会话A',
  keywords: [{ word: '物理', score: 8, msgs: [1, 2] }, { word: 'lrose', score: 5, msgs: [2] }],
  edges: [{ a: 'lrose', b: '物理', weight: 3 }]
}
const B = {
  sessionId: 'b', title: '会话B',
  keywords: [{ word: '物理', score: 4, msgs: [7] }],
  edges: []
}

test('共享主题合并为单节点并连两个会话', () => {
  const { nodes, links } = buildGraph(A, [B])
  const topics = nodes.filter(n => n.kind === 'topic')
  assert.equal(topics.length, 2) // 物理 + lrose，物理不重复
  const phys = topics.find(n => n.label === '物理')
  assert.equal(phys.val, 12)
  assert.deepEqual(phys.msgs, [{ s: 'a', seq: 1 }, { s: 'a', seq: 2 }, { s: 'b', seq: 7 }])
  const members = links.filter(l => l.kind === 'member' && l.source === 't:物理')
  assert.deepEqual(members.map(l => l.target).sort(), ['s:a', 's:b'])
  assert.equal(nodes.filter(n => n.kind === 'session').length, 2)
})

test('共现边跨会话同 pair 合并权重', () => {
  const B2 = { ...B, edges: [{ a: 'lrose', b: '物理', weight: 2 }] }
  const { links } = buildGraph(A, [B2])
  const co = links.filter(l => l.kind === 'cooccur')
  assert.equal(co.length, 1)
  assert.equal(co[0].weight, 5)
})

test('nodeRadius 单调', () => {
  assert.ok(nodeRadius({ kind: 'topic', val: 16 }) > nodeRadius({ kind: 'topic', val: 4 }))
  assert.equal(nodeRadius({ kind: 'session', val: 1 }), 9)
})
```

- [ ] **Step 2: 跑测试确认失败**：`npm test` → FAIL

- [ ] **Step 3: 实现** `lib/graph.js`

```js
export function nodeRadius(node) {
  return node.kind === 'session' ? 9 : 4 + Math.sqrt(node.val) * 2
}

export function buildGraph(current, linkedIndexes = []) {
  const nodes = new Map()
  const linkMap = new Map()
  const addLink = (source, target, kind, weight) => {
    const key = kind + '|' + source + '|' + target
    const old = linkMap.get(key)
    if (old) old.weight += weight
    else linkMap.set(key, { source, target, kind, weight })
  }
  for (const idx of [current, ...linkedIndexes]) {
    if (!idx) continue
    const sid = 's:' + idx.sessionId
    nodes.set(sid, { id: sid, kind: 'session', label: idx.title ?? idx.sessionId, val: 1, sessionId: idx.sessionId })
    for (const kw of idx.keywords ?? []) {
      const tid = 't:' + kw.word
      let t = nodes.get(tid)
      if (!t) { t = { id: tid, kind: 'topic', label: kw.word, val: 0, msgs: [] }; nodes.set(tid, t) }
      t.val += kw.score
      for (const seq of kw.msgs ?? []) t.msgs.push({ s: idx.sessionId, seq })
      addLink(tid, sid, 'member', kw.score)
    }
    for (const e of idx.edges ?? []) addLink('t:' + e.a, 't:' + e.b, 'cooccur', e.weight)
  }
  return { nodes: [...nodes.values()], links: [...linkMap.values()] }
}
```

- [ ] **Step 4: 跑测试确认通过**：`npm test` → 全 pass
- [ ] **Step 5: Commit**：`git commit -am "feat: 图谱 shaping（共享主题合并/碰撞半径）"`

---

### Task 6: HTTP API 逻辑 api.js（op 分发，可单测）

**Files:**
- Create: `lib/api.js`, `tests/api.test.mjs`

**Interfaces:**
- Consumes: Task 3 store、Task 5 buildGraph
- Produces: `createApi({store, bridge, findFile}) → async handle(req, res, url)`；`bridge = {requestIndex(id), readMessage(id, seq) → Promise, status() → {queue, indexing}}`；`findFile(id) → path|null`；`json(res, code, obj)`、`readBody(req)` 导出供 index.js 复用。op 清单：`session` / `related` / `link`(POST/DELETE) / `message` / `status` / `config`(GET/POST)

- [ ] **Step 1: 写失败测试** `tests/api.test.mjs`

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStore } from '../lib/store.js'
import { createApi } from '../lib/api.js'

function setup() {
  const store = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-graph-api-')))
  const indexed = new Set()
  const bridge = {
    requestIndex: (id) => { indexed.add(id) },
    readMessage: async (id, seq) => ({ message: { seq, text: '全文' + seq }, prev: null, next: null }),
    status: () => ({ queue: 0, indexing: null })
  }
  const handle = createApi({ store, bridge, findFile: (id) => '/fake/' + id })
  const call = (op, { method = 'GET', body, params = '' } = {}) => {
    const res = { statusCode: 0, payload: null, setHeader() {}, end(p) { this.payload = JSON.parse(p) } }
    const req = { method, headers: { host: '127.0.0.1:9' }, async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(JSON.stringify(body)) } }
    return handle(req, res, new URL('http://x/dsh-graph/api?op=' + op + params)).then(() => res)
  }
  return { store, bridge, call, indexed }
}
const IDX = { formatVersion: 1, sessionId: 'a', title: 'A', messages: [{ seq: 1, role: 'user', snippet: '物理' }], keywords: [{ word: '物理', score: 8, msgs: [1] }], edges: [] }

test('session 未索引→indexing 并触发请求；已索引→ready+graph', async () => {
  const { store, call, indexed } = setup()
  let res = await call('session', { params: '&id=a' })
  assert.equal(res.payload.status, 'indexing')
  assert.ok(indexed.has('a'))
  store.writeIndex(IDX)
  res = await call('session', { params: '&id=a' })
  assert.equal(res.payload.status, 'ready')
  assert.ok(res.payload.graph.nodes.some(n => n.id === 't:物理'))
})

test('link 增删反映到 session.linked', async () => {
  const { store, call } = setup()
  store.writeIndex(IDX)
  store.writeIndex({ ...IDX, sessionId: 'b', title: 'B' })
  await call('link', { method: 'POST', body: { a: 'a', b: 'b' } })
  let res = await call('session', { params: '&id=a' })
  assert.deepEqual(res.payload.linked, ['b'])
  assert.equal(res.payload.graph.nodes.filter(n => n.kind === 'session').length, 2)
  await call('link', { method: 'DELETE', body: { a: 'a', b: 'b' } })
  res = await call('session', { params: '&id=a' })
  assert.deepEqual(res.payload.linked, [])
})

test('message 透传 bridge；未知 op 404', async () => {
  const { call } = setup()
  const res = await call('message', { params: '&id=a&seq=1' })
  assert.equal(res.payload.result.message.text, '全文1')
  const bad = await call('nope')
  assert.equal(bad.statusCode, 404)
})
```

- [ ] **Step 2: 跑测试确认失败**：`npm test` → FAIL

- [ ] **Step 3: 实现** `lib/api.js`

```js
import { buildGraph } from './graph.js'

export function json(res, code, obj) {
  res.statusCode = code
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(obj))
}

export async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  return Buffer.concat(chunks).toString('utf8')
}

const MAX_LINKED = 10

export function createApi({ store, bridge, findFile }) {
  return async function handle(req, res, url) {
    const op = url.searchParams.get('op')
    const id = url.searchParams.get('id') ?? ''
    if (op === 'session') {
      const idx = store.readIndex(id)
      if (!idx) {
        if (findFile(id)) bridge.requestIndex(id)
        json(res, 200, { ok: true, status: findFile(id) ? 'indexing' : 'missing' })
        return
      }
      const linkedIds = store.readLinks()
        .filter(l => l.a === id || l.b === id)
        .map(l => (l.a === id ? l.b : l.a))
        .slice(0, MAX_LINKED)
      const linked = linkedIds.map(x => store.readIndex(x)).filter(Boolean)
      json(res, 200, {
        ok: true, status: 'ready', title: idx.title, updatedAt: idx.updatedAt,
        graph: buildGraph(idx, linked), messages: idx.messages, linked: linkedIds
      })
      return
    }
    if (op === 'related') { json(res, 200, { ok: true, related: store.related(id) }); return }
    if (op === 'link') {
      const body = JSON.parse((await readBody(req)) || '{}')
      if (req.method === 'POST') store.addLink(body.a, body.b)
      else if (req.method === 'DELETE') store.removeLink(body.a, body.b)
      else { json(res, 405, { ok: false }); return }
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
        const patch = JSON.parse((await readBody(req)) || '{}')
        json(res, 200, { ok: true, config: store.writeConfig(patch) })
      } else json(res, 200, { ok: true, config: store.readConfig() })
      return
    }
    json(res, 404, { ok: false, error: '未知 op' })
  }
}
```

- [ ] **Step 4: 跑测试确认通过**：`npm test` → 全 pass
- [ ] **Step 5: Commit**：`git commit -am "feat: API op 分发（session/related/link/message/status/config）"`

---

### Task 7: 宿主接线 index.js + 挂载声明 + vendor 静态库

**Files:**
- Create: `lib/index.js`, `cordis.patch.yml`, `lib/vendor/force-graph.min.js`, `lib/vendor/d3-force.min.js`
- Modify: `package.json`（files 已含 lib，无需改）

**Interfaces:**
- Consumes: Task 3 createStore、Task 4 worker 协议、Task 6 createApi/json
- Produces: 可安装插件：`export default {name:'dsh-convo-graph', inject:['webServer','connection'], apply(ctx)}`；路由 `GET/POST /dsh-graph/api?op=…` 与 `GET /dsh-graph/vendor/*.js`；数据目录 `~/.dsh/dsh-graph/`

- [ ] **Step 1: vendor 两个 UMD 库**

```bash
mkdir -p tmp/vendor && cd tmp/vendor
npm init -y >/dev/null && npm i force-graph d3-force --no-audit --no-fund
cp node_modules/force-graph/dist/force-graph.min.js ../../lib/vendor/
cp node_modules/d3-force/dist/d3-force.min.js ../../lib/vendor/
cd ../.. && rm -rf tmp/vendor
```
（tmp/ 在 .gitignore；vendor 文件进 git。force-graph UMD 全局 `ForceGraph`，d3-force UMD 全局 `d3`。）

- [ ] **Step 2: 写** `cordis.patch.yml`

```yaml
# dsh-convo-graph —— DSH bundle patch
# 安装（本地开发）：dsh plugin --profile desktop add "link:<仓库绝对路径>"
# 发布后：dsh plugin --profile desktop add dsh-convo-graph
# ⚠️ name 必须与包名完全一致，否则「装上了但页面 404」
- insert:
    - id: dsh-convo-graph
      name: dsh-convo-graph
```

- [ ] **Step 3: 写** `lib/index.js`

信任栅栏三函数（isLoopbackReq/isTrustedReq/rejected）**逐字照抄**养鱼插件 `C:\Users\Nico\.dsh\plugins\dsh-bili-whale\lib\index.js:160-205` 的实现（fail-closed），仅改日志前缀为 `[convo-graph]`。其余：

```js
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { createStore } from './store.js'
import { createApi, json } from './api.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const DATA_DIR = path.join(DSH_HOME, 'dsh-graph')
const SESSIONS_DIR = path.join(DSH_HOME, 'sessions')
const DEBOUNCE_MS = 3000

export default {
  name: 'dsh-convo-graph',
  inject: ['webServer', 'connection'],
  apply(ctx) {
    // …（此处插入照抄的 isLoopbackReq / isTrustedReq / rejected 三函数，ctx 闭包可用）…

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
          if (fs.existsSync(f)) files.set(s, f)
        }
      }
      store.cleanOrphans(new Set(files.keys()))
    }
    scan()

    // worker + 请求桥（串行队列，避免大会话并发吃满 CPU）
    const worker = new Worker(new URL('./indexer.js', import.meta.url), {
      env: { ...process.env, DSH_GRAPH_WORKER: '1' }
    })
    const pending = new Map() // key → resolve
    const queue = []
    let busy = false
    let indexing = null
    worker.on('message', (msg) => {
      const key = msg.type === 'message' ? msg.id + ':' + msg.seq : msg.id
      const r = pending.get(key)
      pending.delete(key)
      if (msg.type === 'indexed') { store.writeIndex(msg.index); r?.(msg.index) }
      else if (msg.type === 'message') r?.(msg.result)
      else r?.(null)
      busy = false
      indexing = null
      pump()
    })
    worker.on('error', (e) => { console.warn('[convo-graph] worker 错误: ' + e.message); busy = false; pump() })
    function pump() {
      if (busy || !queue.length) return
      const job = queue.shift()
      busy = true
      indexing = job.id
      worker.postMessage(job.msg)
    }
    function enqueue(msg, key) {
      return new Promise((resolve) => { pending.set(key, resolve); queue.push({ id: msg.id, msg }); pump() })
    }
    const bridge = {
      requestIndex(id) {
        const file = files.get(id)
        if (!file) return
        const { df, totalSessions } = store.computeDf()
        enqueue({ type: 'index-one', id, file, df, totalSessions, config: store.readConfig() }, id)
      },
      readMessage(id, seq) {
        const file = files.get(id)
        if (!file) return Promise.resolve(null)
        return enqueue({ type: 'read-message', id, file, seq }, id + ':' + seq)
      },
      status() { return { queue: queue.length, indexing } }
    }
    // 启动：已有索引的会话校验 mtime 决定是否重算；全部排队后台建
    for (const [id, file] of files) {
      const old = store.readIndex(id)
      const st = fs.statSync(file)
      if (!old || old.sourceMtime !== st.mtimeMs || old.sourceSize !== st.size) bridge.requestIndex(id)
    }

    // 增量：监听 sessions 目录，防抖后重扫+重算变化者
    let timer = null
    let watcher = null
    try {
      watcher = fs.watch(SESSIONS_DIR, { recursive: true }, () => {
        clearTimeout(timer)
        timer = setTimeout(() => {
          const before = new Map(files)
          scan()
          for (const [id, file] of files) {
            const st = fs.statSync(file)
            const old = store.readIndex(id)
            if (!before.has(id) || !old || old.sourceMtime !== st.mtimeMs || old.sourceSize !== st.size) bridge.requestIndex(id)
          }
        }, DEBOUNCE_MS)
      })
    } catch (e) { console.warn('[convo-graph] 文件监听不可用: ' + e.message) }

    const handle = createApi({ store, bridge, findFile: (id) => files.get(id) ?? null })
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
    route('exact', '/dsh-graph/api', (req, res) => handle(req, res, new URL(req.url, 'http://localhost')))
    for (const name of ['force-graph.min.js', 'd3-force.min.js']) {
      route('exact', '/dsh-graph/vendor/' + name, (req, res) => {
        res.statusCode = 200
        res.setHeader('content-type', 'application/javascript; charset=utf-8')
        res.end(fs.readFileSync(path.join(HERE, 'vendor', name)))
      })
    }

    ctx.effect(() => () => {
      clearTimeout(timer)
      try { watcher?.close() } catch {}
      try { worker.terminate() } catch {}
      for (const d of disposers) { try { d() } catch {} }
    })
    console.log('[convo-graph] 已挂载：/dsh-graph/api · 数据目录 ' + DATA_DIR)
  }
}
```

- [ ] **Step 4: 语法检查**：`node --check lib/index.js && node --check lib/indexer.js && node --check lib/api.js` → 无输出=通过
- [ ] **Step 5: 全量测试**：`npm test` → 全 pass
- [ ] **Step 6: Commit**：`git add lib/index.js cordis.patch.yml lib/vendor && git commit -m "feat: 宿主接线（信任栅栏/worker队列/文件监听/vendor路由）"`

---

### Task 8: 客户端图谱标签 client.js + 装进 DSH 实测

**Files:**
- Create: `lib/client.js`

**Interfaces:**
- Consumes: Task 7 的 API 与 vendor 路由；DSH 插槽 `conversation.view`（注册形状照 `dsh-client-ui-trajectory/lib/client.js:8205`：`{name, id, order, label, inject:(sessionId)=>props}`）
- Produces: 顶栏「图谱」标签；组件 props 含 `sessionId`（inject 返回）与框架给的 `openView` 等

- [ ] **Step 1: 写** `lib/client.js`

骨架照养鱼插件 `lib/client.js` 的 `window.__ModuleLoader__.load({id, factory})` + `exports.apply/inject=['slots']`。核心代码：

```js
window.__ModuleLoader__.load({
  id: 'dsh-convo-graph',
  factory: (require) => {
    const module = { exports: {} }; const exports = module.exports
    const React = require('react')
    const { createElement: h, useEffect, useRef, useState, useCallback } = React
    const API = '/dsh-graph/api'
    const VENDOR = ['/dsh-graph/vendor/d3-force.min.js', '/dsh-graph/vendor/force-graph.min.js']
    let vendorPromise = null
    function loadVendor() {
      if (!vendorPromise) vendorPromise = VENDOR.reduce((p, src) => p.then(() => new Promise((ok, err) => {
        const s = document.createElement('script')
        s.src = src; s.onload = ok; s.onerror = () => err(new Error('加载失败 ' + src))
        document.head.appendChild(s)
      })), Promise.resolve())
      return vendorPromise
    }
    const radius = (n) => n.kind === 'session' ? 9 : 4 + Math.sqrt(n.val) * 2
    const isDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches
    const accent = (cfg) => cfg?.accent || (isDark() ? '#5b8cff' : '#2563eb')

    function GraphView({ sessionId }) {
      const boxRef = useRef(null)
      const fgRef = useRef(null)
      const posRef = useRef(new Map())   // 旧节点坐标，增量更新不跳位
      const bornRef = useRef(new Map())  // 新节点生长动画起点
      const sigRef = useRef('')          // 图谱签名：没变化就不重建实例
      const [data, setData] = useState(null)
      const [cfg, setCfg] = useState(null)
      const [sel, setSel] = useState(null)      // 选中的 topic node
      const [full, setFull] = useState(null)    // 消息全文面板
      const [related, setRelated] = useState([])
      const [err, setErr] = useState(null)
      const hoverRef = useRef(null)

      const refresh = useCallback(async () => {
        try {
          const [s, r, c] = await Promise.all([
            fetch(API + '?op=session&id=' + encodeURIComponent(sessionId)).then(x => x.json()),
            fetch(API + '?op=related&id=' + encodeURIComponent(sessionId)).then(x => x.json()),
            fetch(API + '?op=config').then(x => x.json())
          ])
          setCfg(c.config); setRelated(r.related ?? []); setErr(null)
          if (s.status === 'ready') {
            const sig = JSON.stringify(s.graph.nodes.map(n => [n.id, n.val])) + '|' + s.graph.links.length + '|' + (s.messages ?? []).length
            if (sig === sigRef.current) return
            sigRef.current = sig
            for (const n of s.graph.nodes) {
              const old = posRef.current.get(n.id)
              if (old) Object.assign(n, { x: old.x, y: old.y, vx: old.vx, vy: old.vy })
              else if (!bornRef.current.has(n.id)) bornRef.current.set(n.id, Date.now())
            }
            setData(s)
          } else setData(prev => prev ?? { status: s.status })
          setErr(null)
        } catch (e) { setErr(String(e.message ?? e)) }
      }, [sessionId])

      useEffect(() => { refresh(); const t = setInterval(refresh, 4000); return () => clearInterval(t) }, [refresh])

      useEffect(() => {
        if (!data?.graph || !boxRef.current) return
        let dead = false
        loadVendor().then(() => {
          if (dead || !boxRef.current) return
          const FG = window.ForceGraph()
          fgRef.current = FG
          FG(boxRef.current)
            .width(boxRef.current.clientWidth).height(boxRef.current.clientHeight)
            .backgroundColor('rgba(0,0,0,0)')
            .nodeId('id').nodeVal(n => radius(n) ** 2)
            .nodeLabel(n => n.label)
            .linkColor(l => l.kind === 'member' ? 'rgba(127,127,127,.35)' : 'rgba(127,127,127,.5)')
            .linkWidth(l => Math.min(3, 0.5 + l.weight * 0.15))
            .nodeCanvasObject((n, ctx2, scale) => {
              const r = radius(n)
              const born = bornRef.current.get(n.id) ?? 0
              const grow = Math.min(1, (Date.now() - born) / 400)
              const hov = hoverRef.current
              const dim = hov && n.id !== hov.id && !(hov.neighbors ?? []).includes(n.id)
              ctx2.globalAlpha = dim ? 0.15 : grow
              const hot = sel?.id === n.id || hov?.id === n.id
              ctx2.fillStyle = n.kind === 'session' ? (isDark() ? '#9aa4b2' : '#556070') : hot ? accent(cfg) : (isDark() ? '#7d8aa0' : '#8b96a8')
              ctx2.beginPath(); ctx2.arc(n.x, n.y, r * grow, 0, 2 * Math.PI); ctx2.fill()
              if (scale > 0.6) {
                ctx2.fillStyle = isDark() ? '#e6e8eb' : '#2a2f36'
                ctx2.font = `${Math.max(3, 11 / scale)}px sans-serif`
                ctx2.textAlign = 'center'
                ctx2.fillText(n.label, n.x, n.y + r + 12 / scale)
              }
              ctx2.globalAlpha = 1
            })
            .onNodeHover(n => {
              hoverRef.current = n ? { id: n.id, neighbors: (data.graph.links ?? []).filter(l => l.source.id === n.id || l.target.id === n.id || l.source === n.id || l.target === n.id).map(l => (l.source.id ?? l.source) === n.id ? (l.target.id ?? l.target) : (l.source.id ?? l.source)) } : null
              boxRef.current.style.cursor = n ? 'pointer' : 'default'
            })
            .onNodeClick(n => {
              if (n.kind === 'topic') { setSel(n); setFull(null) }
              else { FG.centerAt(n.x, n.y, 800); FG.zoom(2.2, 800) }
            })
            .onEngineTick(() => { for (const n of data.graph.nodes) posRef.current.set(n.id, { x: n.x, y: n.y, vx: n.vx, vy: n.vy }) })
          FG.d3Force('collide', window.d3.forceCollide(n => radius(n) + 6))
          FG.d3Force('charge').strength(-120)
          FG.graphData(data.graph)
          const ro = new ResizeObserver(() => FG.width(boxRef.current.clientWidth).height(boxRef.current.clientHeight))
          ro.observe(boxRef.current)
          fgRef.current.__ro = ro
        }).catch(e => setErr(String(e.message ?? e)))
        return () => { dead = true; try { fgRef.current?.__ro?.disconnect(); fgRef.current?._destructor() } catch {} }
      }, [data?.graph, sessionId])   // graph 对象每次 refresh 新建 → 重建实例但坐标已保留

      const openMsg = async (s, seq) => {
        const r = await fetch(API + '?op=message&id=' + encodeURIComponent(s) + '&seq=' + seq).then(x => x.json())
        setFull(r.result)
      }
      const link = async (other) => {
        await fetch(API + '?op=link', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ a: sessionId, b: other }) })
        refresh()
      }

      const panelMsgs = sel ? (data?.messages ?? []).filter(m => (sel.msgs ?? []).some(x => x.s === sessionId && x.seq === m.seq)) : []
      return h('div', { style: { display: 'flex', height: '100%', color: 'var(--dsw-alias-label-primary)' } },
        h('div', { ref: boxRef, style: { flex: 1, minWidth: 0, position: 'relative' } },
          data?.status === 'indexing' ? h('div', { style: { position: 'absolute', top: 8, left: 8, fontSize: 12, opacity: .7 } }, '索引中…') : null),
        h('div', { style: { width: 320, overflow: 'auto', borderLeft: '.5px solid var(--dsw-alias-border-l2)', padding: 12 } },
          err ? h('div', { style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 12 } }, err) : null,
          sel ? h('div', null,
            h('h3', { style: { margin: '0 0 8px', fontSize: 14 } }, '主题：' + sel.label),
            panelMsgs.map(m => h('div', { key: m.seq, onClick: () => openMsg(sessionId, m.seq), style: { padding: '6px 0', borderBottom: '.5px solid var(--dsw-alias-border-l2)', cursor: 'pointer', fontSize: 12 } },
              h('b', null, m.role === 'user' ? '我' : 'AI'), ' · ', m.snippet))) : null,
          full ? h('div', { style: { marginTop: 10, fontSize: 12, whiteSpace: 'pre-wrap' } },
            full.prev ? h('div', { style: { opacity: .6 } }, '上一条：' + full.prev.text.slice(0, 120)) : null,
            h('div', { style: { margin: '8px 0', padding: 8, background: 'rgba(127,127,127,.08)', borderRadius: 8 } }, full.message.text),
            full.next ? h('div', { style: { opacity: .6 } }, '下一条：' + full.next.text.slice(0, 120)) : null) : null,
          h('h3', { style: { margin: '14px 0 6px', fontSize: 13 } }, '相关会话'),
          related.map(r => h('div', { key: r.sessionId, style: { display: 'flex', justifyContent: 'space-between', gap: 8, padding: '5px 0', fontSize: 12 } },
            h('span', null, r.title, h('span', { style: { opacity: .6 } }, '（' + r.shared.join('、') + '）')),
            h('button', { onClick: () => link(r.sessionId), style: { cursor: 'pointer' } }, '关联')))))
    }

    function apply(ctx) {
      ctx.effect(() => ctx.slots.inject('conversation.view', () =>
        ctx.slots.register({
          name: 'conversation.view', id: 'graph', order: 20,
          label: () => '图谱',
          inject: (sessionId) => ({ sessionId })
        }, GraphView), 'convo-graph: view'), 'convo-graph: view')
    }
    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  }
})
```

- [ ] **Step 2: 语法检查**：`node --check lib/client.js`（浏览器 API 不影响语法检查）
- [ ] **Step 3: 装进 DSH**：`dsh plugin --profile desktop add "link:<仓库绝对路径>"`（若 dsh CLI 不在 PATH，用 DSH 安装目录下的 `plugin-tool.js` 或 DSH 设置→插件→本地安装）
- [ ] **Step 4: 重启 DSH，打开任意较长会话 → 顶栏应出现「图谱」标签**
- [ ] **Step 5: 验收清单（用户操作 + 截图取证，可用 rea capture_native_ui_scenario 截 DSH 窗口）**
  1. 图谱出图、节点不重叠（碰撞生效）、拖拽回弹
  2. 悬停高亮邻居、其余淡化；选中节点鲸鱼蓝
  3. 点主题 → 右侧消息列表 → 点消息 → 全文+前后邻居正确
  4. 相关会话列表出现 → 点关联 → 共享主题连通两会话
  5. 切到对话页发一条新消息 → 回图谱页几秒内新节点生长出现
  6. 明暗主题切换配色跟随
- [ ] **Step 6: 修问题循环**：任何一条不过 → 定位修复 → 重跑该条（DSH 插件改动后需重启或重载插件）
- [ ] **Step 7: Commit**：`git commit -am "feat: 图谱标签页（力导向/碰撞/高亮/定位/关联/增量生长）"`

---

### Task 9: README + LICENSE + 发布准备

**Files:**
- Create: `README.md`, `LICENSE`
- Modify: `docs/`（验收截图存 `docs/screenshot.png` 供 README 引用）

**Interfaces:**
- Consumes: Task 8 验收截图与安装命令实测结果

- [ ] **Step 1: 写 README.md**（中文：一句话介绍、效果截图、安装命令 link/发布两种、使用五步、配置项表 extraStopwords/topN/accent、隐私声明"数据仅本机 ~/.dsh/dsh-graph/，不上传"、开发 `npm test`）
- [ ] **Step 2: 写 LICENSE**（MIT，Copyright (c) 2026 Nico）
- [ ] **Step 3: 全量测试+语法检查**：`npm test && node --check lib/index.js && node --check lib/client.js`
- [ ] **Step 4: 仓库内容给用户过目**：列 `git ls-files` 清单 + README 全文给用户确认（**确认不含真实对话数据**：fixtures 全编造）
- [ ] **Step 5: 用户明确同意后**才 `git remote add origin <用户给的仓库地址> && git push -u origin main`（用户未给地址/未同意则停在此步）
- [ ] **Step 6: Commit**：`git commit -am "docs: README/LICENSE 与发布准备"`

---

## 自审记录

- Spec 覆盖：§3 形态/交互/视觉→Task 5/8；§4 架构/增量→Task 7；§5 索引格式→Task 3/4；§6 算法→Task 2；§7 API→Task 6（路径改为 ?op= 分发，功能等价，原因见 Global Constraints）；§8 错误处理→Task 4 坏 zstd 测试/Task 7 fail-closed/Task 3 孤儿清理/Task 8 indexing 徽标；§9 测试验收→各 Task 测试 + Task 8 清单（首测长会话）；§10 发布→Task 9；§11 风险兜底→Task 8 面板全文为必做路径、fzstd 不依赖 node 版本
- 偏差说明：① 其他会话也建完整索引（仅摘要不存全文），后台串行队列满足"不阻塞当前会话"意图，keywords-only 优化推迟；② 消息定位不做跳回对话页（openView 只能切页不能滚动），直接采用 spec 兜底面板全文
- 类型一致性：messages `{seq,role,time,turn,text/snippet}`、keywords `{word,score,count,msgs}`、edges `{a,b,weight}`、graph node `{id,kind,label,val,msgs:[{s,seq}]}`、worker 协议 key 规则（index 用 id，message 用 id:seq）在各 Task 间一致