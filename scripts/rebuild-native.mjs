/**
 * better-sqlite3 原生模块重建（不依赖本机 Visual Studio）：
 * 读取已安装 Electron 的版本，用 prebuild-install 拉取对应 ABI 的预编译二进制。
 * 拉取失败（离线 / 无匹配 prebuild）时退回 electron-builder install-app-deps（源码编译）。
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'package.json'));

const electronVersion = require('electron/package.json').version;
const bs3Dir = path.dirname(require.resolve('better-sqlite3/package.json'));
const prebuildBin = require.resolve('prebuild-install/bin.js');

console.log(`[rebuild-native] electron@${electronVersion}，拉取 better-sqlite3 预编译二进制…`);
try {
  execFileSync(process.execPath, [prebuildBin, '-r', 'electron', '-t', electronVersion], {
    cwd: bs3Dir,
    stdio: 'inherit',
  });
  console.log('[rebuild-native] 完成。');
} catch {
  console.warn('[rebuild-native] 预编译拉取失败，退回 electron-builder install-app-deps（需要本机编译环境）…');
  execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['electron-builder', 'install-app-deps'], {
    cwd: root,
    stdio: 'inherit',
  });
}
