/**
 * 更新检查：查询 GitHub Release 最新版本，与当前版本比较。
 * 直连 GitHub 可能不通，失败静默返回 null（不打扰用户）。
 */
import { app } from 'electron';

const REPO = 'Patrick130306/Matrix-Agent';
const API = `https://api.github.com/repos/${REPO}/releases/latest`;
const TIMEOUT_MS = 8000;

export interface UpdateCheckResult {
  current: string;
  latest: string;
  hasUpdate: boolean;
  url: string; // release 页
  notes?: string; // release body（截断）
}

/** 当前应用版本（package.json version） */
export function currentVersion(): string {
  return app.getVersion();
}

function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

export async function checkForUpdate(): Promise<UpdateCheckResult | null> {
  try {
    const res = await fetch(API, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'matrix-agent' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      tag_name?: string;
      html_url?: string;
      body?: string;
    };
    const latest = data.tag_name ?? '';
    const current = currentVersion();
    if (!latest) return null;
    return {
      current,
      latest,
      hasUpdate: compareVersions(latest, current) > 0,
      url: data.html_url ?? `https://github.com/${REPO}/releases/latest`,
      notes: data.body?.slice(0, 600),
    };
  } catch {
    return null; // 网络不通 / 超时：静默
  }
}
