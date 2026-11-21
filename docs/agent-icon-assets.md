# Pegas Agent 图标资产

> Feature：BRAND-001
>
> 状态：Usable
> 更新日期：2026-11-19

## 用户结果

Pegas 使用自己的图标系统替代 DS Bot 鲸鱼形象。主入口固定为 Pegas
机器人；每个新 Channel 由服务端自动分配并持久化一个 Worker 图标，用户不能指定或修改
`workerIconId`。Worker 图标本体始终使用 Pegas 蓝；Channel 状态由独立的小徽记、文字和既有进度元素表达，不再改变 Worker 身份色。

## 验收条件

1. Pegas 主入口、主页、设置和消息身份始终使用 `bot`，Channel 不使用第三方角色形象。
2. 新 Channel 只从 `car`、`camera`、`computer`、`phone` 中由系统确定性分配；分配结果写入 Task，扩展图标库不会重排旧 Channel。
3. `backlog`、`unstarted`、`started`、`completed`、`cancelled` 分别使用三点、时钟、靶心、对勾和叉形徽记；状态同时有文字，不只依赖颜色。
4. 图标通过同源 SVG sprite 的 `<use>` 复用，并通过固定的 `--pegas-icon-background` 与 `--pegas-icon-foreground` 接收品牌主题；状态徽记由 Web 组件独立渲染。
5. 已命名按钮内的图标为装饰图像；独立信息图像由调用方提供可访问名称。状态徽记在 Forced Colors 下使用系统色，并始终有形状或文字作为非颜色线索。
6. 生成脚本是 SVG 几何和 sprite 的唯一事实来源；`pnpm icons:check` 阻止产物漂移。

## 非目标

- 不向用户暴露图标选择器或 `workerIconId` 输入。
- 不让图标决定 Worker 能力、模型、权限或路由。
- 不要求每个 Channel 拥有全局唯一形状；形状、标题、ID 和状态共同帮助区分。
- 不提交设计过程中的 PNG 预览、中间版本或第三方参考图片。

## 权威实现与产物

- 生成器：`scripts/generate-agent-icons.mjs`
- 服务端分配：`src/brand/agent-icon.ts`, `src/storage/sqlite-store.ts`
- Channel 投影：`src/channel/work-channel.ts`
- Web 渲染：`web/src/PegasAgentIcon.tsx`, `web/src/agent-icon-id.ts`
- 静态产物：`web/public/icons/agents/pegas-{bot,car,camera,computer,phone}.svg`, `pegas-agents.svg`

图标路径由生成器中的 `iconDefinitions` 定义。每个图标只声明自身的白色符号；背景、可访问名称和主题变量由统一模板生成。

## 生成与检查

重新生成全部图标：

```bash
pnpm icons:generate
```

只读检查已提交产物是否缺失或与生成器漂移：

```bash
pnpm icons:check
```

`pnpm check` 会自动执行漂移检查。扩展新图标时：

1. 在生成器 `iconDefinitions` 增加唯一名称、可访问名称、描述和几何；
2. 把 Worker 类型加入 `src/brand/agent-icon.ts` 和 Web 类型/注册表；
3. 运行 `pnpm icons:generate`；
4. 增加分配、迁移、小尺寸与状态徽记测试。

旧 Task 已经保存 `worker_icon_id`，因此扩大分配池只影响此后创建的 Channel。

## 数据、权限与恢复边界

图标资产无外部依赖，不读取用户内容。数据库 migration 11 为 Task 增加内部
`worker_icon_id`；历史 Task 由稳定哈希回填，新 Task 在创建事务内写入。API
只返回该值，不接受客户端写入。

生成失败时保留已有文件，修复脚本后重新运行即可。旧版本忽略新增列，因此代码回滚不需回写 Task；若物理回滚 schema，应从迁移前备份恢复数据库。

## 验证证据

- `pnpm icons:check`：五个独立 SVG 和一个 sprite 与生成器完全一致。
- 自动化覆盖确定性分配、非法第三方 ID、历史数据回填、API 投影、旧服务兼容、固定蓝色身份与 UI 状态徽记。
- 浏览器截图覆盖 Pegas 固定机器人、Channel 多形状、五状态徽记和收缩侧栏。
- 完整门禁：`pnpm check`, `pnpm smoke`。

## 剩余风险与下一缺口

自动化可访问性门禁已建立：`pnpm a11y:review`（`scripts/a11y-review.mjs`，
axe-core）对 light/warm/dark 三主题 × 对话/所有事情/待你处理/自动化/记忆/
设置六 surface 执行 WCAG 2.1 AA 扫描，serious/critical 违例即失败；另以
Playwright `forcedColors: 'active'` 验证 Worker 图标几何与状态文字线索。
当前 18 组合 0 违例。VoiceOver/NVDA 实机验证仍待人工执行（自动化无法替代）。

门禁首跑发现并修复的真实缺陷：

- 筛选条误用 `tablist/tab` 且无 `tabpanel`、`aria-controls`：改为
  `role="group"` + toggle button（`aria-pressed`），设置页真 tablist 去除
  非法 `aria-pressed`。
- light 主题 `--critical` 与 `--critical-soft` 对比度 4.28 < 4.5：调整为
  `#b93a46`（全表面 ≥ 4.8），并写入 `test/sealed-ui-contrast.test.ts` 回归。
