/** @type {import('tailwindcss').Config} */
// 设计令牌对齐 Kimi Design System（暗色为默认；亮色通过 html.light 上的 CSS 变量切换）。
// 策略：ink-*/slate-*/语义色全部走 CSS 变量，页面类名两种主题零改动。
module.exports = {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // —— 表面层级（background.* / separator / fills）——
        ink: {
          950: 'var(--ink-950)', // 页面底 = background.primary
          900: 'var(--ink-900)', // 侧栏 = background.groundPc
          800: 'var(--ink-800)', // 卡片 / 浮起面 = background.secondary
          700: 'var(--ink-700)', // 三级面 / 弹窗 = background.tertiary
          600: 'var(--ink-600)', // 轻分隔线 = separator.s1（也作弱填充 fills.f2 用）
          500: 'var(--ink-500)', // 略强分隔
        },
        accent: {
          DEFAULT: 'var(--accent)',
          soft: 'var(--accent-soft)',
          hover: 'var(--accent-hover)',
        },
        // —— 文字层级 = labels.* ——
        slate: {
          200: 'var(--slate-200)',
          300: 'var(--slate-300)',
          400: 'var(--slate-400)',
          500: 'var(--slate-500)',
          600: 'var(--slate-600)',
        },
        // —— 语义色 = status.* ——
        ok: { DEFAULT: 'var(--ok)', soft: 'var(--ok-soft)' },
        warn: { DEFAULT: 'var(--warn)', soft: 'var(--warn-soft)' },
        danger: { DEFAULT: 'var(--danger)', soft: 'var(--danger-soft)' },
        info: { DEFAULT: 'var(--info)', soft: 'var(--info-soft)' },
        violet: { DEFAULT: 'var(--violet)', soft: 'var(--violet-soft)' },
      },
      fontFamily: {
        sans: ['"PingFang SC"', '"Microsoft YaHei"', 'system-ui', '-apple-system', '"Segoe UI"', 'sans-serif'],
        mono: ['"JetBrains Mono"', '"Cascadia Mono"', 'Consolas', 'monospace'],
      },
      transitionTimingFunction: {
        // 覆盖默认 ease-out → Kimi 曲线 cubic-bezier(0.23, 1, 0.32, 1)
        out: 'cubic-bezier(0.23, 1, 0.32, 1)',
        'in-out': 'cubic-bezier(0.77, 0, 0.175, 1)',
        drawer: 'cubic-bezier(0.32, 0.72, 0, 1)',
      },
      keyframes: {
        'modal-in': {
          from: { opacity: '0', transform: 'scale(0.96)' },
          to: { opacity: '1', transform: 'scale(1)' },
        },
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'toast-in': {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'modal-in': 'modal-in 180ms cubic-bezier(0.23, 1, 0.32, 1) both',
        'fade-in': 'fade-in 160ms ease both',
        'toast-in': 'toast-in 240ms cubic-bezier(0.23, 1, 0.32, 1) both',
      },
    },
  },
  plugins: [],
};
