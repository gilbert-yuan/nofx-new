<script setup>
import { ref, onMounted } from 'vue';
import { themes, applyTheme, getCurrentTheme } from '../themes.js';

defineProps({ activeView: { type: String, required: true }, mode: String });
defineEmits(['change-view']);

const currentTheme = ref('dark');
const showThemeMenu = ref(false);

onMounted(() => {
  currentTheme.value = getCurrentTheme();

  // 点击外部关闭菜单
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.theme-switcher')) {
      showThemeMenu.value = false;
    }
  });
});

function switchTheme(themeName) {
  applyTheme(themeName);
  currentTheme.value = themeName;
  showThemeMenu.value = false;
}

function toggleThemeMenu() {
  showThemeMenu.value = !showThemeMenu.value;
}
</script>

<template>
  <header class="topbar">
    <div class="brand-lockup">
      <span class="brand-mark">N</span>
      <div><span class="eyebrow">NOFX / BINANCE</span><h1>合约工作台</h1></div>
    </div>
    <nav class="top-nav">
      <button :class="{ active: activeView === 'workbench' }" @click="$emit('change-view', 'workbench')">行情工作台</button>
      <button :class="{ active: activeView === 'trading' }" @click="$emit('change-view', 'trading')">币安交易</button>
      <button :class="{ active: activeView === 'trading-simulation' }" @click="$emit('change-view', 'trading-simulation')">交易模拟</button>
      <button :class="{ active: activeView === 'daily-trend' }" @click="$emit('change-view', 'daily-trend')">每日趋势</button>
      <button :class="{ active: activeView === 'history' }" @click="$emit('change-view', 'history')">历史分析</button>
      <button :class="{ active: activeView === 'settings' }" @click="$emit('change-view', 'settings')">模型设置</button>
    </nav>
    <div class="theme-switcher">
      <button class="theme-toggle" @click="toggleThemeMenu">
        {{ themes[currentTheme]?.name || '主题' }}
      </button>
      <div v-if="showThemeMenu" class="theme-menu">
        <button
          v-for="(theme, key) in themes"
          :key="key"
          :class="{ active: currentTheme === key }"
          @click="switchTheme(key)"
        >
          {{ theme.name }}
        </button>
      </div>
    </div>
    <div class="top-status"><span class="dot"></span>{{ mode }}</div>
  </header>
</template>
