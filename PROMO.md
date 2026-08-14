> **AI-Native 浏览器集群:一条自然语言指令,调度 N 个隔离指纹浏览器(开源)**

把「指纹浏览器」和「AI Agent」合二为一的开源项目 **Matrix Agent**——不再需要手动配置十几个浏览器环境、写一堆脚本去操作页面,而是用自然语言告诉它做什么,它自己调度、执行、留痕。

项目地址:https://github.com/Patrick130306/Matrix-Agent (MIT,免费)

---

## 它解决什么问题

多账号矩阵运营(电商 / 社媒 / 采集)有三座大山:

1. **环境隔离**:每个账号需要独立浏览器环境 + 独立指纹 + 独立代理
2. **重复劳动**:登录、巡检、批量操作,全是机械动作
3. **过程不可控**:出问题不知道哪一步错了,验证码卡住就断

Matrix Agent 把这三点打包解决:指纹浏览器集群管环境,AI Agent 管执行,逐步留痕 + 录像管回溯。

## 核心能力

- **AI 任务执行**:自然语言指令 → 观察 → 决策 → 执行闭环,支持任意 OpenAI 兼容 API(Base URL / Key / 模型均可配)
- **指纹浏览器集群**:多 Profile 隔离,每个 Profile 独立 userDataDir / 指纹 / 代理;分组管理、克隆、导入导出(含 Cookies)
- **批量任务**:一条指令下发到多个 Profile 并行执行,结果自动聚合;任务可携带 Profile 池,执行中按需切换
- **流程录制与回放**:AI 探路成功后自动录制动作序列,回放完全不调用 LLM;xpath 失效时按 tag+文本模糊匹配自愈,自愈失败才交回 LLM 接管
- **人机协同**:验证码 / 人机验证自动暂停并弹窗(截图 + AI 推理 + 最近动作),真人处理完继续
- **定时任务**:interval / daily 两种规则,多 Profile 自动走批量任务
- **通知**:桌面通知 + Webhook(钉钉 / 企微 / 自建)
- **留痕**:每步截图 + 推理过程 + 完整执行录像(webm),任务详情可回放

## 反检测(面向常规电商/社媒场景)

- Stealth 补丁:webdriver 抹除、自动化标志禁用、permissions / plugins / fonts 保真、Accept-Language q 值
- 拟人行为:贝塞尔鼠标轨迹、逐字符随机打字节奏、分段随机滚动
- 指纹一致性:CPU 核心数受显卡档次约束、按 OS 注入系统字体列表
- **代理出口指纹联动**:填好代理后一键根据出口 IP 生成匹配的时区 / Locale / 语言
- **WebRTC 泄露检测**:检测 ICE 候选是否绕过代理暴露真实 IP

> 边界说明:方案面向常规电商/社媒检测,不承诺过 CreepJS / FingerprintJS Pro 等强检测;对抗级指纹需源码级内核改造,留待后续。

## 技术栈

| 层 | 技术 |
|---|---|
| 桌面框架 | Electron 36(单 EXE 安装包) |
| UI | React 18 + Tailwind CSS + Vite 7 |
| 浏览器自动化 | playwright-core(系统 Chrome 优先) |
| 存储 | better-sqlite3(WAL + schema 迁移) |
| 密钥 | Electron safeStorage 加密 |

## 为什么开源

为爱发电,顺便验证"指纹浏览器 + Agent"这个方向值不值得做。代码完全自研,零闭源依赖。

如果你也在做矩阵运营 / 自动化,欢迎试用、提 Issue / PR。觉得有用点个 ⭐,让更多人看到。

GitHub: https://github.com/Patrick130306/Matrix-Agent
