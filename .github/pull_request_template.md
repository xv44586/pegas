## 结果

<!-- 这次变更给用户或系统带来了什么可验证的结果？ -->

## Feature Map

- Feature ID：
- 状态变化：
- 是否检查过重复实现：是 / 否

## Feature Review

- [ ] PR 标题包含 Feature ID（例如 `fix(CONV-002): ...`）
- [ ] Feature Map 中的验收条件已更新
- [ ] 已查看 CI 自动生成的短期审核 artifact 和 job summary
- [ ] UI 改动已查看自动截图；真实依赖改动已查看脱敏 canary
- [ ] 临时报告中没有关键 `Not tried`
- [ ] 审核记录明确写出 reviewed commit SHA
- 本地生成：`pnpm review:evidence -- --changed-from <base-ref> --feature <FEATURE-ID> --passed "pnpm check|..."`

## 验证

- [ ] 新功能或缺陷修复已有自动化测试
- [ ] `pnpm check`
- [ ] `pnpm smoke`（涉及进程、数据库、通知或恢复路径时必选）
- [ ] Feature Map 已更新
- [ ] 架构或运行文档已同步（如适用）
- [ ] 数据、权限、外部副作用和回滚风险已说明（如适用）

- Tested head SHA：
- 基线 / 目标分支 SHA：
- 测试命令与数量：
- 关键通过场景：
- 真实环境或手工验证：
- 未验证项（Not tried；必须说明是否关键）：
- 已知红灯及 Issue：
- 回滚方式：

## 经验复盘

- [ ] 已检查 `docs/lessons.md`
- Lesson：新增 / 更新 `LESSON-...` / 无新 Lesson
- 后续但尚未晋升的规则是否已进入 `docs/engineering-todo.md`：是 / 不适用
