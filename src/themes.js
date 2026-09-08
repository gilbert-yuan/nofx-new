/**
 * 主题系统
 * 预制多种经典配色方案
 */

export const themes = {
  // 深色专业版 - 经典交易终端风格
  dark: {
    name: '深色专业版',
    colors: {
      // 基础色
      '--bg-primary': '#0a0e0d',
      '--bg-secondary': '#151a19',
      '--bg-tertiary': '#1e2423',
      '--bg-elevated': '#252b2a',

      // 文本色
      '--text-primary': '#e8eef0',
      '--text-secondary': '#a8b5b9',
      '--text-tertiary': '#6b7b7f',
      '--text-muted': '#4a5558',

      // 边框色
      '--border-primary': '#2a3332',
      '--border-secondary': '#1e2423',
      '--border-hover': '#3a4544',

      // 品牌色
      '--brand-primary': '#00d9a3',
      '--brand-secondary': '#00b88a',
      '--brand-tertiary': '#009871',

      // 功能色
      '--success': '#00d9a3',
      '--danger': '#ff5c5c',
      '--warning': '#ffb800',
      '--info': '#4da6ff',

      // 交易色
      '--long': '#00d9a3',
      '--long-bg': '#00d9a320',
      '--short': '#ff5c5c',
      '--short-bg': '#ff5c5c20',

      // 按钮
      '--btn-primary-bg': '#00d9a3',
      '--btn-primary-text': '#0a0e0d',
      '--btn-secondary-bg': '#252b2a',
      '--btn-secondary-text': '#e8eef0',
    }
  },

  // 蓝色现代版 - 现代简约风格
  blue: {
    name: '蓝色现代版',
    colors: {
      '--bg-primary': '#0d1117',
      '--bg-secondary': '#161b22',
      '--bg-tertiary': '#21262d',
      '--bg-elevated': '#2d333b',

      '--text-primary': '#e6edf3',
      '--text-secondary': '#8b949e',
      '--text-tertiary': '#6e7681',
      '--text-muted': '#484f58',

      '--border-primary': '#30363d',
      '--border-secondary': '#21262d',
      '--border-hover': '#3d444d',

      '--brand-primary': '#58a6ff',
      '--brand-secondary': '#4184e4',
      '--brand-tertiary': '#316dca',

      '--success': '#3fb950',
      '--danger': '#f85149',
      '--warning': '#d29922',
      '--info': '#58a6ff',

      '--long': '#3fb950',
      '--long-bg': '#3fb95020',
      '--short': '#f85149',
      '--short-bg': '#f8514920',

      '--btn-primary-bg': '#58a6ff',
      '--btn-primary-text': '#0d1117',
      '--btn-secondary-bg': '#21262d',
      '--btn-secondary-text': '#e6edf3',
    }
  },

  // 紫色优雅版 - 优雅高端风格
  purple: {
    name: '紫色优雅版',
    colors: {
      '--bg-primary': '#0f0718',
      '--bg-secondary': '#1a0f2e',
      '--bg-tertiary': '#261940',
      '--bg-elevated': '#33235a',

      '--text-primary': '#f0e6ff',
      '--text-secondary': '#c8b3e6',
      '--text-tertiary': '#9d82c4',
      '--text-muted': '#6d5a8f',

      '--border-primary': '#3d2d5f',
      '--border-secondary': '#2d1f4a',
      '--border-hover': '#4d3d7f',

      '--brand-primary': '#a78bfa',
      '--brand-secondary': '#8b5cf6',
      '--brand-tertiary': '#7c3aed',

      '--success': '#10b981',
      '--danger': '#ef4444',
      '--warning': '#f59e0b',
      '--info': '#8b5cf6',

      '--long': '#10b981',
      '--long-bg': '#10b98120',
      '--short': '#ef4444',
      '--short-bg': '#ef444420',

      '--btn-primary-bg': '#a78bfa',
      '--btn-primary-text': '#0f0718',
      '--btn-secondary-bg': '#261940',
      '--btn-secondary-text': '#f0e6ff',
    }
  },

  // 浅色简约版 - 清爽明亮风格
  light: {
    name: '浅色简约版',
    colors: {
      '--bg-primary': '#ffffff',
      '--bg-secondary': '#f8f9fa',
      '--bg-tertiary': '#e9ecef',
      '--bg-elevated': '#ffffff',

      '--text-primary': '#212529',
      '--text-secondary': '#495057',
      '--text-tertiary': '#6c757d',
      '--text-muted': '#adb5bd',

      '--border-primary': '#dee2e6',
      '--border-secondary': '#e9ecef',
      '--border-hover': '#ced4da',

      '--brand-primary': '#0d6efd',
      '--brand-secondary': '#0a58ca',
      '--brand-tertiary': '#084298',

      '--success': '#198754',
      '--danger': '#dc3545',
      '--warning': '#ffc107',
      '--info': '#0dcaf0',

      '--long': '#198754',
      '--long-bg': '#d1e7dd',
      '--short': '#dc3545',
      '--short-bg': '#f8d7da',

      '--btn-primary-bg': '#0d6efd',
      '--btn-primary-text': '#ffffff',
      '--btn-secondary-bg': '#6c757d',
      '--btn-secondary-text': '#ffffff',
    }
  },

  // 绿色经典版 - 原版配色优化
  green: {
    name: '绿色经典版',
    colors: {
      '--bg-primary': '#f4f7f5',
      '--bg-secondary': '#ffffff',
      '--bg-tertiary': '#eef5f0',
      '--bg-elevated': '#ffffff',

      '--text-primary': '#15281f',
      '--text-secondary': '#40584b',
      '--text-tertiary': '#61776a',
      '--text-muted': '#91a398',

      '--border-primary': '#dce5df',
      '--border-secondary': '#e7eee9',
      '--border-hover': '#a8d0b5',

      '--brand-primary': '#168558',
      '--brand-secondary': '#19a267',
      '--brand-tertiary': '#08753d',

      '--success': '#168558',
      '--danger': '#ba3b2d',
      '--warning': '#806b2a',
      '--info': '#2b5fa5',

      '--long': '#08753d',
      '--long-bg': '#e2f6e9',
      '--short': '#ba3b2d',
      '--short-bg': '#fff0ed',

      '--btn-primary-bg': '#168558',
      '--btn-primary-text': '#ffffff',
      '--btn-secondary-bg': '#245e42',
      '--btn-secondary-text': '#ffffff',
    }
  },
};

export function applyTheme(themeName) {
  const theme = themes[themeName];
  if (!theme) return;

  const root = document.documentElement;
  Object.entries(theme.colors).forEach(([key, value]) => {
    root.style.setProperty(key, value);
  });

  // 保存到本地存储
  localStorage.setItem('nofx-theme', themeName);
}

export function getCurrentTheme() {
  return localStorage.getItem('nofx-theme') || 'dark';
}

export function initTheme() {
  const savedTheme = getCurrentTheme();
  applyTheme(savedTheme);
}
