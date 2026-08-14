/**
 * §11.1 Profile Manager：创建 / 编辑 / 删除 / 克隆 / 导入导出。
 *
 * - 创建：选择 osPreset + 可调项 → 生成 userDataDir；
 * - 克隆：复制配置，生成新 userDataDir 与新 id（id 变了 → 噪声种子也变，
 *   克隆体的 Canvas/Audio 指纹与原 Profile 不同，这正是期望行为，§6.3）；
 * - 删除：关闭浏览器 → 删数据目录 → 删 DB 记录。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Profile, ProfileInput } from '@shared/types';
import { DEFAULT_PROFILE_TUNABLES, PROXY_CHECK_CONCURRENCY } from '@shared/constants';
import { deleteProfile, getProfile, getProfilesDir, listProfiles, upsertProfile } from './db';
import { encryptString } from './secure-store';
import { resolveProxyConfig } from './proxy-pool';
import { checkProxyConfig } from './proxy-checker';
import { suggestFingerprint } from './geo';
import type { Settings } from '@shared/types';

export class ProfileManager {
  constructor(private readonly closeBrowser: (profileId: string) => Promise<void>) {}

  list(): Profile[] {
    return listProfiles();
  }

  get(id: string): Profile | null {
    return getProfile(id);
  }

  create(input: ProfileInput): Profile {
    const id = crypto.randomUUID();
    const profile: Profile = {
      ...DEFAULT_PROFILE_TUNABLES,
      ...input,
      languages: input.languages?.length ? input.languages : [input.locale || 'en-US'],
      id,
      userDataDir: path.join(getProfilesDir(), id),
      status: 'idle',
      createdAt: new Date().toISOString(),
    };
    fs.mkdirSync(profile.userDataDir, { recursive: true });
    upsertProfile(profile);
    return profile;
  }

  update(id: string, patch: Partial<ProfileInput>): Profile {
    const existing = getProfile(id);
    if (!existing) throw new Error(`Profile 不存在: ${id}`);
    const next: Profile = { ...existing, ...patch, id: existing.id, userDataDir: existing.userDataDir };
    upsertProfile(next);
    return next;
  }

  /**
   * 批量创建 Profile（矩阵运营入口）：
   * - 名称前缀 + 数量 N → 生成 N 个独立 Profile（新 id = 新指纹种子）；
   * - 可选绑定代理池条目（poolIds 循环分配）；
   * - 绑定代理时自动验证出口 IP 并生成匹配的时区/语言指纹（并发受限，防打爆回显服务）。
   * 返回创建的 Profile 列表 + 成功生成指纹的数量。
   */
  async batchCreate(
    input: { prefix: string; count: number; poolIds?: string[] },
    settings: Settings,
  ): Promise<{ profiles: Profile[]; fingerprintApplied: number }> {
    const count = Math.min(50, Math.max(1, Math.floor(Number(input.count) || 1)));
    const prefix = input.prefix?.trim() || '新 Profile';

    const created: Profile[] = [];
    for (let i = 0; i < count; i++) {
      const poolId = input.poolIds?.length ? input.poolIds[i % input.poolIds.length] : undefined;
      const profile = this.create({
        ...DEFAULT_PROFILE_TUNABLES,
        osPreset: 'win11-chrome',
        proxyType: 'none',
        languages: [...DEFAULT_PROFILE_TUNABLES.languages],
        name: count > 1 ? `${prefix} ${i + 1}` : prefix,
        proxyPoolId: poolId,
      });
      created.push(profile);
    }

    // 绑定代理的：并发验证出口 IP → 生成时区/语言指纹（直连不验证，保持默认指纹）
    const toFingerprint = created.filter((p) => p.proxyPoolId);
    if (toFingerprint.length === 0) return { profiles: created, fingerprintApplied: 0 };

    let fingerprintApplied = 0;
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < toFingerprint.length) {
        const idx = cursor++;
        const profile = toFingerprint[idx];
        try {
          const proxy = resolveProxyConfig(profile);
          if (!proxy) continue;
          const parsed = parseProxyServer(proxy.server);
          if (!parsed) continue;
          const ip = await checkProxyConfig(
            { type: parsed.type, host: parsed.host, port: parsed.port, username: proxy.username, password: proxy.password },
            settings,
          );
          const s = await suggestFingerprint(ip);
          this.update(profile.id, {
            timezone: s.timezone,
            locale: s.locale,
            languages: s.languages,
            proxyCheck: { ok: true, ip, latencyMs: 0, checkedAt: new Date().toISOString() },
          });
          fingerprintApplied++;
        } catch {
          // 验证失败：保留默认指纹，代理条目标记失败由用户后续处理
          continue;
        }
      }
    };

    const workers = Array.from({ length: Math.min(PROXY_CHECK_CONCURRENCY, toFingerprint.length) }, () => worker());
    await Promise.all(workers);
    return { profiles: created, fingerprintApplied };
  }

  /** 克隆：新 id + 新 userDataDir（不复制登录态目录，避免 Cookie 关联；需要登录态请用导出/导入场景自行评估）。 */
  clone(id: string): Profile {
    const source = getProfile(id);
    if (!source) throw new Error(`Profile 不存在: ${id}`);
    return this.create({
      name: `${source.name} (副本)`,
      groupId: source.groupId,
      osPreset: source.osPreset,
      screenWidth: source.screenWidth,
      screenHeight: source.screenHeight,
      timezone: source.timezone,
      locale: source.locale,
      languages: [...source.languages],
      hardwareConcurrency: source.hardwareConcurrency,
      deviceMemory: source.deviceMemory,
      proxyType: source.proxyType,
      proxyHost: source.proxyHost,
      proxyPort: source.proxyPort,
      proxyUsername: source.proxyUsername,
      proxyPasswordEnc: source.proxyPasswordEnc,
    });
  }

  /** 删除：关闭浏览器 → 删数据目录 → 删 DB 记录。 */
  async remove(id: string): Promise<void> {
    await this.closeBrowser(id).catch(() => undefined);
    const profile = getProfile(id);
    if (profile) {
      try {
        fs.rmSync(profile.userDataDir, { recursive: true, force: true });
      } catch (err) {
        console.warn(`[profile] 数据目录删除失败（稍后重试或手动删除）: ${profile.userDataDir}`, err);
      }
    }
    deleteProfile(id);
  }

  /** 导出（不含代理密码密文之外的任何明文敏感信息；导出为 JSON 字符串）。 */
  export(id: string): string {
    const profile = getProfile(id);
    if (!profile) throw new Error(`Profile 不存在: ${id}`);
    const { userDataDir, status, lastUsedAt, ...rest } = profile;
    return JSON.stringify({ ...rest, exportedAt: new Date().toISOString(), format: 'matrix-agent-profile@1' }, null, 2);
  }

  /** 导入 JSON（兼容本应用导出格式；代理密码明文会自动加密）。 */
  import(json: string): Profile {
    const raw = JSON.parse(json) as Partial<Profile> & { proxyPassword?: string };
    if (!raw || typeof raw !== 'object' || !raw.osPreset) {
      throw new Error('导入文件格式不正确');
    }
    return this.create({
      name: raw.name ? `${raw.name} (导入)` : '导入的 Profile',
      groupId: raw.groupId,
      osPreset: raw.osPreset,
      screenWidth: raw.screenWidth ?? DEFAULT_PROFILE_TUNABLES.screenWidth,
      screenHeight: raw.screenHeight ?? DEFAULT_PROFILE_TUNABLES.screenHeight,
      timezone: raw.timezone ?? DEFAULT_PROFILE_TUNABLES.timezone,
      locale: raw.locale ?? DEFAULT_PROFILE_TUNABLES.locale,
      languages: raw.languages?.length ? raw.languages : [...DEFAULT_PROFILE_TUNABLES.languages],
      hardwareConcurrency: raw.hardwareConcurrency ?? DEFAULT_PROFILE_TUNABLES.hardwareConcurrency,
      deviceMemory: raw.deviceMemory ?? DEFAULT_PROFILE_TUNABLES.deviceMemory,
      proxyType: raw.proxyType ?? 'none',
      proxyHost: raw.proxyHost,
      proxyPort: raw.proxyPort,
      proxyUsername: raw.proxyUsername,
      // 优先使用密文（同机器导出/导入）；明文则加密
      proxyPasswordEnc: raw.proxyPasswordEnc ?? (raw.proxyPassword ? encryptString(raw.proxyPassword) : undefined),
    });
  }
}

/** 解析 "http://host:port" / "socks5://host:port" 形态的 server 字符串（批量创建自动指纹用） */
function parseProxyServer(server: string): { type: 'http' | 'https' | 'socks5'; host: string; port: number } | null {
  const m = server.match(/^(https?|socks5):\/\/([^:/]+):(\d+)$/);
  if (!m) return null;
  return { type: m[1] as 'http' | 'https' | 'socks5', host: m[2], port: Number(m[3]) };
}
