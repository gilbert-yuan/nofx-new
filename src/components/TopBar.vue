<script setup>
defineProps({ activeView: { type: String, required: true }, mode: String });
defineEmits(['change-view']);
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
      <button :class="{ active: activeView === 'history' }" @click="$emit('change-view', 'history')">历史分析</button>
      <button :class="{ active: activeView === 'settings' }" @click="$emit('change-view', 'settings')">模型设置</button>
    </nav>
    <div class="top-status"><span class="dot"></span>{{ mode }}</div>
  </header>
</template>
