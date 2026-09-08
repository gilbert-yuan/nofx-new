<script setup>
defineProps({ okx: Object, trader: Object, loading: Boolean, testing: Boolean, status: Object });
defineEmits(['save', 'test', 'review']);
</script>

<template>
  <section class="ai-settings okx-settings">
    <div class="view-heading">
      <div>
        <span class="eyebrow">OKX AUTOMATION</span>
        <h2>欧意自动交易</h2>
        <p>每次 15 分钟 K 线同步完成后，系统会复核持仓，并按设置提出或执行止盈、止损调整、平仓和新开仓。</p>
      </div>
      <label class="toggle"><input v-model="trader.enabled" type="checkbox" />启用自动执行</label>
    </div>
    <div class="model-grid">
      <label>API Key<input v-model="okx.apiKey" type="password" autocomplete="off" placeholder="留空保持原值" /></label>
      <label>Secret Key<input v-model="okx.secretKey" type="password" autocomplete="off" placeholder="留空保持原值" /></label>
      <label>Passphrase<input v-model="okx.passphrase" type="password" autocomplete="off" placeholder="留空保持原值" /></label>
      <label>保证金模式<select v-model="okx.tdMode"><option value="isolated">逐仓</option><option value="cross">全仓</option></select></label>
      <label class="toggle"><input v-model="okx.demo" type="checkbox" />欧意模拟盘</label>
      <label class="toggle"><input v-model="trader.dryRun" type="checkbox" />仅模拟指令（不发单）</label>
      <label class="toggle"><input v-model="trader.allowProtectionUpdates" type="checkbox" />允许调整止盈止损</label>
      <label class="toggle"><input v-model="trader.allowCloseOrders" type="checkbox" />允许自动平仓</label>
      <label class="toggle"><input v-model="trader.allowEntryOrders" type="checkbox" />允许自动开仓</label>
      <label>开仓候选币种<input v-model="trader.entrySymbolsText" placeholder="BTCUSDT,ETHUSDT" /></label>
      <label>每轮最多新开仓<input v-model.number="trader.maxNewEntriesPerCycle" type="number" min="1" max="5" /></label>
      <label>最低置信度<input v-model.number="trader.minConfidence" type="number" min="0" max="1" step="0.05" /></label>
      <label>最大杠杆<input v-model.number="trader.maxLeverage" type="number" min="1" max="20" /></label>
      <label>单仓最大权益占比<input v-model.number="trader.maxPositionNotionalPct" type="number" min="0.01" max="1" step="0.01" /></label>
      <label>总仓最大权益占比<input v-model.number="trader.maxTotalNotionalPct" type="number" min="0.01" max="1" step="0.01" /></label>
    </div>
    <p class="muted">实盘发单需要同时关闭“欧意模拟盘”和“仅模拟指令”，并开启对应的开仓、平仓或止盈止损权限。手动创建的欧意条件单不会被本系统修改。</p>
    <p v-if="status?.lastResult" class="muted">上次复核：{{ status.lastRunAt ? new Date(status.lastRunAt).toLocaleString() : '尚未执行' }} · {{ status.lastResult.status }} · 已检查 {{ status.lastResult.reviewed || 0 }} 个持仓</p>
    <div class="button-row">
      <button class="secondary" @click="$emit('save')" :disabled="loading">保存欧意配置</button>
      <button class="ghost" @click="$emit('test')" :disabled="loading || testing">{{ testing ? '连接中…' : '测试只读连接' }}</button>
      <button class="ghost" @click="$emit('review')" :disabled="loading">立即复核持仓</button>
    </div>
  </section>
</template>
