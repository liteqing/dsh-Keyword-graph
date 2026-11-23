import fs from 'node:fs'

// 会话文件解压+解析很贵（9MB 包解压后 28MB），而面板每点一个主题、每展开一条全文
// 都会再读一次。按 mtime+size 缓存提取后的消息（仅内存），文件追加新消息时自动失效。
export function createSessionCache({ max = 4, load }) {
  const map = new Map() // file → { mtimeMs, size, value }
  return {
    get(file) {
      const stat = fs.statSync(file)
      const hit = map.get(file)
      if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
        map.delete(file); map.set(file, hit) // LRU：命中即移到队尾
        return hit.value
      }
      const value = load(file) // 抛错时不写缓存，下次请求会重试
      map.delete(file)
      map.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, value })
      if (map.size > max) map.delete(map.keys().next().value)
      return value
    },
    clear() { map.clear() }
  }
}