/**
 * §11.2 BrowserManager（合并 v1.0 的 Launcher + Controller）。
 *
 * ADR-1：chromium.launchPersistentContext() 托管 Chrome 生命周期；
 * ADR-2：指纹注入只用 context.addInitScript() 单层注入；
 * ADR-3：UA 全权交给 CDP Emulation.setUserAgentOverride（per page），
 *        时区 / Locale 用 context 选项，代理用 Playwright proxy 选项（含认证）。
 */
import fs from 'node:fs';
import { chromium, type BrowserContext, type Cookie, type Page } from 'playwright-core';
import type { AgentAction, PageSnapshot, Profile, Settings } from '@shared/types';
import { buildFingerprintInitScript, getPreset } from './fingerprint';
import { locateByIdx, serializePage } from './serializer';
import { resolveChromeExecutable } from './chrome-locator';
import { cleanSingletonLocks } from './recovery';
import { decryptString } from './secure-store';
import { registerRunningInstance, unregisterRunningInstance, setProfileStatus } from './db';

interface InstanceEntry {
  context: BrowserContext;
  profileId: string;
  manual: boolean; // 手动模式（用户登录等），Agent 不占用
}

export class BrowserManager {
  private readonly instances = new Map<string, InstanceEntry>();

  /** 当前 Profile 是否已有活跃实例 */
  isRunning(profileId: string): boolean {
    return this.instances.has(profileId);
  }

  getRunningProfileIds(): string[] {
    return [...this.instances.keys()];
  }

  /**
   * 启动 Profile 对应的 Chrome 实例（ADR-1）。
   * @param manual 手动模式强制 headed（用户人工登录、指纹自测用）
   */
  async launch(profile: Profile, settings: Settings, manual = false): Promise<BrowserContext> {
    const existing = this.instances.get(profile.id);
    if (existing) return existing.context;

    // 1. 清理残留锁文件（§8.3）
    fs.mkdirSync(profile.userDataDir, { recursive: true });
    cleanSingletonLocks(profile.userDataDir);

    const preset = getPreset(profile);

    // 2. launchPersistentContext
    const executablePath = resolveChromeExecutable(settings.chromeExecutablePath);
    const args = [
      // 仅保留少数无害项（§6.1 启动 flags）
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    ];

    let context: BrowserContext;
    try {
      context = await chromium.launchPersistentContext(profile.userDataDir, {
        executablePath, // undefined 时由 playwright-core 使用其 Chromium 兜底
        headless: manual ? false : settings.headless,
        args,
        proxy: buildProxyConfig(profile), // 原生支持代理认证（ADR-1 理由 2）
        timezoneId: profile.timezone || undefined, // ADR-3：底层即 Emulation.setTimezoneOverride
        locale: profile.locale || undefined,
        viewport: { width: profile.screenWidth, height: profile.screenHeight },
        recordVideo: undefined, // Phase 2 录屏回放时启用
      });
    } catch (err) {
      throw new Error(
        `浏览器启动失败：${(err as Error).message}\n` +
          `（未找到可用的 Chrome？请在设置页指定 Chrome 路径，或执行 npx playwright-core install chromium 安装兜底 Chromium）`,
      );
    }

    // 3. ADR-3：对每个页面应用 CDP Emulation.setUserAgentOverride（含 userAgentMetadata）
    const applyUaOverride = async (page: Page) => {
      try {
        const session = await context.newCDPSession(page);
        await session.send('Emulation.setUserAgentOverride', {
          userAgent: preset.userAgent,
          acceptLanguage: profile.languages.join(','),
          userAgentMetadata: {
            brands: preset.userAgentMetadata.brands,
            fullVersion: preset.userAgentMetadata.fullVersion,
            platform: preset.userAgentMetadata.platform,
            platformVersion: preset.userAgentMetadata.platformVersion,
            architecture: preset.userAgentMetadata.architecture,
            model: preset.userAgentMetadata.model,
            mobile: preset.userAgentMetadata.mobile,
            bitness: preset.userAgentMetadata.bitness,
          },
        });
      } catch (err) {
        console.warn('[browser] UA override 失败:', err);
      }
    };
    context.on('page', (page) => void applyUaOverride(page));
    for (const page of context.pages()) await applyUaOverride(page);

    // 4. ADR-2：addInitScript 单层注入（覆盖动态 iframe，无 MV3/时序问题）
    await context.addInitScript(buildFingerprintInitScript(profile));

    // 5. running_instances 表登记 pid（§8.3-2 崩溃恢复依赖）
    const pid = await detectBrowserPid(context);
    if (pid) registerRunningInstance(profile.id, pid);

    context.on('close', () => {
      this.instances.delete(profile.id);
      unregisterRunningInstance(profile.id);
      setProfileStatus(profile.id, 'idle');
    });

    this.instances.set(profile.id, { context, profileId: profile.id, manual });
    setProfileStatus(profile.id, 'running');
    return context;
  }

  /** 取当前活动页面（没有则新开一个）。 */
  async getPage(profileId: string): Promise<Page> {
    const entry = this.instances.get(profileId);
    if (!entry) throw new Error(`Profile ${profileId} 的浏览器未启动`);
    const pages = entry.context.pages().filter((p) => !p.isClosed());
    if (pages.length > 0) return pages[pages.length - 1];
    return entry.context.newPage();
  }

  /** 新开一个临时标签页（登录态检测用，不干扰用户当前页面；用完由调用方 close）。 */
  async newPage(profileId: string): Promise<Page> {
    const entry = this.instances.get(profileId);
    if (!entry) throw new Error(`Profile ${profileId} 的浏览器未启动`);
    return entry.context.newPage();
  }

  /** 导出该 Profile 的全部 Cookie（登录态迁移）。 */
  async exportCookies(profileId: string): Promise<Cookie[]> {
    const entry = this.instances.get(profileId);
    if (!entry) throw new Error(`Profile ${profileId} 的浏览器未启动`);
    return entry.context.cookies();
  }

  /** 导入 Cookie 到该 Profile（Playwright 导出格式可直接回灌）。 */
  async importCookies(profileId: string, cookies: Cookie[]): Promise<number> {
    const entry = this.instances.get(profileId);
    if (!entry) throw new Error(`Profile ${profileId} 的浏览器未启动`);
    await entry.context.addCookies(cookies);
    return cookies.length;
  }

  async serialize(profileId: string): Promise<PageSnapshot> {
    const page = await this.getPage(profileId);
    return serializePage(page);
  }

  /** §7.3：元素一律经 data-mx-idx 定位；ElementStaleError 交由上层触发重新序列化。 */
  async execute(profileId: string, action: AgentAction, elements: PageSnapshot['elements']): Promise<string> {
    const page = await this.getPage(profileId);

    switch (action.type) {
      case 'navigate':
        await page.goto(action.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        return `已导航到 ${action.url}`;

      case 'click': {
        const el = await locateByIdx(page, elements, action.idx);
        await el.click({ timeout: 5000 });
        return `已点击 idx=${action.idx}`;
      }

      case 'type': {
        const el = await locateByIdx(page, elements, action.idx);
        await el.click({ timeout: 5000 });
        await el.fill('');
        await el.pressSequentially(action.text, { delay: 30 });
        if (action.pressEnter) await el.press('Enter');
        return `已在 idx=${action.idx} 输入 ${action.text.length} 个字符`;
      }

      case 'select': {
        const el = await locateByIdx(page, elements, action.idx);
        await el.selectOption({ label: action.value }).catch(async () => {
          await el.selectOption(action.value);
        });
        return `已在 idx=${action.idx} 选择 "${action.value}"`;
      }

      case 'scroll': {
        switch (action.direction) {
          case 'top':
            await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior }));
            break;
          case 'bottom':
            await page.evaluate(() =>
              window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' as ScrollBehavior }),
            );
            break;
          default:
            await page.mouse.wheel(0, action.direction === 'up' ? -600 : 600);
        }
        return `已滚动（${action.direction}）`;
      }

      case 'wait':
        await page.waitForTimeout(Math.min(action.ms, 15_000));
        return `已等待 ${action.ms}ms`;

      case 'extract': {
        const text = await page.evaluate(() => document.body?.innerText?.slice(0, 3000) ?? '');
        return text;
      }

      default:
        throw new Error(`不支持的动作类型: ${(action as AgentAction).type}`);
    }
  }

  /** §9 实时查看（MVP）：将对应 Chrome 页面置前（headed 模式下零成本）。 */
  async bringToFront(profileId: string): Promise<void> {
    const page = await this.getPage(profileId);
    await page.bringToFront();
  }

  /** 当前页面截图（人机协同弹窗用），返回 JPEG base64。 */
  async screenshot(profileId: string): Promise<string | undefined> {
    try {
      const page = await this.getPage(profileId);
      const buf = await page.screenshot({ type: 'jpeg', quality: 60 });
      return buf.toString('base64');
    } catch {
      return undefined;
    }
  }

  async close(profileId: string): Promise<void> {
    const entry = this.instances.get(profileId);
    if (!entry) return;
    this.instances.delete(profileId);
    try {
      await entry.context.close();
    } catch (err) {
      console.warn('[browser] 关闭异常:', err);
    }
    unregisterRunningInstance(profileId);
    setProfileStatus(profileId, 'idle');
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.instances.keys()].map((id) => this.close(id)));
  }
}

/** 经 CDP SystemInfo.getProcessInfo 取浏览器主进程 pid（崩溃恢复的归属确认依赖）。 */
async function detectBrowserPid(context: BrowserContext): Promise<number | null> {
  try {
    const browser = context.browser();
    if (!browser) return null;
    const session = await browser.newBrowserCDPSession();
    const info = (await session.send('SystemInfo.getProcessInfo')) as {
      processInfo: { type: string; id: number }[];
    };
    await session.detach().catch(() => undefined);
    return info.processInfo.find((p) => p.type === 'browser')?.id ?? null;
  } catch {
    return null;
  }
}

/** ADR-1：Playwright proxy 选项原生支持代理认证，删除 --proxy-server。 */
function buildProxyConfig(profile: Profile):
  | { server: string; username?: string; password?: string }
  | undefined {
  if (profile.proxyType === 'none' || !profile.proxyHost || !profile.proxyPort) return undefined;
  const server = `${profile.proxyType}://${profile.proxyHost}:${profile.proxyPort}`;
  const password = profile.proxyPasswordEnc ? decryptString(profile.proxyPasswordEnc) : '';
  return {
    server,
    username: profile.proxyUsername || undefined,
    password: password || undefined,
  };
}
