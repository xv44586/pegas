# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

React + TypeScript，Web 客户端只负责呈现和交互；Pegas 的身份、任务、Run、记忆和执行状态由独立服务端维护。未来的 iOS 与 macOS 客户端复用相同的服务端领域模型和 API。

## Users

当前主要用户是长期使用 Pegas 的单个所有者。他会从电脑或手机随时提出问题、任务和不成熟的想法，希望只通过自然对话推动工作。Channel、Worker、模型和执行进程可以按需检查或覆盖，但不能成为开始工作的前置维护负担。

## Product Purpose

Pegas 把随时出现的意图组织成可追踪、可恢复的长期任务，并持续执行、汇报关键进展、请求必要确认。成功意味着用户只需要表达目标，同时始终知道重要事情正在发生什么，并能在需要时深入查看或接管。

## Positioning

Conversation 是统一入口，Task 是服务端持久工作生命周期，WorkChannel 是它的用户可见投影。Pegas 可以在内部创建多个 Run、session 或执行单元，但用户始终面对同一个长期存在的 Pegas；Worker 是范围化工作配置，不是独立顶层人格。

完成只结束当前工作轮次：completed WorkChannel 可以在授权复核后恢复；用户明确停止或授权撤回后，原 WorkChannel 永久不可恢复，继续工作需要新建相关 Channel。Run 和 Worker Runtime 独立结束、替换和回收，不决定 Channel 历史是否存在。

## Operating Context

- 用户可以在同一条对话流中任意插入不同事项。
- 默认界面自然展示 Pegas 的回复，以及嵌入对话的计划、委派、等待和结果。
- 用户可以从左侧 Channel 列表或对话事件进入某件工作的完整记录，查看 Run、状态、日志、产物和协作关系并直接纠偏。
- Outbox 聚合需要确认、阻塞、失败和重要结果，普通 progress 留在 Channel。
- 长任务可以跨进程、设备和部署继续；手机将是未来长期使用和发起代码修改的重要入口。

## Capabilities and Constraints

- 服务端是身份、任务和执行状态的唯一事实来源。
- Web、未来 iOS、macOS 和消息渠道共享同一套数据与任务生命周期。
- MVP 使用 DSH 作为可替换的 Agent Runtime。
- Control Plane、Worker 与独立 Supervisor 已有最小实现；Web 必须建立在现有 API 之上。
- 自我更新需要隔离修改、验证、候选版本接管、健康检查和自动回滚，不能直接覆盖正在运行的版本。
- 权限、审批、审计与可恢复性属于产品能力，不是仅靠提示词约束的行为。

## Brand Commitments

产品名为 Pegas，来自《宇宙骑士 BLADE》中的支援机器人柏卡斯：它承接意图、提供能力并帮助用户完成“变身”。品牌表达应像长期、可靠、克制的搭档，避免把用户置于复杂系统的驾驶席。

## Evidence on Hand

- 产品定位：[docs/product-positioning.md](docs/product-positioning.md)
- 系统架构：[docs/architecture.md](docs/architecture.md)
- MVP 计划：[docs/mvp-plan.md](docs/mvp-plan.md)
- 当前没有可引用的用户数据、客户证明或既有视觉资产，不得虚构这些内容。

## Product Principles

1. 对话是唯一必需的入口；Channel、Worker 和 Outbox 是按需控制面。
2. 混乱的输入必须变成清晰、持久的任务状态。
3. 默认保持安静，在需要时提供足够深的可检查性。
4. 进程、设备和版本变化不能中断用户的事情。
5. 自主执行始终服从权限、确认和可恢复边界。

## Accessibility & Inclusion

Web 客户端遵循语义化、键盘可操作、清晰焦点、可读对比度、减少动态效果偏好和移动端触控目标等基础可访问性要求。输入框必须正确处理中文等输入法组合状态。
