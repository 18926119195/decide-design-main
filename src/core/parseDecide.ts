/** JSON extract + decide prospect parse (material-eval subset). */

import {
  normalizeRelevance,
  relevanceAllowsInfer,
} from './prospectRelevance.ts'
import {
  expandDoorplatesInJsonValue,
  resolveWindowDoorplate,
  type WindowAliasTable,
} from './windowAlias.ts'

export function extractJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim()
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = (fence?.[1] ?? trimmed).trim()
  const start = body.indexOf('{')
  if (start < 0) return null
  const end = body.lastIndexOf('}')
  if (end <= start) return null
  try {
    const obj = JSON.parse(body.slice(start, end + 1))
    return obj && typeof obj === 'object' ? (obj as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function asStatus(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim().toLowerCase()
  if (s === 'unread' || s === 'sufficient' || s === 'insufficient') return s
  return null
}

export type MintableProspect = {
  bookKey: string
  prospect: string
  status: string
  relevance: number | null
}

export function parseDecideMintables(
  llmText: string,
  aliasTable: WindowAliasTable,
): { mintables: MintableProspect[]; note: string; rawOk: boolean } {
  let obj = extractJsonObject(llmText)
  if (obj) {
    obj = expandDoorplatesInJsonValue(obj, aliasTable) as Record<string, unknown>
  }
  if (!obj) {
    return { mintables: [], note: 'decide 硬闸：无法解析 JSON', rawOk: false }
  }

  const rows: unknown[] = []
  if (Array.isArray(obj.prospects)) rows.push(...obj.prospects)
  if (Array.isArray(obj.keeps)) rows.push(...obj.keeps)

  const statusByKey = new Map<string, string>()
  if (Array.isArray(obj.keyStatuses)) {
    for (const row of obj.keyStatuses) {
      if (!row || typeof row !== 'object') continue
      const r = row as Record<string, unknown>
      const rawKey = String(r.key ?? r.bookKey ?? r.briefKey ?? '')
      const full =
        resolveWindowDoorplate(rawKey, aliasTable) ??
        (aliasTable.fullOf.has(rawKey) ? rawKey : rawKey)
      const st = asStatus(r.status)
      if (full && st) statusByKey.set(full, st)
    }
  }

  const mintables: MintableProspect[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    const rawKey = String(r.bookKey ?? r.briefKey ?? r.key ?? '')
    const bookKey =
      resolveWindowDoorplate(rawKey, aliasTable) ??
      (aliasTable.fullKeys.includes(rawKey) ? rawKey : '')
    if (!bookKey || !aliasTable.fullKeys.includes(bookKey)) continue
    const prospect = String(r.prospect ?? r.prospects ?? '').trim()
    const status =
      asStatus(r.status) ?? statusByKey.get(bookKey) ?? 'insufficient'
    const relevance = normalizeRelevance(r.relevance)
    if (status !== 'sufficient') continue
    if (!prospect) continue
    if (!relevanceAllowsInfer(relevance)) continue
    if (seen.has(bookKey)) continue
    seen.add(bookKey)
    mintables.push({ bookKey, prospect, status, relevance })
  }

  return {
    mintables,
    note: `decide parse · mintable×${mintables.length}`,
    rawOk: true,
  }
}
