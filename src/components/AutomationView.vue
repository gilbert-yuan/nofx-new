<script setup>
/**
 * AutomationView · 自动化任务
 *
 * 从「交易模拟」内嵌面板独立出来的菜单页。
 * 状态与控制逻辑全部复用 AutomationTasks 组件（数据源 /api/automation/*）：
 *   - GET  /api/automation/status                 读取两项任务状态
 *   - POST /api/automation/start | stop           整体启停
 *   - PUT  /api/automation/tasks/:name            暂停 / 启用（body: { enabled })
 *   - POST /api/automation/tasks/:name/trigger    手动执行一轮
 *
 * 后台两项任务：
 *   klineSync      → 全市场逐币种「拉 K 线 → 落库 → 立即分析 → 合格即挂单」
 *   positionReview → 仅活跃挂单/持仓币种，撮合、推进盈亏、复核
 */
import AutomationTasks from './AutomationTasks.vue';
</script>

<template>
  <section class="history-panel automation-view">
    <div class="view-heading">
      <div>
        <span class="eyebrow">AUTOMATION</span>
        <h2>自动化任务</h2>
        <p>后台两项自动任务：全市场逐币种拉 K 线 → 立即分析 → 合格即挂单；活跃挂单与持仓的撮合、盈亏更新与复核。可整体启停、单独暂停或手动执行一轮。</p>
      </div>
    </div>

    <AutomationTasks />
  </section>
</template>

<style scoped>
.automation-view { display: block; }
</style>
