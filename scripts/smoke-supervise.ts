/**
 * Offline smoke: complete-noun U build + LLM-hit verify gate (no LLM call).
 */
import { buildCompleteNounUniverse } from '../src/harness/superviseS0S1.ts'
import { loadLlmConfigFromEnv } from '../src/harness/llm.ts'
import type { BookIndex } from '../src/core/types.ts'

const bookIndex: BookIndex = {
  docId: 'sup-smoke',
  chunks: [
    {
      ord: 0,
      id: 'c0',
      page: 1,
      bbox: [0, 0, 10, 10],
      key: 'h1.smoke.p1.0',
      kind: 'text',
      faces: {
        text: {
          content: 'Lacan and Freud met Guattari in Paris. Desire and machine.',
        },
      },
      content: 'Lacan and Freud met Guattari in Paris. Desire and machine.',
    },
  ],
}

const report = await buildCompleteNounUniverse({
  bookIndex,
  corpus: { label: 'smoke', docId: 'sup-smoke', chunks: 1 },
  llm: loadLlmConfigFromEnv(),
  residualLlm: false,
})

console.log(report.verdict)
console.log(
  'closed',
  report.closure.closed,
  'llmOk',
  report.llmHitVerify.ok,
  'U',
  report.U.size,
)
if (!report.llmHitVerify.ok || report.version !== 4) {
  console.error('COMPLETE-NOUN SMOKE FAIL')
  process.exit(1)
}
console.log('COMPLETE-NOUN SMOKE OK')
