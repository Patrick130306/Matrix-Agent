/**
 * Chromium 管理器：用户可在设置页按需下载浏览器内核（Chrome for Testing，Google 官方源直连）。
 *
 * 设计：
 * - 安装包不内置 Chromium（保持小体积）；首次使用可一键下载，也可选版本；
 * - 存储：{userData}/chromium/{version}/chrome-win64/chrome.exe；
 * - 下载：curl 直连 Google storage（已验证可达），解压用系统 PowerShell Expand-Archive（流式，零依赖）；
 * - 进度：下载中在目录写 {version}.downloading.json（{received,total}），UI 轮询展示进度条。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { getDataRoot } from './db';

export interface ChromiumVersion {
  version: string; // Chrome for Testing 版本号
  label: string; // UI 展示名
  url: string; // 下载地址
  sizeMB: number; // 已知大小（进度显示）
}

/** 可选版本表（Chrome for Testing 官方源；版本号必须存在于 known-good 列表） */
export const CHROMIUM_VERSIONS: ChromiumVersion[] = [
  {
    version: '151.0.7922.34',
    label: 'Chromium 151（推荐 · 与当前 Playwright 配套）',
    url: 'https://storage.googleapis.com/chrome-for-testing-public/151.0.7922.34/win64/chrome-win64.zip',
    sizeMB: 201,
  },
  {
    version: '128.0.6613.84',
    label: 'Chromium 128（旧版 · 兼容老站 / 常规检测更宽松）',
    url: 'https://storage.googleapis.com/chrome-for-testing-public/128.0.6613.84/win64/chrome-win64.zip',
    sizeMB: 192,
  },
];

export function chromiumRoot(): string {
  return path.join(getDataRoot(), 'chromium');
}

/** 已安装内核的可执行文件路径（{userData}/chromium/{version}/chrome-win64/chrome.exe） */
export function chromiumExecutable(version: string): string {
  return path.join(chromiumRoot(), version, 'chrome-win64', 'chrome.exe');
}

/** 扫描已安装内核（目录存在且 chrome.exe 存在），按版本号降序（最新优先） */
export function listInstalledChromium(): string[] {
  const root = chromiumRoot();
  if (!fs.existsSync(root)) return [];
  try {
    return fs
      .readdirSync(root)
      .filter((d) => fs.existsSync(chromiumExecutable(d)))
      .sort((a, b) => compareVersion(b, a));
  } catch {
    return [];
  }
}

function compareVersion(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

// ---------------------------------------------------------------- 下载

interface DownloadState {
  version: string;
  received: number;
  total: number;
  status: 'downloading' | 'extracting' | 'done' | 'error';
  error?: string;
}

function stateFile(version: string): string {
  return path.join(chromiumRoot(), `${version}.downloading.json`);
}

function readState(version: string): DownloadState | null {
  try {
    return JSON.parse(fs.readFileSync(stateFile(version), 'utf8')) as DownloadState;
  } catch {
    return null;
  }
}

function writeState(s: DownloadState): void {
  fs.mkdirSync(chromiumRoot(), { recursive: true });
  fs.writeFileSync(stateFile(s.version), JSON.stringify(s));
}

/** 查询版本状态：已安装 / 下载中（进度）/ 未安装 */
export function getChromiumStatus(version: string):
  | { installed: true; executable: string }
  | { installed: false; downloading?: DownloadState } {
  const exe = chromiumExecutable(version);
  if (fs.existsSync(exe)) return { installed: true, executable: exe };
  return { installed: false, downloading: readState(version) ?? undefined };
}

/** 下载并解压指定版本（幂等：已安装直接返回）。阻塞直到完成或抛错。 */
export async function downloadChromium(version: string): Promise<string> {
  const info = CHROMIUM_VERSIONS.find((v) => v.version === version);
  if (!info) throw new Error(`未知版本：${version}`);
  const exe = chromiumExecutable(version);
  if (fs.existsSync(exe)) return exe;

  fs.mkdirSync(chromiumRoot(), { recursive: true });
  const zipPath = path.join(chromiumRoot(), `${version}.zip`);
  const destDir = path.join(chromiumRoot(), version);

  try {
    // 1. 下载（curl 直连 Google storage；--retry 网络抖动重试）
    writeState({ version, received: 0, total: info.sizeMB * 1024 * 1024, status: 'downloading' });
    await runWithProgress('curl', ['-L', '--fail', '--retry', '3', '-o', zipPath, info.url], info.sizeMB * 1024 * 1024, (received) =>
      writeState({ version, received, total: info.sizeMB * 1024 * 1024, status: 'downloading' }),
    );
    if (!fs.existsSync(zipPath) || fs.statSync(zipPath).size < 1_000_000) {
      throw new Error('下载失败（文件不完整），请检查网络后重试');
    }

    // 2. 解压（PowerShell Expand-Archive 流式）
    writeState({ version, received: info.sizeMB * 1024 * 1024, total: info.sizeMB * 1024 * 1024, status: 'extracting' });
    fs.mkdirSync(destDir, { recursive: true });
    await execAsync('powershell', [
      '-NoProfile',
      '-Command',
      `Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force`,
    ]);
    fs.rmSync(zipPath, { force: true });

    if (!fs.existsSync(exe)) throw new Error('解压后未找到 chrome.exe（版本结构异常）');
    writeState({ version, received: info.sizeMB * 1024 * 1024, total: info.sizeMB * 1024 * 1024, status: 'done' });
    fs.rmSync(stateFile(version), { force: true });
    return exe;
  } catch (err) {
    writeState({
      version,
      received: fs.existsSync(zipPath) ? fs.statSync(zipPath).size : 0,
      total: info.sizeMB * 1024 * 1024,
      status: 'error',
      error: (err as Error).message.slice(0, 300),
    });
    fs.rmSync(zipPath, { force: true });
    throw err;
  }
}

/** 删除已安装的指定版本内核（释放磁盘） */
export function removeChromium(version: string): void {
  fs.rmSync(path.join(chromiumRoot(), version), { recursive: true, force: true });
  fs.rmSync(stateFile(version), { force: true });
}

// ---------------------------------------------------------------- 工具

function runWithProgress(
  cmd: string,
  args: string[],
  total: number,
  onProgress: (received: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let last = 0;
    const timer = setInterval(() => {
      try {
        const p = args[args.indexOf('-o') + 1];
        if (p && fs.existsSync(p)) {
          const size = fs.statSync(p).size;
          if (size !== last) {
            last = size;
            onProgress(size);
          }
        }
      } catch {
        /* 忽略 */
      }
    }, 500);
    child.on('error', (err) => {
      clearInterval(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearInterval(timer);
      if (code === 0) resolve();
      else reject(new Error(`${cmd} 退出码 ${code}`));
    });
  });
}

function execAsync(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err) =>
      err ? reject(err) : resolve(),
    );
  });
}
