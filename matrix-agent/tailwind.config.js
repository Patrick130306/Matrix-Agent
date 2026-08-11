/** @type {import('tailwindcss').Config} */
// 设计令牌对齐 Kimi Design System（暗色）。
// 策略：保留旧类名 ink-*/slate-*，底层值整体替换为 Kimi token，页面类名改动最小。
module.exports = {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // —— 表面层级（background.* / separator / fills）——
        ink: {
          950: '#121212', // 页面底 = background.primary
          900: '#161717', // 侧栏 = background.groundPc
          800: '#1f1f1f', // 卡片 / 浮起面 = background.secondary
          700: '#292929', // 三级面 / 弹窗 = background.tertiary
          600: 'rgba(255,255,255,0.12)', // 轻分隔线 = separator.s1（也作弱填充 fills.f2 用）
          500: 'rgba(255,255,255,0.20)', // 略强分隔
        },
        accent: {
          DEFAULT: '#1a88ff', // kimiBlue
          soft: 'rgba(26,136,255,0.14)', // 弱蓝底
          hover: '#3d9bff',
        },
        // —— 文字层级 = labels.* ——
        slate: {
          200: 'rgba(255,255,255,0.84)', // labels.primary
          300: 'rgba(255,255,255,0.68)',
          400: 'rgba(255,255,255,0.56)', // labels.secondary
          500: 'rgba(255,255,255,0.42)', // labels.tertiary
          600: 'rgba(255,255,255,0.26)', // labels.quaternary
        },
        // —— 语义色 = status.* ——
        ok: { DEFAULT: '#16c456', soft: 'rgba(22,196,86,0.14)' },
        warn: { DEFAULT: '#ff9f0a', soft: 'rgba(255,159,10,0.14)' },
        danger: { DEFAULT: '#ff4756', soft: 'rgba(255,71,86,0.14)' },
        info: { DEFAULT: '#1a88ff', soft: 'rgba(26,136,255,0.14)' },
        violet: { DEFAULT: '#a16bff', soft: 'rgba(161,107,255,0.14)' },
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
