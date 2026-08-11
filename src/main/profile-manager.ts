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
import { DEFAULT_PROFILE_TUNABLES } from '@shared/constants';
import { deleteProfile, getProfile, getProfilesDir, listProfiles, upsertProfile } from './db';
import { encryptString } from './secure-store';

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
