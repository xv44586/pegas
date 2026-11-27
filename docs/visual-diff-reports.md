# 代码变更流程图（NOTIFY-007）

在「设置 → Pegas → 行为与规则」打开「代码变更流程图」，点击「保存更改」。默认关闭，沿用实例级运行设置；后续代码工作有实质行为变化时，Pegas 在文字汇报后附上动态 SVG，支持预览和下载。关闭阻止新图落库，历史图仍可查看。

## 使用边界

第一版比较两个已存在的 Git commit。图展示当前变更和必要的相邻步骤：前后同义节点对齐，蓝色标注修改，灰色标注复用，虚线表示该版本没有此步骤。连线动画仅提示方向，自动播放一次；系统偏好减少动态效果时隐藏动画。图内保留文件、行号和基线/结果 SHA，完整结构保存在 SVG metadata。

实际 Executor 判断什么值得画图。只有确认不影响行为或契约的类型标注、格式、局部重命名才可折叠，并在图尾保留理由。接口字段、默认值、权限、校验、序列化与异常路径不可当作噪声。Git 校验可以证明引用存在且修改节点命中 diff，不能证明 Agent 的语义解释正确；正文、测试与验收证据仍是独立交付内容。

没有实质变化、没有已提交比较、权限或上下文不足时，不强行画图。不得为了生成图自动提交代码，也不得把未提交部分静默排除后声称已覆盖全部修改。暂不支持工作区快照、全仓索引、人工编辑器、视频或外部渠道内嵌 SVG。

## 实现与协议

1. `runtimeSettings.visualDiffEnabled` 为可选布尔字段。新实例和迁移默认 false；旧客户端省略字段时保留现值。此字段不是新的工具授权。
2. Worker 把开启状态传给实际 DSH Executor。`src/visual-diff/contract.ts` 是唯一的 authoring contract，定义版本 1 JSON、2–8 个节点、每侧最多 12 条边、引用、分类与长度限制。最终文字后追加 `<pegas_visual_diff>JSON</pegas_visual_diff>`；如同时有追问元数据，追问在前、图数据在最后。流式 Activity 隐藏完整和部分标记，不泄露机器数据。
3. `prepareVisualDiffReport` 从最终输出提取有界数据，`verifyVisualDiff` 在当前执行目录只读 Git。只接受两个完整 SHA；每侧存在的节点必须有该侧有效代码行，修改节点至少命中一处增删 hunk。拒绝越界路径、符号链接、错误图结构和不在 diff 内的折叠文件。Git 不经过 shell，禁用外部 diff、textconv、fsmonitor、replace objects；单次调用有超时与输出限制。
4. `renderVisualDiff` 是无依赖纯函数，只生成固定元素、样式与有限 SMIL 动画，所有文本/XML metadata 转义；不接受可执行 SVG、HTML、脚本或任意 URL。
5. `completeRun` 在现有事务和 claim fence 内保存 `run_visual_diffs`、输出与 Outbox。run_id 主键确保一次产物，事务回滚不留下假链接；当前开关再次检查，执行中关闭也不落图。流程图不改变 Goal、审批或完成门禁。
6. `GET /v1/runs/:runId/visual-diff?userId=…` 使用实例鉴权与 owner 查询，返回 SVG、内容摘要、no-store 和严格 CSP。userId 是现有实例鉴权下的资源归属过滤，不是新增多租户身份认证。Web 仅对这个第一方路径附鉴权请求，转为 Blob `<img>` 预览并下载；不通过 innerHTML、iframe 或 object 执行图。图片读取失败提供重试，正文继续可见。外部通知只有现有文字/内部链接，不携带 SVG 字节。

## 可移植技能与渲染器

`skills/visual-diff/SKILL.md` 把「读 diff → 语义筛选 → 前后对齐 → 来源校验 → SVG」流程交给其他 Agent。该技能与 SVG 渲染器没有运行时外部服务依赖。

```sh
pnpm package:visual-diff
node output/visual-diff/scripts/cli.js change.json change.svg /absolute/path/to/repository
```

导出目录包含技能、从同一合同生成的 authoring reference、CLI、模型类型、Git 校验与渲染器 JS。需 Node ≥24.9 与 Git，无运行时 npm 依赖。可将该目录复制为其他 Agent 的技能包，也可仅调用 renderer。导出目录和 SVG 采用拒绝覆盖行为；再次导出时用新目录：`pnpm build:server && node scripts/package-visual-diff.mjs /path/to/new-export`。导出不自动全局安装、不上传。

## 失败、持久化与恢复

JSON、Git 或引用校验失败时，保留文字并追加「流程图未生成」原因类别，不泄露原始 Git 错误或模型数据。关闭时移除数据块，不读取 Git。流式连接中断不产生正式 SVG，已有 Run 恢复和重放规则继续有效；数据库完成事务失败沿用既有恢复链。历史图的字节不因仓库后续变动而改变。

迁移 62 仅增加 `runtime_settings.visual_diff_enabled` 与 `run_visual_diffs`，不重写历史 Run。第一恢复路径是关闭开关；如需回退实现，应经 Candidate/Supervisor 使用声明兼容 schema 62 的回退版本，保留新列和表，不手工降库或删除历史图。旧 Candidate 的 schema 上限可能阻止直接回滚，应先验证兼容性，必要时从发布前备份恢复隔离候选。不得直接替换正在运行的实例。

## 验证范围

`test/visual-diff.test.ts` 使用真实临时 Git 仓库验证 SHA、引用/hunk、符号链接、越界、分类、XML 转义、独立 CLI、开关兼容、Worker 降级、完成事务与重放、重启持久化及 HTTP 访问；`test/dsh-cli-executor.test.ts` 验证逐字符流不泄露图 JSON；Web 测试覆盖开关保存、鉴权图片、下载、失败重试、卸载撤销 Blob 和外链隔离。完整门禁与运行记录登记在 Feature Map。

剩余边界：模板布局不等于任意架构图布局；语义分类需实际模型判断；未提交差异、逐用户偏好、外部渠道原生附件与模型生成质量评估留待后续版本。
