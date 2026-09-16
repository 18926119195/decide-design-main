/**
 * 段落召回模块：基于用户查询召回相关段落
 * 策略：
 * 1. 查询分析：提取查询中的名词
 * 2. 名词匹配：在 s2 中查找匹配的名词
 * 3. 偏移定位：通过名词偏移量定位到段落
 * 4. 排序：按相关性评分排序
 */

import type { PureTextTable } from './pureTextTable.ts'
import type { NounS1Table } from './nounS1.ts'
import { extractNounSurfacesFromText, normalizeNounSurface } from './bookNounIndex.ts'

export type RecalledParagraph = {
  /** 段落索引（在纯文表中） */
  index: number
  /** 段落文本 */
  text: string
  /** 相关性评分 */
  score: number
  /** 命中的名词列表 */
  matchedNouns: string[]
  /** 每个名词的权重贡献 */
  nounScores: Array<{ noun: string; weight: number }>
}

export type RecallResult = {
  query: string
  paragraphs: RecalledParagraph[]
  note: string
}

/**
 * 段落召回主函数
 */
export function recallParagraphs(
  query: string,
  pureTextTable: PureTextTable,
  nounS1Table: NounS1Table,
  options: {
    topK?: number
    minScore?: number
  } = {},
): RecallResult {
  const topK = options.topK ?? 20
  const minScore = options.minScore ?? 0.1

  // 1. 从查询中提取名词
  const querySurfaces = extractNounSurfacesFromText(query)
  const queryNounIds = new Set(
    querySurfaces.map((s) => normalizeNounSurface(s))
  )

  // 2. 在 s1 中查找匹配的名词（并获取其权重）
  const matchedNouns: Array<{
    id: string
    surface: string
    relevance: number
    offsets: Array<{ start: number; end: number }>
  }> = []

  for (const id of queryNounIds) {
    const entry = nounS1Table.byId.get(id)
    if (entry) {
      matchedNouns.push({
        id: entry.id,
        surface: entry.surface,
        relevance: entry.relevance ?? 3,
        offsets: entry.offsets,
      })
    }
  }

  if (matchedNouns.length === 0) {
    return {
      query,
      paragraphs: [],
      note: '未找到匹配的名词',
    }
  }

  // 3. 通过偏移量定位段落，计算每个段落的得分
  const paragraphScores = new Map<
    number,
    {
      score: number
      matchedNouns: Set<string>
      nounScores: Array<{ noun: string; weight: number }>
    }
  >()

  for (const noun of matchedNouns) {
    for (const offset of noun.offsets) {
      // 根据偏移量找到对应的段落
      const paraIndex = findParagraphByOffset(
        offset.start,
        pureTextTable.paragraphs,
      )
      if (paraIndex < 0) continue

      if (!paragraphScores.has(paraIndex)) {
        paragraphScores.set(paraIndex, {
          score: 0,
          matchedNouns: new Set(),
          nounScores: [],
        })
      }

      const paraScore = paragraphScores.get(paraIndex)!
      
      // 累加权重（同一名词在同一段落多次出现，只算一次）
      // 权重 = relevance * df
      const weight = noun.relevance * noun.offsets.length
      if (!paraScore.matchedNouns.has(noun.id)) {
        paraScore.score += weight
        paraScore.matchedNouns.add(noun.id)
        paraScore.nounScores.push({
          noun: noun.surface,
          weight,
        })
      }
    }
  }

  // 4. 排序并返回 topK
  const candidates: RecalledParagraph[] = []
  for (const [paraIndex, data] of paragraphScores) {
    if (data.score < minScore) continue

    const para = pureTextTable.paragraphs[paraIndex]
    candidates.push({
      index: paraIndex,
      text: para.text,
      score: data.score,
      matchedNouns: [...data.matchedNouns],
      nounScores: data.nounScores,
    })
  }

  candidates.sort((a, b) => b.score - a.score)
  const topResults = candidates.slice(0, topK)

  return {
    query,
    paragraphs: topResults,
    note: `召回 ${topResults.length} 个段落 · 查询匹配 ${matchedNouns.length} 个名词`,
  }
}

/**
 * 根据全局偏移量找到对应的段落索引
 */
function findParagraphByOffset(
  offset: number,
  paragraphs: Array<{
    index: number
    text: string
    startOffset: number
    endOffset: number
    chunkKeys: string[]
    page: number
  }>,
): number {
  for (const para of paragraphs) {
    if (offset >= para.startOffset && offset < para.endOffset) {
      return para.index
    }
  }
  return -1
}

/**
 * 格式化召回结果为可读文本
 */
export function formatRecallResult(result: RecallResult): string {
  let output = `【查询】${result.query}\n\n`
  output += `${result.note}\n\n`

  if (result.paragraphs.length === 0) {
    output += '无召回结果\n'
    return output
  }

  for (let i = 0; i < result.paragraphs.length; i++) {
    const para = result.paragraphs[i]
    output += `## [${i + 1}] 段落#${para.index} · 得分=${para.score.toFixed(3)}\n`
    output += `匹配名词：${para.nounScores.map((n) => `${n.noun}(${n.weight.toFixed(2)})`).join(', ')}\n\n`
    output += `${para.text}\n\n`
    output += '---\n\n'
  }

  return output
}
