/** Port of src/arch/prospectRelevance.ts */

export const MIN_PROSPECT_RELEVANCE = 3

export function normalizeRelevance(raw: unknown): number | null {
  if (raw == null || raw === '') return null
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim())
  if (!Number.isFinite(n)) return null
  if (n > 0 && n <= 1) return Math.max(1, Math.min(5, Math.round(n * 5)))
  return Math.max(1, Math.min(5, Math.round(n)))
}

export function relevanceAllowsInfer(
  relevance: number | null | undefined,
): boolean {
  const r = relevance == null ? MIN_PROSPECT_RELEVANCE : relevance
  return r >= MIN_PROSPECT_RELEVANCE
}
