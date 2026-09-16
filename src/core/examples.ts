/**
 * 示例用法：端到端测试流程
 */

import { buildPureTextTable } from './pureTextTable.ts'
import { runFullPipeline, recallByNouns, exportPipelineDebugInfo } from './pipeline.ts'
import {
  createMockLLMProvider,
  createS1Extractor,
  createMergeReviewer,
  createOpenAIProvider,
  createAnthropicProvider,
} from './llmAdapter.ts'

/**
 * 示例1：使用Mock LLM测试基础流程
 */
export async function exampleBasicFlow() {
  // 1. 准备测试数据
  const testBook = {
    id: 'test-book-1',
    title: '人工智能简史',
    author: '张三',
    content: `
      人工智能（Artificial Intelligence，AI）是计算机科学的一个分支。
      机器学习是人工智能的核心技术之一。深度学习又是机器学习的重要分支。
      神经网络模型在图像识别、自然语言处理等领域取得了突破性进展。
      卷积神经网络（CNN）特别适合处理图像数据。循环神经网络（RNN）则擅长序列数据。
      Transformer架构彻底改变了自然语言处理领域。BERT、GPT等预训练模型成为主流。
    `,
    note: '测试书籍',
  }

  // 2. 构建纯文表
  const pureTextTable = buildPureTextTable([testBook])
  console.log('纯文表:', pureTextTable.note)

  // 3. 配置LLM（使用Mock）
  const mockLLM = createMockLLMProvider()
  const llmExtractor = createS1Extractor(mockLLM)
  const mergeReviewer = createMergeReviewer(mockLLM)

  // 4. 运行完整流程（跳过LLM步骤，仅测试s0规则）
  const result = await runFullPipeline(pureTextTable, {
    llmExtractor,
    mergeReviewer,
    concurrency: 3,
    skipS1: true, // 跳过s1补缺
    skipMerge: true, // 跳过合并审查
  })

  console.log('流程摘要:', result.summary)

  // 5. 导出调试信息
  const debugInfo = exportPipelineDebugInfo(result)
  console.log('s0名词数:', debugInfo.s0Nouns.length)
  console.log('终词数:', debugInfo.finalNouns.length)
  console.log('拓扑链数:', debugInfo.topologyChainSample.length)

  // 6. 测试召回
  const queryNouns = ['人工智能', '机器学习', '深度学习']
  const recallResult = recallByNouns(
    result.topologyTable,
    result.finalTable,
    queryNouns,
  )
  console.log('召回结果:', recallResult.note)
  console.log('召回片段数:', recallResult.snippets.length)

  return { result, recallResult, debugInfo }
}

/**
 * 示例2：使用真实LLM（OpenAI）的完整流程
 */
export async function exampleWithRealLLM(apiKey: string) {
  const testBook = {
    id: 'real-book-1',
    title: 'Deep Learning Book',
    author: 'Ian Goodfellow',
    content: `
      Deep learning is part of a broader family of machine learning methods based on artificial neural networks.
      Convolutional neural networks (CNNs) have been particularly successful in image recognition tasks.
      Recurrent neural networks (RNNs) are designed to work with sequential data.
      The Transformer architecture introduced the attention mechanism, which revolutionized natural language processing.
      Models like BERT and GPT-3 have achieved state-of-the-art performance on various NLP benchmarks.
    `,
    note: 'Real test book',
  }

  // 1. 构建纯文表
  const pureTextTable = buildPureTextTable([testBook])

  // 2. 配置真实LLM
  const openaiProvider = createOpenAIProvider({
    apiKey,
    model: 'gpt-4',
  })
  const llmExtractor = createS1Extractor(openaiProvider)
  const mergeReviewer = createMergeReviewer(openaiProvider)

  // 3. 运行完整流程（包含LLM）
  const result = await runFullPipeline(pureTextTable, {
    llmExtractor,
    mergeReviewer,
    concurrency: 3,
    skipS1: false, // 启用s1补缺
    skipMerge: false, // 启用合并审查
  })

  console.log('完整流程摘要:', result.summary)

  // 4. 导出详细结果
  const debugInfo = exportPipelineDebugInfo(result)
  return { result, debugInfo }
}

/**
 * 示例3：使用Anthropic Claude
 */
export async function exampleWithClaude(apiKey: string) {
  const testBook = {
    id: 'claude-test-1',
    title: '量子计算导论',
    author: '李四',
    content: `
      量子计算是利用量子力学原理进行信息处理的新型计算模式。
      量子比特（qubit）是量子计算的基本单位，与经典比特不同，它可以处于叠加态。
      量子纠缠是量子计算的核心资源之一。量子算法如Shor算法和Grover算法展示了量子优势。
      量子退火技术被用于解决优化问题。量子模拟可以帮助研究复杂物理系统。
    `,
    note: 'Claude测试书籍',
  }

  const pureTextTable = buildPureTextTable([testBook])

  const claudeProvider = createAnthropicProvider({
    apiKey,
    model: 'claude-3-5-sonnet-20241022',
  })
  const llmExtractor = createS1Extractor(claudeProvider)
  const mergeReviewer = createMergeReviewer(claudeProvider)

  const result = await runFullPipeline(pureTextTable, {
    llmExtractor,
    mergeReviewer,
    concurrency: 3,
  })

  return { result, debugInfo: exportPipelineDebugInfo(result) }
}

/**
 * 示例4：批量处理多本书
 */
export async function exampleBatchBooks(apiKey: string) {
  const books = [
    {
      id: 'book-1',
      title: '深度学习',
      content: '...',
    },
    {
      id: 'book-2',
      title: '机器学习实战',
      content: '...',
    },
    {
      id: 'book-3',
      title: '自然语言处理',
      content: '...',
    },
  ]

  const pureTextTable = buildPureTextTable(books as any)

  const provider = createOpenAIProvider({ apiKey })
  const result = await runFullPipeline(pureTextTable, {
    llmExtractor: createS1Extractor(provider),
    mergeReviewer: createMergeReviewer(provider),
    concurrency: 5,
  })

  // 按书籍ID查询拓扑链
  const bookNounsMap = new Map<string, string[]>()
  for (const entry of result.finalTable.entries) {
    // 这里需要根据offset反查书籍ID（需要扩展pureTextTable结构）
    // 简化示例，暂不实现
  }

  return result
}

/**
 * 主入口：运行所有示例
 */
export async function runExamples() {
  console.log('=== 示例1: 基础流程（Mock LLM）===')
  const example1 = await exampleBasicFlow()
  console.log('✓ 基础流程完成\n')

  // 如果有API密钥，运行真实LLM示例
  const openaiKey = process.env.OPENAI_API_KEY
  const claudeKey = process.env.ANTHROPIC_API_KEY

  if (openaiKey) {
    console.log('=== 示例2: 真实LLM（OpenAI）===')
    const example2 = await exampleWithRealLLM(openaiKey)
    console.log('✓ OpenAI流程完成\n')
  }

  if (claudeKey) {
    console.log('=== 示例3: Claude流程 ===')
    const example3 = await exampleWithClaude(claudeKey)
    console.log('✓ Claude流程完成\n')
  }

  return example1
}
