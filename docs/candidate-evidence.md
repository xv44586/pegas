# Candidate Evidence Manifest

> Feature：`SELF-001`
>
> 状态：Usable（构建与 staging 闭环）；artifact 签名待实现
>
> 更新日期：2026-11-21

## 用户结果

Pegas 只有在 Candidate 的构建产物、Git commit 和验证证据属于同一个不可变版本时，才允许把它写入 Supervisor 的 verifying 状态。旧 commit 的测试、失败或取消的 CI、未通过的 smoke 和已被替换的 artifact 都不能作为发布证据。

## Manifest 内容

- Release ID、root、完整 Git commit 和创建时间；
- artifact 文件名、字节数和 SHA-256；
- 兼容的最小与最大数据库 schema；
- tested commit；
- 已完成且 conclusion 为 `success` 的 CI workflow、run ID、URL 和完成时间；
- 实际命令和测试数量；
- 通过的 smoke 命令与完成时间；
- 临时 Feature Review 报告的文件名、Feature ID、tested commit 与 SHA-256；
- 人工审核的 reviewed commit、审核人和时间；
- 明确记录的 `notTried`。

`ReleaseStateStore.stage` 接受 Candidate manifest、本地 artifact 路径和临时 Feature Review 报告路径，在状态变更前重新计算两份文件的 SHA-256，并确认 CI tested commit、报告 commit、人工 reviewed commit 与 Release commit 完全一致。

## 构建与 staging 实现（2026-11-21）

- `src/self-change/candidate-builder.ts` 从隔离 worktree 的 exact commit 构建 Candidate：复制 `dist/`、`package.json`、`pnpm-lock.yaml`，`node_modules` 以符号链接共享安装字节；写入目录级 SHA-256 attestation（跳过符号链接、按文件名排序），生成 Review Report 与 Manifest 后将全部文件冻结为只读。`verifyCandidateReleaseTree` 在 staging 前重新计算目录 digest，任何字节变化都会被拒绝。
- 本地自我修改使用 `local-self-change-gate` CI attestation：真实命令是在候选 worktree 内执行的 `pnpm check` 与 `pnpm smoke`；远程发布仍必须提供真实 GitHub Actions 证据。
- Recovery API `POST /v1/recovery/candidates` 是唯一的运行时 staging 入口：Bearer 鉴权、要求绝对路径、校验 manifest 与目录 attestation、检查候选 `minimumSchema` 不超过 active `maximumSchema`，与 restart/rollback 共用转换屏障；接受后返回 202 并进入 verifying。
- 自动化证据：`test/self-change.test.ts`（不可变构建、篡改拒绝、staging 校验、审批发布闭环）与 `pnpm smoke:self-change`（真实 Supervisor 进程的接管与自动回滚，MVP 场景 5/6）。

## 验收条件

1. exact commit、成功 CI、通过 smoke、测试数量和 schema 范围均为必填字段。
2. manifest 可以原子写入、读取和运行时校验。
3. commit 不一致、CI failure/cancelled、smoke failure 或 artifact 变化会阻止 stage。
4. 临时报告存在关键 `Not tried`、内容不完整或创建 Candidate 后发生变化会阻止 stage。
5. 完整质量门禁和 smoke test 通过。
6. stage 成功后临时报告可以按保留期删除；confirm 和 rollback 依赖 Candidate manifest，不依赖媒体继续存在。

## 非目标、权限与恢复

- worktree 创建、本地 CI 执行、Release 构建与进程切换已由 SELF-001 闭环实现（见上）；artifact 签名与远程 CI 强制仍是非目标。
- CI URL 和 run ID 是审计证据，不作为认证凭证；manifest 不得包含 token、环境变量或测试日志原文。
- manifest 校验失败时保持当前 active Release 不变。修复方式是重新运行准确 SHA 的验证和审核并产生新的 Candidate，不能编辑 hash、伪造 reviewed commit 或把失败结论改成 success。
- 当前 artifact 在 stage 时验证；未来还需要 Release Registry 在解包和启动前再次验证签名或内容清单。
