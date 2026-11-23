# dsh-convo-graph 设计文档

> DSH 插件：会话顶栏「图谱」标签页。把当前会话归纳成主题点线图，点主题定位到具体对话消息；
> 其他会话默认不进图，用户手动「关联」后才并入。纯本地、零 token 成本、零原生依赖。
> 日期：2026-11-23 ｜ 状态：待用户审阅

## 1. 背景与目标

用户想像 Obsidian 关系图谱那样回顾与 AI 的历史对话：不是翻流水账，而是看图定位内容。
重心是**当前会话内部**的信息定位（"这个会话里关于物理的讨论在哪几条消息"），
跨会话关联是可选扩展，由用户主动触发。

目标：
- 在 DSH 会话顶栏（对话 / 轨迹 / 上下文 那一排）新增「图谱」标签
- 当前会话内容自动归纳为主题节点，随对话进行增量生长
- 点主题 → 列出相关消息 → 点消息 → 看到该消息全文及上下文
- 推荐相关会话，用户点「关联」后其主题子图并入，共享主题成为连接线
- 视觉丝滑：节点碰撞体积、悬停高亮、平滑缩放、生长动画，Obsidian 手感
- 发布到 GitHub，别人 `dsh plugin add` 装上即用

非目标（明确不做）：
- 不接 LLM 做摘要/主题（纯本地统计；会话标题直接用 DSH 已有的 `session/title` 记录）
- 不做词云视图（双层图已覆盖定位需求）
- 不做全文搜索引擎、不做 SQLite（当前 40 个会话规模用 JSON 索引足够）
- 不复制对话原文进索引库（原文唯一来源是 DSH 会话文件）
- 不上传任何数据到网络

## 2. 已验证的事实（调查结论）

| 事实 | 证据 |
|---|---|
| DSH 会话存于 `~/.dsh/sessions/<工作区编码>/session-*/session.v4.jsonl.zstd` | 实测 40 个会话，最大 12MB 压缩 |
| zstd 解压后是 JSONL，含 `user/message`、`assistant/message`、`session/title`、`turn/start` 等类型 | 实测最大会话：245 条用户消息、1655 条助手消息、129 轮 |
| 顶栏标签的插槽是 `conversation.view`，注册时 `inject: (sessionId) => …` 能拿到当前会话 ID | `dsh-client-ui-trajectory/lib/client.js:8205` 轨迹标签就是这么注册的 |
| 客户端模块用 `window.__ModuleLoader__.load({id, factory})` + `ctx.slots.register/inject` | 养鱼插件 `dsh-bili-whale/lib/client.js` |
| 宿主插件骨架：npm 包 `dsh` 字段 + `cordis.patch.yml` 挂载 + HTTP 路由过信任栅栏 | 养鱼插件 `lib/index.js`（`connection.requestRejection`） |
| 本机 DSH 桌面版在 `E:\DSHdesktop\`，运行时 node 24.21.0 | 快捷方式解析 + `dsh-runtimes/runtime.json` |

## 3. 产品形态与交互

```
┌────────────────────────────────────────────────────────────┐
│  对话   轨迹   上下文   [图谱]   ← conversation.view 插槽新标签 │
├──────────────────────────────────────────┬─────────────────┤
│                                          │  右侧面板        │
│         力导向图（Canvas）                │                 │
│                                          │ ① 主题详情：     │
│      "物理"●────●"情人节"                │   相关消息列表   │
│         │      ╲    │                    │   （带摘要）     │
│      "lrose"●    ●会话节点               │   点消息→全文    │
│                                          │                 │
│                                          │ ② 相关会话：     │
│                                          │   共享主题+分数  │
│                                          │   [关联] 按钮    │
└──────────────────────────────────────────┴─────────────────┘
```

节点与线：
- **主题节点**：当前会话提取的关键词，大小 ∝ 词频分数
- **会话节点**：当前会话一个；每关联一个其他会话多一个（名字用 DSH 的会话标题）
- **线**：同一轮对话里共现的主题之间连线；主题连到所属会话节点；
  关联会话后，两边共享的主题节点合并为同一个点，天然形成跨会话连接线

交互：
- 点主题节点 → 右侧列出该词出现的消息（角色+时间+前 80 字摘要）
- 点消息 → 优先尝试跳回「对话」标签并滚动定位（实施时调查 `ctx.uiConversation` 是否暴露跳转 API）；
  **兜底（必做）**：右侧面板直接展示该消息全文 + 前后各一条上下文，原文现读 DSH 源文件
- 点会话节点 → 图谱聚焦该会话子图
- 相关会话列表按共享主题数排序，点「关联」→ 该会话主题子图并入；关联关系持久化，可取消
- 当前会话进行中：文件变化 → 索引更新 → 图谱几秒内自动长出新节点，无需手动刷新

视觉规格（用户明确要求"丝滑、有碰撞体积"）：
- force-graph（Canvas 渲染）+ d3-force：`forceCollide(节点半径+间距)` → 节点永不重叠，拖拽有物理回弹
- 悬停：该节点+邻居+连线高亮，其余淡化（Obsidian 同款）
- **选中高亮 = DSH 鲸鱼蓝**（用户指定，不用 Obsidian 紫）：默认 `#2563eb`，
  暗主题自动提亮为 `#5b8cff`；不依赖 DSH 品牌 token（实测当前版本 brand-primary 是中性黑白），
  config.json 的 `accent` 可改色
- 点击：相机平滑缩放过渡到目标节点（zoom-to-fit 动画）
- 新节点：缩放+透明度生长动画进入；索引更新用增量数据合并，不整图重排乱跳
- 配色读 DSH CSS 变量（`--dsw-alias-*`），明暗主题自动跟随
- 节点数上限保护：单会话主题 ≤ 30，关联会话 ≤ 10 个，超出提示精简

## 4. 架构与数据流

```
~/.dsh/sessions/**/session.v4.jsonl.zstd
        │ fs.watch + 3 秒防抖
        ▼
┌─ 插件宿主进程（lib/index.js，cordis 插件壳）──────────────┐
│  HTTP API（全部过 DSH 信任栅栏，仅回环）                  │
│  worker_threads 索引线程（lib/indexer.js）               │
│    fzstd 解压 → 白名单类型过滤 → 消息/轮次提取            │
│    → Intl.Segmenter 分词 → 停用词过滤 → TF-IDF 打分       │
│    → 写索引 JSON                                         │
└──────────────────────────────────────────────────────────┘
        │ ~/.dsh/dsh-graph/
        │   index/<sessionId>.json   每会话索引
        │   links.json               手动关联关系
        │   config.json              停用词追加、topN 等设置
        ▼
┌─ 客户端（lib/client.js）─────────────────────────────────┐
│  conversation.view 注册「图谱」（id: graph, order: 20）   │
│  force-graph 渲染；同源 fetch API；轮询 status 感知更新   │
└──────────────────────────────────────────────────────────┘
```

索引策略：
- **当前会话精细索引**：关键词 → 消息 seq 列表、共现边、消息摘要
- **其他会话轻量索引**：只算关键词+分数（供相关推荐），后台逐个建，不阻塞当前会话
- 首次安装：启动时扫描全部会话排队建索引；12MB 级会话单个几秒~十几秒（worker 内）
- 增量：文件 mtime/size 变化 → 防抖后整文件重解析（当前规模下 1-2 秒级，简单可靠；
  不做帧级增量解压，规模上千会话再优化）
- 索引带 `sourceMtime/sourceSize/formatVersion`，源文件没变不重算

## 5. 索引库格式（JSON，非原文副本）

`index/<sessionId>.json`：
```json
{
  "formatVersion": 1,
  "sessionId": "session-…",
  "workspace": "E:\\Qoderwork\\sgds-game",
  "title": "美卡画质Mod安装与清理",
  "createdAt": 1791207848591,
  "updatedAt": 1792825246797,
  "sourceMtime": 1792825246800,
  "sourceSize": 11925784,
  "messages": [
    {"seq": 8, "role": "user", "time": 1791207848591, "turn": 1, "snippet": "帮我把lrose的情人节物理…"}
  ],
  "keywords": [
    {"word": "物理", "score": 0.82, "count": 40, "msgs": [3, 17, 42]}
  ],
  "edges": [{"a": "物理", "b": "lrose", "weight": 12}]
}
```
- `snippet` 截取消息文本前 80 字；**全文不存**，点消息时按 seq 现读源文件
- `links.json`：`[{"a": "<sessionId>", "b": "<sessionId>", "at": 1792825246797}]`
- `config.json`：`{"extraStopwords": [], "topN": 25, "accent": "#2563eb"}`

## 6. 关键词算法（纯本地）

1. 只取 `user/message` 与 `assistant/message` 的文本块（工具调用/系统日志不参与）
2. `Intl.Segmenter('zh', {granularity:'word'})` 切词，取 `isWordLike`
3. 过滤：停用词表（内置常见虚词+代码杂词）、长度<2 的中文词、纯数字/纯符号
4. TF-IDF：TF=本会话词频；IDF=log(总会话数/含该词会话数)——本会话常见且别处罕见者分高
5. 取 topN（默认 25，上限 30）为主题节点；同轮共现计边权
6. 相关推荐：两会话关键词交集大小加权排序

## 7. HTTP API（前缀 /dsh-graph/api，全部过信任栅栏）

| 路由 | 作用 |
|---|---|
| GET `/session/:id` | 图谱数据：节点+边+消息摘要列表+索引状态 |
| GET `/related/:id` | 相关会话推荐（标题、共享词、分数） |
| POST `/link` / DELETE `/link` | 保存/取消关联 `{a, b}` |
| GET `/message/:sessionId/:seq` | 按 seq 现读源文件，返回消息全文+前后各一条 |
| GET `/status` | 索引进度（队列长度、当前会话是否就绪） |

## 8. 错误处理

| 场景 | 对策 |
|---|---|
| 读到写一半的 zstd | 解压失败保留旧索引，防抖后重试，不崩不报错弹窗 |
| 大会话索引慢 | worker 线程跑；页面显示"索引中"+旧数据，不白屏 |
| 会话被删/归档 | 启动时清理孤儿索引；页面提示"会话已不存在" |
| 废词刷屏 | 停用词+词长+TF-IDF 阈值；config.json 可追加停用词 |
| 回环 API 被外部网页偷打 | 所有路由过 `connection.requestRejection` 信任栅栏 |
| DSH 会话格式升级 v4→v5 | 类型白名单跳过未知记录；formatVersion 不匹配提示重建索引 |
| 跳转定位 API 不存在 | 兜底右侧面板全文展示（必做路径，不依赖跳转 API） |

## 9. 测试与验收

- 单元（`node --test`，照养鱼插件模式）：fixtures 为编造的中文会话 JSONL
  （含工具调用、compaction、多轮）→ 验证解压、消息提取、分词过滤、TF-IDF 排序、
  关键词→seq 映射、共现边、相关推荐排序、link 读写
- 手动验收（装进用户 DSH 实测，浏览器自动化截图给用户看；**用户指定首测场景：美卡（ATS）会话
  「美卡画质Mod安装与清理」，116 轮长对话**）：
  1. 打开 116 轮长会话的图谱标签 → 图出来、点不重叠
  2. 点主题 → 消息列表 → 点消息 → 全文正确
  3. 关联另一个会话 → 共享主题连通
  4. 边聊边看 → 新节点生长动画出现
  5. 明暗主题切换配色跟随

## 10. 发布结构

```
dsh-convo-graph/
 ├─ package.json        dsh 字段 + bundle patch 声明
 ├─ cordis.patch.yml    挂载声明（name 必须等于包名）
 ├─ lib/
 │   ├─ index.js        宿主壳：API + worker 管理 + 文件监听
 │   ├─ indexer.js      worker：解压/分词/TF-IDF/写索引
 │   ├─ client.js       图谱标签页（conversation.view）
 │   └─ vendor/         force-graph、fzstd 预打包静态文件
 ├─ tests/              单元测试 + fixtures（编造数据）
 ├─ README.md           中文：效果图、安装、使用
 └─ LICENSE             MIT
```
- 仓库不含任何真实对话数据
- 安装：`dsh plugin --profile desktop add dsh-convo-graph`（发布后）/ `link:<本地路径>`（开发期）
- 推 GitHub 前先给用户过目仓库内容

## 11. 风险

- `conversation.view` 插槽与 `ctx.sessions/uiConversation` API 是 DSH 内部接口，
  版本升级可能变动 → 客户端注册失败时降级：设置页里放一个"打开图谱"链接跳独立页
- Electron 宿主 node 版本未知 → 不依赖 node 24 的内置 zstd，统一用 fzstd 纯 JS 解压
- 消息跳转 API 未验证 → 兜底面板全文展示已列为必做