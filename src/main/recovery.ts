/**
 * §8.3 崩溃恢复（Recovery）—— App 启动时执行。
 *
 * 1. 任务状态修复：running / paused → interrupted，等待用户处置；
 * 2. 孤儿进程回收：检测并杀掉属于本应用的残留 Chrome 进程
 *    （通过进程命令行中的 --user-data-dir 路径二次确认归属，避免误杀用户自己的 Chrome）；
 * 3. 锁文件清理：清理 userDataDir 中残留的 SingletonLock / SingletonSocket / SingletonCookie；
 * 4. 调度恢复：pending 任务保持 pending，调度器启动后自动入队。
 */
import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import {
  clearRunningInstances,
  getProfilesDir,
  listRunningInstances,
  markActiveTasksInterrupted,
} from './db';

const execAsync = promisify(exec);

const SINGLETON_FILES = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];

/** 清理指定 userDataDir 的 Chrome 单例锁文件（§8.3-3，启动前也必须调用）。 */
export function cleanSingletonLocks(userDataDir: string): void {
  for (const name of SINGLETON_FILES) {
    const p = path.join(userDataDir, name);
    try {
      fs.rmSync(p, { force: true });
    } catch (err) {
      console.warn(`[recovery] 锁文件清理失败 ${p}:`, err);
    }
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // 信号 0：仅探测存活
    return true;
  } catch (err) {
    // EPERM 说明进程存在但无权限（仍视为存活），ESRCH 说明不存在
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** 读取进程命令行；失败返回空串。 */
async function getProcessCommandLine(pid: number): Promise<string> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execAsync(
        `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine"`,
      );
      return stdout.trim();
    }
    const { stdout } = await execAsync(`ps -p ${pid} -o args=`);
    return stdout.trim();
  } catch {
    return '';
  }
}

export interface RecoveryReport {
  interruptedTasks: number;
  killedOrphans: number;
  cleanedLocks: number;
}

export async function runRecovery(): Promise<RecoveryReport> {
  const report: RecoveryReport = { interruptedTasks: 0, killedOrphans: 0, cleanedLocks: 0 };

  // 1. 任务状态修复
  report.interruptedTasks = markActiveTasksInterrupted();
  if (report.interruptedTasks > 0) {
    console.log(`[recovery] ${report.interruptedTasks} 个任务标记为 interrupted`);
  }

  // 2. 孤儿 Chrome 进程回收
  const profilesDir = getProfilesDir().toLowerCase();
  const instances = listRunningInstances();
  for (const inst of instances) {
    if (!isPidAlive(inst.pid)) continue;
    const cmdline = (await getProcessCommandLine(inst.pid)).toLowerCase();
    // 二次确认归属：命令行必须包含我们的 profiles 目录（即 --user-data-dir 指向我们）
    const isOurs =
      (cmdline.includes('chrome') || cmdline.includes('chromium')) &&
      cmdline.includes('--user-data-dir') &&
      cmdline.includes(profilesDir);
    if (isOurs) {
      try {
        process.kill(inst.pid, 'SIGKILL');
        report.killedOrphans++;
        console.log(`[recovery] 回收孤儿 Chrome 进程 pid=${inst.pid} (profile=${inst.profileId})`);
      } catch (err) {
        console.warn(`[recovery] 无法杀掉 pid=${inst.pid}:`, err);
      }
    } else {
      console.warn(`[recovery] pid=${inst.pid} 命令行归属无法确认，跳过（避免误杀用户 Chrome）`);
    }
  }
  clearRunningInstances();

  // 3. 所有 Profile 目录的锁文件清理
  try {
    const dirs = fs.readdirSync(getProfilesDir(), { withFileTypes: true });
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const dir = path.join(getProfilesDir(), d.name);
      for (const name of SINGLETON_FILES) {
        if (fs.existsSync(path.join(dir, name))) {
          cleanSingletonLocks(dir);
          report.cleanedLocks++;
          break;
        }
      }
    }
  } catch (err) {
    console.warn('[recovery] 锁文件扫描失败:', err);
  }

  // 4. pending 任务无需处理：调度器启动时会扫描 pending 并重新入队（§8.3-4）
  return report;
}
