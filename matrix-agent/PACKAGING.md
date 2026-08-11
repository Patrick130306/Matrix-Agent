# Matrix Agent 打包说明（Windows）

> 写给执行打包的人（hermes）：按本文档操作，**先通读「已踩过的坑」再动手**，能省掉几个小时。

## 目标产物

NSIS 安装包：`release/Matrix Agent Setup 0.1.0.exe`（版本号以 package.json 为准）。
配置在 `electron-builder.json`，已调好，**不要改 `npmRebuild: false`**（原因见下）。

## 打包前置状态

打包出来的是**纯净初始状态**，无需任何额外清理：

- 所有用户数据（Profile、LLM Key、任务、截图）都写在运行时的 `{userData}/matrix-agent/` 目录（见 `src/main/db.ts`），**不在工程目录里，也不会进安装包**。
- 开发态 userData = `%APPDATA%\matrix-agent\`；安装包 productName = "Matrix Agent"，装好后 userData = `%APPDATA%\Matrix Agent\`，目录不同，即使装在本机也是全新状态。

## 标准流程

```bash
cd /d D:\kimi_workspaces\matrix_agent\matrix-agent   # Git Bash；或 cd 到该目录（cmd）

# 0. 确认没有残留的打包进程（有就杀掉，否则缓存文件被占用会报奇怪错误）
tasklist //FI "IMAGENAME eq node.exe"

# 1. 类型检查 + 构建
cmd //c "node_modules\.bin\tsc.cmd --noEmit"          # Git Bash 下 tsc 要这么调
cmd //c "node_modules\.bin\electron-vite.cmd build"

# 2. 设置镜像环境变量后打包（关键！不设会因连不上 GitHub 失败）
#    cmd 写法：
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/&& npm run dist
#    PowerShell 写法：
$env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"; npm run dist

# 3. 产物在 release/ 下
```

electron-builder 还会读 `ELECTRON_MIRROR`（Electron 运行时 zip 的镜像）。Electron dist zip 在本机已下载进缓存（`%LOCALAPPDATA%\electron\Cache`），如果换机器/清过缓存，再加：

```
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
```

## 已踩过的坑（重要）

### 坑 1：node-gyp 编译 better-sqlite3 必失败 → 已修，勿回退

本机**没装 Visual Studio**，`npmRebuild: true` 时 electron-builder 会用 node-gyp 源码编译 better-sqlite3，必炸。
现状：`electron-builder.json` 里 `npmRebuild: false`，直接打包 `node_modules/better-sqlite3/build/Release/better_sqlite3.node`——这个二进制是 `postinstall`（`scripts/rebuild-native.mjs`）用 prebuild-install 拉的 **Electron ABI 预编译二进制**，dev 下运行正常，可直接打包。
**换机器时**：`npm install` 后确认 `node_modules\better-sqlite3\build\Release\better_sqlite3.node` 存在；若 `npm install` 的 postinstall 失败，手动跑一次 `node scripts/rebuild-native.mjs`。

### 坑 2：electron-builder 下载依赖连不上 GitHub → 用镜像 + 手动灌缓存

electron-builder 打包时要下载两样东西，默认源都在 GitHub，直连会 `ETIMEDOUT` / `ECONNRESET`：

1. **Electron dist zip**（约 100MB）：设 `ELECTRON_BUILDER_BINARIES_MIRROR`（如上）即可走 npmmirror，**本机已缓存成功，不用再下**。
2. **NSIS 工具链两个 7z**：即使设了镜像也可能 404 / 连接重置（npmmirror 的目录布局和 electron-builder 预期不完全一致）。**最稳的办法是手动下载后灌进缓存目录**，electron-builder 带 sha256 校验，校验通过就直接用、不再联网。

需要手动灌缓存的两个文件（从 `node_modules/app-builder-lib/out/toolsets/windows.js` 读到的精确信息）：

| 文件 | 缓存路径（%LOCALAPPDATA%\electron-builder\Cache\ 下） | SHA256 |
|---|---|---|
| `nsis-3.0.4.1.7z` | `nsis-3.0.4.1\nsis-3.0.4.1.7z` | `9877df902530f96357d13a7a31ae2b9df67f48b11ffc9a1700a7c961574ec5fa` |
| `nsis-resources-3.4.1.7z` | `nsis-resources-3.4.1\nsis-resources-3.4.1.7z` | `593a9a92ef958321293ac6a2ee61e64bf1bd543142a5bd6b3d310709cc924103` |

即完整路径：

```
C:\Users\<用户名>\AppData\Local\electron-builder\Cache\nsis-3.0.4.1\nsis-3.0.4.1.7z
C:\Users\<用户名>\AppData\Local\electron-builder\Cache\nsis-resources-3.4.1\nsis-resources-3.4.1.7z
```

候选下载源（按可用性逐个试，哪个通用哪个）：

```
https://npmmirror.com/mirrors/electron-builder-binaries/nsis-3.0.4.1.7z          # 注意：此扁平路径实测 404，需先试带版本目录的形式
https://npmmirror.com/mirrors/electron-builder-binaries/nsis-3.0.4.1/nsis-3.0.4.1.7z
https://cdn.npmmirror.com/binaries/electron-builder-binaries/nsis-3.0.4.1.7z
https://registry.npmmirror.com/-/binary/electron-builder-binaries/                # 目录列表，先 curl 它确认真实路径布局
https://github.com/electron-userland/electron-builder-binaries/releases/download/nsis-3.0.4.1/nsis-3.0.4.1.7z   # 官方源（需代理）
```

nsis-resources 同理（文件名换成 `nsis-resources-3.4.1.7z`，release tag 为 `nsis-resources-3.4.1`）。

**下载后必须校验**（校验不过 electron-builder 会重新联网下载，然后再次失败）：

```cmd
certutil -hashfile "C:\Users\<用户名>\AppData\Local\electron-builder\Cache\nsis-3.0.4.1\nsis-3.0.4.1.7z" SHA256
```

比对上表，一致再跑打包。Electron zip + 两个 NSIS 7z 都在缓存后，**整个打包过程无需联网**。

### 坑 3：打包耗时长，前台等会超时

`npm run dist` 全流程（vite build + 打包）可能 3~10 分钟。建议后台跑 + 轮询日志：

```bash
# Git Bash：
powershell -NoProfile -Command "Start-Process cmd.exe -ArgumentList '/c npm run dist > release-log.txt 2>&1' -WorkingDirectory 'D:\kimi_workspaces\matrix_agent\matrix-agent' -WindowStyle Hidden"
sleep 50 && tail release-log.txt   # 反复轮询直到出现 artifact created
```

成功标志：日志出现 `building target=nsis` → `artifact created`，`release/` 下生成 `Matrix Agent Setup 0.1.0.exe`。

### 兜底方案（NSIS 实在搞不定）

把 `electron-builder.json` 的 `"win": { "target": ["nsis"] }` 改成：

- `["zip"]`：绿色压缩包，解压即用，不需要 NSIS；或
- `["dir"]`：只产出 `release/win-unpacked/` 文件夹（里面有 `Matrix Agent.exe`），自己压缩分发。

这两条路径不需要 NSIS 工具链，Electron zip 已缓存即可全程离线完成。

## 打包后验证

1. 安装到一台**没跑过开发版**的机器（或确认 `%APPDATA%\Matrix Agent\` 不存在）。
2. 首次启动：设置页 LLM Key 为空、Profile 列表为空、任务列表为空——即为纯净初始状态。
3. 填一个 OpenAI 兼容 Key，跑验收场景 1（README）确认端到端可用。

## 其他说明

- `npmRebuild: false` 的前提下，打包**不依赖** Visual Studio / Python / node-gyp。
- better-sqlite3 已配 `asarUnpack`，原生二进制会以松散文件形式随包分发，属正常。
- mac 的 dmg target 在配置里但没验证过，Windows 打包请忽略。
