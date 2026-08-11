/**
 * 出口 IP → 地理指纹：查 IP 归属地，给出与该地区一致的时区 / Locale / 语言列表建议。
 *
 * 用途：新建/编辑 Profile 时填了代理，一键把时区语言对齐到代理出口的真实位置，
 * 避免「美国代理 + 中文时区」这类被强检测一眼识破的穿帮。
 *
 * 数据源：ip-api.com 免费 http 端点（无需 key，45 req/min）；失败时降级 ipwho.is。
 */
import type { GeoFingerprintSuggestion } from '@shared/types';

const GEO_TIMEOUT_MS = 10_000;

interface GeoLookup {
  country: string;
  countryCode: string;
  city?: string;
  timezone: string;
}

/** 常见国家 → 默认 Locale + 语言列表（语言首项与 locale 一致，与真实浏览器习惯对齐） */
const COUNTRY_LOCALE: Record<string, { locale: string; languages: string[] }> = {
  US: { locale: 'en-US', languages: ['en-US', 'en'] },
  GB: { locale: 'en-GB', languages: ['en-GB', 'en'] },
  CA: { locale: 'en-CA', languages: ['en-CA', 'en'] },
  AU: { locale: 'en-AU', languages: ['en-AU', 'en'] },
  SG: { locale: 'en-SG', languages: ['en-SG', 'en', 'zh-SG'] },
  IN: { locale: 'en-IN', languages: ['en-IN', 'en'] },
  JP: { locale: 'ja-JP', languages: ['ja-JP', 'ja'] },
  KR: { locale: 'ko-KR', languages: ['ko-KR', 'ko'] },
  DE: { locale: 'de-DE', languages: ['de-DE', 'de'] },
  FR: { locale: 'fr-FR', languages: ['fr-FR', 'fr'] },
  IT: { locale: 'it-IT', languages: ['it-IT', 'it'] },
  ES: { locale: 'es-ES', languages: ['es-ES', 'es'] },
  NL: { locale: 'nl-NL', languages: ['nl-NL', 'nl'] },
  BR: { locale: 'pt-BR', languages: ['pt-BR', 'pt'] },
  PT: { locale: 'pt-PT', languages: ['pt-PT', 'pt'] },
  RU: { locale: 'ru-RU', languages: ['ru-RU', 'ru'] },
  TR: { locale: 'tr-TR', languages: ['tr-TR', 'tr'] },
  ID: { locale: 'id-ID', languages: ['id-ID', 'id'] },
  TH: { locale: 'th-TH', languages: ['th-TH', 'th'] },
  VN: { locale: 'vi-VN', languages: ['vi-VN', 'vi'] },
  MX: { locale: 'es-MX', languages: ['es-MX', 'es'] },
  AR: { locale: 'es-AR', languages: ['es-AR', 'es'] },
  TW: { locale: 'zh-TW', languages: ['zh-TW', 'zh'] },
  HK: { locale: 'zh-HK', languages: ['zh-HK', 'zh'] },
  CN: { locale: 'zh-CN', languages: ['zh-CN', 'zh'] },
};

const DEFAULT_LOCALE = { locale: 'en-US', languages: ['en-US', 'en'] };

/** 查询 IP 归属（ip-api.com 主，ipwho.is 备） */
async function lookupGeo(ip: string): Promise<GeoLookup> {
  try {
    const res = await fetch(`http://ip-api.com/json/${ip}?fields=status,message,country,countryCode,city,timezone,query`, {
      signal: AbortSignal.timeout(GEO_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`ip-api HTTP ${res.status}`);
    const d = (await res.json()) as {
      status?: string;
      message?: string;
      country?: string;
      countryCode?: string;
      city?: string;
      timezone?: string;
    };
    if (d.status === 'success' && d.countryCode && d.timezone) {
      return { country: d.country ?? d.countryCode, countryCode: d.countryCode, city: d.city, timezone: d.timezone };
    }
    throw new Error(d.message ?? 'ip-api 查询失败');
  } catch (err) {
    // 降级：ipwho.is（https 免费，无需 key）
    const res = await fetch(`https://ipwho.is/${ip}`, { signal: AbortSignal.timeout(GEO_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`ipwho.is HTTP ${res.status}`);
    const d = (await res.json()) as {
      success?: boolean;
      country?: string;
      country_code?: string;
      city?: string;
      timezone?: { id?: string };
    };
    if (!d.success || !d.country_code || !d.timezone?.id) throw new Error(`归属查询失败：${(err as Error).message}`);
    return { country: d.country ?? d.country_code, countryCode: d.country_code, city: d.city, timezone: d.timezone.id };
  }
}

/** 给定出口 IP，返回指纹建议。 */
export async function suggestFingerprint(ip: string): Promise<GeoFingerprintSuggestion> {
  const geo = await lookupGeo(ip);
  const lang = COUNTRY_LOCALE[geo.countryCode.toUpperCase()] ?? DEFAULT_LOCALE;
  return {
    ip,
    country: geo.country,
    countryCode: geo.countryCode,
    city: geo.city,
    timezone: geo.timezone,
    locale: lang.locale,
    languages: lang.languages,
  };
}
