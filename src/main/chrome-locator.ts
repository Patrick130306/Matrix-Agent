/**
 * 浏览器内核解析（§15 Chromium 策略 v2：内置 Chromium 随包分发）。
 * 优先级：用户指定路径 → 自动检测系统 Chrome → 内置 Chromium（打包资源 / dev 用 playwright 缓存）。
 * 内置 Chromium 保证开箱即用（无系统 Chrome 也能跑）；cookie 存各 Profile 独立 userDataDir，与内核无关。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

/** dev 模式 playwright 缓存中的内置 Chromium（revision 1228，已验证兼容 playwright-core 1.54） */
const BUNDLED_REVISION = 'chromium-1228';

function firstExisting(candidates: (string | undefined)[]): string | null {
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

/** 内置 Chromium：打包后位于 resources/chromium/；开发模式直接复用 playwright 缓存 */
function detectBundledChromium(): string | null {
  const resourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath;
  const candidates = [
    resourcesPath && path.join(resourcesPath, 'chromium', 'chrome-win64', 'chrome.exe'),
    process.env.LOCALAPPDATA &&
      path.join(process.env.LOCALAPPDATA, 'ms-playwright', BUNDLED_REVISION, 'chrome-win64', 'chrome.exe'),
  ];
  return firstExisting(candidates);
}

function detectWindows(): string | null {
  const suffix = path.join('Google', 'Chrome', 'Application', 'chrome.exe');
  const candidates = [
    process.env['PROGRAMFILES'] && path.join(process.env['PROGRAMFILES'], suffix),
    process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], suffix),
    process.env['LOCALAPPDATA'] && path.join(process.env['LOCALAPPDATA'], suffix),
  ];

  const found = firstExisting(candidates);
  if (found) return found;

  // 注册表兜底（HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe）
  try {
    const out = execSync(
      'reg query "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe" /ve',
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const m = out.match(/REG_SZ\s+(.+\.exe)/i);
    if (m && fs.existsSync(m[1].trim())) return m[1].trim();
  } catch {
    /* 忽略，继续 */
  }
  return null;
}

function detectMac(): string | null {
  return firstExisting([
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    process.env.HOME &&
      path.join(process.env.HOME, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
  ]);
}

function detectLinux(): string | null {
  for (const cmd of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    try {
      const out = execSync(`which ${cmd}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      if (out && fs.existsSync(out)) return out;
    } catch {
      /* 尝试下一个 */
    }
  }
  return null;
}

/** 自动检测系统 Chrome，找不到返回 null（交由 Playwright Chromium 兜底）。 */
export function detectSystemChrome(): string | null {
  switch (process.platform) {
    case 'win32':
      return detectWindows();
    case 'darwin':
      return detectMac();
    default:
      return detectLinux();
  }
}

/**
 * 解析最终 executablePath。
 * 优先级：用户指定 → 系统 Chrome → 内置 Chromium；全找不到返回 undefined（由 playwright 兜底并报错提示）。
 */
export function resolveChromeExecutable(userSpecified?: string): string | undefined {
  if (userSpecified && fs.existsSync(userSpecified)) return userSpecified;
  return detectSystemChrome() ?? detectBundledChromium() ?? undefined;
}
