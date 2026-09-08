<script setup>
import { ref, computed, watch } from 'vue';

const props = defineProps({ date: String, records: Array, loading: Boolean });
const emit = defineEmits(['update:date', 'refresh', 'open']);

// 分页相关
const currentPage = ref(1);
const pageSize = ref(20);

// 分页后的记录
const paginatedRecords = computed(() => {
  if (!props.records) return [];
  const start = (currentPage.value - 1) * pageSize.value;
  const end = start + pageSize.value;
  return props.records.slice(start, end);
});

// 总页数
const totalPages = computed(() => {
  if (!props.records) return 1;
  return Math.max(1, Math.ceil(props.records.length / pageSize.value));
});

// 分页控制
function goToPage(page) {
  if (page >= 1 && page <= totalPages.value) {
    currentPage.value = page;
  }
}

// 日期变化时重置页码
watch(() => props.date, () => {
  currentPage.value = 1;
});

// 记录变化时重置页码
watch(() => props.records, () => {
  currentPage.value = 1;
});
</script>

<template>
  <section class="history-page">
    <div class="history-hero">
      <div>
        <span class="eyebrow">ANALYSIS HISTORY</span>
        <h2>历史分析记录</h2>
        <p>按日期查看单币、范围和全量分析，点击记录查看详情。</p>
      </div>
      <div class="history-filter">
        <label>
          分析日期
          <input
            :value="date"
            type="date"
            :disabled="loading"
            @change="$emit('update:date', $event.target.value)"
          />
        </label>
        <button class="primary" @click="$emit('refresh')" :disabled="loading">
          {{ loading ? '查询中…' : '查询记录' }}
        </button>
      </div>
    </div>

    <div class="history-table">
      <div class="history-table-head">
        <span>分析任务</span>
        <span>范围</span>
        <span>周期与时间</span>
        <span>结果</span>
        <span></span>
      </div>

      <p v-if="loading" class="inline-loading" role="status">
        <span class="spinner"></span>正在加载历史分析…
      </p>

      <template v-else>
        <button
          v-for="item in paginatedRecords"
          :key="item.id"
          class="history-table-row"
          @click="$emit('open', item)"
        >
          <span class="history-task">
            <b>{{ item.type === 'all' ? '全部币种分析' : item.type === 'range' ? '范围分析' : item.symbol + ' 单币分析' }}</b>
            <small>{{ item.type === 'all' ? '全量扫描' : item.type === 'range' ? '自定义范围' : '指定币种' }}</small>
          </span>
          <span class="history-scope">
            <b>{{ item.marketCount || 1 }}</b>
            <small>个币种</small>
          </span>
          <span class="history-time">
            <b>{{ item.interval }}</b>
            <small>{{ new Date(item.at).toLocaleString() }}</small>
          </span>
          <span class="history-results">
            <b>{{ item.analyses?.length || 0 }}</b>
            <small>条结果</small>
          </span>
          <i>查看详情 ›</i>
        </button>

        <p v-if="!records.length" class="empty">{{ date }} 暂无分析记录</p>

        <!-- 分页控件 -->
        <div class="pagination" v-if="records && records.length > 0 && totalPages > 1">
          <button
            class="btn-small"
            :disabled="currentPage === 1"
            @click="goToPage(1)"
          >
            首页
          </button>
          <button
            class="btn-small"
            :disabled="currentPage === 1"
            @click="goToPage(currentPage - 1)"
          >
            上一页
          </button>

          <span class="page-info">
            第 {{ currentPage }} / {{ totalPages }} 页，共 {{ records.length }} 条
          </span>

          <button
            class="btn-small"
            :disabled="currentPage === totalPages"
            @click="goToPage(currentPage + 1)"
          >
            下一页
          </button>
          <button
            class="btn-small"
            :disabled="currentPage === totalPages"
            @click="goToPage(totalPages)"
          >
            末页
          </button>

          <label style="margin-left: 16px;">
            每页
            <select v-model.number="pageSize" @change="currentPage = 1">
              <option :value="20">20</option>
              <option :value="50">50</option>
              <option :value="100">100</option>
            </select>
            条
          </label>
        </div>
      </template>
    </div>
  </section>
</template>

<style scoped>
.pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin-top: 24px;
  padding: 16px;
  background: var(--bg-card);
  border-radius: 8px;
}

.btn-small {
  padding: 6px 12px;
  font-size: 13px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-primary);
  color: var(--text-primary);
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-small:hover:not(:disabled) {
  background: var(--bg-card);
  border-color: var(--border-secondary);
}

.btn-small:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.page-info {
  color: var(--text-tertiary);
  font-size: 13px;
  margin: 0 8px;
}

.pagination label {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-tertiary);
  font-size: 13px;
}

.pagination select {
  background: var(--bg-elevated);
  border: 1px solid var(--border-primary);
  color: var(--text-primary);
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 13px;
}
</style>
