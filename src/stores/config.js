/**
 * 配置与状态集中存储（前端唯一可信源）
 * - 持有 config / strategy / 各 status，消除 App.vue 里散落的 reactive
 * - 数据访问只通过契约客户端，业务编排仍留在视图层
 */
import { defineStore } from 'pinia';
import { reactive, ref } from 'vue';
import { configApi, strategyApi, binanceApi, marketApi, historyApi } from '../api/client.js';
// demo/testnet 环境判定与后端共用同一实现（shared/），避免前后端口径漂移
import { isBinanceDemo } from '../../shared/binanceEnvironment.js';

export const useConfigStore = defineStore('config', () => {
  const config = reactive({
    model: { enabled: false, apiKey: '', baseUrl: '', model: '', maxConcurrentRequests: 5 },
    binance: {
      apiKey: '', secretKey: '', demoApiKey: '', demoSecretKey: '', liveApiKey: '', liveSecretKey: '',
      demo: true, testnet: true
    },
    trader: {
      exchange: 'binance', enabled: false, dryRun: true, allowEntryOrders: false,
      allowCloseOrders: false, allowProtectionUpdates: true, entrySymbolsText: '',
      maxNewEntriesPerCycle: 1, minConfidence: 0.65, maxLeverage: 5, maxPositionNotionalPct: 0.25,
      maxTotalNotionalPct: 1.25, minProtectionMoveBps: 25,
      syncPaperOrdersToDemo: false, syncPaperOrdersToLive: false
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
        : isBinanceDemo(value.binance)
          ? 'Demo Trading'
          : '实盘交易';
  }

  async function load() {
    const [savedConfig, savedStrategy] = await Promise.all([configApi.get(), strategyApi.get()]);
    Object.assign(config.model, savedConfig.model || {});
    const savedBinance = { ...savedConfig.binance };
    savedBinance.demo = isBinanceDemo(savedBinance);
    savedBinance.testnet = savedBinance.demo;
    if (!Object.hasOwn(savedBinance, 'demoApiKey')) savedBinance.demoApiKey = savedBinance.demo ? savedBinance.apiKey || '' : '';
    if (!Object.hasOwn(savedBinance, 'demoSecretKey')) savedBinance.demoSecretKey = savedBinance.demo ? savedBinance.secretKey || '' : '';
    if (!Object.hasOwn(savedBinance, 'liveApiKey')) savedBinance.liveApiKey = savedBinance.demo ? '' : savedBinance.apiKey || '';
    if (!Object.hasOwn(savedBinance, 'liveSecretKey')) savedBinance.liveSecretKey = savedBinance.demo ? '' : savedBinance.secretKey || '';
    Object.assign(config.binance, savedBinance);
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
    const demo = isBinanceDemo(config.binance);
    const apiKey = demo ? config.binance.demoApiKey : config.binance.liveApiKey;
    const secretKey = demo ? config.binance.demoSecretKey : config.binance.liveSecretKey;
    const saved = await configApi.put({
      binance: { ...config.binance, apiKey, secretKey, demo, testnet: demo },
      trader: { ...config.trader, exchange: 'binance' }
    });
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

  /** 测试网一键冒烟：远价限价单 → 查单 → 撤单（零成交风险全链路验证） */
  async function smoke(payload) {
    return binanceApi.smoke(payload);
  }

  async function openOrders(symbol) {
    return binanceApi.openOrders(symbol);
  }

  async function positions(symbol) {
    return binanceApi.positions(symbol);
  }

  async function order(payload) {
    return binanceApi.order(payload);
  }

  async function cancelOrder(payload) {
    return binanceApi.cancelOrder(payload);
  }

  let pendingStatus;
  function loadStatus() {
    if (pendingStatus) return pendingStatus;
    pendingStatus = Promise.allSettled([marketApi.status(), historyApi.syncStatus(), binanceApi.status()]).then(results => {
      const refs = [symbolStatus, syncStatus, tradingStatus];
      results.forEach((r, i) => { if (r.status === 'fulfilled') refs[i].value = r.value; });
      statusError.value = results.find((r) => r.status === 'rejected')?.reason?.message || '';
    }).finally(() => { pendingStatus = null; });
    return pendingStatus;
  }

  return {
    config, strategy, tradingStatus, symbolStatus, syncStatus, savedMode, statusError,
    load, saveAi, saveBinance, test, review, smoke, openOrders, positions, order, cancelOrder, loadStatus
  };
});
