import { useEffect, useState, type ReactNode } from 'react';
import { matrix } from '../api';
import { Button, Card, Field, PageHeader, Segmented, Toggle, inputCls } from '../components/ui';
import { Icon } from '../components/icons';
import { ProxyPoolPanel } from '../components/ProxyPoolPanel';
import { ChromiumManagerPanel } from '../components/ChromiumManagerPanel';

interface SettingsView {
  llmBaseUrl: string;
  llmModel: string;
  llmMaxTokens: number;
  llmTemperature: number;
  llmConcurrency: number;
  chromeExecutablePath?: string;
  maxConcurrentProfiles: number;
  headless: boolean;
  recordTasks: boolean;
  maxStepsPerTask: number;
  snapshotHistoryWindow: number;
  requireHumanConfirm: boolean;
  taskMaxRetries: number;
  screenshotOnStep: boolean;
  notifyDesktop: boolean;
  webhookUrl: string;
  webhookEvents: 'all' | 'failed';
  theme: 'dark' | 'light';
  behaviorSimulation: boolean;
  llmPricePer1kTokens: number;
  checkUpdates: boolean;
  hasApiKey: boolean;
}

/** §12 设置页：LLM 配置 + 浏览器 + Agent 参数（§10.3）。 */
export function SettingsPage() {
  const [view, setView] = useState<SettingsView | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [saved, setSaved] = useState(false);
  const [testResult, setTestResult] = useState<string>('');
  const [webhookTest, setWebhookTest] = useState<string>('');
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updateResult, setUpdateResult] = useState<{
    current: string;
    latest: string;
    hasUpdate: boolean;
    url: string;
  } | null>(null);
  const [chromeInfo, setChromeInfo] = useState<{ detected: string | null; current: string | null } | null>(null);

  useEffect(() => {
    void matrix.settings.get().then((s) => setView(s as SettingsView));
    void matrix.system.detectChrome().then((r) => setChromeInfo(r as { detected: string | null; current: string | null }));
  }, []);

  if (!view) return <p className="text-sm text-slate-500">加载中…</p>;

  const set = <K extends keyof SettingsView>(k: K, v: SettingsView[K]) =>
    setView((s) => (s ? { ...s, [k]: v } : s));

  const save = async () => {
    await matrix.settings.set({
      ...view,
      llmApiKey: apiKey || undefined, // 留空 = 不改动旧密钥
    });
    // 即时应用主题（无需重启）
    document.documentElement.classList.toggle('light', view.theme === 'light');
    setApiKey('');
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const test = async () => {
    setTestResult('测试中…');
    const r = await matrix.settings.testLlm();
    setTestResult(r.ok ? `✓ 连通正常（${r.model}，${r.latencyMs}ms）` : `✗ ${r.error}`);
  };

  const checkUpdate = async () => {
    setCheckingUpdate(true);
    try {
      const r = await matrix.system.checkUpdate();
      setUpdateResult(r);
    } catch (err) {
      setUpdateResult(null);
      setTestResult(`✗ 检查失败：${(err as Error).message}`);
    } finally {
      setCheckingUpdate(false);
    }
  };

  const testWebhook = async () => {
    if (!view) return;
    setWebhookTest('发送中…');
    try {
      const r = await matrix.settings.testWebhook(view.webhookUrl);
      setWebhookTest(r.ok ? `✓ 已送达（HTTP ${r.status}）` : `✗ ${r.error}`);
    } catch (err) {
      setWebhookTest(`✗ ${(err as Error).message}`);
    }
  };

  const resultCls = (r: string) =>
    r.startsWith('✓') ? 'text-ok' : r.startsWith('✗') ? 'text-danger' : 'text-slate-400';

  return (
    <div>
      <PageHeader title="设置" desc="LLM · 浏览器 · Agent · 通知（保存后对新任务生效）" />

      <div className="max-w-3xl space-y-6">
        <Section title="LLM 配置" desc="用户自备，支持任意 OpenAI 兼容 API">
          <Field label="Base URL" hint="如 https://api.openai.com/v1 或你的中转站地址">
            <input className={inputCls} value={view.llmBaseUrl} onChange={(e) => set('llmBaseUrl', e.target.value)} />
          </Field>
          <Field
            label={`API Key（${view.hasApiKey ? '已配置，留空不改动' : '未配置'}）`}
            hint="经系统密钥库加密存储（safeStorage / DPAPI / Keychain），不明文落盘"
          >
            <input
              type="password"
              className={inputCls}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={view.hasApiKey ? '••••••••' : 'sk-...'}
            />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="模型">
              <input className={inputCls} value={view.llmModel} onChange={(e) => set('llmModel', e.target.value)} placeholder="deepseek-chat / gpt-4o-mini …" />
            </Field>
            <Field label="LLM 并发数（保护你的 rate limit，§8.1）">
              <input type="number" min={1} max={10} className={inputCls} value={view.llmConcurrency} onChange={(e) => set('llmConcurrency', Number(e.target.value))} />
            </Field>
            <Field label="max_tokens">
              <input type="number" className={inputCls} value={view.llmMaxTokens} onChange={(e) => set('llmMaxTokens', Number(e.target.value))} />
            </Field>
            <Field label="temperature">
              <input type="number" step={0.1} min={0} max={2} className={inputCls} value={view.llmTemperature} onChange={(e) => set('llmTemperature', Number(e.target.value))} />
            </Field>
          </div>
          <div className="flex items-center gap-3">
            <Button variant="outline" leftIcon="Link" onClick={() => void test()}>测试连通性</Button>
            {testResult && <span className={`text-xs ${resultCls(testResult)}`}>{testResult}</span>}
          </div>
        </Section>

        <Section title="浏览器">
          <Field
            label="Chrome 可执行文件路径（留空 = 自动检测）"
            hint={
              chromeInfo
                ? chromeInfo.detected
                  ? `已自动检测到：${chromeInfo.detected}`
                  : '未检测到系统 Chrome，将尝试 Playwright Chromium 兜底'
                : ''
            }
          >
            <input
              className={inputCls}
              value={view.chromeExecutablePath ?? ''}
              onChange={(e) => set('chromeExecutablePath', e.target.value || undefined)}
              placeholder="C:\Program Files\Google\Chrome\Application\chrome.exe"
            />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="浏览器并发数（保护本机性能，§8.1）">
              <input type="number" min={1} max={10} className={inputCls} value={view.maxConcurrentProfiles} onChange={(e) => set('maxConcurrentProfiles', Number(e.target.value))} />
            </Field>
          </div>
          <ToggleRow
            label="无头模式（headless）"
            hint="MVP 默认关闭，便于观察 Agent 操作过程"
            checked={view.headless}
            onChange={(v) => set('headless', v)}
          />
          <div className="border-t border-[var(--line-1)] pt-4">
            <p className="mb-2 text-[13px] font-medium text-slate-300">Chromium 内核（按需下载，安装包不内置）</p>
            <ChromiumManagerPanel />
          </div>
        </Section>

        <Section title="Agent">
          <div className="grid grid-cols-2 gap-4">
            <Field label="单任务步数上限（防死循环，§7.1）">
              <input type="number" min={10} max={500} className={inputCls} value={view.maxStepsPerTask} onChange={(e) => set('maxStepsPerTask', Number(e.target.value))} />
            </Field>
            <Field label="近期历史保留步数（§7.4）">
              <input type="number" min={1} max={20} className={inputCls} value={view.snapshotHistoryWindow} onChange={(e) => set('snapshotHistoryWindow', Number(e.target.value))} />
            </Field>
            <Field label="失败自动重试次数（指数退避，§8.2）">
              <input type="number" min={0} max={10} className={inputCls} value={view.taskMaxRetries} onChange={(e) => set('taskMaxRetries', Number(e.target.value))} />
            </Field>
          </div>
          <ToggleRow
            label="敏感操作前要求人工确认"
            hint="支付、下单、删除等动作会先暂停并弹窗等待你处理（§9）"
            checked={view.requireHumanConfirm}
            onChange={(v) => set('requireHumanConfirm', v)}
          />
          <ToggleRow
            label="每步执行后自动截图存档"
            hint="任务详情可回看，电商留凭证用"
            checked={view.screenshotOnStep}
            onChange={(v) => set('screenshotOnStep', v)}
          />
          <ToggleRow
            label="任务执行时录像（屏幕录制）"
            hint="任务详情可回放完整操作过程（webm）；会增加磁盘与 CPU 开销"
            checked={view.recordTasks}
            onChange={(v) => set('recordTasks', v)}
          />
        </Section>

        <Section title="通知">
          <ToggleRow
            label="任务完成 / 失败时发送桌面通知"
            hint="批量任务聚合为一条"
            checked={view.notifyDesktop}
            onChange={(v) => set('notifyDesktop', v)}
          />
          <Field label="Webhook 地址（留空 = 关闭）" hint="支持钉钉 / 企业微信群机器人或自建服务；任务到达终态时 POST JSON">
            <input className={inputCls} value={view.webhookUrl} onChange={(e) => set('webhookUrl', e.target.value)} placeholder="https://oapi.dingtalk.com/robot/send?access_token=..." />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Webhook 触发范围">
              <select className={inputCls} value={view.webhookEvents} onChange={(e) => set('webhookEvents', e.target.value as 'all' | 'failed')}>
                <option value="all">完成 + 失败都推送</option>
                <option value="failed">仅失败时推送</option>
              </select>
            </Field>
          </div>
          <div className="flex items-center gap-3">
            <Button variant="outline" leftIcon="Notification" onClick={() => void testWebhook()}>发送测试消息</Button>
            {webhookTest && <span className={`text-xs ${resultCls(webhookTest)}`}>{webhookTest}</span>}
          </div>
        </Section>

        <Section title="外观">
          <div className="flex items-center justify-between gap-4 rounded-[10px] bg-[var(--fill-1)] px-3.5 py-3">
            <div className="min-w-0">
              <p className="text-[13px] text-slate-300">主题</p>
              <p className="mt-0.5 text-xs text-slate-500">深色 / 亮色，保存后立即生效</p>
            </div>
            <Segmented
              options={[
                { value: 'dark', label: '深色' },
                { value: 'light', label: '亮色' },
              ]}
              value={view.theme}
              onChange={(v) => set('theme', v)}
            />
          </div>
        </Section>

        <Section title="反检测与成本">
          <ToggleRow
            label="拟人行为模拟"
            hint="思考延迟、鼠标 hover 预热、输入节奏等（对抗行为指纹检测）；关闭后动作更机械但更快"
            checked={view.behaviorSimulation}
            onChange={(v) => set('behaviorSimulation', v)}
          />
          <Field label="LLM 单价（元 / 千 token，0 = 不估算成本）" hint="工作台统计条会按此单价估算每次任务的花费，如 2 元/千 token 填 2">
            <input
              type="number"
              min={0}
              step={0.01}
              className={inputCls}
              value={view.llmPricePer1kTokens}
              onChange={(e) => set('llmPricePer1kTokens', Math.max(0, Number(e.target.value)))}
            />
          </Field>
        </Section>

        <Section title="代理池" desc="全局代理列表：批量导入 → 一键验证 → 在 Profile 编辑里选择「使用代理池」自动分配">
          <ProxyPoolPanel />
        </Section>

        <Section title="更新">
          <ToggleRow
            label="启动时检查新版本"
            hint="检测到 GitHub 有新 Release 时提示下载；网络不通自动跳过"
            checked={view.checkUpdates}
            onChange={(v) => set('checkUpdates', v)}
          />
          <div className="flex items-center gap-3">
            <Button variant="outline" leftIcon="Update" onClick={() => void checkUpdate()} disabled={checkingUpdate}>
              {checkingUpdate ? '检查中…' : '立即检查更新'}
            </Button>
            {updateResult && (
              <span className={`text-xs ${updateResult.hasUpdate ? 'text-info' : 'text-ok'}`}>
                {updateResult.hasUpdate
                  ? `发现新版本 ${updateResult.latest}（当前 ${updateResult.current}）→ 点击下载`
                  : `当前已是最新版本 v${updateResult.current}`}
              </span>
            )}
            {updateResult?.hasUpdate && (
              <a
                href={updateResult.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-[26px] items-center rounded-lg bg-info-soft px-2.5 text-xs font-medium text-info transition-colors hover:bg-[var(--info-soft-strong)]"
              >
                <Icon name="Download" size={14} className="mr-1" />
                去下载
              </a>
            )}
          </div>
        </Section>

        <div className="flex items-center gap-3 pb-6">
          <Button variant="primary" size="lg" leftIcon="Check" onClick={() => void save()}>
            保存设置
          </Button>
          {saved && (
            <span className="flex items-center gap-1 text-[13px] text-ok">
              <Icon name="Check" size={14} />
              已保存
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ 区块 / 开关行

function Section(props: { title: string; desc?: string; children: ReactNode }) {
  return (
    <Card className="space-y-4 p-5">
      <div>
        <h2 className="text-[15px] font-semibold text-slate-200">{props.title}</h2>
        {props.desc && <p className="mt-0.5 text-xs text-slate-500">{props.desc}</p>}
      </div>
      {props.children}
    </Card>
  );
}

function ToggleRow(props: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-[10px] bg-[var(--fill-1)] px-3.5 py-3">
      <div className="min-w-0">
        <p className="text-[13px] text-slate-300">{props.label}</p>
        {props.hint && <p className="mt-0.5 text-xs text-slate-500">{props.hint}</p>}
      </div>
      <Toggle size="sm" checked={props.checked} onChange={props.onChange} />
    </div>
  );
}
