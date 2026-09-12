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
import { createStrategiesRouter } from '../routes/strategies.js';

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
    this.klineSync.automation = this.globalAutomation;
    registerGlobalAutomationRoutes(app, this.globalAutomation);
    // 策略管理：勾选启用 / 覆盖参数（运行时即 GlobalAutomation 里的策略运行时）
    app.use(createStrategiesRouter({ strategies: this.globalAutomation.strategies, store: this.store }));
    return this.globalAutomation;
  }

  /** 应用启动后调用：仅启动两项自动交易任务。 */
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

  }
}
