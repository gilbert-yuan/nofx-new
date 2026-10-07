# 增强趋势 v1：联合参数与策略确认探索

执行策略始终是 `enhanced-trend-v1`。其他策略仅提供同币种、同方向的可交易信号；不生成订单，不接管止盈止损，不改变资金分配。回测直接复用 `scripts/backtest/replay.mjs`、正式注册表、`server/tradingSimulator.js` 与项目成本模型。

## 运行

```powershell
# 30 天、12 币种首轮；含妖币埋伏纯 K 线消融研究
node scripts/explore-enhanced-trend-combinations.mjs --config scripts/enhanced-combinations.pilot.json

# 更大的扫描；缺少历史市值画像时排除完整妖币埋伏
node scripts/explore-enhanced-trend-combinations.mjs --config scripts/enhanced-combinations.example.json

# 语法与领域烟雾验证
node --check scripts/explore-enhanced-trend-combinations.mjs
node scripts/backtest-confirmation-smoke.mjs
node scripts/backtest-smoke.mjs
```

结果位于配置的 `backtest.output.directory/<runId>/`。相同代码、参数、数据文件和配置生成相同 ID；再次运行会恢复已完成的逐币回放。`status.json` 显示阶段，`trials.json` 保存所有训练和验证结果，`selection.json` 在测试运行前锁定选择，`report.md/report.json` 提供最终对照和成交记录。

## 搜索范围

- `search.mainTrials`：增强趋势初始参数候选数。`mainSpace` 暴露评分、ATR、RSI、量能、15m 趋势、回调深度、止盈止损、持仓期限与退出参数。可按正式参数模式扩展任意键。
- `singleTrials`：每个单确认策略的联合候选数；候选会同时修改增强趋势参数、确认策略参数、回看根数、评分门槛。
- `pairTrials`：每组双策略 AND/OR 的联合候选数；两个确认策略的参数和增强趋势参数共同变化。
- `topMain`：用于后续联合搜索的增强趋势验证优胜参数数量。
- `topSingles`：从单策略验证结果选择多少个确认策略进入两两组合。默认最多 3 个。双策略是有预算的筛选范围，未穷举所有策略子集。
- `confirmationSpaces`：按确认策略 ID 配置原生参数数组，例如突破通道、EMA、ADX、量比、回归偏离、RSI、结构评分等。配置必须符合正式 schema；执行不接受未知参数。
- `modes`：`all` 要求全部确认，`any` 要求至少一个确认。底层撮合入口另支持 `atLeast`，可用于明确编写的多策略配方。
- `lookbackBars`：最近已闭合原生信号之前可回看多少根。`0` 表示只检查最新已收盘的原生决策。例如 4h 信号收盘后保留到下一根 4h 收盘，`1` 还允许向前一根 4h 的信号。不会读取当前未收盘 K 线。
- `minScores`：确认策略原生评分门槛；为 `0` 时不追加评分限制。仍需通过该策略的完整入场与成本闸门。
- `strategyIds:"disabled"`：以运行开始时的正式配置读取未启用策略。结构空与只做多的执行策略方向不兼容，会列出排除原因。
- `yaoKlineOnly:true`：显式关闭妖币埋伏的市值画像预筛选，研究纯 K 线消融版本。若需完整策略，应提供 `backtest.data.historicalProfiles` 的历史快照；不会用今天市值替代历史。
- `maxSymbols`：按种子与币种名称哈希抽样；`0` 表示所有请求币种。不是按未来收益选币。

若要扩大到全年全币种，可复制示例配置，调整 `period.from/to`、`maxSymbols:0` 和候选预算。先确保历史数据和暖机覆盖；结构策略 500 根 4h 需要约 83 天额外历史。`backtest.parameterSource:"configured"` 读取线上参数作为基准，并把完整快照写入 manifest，不写回生产配置。

## 如何判断组合有效

训练和验证需满足最低交易数、数据可用性与回撤门槛。验证集按既有 `objective` 排序，锁定增强趋势单策略和组合候选后才打开测试期。测试结果不会反过来更换参数。

报告同时给出：当前参数、优化增强趋势、各组合，以及最优组合的“相同增强趋势参数、去掉确认条件”对照。后者用于区分收益变化来自主策略参数还是确认过滤。过滤后的收益来自重新回放订单全过程；直接丢掉旧成交不能替代它。

重叠统计对优化后的增强趋势无过滤成交做观察，分别报告盈利交易保留率、亏损交易过滤率、盈利币种覆盖率、错过的盈利净额、过滤的亏损净额。同时列出未开启策略当前参数的覆盖、优化后条件的覆盖、具体盈利币种的匹配，以及最优组合精确配方的覆盖。盈利币种覆盖表示该币种至少有一笔盈利交易通过确认；不能把它解释成该币种所有盈利交易都匹配。

确认分析使用初始余额作为独立影子账户的上下文，不模拟确认策略自身的持仓与资金约束；增强趋势回放承担实际订单、风险检查、保证金和结算。

每个币种使用独立初始资金，报告的均值为等权统计，不是线上多币共享账户收益。固定手续费、滑点和资金费率，分段末尾强平。有限搜索只能称为扫描范围内的候选最优；单个小规模留出窗口不足以证明稳定盈利。

## 扩大结构做多确认验证

```powershell
node scripts/backtest-structure-confirmation-v1.mjs --config scripts/backtest/structure-expansion.json --plan
node scripts/backtest-structure-confirmation-v1.mjs --config scripts/backtest/structure-expansion.json
node scripts/backtest/structure-expansion-smoke.mjs
```

扩大验证固定首轮 `c7a0318e1d460fd1` 的增强趋势和结构确认完整参数，保存在版本化的 `scripts/backtest/structure-expansion.json`，不依赖未提交的旧输出目录。评估期为 2026-07-08 至 2026-10-06，共 90 天；请求 64 个币种，包含原先 12 币、BTC/ETH/SOL 和按种子与名称哈希选取的额外币种。新增币种的文件首尾需覆盖评估期及 90 天暖机，回放另检查真实覆盖率与缺口；必选的旧币若历史不足，会在结果中单列。

相同增强趋势参数的两组逐币连续回放：无过滤组旁观结构信号（`audit`），结构确认组必须通过确认才允许入场。均使用 1 分钟决策和撮合、原有成本与风控。两组初始资金及退出规则一致，过滤后重新撮合，不用删除旧成交估算收益。

结果保存在 `output/structure-confirmation-expanded/<runId>/`。`manifest.json` 记录引擎、文件、币种选择和来源；`frozen-parameters.json` 保存精确参数；`status.json` 记录进度；`report.md/report.json` 给出同币对照、原先与新增币种、分月权益变化、盈利集中度、确认覆盖和全部逐币成交。相同回放身份可恢复缓存；异常结果会重新计算。

分月收益由连续账户的月初/月末权益计算，月间不重置资金，末尾强平一次。较早历史是回顾性稳健性评估，因为参数在后段历史上已被选择过；新增币种的表现用于观察跨币种外推，不能称为新的未来样本外验证。扩大阶段不再次按结果调参。

### 本轮扩大结果

运行 `49e23defa4a7f3bc`，2026-07-08 至 2026-10-06（UTC，不含结束端点）；64 个请求币种，63 个行情覆盖有效。DJTUSDT 因覆盖不足排除。全部成交均由增强趋势 v1 执行。

| 指标（63 个同币有效样本） | 同参数无过滤 | 结构做多确认 |
| --- | ---: | ---: |
| 等权平均收益 | -14.793% | -2.057% |
| 平仓交易 | 7764 | 899 |
| 胜率 | 35.355% | 34.594% |
| 净收益盈亏比 PF | 0.456 | 0.433 |
| 最差单币回撤 | 36.305% | 9.067% |
| 净盈利币种 | 0 | 6 |

完整 90 天起点暖机的 60 个币种中，两组平均收益为 -15.367% / -2.173%，结构组 897 笔交易、5 个盈利币种。起点历史不足的 EWT、QNTX、TER 单列；DJT 已因行情覆盖不足排除。新增 52 币的结构组平均收益 -2.219%。有成交的共同币种子集（51 币）结构组平均收益 -2.540%，零成交标的没有使结论转为盈利。

结构组分月平均收益：7 月部分区间 -0.258%、8 月 -0.752%、9 月 -0.970%、10 月前 5 天 -0.099%。结构组全部有效样本毛收益 -652.93 USDT，手续费 634.17 USDT、资金费 8.55 USDT，净收益 -1295.65 USDT。该净额对应每币独立 1000 USDT 的研究账户，不能当作共享账户实盘盈亏。

净盈利币种为 USELESS (+2.991%)、CYS (+1.588%)、MTL (+1.008%)、TER (+0.824%，起点暖机不足，仅 2 笔)、STEEM (+0.399%)、ARB (+0.236%)。上轮短测试盈利的 GIGGLE，扩大期结构组收益 -4.082%。当前证据支持减少交易、减少亏损和回撤，尚不支持稳定盈利；胜率与 PF 未改善。

完整报告与逐笔结果位于 `output/structure-confirmation-expanded/49e23defa4a7f3bc/report.md` 和 `report.json`；结算、完整暖机子集及代码一致性核对在 `supplemental-report.json`。

```powershell
node --check scripts/backtest-structure-confirmation-v1.mjs
node scripts/backtest/structure-expansion-smoke.mjs
node scripts/backtest-confirmation-smoke.mjs
node scripts/summarize-structure-expansion.mjs output/structure-confirmation-expanded/49e23defa4a7f3bc/report.json --exclude-new-files scripts/backtest/yao-h4-worker.mjs,scripts/backtest/yao-h4.mjs
```

该运行期间同目录另一组研究新增了两份脚本，因此全目录指纹改变。核对时明确扣除上述新增文件，重算指纹仍严格等于原记录，证明本轮原有引擎文件未改变。`--exclude-new-files` 不能绕过旧引擎文件的变化。实际执行策略、做多方向、确认观察不晚于下单时点、冻结参数、逐笔成本、累计平仓净额与分月权益一致性核对均通过。
