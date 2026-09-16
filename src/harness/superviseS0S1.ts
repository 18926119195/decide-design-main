/**
 * U = S₀ ∪ S₁。
 * S₀ 规则抽词：信任，不验。
 * S₁ LLM 缺口：主验证 = 补上的词能否在残文（mask S₀）里命中；命不中则拒收。
 */

import {
  extractNounSurfacesFromText,
  maskNounsInText,
  mergeNounEntries,
  normalizeNounSurface,
  collectRawNounMap,
  type NounEntry,
} from '../core/bookNounIndex.ts'
import { atomSearchText, isRetrievableAtom } from '../core/text.ts'
import type { BookIndex } from '../core/types.ts'
import { chatCompletions, type LlmConfig } from './llm.ts'
import { extractJsonObject } from '../core/parseDecide.ts'

export type CompleteNounReport = {
  kind: 'docuverse-complete-noun-universe'
  version: 4
  at: string
  corpus: { label: string; docId: string; chunks: number }
  definition: string
  uMeaning: string
  S0: { size: number; sample: string[]; note: string }
  S1: {
    size: number
    sample: string[]
    fromRuleGap: number
    fromLlm: number
    /** LLM 提出的候选数（含拒收） */
    llmProposed: number
    /** 残文命中并入 U */
    grounded: number
    /** 未在对应残文/全书残文命中 → 拒收 */
    missedInResidual: string[]
    llmBatches: number
    note: string
  }
  U: { size: number; nouns: string[] }
  /** 主质检：只盯 LLM 缺口准不准 */
  llmHitVerify: {
    proposed: number
    hit: number
    miss: string[]
    missCount: number
    hitRate: number
    /** 全部 LLM 候选都能在残文命中（或本轮无 LLM 候选） */
    ok: boolean
    note: string
  }
  closure: {
    leftoverRule: string[]
    leftoverRuleCount: number
    closedByRule: boolean
    /** 主裁决 = LLM 缺口命中质检通过（规则词不验） */
    closed: boolean
    note: string
  }
  rounds: number
  verdict: string
  notes: string[]
  promptTokens: number
  completionTokens: number
}

function surfacesOf(entries: NounEntry[]): string[] {
  return entries.map((e) => e.surface)
}

function idsOf(entries: NounEntry[]): Set<string> {
  return new Set(entries.map((e) => e.id))
}

/** Rule-extract noun surfaces from text after masking known surfaces. */
export function ruleExtractFromMaskedBook(
  bookIndex: BookIndex,
  knownSurfaces: ReadonlyArray<string>,
): NounEntry[] {
  const map = new Map<string, NounEntry>()
  for (const chunk of bookIndex.chunks) {
    if (!isRetrievableAtom(chunk)) continue
    const masked = maskNounsInText(atomSearchText(chunk), knownSurfaces)
    const cleaned = masked.replace(/_+/g, ' ')
    for (const surface of extractNounSurfacesFromText(cleaned)) {
      const id = normalizeNounSurface(surface)
      if (id.length < 2) continue
      if (/^_+$/.test(id)) continue
      let e = map.get(id)
      if (!e) {
        e = { id, surface, df: 0, bookKeys: [] }
        map.set(id, e)
      }
      e.df++
      if (!e.bookKeys.includes(chunk.key)) e.bookKeys.push(chunk.key)
    }
  }
  return [...map.values()].sort((a, b) => b.df - a.df || a.id.localeCompare(b.id))
}

/**
 * 在 mask(maskSurfaces) 残文中统计 surface 命中次数。
 * 用于验 LLM 缺口：词必须仍出现在「规则词遮住后」的残文里。
 */
export function countHitsInResidual(
  bookIndex: BookIndex,
  maskSurfaces: ReadonlyArray<string>,
  nounId: string,
): number {
  const needle = nounId.toLowerCase()
  if (needle.length < 2) return 0
  let hits = 0
  for (const chunk of bookIndex.chunks) {
    if (!isRetrievableAtom(chunk)) continue
    const residual = maskNounsInText(atomSearchText(chunk), maskSurfaces)
      .replace(/_+/g, ' ')
      .toLowerCase()
    let from = 0
    while (true) {
      const i = residual.indexOf(needle, from)
      if (i < 0) break
      hits++
      from = i + needle.length
    }
  }
  return hits
}

/** Build residual text batches covering the WHOLE book. */
function residualBatches(
  bookIndex: BookIndex,
  knownSurfaces: ReadonlyArray<string>,
  charsPerBatch: number,
): string[] {
  const batches: string[] = []
  let buf = ''
  for (const chunk of bookIndex.chunks) {
    if (!isRetrievableAtom(chunk)) continue
    const masked = maskNounsInText(atomSearchText(chunk), knownSurfaces)
    const cleaned = masked.replace(/_+/g, ' ').replace(/\s+/g, ' ').trim()
    if (!cleaned || cleaned.length < 8) continue
    if (buf.length + cleaned.length + 1 > charsPerBatch && buf.length > 0) {
      batches.push(buf)
      buf = cleaned
    } else {
      buf = buf ? `${buf}\n${cleaned}` : cleaned
    }
  }
  if (buf.trim()) batches.push(buf)
  return batches
}

async function llmExtractFromBatch(input: {
  batch: string
  llm: LlmConfig
  signal?: AbortSignal
}): Promise<{
  nouns: string[]
  promptTokens: number
  completionTokens: number
  note: string
}> {
  const chat = await chatCompletions({
    config: input.llm,
    system:
      '你从残文中抽取名词/专名。已有名词被空格替代。只输出原文中仍可见的词。禁止发明、禁止摘要。',
    user:
      '残文如下。列出仍可辨认的名词/专名（书中原词表面形）。\n' +
      'JSON: { "nouns": ["…"] }\n\n' +
      input.batch,
    maxTokens: 2048,
    signal: input.signal,
  })
  if (!chat.ok) {
    return { nouns: [], promptTokens: 0, completionTokens: 0, note: chat.note }
  }
  const obj = extractJsonObject(chat.content)
  const nouns = Array.isArray(obj?.nouns)
    ? obj!.nouns.map((x) => String(x).trim()).filter((x) => x.length >= 2 && !/_/.test(x))
    : []
  return {
    nouns,
    promptTokens: chat.usage?.prompt_tokens ?? 0,
    completionTokens: chat.usage?.completion_tokens ?? 0,
    note: 'ok',
  }
}

/**
 * Build U = S₀ ∪ S₁.
 * 主验证：LLM 补的缺口词必须在残文（mask S₀）命中；规则词不验。
 */
export async function buildCompleteNounUniverse(input: {
  bookIndex: BookIndex
  corpus: { label: string; docId: string; chunks: number }
  llm: LlmConfig
  residualLlm?: boolean
  charsPerLlmBatch?: number
  maxLlmBatches?: number
  maxRounds?: number
  onProgress?: (msg: string) => void
}): Promise<CompleteNounReport> {
  const residualLlm = input.residualLlm !== false
  const charsPer = input.charsPerLlmBatch ?? 2500
  const maxLlmBatches = input.maxLlmBatches ?? 80
  const maxRounds = input.maxRounds ?? 3
  const notes: string[] = []
  let promptTokens = 0
  let completionTokens = 0

  const { map, rawCount } = collectRawNounMap(input.bookIndex)
  const S0 = [...map.values()].sort(
    (a, b) => b.df - a.df || a.id.localeCompare(b.id),
  )
  notes.push(`S₀ 规则全量去重 ×${S0.length}（原始抽×${rawCount}；规则词信任、不验）`)

  let U = S0.map((e) => ({ ...e, bookKeys: [...e.bookKeys] }))
  let fromRuleGap = 0
  let fromLlm = 0
  let llmProposed = 0
  const missedInResidual: string[] = []
  const groundedLlm: string[] = []
  let llmBatches = 0
  let rounds = 0

  for (let round = 1; round <= maxRounds; round++) {
    rounds = round
    const known = surfacesOf(U)
    input.onProgress?.(`闭合轮 ${round}/${maxRounds} · 当前 |U|=${U.length}`)

    const ruleGap = ruleExtractFromMaskedBook(input.bookIndex, known)
    const newRule = ruleGap.filter((e) => !idsOf(U).has(e.id))
    if (newRule.length) {
      U = mergeNounEntries(U, newRule.map((e) => e.surface), input.bookIndex)
      fromRuleGap += newRule.length
      notes.push(`轮${round} 规则缺口 +${newRule.length} → |U|=${U.length}（规则侧，不验）`)
    }

    let llmNew = 0
    if (residualLlm) {
      // 残文只 mask 当前已入 U 的词，让 LLM 看缺口；入表前用 mask(S₀∪规则缺口) 验命中
      const batches = residualBatches(input.bookIndex, surfacesOf(U), charsPer)
      const useBatches = batches.slice(0, maxLlmBatches)
      notes.push(
        `轮${round} 残文 LLM 批×${useBatches.length}/${batches.length}（每批≤${charsPer}字·控注意力）`,
      )
      const s0Surfaces = surfacesOf(S0)

      for (let i = 0; i < useBatches.length; i++) {
        input.onProgress?.(
          `轮${round} LLM 批 ${i + 1}/${useBatches.length} · |U|=${U.length}`,
        )
        const batch = useBatches[i]!
        const batchLower = batch.toLowerCase()
        const r = await llmExtractFromBatch({ batch, llm: input.llm })
        llmBatches++
        promptTokens += r.promptTokens
        completionTokens += r.completionTokens
        if (r.note !== 'ok') {
          notes.push(`轮${round} 批${i + 1} 失败 · ${r.note}`)
          continue
        }
        for (const s of r.nouns) {
          const id = normalizeNounSurface(s)
          if (idsOf(U).has(id)) continue
          llmProposed++

          // 1) 必须出现在本批残文（分批局部验，控注意力）
          if (!batchLower.includes(id)) {
            missedInResidual.push(s)
            continue
          }
          // 2) 必须在全书「遮住 S₀ 后的残文」里仍能命中（规则漏掉的真缺口）
          const hitN = countHitsInResidual(input.bookIndex, s0Surfaces, id)
          if (hitN <= 0) {
            missedInResidual.push(s)
            continue
          }

          groundedLlm.push(s)
          U = mergeNounEntries(U, [s], input.bookIndex)
          fromLlm++
          llmNew++
        }
      }
      if (llmNew) notes.push(`轮${round} LLM 缺口命中落地 +${llmNew} → |U|=${U.length}`)
    }

    const leftoverProbe = ruleExtractFromMaskedBook(
      input.bookIndex,
      surfacesOf(U),
    )
    if (newRule.length === 0 && llmNew === 0) {
      notes.push(`轮${round} 无新增 · 停止`)
      break
    }
    if (leftoverProbe.length === 0 && llmNew === 0) {
      notes.push(`轮${round} 残文规则已空 · 停止`)
      break
    }
  }

  const leftover = ruleExtractFromMaskedBook(input.bookIndex, surfacesOf(U))
  const closedByRule = leftover.length === 0

  const missUnique = [...new Set(missedInResidual)]
  const hit = groundedLlm.length
  const proposed = llmProposed
  const hitRate = proposed === 0 ? 1 : hit / proposed
  const llmOk = missUnique.length === 0
  const closed = llmOk

  const llmNote =
    proposed === 0
      ? residualLlm
        ? '本轮 LLM 未提出新候选（或未开到缺口）；无 LLM 命中风险可验'
        : '未开残文 LLM；无 LLM 缺口需验'
      : llmOk
        ? `LLM 缺口质检通过：提出×${proposed} 全部在残文命中并入 U`
        : `LLM 缺口质检未过：提出×${proposed} · 命中×${hit} · 残文未命中拒收×${missUnique.length}`

  const s1Size = U.filter((e) => !idsOf(S0).has(e.id)).length
  const S1surfaces = [
    ...new Set([
      ...groundedLlm,
      ...U.filter((e) => !idsOf(S0).has(e.id)).map((e) => e.surface),
    ]),
  ]

  const verdict = closed
    ? `LLM 缺口命中通过 · |S₀|=${S0.length} · |S₁|=${s1Size} · |U|=${U.length} · hitRate=${(hitRate * 100).toFixed(1)}%`
    : `LLM 缺口有未命中 · 拒收×${missUnique.length} · hitRate=${(hitRate * 100).toFixed(1)}% · |U|=${U.length}`

  return {
    kind: 'docuverse-complete-noun-universe',
    version: 4,
    at: new Date().toISOString(),
    corpus: input.corpus,
    definition:
      'U = S₀∪S₁。主验证只盯 LLM 补的缺口：能否在 mask(S₀) 残文中命中（分批局部 + 全书残文）。规则抽词不验。',
    uMeaning:
      'U = 规则 S₀ + 缺口 S₁（残文规则再扫 ∪ 残文 LLM 且命中通过）去重后的名词表。',
    S0: {
      size: S0.length,
      sample: S0.slice(0, 40).map((e) => e.surface),
      note: '规则抽词去重全量（信任，不验）',
    },
    S1: {
      size: s1Size,
      sample: S1surfaces.slice(0, 40),
      fromRuleGap,
      fromLlm,
      llmProposed: proposed,
      grounded: hit,
      missedInResidual: missUnique.slice(0, 80),
      llmBatches,
      note: residualLlm
        ? `LLM 候选×${proposed} · 残文命中入表×${hit} · 拒收×${missUnique.length} · 批×${llmBatches}`
        : '未开 LLM，缺口仅残文规则',
    },
    U: {
      size: U.length,
      nouns: U.map((e) => e.surface).sort((a, b) => a.localeCompare(b)),
    },
    llmHitVerify: {
      proposed,
      hit,
      miss: missUnique.slice(0, 80),
      missCount: missUnique.length,
      hitRate,
      ok: llmOk,
      note: llmNote,
    },
    closure: {
      leftoverRule: leftover.slice(0, 80).map((e) => e.surface),
      leftoverRuleCount: leftover.length,
      closedByRule,
      closed,
      note: `${llmNote}；同规则残留×${leftover.length}（仅参考，不作主裁决）`,
    },
    rounds,
    verdict,
    notes,
    promptTokens,
    completionTokens,
  }
}

export function completeNounReportToMarkdown(r: CompleteNounReport): string {
  const lines: string[] = []
  lines.push('# 文档名词全集监督（S₀ + 缺口 → U）')
  lines.push('')
  lines.push(`- **U 是什么**：${r.uMeaning}`)
  lines.push(`- ${r.definition}`)
  lines.push(`- 语料：${r.corpus.label} · chunks=${r.corpus.chunks}`)
  lines.push(`- **裁决：${r.verdict}**`)
  lines.push(`- ${r.closure.note}`)
  lines.push('')
  lines.push('## 规模')
  lines.push(
    `- |S₀|=${r.S0.size} · |S₁|=${r.S1.size}（规则缺口+${r.S1.fromRuleGap} / LLM+${r.S1.fromLlm}）· |U|=${r.U.size}`,
  )
  lines.push('')
  lines.push('## 主验证：LLM 缺口残文命中')
  lines.push(
    `- ok=${r.llmHitVerify.ok} · 提出×${r.llmHitVerify.proposed} · 命中×${r.llmHitVerify.hit} · 拒收×${r.llmHitVerify.missCount} · hitRate=${(r.llmHitVerify.hitRate * 100).toFixed(1)}%`,
  )
  lines.push(`- ${r.llmHitVerify.note}`)
  lines.push(r.llmHitVerify.miss.join(' · ') || '  （无拒收）')
  lines.push('')
  lines.push('## 对照：同规则残留（不主裁）')
  lines.push(
    `- closedByRule=${r.closure.closedByRule} · leftover×${r.closure.leftoverRuleCount}`,
  )
  lines.push(r.closure.leftoverRule.join(' · ') || '  （规则残留空）')
  lines.push('')
  lines.push('## 过程')
  for (const n of r.notes) lines.push(`- ${n}`)
  lines.push('')
  lines.push('## U 样本（前 80）')
  lines.push(r.U.nouns.slice(0, 80).join(' · '))
  return lines.join('\n')
}

/** Back-compat wrapper name used by server */
export async function superviseS0S1(input: {
  bookIndex: BookIndex
  corpus: { label: string; docId: string; chunks: number }
  llm: LlmConfig
  residualLlm: boolean
  residualMaxChars?: number
  missingSampleLimit?: number
  onProgress?: (msg: string) => void
}): Promise<CompleteNounReport> {
  return buildCompleteNounUniverse({
    bookIndex: input.bookIndex,
    corpus: input.corpus,
    llm: input.llm,
    residualLlm: input.residualLlm,
    charsPerLlmBatch: input.residualMaxChars
      ? Math.min(2500, input.residualMaxChars)
      : 2500,
    onProgress: input.onProgress,
  })
}

export function superviseReportToMarkdown(r: CompleteNounReport): string {
  return completeNounReportToMarkdown(r)
}

export type SSuperviseReport = CompleteNounReport
