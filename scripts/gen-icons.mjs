// 从 Kimi Design System 图标库抽取本项目用到的图标，生成 components/icons.tsx
// 用法：node scripts/gen-icons.mjs
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC =
  'C:/Users/章振威/AppData/Roaming/kimi-desktop/daimon-share/daimon/skills/kimi-design-skill/assets/icons';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '../src/renderer/src/components/icons.tsx');

// 项目用到的图标（键 = 组件里的名字，值 = 图标库 SVG 文件名）
const NAMES = [
  // 导航
  'Robot', 'Profile', 'List', 'History', 'Setting',
  // 动作
  'Play', 'Pause', 'Stop', 'Delete', 'Download', 'Upload', 'Add', 'Minus',
  'Refresh', 'Search', 'Edit', 'Copy', 'Save', 'Send_b', 'More', 'Power',
  // 状态 / 提示
  'Check', 'Warning', 'Error', 'Info', 'Question',
  // 方向
  'Down', 'Up', 'Right', 'Close', 'ExpandRight', 'FoldLeft',
  // 对象
  'Camera', 'Scan', 'Link', 'Folder', 'Group', 'Browser', 'Document',
  'Computer', 'Switch', 'Tabular', 'Notification', 'Update', 'LoadingRight',
  'MultiSelected', 'AllSelected', 'Share', 'Tag', 'Pin', 'Enter',
];

const missing = NAMES.filter((n) => !existsSync(path.join(SRC, `${n}.svg`)));
if (missing.length) {
  console.error('缺少图标文件:', missing.join(', '));
  process.exit(1);
}

const entries = NAMES.map((name) => {
  const svg = readFileSync(path.join(SRC, `${name}.svg`), 'utf8');
  const inner = svg
    .replace(/[\s\S]*?<svg[^>]*>/, '')
    .replace(/<\/svg>\s*$/, '')
    .replace(/\s*\n\s*/g, '')
    .trim();
  return `  ${JSON.stringify(name)}: ${JSON.stringify(inner)},`;
});

const out = `// 本文件由 scripts/gen-icons.mjs 自动生成，请勿手改。
// 图标源自 Kimi Design System（24×24 viewBox，currentColor，1.8px 线性风格）。

const ICONS: Record<string, string> = {
${entries.join('\n')}
};

export type IconName = keyof typeof ICONS;

export function Icon(props: {
  name: IconName;
  size?: number;
  className?: string;
  'aria-label'?: string;
}) {
  const { name, size = 18, className } = props;
  const label = props['aria-label'];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={\`shrink-0 \${className ?? ''}\`}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? 'img' : undefined}
      dangerouslySetInnerHTML={{ __html: ICONS[name] }}
    />
  );
}
`;

writeFileSync(OUT, out, 'utf8');
console.log(`已生成 ${OUT}（${NAMES.length} 个图标）`);
