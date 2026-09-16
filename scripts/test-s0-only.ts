/**
 * 离线测试：纯文表 + s0 规则名词表（无 LLM 依赖）
 * 目的：验证 s0 名词抽取质量，作为落地前的第一道检验
 */
import { buildPureTextTable } from '../src/core/pureTextTable.ts'
import { buildNounS0Table } from '../src/core/nounS0.ts'
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
      faces: {
        text: {
          content:
            '拉康与弗洛伊德在精神分析史上的交锋。Lacan critique of Freud.\n\n拉康提出镜像阶段理论，弗洛伊德强调无意识与本我。',
        },
      },
      content:
        '拉康与弗洛伊德在精神分析史上的交锋。Lacan critique of Freud.\n\n拉康提出镜像阶段理论，弗洛伊德强调无意识与本我。',
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
          content: '本章讨论气候与农业。与精神分析无关的填充文本用于噪声测试，气候变化影响农业产量。',
        },
      },
      content: '本章讨论气候与农业。与精神分析无关的填充文本用于噪声测试，气候变化影响农业产量。',
    },
  ],
}

console.log('=== Step 1: 构建纯文表 ===')
const pureTextTable = buildPureTextTable(bookIndex)
console.log(pureTextTable.note)
console.log('段落数:', pureTextTable.paragraphs.length)
for (const p of pureTextTable.paragraphs) {
  console.log(`  [${p.index}] p${p.page} · ${p.text.slice(0, 40)}...`)
}

console.log('\n=== Step 2: 构建 s0 规则名词表 ===')
const s0Table = buildNounS0Table(pureTextTable)
console.log(s0Table.note)
console.log(
  '词表:',
  s0Table.entries.map((e) => `${e.surface}(df=${e.df})`),
)

const lacan = s0Table.entries.filter((e) => /lacan|拉康|freud|弗洛伊德/i.test(e.surface))
if (lacan.length === 0) {
  console.error('FAIL: expected Lacan/Freud in s0')
  process.exit(1)
}
console.log('\n命中 Lacan/Freud 相关词:', lacan.map((e) => e.surface))

// 验证偏移量正确性：抽取的文本切片应等于 surface
let offsetErrors = 0
for (const entry of s0Table.entries) {
  for (const off of entry.offsets) {
    const slice = pureTextTable.fullText.slice(off.start, off.end)
    if (slice.toLowerCase() !== entry.id && slice.toLowerCase() !== entry.surface.toLowerCase()) {
      console.error(`FAIL: 偏移不匹配 entry=${entry.surface} slice="${slice}"`)
      offsetErrors++
    }
  }
}
if (offsetErrors > 0) {
  console.error(`FAIL: ${offsetErrors} 个偏移量错误`)
  process.exit(1)
}

console.log('\nSMOKE OK: s0 名词表 + 偏移量全部验证通过')
