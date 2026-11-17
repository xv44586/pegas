# Candidate Evidence Manifest

> Feature：`SELF-001`
>
> 状态：Scaffold
>
> 更新日期：2026-11-17

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
- 明确记录的 `notTried`。

`ReleaseStateStore.stage` 接受 manifest 和本地 artifact 路径，在状态变更前重新计算文件大小与 SHA-256，并确认 tested commit 等于 Release commit。

## 验收条件

1. exact commit、成功 CI、通过 smoke、测试数量和 schema 范围均为必填字段。
2. manifest 可以原子写入、读取和运行时校验。
3. commit 不一致、CI failure/cancelled、smoke failure 或 artifact 变化会阻止 stage。
4. 完整质量门禁和 smoke test 通过。

## 非目标、权限与恢复

- 本 Feature 不负责创建 worktree、执行 CI、签名 artifact、解包 Release 或切换进程。
- CI URL 和 run ID 是审计证据，不作为认证凭证；manifest 不得包含 token、环境变量或测试日志原文。
- manifest 校验失败时保持当前 active Release 不变。修复方式是重新构建并产生新的 Candidate，不能编辑 hash 或把失败结论改成 success。
- 当前 artifact 在 stage 时验证；未来还需要 Release Registry 在解包和启动前再次验证签名或内容清单。
