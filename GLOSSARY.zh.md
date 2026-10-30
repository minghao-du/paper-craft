# Paper Craft

[English](GLOSSARY.md)

研究组织与 agent 工作流术语。

## 术语

**Project（研究项目）**：
将相关仓库归为一组的研究项目。Project 与 Fleet 不同。
_避免_：将 Fleet 用作 Project 的同义词

**Fleet（工作流集群）**：
由配置定义的资源与协调边界，包含 Run 和工作目录池。每个 Run 拥有自己的 Orchestrator。保留对旧版 Conductor 工作流的支持；在并发所有权可用之前，初始 Run 入口仍保持 Fleet 级互斥。
_避免_：将 Project 用作 Fleet 的同义词

**Run**：
一次请求的 Issue 或 EPIC 工作流，使用固定提供方并拥有独立的 Orchestrator。

**Orchestrator**：
Run 的调度代理，通过 Managed Runtime 启动和检查。迁移期间保留兼容的 Conductor 入口。
