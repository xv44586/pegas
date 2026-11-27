# APPROVAL-001 命令授权与真实桌面闭环

## 本事情所有工具授权与状态诊断增量（2026-11-27，本地验收通过）

用户明确选择“增加本事情内所有工具授权，结束后失效”。基线 `7527f4f6`，隔离工作区 `approval-001-state-query`。本轮仍属 APPROVAL-001，包含复合脚本反复审批和内部状态查询无专用工具两个缺口。

验收：符合条件的新建和升级前已停放工具审批提供非默认“本事情内允许所有工具操作”；一次明确决定后，同一事情不同工具、复合脚本、文件读写/删除和网络操作在标准档复用，含首次恢复、后续 Run 与重启。完成/停止立即撤销，重开和别的事情不继承；撤销后 pre-execute 与原生 approval/request 都重新询问，尚未执行的首次恢复有明确 notExecuted 结算。真实 Electron、Worker、DSH 必须验证实际副作用。

边界：规则仅绑定该 owner 的该事情，默认仍批准一次；严格档/权限收紧、宿主凭据隔离和控制面保护仍优先。授权不会改变任务目标、恢复未知副作用或跨用户访问。网络/破坏性操作允许被用户这次明确的有限期授权覆盖，既有目录/命令规则不扩大；任意脚本永久授权仍是非目标。

控制面数据目录及 DSH home 已加入无条件进程/文件服务读写拒绝，不能经不透明脚本读取全局 bearer 或改写审批数据库。macOS 合并 Seatbelt 拒绝规则，Linux 隐藏受保护路径并在挂载完成后只读 remount。此保护同样适用于一次性升级和 full-access；可信插件仍通过有界服务端接口工作。所有 Run 能力文件、Executor 插件 patch 和模型连接 patch 均存入按宿主 uid 隔离且校验所有者/0700/非符号链接的私有临时根；该根也在无条件保护范围内。当前 Run 仅能读取自己的精确 capability 文件，不能写入、列目录或读取其他 Run；macOS 使用精确 literal 读例外，Linux 在遮蔽后精确 ro-bind，再只读 remount 目录。该已委派能力不扩大成 owner bearer。

服务端规范生成选项，决定时保存所展示的选项并原子创建规则和决定绑定。使用既有 operation 规则的独立 `task-tools` category、`*` 工具、空 targets、task lifetime，不作为文件通配目录；不新增 schema。旧版本不识别 category，回滚后重新询问；回滚也会移除本轮运行配置隔离加固，回滚期间应停止工作任务。历史单次批准不会升级，已决定审批保持原状。失败恢复沿用既有 Action outcome 与幂等决定/撤销协议。

内部诊断新增只读 `read_task_state(taskId)`：通过活跃 Run claim 访问 `GET /v1/runs/:runId/history/task-state?taskId=`，读取同 owner 正式事情，排除 conversation。严格只读档和标准档均挂载该专用工具。返回当前状态、最新至多 5 次运行与 10 条 pending/decision_recorded 审批（时间相同时按 rowid 排序），标题/审批摘要限 500 字符，运行错误限 2000 字符，附截断标记；传输上限 64 KiB、超时 10 秒，启用隐私脱敏时对字符串叶子掩码。禁止任意 API 代理，不新增完整工具参数或凭证字段，不读取能力文件内容；有界错误和摘要仍可能引用原命令文本。未知/他人事情同为 404，过期 claim 为 403。结果是事实数据，不能作为新指令。

本地证据：回归先红后绿；`pnpm check` 159 文件 / 1869 测试通过（语句 79.15%、分支 72.88%、函数 76.16%、行 82.07%，未修改阈值），`pnpm smoke` 通过。真实桌面和隔离探针见下方；精确提交 CI、Candidate/Supervisor 发布与生产待审批卡核验必须通过后才能宣布上线。

- `pnpm smoke:command-authorization`：真实 Electron/Worker/DSH 首次 grant 经重启后恢复、不同脚本及原生 write、后续 Run 复用、主对话长期范围与事情输入栏改档/撤销、撤销后实际文件不变、完成/重开失效、strict 的 read_task_state；原 git fetch 门禁继续覆盖任务/长期/重启/worktree/撤销/窄屏。证据在 `output/command-grants/desktop-task-tools-result.json` 与截图。
- `pnpm smoke:credential-boundary`：macOS 10 场景通过，含可信模型 patch 覆盖与跨 Run 能力读取阻断、当前委派能力可读、控制面读写阻断和普通文件可写；Linux 9 场景由精确提交 CI 实测。
- UI 回归含两个对话入口、草稿/焦点与 Escape、保存仅改权限而保留模型、full 显式确认、409 冲突重载、撤销失败重试、长期范围过滤、搜索列表外事情、已结束只读和打开确认后事情结束的竞态；事务回归验证迟到权限修改被拒绝。日志 `output/task-tools/` 为本地审核产物，不提交仓库。

对话权限入口增量：主对话与事情对话输入工具栏提供「权限」按钮。事情页默认当前事情，主对话可选择事情或查看长期授权；复用服务端 WorkerProfile 和 ApprovalRule，不由客户端推断或扩大权限。允许调整事情档位、查看和撤销适用于该事情的规则；新增具体工具/目录/命令授权仍在真实审批中决定。验收包括草稿保留、范围切换、保存冲突、撤销失败可重试、结束事情只读、键盘关闭与焦点恢复，以及真实桌面从输入栏撤销后下一次调用重新审批。长期规则标明跨事情影响。收紧在下一次调用复核，放宽不越过当前 Run 快照上限，越过上限需新 Run；修改档位不复活已撤销规则。服务端在事务中拒绝 completed 事情的权限变更（保留已成功命令的只读幂等重放）；面板同步最新事情状态，结束时关闭尚未确认的完全访问选择，列表外事情可刷新服务端状态。

当前宿主账号边界见 [宿主账号凭据边界](credential-boundary.md)：命令、目录与完全访问授权均不包含本机账号登录；旧版本关于凭据 helper 可用性的记录不构成当前授权。

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
