/**
 * 名词表 s2：LLM 深度语义分析 + 概念聚类
 * 职责：对 s1 名词进行语义分组、同义合并、层级关系识别
 */

import type { NounS1Table, NounS1Entry } from './nounS1.ts'

export type NounS2Cluster = {
  /** 聚类ID */
  clusterId: string
  /** 聚类代表词（最核心的名词） */
  representative: string
  /** 聚类成员（包括代表词） */
  members: string[]
  /** 聚类主题/概念描述 */
  concept: string
  /** 聚类权重（成员总出现次数） */
  weight: number
  /** 最高相关性 */
  maxRelevance: number
}

export type NounS2Table = {
  /** 聚类列表 */
  clusters: NounS2Cluster[]
  /** 名词ID -> 聚类ID */
  nounToCluster: Map<string, string>
  /** 聚类ID -> 聚类 */
  byClusterId: Map<string, NounS2Cluster>
  note: string
}

export type LlmClusterResponse = {
  clusters: Array<{
    representative: string
    members: string[]
    concept: string
  }>
}

/**
 * 构建 s2 聚类 prompt
 */
export function buildNounS2Prompt(nounS1Table: NounS1Table): string {
  // 只取 relevance >= 3 的名词
  const highQualityNouns = nounS1Table.entries
    .filter((e) => (e.relevance ?? 0) >= 3)
    .slice(0, 100)

  const nounList = highQualityNouns
    .map(
      (e, i) =>
        `${i + 1}. ${e.surface} (相关性${e.relevance ?? '?'}, 出现${e.offsets.length}次) ${e.note ? `[${e.note}]` : ''}`,
    )
    .join('\n')

  return `你是专业的语义分析专家。现在需要你对以下名词进行语义聚类和概念抽象。

【高质量名词列表】
${nounList}

【任务】
1. 将语义相关的名词聚类到一起（同义词、上下位关系、强关联概念）
2. 每个聚类选择一个代表词（最核心、最常用的那个）
3. 为每个聚类提炼一个简短的概念描述（5-10字）

【聚类原则】
- 同义词：如 "AI"、"人工智能"、"Artificial Intelligence" -> 聚为一类
- 上下位：如 "动物"、"猫"、"波斯猫" -> 可以聚类，代表词选"猫"或"动物"（看频率和重要性）
- 强关联：如 "机器学习"、"神经网络"、"深度学习" -> 可聚类，概念是"机器学习技术"
- 独立概念不要强行聚类

【输出格式】JSON
{
  "clusters": [
    {
      "representative": "代表词",
      "members": ["成员1", "成员2"],
      "concept": "概念描述"
    }
  ]
}

注意：
- members 必须包含 representative
- 每个名词只能属于一个聚类
- 保持聚类数量合理（不要过度聚合）`
}

/**
 * 解析 LLM s2 响应
 */
export function parseNounS2Response(raw: string): LlmClusterResponse {
  const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
  try {
    const parsed = JSON.parse(cleaned)
    return {
      clusters: Array.isArray(parsed.clusters) ? parsed.clusters : [],
    }
  } catch {
    return { clusters: [] }
  }
}

/**
 * 构建 s2 表
 */
export function buildNounS2Table(
  nounS1Table: NounS1Table,
  llmResponse: LlmClusterResponse,
): NounS2Table {
  const clusters: NounS2Cluster[] = []
  const nounToCluster = new Map<string, string>()
  const usedNouns = new Set<string>()

  // 1. 处理 LLM 聚类
  for (let i = 0; i < llmResponse.clusters.length; i++) {
    const raw = llmResponse.clusters[i]
    const clusterId = `cluster_${i}`

    // 验证成员是否在 s1 中存在
    const validMembers: string[] = []
    let totalWeight = 0
    let maxRelevance = 0

    for (const memberSurface of raw.members) {
      const s1Entry = nounS1Table.entries.find(
        (e) => e.surface.toLowerCase() === memberSurface.toLowerCase(),
      )
      if (s1Entry) {
        validMembers.push(s1Entry.id)
        totalWeight += s1Entry.offsets.length
        maxRelevance = Math.max(maxRelevance, s1Entry.relevance ?? 0)
        usedNouns.add(s1Entry.id)
      }
    }

    if (validMembers.length === 0) continue

    // 确保 representative 在 members 中
    const repEntry = nounS1Table.entries.find(
      (e) => e.surface.toLowerCase() === raw.representative.toLowerCase(),
    )
    const representative = repEntry?.id ?? validMembers[0]

    clusters.push({
      clusterId,
      representative,
      members: validMembers,
      concept: raw.concept || '',
      weight: totalWeight,
      maxRelevance,
    })

    for (const memberId of validMembers) {
      nounToCluster.set(memberId, clusterId)
    }
  }

  // 2. 未聚类的高质量名词自成一类
  for (const s1Entry of nounS1Table.entries) {
    if (usedNouns.has(s1Entry.id)) continue
    if ((s1Entry.relevance ?? 0) < 3) continue

    const clusterId = `cluster_single_${s1Entry.id}`
    clusters.push({
      clusterId,
      representative: s1Entry.id,
      members: [s1Entry.id],
      concept: s1Entry.note || s1Entry.surface,
      weight: s1Entry.offsets.length,
      maxRelevance: s1Entry.relevance ?? 0,
    })
    nounToCluster.set(s1Entry.id, clusterId)
  }

  // 排序：maxRelevance 降序 -> weight 降序
  clusters.sort((a, b) => {
    if (a.maxRelevance !== b.maxRelevance) {
      return b.maxRelevance - a.maxRelevance
    }
    return b.weight - a.weight
  })

  const byClusterId = new Map(clusters.map((c) => [c.clusterId, c]))

  return {
    clusters,
    nounToCluster,
    byClusterId,
    note: `s2 语义聚类表 · 聚类×${clusters.length} · 覆盖名词×${nounToCluster.size}`,
  }
}
