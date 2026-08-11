# Matrix Agent

AI-Native 浏览器集群 —— 把「指纹浏览器」和「AI Agent」合二为一的桌面自动化平台。

用自然语言下达任务，AI 自主调度多个相互隔离的指纹浏览器实例完成工作：多账号矩阵运营、数据采集、定时巡检……任务完成后每一步都有截图与推理留痕，遇到验证码自动暂停交真人处理。

> MVP v2.0 · 基于 Electron + React + Playwright-core + better-sqlite3

## 功能一览

**指纹浏览器集群**
- 多 Profile 隔离：每个 Profile 独立 `userDataDir`、独立指纹（osPreset 派生 + 种子化噪声）、独立代理
- Profile 分组管理、克隆、导入导出（含 Cookies 导入导出）
- 内置「指纹自测」：一键打开 bot.sannysoft.com 肉眼核对指纹
- 登录态检测：自定义检测规则，任务前自动验证登录状态
- 代理连通性检测：出口 IP + 延迟一键测

**AI 任务执行**
- 自然语言任务：观察（aria snapshot + `data-mx-idx` 打标）→ 决策（OpenAI 兼容 LLM，JSON 动作协议，三级兜底解析）→ 执行（playwright-core）循环
- 批量任务：一条指令下发到多个 Profile 并行执行，结果聚合
- 多 Profile 切换：任务可携带 Profile 池，Agent 执行中按需 `switch_profile` 切换操作对象（原浏览器保持打开）
- 流程录制与回放：AI 探路一次成功后自动录制动作序列；回放**完全不调 LLM**，xpath 失效时按 tag+文本模糊匹配自愈，自愈失败才交回 LLM 接管
- 上下文管理：近期 N 步完整快照 + 远期压缩摘要，50K 字符预算自动裁剪
- 防卡死：连续 N 步页面状态指纹不变自动暂停并询问人工

**任务调度与留痕**
- 队列 + 双信号量并发控制（浏览器并发保护本机性能、LLM 并发保护 API 速率），同 Profile 串行互斥
- 失败重试（默认同 Profile 重试，登录态绑定 userDataDir）、崩溃恢复（Recovery 启动序列：任务修复 / 孤儿进程清理 / 锁文件）
- 任务历史：每步截图 + 推理过程 + 动作记录，可点开回溯完整执行过程
- 实时查看：任务执行中可一键把对应浏览器窗口置前

**人机协同**
- 验证码 / 人机验证自动暂停并弹窗：展示截图 + AI 推理 + 最近动作，真人接手完成验证后继续（或终止）
- LLM 多次非法输出、疑似卡死、页面出现验证码关键词都会触发人工确认

**自动化与通知**
- 定时任务：interval（每 N 分钟）/ daily（每日 HH:MM）两种规则，多 Profile 自动走批量任务
- 终态通知：桌面通知 + Webhook（钉钉 / 企微 / 自建服务），批量子任务聚合通知不刷屏

**安全**
- LLM Key 等敏感配置经 Electron `safeStorage` 加密存储（secure-store）
- 任务模板、流程库、Profile 分组等全部持久化在本地 SQLite

## 技术栈

| 层 | 技术 |
|---|---|
| 桌面框架 | Electron 36（主进程 Node） |
| UI | React 18 + Tailwind CSS 3 + Vite 7（electron-vite 4） |
| 浏览器自动化 | playwright-core（`launchPersistentContext`，系统 Chrome 优先，不内置 Chromium） |
| 存储 | better-sqlite3（WAL 模式 + schema_version 迁移） |
| LLM | 任意 OpenAI 兼容 API（Base URL + Key + 模型名可配） |
| 密钥 | Electron safeStorage |

## 快速开始

### 前置条件

- Node.js ≥ 20
- 系统安装 Chrome（未安装则运行 `npx playwright-core install chromium` 装兜底 Chromium）
- 一个 OpenAI 兼容 API Key（应用内「设置」页配置）

### 安装与运行
- 下载并运行releases中的安装包

## 使用指南

典型工作流：

1. **建 Profile**：Profile 页新建，设置分组、指纹可调项（屏幕尺寸 / 时区 / 语言 / 硬件并发数）、代理
2. **登录态准备**：点「打开」手动登录目标站点 → 关闭浏览器 → 配置登录检测规则（可选）
3. **下任务**：工作台输入自然语言指令，勾选「依赖登录态」并指定 Profile；多账号场景勾选多个 Profile 走批量任务
4. **人机协同**：遇到验证码自动弹窗，真人处理完成后点「继续」
5. **复用**：任务成功后自动录制为流程，之后可直接回放（不耗 LLM）；也可存为任务模板定时执行

### 验收场景

1. **匿名任务**：`打开 Google，搜索 'AI Agent'，把前 3 个结果的标题提取给我`
2. **登录态任务**：Profile 页「打开」手动登录 → 关闭浏览器 → 下达任务（勾选「依赖登录态」并指定该 Profile）
3. **人机协同任务**：访问触发验证码的页面 → 观察暂停弹窗（截图 + 推理 + 真人接手 / 继续 / 终止）全流程

## 架构速览

```
src/
├── main/                    # Electron 主进程
│   ├── index.ts             # 入口（Recovery 启动序列：DB → 恢复 → 装配 → IPC → 窗口 → 调度恢复）
│   ├── browser-manager.ts   # launchPersistentContext + CDP UA override + addInitScript
│   ├── chrome-locator.ts    # 系统 Chrome 探测（用户指定 → 自动检测 → Playwright Chromium 兜底）
│   ├── fingerprint.ts       # osPreset 派生 + 种子化噪声注入脚本
│   ├── serializer.ts        # aria snapshot + data-mx-idx 打标 + 页面状态指纹
│   ├── agent-core.ts        # 观察-决策-执行主循环（上下文管理 / 卡死检测 / 验证码检测）
│   ├── action-protocol.ts   # JSON 动作协议三级兜底解析
│   ├── llm-client.ts        # OpenAI 兼容客户端 + LLM 并发信号量
│   ├── task-scheduler.ts    # 队列 + 双信号量 + Profile 互斥 + 重试 + 多 Profile 池
│   ├── flow-runner.ts       # 流程回放引擎（无 LLM 确定性执行 + xpath 自愈）
│   ├── schedule-runner.ts   # 定时任务（interval / daily）
│   ├── recovery.ts          # 崩溃恢复（任务修复 / 孤儿进程 / 锁文件）
│   ├── profile-manager.ts   # Profile CRUD / 克隆 / 导入导出
│   ├── login-checker.ts     # 登录态检测
│   ├── proxy-checker.ts     # 代理连通性检测
│   ├── db.ts                # SQLite + WAL + schema_version 迁移
│   ├── secure-store.ts      # safeStorage 封装
│   ├── window-manager.ts    # 窗口管理
│   ├── notifier.ts          # 桌面通知 + Webhook
│   └── ipc.ts               # IPC 注册 + 人机协同桥
├── preload/index.ts         # contextBridge 白名单 API
├── renderer/                # React UI（工作台 / Profile / 任务 / 自动化 / 设置）
└── shared/                  # 类型 / IPC 常量 / 默认设置 / osPreset 预设包
```

## 数据存储

运行时数据（数据库、Profile userDataDir、任务快照日志）位于 `{userData}/matrix-agent/`，不在安装目录（避免写权限问题），卸载重装不影响数据：

```
{userData}/matrix-agent/
├── data.db                 # SQLite（profiles / tasks / steps / flows / schedules / templates ...）
├── profiles/{profileId}/   # 各 Profile 的 userDataDir（登录态、Cookies、指纹注入）
└── logs/{taskId}/          # 每步快照 step-N.txt + 截图 step-N.jpg
```

- 开发模式：`%APPDATA%\matrix-agent\matrix-agent\`
- 打包安装后：`%APPDATA%\Matrix Agent\matrix-agent\`（productName 决定，互不影响）

## 配置项

设置页可配（均有默认值）：LLM Base URL / Key / 模型 / Max Tokens / Temperature / 并发数、Chrome 路径、最大并发 Profile 数、headless、任务最大步数、快照历史窗口、人机确认开关、最大重试次数、每步截图开关、桌面通知 / Webhook URL / 事件过滤。

## 已知边界（如实说明）

- 库存 Chrome + CDP 路线存在检测天花板：目标是常规电商/社媒检测，**不承诺**过 CreepJS / FingerprintJS Pro / Cloudflare Turnpike 等强检测
- 未做（后续阶段）：批量任务的分布式编排、可视化流程编辑器、指纹硬化清单、内嵌实时画面 / 录像回放、HTTP API
- 流程回放的确定性执行依赖页面结构稳定；页面改版时依赖 tag+文本自愈与 LLM 兜底接管
- 打包默认使用项目自带图标（`build/icon.png`，512×512，Logosc 生成）；如需更换替换该文件后重新 `npm run dist`

## License

MIT
