import type { OSPresetId } from './types';

/**
 * §6.2 指纹预设包（osPreset）—— 解决一致性问题。
 * 用户不逐项填写指纹参数，所有联动项由预设派生，
 * 杜绝 "Mac UA + Windows 显卡渲染器" 这类低级穿帮。
 *
 * 注意：UA 主版本号需与目标真实 Chrome 大版本对齐，内置预设会随 Chrome 升级而更新。
 */

export interface UAMetadataBrand {
  brand: string;
  version: string;
}

export interface FingerprintPreset {
  id: OSPresetId;
  label: string;
  os: 'windows' | 'macos' | 'linux';
  userAgent: string; // 完整 UA 字符串
  userAgentMetadata: {
    // 直接透传给 CDP Emulation.setUserAgentOverride
    brands: UAMetadataBrand[];
    fullVersion: string;
    platform: string; // "Windows" | "macOS" | "Linux"
    platformVersion: string;
    architecture: string;
    model: string;
    mobile: boolean;
    bitness: string;
  };
  platform: string; // navigator.platform
  webglVendor: string; // UNMASKED_VENDOR_WEBGL
  webglRenderer: string; // UNMASKED_RENDERER_WEBGL
  maxTouchPoints: number; // 桌面预设通常为 0
}

const CHROME_MAJOR = '138';
const CHROME_FULL = '138.0.0.0';

function chromeBrands(): UAMetadataBrand[] {
  return [
    { brand: 'Not)A;Brand', version: '99' },
    { brand: 'Google Chrome', version: CHROME_MAJOR },
    { brand: 'Chromium', version: CHROME_MAJOR },
  ];
}

export const OS_PRESETS: Record<OSPresetId, FingerprintPreset> = {
  'win11-chrome': {
    id: 'win11-chrome',
    label: 'Windows 11 + Chrome',
    os: 'windows',
    userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_FULL} Safari/537.36`,
    userAgentMetadata: {
      brands: chromeBrands(),
      fullVersion: CHROME_FULL,
      platform: 'Windows',
      platformVersion: '15.0.0', // Windows 11 22H2+ 常见上报值
      architecture: 'x86',
      model: '',
      mobile: false,
      bitness: '64',
    },
    platform: 'Win32',
    webglVendor: 'Google Inc. (NVIDIA)',
    webglRenderer:
      'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    maxTouchPoints: 0,
  },
  'win10-chrome': {
    id: 'win10-chrome',
    label: 'Windows 10 + Chrome',
    os: 'windows',
    userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_FULL} Safari/537.36`,
    userAgentMetadata: {
      brands: chromeBrands(),
      fullVersion: CHROME_FULL,
      platform: 'Windows',
      platformVersion: '10.0.0',
      architecture: 'x86',
      model: '',
      mobile: false,
      bitness: '64',
    },
    platform: 'Win32',
    webglVendor: 'Google Inc. (Intel)',
    webglRenderer:
      'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    maxTouchPoints: 0,
  },
  'macos-chrome': {
    id: 'macos-chrome',
    label: 'macOS Sonoma + Chrome',
    os: 'macos',
    userAgent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_FULL} Safari/537.36`,
    userAgentMetadata: {
      brands: chromeBrands(),
      fullVersion: CHROME_FULL,
      platform: 'macOS',
      platformVersion: '14.5.0',
      architecture: 'arm',
      model: '',
      mobile: false,
      bitness: '64',
    },
    platform: 'MacIntel',
    webglVendor: 'Google Inc. (Apple)',
    webglRenderer:
      'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)',
    maxTouchPoints: 0,
  },
  'linux-chrome': {
    id: 'linux-chrome',
    label: 'Linux (Ubuntu) + Chrome',
    os: 'linux',
    userAgent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_FULL} Safari/537.36`,
    userAgentMetadata: {
      brands: chromeBrands(),
      fullVersion: CHROME_FULL,
      platform: 'Linux',
      platformVersion: '',
      architecture: 'x86',
      model: '',
      mobile: false,
      bitness: '64',
    },
    platform: 'Linux x86_64',
    webglVendor: 'Google Inc. (Intel)',
    webglRenderer:
      'ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6)',
    maxTouchPoints: 0,
  },
};

export const OS_PRESET_LIST = Object.values(OS_PRESETS);
