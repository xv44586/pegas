# Pegas Agent 图标资产

> Feature：BRAND-001
>
> 状态：Usable
> 更新日期：2026-11-19

## 用户结果

Pegas 使用自己的图标系统替代 DS Bot 鲸鱼形象。主入口固定为 Pegas
机器人；每个新 Channel 由服务端自动分配并持久化一个 Worker 图标，用户不能指定或修改
`workerIconId`。Worker 图标随 Channel 五种状态改变背景色，形状保持稳定。

## 验收条件

1. Pegas 主入口、主页、设置和消息身份始终使用 `bot`，Channel 不使用第三方角色形象。
2. 新 Channel 只从 `car`、`camera`、`computer`、`phone` 中由系统确定性分配；分配结果写入 Task，扩展图标库不会重排旧 Channel。
3. `backlog`、`unstarted`、`started`、`completed`、`cancelled` 分别使用紫、琥珀、蓝、绿、灰背景；状态同时有文字，不只依赖颜色。
4. 图标通过同源 SVG sprite 的 `<use>` 复用，并通过 `--pegas-icon-background` 与 `--pegas-icon-foreground` 接收状态主题。
5. 已命名按钮内的图标为装饰图像；独立信息图像由调用方提供可访问名称。所有状态色与白色前景至少满足 3:1 图形对比度。
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
4. 增加分配、迁移、小尺寸与状态色测试。

旧 Task 已经保存 `worker_icon_id`，因此扩大分配池只影响此后创建的 Channel。

## 数据、权限与恢复边界

图标资产无外部依赖，不读取用户内容。数据库 migration 11 为 Task 增加内部
`worker_icon_id`；历史 Task 由稳定哈希回填，新 Task 在创建事务内写入。API
只返回该值，不接受客户端写入。

生成失败时保留已有文件，修复脚本后重新运行即可。旧版本忽略新增列，因此代码回滚不需回写 Task；若物理回滚 schema，应从迁移前备份恢复数据库。

## 验证证据

- `pnpm icons:check`：五个独立 SVG 和一个 sprite 与生成器完全一致。
- 自动化覆盖确定性分配、非法第三方 ID、历史数据回填、API 投影、旧服务兼容和 UI 状态类。
- 浏览器截图覆盖 Pegas 固定机器人、Channel 多形状、五状态配色和收缩侧栏。
- 完整门禁：`pnpm check`, `pnpm smoke`。

## 剩余风险与下一缺口

仍需 VoiceOver/NVDA 实机验证和正式暗色主题。Forced Colors 下使用系统
`Highlight` / `HighlightText`，状态仍通过相邻文字或可访问描述表达。
