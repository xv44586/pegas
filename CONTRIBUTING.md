# Contributing to Pegas

Pegas 仍处于早期阶段，因此现在就把边界、测试和可恢复性做对，比以后清理重复实现更便宜。

## 开始开发前

1. 阅读 [产品定位](docs/product-positioning.md)、[系统架构](docs/architecture.md)和 [Feature Map](docs/feature-map.md)。
2. 使用 Feature ID 搜索已有实现和测试；没有 ID 时，先在 Feature Map 中登记能力和预期结果。
3. 明确唯一事实来源。客户端只做界面和渠道适配，不复制服务端任务状态或路由逻辑。
4. 阅读 `docs/lessons.md` 中已晋升的经验；候选规则只从 `docs/engineering-todo.md` 按相关 Feature 逐步采用。

## Definition of Done

一个 Feature 只有同时满足以下条件才算完成：

- 用户可观察的结果和失败行为明确；
- 核心逻辑有自动化测试，Bug 修复有回归测试；
- `pnpm check` 通过；
- 涉及跨进程、数据库、恢复或通知链路时，`pnpm smoke` 通过；
- 没有新增未解释的 dead code、重复依赖或宽泛配置豁免；
- Feature Map 的状态、实现入口、测试证据和下一缺口已更新；
- 架构或运行方式变化时，对应文档同步更新。
- 已完成 Lesson 检查，并记录新增、更新或“无新 Lesson”。
- CI 临时审核报告没有关键 `Not tried`，审核记录明确写出 reviewed commit SHA。

## 本地质量检查

```bash
pnpm install
pnpm check
pnpm smoke
```

`pnpm check` 依次验证格式、ESLint、TypeScript、无用代码、覆盖率阈值和生产构建。`pnpm test` 可用于快速反馈，但提交前必须运行完整检查。

默认 `pnpm test`、`pnpm test:coverage`、`pnpm check` 不收集付费模型验收，本机网关在线或设置 `PEGAS_LIVE_MODEL` 都不会自动开启。普通测试使用固定响应与本地 HTTP 夹具，fetch 防护拒绝外网、3425 网关与自动重定向。

只有显式执行 `pnpm test:live` 才运行四组真实模型验收（会消耗 token）。可用 `PEGAS_LIVE_MODEL=<模型路由> pnpm test:live` 指定模型，并在命令末尾附测试文件或 `-t` 只运行相关场景。该命令不属于默认 CI / check；串行执行且不自动重跑失败用例。显式验收缺少 DSH、网关不可达、凭证或配额失败时均报错，不再跳过。普通测试、回环协议测试、付费验收的边界与限制见 [测试隔离](docs/test-isolation.md)。

UI 改动由 CI 在隔离 Pegas 实例中生成短期截图；本地可运行 `pnpm review:ui -- --changed-from origin/main`。`pnpm review:evidence` 把准确 SHA、命令结果和媒体哈希写入 `output/feature-review/`。这些运行产物只供审核和 Candidate stage 使用，不进入主分支；详见 [Feature Review 门禁](docs/feature-review-gate.md)。

覆盖率基线由 `vitest.config.ts` 管理。阈值只能在新增验证后保持或提高；不要通过降低阈值掩盖缺失测试。动态入口导致 Knip 误报时，只添加精确到文件或符号的例外。

## 提交原则

- 一个提交围绕一个清晰结果，避免把无关重构混入功能修改。
- 不提交凭证、本地数据库、构建产物或个人运行配置。
- 数据库 schema、外部副作用和恢复逻辑的变更必须说明兼容与回滚方式。
- 用户可见消息必须来自正确的责任层：传输状态属于 UI 元数据；任务归属属于 Router；工具能力、澄清和执行确认属于实际 Agent。
