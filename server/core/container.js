/**
 * 依赖容器：后端所有单例的单一创建点。
 * index.js 只负责"组装"（挂载路由、静态资源、生命周期），不再散落 new/await。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../store.js';
import { marketData } from '../marketData.js';
import { BinancePositionMonitor } from '../binancePositionMonitor.js';
import { MarketDb } from '../marketDb.js';
import { KlineSync } from '../klineSync.js';
import { registerResearchRoutes } from '../researchRoutes.js';
import { GlobalAutomation, registerGlobalAutomationRoutes } from '../globalAutomation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..', '..');

export class Container {
  constructor() {
    this.ready = false;
  }

  /** 创建数据/行情/同步相关单例（不依赖 express app） */
  async init() {
    if (this.ready) return;
    this.rootDir = rootDir;
    this.dataDir = path.resolve(rootDir, process.env.DATA_DIR || 'data');
    this.port = Number(process.env.PORT || 3100);

    this.store = new Store(this.dataDir);
    await this.store.init();

    this.marketDb = new MarketDb();
    await this.marketDb.init();

    this.positionMonitor = new BinancePositionMonitor({ store: this.store, marketDb: this.marketDb });
    this.klineSync = new KlineSync({ store: this.store, marketDb: this.marketDb, positionMonitor: this.positionMonitor });
    await this.klineSync.configureFromStore();

    this.marketData = marketData;
    this.ready = true;
  }

  /** 注册研究路由（需要 app 实例），返回 simulation/archive 句柄 */
  async registerResearch(app) {
    this.researchInstances = await registerResearchRoutes({
      app,
      store: this.store,
      marketDb: this.marketDb,
      loadContracts: () => this.marketData.perpetualUsdtContracts()
    });
    return this.researchInstances;
  }

  /** 构建并注册全局自动化（依赖 research 的 simulation/archive） */
  registerGlobalAutomation(app) {
    this.globalAutomation = new GlobalAutomation({
      simulation: this.researchInstances.simulation,
      market: this.marketData,
      marketDb: this.marketDb,
      archive: this.researchInstances.archive,
      store: this.store
    });
    registerGlobalAutomationRoutes(app, this.globalAutomation);
    return this.globalAutomation;
  }

  /** 应用启动后调用：拉起自动化与定时清理任务 */
  startLifecycle() {
    setTimeout(() => {
      try {
        this.globalAutomation.start();
        console.log('[GlobalAutomation] 自动启动成功');
      } catch (error) {
        console.error('[GlobalAutomation] 自动启动失败:', error.message);
      }
    }, 5000);
    console.log('[GlobalAutomation] 系统就绪，将在5秒后自动启动');

    setTimeout(() => this.scheduleKlineCleanup(), 10000);
    setTimeout(() => this.scheduleAnalysisCleanup(), 15000);
  }

  scheduleKlineCleanup() {
    const tick = async () => {
      try {
        const state = await this.researchInstances.simulation.read();
        const symbols = [...new Set(state.orders.map((o) => o.symbol))];
        const result = await this.marketDb.cleanOldKlines(symbols, 3);
        console.log(`[KlineCleanup] 完成: 删除 ${result.deletedCount} 条, 币种 ${result.symbolsCleaned.join(', ') || '无'}`);
      } catch (error) {
        console.error('[KlineCleanup] 失败:', error.message);
      }
    };
    const next = () => {
      const now = new Date();
      const t = new Date(now); t.setHours(2, 0, 0, 0);
      if (t <= now) t.setDate(t.getDate() + 1);
      setTimeout(async () => { await tick(); next(); }, t.getTime() - now.getTime());
    };
    next();
  }

  scheduleAnalysisCleanup() {
    const tick = async () => {
      try {
        const state = await this.researchInstances.simulation.read();
        const keep = [...new Set(state.orders.map((o) => o.recordId).filter(Boolean))];
        const result = await this.researchInstances.archive.cleanOldRecords(keep, 30);
        console.log(`[AnalysisCleanup] 完成: 删除 ${result.deletedCount} 条, 保护 ${result.protectedRecords} 条`);
      } catch (error) {
        console.error('[AnalysisCleanup] 失败:', error.message);
      }
    };
    setTimeout(async () => {
      await tick();
      setInterval(tick, 60 * 60 * 1000);
      console.log('[AnalysisCleanup] 定时清理已启动（每小时）');
    }, 0);
  }
}
