/**
 * 代理检测：验证 Profile 的代理配置是否可用，返回出口 IP + 延迟。
 *
 * - 直连（proxyType = none）：主进程直接 fetch IP 回显服务；
 * - 代理：起一个临时 headless Chrome 走该代理访问回显服务（Playwright 原生支持代理认证），
 *   这样测的是「浏览器真实出口」，与实际跑任务时的链路完全一致。
 */
import { chromium } from 'playwright-core';
import type { Profile, ProxyCheckResult, Settings } from '@shared/types';
import { resolveChromeExecutable } from './chrome-locator';
import { decryptString } from './secure-store';

const ECHO_URL = 'https://api.ipify.org?format=json';
const FETCH_TIMEOUT_MS = 10_000;
const BROWSER_TIMEOUT_MS = 25_000;

export async function checkProfileProxy(profile: Profile, settings: Settings): Promise<ProxyCheckResult> {
  const started = Date.now();
  try {
    const ip =
      profile.proxyType === 'none' || !profile.proxyHost || !profile.proxyPort
        ? await checkDirect()
        : await checkViaBrowser(profile, settings);
    return { ok: true, ip, latencyMs: Date.now() - started, checkedAt: new Date().toISOString() };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: (err as Error).message.slice(0, 200),
      checkedAt: new Date().toISOString(),
    };
  }
}

/** 直连出口：主进程 fetch 即可（不需要浏览器） */
async function checkDirect(): Promise<string> {
  const res = await fetch(ECHO_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`回显服务 HTTP ${res.status}`);
  const data = (await res.json()) as { ip?: string };
  if (!data.ip) throw new Error('回显服务未返回 IP');
  return data.ip;
}

/** 代理出口：临时 headless Chrome 走代理访问回显服务 */
async function checkViaBrowser(profile: Profile, settings: Settings): Promise<string> {
  const password = profile.proxyPasswordEnc ? decryptString(profile.proxyPasswordEnc) : '';
  const browser = await chromium.launch({
    executablePath: resolveChromeExecutable(settings.chromeExecutablePath),
    headless: true,
    proxy: {
      server: `${profile.proxyType}://${profile.proxyHost}:${profile.proxyPort}`,
      username: profile.proxyUsername || undefined,
      password: password || undefined,
    },
  });
  try {
    const page = await browser.newPage();
    await page.goto(ECHO_URL, { waitUntil: 'domcontentloaded', timeout: BROWSER_TIMEOUT_MS });
    const text = await page.evaluate(() => document.body?.innerText ?? '');
    const match = text.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/) ?? text.match(/"ip"\s*:\s*"([^"]+)"/);
    if (!match) throw new Error('未从回显页面解析到 IP');
    return match[1] ?? match[0];
  } finally {
    await browser.close().catch(() => undefined);
  }
}
