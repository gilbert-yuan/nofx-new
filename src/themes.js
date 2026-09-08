/**
 * 主题系统
 * 预制多种经典配色方案
 * 
 * 变量命名规范：
 * - bg-*       背景色
 * - text-*     文字色
 * - border-*   边框色
 * - brand-*    品牌色
 * - success/danger/warning/info  功能色
 * - long/short 交易方向色
 * - btn-*      按钮色
 * - chart-*    图表专用色
 * - shadow-*   阴影
 * - state-*    状态色 (hover/active/focus)
 */

export const themes = {
  // ========== 深色专业版 - 经典交易终端风格 ==========
  dark: {
    name: '深色专业版',
    colors: {
      // ---- 背景色 ----
      '--bg-primary': '#0d1110',
      '--bg-secondary': '#141a19',
      '--bg-tertiary': '#1c2322',
      '--bg-elevated': '#232b2a',
      '--bg-card': '#1a2120',
      '--bg-input': '#1c2322',
      '--bg-overlay': 'rgba(0, 0, 0, 0.6)',

      // ---- 文字色 ----
      '--text-primary': '#e8f0ed',
      '--text-secondary': '#b8c4c0',
      '--text-tertiary': '#8a9a95',
      '--text-muted': '#66736e',
      '--text-inverse': '#0d1110',

      // ---- 边框色 ----
      '--border-primary': '#2d3836',
      '--border-secondary': '#222c2a',
      '--border-tertiary': '#1a2321',
      '--border-hover': '#3d4a48',

      // ---- 品牌色 ----
      '--brand-primary': '#00e0a8',
      '--brand-secondary': '#00bd8d',
      '--brand-tertiary': '#009a72',
      '--brand-bg': 'rgba(0, 224, 168, 0.12)',

      // ---- 功能色 ----
      '--success': '#00e0a8',
      '--success-bg': 'rgba(0, 224, 168, 0.12)',
      '--danger': '#ff6b6b',
      '--danger-bg': 'rgba(255, 107, 107, 0.12)',
      '--warning': '#f5a623',
      '--warning-bg': 'rgba(245, 166, 35, 0.12)',
      '--info': '#5eb8ff',
      '--info-bg': 'rgba(94, 184, 255, 0.12)',

      // ---- 交易色 ----
      '--long': '#00e0a8',
      '--long-bg': 'rgba(0, 224, 168, 0.15)',
      '--short': '#ff6b6b',
      '--short-bg': 'rgba(255, 107, 107, 0.15)',

      // ---- 盈亏色 ----
      '--profit': '#00e0a8',
      '--profit-bg': 'rgba(0, 224, 168, 0.15)',
      '--loss': '#ff6b6b',
      '--loss-bg': 'rgba(255, 107, 107, 0.15)',

      // ---- 按钮 ----
      '--btn-primary-bg': '#00e0a8',
      '--btn-primary-text': '#0d1110',
      '--btn-primary-hover': '#1aebbd',
      '--btn-secondary-bg': '#252f2d',
      '--btn-secondary-text': '#e8f0ed',
      '--btn-secondary-hover': '#2f3b39',
      '--btn-ghost-bg': 'transparent',
      '--btn-ghost-text': '#e8f0ed',
      '--btn-ghost-hover': '#252f2d',

      // ---- 状态色 ----
      '--state-hover': 'rgba(255, 255, 255, 0.05)',
      '--state-active': 'rgba(255, 255, 255, 0.08)',
      '--state-focus': 'rgba(0, 224, 168, 0.3)',
      '--state-selected': 'rgba(0, 224, 168, 0.1)',

      // ---- 图表色 ----
      '--chart-grid': '#2a3533',
      '--chart-grid-dash': '#222c2a',
      '--chart-axis': '#66736e',
      '--chart-crosshair': '#5a6662',
      '--chart-up': '#00e0a8',
      '--chart-down': '#ff6b6b',
      '--chart-volume-up': 'rgba(0, 224, 168, 0.4)',
      '--chart-volume-down': 'rgba(255, 107, 107, 0.4)',

      // ---- 阴影 ----
      '--shadow-sm': '0 1px 2px rgba(0, 0, 0, 0.3)',
      '--shadow-md': '0 4px 12px rgba(0, 0, 0, 0.4)',
      '--shadow-lg': '0 8px 24px rgba(0, 0, 0, 0.5)',
      '--shadow-glow': '0 0 20px rgba(0, 224, 168, 0.2)',
    }
  },

  // ========== 蓝色现代版 - 现代简约风格 ==========
  blue: {
    name: '蓝色现代版',
    colors: {
      // ---- 背景色 ----
      '--bg-primary': '#0d1117',
      '--bg-secondary': '#161b22',
      '--bg-tertiary': '#21262d',
      '--bg-elevated': '#2d333b',
      '--bg-card': '#1a2028',
      '--bg-input': '#21262d',
      '--bg-overlay': 'rgba(0, 0, 0, 0.6)',

      // ---- 文字色 ----
      '--text-primary': '#f0f6fc',
      '--text-secondary': '#c9d1d9',
      '--text-tertiary': '#8b949e',
      '--text-muted': '#6e7681',
      '--text-inverse': '#0d1117',

      // ---- 边框色 ----
      '--border-primary': '#30363d',
      '--border-secondary': '#21262d',
      '--border-tertiary': '#161b22',
      '--border-hover': '#3d444d',

      // ---- 品牌色 ----
      '--brand-primary': '#58a6ff',
      '--brand-secondary': '#4184e4',
      '--brand-tertiary': '#316dca',
      '--brand-bg': 'rgba(88, 166, 255, 0.12)',

      // ---- 功能色 ----
      '--success': '#3fb950',
      '--success-bg': 'rgba(63, 185, 80, 0.12)',
      '--danger': '#f85149',
      '--danger-bg': 'rgba(248, 81, 73, 0.12)',
      '--warning': '#d29922',
      '--warning-bg': 'rgba(210, 153, 34, 0.12)',
      '--info': '#58a6ff',
      '--info-bg': 'rgba(88, 166, 255, 0.12)',

      // ---- 交易色 ----
      '--long': '#3fb950',
      '--long-bg': 'rgba(63, 185, 80, 0.15)',
      '--short': '#f85149',
      '--short-bg': 'rgba(248, 81, 73, 0.15)',

      // ---- 盈亏色 ----
      '--profit': '#3fb950',
      '--profit-bg': 'rgba(63, 185, 80, 0.15)',
      '--loss': '#f85149',
      '--loss-bg': 'rgba(248, 81, 73, 0.15)',

      // ---- 按钮 ----
      '--btn-primary-bg': '#58a6ff',
      '--btn-primary-text': '#0d1117',
      '--btn-primary-hover': '#79b8ff',
      '--btn-secondary-bg': '#21262d',
      '--btn-secondary-text': '#f0f6fc',
      '--btn-secondary-hover': '#30363d',
      '--btn-ghost-bg': 'transparent',
      '--btn-ghost-text': '#f0f6fc',
      '--btn-ghost-hover': '#21262d',

      // ---- 状态色 ----
      '--state-hover': 'rgba(255, 255, 255, 0.05)',
      '--state-active': 'rgba(255, 255, 255, 0.08)',
      '--state-focus': 'rgba(88, 166, 255, 0.3)',
      '--state-selected': 'rgba(88, 166, 255, 0.1)',

      // ---- 图表色 ----
      '--chart-grid': '#2a313c',
      '--chart-grid-dash': '#21262d',
      '--chart-axis': '#6e7681',
      '--chart-crosshair': '#5a6662',
      '--chart-up': '#3fb950',
      '--chart-down': '#f85149',
      '--chart-volume-up': 'rgba(63, 185, 80, 0.4)',
      '--chart-volume-down': 'rgba(248, 81, 73, 0.4)',

      // ---- 阴影 ----
      '--shadow-sm': '0 1px 2px rgba(0, 0, 0, 0.3)',
      '--shadow-md': '0 4px 12px rgba(0, 0, 0, 0.4)',
      '--shadow-lg': '0 8px 24px rgba(0, 0, 0, 0.5)',
      '--shadow-glow': '0 0 20px rgba(88, 166, 255, 0.2)',
    }
  },

  // ========== 紫色优雅版 - 优雅高端风格 ==========
  purple: {
    name: '紫色优雅版',
    colors: {
      // ---- 背景色 ----
      '--bg-primary': '#0f0820',
      '--bg-secondary': '#18102e',
      '--bg-tertiary': '#221840',
      '--bg-elevated': '#2e2052',
      '--bg-card': '#1c1236',
      '--bg-input': '#221840',
      '--bg-overlay': 'rgba(0, 0, 0, 0.6)',

      // ---- 文字色 ----
      '--text-primary': '#f5f0ff',
      '--text-secondary': '#d8cff0',
      '--text-tertiary': '#b0a0d4',
      '--text-muted': '#8a7ab0',
      '--text-inverse': '#0f0820',

      // ---- 边框色 ----
      '--border-primary': '#3d2e5f',
      '--border-secondary': '#2d1f4a',
      '--border-tertiary': '#221840',
      '--border-hover': '#4d3d7f',

      // ---- 品牌色 ----
      '--brand-primary': '#a78bfa',
      '--brand-secondary': '#8b5cf6',
      '--brand-tertiary': '#7c3aed',
      '--brand-bg': 'rgba(167, 139, 250, 0.12)',

      // ---- 功能色 ----
      '--success': '#34d399',
      '--success-bg': 'rgba(52, 211, 153, 0.12)',
      '--danger': '#f87171',
      '--danger-bg': 'rgba(248, 113, 113, 0.12)',
      '--warning': '#fbbf24',
      '--warning-bg': 'rgba(251, 191, 36, 0.12)',
      '--info': '#a78bfa',
      '--info-bg': 'rgba(167, 139, 250, 0.12)',

      // ---- 交易色 ----
      '--long': '#34d399',
      '--long-bg': 'rgba(52, 211, 153, 0.15)',
      '--short': '#f87171',
      '--short-bg': 'rgba(248, 113, 113, 0.15)',

      // ---- 盈亏色 ----
      '--profit': '#34d399',
      '--profit-bg': 'rgba(52, 211, 153, 0.15)',
      '--loss': '#f87171',
      '--loss-bg': 'rgba(248, 113, 113, 0.15)',

      // ---- 按钮 ----
      '--btn-primary-bg': '#a78bfa',
      '--btn-primary-text': '#0f0820',
      '--btn-primary-hover': '#c4b5fd',
      '--btn-secondary-bg': '#221840',
      '--btn-secondary-text': '#f5f0ff',
      '--btn-secondary-hover': '#2e2052',
      '--btn-ghost-bg': 'transparent',
      '--btn-ghost-text': '#f5f0ff',
      '--btn-ghost-hover': '#221840',

      // ---- 状态色 ----
      '--state-hover': 'rgba(255, 255, 255, 0.04)',
      '--state-active': 'rgba(255, 255, 255, 0.07)',
      '--state-focus': 'rgba(167, 139, 250, 0.3)',
      '--state-selected': 'rgba(167, 139, 250, 0.1)',

      // ---- 图表色 ----
      '--chart-grid': '#352550',
      '--chart-grid-dash': '#2d1f4a',
      '--chart-axis': '#8a7ab0',
      '--chart-crosshair': '#7060a0',
      '--chart-up': '#34d399',
      '--chart-down': '#f87171',
      '--chart-volume-up': 'rgba(52, 211, 153, 0.4)',
      '--chart-volume-down': 'rgba(248, 113, 113, 0.4)',

      // ---- 阴影 ----
      '--shadow-sm': '0 1px 2px rgba(0, 0, 0, 0.35)',
      '--shadow-md': '0 4px 12px rgba(0, 0, 0, 0.45)',
      '--shadow-lg': '0 8px 24px rgba(0, 0, 0, 0.55)',
      '--shadow-glow': '0 0 20px rgba(167, 139, 250, 0.25)',
    }
  },

  // ========== 浅色简约版 - 清爽明亮风格 ==========
  light: {
    name: '浅色简约版',
    colors: {
      // ---- 背景色 ----
      '--bg-primary': '#ffffff',
      '--bg-secondary': '#f8f9fa',
      '--bg-tertiary': '#f1f3f5',
      '--bg-elevated': '#ffffff',
      '--bg-card': '#ffffff',
      '--bg-input': '#ffffff',
      '--bg-overlay': 'rgba(0, 0, 0, 0.4)',

      // ---- 文字色 ----
      '--text-primary': '#1a1a2e',
      '--text-secondary': '#4a4a68',
      '--text-tertiary': '#6b7280',
      '--text-muted': '#9ca3af',
      '--text-inverse': '#ffffff',

      // ---- 边框色 ----
      '--border-primary': '#e5e7eb',
      '--border-secondary': '#f1f3f5',
      '--border-tertiary': '#f8f9fa',
      '--border-hover': '#d1d5db',

      // ---- 品牌色 ----
      '--brand-primary': '#2563eb',
      '--brand-secondary': '#1d4ed8',
      '--brand-tertiary': '#1e40af',
      '--brand-bg': 'rgba(37, 99, 235, 0.08)',

      // ---- 功能色 ----
      '--success': '#059669',
      '--success-bg': 'rgba(5, 150, 105, 0.08)',
      '--danger': '#dc2626',
      '--danger-bg': 'rgba(220, 38, 38, 0.08)',
      '--warning': '#d97706',
      '--warning-bg': 'rgba(217, 119, 6, 0.08)',
      '--info': '#2563eb',
      '--info-bg': 'rgba(37, 99, 235, 0.08)',

      // ---- 交易色 ----
      '--long': '#059669',
      '--long-bg': 'rgba(5, 150, 105, 0.1)',
      '--short': '#dc2626',
      '--short-bg': 'rgba(220, 38, 38, 0.1)',

      // ---- 盈亏色 ----
      '--profit': '#059669',
      '--profit-bg': 'rgba(5, 150, 105, 0.1)',
      '--loss': '#dc2626',
      '--loss-bg': 'rgba(220, 38, 38, 0.1)',

      // ---- 按钮 ----
      '--btn-primary-bg': '#2563eb',
      '--btn-primary-text': '#ffffff',
      '--btn-primary-hover': '#1d4ed8',
      '--btn-secondary-bg': '#6b7280',
      '--btn-secondary-text': '#ffffff',
      '--btn-secondary-hover': '#4b5563',
      '--btn-ghost-bg': 'transparent',
      '--btn-ghost-text': '#1a1a2e',
      '--btn-ghost-hover': '#f1f3f5',

      // ---- 状态色 ----
      '--state-hover': 'rgba(0, 0, 0, 0.04)',
      '--state-active': 'rgba(0, 0, 0, 0.06)',
      '--state-focus': 'rgba(37, 99, 235, 0.25)',
      '--state-selected': 'rgba(37, 99, 235, 0.08)',

      // ---- 图表色 ----
      '--chart-grid': '#e5e7eb',
      '--chart-grid-dash': '#f1f3f5',
      '--chart-axis': '#6b7280',
      '--chart-crosshair': '#9ca3af',
      '--chart-up': '#059669',
      '--chart-down': '#dc2626',
      '--chart-volume-up': 'rgba(5, 150, 105, 0.35)',
      '--chart-volume-down': 'rgba(220, 38, 38, 0.35)',

      // ---- 阴影 ----
      '--shadow-sm': '0 1px 2px rgba(0, 0, 0, 0.06)',
      '--shadow-md': '0 4px 12px rgba(0, 0, 0, 0.08)',
      '--shadow-lg': '0 8px 24px rgba(0, 0, 0, 0.1)',
      '--shadow-glow': '0 0 20px rgba(37, 99, 235, 0.15)',
    }
  },

  // ========== 绿色经典版 - 原版配色优化 ==========
  green: {
    name: '绿色经典版',
    colors: {
      // ---- 背景色 ----
      '--bg-primary': '#f4f7f5',
      '--bg-secondary': '#ffffff',
      '--bg-tertiary': '#eef5f0',
      '--bg-elevated': '#ffffff',
      '--bg-card': '#ffffff',
      '--bg-input': '#ffffff',
      '--bg-overlay': 'rgba(0, 0, 0, 0.4)',

      // ---- 文字色 ----
      '--text-primary': '#0f1c14',
      '--text-secondary': '#2d4438',
      '--text-tertiary': '#556b5e',
      '--text-muted': '#7a8c82',
      '--text-inverse': '#ffffff',

      // ---- 边框色 ----
      '--border-primary': '#d0ddd4',
      '--border-secondary': '#e7eee9',
      '--border-tertiary': '#f0f5f2',
      '--border-hover': '#a8d0b5',

      // ---- 品牌色 ----
      '--brand-primary': '#168558',
      '--brand-secondary': '#19a267',
      '--brand-tertiary': '#08753d',
      '--brand-bg': 'rgba(22, 133, 88, 0.08)',

      // ---- 功能色 ----
      '--success': '#168558',
      '--success-bg': 'rgba(22, 133, 88, 0.08)',
      '--danger': '#ba3b2d',
      '--danger-bg': 'rgba(186, 59, 45, 0.08)',
      '--warning': '#d97706',
      '--warning-bg': 'rgba(217, 119, 6, 0.08)',
      '--info': '#2563eb',
      '--info-bg': 'rgba(37, 99, 235, 0.08)',

      // ---- 交易色 ----
      '--long': '#08753d',
      '--long-bg': 'rgba(8, 117, 61, 0.1)',
      '--short': '#ba3b2d',
      '--short-bg': 'rgba(186, 59, 45, 0.1)',

      // ---- 盈亏色 ----
      '--profit': '#08753d',
      '--profit-bg': 'rgba(8, 117, 61, 0.1)',
      '--loss': '#ba3b2d',
      '--loss-bg': 'rgba(186, 59, 45, 0.1)',

      // ---- 按钮 ----
      '--btn-primary-bg': '#168558',
      '--btn-primary-text': '#ffffff',
      '--btn-primary-hover': '#19a267',
      '--btn-secondary-bg': '#245e42',
      '--btn-secondary-text': '#ffffff',
      '--btn-secondary-hover': '#1e4e37',
      '--btn-ghost-bg': 'transparent',
      '--btn-ghost-text': '#0f1c14',
      '--btn-ghost-hover': '#eef5f0',

      // ---- 状态色 ----
      '--state-hover': 'rgba(22, 133, 88, 0.04)',
      '--state-active': 'rgba(22, 133, 88, 0.06)',
      '--state-focus': 'rgba(22, 133, 88, 0.25)',
      '--state-selected': 'rgba(22, 133, 88, 0.08)',

      // ---- 图表色 ----
      '--chart-grid': '#d0ddd4',
      '--chart-grid-dash': '#e7eee9',
      '--chart-axis': '#556b5e',
      '--chart-crosshair': '#7a8c82',
      '--chart-up': '#08753d',
      '--chart-down': '#ba3b2d',
      '--chart-volume-up': 'rgba(8, 117, 61, 0.35)',
      '--chart-volume-down': 'rgba(186, 59, 45, 0.35)',

      // ---- 阴影 ----
      '--shadow-sm': '0 1px 2px rgba(15, 28, 20, 0.05)',
      '--shadow-md': '0 4px 12px rgba(15, 28, 20, 0.07)',
      '--shadow-lg': '0 8px 24px rgba(15, 28, 20, 0.09)',
      '--shadow-glow': '0 0 20px rgba(22, 133, 88, 0.15)',
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
