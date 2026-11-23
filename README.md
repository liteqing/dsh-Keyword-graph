# dsh-convo-graph

DSH（DeepSeek Harness 桌面版）插件：在会话顶栏增加「图谱」标签，把当前会话变成中文分词 + TF-IDF 主题点线图，点击主题定位消息原文，并可手动关联相关会话形成跨会话图谱。

## 效果

- 当前会话的主题图谱：力导向布局，节点带碰撞体积、互不重叠，可拖拽。
- 悬停节点高亮邻居、淡化其余；点击主题节点变为鲸鱼蓝（浅色 `#2563eb` / 暗色 `#5b8cff`，可配置），右侧列出该主题的消息。
- 点击消息显示全文与前后邻居摘要（全文按需从 DSH 会话文件读取）。
- 右侧「相关会话」按共享主题推荐其他会话，点「关联」并入图谱（每个会话关联上限 10 条）。
- 每 4 秒增量刷新：新消息产生的新主题节点带生长动画出现，旧节点不跳位。
- 明暗主题自动跟随系统 / DSH 配色。

## 安装

要求：DSH 桌面版。开发 / 测试需 Node 22.15+（测试用 `zlib.zstdCompressSync`）；运行插件所用 Node 由 DSH 内置决定。

### 方式一：本地 link（当前推荐）

以 Windows 为例，`<仓库路径>` 为本仓库的绝对路径：

1. 建立插件目录 junction：

   ```bat
   cmd /c mklink /J "%USERPROFILE%\.dsh\plugins\dsh-convo-graph" "<仓库路径>"
   ```

2. 编辑 `%USERPROFILE%\.dsh\profiles\desktop\package.json`：
   - `dependencies` 中加入 `"dsh-convo-graph": "link:C:/Users/<用户名>/.dsh/plugins/dsh-convo-graph"`（正斜杠路径）；
   - `dsh.profile.bundles` 数组末尾加入 `"dsh-convo-graph"`。

3. 建立 profile 内的 node_modules junction：

   ```bat
   cmd /c mklink /J "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-convo-graph" "%USERPROFILE%\.dsh\plugins\dsh-convo-graph"
   ```

4. 完全退出 DSH（含托盘）后重新启动生效。启动日志出现 `[convo-graph] 已挂载：/dsh-graph/api …` 即安装成功。

回滚：`rmdir` 删除上述两个 junction（不会动源文件），并还原 package.json 的两处修改。

### 方式二：npm 发布安装（计划中）

尚未发布到 npm。发布后计划支持通过 DSH 插件机制直接安装 `dsh-convo-graph`，无需手工 link。

## 使用

1. 打开任意会话，点顶栏「图谱」标签。首次进入显示「索引中…」，后台建索引完成后自动出图。
2. 悬停查看主题关联；点击主题节点，右侧出现该主题的消息列表。
3. 点击一条消息，查看全文与上一条 / 下一条摘要。
4. 在右侧「相关会话」中点「关联」，把共享主题的其他会话并入图谱（上限 10 条，超出会提示）。
5. 回到对话页发新消息后再看图谱，几秒内新主题节点生长出现；切换明暗主题配色自动跟随。

## 配置

配置文件：`~/.dsh/dsh-graph/config.json`（不存在时使用默认值，可直接创建 / 编辑）。

| 键 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `extraStopwords` | `string[]` | `[]` | 额外停用词，命中的词不进主题图谱 |
| `topN` | `number` | `25` | 每个会话保留的主题词数，通过 API 修改时自动收敛到 1–30；手工编辑请保持在此范围 |
| `accent` | `string` | `"#2563eb"` | 选中 / 高亮强调色（暗色主题默认 `#5b8cff`） |

示例：

```json
{ "extraStopwords": ["好的"], "topN": 20, "accent": "#2563eb" }
```

## 隐私

- 所有数据仅存本机 `~/.dsh/dsh-graph/`（索引、关联、配置），不上传任何内容。
- 索引只保存关键词、每条消息 80 字摘要及标题/时间/轮次等元数据；消息全文在点击时按需从 DSH 本地会话文件读取，不落盘到索引。
- HTTP 路由 `/dsh-graph/api` 沿用 DSH 信任栅栏：仅回环 / DSH 信任来源可访问；信任服务不可用时拒绝访问（fail-closed）。

## 开发

```bash
npm test          # node --test，56 项测试
```

零原生依赖：zstd 解压用纯 JS 的 fzstd；前端力导向图库（d3-force / force-graph 及其 d3 依赖）以 UMD 形式随包内置于 `lib/vendor/`，无需外网 CDN。

## 许可

[MIT](./LICENSE)
