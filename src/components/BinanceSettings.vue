<script setup>
defineProps({ binance: Object, trader: Object, loading: Boolean, status: Object, savedMode: String });
defineEmits(['save', 'test', 'review']);
const stateName = value => ({ ok: '已完成', disabled: '未启用', blocked: '待配置', error: '失败', attention: '需要检查', skipped: '已跳过', dry_run: '模拟指令', sent: '已提交', held: '保持', rejected: '已拦截', proposed: '建议', uncertain: '需核对成交' }[value] || value || '尚未运行');
</script>
<template>
  <div class="trading-layout">
    <section class="ai-settings">
      <div class="view-heading"><div><span class="eyebrow">BINANCE · USDⓈ-M</span><h2>币安交易配置</h2><p>配置账户连接、执行范围和仓位上限。</p></div><span class="mode-pill">{{ savedMode }}</span></div>
      <fieldset class="settings-group"><legend>账户连接</legend>
        <div class="model-grid account-grid">
          <label>API Key<input v-model="binance.apiKey" type="password" autocomplete="off" placeholder="输入币安 API Key" /></label>
          <label>Secret Key<input v-model="binance.secretKey" type="password" autocomplete="off" placeholder="输入币安 Secret Key" /></label>
          <label>交易环境<select v-model="binance.testnet"><option :value="true">币安合约测试网</option><option :value="false">币安合约实盘</option></select></label>
        </div>
        <p class="muted">仅需 API Key 和 Secret Key，支持单向持仓。公开行情始终独立获取；测试网持仓使用测试网行情复核。</p>
      </fieldset>
      <fieldset class="settings-group"><legend>自动执行</legend>
        <div class="permission-grid">
          <label><input v-model="trader.enabled" type="checkbox" /><span><b>启用定时复核</b><small>15 分钟行情同步后检查持仓</small></span></label>
          <label><input v-model="trader.dryRun" type="checkbox" /><span><b>仅生成模拟指令</b><small>记录建议，不提交订单</small></span></label>
          <label><input v-model="trader.allowEntryOrders" type="checkbox" /><span><b>自动开仓</b><small>只分析下方指定的候选币种</small></span></label>
          <label><input v-model="trader.allowProtectionUpdates" type="checkbox" /><span><b>止盈止损管理</b><small>复核并更新本系统的保护单</small></span></label>
          <label><input v-model="trader.allowCloseOrders" type="checkbox" /><span><b>自动平仓</b><small>策略退出时提交只减仓订单</small></span></label>
        </div>
      </fieldset>
      <fieldset class="settings-group"><legend>开仓与风控</legend>
        <label class="wide-label">开仓候选币种<input v-model="trader.entrySymbolsText" placeholder="BTCUSDT,ETHUSDT" /></label>
        <div class="model-grid">
          <label>每轮最多开仓<input v-model.number="trader.maxNewEntriesPerCycle" type="number" min="1" max="5" /></label>
          <label>最大杠杆<input v-model.number="trader.maxLeverage" type="number" min="1" max="20" /></label>
          <label>最低模型置信度<input v-model.number="trader.minConfidence" type="number" min="0" max="1" step="0.05" /></label>
          <label>单仓名义价值 / 权益<input v-model.number="trader.maxPositionNotionalPct" type="number" min="0.01" max="1" step="0.01" /></label>
          <label>总仓名义价值 / 权益<input v-model.number="trader.maxTotalNotionalPct" type="number" min="0.01" max="1" step="0.01" /></label>
          <label>保护价最小调整幅度（基点）<input v-model.number="trader.minProtectionMoveBps" type="number" min="0" step="5" /></label>
        </div>
        <p class="muted">比例 0.2 表示账户权益的 20%；置信度是模型自评，不代表实际胜率。实盘发单需要关闭“仅生成模拟指令”。</p>
      </fieldset>
      <div class="button-row"><button class="primary" @click="$emit('save')" :disabled="loading">保存币安配置</button><button class="ghost" @click="$emit('test')" :disabled="loading">测试已保存的连接</button></div>
    </section>
    <aside class="execution-panel">
      <span class="eyebrow">POSITION REVIEW</span><h2>持仓复核</h2>
      <div class="execution-status"><span class="mode-pill">{{ status?.running ? '复核中' : stateName(status?.lastResult?.status) }}</span><p>{{ status?.lastRunAt ? new Date(status.lastRunAt).toLocaleString() : '启用后随 15 分钟同步运行' }}</p></div>
      <p class="muted" v-if="status?.lastResult?.reason || status?.lastError">{{ status.lastResult?.reason || status.lastError }}</p>
      <button class="secondary" @click="$emit('review')" :disabled="loading || status?.running">按已保存配置立即复核</button>
      <div class="execution-history"><h3>最近执行记录</h3><p v-if="!status?.decisions?.length" class="empty">暂无记录。复核结果、拦截原因和执行状态会显示在这里。</p>
        <article v-for="record in status?.decisions || []" :key="record.id"><time>{{ new Date(record.at).toLocaleString() }}</time><b>{{ stateName(record.execution.status) }}</b><div v-for="item in [...(record.execution.reviews || []), ...(record.execution.entries || [])]" :key="item.symbol"><strong>{{ item.symbol }}</strong> · {{ stateName(item.action.status) }}<p>{{ item.action.reason || item.review?.reason || item.decision?.reason }}</p></div></article>
      </div>
    </aside>
  </div>
</template>
