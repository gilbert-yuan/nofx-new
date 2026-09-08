<script setup>
import { ref, computed, watch } from 'vue';

const props = defineProps({
  symbols: { type: Array, default: () => [] },
  activeSymbol: String,
  search: String,
  loading: Boolean
});

const emit = defineEmits(['update:search', 'select', 'refresh']);

// 分页相关
const currentPage = ref(1);
const pageSize = ref(20);

// 分页后的币种
const paginatedSymbols = computed(() => {
  if (!props.symbols) return [];
  const start = (currentPage.value - 1) * pageSize.value;
  const end = start + pageSize.value;
  return props.symbols.slice(start, end);
});

// 总页数
const totalPages = computed(() => {
  if (!props.symbols) return 1;
  return Math.max(1, Math.ceil(props.symbols.length / pageSize.value));
});

// 分页控制
function goToPage(page) {
  if (page >= 1 && page <= totalPages.value) {
    currentPage.value = page;
  }
}

// 搜索或币种列表变化时重置页码
watch(() => props.search, () => {
  currentPage.value = 1;
});

watch(() => props.symbols?.length, () => {
  currentPage.value = 1;
});

function marketCap(value) {
  const amount = Number(value || 0);
  if (amount >= 1e12) return `${(amount / 1e12).toFixed(1)}T`;
  if (amount >= 1e9) return `${(amount / 1e9).toFixed(1)}B`;
  if (amount >= 1e6) return `${(amount / 1e6).toFixed(1)}M`;
  return amount.toLocaleString();
}
</script>

<template>
  <aside class="symbol-panel">
    <div class="panel-title">
      <div>
        <span class="eyebrow">MARKETS</span>
        <h2>永续合约</h2>
      </div>
      <strong>{{ symbols.length }}</strong>
    </div>

    <div class="search-box">
      <span aria-hidden="true">⌕</span>
      <input
        :value="search"
        @input="$emit('update:search', $event.target.value)"
        placeholder="搜索币种，例如 BTC"
        aria-label="搜索币种"
        :aria-busy="loading"
      />
      <button
        v-if="search"
        class="clear-search"
        aria-label="清空搜索"
        @click="$emit('update:search', '')"
      >
        ×
      </button>
      <span v-if="loading" class="spinner spinner-small" aria-label="正在搜索"></span>
    </div>

    <button class="symbol-refresh" @click="$emit('refresh')" :disabled="loading">
      {{ loading ? '正在刷新…' : '刷新币种列表' }}
    </button>

    <div class="symbol-list">
      <p v-if="loading" class="inline-loading">
        <span class="spinner"></span>正在加载币种…
      </p>

      <template v-else>
        <button
          v-for="item in paginatedSymbols"
          :key="item.symbol"
          class="symbol-row"
          :class="{ selected: activeSymbol === item.symbol }"
          @click="$emit('select', item.symbol)"
        >
          <span>{{ item.baseCoin }}</span>
          <small>{{ item.symbol }} · 永续</small>
          <b>›</b>
        </button>

        <p v-if="!loading && !symbols.length" class="empty">
          没有匹配币种，可调整搜索或刷新列表。
        </p>

        <!-- 分页控件 -->
        <div class="symbol-pagination" v-if="symbols.length > 0 && totalPages > 1">
          <div class="pagination-info">
            第 {{ currentPage }} / {{ totalPages }} 页
          </div>
          <div class="pagination-controls">
            <button
              class="page-btn"
              :disabled="currentPage === 1"
              @click="goToPage(1)"
              title="首页"
            >
              ««
            </button>
            <button
              class="page-btn"
              :disabled="currentPage === 1"
              @click="goToPage(currentPage - 1)"
              title="上一页"
            >
              ‹
            </button>
            <button
              class="page-btn"
              :disabled="currentPage === totalPages"
              @click="goToPage(currentPage + 1)"
              title="下一页"
            >
              ›
            </button>
            <button
              class="page-btn"
              :disabled="currentPage === totalPages"
              @click="goToPage(totalPages)"
              title="末页"
            >
              »»
            </button>
          </div>
          <div class="pagination-size">
            <select v-model.number="pageSize" @change="currentPage = 1">
              <option :value="20">20条/页</option>
              <option :value="50">50条/页</option>
              <option :value="100">100条/页</option>
            </select>
          </div>
        </div>
      </template>
    </div>
  </aside>
</template>

<style scoped>
.symbol-pagination {
  padding: 12px 16px;
  background: var(--bg-card);
  border-top: 1px solid var(--border-secondary);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.pagination-info {
  text-align: center;
  color: var(--text-tertiary);
  font-size: 12px;
}

.pagination-controls {
  display: flex;
  justify-content: center;
  gap: 4px;
}

.page-btn {
  padding: 4px 12px;
  font-size: 13px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-primary);
  color: var(--text-primary);
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.2s;
}

.page-btn:hover:not(:disabled) {
  background: var(--btn-secondary-hover);
  border-color: var(--border-hover);
}

.page-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.pagination-size {
  display: flex;
  justify-content: center;
}

.pagination-size select {
  background: var(--bg-card);
  border: 1px solid var(--border-secondary);
  color: var(--text-primary);
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
}

.pagination-size select:hover {
  border-color: var(--border-primary);
}
</style>
