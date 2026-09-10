/**
 * 配置与状态集中存储（前端唯一可信源）
 * - 持有 config / strategy / 各 status，消除 App.vue 里散落的 reactive
 * - 数据访问只通过契约客户端，业务编排仍留在视图层
 */
import { defineStore } from 'pinia';
import { reactive, ref } from 'vue';
import { configApi, strategyApi, binanceApi, marketApi, historyApi } from '../api/client.js';

export const useConfigStore = defineStore('config', () => {
  const config = reactive({
    model: { enabled: false, apiKey: '', baseUrl: '', model: '', maxConcurrentRequests: 5 },
    binance: { apiKey: '', secretKey: '', testnet: true },
    trader: {
      exchange: 'binance', enabled: false, dryRun: true, allowEntryOrders: false,
      allowCloseOrders: false, allowProtectionUpdates: true, entrySymbolsText: '',
      maxNewEntriesPerCycle: 1, minConfidence: 0.65, maxLeverage: 3, maxPositionNotionalPct: 0.2,
      maxTotalNotionalPct: 0.3, minProtectionMoveBps: 25
    }
  });
  const strategy = reactive({ name: '', interval: '1m', klineLimit: 80, systemPrompt: '', rules: '' });

  const tradingStatus = ref(null);
  const symbolStatus = ref(null);
  const syncStatus = ref(null);
  const savedMode = ref('读取配置中');
  const statusError = ref('');

  function updateSavedMode(value) {
    savedMode.value = !value.trader?.enabled
      ? '币安自动交易关闭'
      : value.trader.dryRun !== false
        ? '仅模拟指令'
        : value.binance?.testnet
          ? '测试网交易'
          : '实盘交易';
  }

  async function load() {
    const [savedConfig, savedStrategy] = await Promise.all([configApi.get(), strategyApi.get()]);
    Object.assign(config.model, savedConfig.model || {});
    Object.assign(config.binance, savedConfig.binance || {});
    Object.assign(config.trader, savedConfig.trader || {});
    updateSavedMode(savedConfig);
    Object.assign(strategy, savedStrategy || {});
    return { savedConfig, savedStrategy };
  }

  async function saveAi() {
    const savedConfig = await configApi.put({ model: { ...config.model } });
    const savedStrategy = await strategyApi.put({ ...strategy, symbolsText: 'ALL' });
    Object.assign(config.model, savedConfig.model || {});
    Object.assign(strategy, savedStrategy || {});
  }

  async function saveBinance() {
    const saved = await configApi.put({ binance: { ...config.binance }, trader: { ...config.trader, exchange: 'binance' } });
    Object.assign(config.binance, saved.binance || {});
    Object.assign(config.trader, saved.trader || {});
    updateSavedMode(saved);
  }

  async function test() {
    return binanceApi.test();
  }

  async function review() {
    return binanceApi.review();
  }

  async function loadStatus() {
    const results = await Promise.allSettled([marketApi.status(), historyApi.syncStatus(), binanceApi.status()]);
    const refs = [symbolStatus, syncStatus, tradingStatus];
    results.forEach((r, i) => { if (r.status === 'fulfilled') refs[i].value = r.value; });
    statusError.value = results.find((r) => r.status === 'rejected')?.reason?.message || '';
  }

  return {
    config, strategy, tradingStatus, symbolStatus, syncStatus, savedMode, statusError,
    load, saveAi, saveBinance, test, review, loadStatus
  };
});
