/**
 * Current Docuverse decide material path (no UI / no settle store):
 *   seed bookKeys → qCore prioritize → batch decide (⟦n⟧+T) → mintable prospects
 * Optional: restrict seed to TOC strand∩A1 when semanticIndex present and useToc=true
 * (does NOT call toc_nav LLM — chapter filter is CLI/gold-driven or all sections union).
 */

import {
  buildWindowAliasTable,
  formatDeskMaterialSlot,
  windowAliasContractHint,
} from '../core/windowAlias'
import { chunkUniqueKeys, runBatchesParallel } from '../core/parallelLlmBatch'
import { parseDecideMintables, type MintableProspect } from '../core/parseDecide'
import { prioritizeBookKeysByQCore, qCoreNeedles, textHitsQCore } from '../core/qCoreBookHits'
import { chunkT, orderedRetrievableBookKeys } from '../core/text'
import type { BookIndex, BookSemanticIndex } from '../core/types'
import { listTocCorridors } from './loadCorpus'
import { chatCompletions, type LlmConfig } from './llm'

export type DecideEvalOptions = {
  batchSize?: number
  concurrency?: number
  minProspects?: number
  maxKeys?: number
  /** If true and semanticIndex has sections, seed = union of all TOC strands ∩ A1 */
  useTocUnion?: boolean
  tMaxChars?: number
}

export type DecideCaseResult = {
  question: string
  seedKeys: string[]
  qCoreNote: string
  predictedBookKeys: string[]
  mintables: MintableProspect[]
  batchNotes: string[]
  stoppedEarly: boolean
  promptTokens: number
  completionTokens: number
  note: string
}

const DECIDE_SYSTEM =
  '你是写信台 decide 工种。只根据本窗材料槽与 Q_now 判断哪些门能直接支撑解问。' +
  '只输出 JSON。门牌字段只许回传本窗 ⟦n⟧。thinking 关闭。'

function buildDecideUser(input: {
  question: string
  bookKeys: string[]
  bookIndex: BookIndex
  tMaxChars: number
}): { user: string; aliasTable: ReturnType<typeof buildWindowAliasTable> } {
  const aliasTable = buildWindowAliasTable(input.bookKeys)
  const needles = qCoreNeedles(input.question)
  const lines: string[] = []
  lines.push(`Q_now：${input.question}`, '')
  lines.push(
    '【实验·无 peek】decide 直读材料槽：上行 ⟦n⟧ 独占行，下行正文 T；' +
      'prospect 父门=该槽（JSON 只许回传 bookKey/briefKey/key=⟦n⟧）。',
    '',
  )
  let qCoreHits = 0
  for (const k of input.bookKeys) {
    const chunk = input.bookIndex.chunks.find((c) => c.key === k)
    const T = (chunk ? chunkT(chunk) : '').slice(0, input.tMaxChars)
    const tags: string[] = []
    if (!T.trim()) {
      tags.push(
        '【台侧·T 空】本门无原文，禁止编造；须 status=insufficient，prospects 勿写本门。',
      )
    }
    if (textHitsQCore(T, needles)) {
      qCoreHits++
      tags.push(
        `【问核提示】T 含 Q 专名（${needles.slice(0, 4).join('/')}）——逐门判解问相关；` +
          `专名≠充分，也≠默认不足。`,
      )
    }
    lines.push(
      formatDeskMaterialSlot({
        fullKey: k,
        table: aliasTable,
        body: T,
        tags,
      }),
    )
  }
  if (qCoreHits > 0) {
    lines.push(
      '【问核提示】本窗有专名词面命中：逐门独立打分，禁止整窗一刀切 insufficient。',
      '',
    )
  }
  lines.push(windowAliasContractHint(aliasTable), '')
  lines.push(
    '请只输出 JSON（可围栏）：\n' +
      '{\n' +
      '  "prospects": [{ "bookKey": "⟦n⟧", "prospect": "单行≤40字：该原文解 Q_now 的一种可能", "status": "sufficient", "relevance": 4 }],\n' +
      '  "keyStatuses": [{ "key": "⟦n⟧", "status": "unread|sufficient|insufficient" }]\n' +
      '}\n' +
      '硬规则：\n' +
      '- 只有能直接支撑解 Q_now 才写 prospects[]；须带 relevance 1–5；台侧 ≥3 才算命中材料。\n' +
      '- 仅点名/标题/旁例 → insufficient，勿因专名硬铸。\n' +
      '- bookKey/key 只许回传本窗 ⟦n⟧；prospect 单行≤40字。\n' +
      '- 窗内每个 ⟦n⟧ 都必须出现在 prospects 或 keyStatuses。\n' +
      '- 优先保证 JSON 完整可解析。',
  )
  return { user: lines.join('\n'), aliasTable }
}

function seedBookKeys(input: {
  bookIndex: BookIndex
  semanticIndex: BookSemanticIndex | null
  useTocUnion: boolean
  maxKeys: number
}): string[] {
  const all = orderedRetrievableBookKeys(input.bookIndex)
  if (!input.useTocUnion) return all.slice(0, input.maxKeys)
  const corridors = listTocCorridors(input.semanticIndex)
  if (corridors.length === 0) return all.slice(0, input.maxKeys)
  const allowedPages = new Set<number>()
  for (const c of corridors) {
    for (let p = c.startStrand; p <= c.endStrand; p++) allowedPages.add(p)
  }
  return all.filter((k) => {
    const chunk = input.bookIndex.chunks.find((c) => c.key === k)
    return chunk && allowedPages.has(chunk.page)
  }).slice(0, input.maxKeys)
}

export async function runDecideMaterial(input: {
  question: string
  bookIndex: BookIndex
  semanticIndex?: BookSemanticIndex | null
  llm: LlmConfig
  options?: DecideEvalOptions
  onProgress?: (msg: string) => void
}): Promise<DecideCaseResult> {
  const batchSize = input.options?.batchSize ?? 6
  const concurrency = input.options?.concurrency ?? 3
  const minProspects = input.options?.minProspects ?? 10
  const maxKeys = input.options?.maxKeys ?? 400
  const useTocUnion = input.options?.useTocUnion ?? false
  const tMaxChars = input.options?.tMaxChars ?? 1200

  const seed = seedBookKeys({
    bookIndex: input.bookIndex,
    semanticIndex: input.semanticIndex ?? null,
    useTocUnion,
    maxKeys,
  })
  const prio = prioritizeBookKeysByQCore({
    bookKeys: seed,
    bookIndex: input.bookIndex,
    question: input.question,
  })
  const ordered = prio.keys
  const batches = chunkUniqueKeys(ordered, batchSize)
  input.onProgress?.(
    `seed×${ordered.length} · ${prio.note} · 批×${batches.length}`,
  )

  const mintAccum = new Map<string, MintableProspect>()
  const batchNotes: string[] = []
  let promptTokens = 0
  let completionTokens = 0

  const parallel = await runBatchesParallel({
    batches,
    concurrency,
    run: async (batch, index, signal) => {
      input.onProgress?.(`decide 批 ${index + 1}/${batches.length} · ×${batch.length}`)
      const { user, aliasTable } = buildDecideUser({
        question: input.question,
        bookKeys: batch,
        bookIndex: input.bookIndex,
        tMaxChars,
      })
      const chat = await chatCompletions({
        config: input.llm,
        system: DECIDE_SYSTEM,
        user,
        signal,
      })
      if (!chat.ok) {
        return {
          mintables: [] as MintableProspect[],
          note: `批${index + 1} 失败 · ${chat.note}`,
          promptTokens: 0,
          completionTokens: 0,
        }
      }
      const parsed = parseDecideMintables(chat.content, aliasTable)
      return {
        mintables: parsed.mintables,
        note: `批${index + 1} · ${parsed.note}`,
        promptTokens: chat.usage?.prompt_tokens ?? 0,
        completionTokens: chat.usage?.completion_tokens ?? 0,
      }
    },
    shouldStop: (result) => {
      if (!result.ok) return false
      // accumulate check happens after; early stop based on running mint — approximate via result value size only within shouldStop is weak.
      // Use cumulative via closure after each success in a second pass — mirror autoFlow: stop when mintAccum >= min
      return false
    },
  })

  // Sequential accumulate with early-stop semantics: re-run style — prefer first batches in order
  // Parallel already ran; collect in index order and stop counting after minProspects for "predicted" set still includes all returned.
  const orderedResults = [...parallel.results].sort((a, b) => a.index - b.index)
  let stoppedEarly = parallel.stoppedEarly
  for (const r of orderedResults) {
    if (!r.ok) {
      batchNotes.push(r.note)
      continue
    }
    batchNotes.push(r.value.note)
    promptTokens += r.value.promptTokens
    completionTokens += r.value.completionTokens
    for (const m of r.value.mintables) {
      if (!mintAccum.has(m.bookKey)) mintAccum.set(m.bookKey, m)
    }
    if (mintAccum.size >= minProspects) {
      stoppedEarly = true
      break
    }
  }

  // Better early-stop: abort remaining mid-flight — implement proper shouldStop with shared Set
  // For v1, post-hoc truncate note is enough for scoring; tokens may include cancelled work if any.

  const mintables = [...mintAccum.values()]
  return {
    question: input.question,
    seedKeys: ordered,
    qCoreNote: prio.note,
    predictedBookKeys: mintables.map((m) => m.bookKey),
    mintables,
    batchNotes,
    stoppedEarly,
    promptTokens,
    completionTokens,
    note: `${parallel.note} · mintable×${mintables.length}` + (stoppedEarly ? ' · 达早停门槛' : ''),
  }
}

/** Proper early-stop variant: sequential batches (simpler token accounting for eval). */
export async function runDecideMaterialSequential(input: {
  question: string
  bookIndex: BookIndex
  semanticIndex?: BookSemanticIndex | null
  llm: LlmConfig
  options?: DecideEvalOptions
  onProgress?: (msg: string) => void
}): Promise<DecideCaseResult> {
  const batchSize = input.options?.batchSize ?? 6
  const minProspects = input.options?.minProspects ?? 10
  const maxKeys = input.options?.maxKeys ?? 400
  const useTocUnion = input.options?.useTocUnion ?? false
  const tMaxChars = input.options?.tMaxChars ?? 1200

  const seed = seedBookKeys({
    bookIndex: input.bookIndex,
    semanticIndex: input.semanticIndex ?? null,
    useTocUnion,
    maxKeys,
  })
  const prio = prioritizeBookKeysByQCore({
    bookKeys: seed,
    bookIndex: input.bookIndex,
    question: input.question,
  })
  const ordered = prio.keys
  const batches = chunkUniqueKeys(ordered, batchSize)
  const mintAccum = new Map<string, MintableProspect>()
  const batchNotes: string[] = []
  let promptTokens = 0
  let completionTokens = 0
  let stoppedEarly = false

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i]!
    input.onProgress?.(`decide 批 ${i + 1}/${batches.length} · ×${batch.length}`)
    const { user, aliasTable } = buildDecideUser({
      question: input.question,
      bookKeys: batch,
      bookIndex: input.bookIndex,
      tMaxChars,
    })
    const chat = await chatCompletions({
      config: input.llm,
      system: DECIDE_SYSTEM,
      user,
    })
    if (!chat.ok) {
      batchNotes.push(`批${i + 1} 失败 · ${chat.note}`)
      continue
    }
    promptTokens += chat.usage?.prompt_tokens ?? 0
    completionTokens += chat.usage?.completion_tokens ?? 0
    const parsed = parseDecideMintables(chat.content, aliasTable)
    batchNotes.push(`批${i + 1} · ${parsed.note}`)
    for (const m of parsed.mintables) {
      if (!mintAccum.has(m.bookKey)) mintAccum.set(m.bookKey, m)
    }
    if (mintAccum.size >= minProspects) {
      stoppedEarly = true
      break
    }
  }

  const mintables = [...mintAccum.values()]
  return {
    question: input.question,
    seedKeys: ordered,
    qCoreNote: prio.note,
    predictedBookKeys: mintables.map((m) => m.bookKey),
    mintables,
    batchNotes,
    stoppedEarly,
    promptTokens,
    completionTokens,
    note:
      `顺序批 · mintable×${mintables.length}` +
      (stoppedEarly ? ` · 早停≥${minProspects}` : ' · 扫完'),
  }
}
