# decide-design-main 入库指南

[一分钟定位](#一分钟定位) · [沿聊天时间线看灵感](#沿聊天时间线看灵感) · [从代码反查来由](#从代码反查来由) · [走读与维护记录](#走读与维护记录)

## 一分钟定位

这是 9 月 16 日保存的独立名词表选材评测仓。现行 Web/CLI 从问题出发，选出书上应看的段落并打分；同一快照还有用全文偏移表示名词出现位置的两套实验。首次进入时先认清入口，因为三个流程使用的构表模块不同。阅读基线为 [main · 092d464](https://github.com/18926119195/decide-design-main/commit/092d4646a083d21aa5eef0f44f43a0187512c349)。

## 沿聊天时间线看灵感

**如何读状态。** 已实现表示在所列版本找到与灵感相符的代码路径。部分实现表示已有其中一段。未实现表示已查的入口尚无对应实现。证据不足时标待确认。归档与设计文稿按资料本身的状态描述。

会话采用北京时间。[9 月 13 日 Markdown 导出](docs/chat-export/decide-design-chat-29c55109.md)有逐轮时间。[9 月 14 日聊天](9.14的聊天记录)按会话行号查。9 月 16 日是代码快照日期。

| 编号与聊天原件 | 当时提出的思路 | 当前状态与代码证据 |
| --- | --- | --- |
| <a name="idea-i01"></a>I01 · 9 月 13 日 10:23–10:36，[会话 6–9](https://github.com/18926119195/decide-design-main/blob/092d4646a083d21aa5eef0f44f43a0187512c349/docs/chat-export/decide-design-chat-29c55109.md?plain=1#L64-L177) | 规则抽词、残文可选补词、同形去重、真实位置和邻词依次服务选材。 | **已实现于现行评测。** Web 和 CLI 调用同一个材料选择器，生成预测 bookKey。 [材料选择器](src/harness/runNounTableMaterial.ts) · [CLI](scripts/eval-decide.ts#L64-L101) |
| <a name="idea-i02"></a>I02 · 9 月 13 日 16:13，[会话 40](https://github.com/18926119195/decide-design-main/blob/092d4646a083d21aa5eef0f44f43a0187512c349/docs/chat-export/decide-design-chat-29c55109.md?plain=1#L669-L675) | 把准度试验抽成独立项目。 | **已实现。** 评测脚本用人工题单比较预测书块和预测页，本仓不用启动 Docuverse 应用。 [入口配置](package.json) · [评分](src/harness/score.ts) |
| <a name="idea-i03"></a>I03 · 9 月 14 日，[分批 L422](9.14的聊天记录#L422-L429) | 两个 S₀ 遮罩定一组，组间并行，长组内部顺序补缺。 | **未落地到现行评测。** 监督器按残文批循环；另有递归补缺模块，但两种流程的切分和驱动方式不同。 [监督循环](src/harness/superviseS0S1.ts#L228-L304) · [递归模块](src/core/nounS1Fill.ts) |
| <a name="idea-i04"></a>I04 · 9 月 14 日，[L2170–2176](9.14的聊天记录#L2170-L2176) | 集中导出构表质量，让人和 AI 能比较前后。 | **已实现导出。** Web 有监督和评测监视报告，记录足够追到输入和构表摘要。 [监督入口](src/server/main.ts#L219-L305) · [监视报告](src/harness/buildMonitorExport.ts) |
| <a name="idea-i05"></a>I05 · 9 月 16 日，[相邻归纳版本 L1–74](https://github.com/18926119195/decide-design-v2/blob/e61d9de9ef27b838b94a2102db449a40d162feec/%E8%81%8A%E5%A4%A9%E5%BD%92%E7%BA%B3#L1-L74) · [本库代码快照](https://github.com/18926119195/decide-design-main/commit/8c4f556) | 用词在纯文中的位置解释残文和后续段落。本库这个快照未保存后来的《聊天归纳》，同日的相邻快照保留了讨论原件。 | **部分实现。** 独立实验能将全书文字放到同一偏移坐标、抽取 S₀ 和召回段落。第二套递归编排源码存在，且缺少被导入的 `src/core/batchUtil.ts`，未接入 CLI、Web 或 `test:full`。 [纯文及偏移](src/core/pureTextTable.ts) · [实验命令](scripts/test-complete-pipeline.ts) · [递归编排](src/core/pipeline.ts) |

HEAD 的 [PowerShell 提交](https://github.com/18926119195/decide-design-main/commit/092d4646a083d21aa5eef0f44f43a0187512c349) 改的是 Git/gh 路径处理。与 [decide-design-v2 的当时快照](https://github.com/18926119195/decide-design-v2/commit/e61d9de9ef27b838b94a2102db449a40d162feec) 比较，后者比本快照多的是《聊天归纳》一个文件。

## 从代码反查来由

- [Web](src/server/main.ts) 与 [材料选择器](src/harness/runNounTableMaterial.ts) 回看 [I01](#idea-i01)、[I04](#idea-i04)，入口是一问一选材或构表监督。
- [CLI](scripts/eval-decide.ts) → [score](src/harness/score.ts) 回看 [I02](#idea-i02)。输入题单的页和书块 key 是人工标注。
- [pureTextTable](src/core/pureTextTable.ts) → [nounS0](src/core/nounS0.ts) → [recallParagraphs](src/core/recallParagraphs.ts) 回看 [I05](#idea-i05) 的段落实验。另查 [pipeline](src/core/pipeline.ts) 理解 [I03](#idea-i03)/[I05](#idea-i05) 的递归版本。[早期实验说明](README-NEW-PIPELINE.md)

## 走读与维护记录

第一次查“一个词怎样连回书页”，打开 [夹具](scripts/test-s0-only.ts) 找用 `slice(start,end)` 还原词面的断言，再回看 [I05](#idea-i05)。要查看输出时可运行 `npm run test:s0`。Node 24 下 `smoke`、`test:s0` 通过，短样例输出 0 段；预建 `output/` 并指定 126 字合成语料后，`test:full` 的一条题召回 1 段，另外两条无匹配。默认路径的语料文件未随仓提供，真实模型与 PowerShell 发布未试。修改指南时保留编号与原件，再贴上能够复查的调用、版本和实测。

**指南如何更新。** 以仓库和版本划定范围，从聊天提取原始目标，再用代码与产物校正对当时决策的理解。新证据出现时，回到原编号修订记录。这种读法借鉴了钱学森的系统工程和工程控制论。 [《组织管理的技术——系统工程》](https://doi.org/10.13255/j.cnki.jusst.2011.06.020) · [《工程控制论》](https://openlibrary.org/books/OL49218199M/Engineering_cybernetics)
