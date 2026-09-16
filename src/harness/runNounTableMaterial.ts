/**
 * Noun-table material path (eval default):
 *   build S → LLM pick S_q (batched) → locate hits → topo bags → decide on bags
 * Residual LLM fill for S₁ is optional (opts.residualLlm).
 */

import {
  buildNounTable,
  buildTopoBags,
  locateNounHits,
  mergeNounEntries,
  maskNounsInText,
  type NounEntry,
  type TopoBag,
} from '../core/bookNounIndex.ts'
import {
  buildWindowAliasTable,
  formatDeskMaterialSlot,
  windowAliasContractHint,
} from '../core/windowAlias.ts'
import { parseDecideMintables } from '../core/parseDecide.ts'
import { atomSearchText, isRetrievableAtom } from '../core/text.ts'
import type { BookIndex } from '../core/types.ts'
import { chatCompletions, type LlmConfig } from './llm.ts'

export type NounTableOptions = {
  /** Max nouns per pick batch */
  pickBatchSize?: number
  /** Max pick batches (safety) */
  maxPickBatches?: number
  neighborN?: number
  maxHitsPerNoun?: number
  maxBags?: number
  /** Decide bags per LLM call */
  decideBatchSize?: number
  /** Optional: LLM residual noun fill after mask */
  residualLlm?: boolean
  residualMaxChars?: number
}

export type NounTableCaseResult = {
  question: string
  sSize: number
  sNote: string
  sq: string[]
  hitCount: number
  bagCount: number
  predictedBookKeys: string[]
  predictedPages: number[]
  mintables: Array<{
    bookKey: string
    prospect: string
    relevance: number | null
  }>
  bagsPreview: Array<{
    bagId: string
    bookKey: string
    page: number
    hit: string
    neighbors: string[]
  }>
  promptTokens: number
  completionTokens: number
  notes: string[]
  note: string
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

async function pickRelevantNouns(input: {
  question: string
  entries: NounEntry[]
  llm: LlmConfig
  batchSize: number
  maxBatches: number
}): Promise<{ selected: NounEntry[]; notes: string[]; promptTokens: number; completionTokens: number }> {
  const selected = new Map<string, NounEntry>()
  const notes: string[] = []
  let promptTokens = 0
  let completionTokens = 0
  const batches = chunkArray(input.entries, input.batchSize).slice(0, input.maxBatches)

  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi]!
    const alias = buildWindowAliasTable(batch.map((e) => e.id))
    const lines: string[] = [
      `Q_now：${input.question}`,
      '',
      '【书内名词表 · 闭集勾选】下列为去重后的书内名词。请勾选与解答 Q_now 相关的项。',
      '禁止发明表外词；只回传本窗 ⟦n⟧。',
      '',
    ]
    for (const e of batch) {
      const door = alias.aliasOf.get(e.id)!
      lines.push(door)
      lines.push(`${e.surface} · df=${e.df}`)
      lines.push('')
    }
    lines.push(windowAliasContractHint(alias))
    lines.push(
      '请只输出 JSON：\n' +
        '{ "selected": ["⟦n⟧", …] }\n' +
        '硬规则：只许 ⟦n⟧；可空数组；宁缺毋滥。',
    )

    const chat = await chatCompletions({
      config: input.llm,
      system:
        '你从书内名词闭集中勾选与问题相关的名词。只输出 JSON。禁止造词。',
      user: lines.join('\n'),
      maxTokens: 2048,
    })
    if (!chat.ok) {
      notes.push(`勾选批${bi + 1}失败 · ${chat.note}`)
      continue
    }
    promptTokens += chat.usage?.prompt_tokens ?? 0
    completionTokens += chat.usage?.completion_tokens ?? 0

    const { extractJsonObject } = await import('../core/parseDecide.ts')
    const { resolveWindowDoorplate } = await import('../core/windowAlias.ts')
    const obj = extractJsonObject(chat.content)
    const arr = Array.isArray(obj?.selected)
      ? obj!.selected
      : Array.isArray(obj?.nouns)
        ? obj!.nouns
        : []
    let got = 0
    for (const raw of arr) {
      const id =
        resolveWindowDoorplate(String(raw), alias) ??
        (alias.fullKeys.includes(String(raw)) ? String(raw) : null)
      if (!id) continue
      const e = batch.find((x) => x.id === id)
      if (e && !selected.has(e.id)) {
        selected.set(e.id, e)
        got++
      }
    }
    notes.push(`勾选批${bi + 1} · 选×${got}/${batch.length}`)
  }

  return {
    selected: [...selected.values()],
    notes,
    promptTokens,
    completionTokens,
  }
}

async function residualFillNouns(input: {
  bookIndex: BookIndex
  entries: NounEntry[]
  llm: LlmConfig
  maxChars: number
}): Promise<{ extras: string[]; note: string; promptTokens: number; completionTokens: number }> {
  const surfaces = input.entries.map((e) => e.surface)
  const parts: string[] = []
  let used = 0
  for (const chunk of input.bookIndex.chunks) {
    if (!isRetrievableAtom(chunk)) continue
    const masked = maskNounsInText(atomSearchText(chunk), surfaces)
    if (!masked.replace(/[_\s]/g, '').length) continue
    const piece = masked.slice(0, 400)
    if (used + piece.length > input.maxChars) break
    parts.push(piece)
    used += piece.length
  }
  if (parts.length === 0) {
    return { extras: [], note: '残文空 · 跳过补抽', promptTokens: 0, completionTokens: 0 }
  }
  const chat = await chatCompletions({
    config: input.llm,
    system: '从残文中抽出仍可见的专名/名词。只输出 JSON。不要摘要。',
    user:
      '下列文本中已有名词被遮盖为下划线。请列出仍可辨认的专名/名词（书中原词）。\n' +
      'JSON: { "nouns": ["…"] }\n\n' +
      parts.join('\n---\n'),
    maxTokens: 2048,
  })
  if (!chat.ok) {
    return {
      extras: [],
      note: `残文补抽失败 · ${chat.note}`,
      promptTokens: 0,
      completionTokens: 0,
    }
  }
  const { extractJsonObject } = await import('../core/parseDecide.ts')
  const obj = extractJsonObject(chat.content)
  const nouns = Array.isArray(obj?.nouns)
    ? obj!.nouns.map((x) => String(x).trim()).filter(Boolean)
    : []
  return {
    extras: nouns,
    note: `残文补抽 · +${nouns.length}`,
    promptTokens: chat.usage?.prompt_tokens ?? 0,
    completionTokens: chat.usage?.completion_tokens ?? 0,
  }
}

async function decideOnTopoBags(input: {
  question: string
  bags: TopoBag[]
  bookIndex: BookIndex
  llm: LlmConfig
  batchSize: number
}): Promise<{
  mintables: Array<{ bookKey: string; prospect: string; relevance: number | null }>
  notes: string[]
  promptTokens: number
  completionTokens: number
}> {
  const mintByKey = new Map<
    string,
    { bookKey: string; prospect: string; relevance: number | null }
  >()
  const notes: string[] = []
  let promptTokens = 0
  let completionTokens = 0
  const batches = chunkArray(input.bags, input.batchSize)

  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi]!
    // Slot identity = bagId (stable), map to bookKey after
    const slotKeys = batch.map((b) => b.bagId)
    const alias = buildWindowAliasTable(slotKeys)
    const lines: string[] = [
      `Q_now：${input.question}`,
      '',
      '【语义拓扑袋】每个槽=一个名词命中点：命中词 + 前后异名词邻域（非全文）。',
      '判断该出现点所在段落是否能直接支撑解 Q_now。充分才写 prospect。',
      '',
    ]
    for (const bag of batch) {
      const body =
        `命中词：${bag.hit.surface}\n` +
        `邻域异名词：${bag.neighbors.length ? bag.neighbors.join(' · ') : '（空）'}\n` +
        `页：${bag.page}`
      lines.push(
        formatDeskMaterialSlot({
          fullKey: bag.bagId,
          table: alias,
          body,
        }),
      )
    }
    lines.push(windowAliasContractHint(alias))
    lines.push(
      '请只输出 JSON：\n' +
        '{\n' +
        '  "prospects": [{ "bookKey": "⟦n⟧", "prospect": "单行≤40字", "status": "sufficient", "relevance": 4 }],\n' +
        '  "keyStatuses": [{ "key": "⟦n⟧", "status": "sufficient|insufficient" }]\n' +
        '}\n' +
        '硬规则：门牌只许 ⟦n⟧；relevance≥3 且 sufficient 才算材料命中；邻域不足以解问 → insufficient。',
    )

    const chat = await chatCompletions({
      config: input.llm,
      system:
        '你是 decide：根据名词命中点的拓扑邻域判断材料是否解问相关。只输出 JSON。',
      user: lines.join('\n'),
      maxTokens: 4096,
    })
    if (!chat.ok) {
      notes.push(`拓扑decide批${bi + 1}失败 · ${chat.note}`)
      continue
    }
    promptTokens += chat.usage?.prompt_tokens ?? 0
    completionTokens += chat.usage?.completion_tokens ?? 0
    const parsed = parseDecideMintables(chat.content, alias)
    // Map bagId → bookKey
    for (const m of parsed.mintables) {
      const bag = batch.find((b) => b.bagId === m.bookKey)
      const bookKey = bag?.bookKey ?? m.bookKey
      if (!mintByKey.has(bookKey)) {
        mintByKey.set(bookKey, {
          bookKey,
          prospect: m.prospect,
          relevance: m.relevance,
        })
      }
    }
    notes.push(`拓扑decide批${bi + 1} · ${parsed.note} → 门×${mintByKey.size}`)
  }

  return {
    mintables: [...mintByKey.values()],
    notes,
    promptTokens,
    completionTokens,
  }
}

/** Cache S per docId in memory for web UI. */
const sCache = new Map<
  string,
  { entries: NounEntry[]; note: string; builtAt: number }
>()

export function getCachedNounTable(docId: string) {
  return sCache.get(docId) ?? null
}

export function clearNounTableCache(docId?: string) {
  if (docId) sCache.delete(docId)
  else sCache.clear()
}

export async function ensureNounTable(input: {
  bookIndex: BookIndex
  llm: LlmConfig
  residualLlm?: boolean
  residualMaxChars?: number
  forceRebuild?: boolean
}): Promise<{ entries: NounEntry[]; note: string; promptTokens: number; completionTokens: number }> {
  const docId = input.bookIndex.docId
  if (!input.forceRebuild && sCache.has(docId)) {
    const c = sCache.get(docId)!
    return { entries: c.entries, note: c.note + ' · cache', promptTokens: 0, completionTokens: 0 }
  }

  let { entries, note } = buildNounTable(input.bookIndex)
  let promptTokens = 0
  let completionTokens = 0

  if (input.residualLlm) {
    const fill = await residualFillNouns({
      bookIndex: input.bookIndex,
      entries,
      llm: input.llm,
      maxChars: input.residualMaxChars ?? 12000,
    })
    promptTokens += fill.promptTokens
    completionTokens += fill.completionTokens
    if (fill.extras.length) {
      entries = mergeNounEntries(entries, fill.extras, input.bookIndex)
    }
    note = `${note} · ${fill.note} · 合并后×${entries.length}`
  }

  sCache.set(docId, { entries, note, builtAt: Date.now() })
  return { entries, note, promptTokens, completionTokens }
}

export async function runNounTableMaterial(input: {
  question: string
  bookIndex: BookIndex
  llm: LlmConfig
  options?: NounTableOptions
  onProgress?: (msg: string) => void
}): Promise<NounTableCaseResult> {
  const opts = input.options ?? {}
  const pickBatchSize = opts.pickBatchSize ?? 80
  const maxPickBatches = opts.maxPickBatches ?? 8
  const neighborN = opts.neighborN ?? 5
  const maxHitsPerNoun = opts.maxHitsPerNoun ?? 60
  const maxBags = opts.maxBags ?? 80
  const decideBatchSize = opts.decideBatchSize ?? 10
  const notes: string[] = []
  let promptTokens = 0
  let completionTokens = 0

  input.onProgress?.('建名词表 S…')
  const table = await ensureNounTable({
    bookIndex: input.bookIndex,
    llm: input.llm,
    residualLlm: opts.residualLlm ?? false,
    residualMaxChars: opts.residualMaxChars,
  })
  promptTokens += table.promptTokens
  completionTokens += table.completionTokens
  notes.push(table.note)

  input.onProgress?.(`勾选 S_q · 表×${table.entries.length}…`)
  const picked = await pickRelevantNouns({
    question: input.question,
    entries: table.entries,
    llm: input.llm,
    batchSize: pickBatchSize,
    maxBatches: maxPickBatches,
  })
  promptTokens += picked.promptTokens
  completionTokens += picked.completionTokens
  notes.push(...picked.notes)

  if (picked.selected.length === 0) {
    return {
      question: input.question,
      sSize: table.entries.length,
      sNote: table.note,
      sq: [],
      hitCount: 0,
      bagCount: 0,
      predictedBookKeys: [],
      predictedPages: [],
      mintables: [],
      bagsPreview: [],
      promptTokens,
      completionTokens,
      notes,
      note: 'S_q 空 · 无材料',
    }
  }

  input.onProgress?.(`定位命中 · S_q×${picked.selected.length}…`)
  const byId = new Map(table.entries.map((e) => [e.id, e]))
  const hits = locateNounHits({
    bookIndex: input.bookIndex,
    nouns: picked.selected,
    maxHitsPerNoun,
  })
  notes.push(`定位 · hit×${hits.length}`)

  input.onProgress?.(`组拓扑袋 ±${neighborN}…`)
  const bags = buildTopoBags({
    bookIndex: input.bookIndex,
    nounById: byId,
    hits,
    neighborN,
    maxBags,
  })
  notes.push(`拓扑袋 ×${bags.length}`)

  if (bags.length === 0) {
    return {
      question: input.question,
      sSize: table.entries.length,
      sNote: table.note,
      sq: picked.selected.map((e) => e.surface),
      hitCount: hits.length,
      bagCount: 0,
      predictedBookKeys: [],
      predictedPages: [],
      mintables: [],
      bagsPreview: [],
      promptTokens,
      completionTokens,
      notes,
      note: '无拓扑袋',
    }
  }

  input.onProgress?.(`decide 拓扑袋 ×${bags.length}…`)
  const decided = await decideOnTopoBags({
    question: input.question,
    bags,
    bookIndex: input.bookIndex,
    llm: input.llm,
    batchSize: decideBatchSize,
  })
  promptTokens += decided.promptTokens
  completionTokens += decided.completionTokens
  notes.push(...decided.notes)

  const predictedBookKeys = decided.mintables.map((m) => m.bookKey)
  const predictedPages = [
    ...new Set(
      predictedBookKeys
        .map((k) => input.bookIndex.chunks.find((c) => c.key === k)?.page)
        .filter((p): p is number => p != null),
    ),
  ].sort((a, b) => a - b)

  return {
    question: input.question,
    sSize: table.entries.length,
    sNote: table.note,
    sq: picked.selected.map((e) => e.surface),
    hitCount: hits.length,
    bagCount: bags.length,
    predictedBookKeys,
    predictedPages,
    mintables: decided.mintables,
    bagsPreview: bags.slice(0, 12).map((b) => ({
      bagId: b.bagId,
      bookKey: b.bookKey,
      page: b.page,
      hit: b.hit.surface,
      neighbors: b.neighbors,
    })),
    promptTokens,
    completionTokens,
    notes,
    note: `名词表路径 · S_q×${picked.selected.length} · hit×${hits.length} · bag×${bags.length} · 过闸门×${predictedBookKeys.length}`,
  }
}
