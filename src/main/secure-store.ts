/**
 * ADR-6：敏感信息存储 —— Electron safeStorage。
 * LLM API Key、代理密码等敏感字段一律经 safeStorage.encryptString() 加密后落库。
 * 系统级密钥管理（Windows DPAPI / macOS Keychain / Linux kwallet 等），零自研风险。
 *
 * 降级：极少数 Linux 环境无可用密钥后端时，以 'plain:' 前缀明文存储并在日志中告警，
 * 绝不静默假装已加密。
 */
import { safeStorage } from 'electron';

const PLAIN_PREFIX = 'plain:';

export function isEncryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

export function encryptString(plain: string): string {
  if (!plain) return '';
  if (!isEncryptionAvailable()) {
    console.warn('[secure-store] safeStorage 不可用，敏感字段将以明文降级存储！');
    return PLAIN_PREFIX + plain;
  }
  return safeStorage.encryptString(plain).toString('base64');
}

export function decryptString(stored: string): string {
  if (!stored) return '';
  if (stored.startsWith(PLAIN_PREFIX)) return stored.slice(PLAIN_PREFIX.length);
  try {
    return safeStorage.decryptString(Buffer.from(stored, 'base64'));
  } catch (err) {
    console.error('[secure-store] 解密失败（密钥库变更？）:', err);
    return '';
  }
}
