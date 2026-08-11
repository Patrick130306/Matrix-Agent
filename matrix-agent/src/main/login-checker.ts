/**
 * 登录态检测：打开检测页（新标签页，不干扰用户当前页面），
 * 按 CSS 选择器或页面关键词判断「已登录 / 未登录」。
 *
 * 复用 Profile 的浏览器实例（未启动则按设置启动）——登录态绑定在 userDataDir 里，
 * 必须走真实 Profile 环境检测才有意义。
 */
import type { LoginCheck, Profile, Settings } from '@shared/types';
import type { BrowserManager } from './browser-manager';

export interface LoginCheckOutcome {
  status: 'online' | 'offline';
  detail: string;
}

export async function runLoginCheck(
  browsers: BrowserManager,
  profile: Profile,
  check: LoginCheck,
  settings: Settings,
): Promise<LoginCheckOutcome> {
  await browsers.launch(profile, settings); // 已运行则复用
  const page = await browsers.newPage(profile.id);
  try {
    await page.goto(check.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(2500); // 等前端渲染/跳转收敛

    if (check.mode === 'selector') {
      const el = await page.$(check.target);
      return el
        ? { status: 'online', detail: `检测到登录标识元素 ${check.target}` }
        : { status: 'offline', detail: `未找到元素 ${check.target}，疑似掉线` };
    }
    const text = await page.evaluate(() => document.body?.innerText ?? '');
    return text.includes(check.target)
      ? { status: 'online', detail: `页面包含关键词「${check.target}」` }
      : { status: 'offline', detail: `页面不含关键词「${check.target}」，疑似掉线` };
  } finally {
    await page.close().catch(() => undefined);
  }
}
