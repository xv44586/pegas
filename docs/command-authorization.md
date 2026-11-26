# APPROVAL-001 命令授权与真实桌面闭环

2026-11-26 用户确认统一授权设计 v1。基线 ebc5b433；独立分支及 worktree 为 `codex/approval-001-command-grants`。主工作区不参与开发。

## 用户行为与范围

授权对象与有效期分别表达。命令提供准确参数 / 受支持命令族两种精度，各有本事情 / 长期有效两种期限。默认仍是仅批准一次；长期授权须主动选择，可在设置 → 隐私 → 授权管理或事情详情撤销。已结束的审批显示决定、范围和执行结果，技术标识折叠展示。

首个完整适配器是 `git fetch`：绑定实际 Git、Shell、执行组件、仓库 Git common directory、远端解析地址、有效配置与相关环境的哈希。命令族允许同仓库合法 worktree、已批准 remote 的普通分支/tag 拉取；准确命令还要求 argv 与实际 cwd 一致。`env -u GIT_CONFIG_COUNT ...` 保留真实环境影响。搜索文本中的 `git fetch` 不视作执行。

支持 HTTPS 和本地远端。凭证适配仅允许系统 osxkeychain、精确可信路径的 gh 凭证命令，绑定真实组件路径与内容哈希；任意 shell helper、SSH 的额外执行配置、可执行 Git hook、子模块、自定义 transport、force/prune、自定义 refspec、配置注入、复合脚本不获得普通 fetch 持久权限，卡片解释不适用原因。配置变化后重新核对。配置中的 prune/pruneTags 与自定义 fetch refspec 同样不能持久授权；带合法 Git 全局选项但暂未适配的 fetch 形式仍须单次确认。此边界不宣称隔离任意程序，也不等于全磁盘或任意网络授权。

目录信任仅覆盖可确定范围的普通文件写入、编辑、补丁及有界补丁入口，不自动包含删除、移动或任意 shell。路径使用实际 session cwd/workdir 与 realpath；缺失目标的拟授权目录不会扩大到已有祖先。符号链接越界及相似路径前缀不能复用。现有默认工作区与全局读取政策保持原定义。

事情规则在事情完成或停止时失效，重开不会复活；运行结束但事情仍在进行时可继续复用。长期规则绑定同一 owner，跨事情和重启保留。撤销作用于尚未开始的下一次调用，已经执行中的系统进程仍由现有停止能力管理。

## 权威判定与恢复

服务端保存 Approval、Action、规则、决定引用的实际规则和审计。审批说明区分规则撤销/事情结束、仓库或远端不同、准确参数变化、环境配置变化和严格档收紧；仅用于解释的撤销历史独立于可执行规则。事情的每次运行提供「授权执行记录」，可展开已落库的原因并进入对应授权查看/撤销，支持分页与读取失败重试。客户端仅选择服务端规范选项，不自行判定权限。规则去重也必须记录决定与既有规则的绑定，不能丢失撤销关联。

Executor 的 pre-execute 与 DSH approval/request 使用同一匹配模块，每个入口重新读取权限及实际上下文。首次恢复的 `approve_rule` 与单次批准均记录真实执行结果；持久决定的首次 grant 同样必须复核所绑定规则、档位和资源。目录规则也遵循该检查。首次 grant 复核只针对它绑定的 Action，不能误伤后续另一个已独立授权的调用。规则不存在、被撤销、权限收紧或上下文变化时不得复用。

仅对桥明确证实尚未开始的调用记录 failed outcome 的 `notExecuted: true`，允许该恢复 Run 生成新的审批。缺少该布尔事实、一般工具失败、unknown、未结算 authorized 或人工核对失败仍遵循原保护。授权停放后的晚到 session-ref 回调不再把合法等待误变成执行错误。决定、规则、绑定和恢复事件同事务；重复决定/撤销保留幂等语义。

## 数据与回滚

增量 schema 60 为规则增加 kind、lifetime、command selector，并新增不可变的决定到规则绑定。既有规则不扩大范围；旧的单次决定不产生持久授权。任务终态触发事情规则撤销，保留历史；升级时同时回填已结束事情的旧规则，长期目录规则保持原范围。

新命令规则使用独立 category 与空文件 targets，旧文件规则匹配器不能把它们解释为通配允许。旧版本忽略其复用，重新询问。未结算的新命令授权由 Supervisor 回滚兼容检查阻止回到 schema 59，以免旧 Worker 丢失首次 grant 的上下文约束。发布必须构建不可变 Candidate，由独立 Supervisor 验证、切换及保留回滚版本。

## 验证证据

本地先运行 `pnpm build`，再在 DSH 位于 PATH 的环境执行 `pnpm smoke:command-authorization`。CI 使用 `xvfb-run --auto-servernum npm exec --yes --package=@deepseek-ai/dsh@0.2.2-rc.5 -- pnpm smoke:command-authorization`，在真实 Electron 中运行同一脚本；依赖缺失或断言失败会使检查失败。`output/command-grants/` 以 `command-authorization-<commit SHA>` artifact 上传并保留 7 天，证据只代表对应提交的实际验证结果。

- `test/command-policy.test.ts`：实际临时 Git 仓库、worktree、参数/远端差异、PATH、启动变量、hook、helper、SSH 与配置边界。
- `test/approval-rule-bridge.test.ts`：真实 SQLite + HTTP，四种命令授权、目录授权、owner 隔离、规则去重绑定、双入口撤销、首次 grant 撤销后重新审批并结算、终态失效及迁移回滚检查。
- `test/processor.test.ts`：持久决定首次 grant/outcome 与停放后的 session-ref，两条原问题先红后绿。
- `test/policy-gate.test.ts`、`test/approval-rules.test.ts`：有界目录、未存在路径、链接越界、默认选项与历史数据。
- `web/src/App.test.tsx`：四种命令范围显式提交、只读历史结果、多端已决定与错误恢复、规则撤销。
- `pnpm smoke:command-authorization`：实际 Electron main、真实 Worker 和 DSH bash，模型仅使用 loopback 确定性网关；所有 fetch 操作都访问隔离本地 bare remote。每阶段推进新的远端 commit，再核验实际 FETCH_HEAD；撤销后确认不执行。覆盖事情内复用及结束失效、长期后续运行、SQLite/桌面重启、新事情、worktree、桌面设置撤销、重新询问及窄屏布局。测试不批准用户业务任务、不修改真实规则。

本地证据位于 `output/command-grants/`，包括桌面截图、结构化结果、红绿回归和完整门禁日志；生成产物不提交。完整门禁与部署状态以同 Feature 的 Feature Map 和发布证据为准。

非目标：任意命令字符串前缀白名单、任意脚本永久授权、默认全磁盘权限、自动扩大高风险/外发授权、修改 Router 职责。
