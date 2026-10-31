# paper-craft 设计决策

[English](DESIGN.md)

paper-craft 的技术架构决策。这些选择承载着整个系统——改变它们会产生广泛影响。

## I. JSONL 是唯一事实来源

结构化持久数据保存在 JSONL 文件中（文献、项目、仓库）。项目研究状态是明确的例外：它是仅保存在本地、位于指定研究主目录且不进入 Git 历史的 Markdown（见[研究状态](docs/guides/research-state.md)）。索引是临时产物——通过 `pc rebuild` 从 JSONL 重建。模式变更必须删除索引并重建，绝不使用迁移脚本。

选择 JSONL 是为了便于 Git 合并。

## II. 纯 TypeScript，无原生扩展

`npm run build` 必须能在没有 C/C++ 编译器或平台专用二进制文件的环境中工作。使用纯 JS/TS 依赖（例如 `better-sqlite3` WASM 或等效索引方案）。不使用 `node-gyp`，不使用原生模块。这使安装保持快速且跨平台。

## III. 本地优先，云端可选

核心功能使用本地数据离线运行。外部 API（Semantic Scholar、GitHub、Slack 等）是可选增强。pc 绝不主动向开发方回传信息。

## IV. Nexus 模式

结构化研究数据存于一个由 Git 管理的 nexus 仓库。路径来自 `~/.config/pc/config.yml` → `nexus_path`。nexus 是 Git 仓库——研究数据有版本记录且可共享。工作流状态也可以写入权威 `.epic-config.json` 明确配置的项目目录和克隆池：任务简报、槽位状态、暂停状态和已验证归档。路径按物理位置解析，写入必须保持在这些配置的根目录内。项目研究状态可存于指定的本地研究主目录，由多个仓库与检出目录共享；它不要求备份或同步。其他 pc 数据仍保存在 nexus 或 pc 自身的配置目录中。

## V. 与 Git 兼容的协作

JSONL 格式支持标准 Git 合并工作流。`pc resolve` 处理领域感知的冲突解决（基于 DOI 去重、合并互补元数据）。`pc dedupe` 清理合并后的重复项。设计时应考虑多人向同一个 nexus 推送的情况。

## VI. TypeScript Skill 模块

Skills 以 TypeScript 模块编写——可测试、可调试且类型安全。skill 前缀为 `pc-`。Skill 文档始终是权威依据：行为改变时，必须在同一 PR 中更新 skill 文档。

## VII. 独立于运行时的工作流

工作流逻辑通过 `pc` CLI 背后的 TypeScript、Git 和文件实现。JSON 输出和退出码是所有能读取文件、执行命令的 agent 共用的契约，不依赖模型或运行框架。Fleet 的终端编排可依赖 tmux 作为共享基础设施。agent runner 独立选择：tmux 管理终端会话，runner 提供自身的调用方式、提示输入与重置行为。Claude Code 不是必需的 runner。原生消息传递与 runner 专用会话 API 是可选能力。无需启动终端会话，Git/文件命令仍可使用。每个 Run 拥有唯一的 Orchestrator 调度权限，由恰好一个活跃的受管执行尝试承载。每个受管尝试都属于一个 Run。Fleet 是配置与资源边界，没有调度代理。Run Registry 以确定性规则仲裁资源；提供方在入口固定，之后从 Run 记录读取。受管启动、检查与恢复都要求指定 Run；批量恢复使用同一逐 Run 路径。不提供兼容入口，也不读取旧版运行时记录（见 [ADR 0002](docs/adr/0002-run-scoped-orchestrator.zh.md)）。无法进行占用检查意味着未知，绝不意味着空闲。在占用情况及所有保全、完成检查都得到验证之前，自动回收始终被阻止；可移植 CLI 提供只读证据。

## VIII. 宿主适配器依赖 Core

pnpm 工作区分离 `packages/core`、`packages/cli` 和 `packages/mcp`。Core 暴露领域数据与服务，不包含 Commander、MCP 或模型宿主上下文。CLI 和 MCP 依赖 Core 的公共包导出；Core 绝不导入适配器。宿主专用的注册、响应格式和进程生命周期属于适配器。未来的原生 DeepSeek 插件也遵循同一依赖方向。共享 skills 仍位于仓库根目录。CLI 命令、配置路径和 JSONL 格式是明确的公共契约。
