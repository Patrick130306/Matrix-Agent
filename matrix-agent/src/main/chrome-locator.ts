/**
 * 系统 Chrome 探测（§15 Chromium 策略）。
 * 优先级：用户指定路径 → 自动检测系统 Chrome → Playwright Chromium 兜底。
 * playwright-core 不下载二进制；打包不内置 Chromium（避免安装包膨胀 150MB+）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

function firstExisting(candidates: (string | undefined)[]): string | null {
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
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
 * 返回 undefined 表示交给 playwright-core 使用其注册表中的 Chromium（需 `npx playwright-core install chromium`）。
 */
export function resolveChromeExecutable(userSpecified?: string): string | undefined {
  if (userSpecified && fs.existsSync(userSpecified)) return userSpecified;
  return detectSystemChrome() ?? undefined;
}
