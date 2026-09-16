/**
 * 名词表 s0：基于规则的名词抽取 + 偏移量定位
 * 职责：从纯文表抽取名词，记录每个名词在纯文表中的出现位置（偏移量）
 */

import type { PureTextTable } from './pureTextTable.ts'
import { extractNounSurfacesFromText, normalizeNounSurface } from './bookNounIndex.ts'

export type NounS0Entry = {
  /** 标准化的名词ID（用于去重） */
  id: string
  /** 展示形式（首次见到的形式，或最长形式） */
  surface: string
  /** 出现次数 */
  df: number
  /** 全局偏移量列表（在纯文表中的位置） */
  offsets: Array<{ start: number; end: number }>
}

export type NounS0Table = {
  entries: NounS0Entry[]
  byId: Map<string, NounS0Entry>
  note: string
}

/**
 * 从纯文表构建 s0（规则名词表 + 偏移）
 * 策略：遍历全文，抽取名词，记录每次出现的精确偏移
 * 优化：不使用 taken 数组（内存密集），改用偏移去重
 */
export function buildNounS0Table(pureTextTable: PureTextTable): NounS0Table {
  const map = new Map<string, NounS0Entry>()
  const fullText = pureTextTable.fullText
  const fullTextLower = fullText.toLowerCase()

  // 先抽取所有候选名词
  const surfaces = extractNounSurfacesFromText(fullText)
  
  // 按 id 分组所有表面形式
  const candidates = new Map<string, Set<string>>()
  for (const surface of surfaces) {
    const id = normalizeNounSurface(surface)
    if (id.length < 2) continue
    if (!candidates.has(id)) {
      candidates.set(id, new Set())
    }
    candidates.get(id)!.add(surface)
  }

  // 定位每个名词的所有出现位置
  for (const [id, surfaceSet] of candidates) {
    const allSurfaces = [...surfaceSet]
    // 按长度降序，优先匹配长词
    allSurfaces.sort((a, b) => b.length - a.length)

    const offsetsMap = new Map<string, { start: number; end: number }>()

    for (const surface of allSurfaces) {
      const needle = surface.toLowerCase()
      let from = 0
      while (from < fullTextLower.length) {
        const at = fullTextLower.indexOf(needle, from)
        if (at < 0) break

        const end = at + needle.length
        const key = `${at}-${end}`
        
        // 检查是否与已有偏移重叠
        let overlap = false
        for (const [existKey, exist] of offsetsMap) {
          if (
            (at >= exist.start && at < exist.end) ||
            (end > exist.start && end <= exist.end) ||
            (at <= exist.start && end >= exist.end)
          ) {
            overlap = true
            break
          }
        }

        if (!overlap) {
          offsetsMap.set(key, { start: at, end })
        }

        from = at + 1
      }
    }

    if (offsetsMap.size === 0) continue

    const offsets = [...offsetsMap.values()]
    // 按偏移排序
    offsets.sort((a, b) => a.start - b.start)

    // 选择最长的表面形式
    const bestSurface = allSurfaces[0]!

    map.set(id, {
      id,
      surface: bestSurface,
      df: offsets.length,
      offsets,
    })
  }

  // 过滤：df >= 2 或 首字母大写且长度 >= 3 或 CJK 2-4字
  const filtered = [...map.values()].filter((e) => {
    if (e.df >= 2) return true
    if (/^[A-ZÀ-Ý]/.test(e.surface) && /[a-zA-ZÀ-ÿ]{3,}/.test(e.surface)) {
      return true
    }
    if (/^[\u4e00-\u9fff]{2,4}$/.test(e.surface) && e.df >= 1) return true
    return false
  })

  // CJK 子串剪枝：如果一个短词完全包含在一个更高频的长词中，剪掉短词
  const pruned = filtered.filter((e) => {
    if (!/^[\u4e00-\u9fff]+$/.test(e.surface)) return true
    for (const other of filtered) {
      if (other.id === e.id) continue
      if (!/^[\u4e00-\u9fff]+$/.test(other.surface)) continue
      if (
        other.surface.includes(e.surface) &&
        other.surface.length > e.surface.length &&
        other.df >= e.df
      ) {
        return false
      }
    }
    return true
  })

  pruned.sort((a, b) => b.df - a.df || a.id.localeCompare(b.id))

  const byId = new Map(pruned.map((e) => [e.id, e]))

  return {
    entries: pruned,
    byId,
    note: `s0 规则名词表 · 词×${pruned.length} · 总命中×${pruned.reduce((s, e) => s + e.df, 0)}`,
  }
}
