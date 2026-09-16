/**
 * Port of src/arch/qCoreBookHits.ts — imports rewritten for this harness.
 */

import {
  atomSearchText,
  isRetrievableAtom,
  orderedRetrievableBookKeys,
  tokenizeQuery,
} from './text.ts'
import type { BookIndex } from './types.ts'

const CJK_ALIASES: Record<string, string[]> = {
  拉康: ['lacan', 'lacanien', 'lacanienne'],
  弗洛伊德: ['freud', 'freudien', 'freudienne'],
  荣格: ['jung', 'jungien'],
  德勒兹: ['deleuze'],
  瓜塔里: ['guattari'],
  加塔利: ['guattari'],
  马克思: ['marx', 'marxiste'],
  黑格尔: ['hegel', 'hégel'],
  尼采: ['nietzsche'],
  萨特: ['sartre'],
  福柯: ['foucault'],
}

const Q_NOISE = new Set([
  '如何',
  '什么',
  '怎么',
  '怎样',
  '批判',
  '批评',
  '理解',
  '意思',
  '是否',
  '提到',
  '的呢',
  '呢',
  '吗',
  '啊',
  '呀',
  '吧',
])

export function qCoreNeedles(question: string): string[] {
  const q = question.trim()
  if (!q) return []
  const out = new Set<string>()

  const names = Object.keys(CJK_ALIASES).sort((a, b) => b.length - a.length)
  for (const name of names) {
    if (q.includes(name)) {
      out.add(name)
      for (const a of CJK_ALIASES[name] ?? []) out.add(a)
    }
  }

  const cjkRuns = q.match(/[\u4e00-\u9fff]{2,8}/g) ?? []
  for (const run of cjkRuns) {
    if (Q_NOISE.has(run)) continue
    if ([...out].some((n) => /[\u4e00-\u9fff]/.test(n) && run.includes(n))) {
      continue
    }
    let hasNoise = false
    for (const noise of Q_NOISE) {
      if (run.includes(noise)) {
        hasNoise = true
        break
      }
    }
    if (hasNoise) continue
    if (run.length >= 2 && run.length <= 6) out.add(run)
  }

  for (const t of tokenizeQuery(q)) {
    if (/^[a-z]{4,}$/i.test(t)) out.add(t.toLowerCase())
  }

  for (const noise of Q_NOISE) out.delete(noise)
  return [...out].filter((n) => {
    if (/[\u4e00-\u9fff]/.test(n) && n.length > 6) return false
    return true
  })
}

export function textHitsQCore(
  text: string,
  needles: ReadonlyArray<string>,
): boolean {
  const t = text.toLowerCase()
  if (!t.trim() || needles.length === 0) return false
  return needles.some((n) => {
    const needle = n.toLowerCase()
    return needle.length >= 2 && t.includes(needle)
  })
}

export function prioritizeBookKeysByQCore(input: {
  bookKeys: ReadonlyArray<string>
  bookIndex: BookIndex
  question: string
}): { keys: string[]; hitKeys: string[]; needles: string[]; note: string } {
  const needles = qCoreNeedles(input.question)
  if (needles.length === 0 || input.bookKeys.length === 0) {
    return {
      keys: [...input.bookKeys],
      hitKeys: [],
      needles,
      note: '问核优先 · 无 needle / 空队列',
    }
  }
  const hitKeys: string[] = []
  const rest: string[] = []
  for (const k of input.bookKeys) {
    const chunk = input.bookIndex.chunks.find((c) => c.key === k)
    const t = chunk ? atomSearchText(chunk) : ''
    if (textHitsQCore(t, needles)) hitKeys.push(k)
    else rest.push(k)
  }
  return {
    keys: [...hitKeys, ...rest],
    hitKeys,
    needles,
    note:
      `问核优先 · needle=[${needles.slice(0, 8).join(',')}]` +
      ` · 命中×${hitKeys.length}/${input.bookKeys.length}`,
  }
}

export function bookKeysHittingQCore(input: {
  bookIndex: BookIndex
  question: string
  allowedKeys?: ReadonlySet<string> | null
  maxKeys?: number
}): { keys: string[]; needles: string[]; note: string } {
  const needles = qCoreNeedles(input.question)
  if (needles.length === 0) {
    return { keys: [], needles, note: '问核词面 · 无专名 needle' }
  }
  const maxKeys = input.maxKeys ?? 24
  const hit = new Set<string>()
  for (const c of input.bookIndex.chunks) {
    if (input.allowedKeys && !input.allowedKeys.has(c.key)) continue
    if (!isRetrievableAtom(c)) continue
    if (!textHitsQCore(atomSearchText(c), needles)) continue
    hit.add(c.key)
  }
  const keys = orderedRetrievableBookKeys(input.bookIndex)
    .filter((k) => hit.has(k))
    .slice(0, maxKeys)
  return {
    keys,
    needles,
    note:
      `问核词面 · needle=[${needles.slice(0, 8).join(',')}]` +
      ` · 命中×${keys.length}` +
      (input.allowedKeys ? '（走廊内）' : '（全书）'),
  }
}
