<script setup>
defineProps({ symbols: Object, sync: Object, loading: Boolean, error: String });
defineEmits(['refresh-symbols', 'sync', 'toggle-sync']);
const time = value => value ? new Date(value).toLocaleTimeString() : '尚未更新';
</script>
<template>
  <section class="market-status" aria-label="行情获取状态">
    <div><span class="eyebrow">{{ (symbols?.provider || 'okx').toUpperCase() }} 币种列表</span><strong>{{ symbols?.count || 0 }} <small>个合约</small></strong><p>{{ symbols?.lastError ? '刷新失败' : time(symbols?.updatedAt) }}</p><button class="ghost" @click="$emit('refresh-symbols')" :disabled="loading || symbols?.busy">单独刷新币种</button></div>
    <div><span class="eyebrow">K 线 · {{ sync?.interval || '1m' }}</span><strong>{{ sync?.busy ? '同步中' : sync?.lastError ? '部分失败' : sync?.lastRunAt ? '已更新' : '等待同步' }}</strong><p>{{ sync?.busy ? `${sync.progress?.completed || 0} / ${sync.progress?.total || 0} 个合约` : time(sync?.lastRunAt) }}</p><button class="ghost" @click="$emit('sync')" :disabled="loading || sync?.busy">拉取 {{ sync?.interval || '1m' }} K 线</button></div>
    <div><span class="eyebrow">定时任务</span><strong>{{ sync?.running ? `每 ${sync?.intervalSeconds || 60} 秒` : '已暂停' }}</strong><p>下次运行 {{ time(sync?.nextRunAt) }}</p><button class="ghost" @click="$emit('toggle-sync')" :disabled="loading">{{ sync?.running ? '暂停定时同步' : '开启定时同步' }}</button></div>
    <p v-if="error || symbols?.lastError || sync?.lastError" class="status-error" role="alert">{{ error || symbols?.lastError || sync?.lastError }}</p>
  </section>
</template>
