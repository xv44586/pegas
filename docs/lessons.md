# Pegas Engineering Lessons

> Feature：`QUALITY-001`
>
> 状态：Living Document
>
> 更新日期：2026-11-19

本文件把已经造成返工、回滚、测试漏检或用户影响的事实，转化为可执行的工程规则。它不是通用最佳实践清单，也不收录尚未在 Pegas 中观察到的猜测。

## 用户结果

重复出现的工程失误不会只停留在一次修复里。每次事故留下证据，同类问题达到晋升条件后进入仓库规则或自动化门禁，使后续 Feature 在合并前被阻断。

## 记录格式

每条 Lesson 使用稳定 ID `LESSON-YYYYMMDD-NN`，并包含：

- **Rule**：一句可以检查的规则；
- **Why**：用户或系统受到的实际影响；
- **Feature**：关联的 Feature ID；
- **Evidence**：commit、PR、Issue、测试或日志的稳定引用；
- **Seen**：在不同日期独立观察到的次数与日期；
- **Severity**：`normal`、`security`、`data-loss` 或 `recovery`；
- **Status**：`Observed`、`Candidate` 或 `Promoted`；
- **Enforcement**：晋升后的 `AGENTS.md` 条款、测试、Lint、CI 或运行时约束；
- **Owner / next action**：下一步负责人或缺口。

证据不得包含凭证、用户原文、生产数据库内容或无法安全公开的日志。需要保留敏感证据时，只记录受控 artifact 的引用和脱敏摘要。

## 晋升规则

1. 首次观察记为 `Observed`；第二个独立日期再次出现时改为 `Candidate`。
2. 同一类问题在三个独立日期出现后必须改为 `Promoted`，并在同一个变更中给出 Enforcement。
3. `security`、`data-loss` 和 `recovery` 不等待三次；一次确认即可晋升。
4. 优先使用自动化门禁。只有无法可靠自动检查时，才把规则放入 `AGENTS.md` 或评审清单。
5. 已晋升 Lesson 继续保留证据，但规则只在一个权威位置维护，避免文档分叉。
6. 如果证据不足以证明是同一类问题，保持 `Observed`，不得为了凑次数扩大规则。

## 复盘节奏

- 每个 Bug、回滚、重开的 Issue 和失败的 Candidate 在关闭前检查是否应新增或增加 Seen。
- 每次 Release 复盘当期的返工提交、CI 漏检、人工修复和未覆盖风险。
- Feature 完成时，在 PR 的“经验复盘”中明确填写：新增 Lesson、更新已有 Lesson，或“无新 Lesson”。
- 晋升后验证规则能在旧的错误实现上失败；不能证明这一点的测试不能作为 Enforcement。

## 验收条件

1. Lesson 有统一格式、Seen 计数和明确晋升阈值。
2. 高严重度问题可以立即晋升。
3. PR 会记录精确 tested head、测试数量、真实验证、未验证项和经验复盘。
4. 后续规则集中在工程 TODO，未成熟规则不会提前污染强制标准。

## 非目标与恢复

- 本 Feature 不自动分析 commit 或生产日志，也不接入外部 Issue 系统。
- 本 Feature 不把 Magpie 或其他项目的规则直接认定为 Pegas 已发生的 Lesson。
- 错误晋升可通过普通文档提交降级或撤销；已存在的自动化门禁必须同步移除或收窄，并保留原因。

## Lessons

### LESSON-20261118-01：看板固定最小宽度导致整页横向位移

- Rule：宽面板需要在实际主内容宽度下验证，不能只按完整视口宽度决定列数。
- Why：任务列被裁切，用户必须横向拖动，标题栏和搜索入口也随滚动偏移。
- Feature：CONV-002
- Evidence：用户提供的任务页截图；`web/src/App.test.tsx` 的任务页回归与浏览器宽度核对。
- Seen：1（2026-11-18）
- Severity：normal
- Status：Observed
- Enforcement：尚未晋升；本轮以容器查询修复，后续评估浏览器布局自动化。
- Owner / next action：后续出现同类问题时补充独立日期证据。

### LESSON-20261118-02：模型目录获取成功却无法选用

- Rule：异步获取的选项需要实际点击或键盘选用路径，且失败反馈应提供用户下一步，不直接展示上游长错误。
- Why：用户获取 165 个模型后无法从输入框选择，404 返回的供应商原文淹没设置页。
- Feature：SETTINGS-001
- Evidence：用户提供的模型设置截图；`web/src/App.test.tsx` 的大列表选择及 404 反馈回归。
- Seen：1（2026-11-18）
- Severity：normal
- Status：Observed
- Enforcement：尚未晋升；本轮以回归测试覆盖主要路径。
- Owner / next action：后续出现同类问题时补充独立日期证据。

### LESSON-20261118-03：密文末字符变更不能稳定代表字节篡改

- Rule：加密完整性测试必须修改解码后的密文字节或认证标签字节，再重新编码；不能只替换编码字符串的末字符。
- Why：Base64url 末字符可能含不参与解码的尾部位，也可能恰好与替换字符相同，导致 CI 偶发通过解密。
- Feature：SETTINGS-001
- Evidence：2026-11-18 主分支 CI run 44248190224 的失败断言；`test/model-credential-vault.test.ts` 的确定性标签篡改测试。
- Seen：1（2026-11-18）
- Severity：normal
- Status：Observed
- Enforcement：尚未晋升；测试已改为确定性字节篡改。
- Owner / next action：后续出现同类问题时补充独立日期证据。

### LESSON-20261118-04：录音能力与语音服务状态混淆

- Rule：语音入口应分别显示浏览器录音能力和服务端转写配置，并在申请麦克风权限前检查服务配置。
- Why：设置页显示“浏览器可用”，实际服务端未配置 ASR，录音结束后才出现英文错误，且用户无法在页面修复。
- Feature：VOICE-001
- Evidence：用户提供的输入器和设置截图；`web/src/App.test.tsx` 未配置引导回归及 `test/control-plane.test.ts` 保存后转写回归。
- Seen：1（2026-11-18）
- Severity：normal
- Status：Observed
- Enforcement：尚未晋升；本轮以回归测试覆盖。
- Owner / next action：后续出现同类问题时补充独立日期证据。

### LESSON-20261118-05：连接设置缺少实际验证入口

- Rule：新增外部服务连接表单时，提供基于当前未保存配置的真实请求测试和可理解的结果反馈。
- Why：用户可以填入语音地址、模型和密钥，却要保存并返回对话录音后才知道连接是否可用。
- Feature：VOICE-001、SETTINGS-001
- Evidence：用户提供的语音与改写设置截图；`test/control-plane.test.ts` 未保存连接探测、失败脱敏及改写回归，`web/src/App.test.tsx` 对应交互回归。
- Seen：1（2026-11-18）
- Severity：normal
- Status：Observed
- Enforcement：尚未晋升；本轮以回归测试覆盖。
- Owner / next action：同日改写服务再次出现缺少测试入口，后续独立日期复发时评估统一门禁。

### LESSON-20261118-06：绝对定位子元素必须有明确的局部包含块

- Rule：面板内绝对定位的标题栏必须锚定到面板自身的定位上下文，并为收缩态的可见控件数量增加回归证据。
- Why：工作区空态标题以 viewport 为包含块，导致窄屏覆盖面板中的文字和分隔线跨过左边界；左 rail 收缩后也保留了多余入口。
- Feature：CONV-002
- Evidence：用户提供的工作区与收缩 rail 截图；`web/src/App.test.tsx` 单按钮回归与 `test/workspace-theme.test.ts` 定位合同。
- Seen：1（2026-11-18）
- Severity：normal
- Status：Observed
- Enforcement：尚未晋升；本轮以 DOM 和 CSS 回归测试覆盖。
- Owner / next action：后续独立日期复发时补充可视化几何门禁。

### LESSON-20261119-01：发布目录不能成为不可恢复的 Session 身份

- Rule：Executor 恢复必须区分“已开始执行后的失败”和运行时在执行前明确拒绝的 workspace 身份漂移；只有后者可以自动新建 session。
- Why：Candidate worktree 切换后，历史 DSH session 仍绑定旧路径，新的 Worker 使用当前路径恢复时把运行时路径错误直接展示给用户，导致可用模型看起来不可用。
- Feature：EXEC-003
- Evidence：用户提供的对话错误截图；`test/dsh-cli-executor.test.ts` 跨 workspace session 恢复回归。
- Seen：1（2026-11-19）
- Severity：normal
- Status：Observed
- Enforcement：尚未晋升；本轮以精确错误匹配和回归测试约束，其他失败仍保持不可自动重放。
- Owner / next action：将 Task workspace 与 Candidate artifact 生命周期彻底解耦，并补真实 Candidate 切换故障演练。

### LESSON-20261119-02：错误反馈不能覆盖用户正在阅读的内容

- Rule：输入器异步错误必须在输入器内部占据正常布局空间，并通过礼貌 live region 宣告；不得绝对定位到消息流上方。
- Why：语音服务不可达时，错误文案覆盖了上一条消息的时间和输入器边缘，用户既看不清错误归属也无法稳定操作输入框。
- Feature：VOICE-001
- Evidence：用户提供的语音失败截图；`web/src/App.test.tsx` 的 inline status 回归和 `test/workspace-theme.test.ts` 的非覆盖布局合同。
- Seen：1（2026-11-19）
- Severity：normal
- Status：Observed
- Enforcement：尚未晋升；本轮以语义和 CSS 回归覆盖。
- Owner / next action：后续独立日期复发时补充浏览器几何截图门禁。

### LESSON-20261119-03：功能完成必须按用户闭环判定

- Rule：Feature 开始前必须冻结“用户场景 × UI 状态 × 视口 × 真实依赖 × Candidate 生命周期”的验收矩阵；只有关键单元格都有可复核证据，才能宣告完成。单元测试通过、配置已保存、页面能打开或某个截图相似，都不能单独代表用户闭环可用。
- Why：DS Bot 前端重构连续经历了壳层重做、设置和工作区补回、工作区定位与收缩态修复、默认 ASR、默认 Magpie、跨 Candidate session 恢复和错误提示布局修复。反复修改不是因为这些问题无法同时发现，而是第一轮没有把完整闭环定义为一个验收对象：我把明确的“复刻”要求当成可解释的设计方向，没有先逐项对照源码与参考截图；自动化主要验证 DOM、状态和局部 CSS，没有在真实布局里检查几何关系；模型和语音先验证了配置值，没有在最终 Candidate 上走真实服务；运行代码所在 worktree 又被误当成 DSH 的稳定 Task workspace；同一界面存在多层主题 CSS，最终级联覆盖没有在所有关键状态下渲染验证。结果是每次只修复用户刚暴露出的那一层，测试也在事后追着缺陷补，而不是在第一轮阻止不完整交付。
- Feature：QUALITY-001、CONV-002、VOICE-001、SETTINGS-001、EXEC-003
- Evidence：2026-11-18 至 2026-11-19 的提交序列 `56906db`、`0427a0a`、`1598a76`、`d4747d6`、`1f2ced6`、`d205ccb`、`f2142dd`；用户连续提供的首页、工作区、收缩栏、设置和错误状态截图；随后补入的 `web/src/App.test.tsx`、`test/workspace-theme.test.ts` 与 `test/dsh-cli-executor.test.ts` 回归；首轮 QUALITY-001 CI artifact 名称绑定 PR head、报告正文却绑定 GitHub synthetic merge commit，最终核验发现后增加显式 head checkout 回归。
- Seen：2（2026-11-18、2026-11-19）
- Severity：normal
- Status：Candidate
- Enforcement：根据用户明确要求提前实现 QUALITY-001 门禁，但 Lesson 仍按 Seen 次数保持 Candidate：仓库永久保存验收条件和测试能力；CI 显式检出 PR head 并在准确 SHA 上生成短期报告与 UI 截图；关键 `Not tried` 阻断审核；Candidate schema v2 绑定报告哈希与人工 reviewed commit。运行结果不再作为永久 Feature manifest 提交。
- Owner / next action：补通用 Candidate canary runner；第三个独立日期再次出现同类问题时，按晋升规则将本 Lesson 标记为 Promoted。

<!--
### LESSON-YYYYMMDD-NN：简短标题

- Rule：
- Why：
- Feature：
- Evidence：
- Seen：1（YYYY-MM-DD）
- Severity：normal
- Status：Observed
- Enforcement：尚未晋升
- Owner / next action：
-->
