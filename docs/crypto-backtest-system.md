# 加密货币年度回测脚本系统

## 快速运行

在项目根目录使用 Node.js 22 或更高版本。所有脚本均为 Node.js，策略分析、成交、手续费、分批止盈、移动止损和平仓复用项目现有领域实现。

```powershell
# 生成包含全部策略参数的配置和参数说明；目标文件已存在时不会覆盖
node scripts/backtest-system.mjs init --config configs/crypto-backtest.json

# 更新最近 365 天数据、审计覆盖率、逐策略多轮优化并生成报告
npm run backtest:year -- --config configs/crypto-backtest.json

# 分步执行
node scripts/backtest-system.mjs data --config configs/crypto-backtest.json
node scripts/backtest-system.mjs audit --config configs/crypto-backtest.json
node scripts/backtest-system.mjs run --config configs/crypto-backtest.json
node scripts/backtest-system.mjs optimize --config configs/crypto-backtest.json
```

直接使用随仓库提供的 `configs/crypto-backtest.example.json` 也可以运行，无须先生成配置。`run` 评估当前参数，并完成特征训练、验证与最终测试；`optimize` 增加多轮参数搜索；`all` 串起数据更新、覆盖审计和全部策略优化。默认只用 2 个计算 worker 和 2 个下载 worker，可以配置调整。

公共行情访问需要代理时，在启动脚本前设置项目现有代理环境变量，例如：

```powershell
$env:HTTPS_PROXY = 'http://127.0.0.1:7890'
node scripts/backtest-system.mjs data --config configs/crypto-backtest.example.json
```

下载只使用公共数据接口，不需要 API Key。REST 补全复用项目的 `BinanceClient` 公共接口与已有行情基址设置。

## 每个策略的独立入口

| 策略 | 脚本 | 决策周期 |
| --- | --- | --- |
| 增强趋势 v1 | `scripts/backtest-enhanced-trend-v1.mjs` | 1m，辅以 15m |
| 4H 趋势突破 v1 | `scripts/backtest-h4-trend-breakout-v1.mjs` | 4h |
| 4H 吊灯突破 v1 | `scripts/backtest-h4-chandelier-breakout-v1.mjs` | 4h |
| 4H 均值回归 v1 | `scripts/backtest-h4-mean-reversion-v1.mjs` | 4h |
| 妖币埋伏 v1 | `scripts/backtest-yao-coin-ambush-v1.mjs` | 1m，辅以 15m |
| 结构做空 v1 | `scripts/backtest-structure-short-v1.mjs` | 15m，辅以 5m/1h/4h |
| 结构做多 v1 | `scripts/backtest-structure-long-v1.mjs` | 15m，辅以 5m/1h/4h |

例如单独优化均值回归：

```powershell
node scripts/backtest-h4-mean-reversion-v1.mjs optimize --config configs/crypto-backtest.example.json
```

总入口也支持 `--strategy h4-mean-reversion-v1,structure-long-v1`。策略来自正式注册表，包括生产环境未启用的内置策略。没有复制一份简化版策略或另一套盈亏计算器。

## 数据范围与质量

目前默认市场是 **币安 USDT 本位永续合约**。“全部币种”指该市场中发现的币种，不包含其他交易所的所有加密资产、币本位合约或股票。

下载器取官方月度归档的历史币种目录、当前永续合约目录以及本地缓存的并集，从而纳入历史下架币种；已结束月份下载月包，当前月份或缺少月包时下载日包，最近缺少归档的日期再用 REST 补全。官方数据的月包、日包、12 列 K 线字段及 SHA256 校验说明见 [Binance Public Data](https://github.com/binance/binance-public-data)，REST 字段见 [币安 K 线接口文档](https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/market-data/rest-api/Kline-Candlestick-Data)。

- `period.from/to`：ISO 时间，UTC 分钟对齐，结束端点不含。不指定时按最新完整分钟往前 365 天。
- `period.warmupDays`：默认额外请求 90 天暖机数据，不计入评估收益。结构策略的 500 根 4h 窗口需要约 83 天历史。
- `data.directory/klines/SYMBOL.ndjson`：新数据目录；`legacyDirectories` 可接入旧年度缓存。
- 旧 `.ndjson` 文件实际上是六列 CSV，支持 `openTime,open,high,low,close,volume`；新下载保存官方 12 列格式。也支持逐行 JSON 对象。
- 1m 自动聚合 5m、15m、1h、4h、1d 等周期；只有全部分钟连续存在且已经结束的桶才生成完整 K 线。
- 报告列出覆盖比例、实际可观察天数、起止时间、无效行、重复行、缺口和缺失字段。旧数据缺少成交额时不会把 `close × volume` 当作真实成交额。
- 新上市或下架币种默认按实际历史评估，并标记 `partial_history`。可以设置 `allowPartialHistory:false`，只接受覆盖率达到 `minCoverage` 的币种。暖机不足和无数据区间都会给出排除原因。
- 下载失败保持非成功状态；`all` 会在下载错误时停止，避免把下载失败悄悄视为全市场完整数据。无历史归档的币种仍保留在清单。

**旧年度缓存当前截至 2026-09-13；只使用该缓存不能把报告称为截至今天的完整一年结果。** 更新后应先查看覆盖审计，尤其是末端缺口、新币和下架币。

### 妖币埋伏的历史画像

该策略生产候选池还依赖市值、流通量、总供应量、市值排名和 24h 成交额。这些数据不能从 K 线完整复原，也不能用今天的市值代替过去市值。

`data.historicalProfiles` 可以指向历史快照 JSON 数组：

```json
[
  {
    "symbol": "BTCUSDT",
    "asOf": "2025-10-01T00:00:00Z",
    "marketCap": 2000000000000,
    "marketCapRank": 1,
    "volume24h": 30000000000,
    "circulatingSupply": 19900000,
    "totalSupply": 21000000,
    "priceChangePercentage24h": 1.5
  }
]
```

只能读取当时或更早的快照，默认超过 `profileMaxAgeDays:2` 视为过期。缺少这类历史数据时该策略标记 `historical_market_profiles_missing`。要研究其纯 K 线部分，可以在该策略 `params` 明确设 `marketUniverseEnabled:false`；这属于候选池消融实验，不能宣称完整复现生产策略。

## 参数与批量调优

`init` 输出每个策略全部注册参数，包括默认值的可编辑副本；旁边 `.schema.json` 输出参数名称、边界、分组和说明。`schema` 命令也可单独导出当前模式。增强趋势补充了主周期 MA、ATR、RSI、MACD、布林带、量能、支撑阻力、Ichimoku、DMI、Supertrend 和 OBV 窗口，以及智能退出 MA/ATR 周期。指标与出场规则随订单快照，复核时读取该订单参数。

参数层级：

| 配置 | 用途 |
| --- | --- |
| `strategies.<id>.params` | 策略原有参数：周期、方向、评分、量比、ATR、止损、目标、持有期限、分批退出等 |
| `execution` | 初始资金、固定/比例保证金、止损风险预算、杠杆上限、挂单 TTL、冷却、每日亏损、连续亏损、决策/复核频率 |
| `strategies.<id>.execution/costs` | 单策略覆盖执行或成本配置 |
| `costs` | 双边手续费、滑点、固定资金费情景，单位 bps |
| `features` | 特征周期、窗口、分位、效应门槛、证据量、规则数、缺失处理、手工规则 |
| `strategies.<id>.searchSpace` | 策略参数搜索值，数组或 `{min,max,step}` |
| `optimization.runtimeSpace/costSpace` | 执行参数或成本情景搜索空间 |

未知参数、越界、非整数周期、周期冲突等会报错，避免调参时拼错名称却静默跑默认值。`parameterSource` 默认 `schema`；设为 `configured` 时只读加载当前项目策略配置作为起点，报告保存实际参数，不输出账户密钥。

示例：

```json
{
  "strategies": {
    "h4-mean-reversion-v1": {
      "params": { "tpToMean": false },
      "searchSpace": {
        "meanPeriod": [16, 20, 24],
        "entryExtAtr": [1.5, 2, 2.5],
        "stopAtr": [1.2, 1.5, 1.8],
        "tpR": [1.5, 2, 2.5],
        "maxHoldBars": [12, 17, 24]
      }
    }
  },
  "optimization": {
    "objective": "return",
    "method": "adaptive-random",
    "autoSpace": false,
    "maxRounds": 10,
    "trialsPerRound": 20,
    "patience": 3,
    "runtimeSpace": { "marginPct": [0.03, 0.05, 0.08] }
  }
}
```

`tpToMean:true` 时目标是均线，`tpR` 不决定主目标。原策略未消费或仅用于组合的参数也不会凭空生效。例如每币独立账户只有一笔活动订单，`maxPositions` 不参与逐币盈亏；它不能用来解释共享资金池的组合回测。

仓位取固定金额或权益比例，再按止损风险和可用资金截断。新单的 **保证金 + 往返手续费预留 ≤ 当前权益**。`respectStrategySizing:true` 时策略自身的 `autoMarginPct/riskPerTrade` 优先；研究统一金额时可设为 `false`。固定资金费情景按持有时间扣费，并非真实逐时历史资金费率。

### 多轮搜索与停止

1. 时间按先后默认分成 60% 训练、20% 验证、20% 最终测试，各段独立起始资金。
2. 每轮评估多个参数组合；默认在参数边界内生成邻近值并进行确定性随机搜索，后续围绕验证期最优配置继续搜索。
3. 默认在交易数和最大回撤约束内最大化验证期等权平均收益。可用 `objective:"risk-adjusted-return"` 加入回撤与均值/中位数差异惩罚。
4. 连续 `patience` 轮无显著改善、搜索空间穷尽或达到 `maxRounds` 时停止。最优只针对已经搜索过的范围和预算，有限回测不能保证全局最优。
5. 逐币最优参数也从训练/验证阶段选取，交易证据不足时回退策略统一参数并标明原因。
6. 冻结选择后才读最终测试期。不会以测试收益决定下一轮参数。重新看同一测试期后再调参，会污染样本外证据，应保留新的测试期或做前向观察。

`method:"grid"` 支持笛卡尔网格，建议关闭 `autoSpace` 并显式列出少量参数。大型网格按轮数预算截断，不承诺穷举完毕。

## 从盈利币种提取特征并执行筛选

每笔训练期交易记录入场之前已经收盘的特征窗口：

| 特征名称 | 定义 |
| --- | --- |
| `trendReturn` | 最近 `trendBars` 根收盘累计变动，比例数 |
| `trendEfficiency` | 净位移 / 逐根绝对位移，0～1 |
| `atrPct` | 平均真实波幅 / 最新收盘价 |
| `returnVolatility` | 对数收益的标准差 |
| `volumeRatio` | 最新成交量 / 前若干根平均成交量 |
| `volumeTrend` | 最近一段均量 / 前一段均量 |
| `upperWickRatio/lowerWickRatio` | 最新 K 线上/下影占当根振幅比例 |
| `rangePosition` | 最新价格在近期最高/最低区间内的位置 |

先分训练期盈利币种和非盈利币种，每个币种一票，比较其入场特征中位数。只保留样本量与效应门槛足够的特征，再用盈利币种的分位区间形成规则。规则只来自训练期；验证期收益、交易证据与回撤通过门槛后才应用于最终测试和全年重放。未通过验证或样本不足时明确不启用学习规则。规则依据的是形态条件，不是事后盈利币种名单。

手工条件始终可以固定，例如：

```json
{
  "features": {
    "interval": "1h",
    "manualRules": [
      { "feature": "atrPct", "min": 0.005, "max": 0.035 },
      { "feature": "trendEfficiency", "min": 0.3, "max": 1 }
    ],
    "missing": "reject"
  }
}
```

多条规则按 AND 匹配，未满足就不生成新订单，已有持仓继续按原出场规则管理。特征区间是描述性统计，不能证明因果，也不能直接解释成上涨概率。

### 自动化模块使用相同筛选

每次回测输出 `feature-filters.json`。系统自动化入口已接入同一 `klineFeatures/matchFeatureRules` 实现；可以在系统配置的 `analysis` 中显式启用：

```json
{
  "analysis": {
    "backtestFeatureFilters": {
      "enabled": true,
      "file": "output/crypto-backtest/<runId>/feature-filters.json"
    }
  }
}
```

启用后的新信号只对符合规则的币种生成。筛选文件或行情不可用时保持 WAIT。回测脚本本身不会写线上配置、替换生产策略参数或提交交易订单；部署选中的配置仍应结合最终测试和前向观察。参数/执行配置另存于 `strategy-profile.json`，生产资金管理仍使用本地实际设置。

## 输出与解释

默认目录：`output/crypto-backtest/<runId>/`，`runId` 包含请求日期、有效参数、数据文件标识、历史画像摘要与引擎代码摘要。

```text
index.html                         所有策略汇总
summary.json                       汇总机器可读结果
status.json                        运行/暂停/失败/完成状态
run.json                           脱敏配置、参数与数据标识
parameter-schema.json              完整注册参数说明
feature-filters.json               各策略固定筛选规则
checkpoints/*.json                 逐币逐组合逐分段检查点
<strategyId>/report.html            策略页面
<strategyId>/report.json            逐币全部指标、成本、漏斗、月度与交易明细
<strategyId>/coins.csv              逐币收益率、最大回撤、胜率、PF、参数等
<strategyId>/optimization-history.json 每轮试验及最优变化
<strategyId>/best-per-coin.json      币种最优参数与最终测试结果
<strategyId>/strategy-profile.json  统一参数、执行设置、特征条件及风险说明
```

- `training/validation/test/full` 明确区分。`full` 是全年描述性重放，包含训练和验证，不应作为纯样本外结果。
- `test` 使用策略统一参数；`coinBestTest` 使用逐币验证最优参数。CSV 每行带 `params/execution/costs`，可以重放。
- 最大回撤按每分钟已收盘价格盯市，包含未实现收益与已计费用；一分钟内部真实资金轨迹无法从 OHLC 完整恢复。
- 各币种独立起始资金。横截面平均收益与最差单币回撤不等于多策略共享资金池组合的收益和回撤。
- 分段结束仍持仓会按最后已观察收盘价计费用平仓，记为 `backtest_period_end` 和 `forcedClosures`；待成交订单取消并单独统计。
- 没有交易是零交易，缺失数据是 `excluded`，计算错误是 `error/analysis_error`。没有有效币种时平均收益为 `null`，不会伪装成 0% 盈利。
- `insufficient_evidence` 表示没有满足交易数/回撤门槛的候选，不能解释为已发现赚钱参数。
- 优化报告显示每次实际搜索组合及其收益，不只保存最好的一次。

## 断点续跑与缩小研究范围

每个逐币任务完成后原子写检查点；同一请求区间、参数、数据和代码可直接重跑复用。执行错误不缓存成成功，代码或数据发生变化会换指纹。自动日期每分钟会变化；长任务中断后应保持相同 `from/to`（从 `run.json` 获取），避免把新的时间请求误认为原任务的续跑。

```powershell
node scripts/backtest-system.mjs optimize --config configs/crypto-backtest.example.json `
  --strategy h4-trend-breakout-v1 --symbols BTCUSDT,ETHUSDT,SOLUSDT `
  --from 2025-09-13T12:46:00Z --to 2026-09-13T12:46:00Z `
  --workers 2 --rounds 3 --trials 3 --output output/crypto-pilot
```

Ctrl+C 会让当前试验完成并保存检查点，在进入后续试验前暂停；`status.json` 不会伪报全部完成。大规模 1m 策略需要大量 CPU、磁盘和下载时间，先看审计和小范围运行，再增加币种与搜索预算。

## 完整性检查

```powershell
npm run backtest:smoke
node --check scripts/backtest-system.mjs
```

离线完整性脚本检查周期关闭、未来 K 线不可见、缺口、CSV 字段、未知参数、期限、成本、无效收益、训练特征、运行时筛选和网格轮次。它不替代全市场年度回测或对策略有效性的统计评估。

历史收益不能保证未来收益；最优仅代表给定搜索范围内的历史选择。报告不构成投资建议。
# 已授权的完整执行批次

新增 `scripts/backtest-campaign.mjs` 把下载、审计、7 个独立脚本的顺序优化和部署连起来。

```powershell
# init 冻结有效线上参数，生成可配置的年度区间和搜索空间（已有文件不会覆盖）
node scripts/backtest-campaign.mjs init configs/crypto-backtest.campaign.json
node scripts/backtest-campaign.mjs run configs/crypto-backtest.campaign.json
```

本轮区间为 2025-10-06 至 2026-10-06 UTC，暖机 90 天。初始每币独立模拟资金为 360 USDT；真实线上资金池配置不由批次修改。
每策略最多 3 轮、每轮 3 个候选，连续 2 轮无改进停止。只表示本轮空间和预算内最优；可在配置中修改预算及任一策略参数，再使用新的留出期重新评估。

执行进度在 `output/crypto-backtest-campaign/campaign-status.json`，各阶段日志在同目录 `logs/`。
下载覆盖官方历史归档、当前合约和本地缓存的并集；无本年数据的历史币种排除。已校验且文件指纹未变的下载可以继续复用。
原生 4h/15m 策略空仓时跳到下一决策点，活动订单始终逐分钟撮合；同币训练/验证的数据解析复用。

每份报告包含冻结当前参数的 `baseline` 与候选的同币种对照，以及 `deployment` 决策。
上线门槛同时检查全体有效币种与年度覆盖至少 95% 的同币种子集：全体有效币种的验证/测试收益均须为正，PF 至少 1.05，最差回撤不超过 30%；不能仅凭完整历史币种子集盈利通过采用判定。
默认采用门槛见 `scripts/backtest/deployment.mjs`：至少 30 天最终测试，验证/测试各 100 笔交易和 10 个成交币种，年度覆盖至少 95%，均值收益为正并优于基线至少 0.1 个百分点，PF 至少 1.05，最差币种回撤不超过 30%且相对基线恶化不超过 2 个百分点。
成本或执行情景改变不自动部署；测试只否决事先冻结候选，不能据此继续挑参。妖币策略没有历史市场画像时出具明确排除报告，不为获得回测收益自动关闭线上画像筛选。

```powershell
# 只形成部署计划
node scripts/backtest-deploy.mjs --campaign output/crypto-backtest-campaign
# 用户已授权本批次更新线上，run 会在全部独立脚本完成后执行这个动作
node scripts/backtest-deploy.mjs --campaign output/crypto-backtest-campaign --apply
```

部署先备份 `data/strategies.json` 和既有生产筛选文件，保留启用状态与备注；使用本地策略 API 条件更新参数并回读。
线上参数相对回测基线已经变化时跳过，读回不一致时尝试条件回退并记录结果。
通过验证的筛选固化在 `data/backtest/production-profiles.json`，只在参数快照匹配时应用。已有显式筛选设置时不覆盖它。
服务重启保留 PM2 既有环境，不使用 `--update-env`。不发送测试订单，不改初始资金、杠杆后的名义总额上限或共享资金池的保证金加手续费限制。
历史结果仍不保证未来盈利，策略参数采用情况记录在 `deployment-result.json`。

