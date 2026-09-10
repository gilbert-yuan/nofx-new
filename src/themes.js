/**
 * 主题系统
 * 预制多种经典配色方案（oklch + color-mix 现代色彩工程）
 *
 * 交易色规约：A 股红涨绿跌（涨=红 hue 27、跌=绿 hue 145）
 * 中性色：tinted neutral（chroma 0.008-0.014，跟随主题 hue）
 * 衍生色：color-mix(in oklch, ...) 派生，减少手维护
 *
 * 变量命名规范：
 * - bg-*       背景色
 * - text-*     文字色
 * - border-*   边框色
 * - brand-*    品牌色
 * - success/danger/warning/info  功能色
 * - long/short 交易方向色（A 股红涨绿跌）
 * - btn-*      按钮色
 * - chart-*    图表专用色
 * - shadow-*   阴影
 * - state-*    状态色 (hover/active/focus)
 */

export const themes = {
  // ========== 深色专业版 - 冷峻交易终端风格（hue 200 冷调） ==========
  dark: {
    name: '深色专业版',
    colors: {
      // ---- 背景色（深色 oklch 15-22%，冷色调 hue 200）----
      '--bg-primary': 'oklch(15% 0.012 200)',
      '--bg-secondary': 'oklch(17.5% 0.012 200)',
      '--bg-tertiary': 'oklch(20% 0.014 200)',
      '--bg-elevated': 'oklch(22% 0.014 200)',
      '--bg-card': 'oklch(19% 0.014 200)',
      '--bg-input': 'oklch(20% 0.014 200)',
      '--bg-overlay': 'oklch(12% 0.012 200 / 0.72)',

      // ---- 文字色（亮色，冷调）----
      '--text-primary': 'oklch(93% 0.008 200)',
      '--text-secondary': 'oklch(80% 0.008 200)',
      '--text-tertiary': 'oklch(65% 0.008 200)',
      '--text-muted': 'oklch(50% 0.008 200)',
      '--text-inverse': 'oklch(15% 0.012 200)',

      // ---- 边框色 ----
      '--border-primary': 'oklch(28% 0.014 200)',
      '--border-secondary': 'oklch(24% 0.014 200)',
      '--border-tertiary': 'oklch(21% 0.014 200)',
      '--border-hover': 'oklch(34% 0.014 200)',

      // ---- 品牌色（NOFX 青绿 hue 165）----
      '--brand-primary': 'oklch(72% 0.15 165)',
      '--brand-secondary': 'oklch(65% 0.14 165)',
      '--brand-tertiary': 'oklch(58% 0.13 165)',
      '--brand-bg': 'color-mix(in oklch, var(--brand-primary) 12%, transparent)',

      // ---- 功能色 ----
      '--success': 'oklch(72% 0.15 165)',
      '--success-bg': 'color-mix(in oklch, var(--success) 12%, transparent)',
      '--danger': 'oklch(64% 0.21 27)',
      '--danger-bg': 'color-mix(in oklch, var(--danger) 12%, transparent)',
      '--warning': 'oklch(75% 0.15 75)',
      '--warning-bg': 'color-mix(in oklch, var(--warning) 12%, transparent)',
      '--info': 'oklch(70% 0.12 240)',
      '--info-bg': 'color-mix(in oklch, var(--info) 12%, transparent)',

      // ---- 交易色（A 股红涨绿跌：涨=红、跌=绿）----
      '--long': 'oklch(64% 0.21 27)',
      '--long-bg': 'color-mix(in oklch, var(--long) 15%, transparent)',
      '--short': 'oklch(62% 0.16 145)',
      '--short-bg': 'color-mix(in oklch, var(--short) 15%, transparent)',

      // ---- 盈亏色（盈=红涨、亏=绿跌）----
      '--profit': 'oklch(64% 0.21 27)',
      '--profit-bg': 'color-mix(in oklch, var(--profit) 15%, transparent)',
      '--loss': 'oklch(62% 0.16 145)',
      '--loss-bg': 'color-mix(in oklch, var(--loss) 15%, transparent)',

      // ---- 按钮 ----
      '--btn-primary-bg': 'oklch(72% 0.15 165)',
      '--btn-primary-text': 'oklch(15% 0.012 200)',
      '--btn-primary-hover': 'oklch(78% 0.14 165)',
      '--btn-secondary-bg': 'oklch(26% 0.014 200)',
      '--btn-secondary-text': 'oklch(93% 0.008 200)',
      '--btn-secondary-hover': 'oklch(30% 0.014 200)',
      '--btn-ghost-bg': 'transparent',
      '--btn-ghost-text': 'oklch(93% 0.008 200)',
      '--btn-ghost-hover': 'oklch(26% 0.014 200)',

      // ---- 状态色 ----
      '--state-hover': 'color-mix(in oklch, white 5%, transparent)',
      '--state-active': 'color-mix(in oklch, white 8%, transparent)',
      '--state-focus': 'color-mix(in oklch, var(--brand-primary) 30%, transparent)',
      '--state-selected': 'color-mix(in oklch, var(--brand-primary) 10%, transparent)',

      // ---- 图表色（A 股红涨绿跌）----
      '--chart-grid': 'oklch(30% 0.014 200)',
      '--chart-grid-dash': 'oklch(24% 0.014 200)',
      '--chart-axis': 'oklch(50% 0.008 200)',
      '--chart-crosshair': 'oklch(55% 0.008 200)',
      '--chart-up': 'oklch(64% 0.21 27)',
      '--chart-down': 'oklch(62% 0.16 145)',
      '--chart-volume-up': 'color-mix(in oklch, var(--chart-up) 40%, transparent)',
      '--chart-volume-down': 'color-mix(in oklch, var(--chart-down) 40%, transparent)',

      // ---- 阴影（深色模式极简，不用发光）----
      '--shadow-sm': '0 1px 2px oklch(0% 0 0 / 0.3)',
      '--shadow-md': '0 4px 12px oklch(0% 0 0 / 0.4)',
      '--shadow-lg': '0 8px 24px oklch(0% 0 0 / 0.5)',
      '--shadow-glow': '0 0 20px color-mix(in oklch, var(--brand-primary) 20%, transparent)',
    }
  },

  // ========== 蓝色现代版 - 现代简约风格（hue 240 蓝调） ==========
  blue: {
    name: '蓝色现代版',
    colors: {
      // ---- 背景色（深色，蓝调 hue 240）----
      '--bg-primary': 'oklch(15% 0.012 240)',
      '--bg-secondary': 'oklch(17.5% 0.012 240)',
      '--bg-tertiary': 'oklch(20% 0.014 240)',
      '--bg-elevated': 'oklch(22% 0.014 240)',
      '--bg-card': 'oklch(19% 0.014 240)',
      '--bg-input': 'oklch(20% 0.014 240)',
      '--bg-overlay': 'oklch(12% 0.012 240 / 0.72)',

      // ---- 文字色 ----
      '--text-primary': 'oklch(93% 0.008 240)',
      '--text-secondary': 'oklch(80% 0.008 240)',
      '--text-tertiary': 'oklch(65% 0.008 240)',
      '--text-muted': 'oklch(50% 0.008 240)',
      '--text-inverse': 'oklch(15% 0.012 240)',

      // ---- 边框色 ----
      '--border-primary': 'oklch(28% 0.014 240)',
      '--border-secondary': 'oklch(24% 0.014 240)',
      '--border-tertiary': 'oklch(21% 0.014 240)',
      '--border-hover': 'oklch(34% 0.014 240)',

      // ---- 品牌色（蓝 hue 250）----
      '--brand-primary': 'oklch(70% 0.13 250)',
      '--brand-secondary': 'oklch(63% 0.14 250)',
      '--brand-tertiary': 'oklch(56% 0.13 250)',
      '--brand-bg': 'color-mix(in oklch, var(--brand-primary) 12%, transparent)',

      // ---- 功能色 ----
      '--success': 'oklch(72% 0.15 165)',
      '--success-bg': 'color-mix(in oklch, var(--success) 12%, transparent)',
      '--danger': 'oklch(64% 0.21 27)',
      '--danger-bg': 'color-mix(in oklch, var(--danger) 12%, transparent)',
      '--warning': 'oklch(75% 0.15 75)',
      '--warning-bg': 'color-mix(in oklch, var(--warning) 12%, transparent)',
      '--info': 'oklch(70% 0.12 240)',
      '--info-bg': 'color-mix(in oklch, var(--info) 12%, transparent)',

      // ---- 交易色（A 股红涨绿跌）----
      '--long': 'oklch(64% 0.21 27)',
      '--long-bg': 'color-mix(in oklch, var(--long) 15%, transparent)',
      '--short': 'oklch(62% 0.16 145)',
      '--short-bg': 'color-mix(in oklch, var(--short) 15%, transparent)',

      // ---- 盈亏色 ----
      '--profit': 'oklch(64% 0.21 27)',
      '--profit-bg': 'color-mix(in oklch, var(--profit) 15%, transparent)',
      '--loss': 'oklch(62% 0.16 145)',
      '--loss-bg': 'color-mix(in oklch, var(--loss) 15%, transparent)',

      // ---- 按钮 ----
      '--btn-primary-bg': 'oklch(70% 0.13 250)',
      '--btn-primary-text': 'oklch(15% 0.012 240)',
      '--btn-primary-hover': 'oklch(76% 0.12 250)',
      '--btn-secondary-bg': 'oklch(26% 0.014 240)',
      '--btn-secondary-text': 'oklch(93% 0.008 240)',
      '--btn-secondary-hover': 'oklch(30% 0.014 240)',
      '--btn-ghost-bg': 'transparent',
      '--btn-ghost-text': 'oklch(93% 0.008 240)',
      '--btn-ghost-hover': 'oklch(26% 0.014 240)',

      // ---- 状态色 ----
      '--state-hover': 'color-mix(in oklch, white 5%, transparent)',
      '--state-active': 'color-mix(in oklch, white 8%, transparent)',
      '--state-focus': 'color-mix(in oklch, var(--brand-primary) 30%, transparent)',
      '--state-selected': 'color-mix(in oklch, var(--brand-primary) 10%, transparent)',

      // ---- 图表色（A 股红涨绿跌）----
      '--chart-grid': 'oklch(30% 0.014 240)',
      '--chart-grid-dash': 'oklch(24% 0.014 240)',
      '--chart-axis': 'oklch(50% 0.008 240)',
      '--chart-crosshair': 'oklch(55% 0.008 240)',
      '--chart-up': 'oklch(64% 0.21 27)',
      '--chart-down': 'oklch(62% 0.16 145)',
      '--chart-volume-up': 'color-mix(in oklch, var(--chart-up) 40%, transparent)',
      '--chart-volume-down': 'color-mix(in oklch, var(--chart-down) 40%, transparent)',

      // ---- 阴影 ----
      '--shadow-sm': '0 1px 2px oklch(0% 0 0 / 0.3)',
      '--shadow-md': '0 4px 12px oklch(0% 0 0 / 0.4)',
      '--shadow-lg': '0 8px 24px oklch(0% 0 0 / 0.5)',
      '--shadow-glow': '0 0 20px color-mix(in oklch, var(--brand-primary) 20%, transparent)',
    }
  },

  // ========== 紫色优雅版 - 优雅高端风格（hue 280 紫调） ==========
  purple: {
    name: '紫色优雅版',
    colors: {
      // ---- 背景色（深色，紫调 hue 290）----
      '--bg-primary': 'oklch(14% 0.018 290)',
      '--bg-secondary': 'oklch(17% 0.018 290)',
      '--bg-tertiary': 'oklch(20% 0.02 290)',
      '--bg-elevated': 'oklch(23% 0.02 290)',
      '--bg-card': 'oklch(19% 0.02 290)',
      '--bg-input': 'oklch(20% 0.02 290)',
      '--bg-overlay': 'oklch(11% 0.018 290 / 0.72)',

      // ---- 文字色 ----
      '--text-primary': 'oklch(93% 0.012 290)',
      '--text-secondary': 'oklch(80% 0.012 290)',
      '--text-tertiary': 'oklch(65% 0.012 290)',
      '--text-muted': 'oklch(50% 0.01 290)',
      '--text-inverse': 'oklch(14% 0.018 290)',

      // ---- 边框色 ----
      '--border-primary': 'oklch(30% 0.02 290)',
      '--border-secondary': 'oklch(25% 0.02 290)',
      '--border-tertiary': 'oklch(21% 0.02 290)',
      '--border-hover': 'oklch(36% 0.02 290)',

      // ---- 品牌色（紫 hue 295）----
      '--brand-primary': 'oklch(70% 0.14 295)',
      '--brand-secondary': 'oklch(63% 0.15 295)',
      '--brand-tertiary': 'oklch(56% 0.14 295)',
      '--brand-bg': 'color-mix(in oklch, var(--brand-primary) 12%, transparent)',

      // ---- 功能色 ----
      '--success': 'oklch(72% 0.15 165)',
      '--success-bg': 'color-mix(in oklch, var(--success) 12%, transparent)',
      '--danger': 'oklch(64% 0.21 27)',
      '--danger-bg': 'color-mix(in oklch, var(--danger) 12%, transparent)',
      '--warning': 'oklch(75% 0.15 75)',
      '--warning-bg': 'color-mix(in oklch, var(--warning) 12%, transparent)',
      '--info': 'oklch(70% 0.12 240)',
      '--info-bg': 'color-mix(in oklch, var(--info) 12%, transparent)',

      // ---- 交易色（A 股红涨绿跌）----
      '--long': 'oklch(64% 0.21 27)',
      '--long-bg': 'color-mix(in oklch, var(--long) 15%, transparent)',
      '--short': 'oklch(62% 0.16 145)',
      '--short-bg': 'color-mix(in oklch, var(--short) 15%, transparent)',

      // ---- 盈亏色 ----
      '--profit': 'oklch(64% 0.21 27)',
      '--profit-bg': 'color-mix(in oklch, var(--profit) 15%, transparent)',
      '--loss': 'oklch(62% 0.16 145)',
      '--loss-bg': 'color-mix(in oklch, var(--loss) 15%, transparent)',

      // ---- 按钮 ----
      '--btn-primary-bg': 'oklch(70% 0.14 295)',
      '--btn-primary-text': 'oklch(14% 0.018 290)',
      '--btn-primary-hover': 'oklch(76% 0.13 295)',
      '--btn-secondary-bg': 'oklch(28% 0.02 290)',
      '--btn-secondary-text': 'oklch(93% 0.012 290)',
      '--btn-secondary-hover': 'oklch(32% 0.02 290)',
      '--btn-ghost-bg': 'transparent',
      '--btn-ghost-text': 'oklch(93% 0.012 290)',
      '--btn-ghost-hover': 'oklch(28% 0.02 290)',

      // ---- 状态色 ----
      '--state-hover': 'color-mix(in oklch, white 5%, transparent)',
      '--state-active': 'color-mix(in oklch, white 8%, transparent)',
      '--state-focus': 'color-mix(in oklch, var(--brand-primary) 30%, transparent)',
      '--state-selected': 'color-mix(in oklch, var(--brand-primary) 10%, transparent)',

      // ---- 图表色（A 股红涨绿跌）----
      '--chart-grid': 'oklch(32% 0.02 290)',
      '--chart-grid-dash': 'oklch(25% 0.02 290)',
      '--chart-axis': 'oklch(50% 0.012 290)',
      '--chart-crosshair': 'oklch(55% 0.012 290)',
      '--chart-up': 'oklch(64% 0.21 27)',
      '--chart-down': 'oklch(62% 0.16 145)',
      '--chart-volume-up': 'color-mix(in oklch, var(--chart-up) 40%, transparent)',
      '--chart-volume-down': 'color-mix(in oklch, var(--chart-down) 40%, transparent)',

      // ---- 阴影 ----
      '--shadow-sm': '0 1px 2px oklch(0% 0 0 / 0.35)',
      '--shadow-md': '0 4px 12px oklch(0% 0 0 / 0.45)',
      '--shadow-lg': '0 8px 24px oklch(0% 0 0 / 0.55)',
      '--shadow-glow': '0 0 20px color-mix(in oklch, var(--brand-primary) 22%, transparent)',
    }
  },

  // ========== 浅色简约版 - 清爽明亮风格（hue 200 冷调，亮色） ==========
  light: {
    name: '浅色简约版',
    colors: {
      // ---- 背景色（亮色 oklch 95-99%，冷调 hue 200）----
      '--bg-primary': 'oklch(99% 0.003 200)',
      '--bg-secondary': 'oklch(97% 0.004 200)',
      '--bg-tertiary': 'oklch(95% 0.005 200)',
      '--bg-elevated': 'oklch(99% 0.003 200)',
      '--bg-card': 'oklch(99% 0.003 200)',
      '--bg-input': 'oklch(99% 0.003 200)',
      '--bg-overlay': 'oklch(20% 0.012 200 / 0.5)',

      // ---- 文字色（深色文字，冷调）----
      '--text-primary': 'oklch(22% 0.02 200)',
      '--text-secondary': 'oklch(38% 0.015 200)',
      '--text-tertiary': 'oklch(50% 0.012 200)',
      '--text-muted': 'oklch(60% 0.01 200)',
      '--text-inverse': 'oklch(99% 0.003 200)',

      // ---- 边框色 ----
      '--border-primary': 'oklch(90% 0.005 200)',
      '--border-secondary': 'oklch(94% 0.004 200)',
      '--border-tertiary': 'oklch(96% 0.003 200)',
      '--border-hover': 'oklch(85% 0.008 200)',

      // ---- 品牌色（蓝 hue 250，浅色背景需更深 chroma）----
      '--brand-primary': 'oklch(55% 0.22 250)',
      '--brand-secondary': 'oklch(50% 0.2 250)',
      '--brand-tertiary': 'oklch(45% 0.18 250)',
      '--brand-bg': 'color-mix(in oklch, var(--brand-primary) 10%, transparent)',

      // ---- 功能色（浅色背景需更深，保证对比度）----
      '--success': 'oklch(52% 0.15 165)',
      '--success-bg': 'color-mix(in oklch, var(--success) 10%, transparent)',
      '--danger': 'oklch(55% 0.22 27)',
      '--danger-bg': 'color-mix(in oklch, var(--danger) 10%, transparent)',
      '--warning': 'oklch(60% 0.16 75)',
      '--warning-bg': 'color-mix(in oklch, var(--warning) 12%, transparent)',
      '--info': 'oklch(52% 0.2 240)',
      '--info-bg': 'color-mix(in oklch, var(--info) 10%, transparent)',

      // ---- 交易色（A 股红涨绿跌，浅色背景加深）----
      '--long': 'oklch(55% 0.22 27)',
      '--long-bg': 'color-mix(in oklch, var(--long) 12%, transparent)',
      '--short': 'oklch(48% 0.15 145)',
      '--short-bg': 'color-mix(in oklch, var(--short) 12%, transparent)',

      // ---- 盈亏色 ----
      '--profit': 'oklch(55% 0.22 27)',
      '--profit-bg': 'color-mix(in oklch, var(--profit) 12%, transparent)',
      '--loss': 'oklch(48% 0.15 145)',
      '--loss-bg': 'color-mix(in oklch, var(--loss) 12%, transparent)',

      // ---- 按钮 ----
      '--btn-primary-bg': 'oklch(55% 0.22 250)',
      '--btn-primary-text': 'oklch(99% 0.003 200)',
      '--btn-primary-hover': 'oklch(50% 0.2 250)',
      '--btn-secondary-bg': 'oklch(90% 0.005 200)',
      '--btn-secondary-text': 'oklch(25% 0.015 200)',
      '--btn-secondary-hover': 'oklch(85% 0.008 200)',
      '--btn-ghost-bg': 'transparent',
      '--btn-ghost-text': 'oklch(25% 0.015 200)',
      '--btn-ghost-hover': 'oklch(95% 0.005 200)',

      // ---- 状态色（浅色用 black 派生）----
      '--state-hover': 'color-mix(in oklch, black 4%, transparent)',
      '--state-active': 'color-mix(in oklch, black 6%, transparent)',
      '--state-focus': 'color-mix(in oklch, var(--brand-primary) 25%, transparent)',
      '--state-selected': 'color-mix(in oklch, var(--brand-primary) 8%, transparent)',

      // ---- 图表色（A 股红涨绿跌，浅色）----
      '--chart-grid': 'oklch(90% 0.005 200)',
      '--chart-grid-dash': 'oklch(94% 0.004 200)',
      '--chart-axis': 'oklch(55% 0.012 200)',
      '--chart-crosshair': 'oklch(60% 0.01 200)',
      '--chart-up': 'oklch(55% 0.22 27)',
      '--chart-down': 'oklch(48% 0.15 145)',
      '--chart-volume-up': 'color-mix(in oklch, var(--chart-up) 28%, transparent)',
      '--chart-volume-down': 'color-mix(in oklch, var(--chart-down) 28%, transparent)',

      // ---- 阴影（浅色用阴影做深度）----
      '--shadow-sm': '0 1px 2px oklch(20% 0.012 200 / 0.08)',
      '--shadow-md': '0 4px 12px oklch(20% 0.012 200 / 0.1)',
      '--shadow-lg': '0 8px 24px oklch(20% 0.012 200 / 0.12)',
      '--shadow-glow': '0 0 20px color-mix(in oklch, var(--brand-primary) 15%, transparent)',
    }
  },

  // ========== 绿色经典版 - 原版配色优化（hue 150 绿调，亮色） ==========
  green: {
    name: '绿色经典版',
    colors: {
      // ---- 背景色（亮色，绿调 hue 150）----
      '--bg-primary': 'oklch(98% 0.005 150)',
      '--bg-secondary': 'oklch(99% 0.004 150)',
      '--bg-tertiary': 'oklch(96% 0.006 150)',
      '--bg-elevated': 'oklch(99% 0.004 150)',
      '--bg-card': 'oklch(99% 0.004 150)',
      '--bg-input': 'oklch(99% 0.004 150)',
      '--bg-overlay': 'oklch(20% 0.012 150 / 0.5)',

      // ---- 文字色（深色，绿调）----
      '--text-primary': 'oklch(22% 0.02 150)',
      '--text-secondary': 'oklch(38% 0.018 150)',
      '--text-tertiary': 'oklch(52% 0.015 150)',
      '--text-muted': 'oklch(62% 0.012 150)',
      '--text-inverse': 'oklch(99% 0.004 150)',

      // ---- 边框色 ----
      '--border-primary': 'oklch(88% 0.01 150)',
      '--border-secondary': 'oklch(92% 0.008 150)',
      '--border-tertiary': 'oklch(95% 0.006 150)',
      '--border-hover': 'oklch(80% 0.015 150)',

      // ---- 品牌色（绿 hue 155，浅色背景加深）----
      '--brand-primary': 'oklch(48% 0.13 155)',
      '--brand-secondary': 'oklch(43% 0.12 155)',
      '--brand-tertiary': 'oklch(38% 0.11 155)',
      '--brand-bg': 'color-mix(in oklch, var(--brand-primary) 10%, transparent)',

      // ---- 功能色 ----
      '--success': 'oklch(48% 0.13 155)',
      '--success-bg': 'color-mix(in oklch, var(--success) 10%, transparent)',
      '--danger': 'oklch(55% 0.22 27)',
      '--danger-bg': 'color-mix(in oklch, var(--danger) 10%, transparent)',
      '--warning': 'oklch(60% 0.16 75)',
      '--warning-bg': 'color-mix(in oklch, var(--warning) 12%, transparent)',
      '--info': 'oklch(52% 0.2 240)',
      '--info-bg': 'color-mix(in oklch, var(--info) 10%, transparent)',

      // ---- 交易色（A 股红涨绿跌，浅色背景加深）----
      '--long': 'oklch(55% 0.22 27)',
      '--long-bg': 'color-mix(in oklch, var(--long) 12%, transparent)',
      '--short': 'oklch(45% 0.13 155)',
      '--short-bg': 'color-mix(in oklch, var(--short) 12%, transparent)',

      // ---- 盈亏色 ----
      '--profit': 'oklch(55% 0.22 27)',
      '--profit-bg': 'color-mix(in oklch, var(--profit) 12%, transparent)',
      '--loss': 'oklch(45% 0.13 155)',
      '--loss-bg': 'color-mix(in oklch, var(--loss) 12%, transparent)',

      // ---- 按钮 ----
      '--btn-primary-bg': 'oklch(48% 0.13 155)',
      '--btn-primary-text': 'oklch(99% 0.004 150)',
      '--btn-primary-hover': 'oklch(43% 0.12 155)',
      '--btn-secondary-bg': 'oklch(88% 0.01 150)',
      '--btn-secondary-text': 'oklch(25% 0.018 150)',
      '--btn-secondary-hover': 'oklch(82% 0.012 150)',
      '--btn-ghost-bg': 'transparent',
      '--btn-ghost-text': 'oklch(25% 0.018 150)',
      '--btn-ghost-hover': 'oklch(94% 0.006 150)',

      // ---- 状态色 ----
      '--state-hover': 'color-mix(in oklch, black 4%, transparent)',
      '--state-active': 'color-mix(in oklch, black 6%, transparent)',
      '--state-focus': 'color-mix(in oklch, var(--brand-primary) 25%, transparent)',
      '--state-selected': 'color-mix(in oklch, var(--brand-primary) 8%, transparent)',

      // ---- 图表色（A 股红涨绿跌，浅色）----
      '--chart-grid': 'oklch(88% 0.01 150)',
      '--chart-grid-dash': 'oklch(92% 0.008 150)',
      '--chart-axis': 'oklch(55% 0.015 150)',
      '--chart-crosshair': 'oklch(60% 0.012 150)',
      '--chart-up': 'oklch(55% 0.22 27)',
      '--chart-down': 'oklch(45% 0.13 155)',
      '--chart-volume-up': 'color-mix(in oklch, var(--chart-up) 28%, transparent)',
      '--chart-volume-down': 'color-mix(in oklch, var(--chart-down) 28%, transparent)',

      // ---- 阴影 ----
      '--shadow-sm': '0 1px 2px oklch(20% 0.012 150 / 0.08)',
      '--shadow-md': '0 4px 12px oklch(20% 0.012 150 / 0.1)',
      '--shadow-lg': '0 8px 24px oklch(20% 0.012 150 / 0.12)',
      '--shadow-glow': '0 0 20px color-mix(in oklch, var(--brand-primary) 15%, transparent)',
    }
  },
};

/**
 * 应用主题
 * @param {string} themeName - 主题名称
 */
export function applyTheme(themeName) {
  const theme = themes[themeName];
  if (!theme) return;

  const root = document.documentElement;
  Object.entries(theme.colors).forEach(([key, value]) => {
    root.style.setProperty(key, value);
  });

  // 设置 data-theme 属性，方便 CSS 选择器使用
  root.setAttribute('data-theme', themeName);

  // 保存到本地存储
  localStorage.setItem('nofx-theme', themeName);
}

/**
 * 获取当前主题名称
 * @returns {string} 主题名称
 */
export function getCurrentTheme() {
  return localStorage.getItem('nofx-theme') || 'dark';
}

/**
 * 初始化主题
 */
export function initTheme() {
  const savedTheme = getCurrentTheme();
  applyTheme(savedTheme);
}

/**
 * 获取所有主题列表
 * @returns {Array} 主题列表 [{ key, name }]
 */
export function getThemeList() {
  return Object.entries(themes).map(([key, theme]) => ({
    key,
    name: theme.name,
  }));
}
