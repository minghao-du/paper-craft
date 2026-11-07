# paper-craft 设计决策

[English](DESIGN.md)

paper-craft 的技术架构决策。这些选择承载着整个系统——改变它们会产生广泛影响。

## 模块化设计

模块遵循以下原则：

- **正交与低耦合（Orthogonality & Low Coupling）**：尽可能减少模块之间的相互依赖，保持各模块职责独立与正交；避免即使在小接口下仍形成网状纠缠，将单点修改的影响严格限制在模块内部。
- **深模块与高杠杆率（Deep Module & Leverage）**：对外暴露极小的接口表面积（接缝 Seam），在内部封装复杂的实现逻辑与状态；为调用方提供高杠杆率（Leverage），为维护方提供高局部性（Locality），杜绝无实效的浅层透传（Pass-through）。

## 技能与执行的边界

该架构将专业任务知识与流程策略分离。

- **技能**：教导如何完成一项完整的专业任务。专业技能不知道 workflow 或 orchestrator 的存在，不依赖派发 CLI。允许真正需要的其他技能依赖；不包含派发专用模式或流程路由逻辑。专业技能专注于专业协作，不为每个操作新增一个技能。
- **Orchestrator**：负责步骤顺序、执行者选择、结果关联、失败分支和整体完成判断。它理解失败原因以选择后续工作，但不手动复制发现或组装输入字段。

每次派发都开启新的 agent 对话，包括重复角色和修复尝试。上下文通过明确输入传递，不复用对话。专业 agent 负责领域判断，Orchestrator 负责路由和验收。正常完成的审查可以得出需要修改的结论，正常完成的范围评估也可以发现超出授权的工作。详细证据保存在文件回执中。

技能通过内核脚本与 agent 指令强制执行契约。程序化校验与状态机约束守护着每次派发与回执。运行次数限制、报告修复、范围重新评估和恢复规程由 orchestrator 技能定义。

## 阶段与执行者解耦

工作流阶段将抽象的逻辑任务与具体的执行提供者解耦。工作流状态机跟踪任务进度、状态流转和回执校验，而无需硬编码阶段的具体执行方式。每个阶段通过多态的 provider 规范进行声明：

```yaml
provider:
  type: "skill" | "script"
  target: "<skill-name> | <script-path>"
  args: []
```

两种提供者类型满足该契约：

- **`skill` 提供者**：Orchestrator 通过平台适配器派发自主的 LLM 专业子 agent，加载 `skills/<target>/SKILL.md` 并附带引用任务输入信封的标准精简提示词。
- **`script` 提供者**：Orchestrator 或无头运行器直接通过 CLI 执行确定性内核脚本（`target`），传入 `--input-envelope <path>`，并从标准输出捕获紧凑执行报告。

由于两种提供者路径消费完全相同的任务输入信封并生成完全相同的回执契约，将 `skill` 提供者无缝替换为 `script` 提供者无需修改任何工作流阶段逻辑、路由表或状态持久化机制。

## 任务输入信封

上下文传递完全结构化并基于文件化实现。Orchestrator 从不跨阶段拼接冗长、非结构化的自由文本提示词。在派发任何提供者之前，Orchestrator 将完整的执行上下文固化为 `<receipt_root>/<step_index>-input.json` 处的不可变 JSON 文件。

任务输入信封遵循标准化的 7 块模式（`schema_version: "1.0"`）：

```json
{
  "schema_version": "1.0",
  "task": { "logical_stage": "...", "step_index": 0, "attempt": 1, "root_issue_id": "...", "current_issue_id": "..." },
  "provider": { "type": "skill | script", "target": "...", "args": [] },
  "environment": { "working_directory": "...", "repository": "...", "base_branch": "...", "branch": "...", "commit": "..." },
  "inputs": { "objective": "...", "scope": "...", "acceptance_criteria": [], "predecessor_receipts": [], "parameters": {} },
  "contract": { "receipt_path": "...", "receipt_template": "..." },
  "budgets": { "delivery_attempts_used": 0, "delivery_attempts_max": 3, "replans_used": 0, "replans_max": 2 }
}
```

该协议确立了两项运行不变量：

- **标准精简提示词规范（约 15 行）**：派发 LLM 子 agent 时，提示词仅包含所分配的阶段名称、绝对信封路径、目录绑定指令和紧凑 JSON 返回要求。领域上下文、验收标准、前序回执和预算上限均直接从信封文件中读取，消除了提示词漂移。
- **原子写入与环境隔离**：信封与状态文件在 `<receipt_root>` 内通过临时文件、缓冲区刷新、fsync 和原子替换进行安全写入。`<receipt_root>` 位于可丢弃的 Git worktree 外部，以防止在分支切换或 worktree 修剪期间被意外删除。

## 技能内核化模式

技能通过内核-包装器模式（Kernel-Wrapper Pattern）将确定性的机械操作与认知启发式推理分离开来：

- **确定性内核（`scripts/`）**：重复、不变的程序化逻辑（如 Git worktree 准备、仓库干净度检查、回执生成和信封序列化）封装在 `skills/<skill>/scripts/` 下的自包含 CLI 脚本中。内核消费 `--input-envelope <path>`，确定性地执行，写入 Markdown 回执，并将紧凑 JSON 报告输出至标准输出。
- **认知包装器（`SKILL.md`）**：技能文档作为 LLM 子 agent 的轻量认知接口。它指示子 agent 携带 `--input-envelope` 运行内部内核脚本，检查标准输出，并仅在出现非确定性判断或环境阻碍时应用领域启发式方法或回退恢复规程。

该模式为两种执行模式提供了统一的底层实现。LLM 子 agent 通过将机械执行委托给内部脚本获得高杠杆率，而未来的自动化运行器可以直接调用内核脚本而无需重写核心业务逻辑。

## 统一回执协议

每个执行提供者均通过两个必选通道履行统一回执协议来结束执行：

```json
{
  "execution_status": "succeeded",
  "result": { "outcome": "verified" },
  "receipt_path": "/path/to/receipt.md",
  "summary": "Execution completed successfully"
}
```

该协议强制实行双重报告机制：

- **紧凑执行报告（stdout）**：输出到标准输出的机器可解析 JSON 对象。`execution_status` 严格限定为 `"succeeded"`、`"blocked"` 或 `"failed"`。有效的专业结论（包括返工结论或 `out_of_scope`）均上报 `"succeeded"`，`"blocked"` 仅用于未满足的前置条件，`"failed"` 用于无法恢复的崩溃。`result` 对象包含领域特定的路由结果。
- **持久磁盘回执（Markdown）**：写入 `contract.receipt_path` 并符合 `subagent-receipt.template.md` 规范的完整 Markdown 审计记录。它在可丢弃的检出目录外部记录完整的验证日志、Git 版本、修改产物和前序回执链接。

Orchestrator 校验全部四个报告字段并核验回执文件的物理存在。任何协议违背、无法解析的输出或缺失的回执都会触发快速失败，立即暂停并呈现决策看板，杜绝推测性修复。

## 工作空间归属

Orchestrator 分配环境，决定准备、复用和清理的时机。`pc-workspace` 专业 agent 在专业任务开始前准备并验证 Git 检出目录。每次派发，包括内部子 agent，都提供绝对工作目录及相关仓库、分支和版本信息。平台支持时绑定启动目录。仅支持提示词的适配器要求每条命令显式绑定目录，并在入口核验环境。专业技能使用已准备的工作空间，负责项目依赖、计算环境和数据检查。

实现、审查和合并前返工共用对应的功能 worktree。集成验收使用固定到集成提交的独立检出目录。合并后修复和 pipeline 修改使用新的功能 worktree。研究状态使用唯一固定的共享位置，需要保留的产物具有明确的持久位置。成功完成后，工作空间专业 agent 清理本次创建且符合条件的工作空间，并记录保留路径及原因。中断或失败的任务保留环境。运行时状态保存环境分配、准备回执、归属和清理结果。

## 工作流解耦

工作流定义与技术架构及编排内核完全解耦。具体的执行序列（如 Issue 交付、热修复或重构）作为独立的工作流文件维护在 `skills/pc-orchestrator/workflows/` 下。Orchestrator 内核仅提供纯派发、回执校验与错误恢复机制，不硬编码任何具体的领域交付步骤。
