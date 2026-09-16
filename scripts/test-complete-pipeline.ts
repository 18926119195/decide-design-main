/**
 * 完整流程测试：纯文表 -> s0 -> s1 -> 召回段落
 * 目标：验证完整的名词表构建和段落召回流程
 */

import { writeFileSync } from 'node:fs'
import { loadCorpusPack } from '../src/harness/loadCorpus.ts'
import { buildPureTextTable } from '../src/core/pureTextTable.ts'
import { buildNounS0Table } from '../src/core/nounS0.ts'
import {
  buildNounS1Prompt,
  parseNounS1Response,
  buildNounS1Table,
} from '../src/core/nounS1.ts'
import { recallParagraphs, formatRecallResult } from '../src/core/recallParagraphs.ts'
import { loadLlmConfigFromEnv, chatCompletions } from '../src/harness/llm.ts'

const CORPUS_PATH = process.env.CORPUS_PATH || './corpus/example.json'
const OUTPUT_DIR = './output'

async function main() {
  console.log('=== 完整流程测试开始 ===\n')

  // 1. 加载语料
  console.log('步骤 1: 加载语料包')
  const pack = loadCorpusPack(CORPUS_PATH)
  console.log(`语料：${pack.label} (${pack.docId})`)
  console.log(`chunks: ${pack.bookIndex.chunks.length}\n`)

  // 2. 构建纯文表
  console.log('步骤 2: 构建纯文表')
  const pureTextTable = buildPureTextTable(pack.bookIndex)
  console.log(pureTextTable.note)
  console.log(`段落数: ${pureTextTable.paragraphs.length}`)
  console.log(`文本总长: ${pureTextTable.fullText.length} 字符\n`)

  // 3. 构建 s0 规则名词表
  console.log('步骤 3: 构建 s0 规则名词表')
  const nounS0Table = buildNounS0Table(pureTextTable)
  console.log(nounS0Table.note)
  console.log(`前 20 个高频名词:`)
  for (let i = 0; i < Math.min(20, nounS0Table.entries.length); i++) {
    const e = nounS0Table.entries[i]
    console.log(`  ${i + 1}. ${e.surface} (df=${e.df}, 偏移×${e.offsets.length})`)
  }
  console.log()

  // 导出 s0
  writeFileSync(
    `${OUTPUT_DIR}/s0-nouns.json`,
    JSON.stringify(
      {
        note: nounS0Table.note,
        entries: nounS0Table.entries.slice(0, 200).map((e) => ({
          surface: e.surface,
          df: e.df,
          offsetCount: e.offsets.length,
        })),
      },
      null,
      2,
    ),
  )
  console.log(`已导出 s0 名词表到 ${OUTPUT_DIR}/s0-nouns.json\n`)

  // 4. 构建 s1 LLM 增强名词表
  console.log('步骤 4: 构建 s1 LLM 增强名词表')
  const llmConfig = loadLlmConfigFromEnv()
  
  if (!llmConfig.apiKey.trim()) {
    console.log('未配置 LLM_API_KEY，跳过 s1 构建，使用 s0 作为最终名词表\n')
    
    // 将 s0 转为 s1 格式（用于后续召回）
    const mockS1Table = {
      entries: nounS0Table.entries.map((e) => ({
        id: e.id,
        surface: e.surface,
        fromS0: true,
        fromLlm: false,
        relevance: e.df >= 5 ? 4 : e.df >= 3 ? 3 : 2,
        note: '',
        offsets: e.offsets,
      })),
      byId: new Map(
        nounS0Table.entries.map((e) => [
          e.id,
          {
            id: e.id,
            surface: e.surface,
            fromS0: true,
            fromLlm: false,
            relevance: e.df >= 5 ? 4 : e.df >= 3 ? 3 : 2,
            note: '',
            offsets: e.offsets,
          },
        ]),
      ),
      note: `s1 模拟表（基于 s0）· 词×${nounS0Table.entries.length}`,
    }

    // 5. 测试召回
    console.log('步骤 5: 测试段落召回')
    const testQueries = [
      '拉康和弗洛伊德的关系',
      '精神分析的核心概念',
      '无意识理论',
    ]

    for (const query of testQueries) {
      console.log(`\n查询: "${query}"`)
      const result = recallParagraphs(query, pureTextTable, mockS1Table, {
        topK: 5,
      })
      console.log(result.note)
      
      for (let i = 0; i < Math.min(3, result.paragraphs.length); i++) {
        const para = result.paragraphs[i]
        console.log(
          `  [${i + 1}] 段落#${para.index} · 得分=${para.score.toFixed(2)} · 名词${para.matchedNouns.length}个`,
        )
        console.log(`      ${para.text.slice(0, 100)}...`)
      }

      // 导出召回结果
      const formatted = formatRecallResult(result)
      writeFileSync(
        `${OUTPUT_DIR}/recall-${query.replace(/[^\w\u4e00-\u9fff]/g, '_')}.txt`,
        formatted,
      )
    }

    console.log('\n=== 流程测试完成（无 LLM） ===')
    return
  }

  // 有 LLM，执行完整 s1 构建
  const s1Prompt = buildNounS1Prompt(pureTextTable, nounS0Table)
  console.log('正在调用 LLM 进行名词确认和补充...')
  
  const llmResponse = await chatCompletions({
    config: llmConfig,
    system: '你是专业的文本分析助手，擅长提取和评估文本中的重要概念、实体、术语。',
    user: s1Prompt,
    temperature: 0.3,
    maxTokens: 4096,
  })

  if (!llmResponse.ok) {
    console.error(`LLM 调用失败: ${llmResponse.note}`)
    process.exit(1)
  }

  console.log(`LLM 响应长度: ${llmResponse.content.length} 字符`)
  
  const parsedS1 = parseNounS1Response(llmResponse.content)
  console.log(`LLM 确认名词: ${parsedS1.confirmed.length} 个`)
  console.log(`LLM 新增名词: ${parsedS1.added.length} 个`)

  const nounS1Table = buildNounS1Table(nounS0Table, parsedS1, pureTextTable)
  console.log(nounS1Table.note)
  console.log(`前 20 个高质量名词:`)
  for (let i = 0; i < Math.min(20, nounS1Table.entries.length); i++) {
    const e = nounS1Table.entries[i]
    console.log(
      `  ${i + 1}. ${e.surface} (相关性=${e.relevance ?? '?'}, df=${e.offsets.length}) ${e.note ? `[${e.note}]` : ''}`,
    )
  }
  console.log()

  // 导出 s1
  writeFileSync(
    `${OUTPUT_DIR}/s1-nouns.json`,
    JSON.stringify(
      {
        note: nounS1Table.note,
        entries: nounS1Table.entries.slice(0, 200).map((e) => ({
          surface: e.surface,
          relevance: e.relevance,
          df: e.offsets.length,
          fromS0: e.fromS0,
          fromLlm: e.fromLlm,
          note: e.note,
        })),
      },
      null,
      2,
    ),
  )
  console.log(`已导出 s1 名词表到 ${OUTPUT_DIR}/s1-nouns.json\n`)

  // 5. 测试召回
  console.log('步骤 5: 测试段落召回')
  const testQueries = [
    '拉康和弗洛伊德的关系',
    '精神分析的核心概念',
    '无意识理论',
  ]

  for (const query of testQueries) {
    console.log(`\n查询: "${query}"`)
    const result = recallParagraphs(query, pureTextTable, nounS1Table, {
      topK: 5,
    })
    console.log(result.note)
    
    for (let i = 0; i < Math.min(3, result.paragraphs.length); i++) {
      const para = result.paragraphs[i]
      console.log(
        `  [${i + 1}] 段落#${para.index} · 得分=${para.score.toFixed(2)} · 名词${para.matchedNouns.length}个`,
      )
      console.log(`      ${para.text.slice(0, 100)}...`)
    }

    // 导出召回结果
    const formatted = formatRecallResult(result)
    writeFileSync(
      `${OUTPUT_DIR}/recall-${query.replace(/[^\w\u4e00-\u9fff]/g, '_')}.txt`,
      formatted,
    )
  }

  console.log('\n=== 完整流程测试完成 ===')
}

main().catch((err) => {
  console.error('流程测试失败:', err)
  process.exit(1)
})
