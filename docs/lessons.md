# Pegas Engineering Lessons

> Feature：`QUALITY-001`
>
> 状态：Living Document
>
> 更新日期：2026-11-18

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
