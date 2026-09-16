# 名词表找材料 · 设计契约（评测仓副本）

主仓讨论共识摘要。实现尚未接入本 eval 的 `--strategy`；当前 CLI 测的是 **既有 decide（qCore+分批）** 基线。

## 热路径（目标）

```
建库: 规则抽 S₀ → 遮盖残文 →（可选）LLM 补 S₁ → 去重 S
每问: 勾选 S_q → 字符串定位 → 命中点±n 异名词拓扑袋 → decide 闸段落 → infer
```

- 去重：同形（忽略大小写）一条；过长分批勾选
- 不跑 toc_nav；TOC 非检索必需
- 与主流 RAG 差在召回精度

详见会话 canvas：`noun-table-retrieve-pipeline.canvas.tsx`
