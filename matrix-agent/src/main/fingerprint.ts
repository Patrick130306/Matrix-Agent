/**
 * §6 指纹方案（v2.0）—— osPreset 派生 + addInitScript 生成。
 *
 * 分层结构：
 *   第一层  launchPersistentContext 选项（timezoneId / locale / proxy / viewport）
 *   第二层  CDP Emulation 域（UA + UA-CH，见 browser-manager.ts）
 *   第三层  context.addInitScript()（本文件生成的脚本）
 *   flags   仅保留少数无害项
 *
 * §6.3 种子化确定性噪声：以 profile.id 派生种子（mulberry32 PRNG），
 * 同一 Profile 会话内与跨会话指纹稳定，不同 Profile 之间指纹不同。
 */
import crypto from 'node:crypto';
import type { Profile } from '@shared/types';
import { OS_PRESETS, type FingerprintPreset } from '@shared/presets';

/** §6.3 种子：sha1(profileId) 取前 4 字节 */
export function seedFromProfile(profileId: string): number {
  const hash = crypto.createHash('sha1').update(profileId).digest();
  return hash.readUInt32LE(0);
}

export function getPreset(profile: Profile): FingerprintPreset {
  return OS_PRESETS[profile.osPreset] ?? OS_PRESETS['win11-chrome'];
}

/**
 * 生成注入脚本（第三层）。
 * 覆盖 §6.4 MVP 注入清单；时区 / Intl / UA / userAgentData 已由第一、二层覆盖，不在 JS 层重复劫持。
 */
export function buildFingerprintInitScript(profile: Profile): string {
  const preset = getPreset(profile);
  const seed = seedFromProfile(profile.id);

  const config = {
    seed,
    platform: preset.platform,
    hardwareConcurrency: clampInt(profile.hardwareConcurrency, 2, 16, 8),
    deviceMemory: pickDeviceMemory(profile.deviceMemory),
    languages: profile.languages.length > 0 ? profile.languages : [profile.locale],
    maxTouchPoints: preset.maxTouchPoints,
    screen: {
      width: clampInt(profile.screenWidth, 800, 7680, 1920),
      height: clampInt(profile.screenHeight, 600, 4320, 1080),
      colorDepth: 24,
    },
    webgl: {
      vendor: preset.webglVendor,
      renderer: preset.webglRenderer,
    },
  };

  // 页面脚本内禁用模板字符串语法，避免与外层层级混淆
  return `
(() => {
  'use strict';
  if (window.__mxFingerprintApplied) return;
  Object.defineProperty(window, '__mxFingerprintApplied', { value: true, configurable: false });

  const CFG = ${JSON.stringify(config)};

  // ---- 确定性 PRNG：mulberry32（§6.3） ----
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---- 原生伪装：被劫持函数的 toString 特征（§17 风险表） ----
  const nativeToString = Function.prototype.toString;
  const wrapped = new WeakSet();
  function nativeWrap(fn, name) {
    wrapped.add(fn);
    Object.defineProperty(fn, 'toString', {
      value: function () { return 'function ' + name + '() { [native code] }'; },
      writable: true, configurable: true,
    });
    return fn;
  }
  const hookedToString = nativeWrap(function toString() {
    if (wrapped.has(this)) {
      return 'function ' + (this.name || '') + '() { [native code] }';
    }
    return nativeToString.call(this);
  }, 'toString');
  Object.defineProperty(Function.prototype, 'toString', { value: hookedToString, writable: true, configurable: true });

  function defineGetter(obj, prop, getter) {
    try {
      Object.defineProperty(obj, prop, {
        get: nativeWrap(getter, 'get ' + prop),
        configurable: true,
      });
    } catch (e) { /* 个别环境属性不可重定义，跳过 */ }
  }

  // ---- navigator（§6.4） ----
  defineGetter(Navigator.prototype, 'webdriver', () => false);
  defineGetter(Navigator.prototype, 'platform', () => CFG.platform);
  defineGetter(Navigator.prototype, 'hardwareConcurrency', () => CFG.hardwareConcurrency);
  defineGetter(Navigator.prototype, 'deviceMemory', () => CFG.deviceMemory);
  defineGetter(Navigator.prototype, 'languages', () => Object.freeze(CFG.languages.slice()));
  defineGetter(Navigator.prototype, 'maxTouchPoints', () => CFG.maxTouchPoints);

  // ---- screen（§6.4） ----
  defineGetter(Screen.prototype, 'width', () => CFG.screen.width);
  defineGetter(Screen.prototype, 'height', () => CFG.screen.height);
  defineGetter(Screen.prototype, 'availWidth', () => CFG.screen.width);
  defineGetter(Screen.prototype, 'availHeight', () => CFG.screen.height - 40);
  defineGetter(Screen.prototype, 'colorDepth', () => CFG.screen.colorDepth);
  defineGetter(Screen.prototype, 'pixelDepth', () => CFG.screen.colorDepth);

  // ---- Canvas 种子噪声（§6.3）：LSB 级扰动，同 Profile 结果一致 ----
  // 注意：噪声必须以“内容 + 种子”为输入，保证同一 Profile 重读结果稳定（过一致性校验）。
  function contentSeed(bytes, offset) {
    let h = CFG.seed | 0;
    const step = Math.max(1, Math.floor(bytes.length / 64));
    for (let i = 0; i < bytes.length; i += step) {
      h = (h * 31 + bytes[i] + offset) | 0;
    }
    return h >>> 0;
  }

  const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
  const hookedGetImageData = nativeWrap(function getImageData(x, y, w, h) {
    const imageData = origGetImageData.apply(this, arguments);
    const rand = mulberry32(contentSeed(imageData.data, 0xC4) ^ CFG.seed);
    for (let i = 0; i < imageData.data.length; i += 4) {
      if (rand() < 0.05) {
        // 仅扰动颜色通道最低位，视觉上不可感知
        imageData.data[i] = imageData.data[i] ^ 1;
      }
    }
    return imageData;
  }, 'getImageData');
  CanvasRenderingContext2D.prototype.getImageData = hookedGetImageData;

  // ---- WebGL：返回预设固定值（§6.3 不做噪声） ----
  const UNMASKED_VENDOR_WEBGL = 0x9245;
  const UNMASKED_RENDERER_WEBGL = 0x9246;
  function hookGetParameter(proto) {
    if (!proto) return;
    const orig = proto.getParameter;
    proto.getParameter = nativeWrap(function getParameter(pname) {
      if (pname === UNMASKED_VENDOR_WEBGL) return CFG.webgl.vendor;
      if (pname === UNMASKED_RENDERER_WEBGL) return CFG.webgl.renderer;
      return orig.apply(this, arguments);
    }, 'getParameter');
  }
  hookGetParameter(window.WebGLRenderingContext && window.WebGLRenderingContext.prototype);
  hookGetParameter(window.WebGL2RenderingContext && window.WebGL2RenderingContext.prototype);

  // ---- Audio 种子微噪声（±0.0001 量级，§6.3） ----
  if (window.AudioBuffer && window.AudioBuffer.prototype) {
    const origGetChannelData = window.AudioBuffer.prototype.getChannelData;
    window.AudioBuffer.prototype.getChannelData = nativeWrap(function getChannelData(channel) {
      const data = origGetChannelData.apply(this, arguments);
      if (!data.__mxNoised) {
        const rand = mulberry32(CFG.seed ^ 0xA0 ^ channel);
        for (let i = 0; i < data.length; i += 97) {
          data[i] = data[i] + (rand() - 0.5) * 0.0002;
        }
        try { Object.defineProperty(data, '__mxNoised', { value: true }); } catch (e) { /* 只读则跳过 */ }
      }
      return data;
    }, 'getChannelData');
  }
})();
`;
}

function clampInt(v: number, min: number, max: number, dflt: number): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

/** deviceMemory 合法值（Chrome 仅接受 2 的幂，上限 8） */
function pickDeviceMemory(v: number): number {
  const allowed = [2, 4, 8];
  const n = Number(v);
  return allowed.includes(n) ? n : 8;
}
