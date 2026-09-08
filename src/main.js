import { createApp } from 'vue';
import App from './App.vue';
import './style.css';
import './workspace.css';
import { initTheme } from './themes.js';

// 初始化主题
initTheme();

createApp(App).mount('#app');
