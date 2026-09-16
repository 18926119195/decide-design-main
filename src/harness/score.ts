import type { BookIndex } from '../core/types.ts'
import { pageOfKey, type EvalCase } from './loadCorpus.ts'

export type MaterialPred = {
  predictedBookKeys: string[]
}

export type CaseScore = {
  id: string
  /** false when gold empty — do not fold into hitRate */
  scored: boolean
  hit: boolean
  precision: number
  recall: number
  predictedPages: number[]
  goldPages: number[]
  predictedBookKeys: string[]
  goldBookKeys: string[]
  scoreNote: string
}

function resolveGold(input: {
  bookIndex: BookIndex
  c: EvalCase
}): { keys: Set<string>; pages: Set<number> } {
  const keys = new Set<string>(input.c.goldBookKeys ?? [])
  const pages = new Set<number>(input.c.goldPages ?? [])
  for (const k of keys) {
    const p = pageOfKey(input.bookIndex, k)
    if (p != null) pages.add(p)
  }
  if (keys.size === 0 && pages.size > 0) {
    for (const c of input.bookIndex.chunks) {
      if (pages.has(c.page)) keys.add(c.key)
    }
  }
  return { keys, pages }
}

export function scoreCase(input: {
  bookIndex: BookIndex
  evalCase: EvalCase
  predictedBookKeys: string[]
}): CaseScore {
  const gold = resolveGold({ bookIndex: input.bookIndex, c: input.evalCase })
  const predKeys = new Set(input.predictedBookKeys)
  const predPages = new Set<number>()
  for (const k of predKeys) {
    const p = pageOfKey(input.bookIndex, k)
    if (p != null) predPages.add(p)
  }

  const goldEmpty = gold.pages.size === 0 && gold.keys.size === 0
  if (goldEmpty) {
    return {
      id: input.evalCase.id,
      scored: false,
      hit: false,
      precision: 0,
      recall: 0,
      predictedPages: [...predPages].sort((a, b) => a - b),
      goldPages: [],
      predictedBookKeys: [...predKeys],
      goldBookKeys: [],
      scoreNote: '未计分：gold 为空（请填 goldPages 或用监控包 suggestedGoldPages）',
    }
  }

  const mode = input.evalCase.goldMode ?? 'any'
  let hit = false
  if (gold.pages.size > 0) {
    const inter = [...gold.pages].filter((p) => predPages.has(p))
    hit = mode === 'all' ? inter.length === gold.pages.size : inter.length > 0
  } else if (gold.keys.size > 0) {
    const inter = [...gold.keys].filter((k) => predKeys.has(k))
    hit = mode === 'all' ? inter.length === gold.keys.size : inter.length > 0
  }

  const tp = [...predKeys].filter((k) => gold.keys.has(k)).length
  const precision = predKeys.size === 0 ? 0 : tp / predKeys.size
  const recall = gold.keys.size === 0 ? (hit ? 1 : 0) : tp / gold.keys.size

  return {
    id: input.evalCase.id,
    scored: true,
    hit,
    precision,
    recall,
    predictedPages: [...predPages].sort((a, b) => a - b),
    goldPages: [...gold.pages].sort((a, b) => a - b),
    predictedBookKeys: [...predKeys],
    goldBookKeys: [...gold.keys],
    scoreNote: hit ? '命中 gold' : '未命中 gold',
  }
}

export function aggregateScores(scores: CaseScore[]): {
  n: number
  scoredN: number
  unscoredN: number
  hitRate: number | null
  meanPrecision: number | null
  meanRecall: number | null
} {
  const scored = scores.filter((s) => s.scored)
  const n = scored.length
  if (n === 0) {
    return {
      n: scores.length,
      scoredN: 0,
      unscoredN: scores.length,
      hitRate: null,
      meanPrecision: null,
      meanRecall: null,
    }
  }
  return {
    n: scores.length,
    scoredN: n,
    unscoredN: scores.length - n,
    hitRate: scored.filter((s) => s.hit).length / n,
    meanPrecision: scored.reduce((a, s) => a + s.precision, 0) / n,
    meanRecall: scored.reduce((a, s) => a + s.recall, 0) / n,
  }
}
