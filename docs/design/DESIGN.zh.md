# paper-craft 设计决策

[English](DESIGN.md)

paper-craft 的技术架构决策。这些选择承载着整个系统——改变它们会产生广泛影响。

## 模块化设计

模块遵循以下原则：

- **正交与低耦合（Orthogonality & Low Coupling）**：尽可能减少模块之间的相互依赖，保持各模块职责独立与正交；避免即使在小接口下仍形成网状纠缠，将单点修改的影响严格限制在模块内部。
- **深模块与高杠杆率（Deep Module & Leverage）**：对外暴露极小的接口表面积（接缝 Seam），在内部封装复杂的实现逻辑与状态；为调用方提供高杠杆率（Leverage），为维护方提供高局部性（Locality），杜绝无实效的浅层透传（Pass-through）。
