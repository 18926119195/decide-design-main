/**
 * 名词表 s1：LLM 增强名词提取
 * 职责：基于 s0 的名词 + 上下文，让 LLM 补充遗漏的重要名词并确认每个名词
 */

import type { PureTextTable } from './pureTextTable.ts'
import type { NounS0Table } from './nounS0.ts'
import { normalizeNounSurface } from './bookNounIndex.ts'

export type NounS1Entry = {
  id: string
  surface: string
  /** s0 已有 */
  fromS0: boolean
  /** LLM 补充 */
  fromLlm: boolean
  /** 相关性评分 1-5，LLM 判断 */
  relevance: number | null
  /** LLM 给出的简短说明 */
  note: string
  /** 偏移量（从 s0 继承，或为空） */
  offsets: Array<{ start: number; end: number }>
}

export type NounS1Table = {
  entries: NounS1Entry[]
  byId: Map<string, NounS1Entry>
  note: string
}

export type LlmNounConfirmation = {
  /** 名词原文 */
  noun: string
  /** 相关性 1-5 */
  relevance: number
  /** 简短说明（为何重要/不重要） */
  reason: string
}

export type LlmNounSupplementResponse = {
  /** 对 s0 名词的确认 */
  confirmed: LlmNounConfirmation[]
  /** LLM 新增的名词 */
  added: LlmNounConfirmation[]
}

/**
 * 构建 LLM prompt：提供纯文摘要 + s0 名词列表
 */
export function buildNounS1Prompt(
  pureTextTable: PureTextTable,
  nounS0Table: NounS0Table,
): string {
  // 构建摘要：取前 8000 字符作为上下文
  const contextLength = 8000
  const context =
    pureTextTable.fullText.length > contextLength
      ? pureTextTable.fullText.slice(0, contextLength) + '\n\n[文本截断...]'
      : pureTextTable.fullText

  const s0List = nounS0Table.entries
    .slice(0, 200) // 限制前 200 个高频名词
    .map((e, i) => `${i + 1}. ${e.surface} (出现${e.df}次)`)
    .join('\n')

  return `你是专业的文本分析助手。现在需要你基于以下文本，对已抽取的名词进行确认和补充。

【文本内容】
${context}

【规则已抽取的名词列表（按频率降序）】
${s0List}

【任务】
1. 确认上述名词列表中哪些是文本的重要概念、实体、术语
2. 为每个名词评估相关性（1-5分）：
   - 5分：核心概念/关键实体（如主角、核心术语、关键地点）
   - 4分：重要概念/次要实体
   - 3分：普通名词/一般实体
   - 2分：边缘概念
   - 1分：无关或噪音
3. 补充任何遗漏的重要名词（特别是规则可能错过的：多词组合、专有名词、领域术语）

【输出格式】JSON
{
  "confirmed": [
    {"noun": "名词原文", "relevance": 5, "reason": "核心角色"}
  ],
  "added": [
    {"noun": "遗漏的名词", "relevance": 4, "reason": "重要地点"}
  ]
}

注意：
- 只确认列表中实际出现的名词
- added 中补充的名词必须在文本中真实出现
- reason 控制在 10 字以内
- 优先高相关性名词（4-5分），低相关性的可以少标或不标`
}

/**
 * 解析 LLM 响应
 */
export function parseNounS1Response(raw: string): LlmNounSupplementResponse {
  const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
  try {
    const parsed = JSON.parse(cleaned)
    return {
      confirmed: Array.isArray(parsed.confirmed) ? parsed.confirmed : [],
      added: Array.isArray(parsed.added) ? parsed.added : [],
    }
  } catch {
    return { confirmed: [], added: [] }
  }
}

/**
 * 合并 s0 + LLM 结果，构建 s1 表
 */
export function buildNounS1Table(
  nounS0Table: NounS0Table,
  llmResponse: LlmNounSupplementResponse,
  pureTextTable: PureTextTable,
): NounS1Table {
  const map = new Map<string, NounS1Entry>()

  // 1. 导入 s0 所有名词（默认 relevance = null）
  for (const s0Entry of nounS0Table.entries) {
    map.set(s0Entry.id, {
      id: s0Entry.id,
      surface: s0Entry.surface,
      fromS0: true,
      fromLlm: false,
      relevance: null,
      note: '',
      offsets: [...s0Entry.offsets],
    })
  }

  // 2. 应用 LLM confirmed
  for (const conf of llmResponse.confirmed) {
    const id = normalizeNounSurface(conf.noun)
    const existing = map.get(id)
    if (existing) {
      existing.relevance = conf.relevance
      existing.note = conf.reason || ''
      existing.fromLlm = true
    }
  }

  // 3. 添加 LLM added（需要在文本中定位偏移）
  for (const add of llmResponse.added) {
    const id = normalizeNounSurface(add.noun)
    if (map.has(id)) {
      // 已存在，只更新 relevance
      const existing = map.get(id)!
      if (!existing.relevance || add.relevance > existing.relevance) {
        existing.relevance = add.relevance
        existing.note = add.reason || ''
        existing.fromLlm = true
      }
      continue
    }

    // 新增名词，需要定位
    const offsets = locateNounInText(add.noun, pureTextTable.fullText)
    if (offsets.length === 0) {
      // LLM 幻觉，跳过
      continue
    }

    map.set(id, {
      id,
      surface: add.noun,
      fromS0: false,
      fromLlm: true,
      relevance: add.relevance,
      note: add.reason || '',
      offsets,
    })
  }

  // 4. 过滤：只保留 relevance >= 3 或 fromS0 且高频
  const filtered = [...map.values()].filter((e) => {
    if (e.relevance != null && e.relevance >= 3) return true
    if (e.fromS0 && e.offsets.length >= 3) return true
    return false
  })

  // 排序：relevance 降序 -> df 降序
  filtered.sort((a, b) => {
    const ra = a.relevance ?? 0
    const rb = b.relevance ?? 0
    if (ra !== rb) return rb - ra
    return b.offsets.length - a.offsets.length
  })

  const byId = new Map(filtered.map((e) => [e.id, e]))

  return {
    entries: filtered,
    byId,
    note: `s1 LLM增强名词表 · 词×${filtered.length} · LLM确认×${filtered.filter((e) => e.fromLlm).length} · LLM新增×${filtered.filter((e) => !e.fromS0).length}`,
  }
}

/**
 * 在文本中定位名词的所有出现位置
 */
function locateNounInText(
  noun: string,
  fullText: string,
): Array<{ start: number; end: number }> {
  const offsets: Array<{ start: number; end: number }> = []
  const needle = noun.toLowerCase()
  const haystack = fullText.toLowerCase()

  let from = 0
  while (from < haystack.length) {
    const at = haystack.indexOf(needle, from)
    if (at < 0) break
    offsets.push({ start: at, end: at + noun.length })
    from = at + 1
  }

  return offsets
}
