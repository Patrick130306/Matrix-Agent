/**
 * 代理检测：验证 Profile 的代理配置是否可用，返回出口 IP + 延迟。
 *
 * - 直连（proxyType = none）：主进程直接 fetch IP 回显服务；
 * - 代理：起一个临时 headless Chrome 走该代理访问回显服务（Playwright 原生支持代理认证），
 *   这样测的是「浏览器真实出口」，与实际跑任务时的链路完全一致。
 */
import { chromium } from 'playwright-core';
import type { Profile, ProxyCheckResult, ProxyType, Settings } from '@shared/types';
import { resolveChromeExecutable } from './chrome-locator';
import { decryptString } from './secure-store';

const ECHO_URL = 'https://api.ipify.org?format=json';
const FETCH_TIMEOUT_MS = 10_000;
const BROWSER_TIMEOUT_MS = 25_000;

/** 未落库的代理配置快照（新建 Profile 表单里也能用） */
export interface ProxyConfig {
  type: ProxyType;
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export async function checkProfileProxy(profile: Profile, settings: Settings): Promise<ProxyCheckResult> {
  const started = Date.now();
  try {
    const out =
      profile.proxyType === 'none' || !profile.proxyHost || !profile.proxyPort
        ? await checkDirect()
        : await checkViaBrowser(
            {
              type: profile.proxyType,
              host: profile.proxyHost,
              port: profile.proxyPort,
              username: profile.proxyUsername,
              password: profile.proxyPasswordEnc ? decryptString(profile.proxyPasswordEnc) : '',
            },
            settings,
          );
    const { webrtcIps, webrtcLeak } = detectWebRtcLeak(out.ip, out.webrtcIps);
    return {
      ok: true,
      ip: out.ip,
      latencyMs: Date.now() - started,
      webrtcIps,
      webrtcLeak,
      checkedAt: new Date().toISOString(),
    };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: (err as Error).message.slice(0, 200),
      checkedAt: new Date().toISOString(),
    };
  }
}

/** 独立入口：给定代理配置（可以是未保存的表单值），返回出口 IP。 */
export async function checkProxyConfig(proxy: ProxyConfig, settings: Settings): Promise<string> {
  if (proxy.type === 'none' || !proxy.host || !proxy.port) throw new Error('代理配置不完整');
  return (await checkViaBrowser(proxy, settings)).ip;
}

/** 直连出口：主进程 fetch 即可（不需要浏览器） */
async function checkDirect(): Promise<{ ip: string; webrtcIps: string[] }> {
  const res = await fetch(ECHO_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`回显服务 HTTP ${res.status}`);
  const data = (await res.json()) as { ip?: string };
  if (!data.ip) throw new Error('回显服务未返回 IP');
  return { ip: data.ip, webrtcIps: [] };
}

/** 代理出口：临时 headless Chrome 走代理访问回显服务 */
async function checkViaBrowser(proxy: ProxyConfig, settings: Settings): Promise<{ ip: string; webrtcIps: string[] }> {
  const browser = await chromium.launch({
    executablePath: resolveChromeExecutable(settings.chromeExecutablePath),
    headless: true,
    proxy: {
      server: `${proxy.type}://${proxy.host}:${proxy.port}`,
      username: proxy.username || undefined,
      password: proxy.password || undefined,
    },
  });
  try {
    const page = await browser.newPage();
    await page.goto(ECHO_URL, { waitUntil: 'domcontentloaded', timeout: BROWSER_TIMEOUT_MS });
    const text = await page.evaluate(() => document.body?.innerText ?? '');
    const match = text.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/) ?? text.match(/"ip"\s*:\s*"([^"]+)"/);
    if (!match) throw new Error('未从回显页面解析到 IP');
    const ip = match[1] ?? match[0];
    // WebRTC 泄露检测：收集 ICE 候选 IP（STUN 走系统网络栈，可能绕过代理暴露真实 IP）
    const webrtcIps = (await page.evaluate(WEBRTC_PROBE_SCRIPT).catch(() => [])) as string[];
    return { ip, webrtcIps };
  } finally {
    await browser.close().catch(() => undefined);
  }
}

/** 页面内执行的 WebRTC 探测：建 RTCPeerConnection 收集 ICE 候选里的 IPv4，5s 超时。 */
const WEBRTC_PROBE_SCRIPT = `
  () => new Promise((resolve) => {
    try {
      const ips = new Set();
      const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
      pc.createDataChannel('mx');
      pc.onicecandidate = (e) => {
        if (e.candidate) {
          const m = String(e.candidate.candidate).match(/(\\d{1,3}(?:\\.\\d{1,3}){3})/);
          if (m) ips.add(m[1]);
        } else {
          resolve([...ips]);
        }
      };
      pc.createOffer().then((o) => pc.setLocalDescription(o)).catch(() => resolve([...ips]));
      setTimeout(() => resolve([...ips]), 5000);
    } catch { resolve([]); }
  })
`;

/** 判定：候选里出现 ≠ 出口 IP 的非私有地址 = 泄露 */
function detectWebRtcLeak(exitIp: string, webrtcIps: string[]): { webrtcIps: string[]; webrtcLeak: boolean } {
  const ips = [...new Set(webrtcIps ?? [])];
  const leaks = ips.filter((ip) => ip !== exitIp && !isPrivateIp(ip));
  return { webrtcIps: ips, webrtcLeak: leaks.length > 0 };
}

function isPrivateIp(ip: string): boolean {
  if (/^10\./.test(ip) || /^192\.168\./.test(ip) || /^127\./.test(ip) || /^169\.254\./.test(ip)) return true;
  if (/^0\.0\.0\.0$/.test(ip)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  if (/^::1$/.test(ip) || /^fe80::/i.test(ip) || /^::/.test(ip)) return true;
  if (ip.toLowerCase().endsWith('.local')) return true; // mDNS 占位
  return false;
}
