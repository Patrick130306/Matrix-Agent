/**
 * §7.2 页面序列化（Serializer）。
 *
 * 1. 打标：为可交互元素写入 data-mx-idx 属性，并收集元素信息（含 xpath 备用定位）；
 * 2. 页面结构：官方 aria snapshot（YAML），超长截断。
 *
 * §7.3 元素定位协议：LLM 只能引用 idx；执行层只认 data-mx-idx 属性；
 * 两者由打标动作绑定，绝不跨语义换算（修复 v1.0 的 index 不一致 bug）。
 */
import type { Page } from 'playwright-core';
import type { ElementInfo, PageSnapshot } from '@shared/types';
import { SERIALIZE_ARIA_MAX_CHARS, SERIALIZE_MAX_ELEMENTS } from '@shared/constants';

export class ElementStaleError extends Error {
  constructor(public readonly idx: number) {
    super(`元素 idx=${idx} 的 data-mx-idx 打标已失效（SPA 重渲染？）`);
    this.name = 'ElementStaleError';
  }
}

export async function serializePage(page: Page): Promise<PageSnapshot> {
  // 1. 打标 + 元素收集（页面内执行）
  const elements = await page.evaluate(
    ({ maxElements }) => {
      const selector =
        'a, button, input, select, textarea, [role="button"], [role="link"], ' +
        '[role="textbox"], [role="checkbox"], [role="tab"], [role="menuitem"], [onclick], summary';

      const isVisible = (el: Element): boolean => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
      };

      const getXPath = (el: Element): string => {
        if (el.id) return `//*[@id="${el.id}"]`;
        const parts: string[] = [];
        let node: Element | null = el;
        while (node && node.nodeType === Node.ELEMENT_NODE) {
          let index = 1;
          let sibling = node.previousElementSibling;
          while (sibling) {
            if (sibling.tagName === node.tagName) index++;
            sibling = sibling.previousElementSibling;
          }
          parts.unshift(`${node.tagName.toLowerCase()}[${index}]`);
          node = node.parentElement;
        }
        return '/' + parts.join('/');
      };

      // 视口内的元素优先（排序后再截断，保证首屏可交互性）
      const all = Array.from(document.querySelectorAll(selector)).filter(isVisible);
      const viewportH = window.innerHeight;
      all.sort((a, b) => {
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        const aIn = ra.top < viewportH && ra.bottom > 0 ? 0 : 1;
        const bIn = rb.top < viewportH && rb.bottom > 0 ? 0 : 1;
        return aIn - bIn || ra.top - rb.top;
      });

      return all.slice(0, maxElements).map((el, i) => {
        el.setAttribute('data-mx-idx', String(i));
        const input = el as HTMLInputElement;
        const btn = el as HTMLButtonElement;
        return {
          idx: i,
          tag: el.tagName.toLowerCase(),
          type: input.type || undefined,
          text: (el.textContent || '').trim().slice(0, 50),
          placeholder: input.placeholder || undefined,
          disabled: btn.disabled || undefined,
          xpath: getXPath(el),
        } as ElementInfo;
      });
    },
    { maxElements: SERIALIZE_MAX_ELEMENTS },
  );

  // 2. aria snapshot（新版本 Playwright 面向 AI 场景优化；老版本/异常时降级 innerText）
  let aria = '';
  try {
    aria = await page.ariaSnapshot();
  } catch {
    try {
      aria = await page.evaluate(() => document.body?.innerText ?? '');
    } catch {
      aria = '';
    }
  }
  if (aria.length > SERIALIZE_ARIA_MAX_CHARS) {
    aria = aria.slice(0, SERIALIZE_ARIA_MAX_CHARS) + '\n...（截断）';
  }

  return {
    url: page.url(),
    title: await page.title().catch(() => ''),
    aria,
    elements,
    capturedAt: new Date().toISOString(),
  };
}

/** 按打标定位元素；打标失效时用 xpath 兜底，再失败抛 ElementStaleError（§7.3）。 */
export async function locateByIdx(page: Page, elements: ElementInfo[], idx: number) {
  const byAttr = page.locator(`[data-mx-idx="${idx}"]`);
  if ((await byAttr.count()) > 0) return byAttr.first();

  const info = elements.find((e) => e.idx === idx);
  if (info?.xpath) {
    const byXpath = page.locator(`xpath=${info.xpath}`);
    if ((await byXpath.count()) > 0) {
      // 兜底定位成功后补打标，保持后续动作可用
      await byXpath.first().evaluate((el, i) => el.setAttribute('data-mx-idx', String(i)), idx);
      return byXpath.first();
    }
  }
  throw new ElementStaleError(idx);
}

/** §7.6 页面状态指纹：只用稳定特征（URL + 元素签名），剔除易变节点。 */
export function pageStateHash(snapshot: PageSnapshot): string {
  const sig = snapshot.elements.map((e) => `${e.tag}|${e.type ?? ''}|${e.text}`).join(';');
  let h = 0;
  const s = snapshot.url + sig;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16);
}

/** 快照 → 给 LLM 的文本表示 */
export function snapshotToPromptText(snapshot: PageSnapshot, maxChars: number): string {
  const lines = snapshot.elements.map((e) => {
    const parts = [`[${e.idx}]`, `<${e.tag}>`];
    if (e.type) parts.push(`type=${e.type}`);
    if (e.text) parts.push(`"${e.text}"`);
    if (e.placeholder) parts.push(`placeholder="${e.placeholder}"`);
    if (e.disabled) parts.push('(disabled)');
    return parts.join(' ');
  });

  let text =
    `URL: ${snapshot.url}\n标题: ${snapshot.title}\n\n` +
    `【页面结构（aria）】\n${snapshot.aria}\n\n` +
    `【可交互元素索引表】\n${lines.join('\n')}`;

  if (text.length > maxChars) {
    text = text.slice(0, maxChars) + '\n...（快照截断）';
  }
  return text;
}
