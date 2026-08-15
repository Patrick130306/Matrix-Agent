import { useCallback, useEffect, useState } from 'react';
import type { Profile, ProfileGroup, Task, TaskStep } from '@shared/types';
import { matrix } from './api';
import { Dashboard } from './pages/Dashboard';
import { ProfilesPage } from './pages/Profiles';
import { TasksPage } from './pages/Tasks';
import { AutomationPage } from './pages/Automation';
import { SettingsPage } from './pages/Settings';
import { HumanConfirmDialog } from './components/HumanConfirmDialog';
import { FeedbackHost } from './components/feedback';
import { Icon, type IconName } from './components/icons';

interface TaskRow extends Task {
  steps?: TaskStep[];
}

type PageKey = 'dashboard' | 'profiles' | 'tasks' | 'automation' | 'settings';

const NAV: { key: PageKey; label: string; icon: IconName }[] = [
  { key: 'dashboard', label: '工作台', icon: 'Robot' },
  { key: 'profiles', label: 'Profile 管理', icon: 'Profile' },
  { key: 'tasks', label: '任务历史', icon: 'List' },
  { key: 'automation', label: '自动化', icon: 'History' },
  { key: 'settings', label: '设置', icon: 'Setting' },
];

export default function App() {
  const [page, setPage] = useState<PageKey>('dashboard');
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [groups, setGroups] = useState<ProfileGroup[]>([]);
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');

  const refresh = useCallback(() => {
    void matrix.tasks.list().then((t) => setTasks(t as TaskRow[]));
    void matrix.profiles.list().then((p) => setProfiles(p as Profile[]));
    void matrix.groups.list().then(setGroups);
  }, []);

  // 主题：启动时读设置并应用到 documentElement（亮色 = html.light，覆盖 :root 变量）
  useEffect(() => {
    void matrix.settings.get().then((s) => {
      const t = (s as { theme?: 'dark' | 'light' }).theme === 'light' ? 'light' : 'dark';
      setTheme(t);
      document.documentElement.classList.toggle('light', t === 'light');
    });
  }, []);

  // 左下角快捷切换：亮色显示太阳（点按切暗），暗色显示月亮（点按切亮），即时生效并持久化
  const toggleTheme = () => {
    const next: 'dark' | 'light' = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    document.documentElement.classList.toggle('light', next === 'light');
    void matrix.settings.set({ theme: next }).catch(() => undefined);
  };

  useEffect(() => {
    refresh();
    // 任务事件驱动即时刷新；再挂一个慢轮询兜底（Profile 状态变化等）
    const unsubscribe = matrix.events.onTaskEvent(() => refresh());
    const timer = setInterval(refresh, 5000);
    return () => {
      unsubscribe();
      clearInterval(timer);
    };
  }, [refresh]);

  const runningCount = tasks.filter((t) => t.status === 'running').length;

  return (
    <div className="flex h-full">
      {/* 侧边导航 */}
      <nav className="flex w-60 shrink-0 flex-col border-r border-ink-600 bg-ink-900">
        <div className="flex h-14 items-center gap-2.5 border-b border-ink-600 px-5">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent-soft text-accent">
            <Icon name="Robot" size={18} />
          </div>
          <div>
            <h1 className="text-[15px] font-semibold leading-5 text-slate-200">Matrix Agent</h1>
            <p className="text-[11px] leading-4 text-slate-600">AI-Native 浏览器集群</p>
          </div>
        </div>
        <ul className="flex-1 space-y-0.5 p-3">
          {NAV.map((item) => (
            <li key={item.key}>
              <button
                className={`flex h-9 w-full items-center gap-2.5 rounded-[10px] px-3 text-sm transition-colors duration-150 ease-out ${
                  page === item.key
                    ? 'bg-[var(--fill-2)] font-medium text-slate-200'
                    : 'text-slate-400 hover:bg-[var(--fill-1)] hover:text-slate-200'
                }`}
                onClick={() => setPage(item.key)}
              >
                <Icon name={item.icon} size={18} />
                {item.label}
                {item.key === 'dashboard' && runningCount > 0 && (
                  <span className="ml-auto rounded-md bg-info-soft px-1.5 text-xs font-medium leading-[18px] text-info">
                    {runningCount}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
        <div className="flex items-center justify-between border-t border-ink-600 px-4 py-3">
          <span className="text-xs leading-4 text-slate-600">MVP v3.0</span>
          <button
            type="button"
            title={theme === 'dark' ? '切换到亮色主题' : '切换到暗色主题'}
            aria-label={theme === 'dark' ? '切换到亮色主题' : '切换到暗色主题'}
            onClick={toggleTheme}
            className="flex h-6 w-6 items-center justify-center rounded-md text-slate-500 transition-colors duration-150 ease-out hover:bg-[var(--fill-1)] hover:text-slate-200 active:scale-95"
          >
            <Icon name={theme === 'dark' ? 'Moon' : 'Sun'} size={16} />
          </button>
        </div>
      </nav>

      {/* 主区域 */}
      <main className="min-w-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-[1200px] px-8 py-6">
          {page === 'dashboard' && <Dashboard tasks={tasks} profiles={profiles} groups={groups} refresh={refresh} />}
          {page === 'profiles' && <ProfilesPage profiles={profiles} groups={groups} refresh={refresh} />}
          {page === 'tasks' && <TasksPage tasks={tasks} profiles={profiles} refresh={refresh} />}
          {page === 'automation' && <AutomationPage profiles={profiles} />}
          {page === 'settings' && <SettingsPage />}
        </div>
      </main>

      {/* §9 人机协同弹窗（全局监听） */}
      <HumanConfirmDialog />

      {/* 全局 Toast / 确认框 / 输入框 */}
      <FeedbackHost />
    </div>
  );
}
