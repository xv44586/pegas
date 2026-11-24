# Pegas Agent 图标资产

> Feature：BRAND-001
>
> 状态：Usable
> 更新日期：2026-11-21

## 用户结果

Pegas 使用自己的图标系统替代 DS Bot 鲸鱼形象。主入口固定为 Pegas
机器人；每个新 Channel 由服务端自动分配并持久化一个 Worker 图标，用户不能指定或修改
`workerIconId`。Worker 图标本体始终使用 Pegas 蓝；Channel 状态由独立的小徽记、文字和既有进度元素表达，不再改变 Worker 身份色。

`bot` 使用 BRAND-002 确认版圆肚机器人。四种 Worker 继续使用柔和 3D
陶瓷质感插画。透明母版由 `scripts/generate-brand-icons.mjs` 裁切、
等比缩放并居中到 256×256 画布，输出无损 WebP。UI 中的插画直接落在页面背景上。此前改编自 MIT Tabler Icons 的线性 Worker 符号
及其 sprite 管线已整体退役，当前产物不含第三方几何；历史记录见 git 历史
与 `docs/pegas-mascot.md`。

## 验收条件

1. Pegas 主入口、主页、设置和消息身份始终使用 `bot`，Channel 不使用第三方角色形象。
2. 新 Channel 只从 `car`、`camera`、`computer`、`phone` 中由系统确定性分配；分配结果写入 Task，扩展图标库不会重排旧 Channel。
3. `backlog`、`unstarted`、`started`、`completed`、`cancelled` 分别使用三点、时钟、靶心、对勾和叉形徽记；状态同时有文字，不只依赖颜色。
4. 图标以显式宽高的 `<img>` 渲染 `/brand/agent-<id>.webp`，透明背景、三主题无需变量或滤镜（白色机体在暗色画布天然成立）；加载不引起布局偏移；状态徽记由 Web 组件独立渲染，Forced Colors 下插画保留原色并以系统色描边界定形状。
5. 已命名按钮内的图标为装饰图像；独立信息图像由调用方提供可访问名称。状态徽记在 Forced Colors 下使用系统色，并始终有形状或文字作为非颜色线索。
6. `scripts/generate-brand-icons.mjs` 是全部身份插画的唯一事实来源（母版 PNG 提交在 `web/public/brand/`）；`pnpm brand:check` 以 sha256 manifest 阻止产物漂移。

## 非目标

- 不向用户暴露图标选择器或 `workerIconId` 输入。
- 不让图标决定 Worker 能力、模型、权限或路由。
- 不要求每个 Channel 拥有全局唯一形状；形状、标题、ID 和状态共同帮助区分。
- 不提交设计过程中的 PNG 预览、中间版本或第三方参考图片。

## 权威实现与产物

- 生成器：`scripts/generate-brand-icons.mjs`（`pnpm brand:generate` / `pnpm brand:check`）
- 服务端分配：`src/brand/agent-icon.ts`, `src/storage/sqlite-store.ts`
- Channel 投影：`src/channel/work-channel.ts`
- Web 渲染：`web/src/PegasAgentIcon.tsx`, `web/src/agent-icon-id.ts`
- 产物：`web/public/brand/agent-{bot,car,camera,computer,phone}.webp`（256×256 无损、全透明背景）与同源母版 `pegas-mascot.png`、`worker-{car,camera,computer,phone}.png`。旧手绘 SVG、Tabler 线性 sprite（`scripts/generate-agent-icons.mjs`、`web/src/agent-icon-sprite.ts`、`web/src/pegas-agents.svg`）与 `icons:generate`/`icons:check` 脚本均已删除。

身份插画由生成器裁切 alpha 边距后等比缩放居中到 256 透明画布。
更换插画时替换母版 PNG 并运行 `pnpm brand:generate`，同步更新
`test/agent-icon-assets.test.ts` 的尺寸/体积约束。

## 生成与检查

重新生成全部品牌位图（需要 python3 + Pillow）：

```bash
pnpm brand:generate
```

只读检查已提交产物是否缺失或与 manifest 漂移（纯 Node，CI 可运行）：

```bash
pnpm brand:check
```

`pnpm check` 会自动执行漂移检查。扩展新图标时：

1. 制作同风格透明插画母版 PNG，放入 `web/public/brand/` 并登记到生成器 `agentSourceNames`/`agentIconIds`；
2. 把 Worker 类型加入 `src/brand/agent-icon.ts` 和 Web 类型/注册表；
3. 运行 `pnpm brand:generate`；
4. 增加分配、迁移、小尺寸与状态徽记测试。

旧 Task 已经保存 `worker_icon_id`，因此扩大分配池只影响此后创建的 Channel。

## 数据、权限与恢复边界

图标资产无外部依赖，不读取用户内容。数据库 migration 11 为 Task 增加内部
`worker_icon_id`；历史 Task 由稳定哈希回填，新 Task 在创建事务内写入。API
只返回该值，不接受客户端写入。

生成失败时保留已有文件，修复脚本后重新运行即可。旧版本忽略新增列，因此代码回滚不需回写 Task；若物理回滚 schema，应从迁移前备份恢复数据库。

## 验证证据

- `pnpm brand:check`：确认版源文件及派生产物与 SHA-256 manifest 一致。
- `web/src/PegasAgentIcon.test.tsx`：五个身份逐一指向对应透明插画、显式宽高占位、装饰/具名可访问性与五状态徽记。
- `test/agent-icon-assets.test.ts`：五个身份资产为 256×256 带透明通道的 WebP、RIFF 长度自洽、体积 5KB–120KB、母版 PNG 齐全、manifest 覆盖。
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

### 渲染管线演进（2026-11-21）

外部 sprite `<use>` 曾在首帧未解码导致 Worker 图标列空白，第一版修复把
sprite 内联进文档（`PegasAgentSprite` 单例 + 文档内 fragment）。随
BRAND-002 透明插画落地，身份图标改为直接 `<img>` 引用同源 WebP（显式
宽高占位、`decoding="async"`），内联 sprite 管线整体退役；首帧不再有
`<use>` 解码竞态，位图按普通图片资源缓存加载。
