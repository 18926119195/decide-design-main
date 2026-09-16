/**
 * One-click optimization monitor pack.
 * Captures S / S_q / hits / bags / decide / score + auto diagnosis.
 */

import { atomSearchText, isRetrievableAtom } from '../core/text.ts'
import type { BookIndex } from '../core/types.ts'
import type { NounEntry } from '../core/bookNounIndex.ts'
import { qCoreNeedles } from '../core/qCoreBookHits.ts'
import type { EvalCase } from './loadCorpus.ts'
import type { CaseScore } from './score.ts'
import type { NounTableCaseResult } from './runNounTableMaterial.ts'
import { getCachedNounTable } from './runNounTableMaterial.ts'

export type MonitorCase = {
  id: string
  question: string
  goldPages: number[]
  goldBookKeys: string[]
  goldEmpty: boolean
  suggestedGoldPages: number[]
      score: CaseScore
      pipeline: {
    sSize: number
    sq: string[]
    sqSize: number
    hitCount: number
    bagCount: number
    predictedPages: number[]
    predictedBookKeys: string[]
    mintables: NounTableCaseResult['mintables']
    bagsPreview: NounTableCaseResult['bagsPreview']
    hitsByNoun: Array<{ surface: string; hits: number; pages: number[] }>
    notes: string[]
    note: string
    promptTokens: number
    completionTokens: number
  }
  probes: {
    qNeedles: string[]
    needlesInS: Array<{ needle: string; inS: boolean; surface?: string; df?: number }>
    needlesInSq: Array<{ needle: string; inSq: boolean }>
    needlePagesInBook: Array<{ needle: string; pages: number[]; hitChunks: number }>
  }
  diagnosis: string[]
}

export type MonitorPack = {
  kind: 'docuverse-noun-table-monitor'
  version: 1
  at: string
  corpus: { label: string; docId: string; chunks: number }
  sSummary: {
    size: number
    note: string
    topDf: Array<{ surface: string; df: number }>
    latinShare: number
    cjkShare: number
  } | null
  aggregate: {
    n: number
    scoredN: number
    hitRate: number | null
    meanPrecision: number | null
    meanRecall: number | null
    unscoredN: number
  }
  cases: MonitorCase[]
  globalDiagnosis: string[]
}

function pagesForNeedle(bookIndex: BookIndex, needle: string): {
  pages: number[]
  hitChunks: number
} {
  const n = needle.toLowerCase()
  if (n.length < 2) return { pages: [], hitChunks: 0 }
  const pages = new Set<number>()
  let hitChunks = 0
  for (const c of bookIndex.chunks) {
    if (!isRetrievableAtom(c)) continue
    const t = atomSearchText(c).toLowerCase()
    if (!t.includes(n)) continue
    hitChunks++
    pages.add(c.page)
  }
  return { pages: [...pages].sort((a, b) => a - b), hitChunks }
}

function hitsByNounFromPreview(
  result: NounTableCaseResult,
): Array<{ surface: string; hits: number; pages: number[] }> {
  // Approximate from bagsPreview + note; full hist requires runtime — use mint + bags
  const map = new Map<string, { hits: number; pages: Set<number> }>()
  for (const b of result.bagsPreview) {
    const cur = map.get(b.hit) ?? { hits: 0, pages: new Set<number>() }
    cur.hits++
    cur.pages.add(b.page)
    map.set(b.hit, cur)
  }
  return [...map.entries()].map(([surface, v]) => ({
    surface,
    hits: v.hits,
    pages: [...v.pages].sort((a, b) => a - b),
  }))
}

function diagnoseCase(c: MonitorCase): string[] {
  const d: string[] = []
  if (c.goldEmpty) {
    d.push('gold 为空：hitRate 无意义；请填 goldPages 或采用 suggestedGoldPages')
  }
  const missing = c.probes.needlesInS.filter((x) => !x.inS)
  if (missing.length) {
    d.push(
      `问核未进 S：${missing.map((m) => m.needle).join(', ')} → 抽词/停用/去重过狠或 OCR 写法不同`,
    )
  }
  const notPicked = c.probes.needlesInSq.filter((x) => !x.inSq)
  const inS = c.probes.needlesInS.filter((x) => x.inS)
  if (inS.length && notPicked.length) {
    d.push(
      `问核在 S 但未进 S_q：${notPicked.map((m) => m.needle).join(', ')} → 勾选 LLM 跑偏（表太大/分批未见到专名）`,
    )
  }
  if (c.pipeline.sqSize > 40) {
    d.push(`S_q 过大（${c.pipeline.sqSize}）→ 命中爆炸；应收紧勾选或先粗筛再勾`)
  }
  if (c.pipeline.hitCount > 500) {
    d.push(`hit×${c.pipeline.hitCount} 爆炸 → 限 maxHitsPerNoun / 先按问核专名定位`)
  }
  if (c.pipeline.bagCount > 0 && c.pipeline.predictedPages.length === 0) {
    d.push('有拓扑袋但 decide 过闸=0 → 袋噪声大（功能词邻域）或门槛过严')
  }
  const frNoise = c.pipeline.bagsPreview.some((b) =>
    b.neighbors.some((n) =>
      /^(des|que|ces|les|une|est|dans|pour|avec|mais|sur|par)$/i.test(n),
    ),
  )
  if (frNoise) {
    d.push('拓扑邻域含法语功能词 → 扩 STOP_LATIN / 抽词过滤')
  }
  if (
    !c.goldEmpty &&
    c.score.hit === false &&
    c.pipeline.predictedPages.length > 0
  ) {
    d.push(
      `有预测页 ${c.pipeline.predictedPages.join(',')} 但未撞 gold ${c.score.goldPages.join(',')}`,
    )
  }
  if (
    c.probes.needlePagesInBook.some((p) => p.hitChunks > 0) &&
    c.pipeline.predictedPages.length === 0
  ) {
    d.push('书中能词面命中问核，但管线未过闸 → 漏在勾选或 decide')
  }
  return d
}

export function buildMonitorPack(input: {
  corpus: { label: string; docId: string; chunks: number }
  bookIndex: BookIndex
  rows: Array<{
    case: EvalCase
    result: NounTableCaseResult
    score: CaseScore
  }>
}): MonitorPack {
  const cached = getCachedNounTable(input.bookIndex.docId)
  const entries: NounEntry[] = cached?.entries ?? []
  let latin = 0
  let cjk = 0
  for (const e of entries) {
    if (/[\u4e00-\u9fff]/.test(e.surface)) cjk++
    else latin++
  }
  const sSummary = cached
    ? {
        size: entries.length,
        note: cached.note,
        topDf: entries.slice(0, 40).map((e) => ({ surface: e.surface, df: e.df })),
        latinShare: entries.length ? latin / entries.length : 0,
        cjkShare: entries.length ? cjk / entries.length : 0,
      }
    : null

  const cases: MonitorCase[] = input.rows.map((row) => {
    const goldPages = row.case.goldPages ?? []
    const goldBookKeys = row.case.goldBookKeys ?? []
    const goldEmpty = goldPages.length === 0 && goldBookKeys.length === 0
    const needles = qCoreNeedles(row.case.question)
    const needlesInS = needles.map((needle) => {
      const id = needle.toLowerCase()
      const hit = entries.find(
        (e) =>
          e.id === id ||
          e.id.includes(id) ||
          e.surface.toLowerCase().includes(id),
      )
      return {
        needle,
        inS: !!hit,
        surface: hit?.surface,
        df: hit?.df,
      }
    })
    const sqLower = row.result.sq.map((s) => s.toLowerCase())
    const needlesInSq = needles.map((needle) => ({
      needle,
      inSq: sqLower.some(
        (s) => s === needle.toLowerCase() || s.includes(needle.toLowerCase()),
      ),
    }))
    const needlePagesInBook = needles.map((needle) => {
      const r = pagesForNeedle(input.bookIndex, needle)
      return { needle, pages: r.pages.slice(0, 40), hitChunks: r.hitChunks }
    })
    const suggestedGoldPages = [
      ...new Set(needlePagesInBook.flatMap((x) => x.pages)),
    ]
      .sort((a, b) => a - b)
      .slice(0, 30)

    const mc: MonitorCase = {
      id: row.case.id,
      question: row.case.question,
      goldPages,
      goldBookKeys,
      goldEmpty,
      suggestedGoldPages,
      score: row.score,
      pipeline: {
        sSize: row.result.sSize,
        sq: row.result.sq,
        sqSize: row.result.sq.length,
        hitCount: row.result.hitCount,
        bagCount: row.result.bagCount,
        predictedPages: row.result.predictedPages,
        predictedBookKeys: row.result.predictedBookKeys,
        mintables: row.result.mintables,
        bagsPreview: row.result.bagsPreview,
        hitsByNoun: hitsByNounFromPreview(row.result),
        notes: row.result.notes,
        note: row.result.note,
        promptTokens: row.result.promptTokens,
        completionTokens: row.result.completionTokens,
      },
      probes: { qNeedles: needles, needlesInS, needlesInSq, needlePagesInBook },
      diagnosis: [],
    }
    mc.diagnosis = diagnoseCase(mc)
    return mc
  })

  const scoredCases = cases.filter((c) => c.score.scored)
  const aggregate = {
    n: cases.length,
    scoredN: scoredCases.length,
    unscoredN: cases.length - scoredCases.length,
    hitRate:
      scoredCases.length === 0
        ? null
        : scoredCases.filter((c) => c.score.hit).length / scoredCases.length,
    meanPrecision:
      scoredCases.length === 0
        ? null
        : scoredCases.reduce((a, c) => a + c.score.precision, 0) /
          scoredCases.length,
    meanRecall:
      scoredCases.length === 0
        ? null
        : scoredCases.reduce((a, c) => a + c.score.recall, 0) /
          scoredCases.length,
  }

  const globalDiagnosis: string[] = []
  if (aggregate.unscoredN > 0) {
    globalDiagnosis.push(
      `${aggregate.unscoredN}/${aggregate.n} 题无 gold → 先把 suggestedGoldPages 填进评测题再谈 hitRate`,
    )
  }
  if (sSummary && sSummary.size > 3000) {
    globalDiagnosis.push(
      `S 过大（${sSummary.size}）→ 勾选必分批且易漏专名；需粗筛或专名优先入首批`,
    )
  }
  if (sSummary && sSummary.latinShare > 0.85) {
    globalDiagnosis.push('S 几乎全是拉丁词 → 法语功能词污染风险高，加强停用')
  }
  for (const c of cases) {
    for (const line of c.diagnosis) {
      const tagged = `[${c.id}] ${line}`
      if (!globalDiagnosis.includes(tagged)) globalDiagnosis.push(tagged)
    }
  }

  return {
    kind: 'docuverse-noun-table-monitor',
    version: 1,
    at: new Date().toISOString(),
    corpus: input.corpus,
    sSummary,
    aggregate,
    cases,
    globalDiagnosis,
  }
}

/** Human-readable markdown for quick reading in chat / IDE */
export function monitorPackToMarkdown(pack: MonitorPack): string {
  const lines: string[] = []
  lines.push(`# 名词表监控包`)
  lines.push('')
  lines.push(`- 时间：${pack.at}`)
  lines.push(
    `- 语料：${pack.corpus.label} · chunks=${pack.corpus.chunks} · docId=${pack.corpus.docId}`,
  )
  if (pack.sSummary) {
    lines.push(
      `- S：${pack.sSummary.size} · latin=${(pack.sSummary.latinShare * 100).toFixed(0)}% · cjk=${(pack.sSummary.cjkShare * 100).toFixed(0)}%`,
    )
    lines.push(`- ${pack.sSummary.note}`)
  }
  lines.push('')
  lines.push(`## 总诊断`)
  for (const g of pack.globalDiagnosis) lines.push(`- ${g}`)
  lines.push('')
  lines.push(`## 聚合`)
  lines.push(
    `- scored ${pack.aggregate.scoredN}/${pack.aggregate.n}` +
      (pack.aggregate.hitRate == null
        ? ' · hitRate=N/A'
        : ` · hitRate=${(pack.aggregate.hitRate * 100).toFixed(1)}%`),
  )
  for (const c of pack.cases) {
    lines.push('')
    lines.push(`## ${c.id} · ${c.question}`)
    lines.push(`- ${c.score.scoreNote}`)
    lines.push(
      `- S_q×${c.pipeline.sqSize} · hit×${c.pipeline.hitCount} · bag×${c.pipeline.bagCount} · predPages=[${c.pipeline.predictedPages.join(',')}]`,
    )
    lines.push(`- S_q：${c.pipeline.sq.slice(0, 24).join(' · ')}`)
    lines.push(`- 问核：${c.probes.qNeedles.join(', ') || '∅'}`)
    lines.push(
      `- 问核∈S：` +
        c.probes.needlesInS
          .map((x) => `${x.needle}${x.inS ? '✓' : '✗'}`)
          .join(' '),
    )
    lines.push(
      `- 问核∈S_q：` +
        c.probes.needlesInSq
          .map((x) => `${x.needle}${x.inSq ? '✓' : '✗'}`)
          .join(' '),
    )
    if (c.suggestedGoldPages.length) {
      lines.push(
        `- suggestedGoldPages：${c.suggestedGoldPages.slice(0, 20).join(', ')}`,
      )
    }
    if (c.pipeline.mintables.length) {
      lines.push(`- mintables：`)
      for (const m of c.pipeline.mintables) {
        lines.push(
          `  - p? · rel=${m.relevance} · ${m.prospect} · \`${m.bookKey.slice(0, 24)}…\``,
        )
      }
    }
    lines.push(`- 诊断：`)
    for (const d of c.diagnosis) lines.push(`  - ${d}`)
    lines.push(`- 袋预览（前 5）：`)
    for (const b of c.pipeline.bagsPreview.slice(0, 5)) {
      lines.push(
        `  - p${b.page} hit=${b.hit} · nbr=${b.neighbors.slice(0, 8).join('/')}`,
      )
    }
  }
  return lines.join('\n')
}
