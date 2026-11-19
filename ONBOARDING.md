# decide-design-main 入库指南

这是名词表评测的 9 月 16 日快照，同时保留了原 Web/CLI 调用和多套偏移量试验。接手时先确定要维护哪一个入口，再把对应产物和金标登记到实验记录。基线为 [main · 092d464](https://github.com/18926119195/decide-design-main/commit/092d4646a083d21aa5eef0f44f43a0187512c349)。

## 开发沿革与入口

| 时间 | 协作意图 | 可用代码及边界 |
| --- | --- | --- |
| 9 月 13 日的协作记录 | 从名词候选到原文位置和上下文，最终检验选材质量。 [脱敏会话](docs/chat-export/decide-design-chat-29c55109.md) | [Web](src/server/main.ts) 与 [CLI](scripts/eval-decide.ts) 都走 [runNounTableMaterial](src/harness/runNounTableMaterial.ts)。[设计契约](docs/book-noun-pipeline-contract.md) 里的 CLI 描述是旧状态。 |
| 9 月 14 日的协作记录 | 相邻 S₀ 遮罩定分组，区分并行与局部串联，要求便于迭代的监督导出。 [分批原件 L422 与末段](https://github.com/18926119195/decide-design-main/blob/092d4646a083d21aa5eef0f44f43a0187512c349/9.14%E7%9A%84%E8%81%8A%E5%A4%A9%E8%AE%B0%E5%BD%95#L422-L429) | [监督模块](src/harness/superviseS0S1.ts) 有残文和轮次报告。分批契约仍需用相同输入比较监督模块与递归补缺实现。 |
| 9 月 16 日，[初始快照](https://github.com/18926119195/decide-design-main/commit/8c4f556) | 入库时出现以纯文、全局偏移做定位的新实验和独立发布脚本。 | [旧偏移量实验](scripts/test-complete-pipeline.ts) 直接调用 [nounS0](src/core/nounS0.ts)、[nounS1](src/core/nounS1.ts) 和 [recallParagraphs](src/core/recallParagraphs.ts)。[递归构表](src/core/pipeline.ts) 在示例引用中，缺少被导入的 `src/core/batchUtil.ts`。 |
| 9 月 16 日，[PowerShell 修订](https://github.com/18926119195/decide-design-main/commit/092d4646a083d21aa5eef0f44f43a0187512c349) | 支持 Git 和 gh 的非标准安装路径。 | HEAD 只改 [发布脚本](scripts/push-to-github.ps1)，交互、登录和改远程属于发布环节。工程验收使用下列命令。 |

[v2 快照](https://github.com/18926119195/decide-design-v2/commit/e61d9de9ef27b838b94a2102db449a40d162feec) 相对当前基线增加聊天归纳。比较行为前先记录两边的代码提交及测试入口。

## 第一次运行

```sh
npm run smoke
npm run test:s0
mkdir -p output
CORPUS_PATH=/path/to/book.docuverse.json LLM_API_KEY= npm run test:full
```

把 `CORPUS_PATH` 指向实际的非敏感导出。Node 24.22.1 下 smoke 和 S₀ 偏移检查实跑通过。S₀ 内置短样例得到 0 段，因此另用 126 字、单书块的合成包跑过 `test:full`，得到 1 段、“拉康和弗洛伊德的关系”召回 1 段，另两道内置查询没有词命中。干净克隆中默认的 `./corpus/example.json` 缺失，输出目录也需预建。真实模型及 PowerShell 发布行为未实跑。[新实验说明](README-NEW-PIPELINE.md)

## 变更与验收

1. **表的可追溯性**。固定 BookIndex、书块顺序和题单。为短段、重复词、中文标点、跨块起止分别构造用例。记录 `fullText.slice(start,end)`、来源 key 和页码，目标为 0 条不能还原的偏移或未知 key。偏差先定位 [纯文表](src/core/pureTextTable.ts)，再查具体的 S₀ 版本。
2. **建立可运行的实验入口**。先恢复缺失的批处理模块，再向 [pipeline](src/core/pipeline.ts) 传入与签名一致的 BookIndex 所构造的纯文表。将旧的 `test:full` 和新递归流程分别编号。用 Mock 输出记录批次数、失败与停止原因，验收以可独立运行、错误可追溯和偏移零误差为门。
3. **判断是否切换**。基线和候选使用同一语料、gold、模型与预算。报告每题选择的段、key、P/R、模型调用次数和耗时。评测维护者根据主要错例和预先约定的容忍度批准接到 Web/CLI，发布维护者单独评审远程操作。新增退化时退回对应入口版本，保留输入快照与失败报告用于复跑。

## 方法依据

本指南把总体设计落实为边界、目标和任务接口，把工程控制中的反馈落实为观测、判据和纠偏。维护者用原始协作记录、代码和固定样本共同核验定性判断与量化结果，据此决定下一轮行动。[《工程控制论》](https://openlibrary.org/books/OL49218199M/Engineering_cybernetics) · [《组织管理的技术——系统工程》](https://doi.org/10.13255/j.cnki.jusst.2011.06.020) · [《一个科学新领域——开放的复杂巨系统及其方法论》](https://cnki.istiz.org.cn/kcms/detail/detail.aspx?dbcode=CPFD&dbname=cpfd1999&filename=ZGXC199008001001)
