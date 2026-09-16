import type { AChunk } from './types.ts'

/** Port of hybridRetrieve.atomSearchText / isRetrievableAtom / tokenizeQuery */
export function atomSearchText(input: {
  kind: string
  content: string
  faces: {
    text?: { content: string }
    fig?: { note: string; figId?: string }
  }
}): string {
  const text = input.faces.text?.content?.trim()
  if (text && text.length >= 8) return text
  const raw = input.content.trim()
  if (raw && !raw.startsWith('[FIG:') && raw.length >= 8) return raw
  if (text) return text
  const note = input.faces.fig?.note?.trim() ?? ''
  return note
    .replace(/请依据可见版面回答[^。]*。?/g, '')
    .replace(/勿编造未提供的文字[^。]*。?/g, '')
    .replace(/无文字层\/未OCR[^。]*。?/g, '')
    .trim()
}

export function tokenizeQuery(text: string): string[] {
  const norm = text.toLowerCase().replace(/\s+/g, ' ').trim()
  if (!norm) return []
  const out: string[] = []
  const latin = norm.match(/[a-z0-9]{2,}/g)
  if (latin) out.push(...latin)
  const cjk = norm.replace(/[a-z0-9\s.,;:!?'"()[\]{}<>/\\|_+=\-@#$%^&*`~]+/g, '')
  for (let i = 0; i < cjk.length; i++) {
    out.push(cjk[i]!)
    if (i + 1 < cjk.length) out.push(cjk.slice(i, i + 2))
  }
  return out
}

export function isRetrievableAtom(input: {
  kind: string
  content: string
  faces: {
    text?: { content: string }
    fig?: { note: string }
  }
}): boolean {
  const t = atomSearchText(input)
  if (t.length < 4) return false
  if (input.kind === 'fig' && t.length < 24 && !input.faces.text) return false
  return true
}

export function chunkT(chunk: AChunk): string {
  return atomSearchText(chunk)
}

export function orderedRetrievableBookKeys(
  bookIndex: { chunks: AChunk[] },
): string[] {
  return [...bookIndex.chunks]
    .filter((c) => isRetrievableAtom(c))
    .sort((a, b) => a.page - b.page || a.ord - b.ord)
    .map((c) => c.key)
}
