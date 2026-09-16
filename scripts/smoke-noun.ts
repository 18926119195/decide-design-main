/**
 * Offline smoke: noun table build + locate + topo (no LLM).
 */
import { buildNounTable, locateNounHits, buildTopoBags } from '../src/core/bookNounIndex.ts'
import type { BookIndex } from '../src/core/types.ts'

const bookIndex: BookIndex = {
  docId: 'smoke-doc',
  chunks: [
    {
      ord: 0,
      id: 'c0',
      page: 1,
      bbox: [0, 0, 10, 10],
      key: 'h1.smoke.p1.0',
      kind: 'text',
      faces: { text: { content: '拉康与弗洛伊德在精神分析史上的交锋。Lacan critique of Freud.' } },
      content: '拉康与弗洛伊德在精神分析史上的交锋。Lacan critique of Freud.',
    },
    {
      ord: 1,
      id: 'c1',
      page: 2,
      bbox: [0, 0, 10, 10],
      key: 'h1.smoke.p2.0',
      kind: 'text',
      faces: {
        text: {
          content:
            '本章讨论气候与农业。与精神分析无关的填充文本用于噪声。',
        },
      },
      content: '本章讨论气候与农业。与精神分析无关的填充文本用于噪声。',
    },
  ],
}

const { entries, byId, note } = buildNounTable(bookIndex)
console.log(note)
console.log(
  'sample',
  entries.slice(0, 15).map((e) => `${e.surface}:${e.df}`),
)

const lacan = entries.filter((e) => /lacan|拉康|freud|弗洛伊德/i.test(e.surface))
if (lacan.length === 0) {
  console.error('FAIL: expected Lacan/Freud in S')
  process.exit(1)
}

const hits = locateNounHits({ bookIndex, nouns: lacan, maxHitsPerNoun: 20 })
console.log('hits', hits.length, hits.map((h) => `${h.surface}@p${h.page}`))
if (hits.length === 0) {
  console.error('FAIL: no hits')
  process.exit(1)
}

const bags = buildTopoBags({
  bookIndex,
  nounById: byId,
  hits,
  neighborN: 3,
  maxBags: 20,
})
console.log(
  'bags',
  bags.map((b) => ({
    hit: b.hit.surface,
    neighbors: b.neighbors,
    page: b.page,
  })),
)
if (bags.length === 0) {
  console.error('FAIL: no bags')
  process.exit(1)
}
console.log('SMOKE OK')
