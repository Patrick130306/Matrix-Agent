/**
 * §11.2 BrowserManager（合并 v1.0 的 Launcher + Controller）。
 *
 * ADR-1：chromium.launchPersistentContext() 托管 Chrome 生命周期；
 * ADR-2：指纹注入只用 context.addInitScript() 单层注入；
 * ADR-3：UA 全权交给 CDP Emulation.setUserAgentOverride（per page），
 *        时区 / Locale 用 context 选项，代理用 Playwright proxy 选项（含认证）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type BrowserContext, type Cookie, type Page } from 'playwright-core';
import type { AgentAction, PageSnapshot, Profile, Settings } from '@shared/types';
import { buildFingerprintInitScript, getPreset } from './fingerprint';
import { locateByIdx, serializePage } from './serializer';
import { resolveChromeExecutable } from './chrome-locator';
import { cleanSingletonLocks } from './recovery';
import { decryptString } from './secure-store';
import { getDataRoot, getLogsDir, registerRunningInstance, unregisterRunningInstance, setProfileStatus } from './db';

interface InstanceEntry {
  context: BrowserContext;
  profileId: string;
  manual: boolean; // 手动模式（用户登录等），Agent 不占用
  recordingPage?: Page; // 任务录像页（任务开始时记录，结束时关闭以 finalize 视频）
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
        // 任务录像（§6.6）：设置页开关，默认关；尺寸跟屏幕走但封顶 1280x720 控制体积
        recordVideo: settings.recordTasks
          ? {
              dir: path.join(getDataRoot(), 'videos'),
              size: {
                width: Math.min(profile.screenWidth, 1280),
                height: Math.min(profile.screenHeight, 720),
              },
            }
          : undefined,
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
          acceptLanguage: buildAcceptLanguage(profile.languages),
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
        // 拟人点击：滚动到可见 → 贝塞尔轨迹移动鼠标 → 按下/抬起（避免瞬移点击）
        await el.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => undefined);
        const box = await el.boundingBox();
        if (box) {
          const tx = box.x + box.width * (0.3 + Math.random() * 0.4);
          const ty = box.y + box.height * (0.3 + Math.random() * 0.4);
          await humanMouseMove(page, { x: tx, y: ty });
          await page.waitForTimeout(randInt(30, 90));
          await page.mouse.down();
          await page.waitForTimeout(randInt(60, 140));
          await page.mouse.up();
        } else {
          await el.click({ timeout: 5000 });
        }
        return `已点击 idx=${action.idx}`;
      }

      case 'type': {
        const el = await locateByIdx(page, elements, action.idx);
        await el.click({ timeout: 5000 });
        await el.fill('');
        // 拟人输入：逐字符随机节奏 + 偶尔停顿（模拟真实打字）
        let sincePause = 0;
        for (const ch of action.text) {
          await page.keyboard.type(ch, { delay: randInt(28, 110) });
          sincePause++;
          if (sincePause >= randInt(10, 22)) {
            await page.waitForTimeout(randInt(250, 800));
            sincePause = 0;
          }
        }
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
        // 拟人滚动：分段滚动 + 随机步长 + 随机间隔（避免一次性大跳）
        const humanWheel = async (dir: 1 | -1, segs: number) => {
          for (let i = 0; i < segs; i++) {
            await page.mouse.wheel(0, dir * randInt(200, 520));
            await page.waitForTimeout(randInt(80, 220));
          }
        };
        switch (action.direction) {
          case 'top':
            await humanWheel(-1, randInt(5, 8));
            break;
          case 'bottom':
            await humanWheel(1, randInt(5, 8));
            break;
          default:
            await humanWheel(action.direction === 'up' ? -1 : 1, randInt(2, 3));
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

  /** §6.6 任务录像：记录当前活动页为录像页（任务开始时调用；页面关闭即停止录制）。 */
  async startTaskRecording(profileId: string): Promise<void> {
    const entry = this.instances.get(profileId);
    if (!entry || entry.recordingPage) return;
    const pages = entry.context.pages().filter((p) => !p.isClosed());
    const page = pages[pages.length - 1] ?? (await entry.context.newPage().catch(() => undefined));
    if (page) entry.recordingPage = page;
  }

  /**
   * §6.6 任务录像收尾：关闭任务页以 finalize 视频 → 拷贝到 logs/{taskId}/recording.webm。
   * 返回相对 logs 的路径（存 Task.recordingFile）；失败返回 undefined。
   */
  async stopTaskRecording(profileId: string, taskId: string): Promise<string | undefined> {
    const entry = this.instances.get(profileId);
    if (!entry || !entry.recordingPage) return undefined;
    const page = entry.recordingPage;
    entry.recordingPage = undefined;
    try {
      const video = page.video();
      // 任务页随任务结束关闭（浏览器实例保持打开，用户可手动开新页）
      await page.close().catch(() => undefined);
      if (!video) return undefined;
      const src = await video.path().catch(() => undefined);
      if (!src || !fs.existsSync(src)) return undefined;
      const logsDir = getLogsDir(taskId);
      fs.mkdirSync(logsDir, { recursive: true });
      const target = path.join(logsDir, 'recording.webm');
      fs.copyFileSync(src, target);
      return `${taskId}/recording.webm`;
    } catch (err) {
      console.warn('[browser] 录像收尾失败:', err);
      return undefined;
    }
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

/** Accept-Language 头：真实浏览器按 q 值降序排列（en-US,en;q=0.9），不能逗号直拼。 */
function buildAcceptLanguage(languages: string[]): string {
  const list = languages.length > 0 ? languages : ['en-US', 'en'];
  return list
    .map((l, i) => {
      const tag = l.trim();
      if (i === 0) return tag;
      const q = Math.max(0.1, 0.9 - (i - 1) * 0.1);
      return `${tag};q=${q.toFixed(1)}`;
    })
    .join(',');
}

// ---------------------------------------------------------------- 拟人行为模拟（§6.5）

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** 三次贝塞尔路径：控制点带随机偏移模拟人手弧度，返回 steps+1 个点。 */
function bezierPath(
  from: { x: number; y: number },
  to: { x: number; y: number },
  steps: number,
): { x: number; y: number }[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy) || 1;
  const jitter = () => (Math.random() - 0.5) * dist * 0.15;
  const c1 = {
    x: from.x + dx * (0.2 + Math.random() * 0.2) + jitter(),
    y: from.y + dy * (0.1 + Math.random() * 0.25) + jitter(),
  };
  const c2 = {
    x: from.x + dx * (0.6 + Math.random() * 0.2) + jitter(),
    y: from.y + dy * (0.55 + Math.random() * 0.25) + jitter(),
  };
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const mt = 1 - t;
    pts.push({
      x: mt * mt * mt * from.x + 3 * mt * mt * t * c1.x + 3 * mt * t * t * c2.x + t * t * t * to.x,
      y: mt * mt * mt * from.y + 3 * mt * mt * t * c1.y + 3 * mt * t * t * c2.y + t * t * t * to.y,
    });
  }
  return pts;
}

/** 拟人鼠标移动：从视口内随机起点走贝塞尔曲线到目标，每步随机延迟。 */
async function humanMouseMove(page: Page, to: { x: number; y: number }): Promise<void> {
  const dist = Math.hypot(to.x - 400, to.y - 300) || 1;
  const steps = Math.min(40, Math.max(12, Math.round(dist / 18)));
  const from = { x: 400 + randInt(-120, 120), y: 300 + randInt(-80, 80) };
  const pts = bezierPath(from, to, steps);
  for (const p of pts) {
    await page.mouse.move(p.x, p.y);
    await page.waitForTimeout(randInt(4, 14));
  }
}
