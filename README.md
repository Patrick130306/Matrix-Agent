# Matrix Agent

AI-Native 浏览器集群 —— 把「指纹浏览器」和「AI Agent」合二为一的桌面自动化平台。

用自然语言下达任务，AI 自主调度多个相互隔离的指纹浏览器实例完成工作：多账号矩阵运营、数据采集、定时巡检……任务完成后每一步都有截图与推理留痕，遇到验证码自动暂停交真人处理。

> MVP v3.0 · 基于 Electron + React + Playwright-core + better-sqlite3

## 功能一览

**指纹浏览器集群**
- 多 Profile 隔离：每个 Profile 独立 `userDataDir`、独立指纹（osPreset 派生 + 种子化噪声）、独立代理
- **批量创建**：名称前缀 + 数量一键生成 N 个独立 Profile；可选绑定代理池，自动分配代理并逐个按出口 IP 生成匹配指纹
- **全局代理池**：批量导入（host:port:user:pass / URL 格式）→ 一键并发验证（出口 IP + 延迟）→ Profile 绑定池内条目自动分配
- Profile 分组管理、克隆、导入导出（含 Cookies 导入导出）
- 内置「指纹自测」：一键打开 bot.sannysoft.com 肉眼核对指纹
- 反检测体系：webdriver 抹除 + 自动化标志禁用 + permissions/plugins 保真 + Accept-Language q 值 + **WebGL readPixels 种子噪声** + **拟人行为模拟**（思考延迟 / hover 预热 / 逐字符输入节奏 / 分段滚动，设置可关）
- 代理出口指纹联动：填写代理后一键「根据出口 IP 生成指纹」，自动把时区 / Locale / 语言对齐到出口 IP 地理位置（**直连也支持**，取本机出口 IP）
- 登录态检测：自定义检测规则，任务前自动验证登录状态
- 代理连通性检测：出口 IP + 延迟一键测

**AI 任务执行**
- 自然语言任务：观察（aria snapshot + `data-mx-idx` 打标）→ 决策（OpenAI 兼容 LLM，JSON 动作协议，三级兜底解析）→ 执行（playwright-core）循环
- 批量任务：一条指令下发到多个 Profile 并行执行，结果聚合
- 多 Profile 切换：任务可携带 Profile 池，Agent 执行中按需 `switch_profile` 切换操作对象（原浏览器保持打开）
- 流程录制与回放：AI 探路一次成功后自动录制动作序列；回放**完全不调 LLM**，xpath 失效时按 tag+文本模糊匹配自愈，自愈失败才交回 LLM 接管
- **流程可视化编辑**：步骤上移 / 下移 / 删除 / 改参数（URL、输入文本、选项、等待时长），保存后回放按新顺序执行
- 上下文管理：近期 N 步完整快照 + 远期压缩摘要，50K 字符预算自动裁剪
- 防卡死：连续 N 步页面状态指纹不变自动暂停并询问人工

**任务调度与留痕**
- 队列 + 双信号量并发控制（浏览器并发保护本机性能、LLM 并发保护 API 速率），同 Profile 串行互斥
- 失败重试（默认同 Profile 重试，登录态绑定 userDataDir）、崩溃恢复（Recovery 启动序列：任务修复 / 孤儿进程清理 / 锁文件）
- **任务仪表盘**：成功率 / 平均耗时 / LLM token 用量 / 成本估算（设置里填单价）
- 任务历史：每步截图 + 推理过程 + 动作记录，可点开回溯完整执行过程
- 实时查看：任务执行中可一键把对应浏览器窗口置前

**人机协同**
- 验证码 / 人机验证自动暂停并弹窗：展示截图 + AI 推理 + 最近动作，真人接手完成验证后继续（或终止）
- 接管后智能豁免：同一验证码不会反复弹窗打断，LLM 非法输出、疑似卡死同样触发人工确认

**自动化与通知**
- 定时任务：interval（每 N 分钟）/ daily（每日 HH:MM）两种规则，多 Profile 自动走批量任务
- **结构化采集**：内置模板（电商商品 / 订单 / 社媒 / 搜索）+ 自定义模板，多页翻页采集，结果自动合并为表格并导出 CSV
- 终态通知：桌面通知 + Webhook（钉钉 / 企微 / 自建服务），批量子任务聚合通知不刷屏

**外观与安全**
- **亮色 / 深色主题**：设置页一键切换，立即生效，两套主题同等精致
- LLM Key 等敏感配置经 Electron `safeStorage` 加密存储（secure-store）
- 任务模板、流程库、Profile 分组、代理池等全部持久化在本地 SQLite

## 技术栈

| 层 | 技术 |
|---|---|
| 桌面框架 | Electron 36（主进程 Node） |
| UI | React 18 + Tailwind CSS 3 + Vite 7（electron-vite 4） |
| 浏览器自动化 | playwright-core（`launchPersistentContext`，系统 Chrome 优先，不内置 Chromium） |
| 存储 | better-sqlite3（WAL 模式 + schema_version 迁移） |
| LLM | 任意 OpenAI 兼容 API（Base URL + Key + 模型名可配） |
| 密钥 | Electron safeStorage |

## 安装与使用（Windows EXE）

> 不想折腾源码/Node 环境的用户走这条：到 Releases 下载安装包直接装。

1. **下载安装**：Releases 页下载 `Matrix Agent Setup <版本>.exe`，双击安装（NSIS 安装包，无需 Node / 无需配置环境）
2. **首次启动**：打开「Matrix Agent」→ 左侧「设置」→ 填 LLM 配置：
   - Base URL：你的 OpenAI 兼容 API 地址（如 `https://api.openai.com/v1` 或任意中转站）
   - API Key：你的密钥（经系统密钥库加密存储，不明文落盘）
   - 模型：如 `gpt-4o-mini` / `deepseek-chat`（填你服务商支持的）
   - 点「测试连通性」确认 → 保存设置
3. **建 Profile（浏览器环境）**：Profile 管理页「新建」→ 填名称，按需调指纹（时区 / 语言 / 屏幕 / CPU）/ 代理；矩阵运营可直接「批量创建」，一次生成 N 个独立环境
4. **发任务**：工作台输入自然语言指令 →「开始执行」。例如：
   - `打开 bing，搜索 "AI Agent"，提取前 3 个标题`
   - `登录后把今天的订单数和待发货数提取给我`
5. **遇到验证码**：自动暂停弹窗（附截图 + Agent 最近动作），你在浏览器里手动过掉验证码后点「我已处理，继续」
6. **复用**：任务成功后自动录成流程，到「自动化」页可秒级回放（不耗 LLM）；也可建定时任务每天自动跑

常用功能入口：
- 工作台：发任务、任务列表、执行日志、成功率/耗时/LLM 成本统计
- Profile 管理：新建 / 批量创建 / 克隆 / 导入导出 / 指纹自测 / 登录态检测
- 自动化：定时任务、流程回放与编辑、结构化采集（内置模板）、任务模板
- 设置：LLM、浏览器、Agent 参数、主题（深色/亮色）、代理池、通知

> 注意：Agent 驱动的是你系统里已安装的 Chrome（通过 CDP），无需额外安装浏览器；未装 Chrome 时可在设置里指定 Chromium 路径。

## 快速开始（开发者）

### 前置条件

- Node.js ≥ 20
- 系统安装 Chrome（未安装则运行 `npx playwright-core install chromium` 装兜底 Chromium）
- 一个 OpenAI 兼容 API Key（应用内「设置」页配置）

### 安装与运行

```bash
npm install        # postinstall 自动拉取 better-sqlite3 的 Electron ABI 预编译二进制
npm run dev        # 开发模式（electron-vite，带 HMR）
```

### 常用命令

```bash
npm run typecheck  # TypeScript 类型检查
npm run build      # 构建产物到 dist/
npm run dist       # 打包 Windows 安装包，产物在 release/
```

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

## 更新日志

### 2026-08-11 — v0.2.0 反检测与代理指纹联动

- **反检测补丁（首档 stealth）**：在既有 webdriver 抹除 + `--disable-blink-features` 之上，新增
  - `navigator.permissions.query` 通知权限返回真实 Chrome 的 `prompt`（自动化环境常被检测为 `denied`）
  - `navigator.plugins` / `mimeTypes` 保真：注入真实 Chrome 的 PDF 插件组（含 `item` / `namedItem`）
  - `window.chrome` 保真：headless / 非 Chrome 内核缺失时补齐 `app` / `csi` / `loadTimes`
  - Accept-Language 头按真实浏览器 q 值格式生成（`en-US,en;q=0.9`），不再逗号直拼
- **代理出口指纹联动**：Profile 表单新增「根据出口 IP 生成指纹」——走代理实测出口 IP（与任务同链路）→ 查 IP 归属（ip-api.com，自动降级 ipwho.is）→ 自动回填时区 / Locale / 语言列表，与代理地理位置对齐；新建未保存的表单同样可用
- **拟人行为模拟**：点击走贝塞尔鼠标轨迹（非瞬移）、输入逐字符随机节奏 + 偶尔停顿、滚动分段随机步长
- **指纹一致性修正**：CPU 核心数受显卡档次约束（核显预设不出现 32 核）、按 OS 注入常见系统字体列表（fonts 指纹保真）
- **WebRTC 泄露检测**：代理检测同时收集 ICE 候选 IP，识别绕过代理暴露真实 IP 的泄露并红色告警
- **任务执行录像**：设置页开关（默认关），任务详情内嵌 webm 回放完整操作过程（media:// 本地协议，路径校验防越权）
- 修复：代理检测逻辑拆分为可复用入口，供未落库的表单配置使用

### 2026-08-10 — 首个 MVP（内部迭代，对外发布为 v0.2.0）

- 指纹浏览器集群：多 Profile 隔离（独立 userDataDir / 指纹 / 代理）、分组管理、克隆、导入导出（含 Cookies）
- AI 任务执行：自然语言指令 → 观察-决策-执行闭环，任意 OpenAI 兼容 API
- 批量任务 / 流程录制回放（回放不耗 LLM）/ 定时任务 / 人机协同验证码处理
- 登录态检测、代理连通性检测、桌面通知 + Webhook
- LLM Key 经 Electron safeStorage 加密存储

## 已知边界（如实说明）

- 库存 Chrome + CDP 路线存在检测天花板：已内置首档 stealth 补丁（webdriver / 自动化标志 / permissions / plugins / Accept-Language），面向常规电商/社媒检测；**不承诺**过 CreepJS / FingerprintJS Pro / Cloudflare Turnpike 等强检测（需源码级 patch 或 camoufox 级内核改造）
- 未做（后续阶段）：批量任务的分布式编排、可视化流程编辑器、指纹硬化清单、内嵌实时画面 / 录像回放、HTTP API
- 流程回放的确定性执行依赖页面结构稳定；页面改版时依赖 tag+文本自愈与 LLM 兜底接管
- 打包默认使用项目自带图标（`build/icon.png`，512×512，Logosc 生成）；如需更换替换该文件后重新 `npm run dist`

## License

MIT
