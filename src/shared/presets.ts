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
  maxCores: number; // 该显卡/机型档次的合理核心数上限（防「核显 + 32 核」穿帮）
  fonts: string[]; // 该 OS 的常见系统字体列表（fonts 指纹注入用）
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

/** Windows 常见系统字体（fonts 指纹注入用） */
const WIN_FONTS = [
  'Arial', 'Arial Black', 'Calibri', 'Cambria', 'Cambria Math', 'Candara', 'Comic Sans MS', 'Consolas',
  'Constantia', 'Corbel', 'Courier New', 'Ebrima', 'Franklin Gothic Medium', 'Gabriola', 'Georgia', 'Impact',
  'Ink Free', 'Lucida Console', 'Lucida Sans Unicode', 'Malgun Gothic', 'Microsoft JhengHei', 'Microsoft Sans Serif',
  'Microsoft YaHei', 'MingLiU-ExtB', 'NSimSun', 'Palatino Linotype', 'Segoe Print', 'Segoe Script', 'Segoe UI',
  'Segoe UI Light', 'Segoe UI Semibold', 'SimSun', 'Sitka Small', 'Tahoma', 'Times New Roman', 'Trebuchet MS',
  'Verdana', 'Webdings', 'Wingdings',
];

/** macOS 常见系统字体 */
const MAC_FONTS = [
  'American Typewriter', 'Arial', 'Arial Black', 'Arial Narrow', 'Avenir', 'Avenir Next', 'Baskerville',
  'Big Caslon', 'Bodoni 72', 'Bradley Hand', 'Brush Script MT', 'Chalkboard', 'Chalkduster', 'Charter', 'Cochin',
  'Comic Sans MS', 'Copperplate', 'Courier', 'Courier New', 'Didot', 'DIN Alternate', 'Futura', 'Geneva', 'Georgia',
  'Gill Sans', 'Helvetica', 'Helvetica Neue', 'Hoefler Text', 'Impact', 'Lucida Grande', 'Marker Felt', 'Menlo',
  'Monaco', 'Noteworthy', 'Optima', 'Palatino', 'Papyrus', 'Phosphate', 'Rockwell', 'SignPainter', 'Skia',
  'Snell Roundhand', 'Tahoma', 'Times New Roman', 'Trattatello', 'Trebuchet MS', 'Verdana', 'Zapfino',
];

/** Linux (Ubuntu) 常见系统字体 */
const LINUX_FONTS = [
  'Bitstream Vera Sans', 'Cantarell', 'Droid Sans', 'Droid Sans Mono', 'Droid Serif', 'FreeMono', 'FreeSans',
  'FreeSerif', 'Liberation Mono', 'Liberation Sans', 'Liberation Serif', 'Nimbus Mono L', 'Nimbus Roman',
  'Nimbus Sans', 'Noto Color Emoji', 'Noto Mono', 'Noto Sans', 'Noto Sans CJK JP', 'Noto Sans CJK SC', 'Noto Serif',
  'OpenSymbol', 'STIXGeneral', 'Ubuntu', 'Ubuntu Condensed', 'Ubuntu Light', 'Ubuntu Mono', 'WenQuanYi Micro Hei',
  'WenQuanYi Zen Hei',
];

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
    maxCores: 16,
    fonts: WIN_FONTS,
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
    maxCores: 8,
    fonts: WIN_FONTS,
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
    maxCores: 12,
    fonts: MAC_FONTS,
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
    maxCores: 8,
    fonts: LINUX_FONTS,
  },
};

export const OS_PRESET_LIST = Object.values(OS_PRESETS);
