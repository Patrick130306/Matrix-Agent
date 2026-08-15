/**
 * 全局代理池：批量导入（每行一条代理）→ 一键并发验证 → 分配给 Profile 使用。
 *
 * 导入格式（每行一条，支持三种形态）：
 *   host:port
 *   host:port:user:pass
 *   protocol://host:port:user:pass   （protocol: http / https / socks5）
 *
 * 分配策略：Profile 设置 proxyPoolId 后，启动浏览器时从池中随机取一个 status=ok 的条目
 * （优先最近验证通过的；无 ok 则取 unknown 尝试）。
 */
import crypto from 'node:crypto';
import type { Profile, ProxyPoolEntry, ProxyPoolEntryInput, ProxyType } from '@shared/types';
import { PROXY_CHECK_CONCURRENCY, PROXY_POOL_AUTO_ID } from '@shared/constants';
import { getProxyEntry, listProxyPool, upsertProxyEntry } from './db';
import { checkProxyConfig } from './proxy-checker';
import { decryptString, encryptString } from './secure-store';
import type { Settings } from '@shared/types';

/** 解析批量导入文本 → 代理条目输入列表（跳过空行与格式错误行，返回解析报告） */
export function parseProxyList(text: string): {
  entries: ProxyPoolEntryInput[];
  skipped: string[];
} {
  const entries: ProxyPoolEntryInput[] = [];
  const skipped: string[] = [];

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const parsed = parseProxyLine(line);
    if (!parsed) {
      skipped.push(line.slice(0, 80));
      continue;
    }
    entries.push(parsed);
  }
  return { entries, skipped };
}

function parseProxyLine(line: string): ProxyPoolEntryInput | null {
  // 形态三：protocol://host:port:user:pass
  let m = line.match(/^(https?|socks5):\/\/(.+)$/i);
  if (m) {
    const type = m[1].toLowerCase() as ProxyType;
    const rest = m[2];
    const parts = rest.split(':');
    if (parts.length < 2) return null;
    const host = parts[0];
    const port = Number(parts[1]);
    if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
    const user = parts.length > 2 ? parts.slice(2, -1).join(':') : undefined;
    const pass = parts.length > 3 ? parts[parts.length - 1] : undefined;
    return { type, host, port, username: user || undefined, passwordEnc: pass ? encryptString(pass) : undefined };
  }

  // 形态一/二：host:port[:user:pass]
  const parts = line.split(':');
  if (parts.length < 2) return null;
  const host = parts[0];
  const port = Number(parts[1]);
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
  const user = parts.length > 2 ? parts[2] : undefined;
  const pass = parts.length > 3 ? parts[3] : undefined;
  return { type: 'http', host, port, username: user || undefined, passwordEnc: pass ? encryptString(pass) : undefined };
}

/** 把解析出的条目落库（重复 host:port 去重）。 */
export function addProxyEntries(entries: ProxyPoolEntryInput[]): number {
  const existing = new Set(listProxyPool().map((e) => `${e.type}://${e.host}:${e.port}`));
  let added = 0;
  for (const e of entries) {
    const key = `${e.type}://${e.host}:${e.port}`;
    if (existing.has(key)) continue;
    existing.add(key);
    const entry: ProxyPoolEntry = {
      id: crypto.randomUUID(),
      ...e,
      status: 'unknown',
      createdAt: new Date().toISOString(),
    };
    upsertProxyEntry(entry);
    added++;
  }
  return added;
}

/** 一键验证：并发检查全部条目，结果写回 DB。返回汇总 {ok, fail, unknown}。 */
export async function checkAllProxies(settings: Settings): Promise<{ ok: number; fail: number; total: number }> {
  const entries = listProxyPool();
  if (entries.length === 0) return { ok: 0, fail: 0, total: 0 };

  let ok = 0;
  let fail = 0;
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (cursor < entries.length) {
      const idx = cursor++;
      const entry = entries[idx];
      try {
        const ip = await checkProxyConfig(
          {
            type: entry.type,
            host: entry.host,
            port: entry.port,
            username: entry.username,
            password: entry.passwordEnc ? decryptString(entry.passwordEnc) : '',
          },
          settings,
        );
        entry.status = 'ok';
        entry.ip = ip;
        entry.lastError = undefined;
        ok++;
      } catch (err) {
        entry.status = 'fail';
        entry.ip = undefined;
        entry.lastError = (err as Error).message.slice(0, 200);
        fail++;
      }
      entry.checkedAt = new Date().toISOString();
      upsertProxyEntry(entry);
    }
  };

  const workers = Array.from({ length: Math.min(PROXY_CHECK_CONCURRENCY, entries.length) }, () => worker());
  await Promise.all(workers);
  return { ok, fail, total: entries.length };
}

/** 池绑定特殊值：Profile.proxyPoolId = POOL_AUTO_ID 表示绑定整个池，每次启动自动轮换取可用代理 */
export const POOL_AUTO_ID = PROXY_POOL_AUTO_ID;

/**
 * 为 Profile 解析出最终代理配置：
 * - proxyPoolId = POOL_AUTO_ID：绑定整个池，LRU 轮换取一条可用代理（任务间自动换 IP）；
 * - proxyPoolId = 具体条目 id：固定用该条（失败时自动换池内其他可用）；
 * - 未设置池：用自身 proxyType/host/port 配置。
 */
export function resolveProxyConfig(
  profile: Profile,
): { server: string; username?: string; password?: string } | undefined {
  if (profile.proxyPoolId) {
    let entry: ProxyPoolEntry | null = null;
    if (profile.proxyPoolId === POOL_AUTO_ID) {
      entry = pickFromPool(); // 整池轮换
    } else {
      entry = getProxyEntry(profile.proxyPoolId);
      if (entry && entry.status === 'fail') entry = pickFromPool(); // 固定条失效 → 池内换可用
    }
    if (entry) {
      // 分配后记录使用时间（LRU 轮换依据）
      entry.lastAssignedAt = new Date().toISOString();
      upsertProxyEntry(entry);
      return {
        server: `${entry.type}://${entry.host}:${entry.port}`,
        username: entry.username || undefined,
        password: entry.passwordEnc ? decryptString(entry.passwordEnc) : '',
      };
    }
    // 池里没有可用代理 → 回退直连（不阻塞任务，浏览器启动时由上层提示）
    return undefined;
  }
  if (profile.proxyType === 'none' || !profile.proxyHost || !profile.proxyPort) return undefined;
  const server = `${profile.proxyType}://${profile.proxyHost}:${profile.proxyPort}`;
  const password = profile.proxyPasswordEnc ? decryptString(profile.proxyPasswordEnc) : '';
  return {
    server,
    username: profile.proxyUsername || undefined,
    password: password || undefined,
  };
}

/** 浏览器启动失败时标记该代理不可用（下次分配自动跳过；供调度器在启动失败后调用并换一条重试） */
export function markProxyFailed(poolId: string, error: string): void {
  const entry = getProxyEntry(poolId);
  if (!entry) return;
  entry.status = 'fail';
  entry.lastError = error.slice(0, 200);
  entry.checkedAt = new Date().toISOString();
  upsertProxyEntry(entry);
}

/**
 * 从池中按 LRU 取可用代理：优先 status=ok（最近验证），其次 unknown（未验证过，尝试性使用）；
 * 同一优先级内选 lastAssignedAt 最旧（闲置最久）的，实现任务间自动轮换。
 */
function pickFromPool(): ProxyPoolEntry | null {
  const all = listProxyPool();
  if (all.length === 0) return null;
  const ok = all.filter((e) => e.status === 'ok');
  const unknown = all.filter((e) => e.status === 'unknown');
  const candidates = ok.length > 0 ? ok : unknown;
  if (candidates.length === 0) return null;
  // 闲置最久优先（lastAssignedAt 最旧 / 从未分配过的排最前）
  candidates.sort((a, b) => {
    const ta = a.lastAssignedAt ? new Date(a.lastAssignedAt).getTime() : 0;
    const tb = b.lastAssignedAt ? new Date(b.lastAssignedAt).getTime() : 0;
    return ta - tb;
  });
  return candidates[0];
}
