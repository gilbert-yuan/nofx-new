<script setup>
defineProps({ symbols: { type: Array, default: () => [] }, activeSymbol: String, search: String, loading: Boolean });
defineEmits(['update:search', 'select', 'refresh']);
function marketCap(value) { const amount = Number(value || 0); if (amount >= 1e12) return `${(amount / 1e12).toFixed(1)}T`; if (amount >= 1e9) return `${(amount / 1e9).toFixed(1)}B`; if (amount >= 1e6) return `${(amount / 1e6).toFixed(1)}M`; return amount.toLocaleString(); }
</script>
<template>
  <aside class="symbol-panel">
    <div class="panel-title"><div><span class="eyebrow">MARKETS</span><h2>永续合约</h2></div><strong>{{ symbols.length }}</strong></div>
    <div class="search-box"><span aria-hidden="true">⌕</span><input :value="search" @input="$emit('update:search', $event.target.value)" placeholder="搜索币种，例如 BTC" aria-label="搜索币种" :aria-busy="loading" /><button v-if="search" class="clear-search" aria-label="清空搜索" @click="$emit('update:search', '')">×</button><span v-if="loading" class="spinner spinner-small" aria-label="正在搜索"></span></div>
    <button class="symbol-refresh" @click="$emit('refresh')" :disabled="loading">{{ loading ? '正在刷新…' : '刷新币种列表' }}</button>
    <div class="symbol-list"><p v-if="loading" class="inline-loading"><span class="spinner"></span>正在加载币种…</p><button v-for="item in symbols" :key="item.symbol" class="symbol-row" :class="{ selected: activeSymbol === item.symbol }" @click="$emit('select', item.symbol)"><span>{{ item.baseCoin }}</span><small>{{ item.symbol }} · 永续</small><b>›</b></button><p v-if="!loading && !symbols.length" class="empty">没有匹配币种，可调整搜索或刷新列表。</p></div>
  </aside>
</template>
