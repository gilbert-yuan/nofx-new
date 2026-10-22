# 山寨趋势突破线上启用记录

**已部署并开启。** 2026-10-23（Asia/Irkutsk，UTC+8）完成运行验收：新策略 ID 为 `altcoin-trend-breakout-live-v1`，名称“山寨趋势突破 · EMA30/90”；仅此1项启用，其余12项均关闭。用户授权创建并启用本轮最高历史收益参数策略，关闭其他策略。

服务地址为 `http://127.0.0.1:3100`，Rust健康检查通过，PM2守护进程在线且配置已持久保存；自动行情扫描与持仓复核已启动。Demo账户及成交收益已完成新同步，`executionStatus.ready=true`，实盘同步关闭。验收时首次行情同步进行中，已完成73/524个合约，失败0个；这不是已经产生新策略成交的证明。

## 参数与执行环境

复用 A 直接突破的 Rust 分析与持仓复核：4h EMA30/90、前10根通道收盘新突破、Wilder ATR14、初始1.5 ATR止损、3 ATR单向收紧保护；无固定止盈。单笔计划风险上限0.3%，杠杆1倍，最多3个在途订单、同向最多2个、同币最多1个。旧策略遗留活动订单计入组合上限。

沿用当前 Binance Demo 配置；`syncPaperOrdersToDemo=true`、`syncPaperOrdersToLive=false`。不切换实盘，不主动平掉旧策略持仓；关闭旧策略意味着停止其新信号扫描，已有订单继续由原策略规则及共享执行层管理。

全局信号分门槛由0.65调整为0.60，以接纳这项机械规则固定的0.60信号分；它不是60%胜率。账户模式、资金和盘口上限保持原配置。

启动验收时交易所直连连续超时。已验证本机现有 `127.0.0.1:7890` 代理能访问 Binance 公共和 Demo 时间接口，运行进程显式设置 `NOFX_HTTP_PROXY=http://127.0.0.1:7890`。该设置保存在 PM2 运行配置，原 `.env` 未改写。

币池按完整的前180根已收盘4h K线（30天）成交额降序，排除BTC、ETH、稳定币和非COIN/非永续，要求上市至少180天，最多选择30个标的。缺失数据不以0填补。全局自适应、成交额、波动率、盘口及资金规则仍可进一步阻止开仓。

## 与历史回放的实际差别

- 保留现有每笔50 USDT名义仓位硬上限及每轮新增订单上限。这些上限可能使实际风险明显低于0.3%，不通过放大仓位追求历史收益。
- 已收盘信号只在当前4h边界后的15分钟内允许首次执行；交易使用实际可用报价和真实成交价，不能承诺历史开盘价。超时拒绝追单，同一个signalAt不重复入场。
- 真实成交价用于重新锚定初始止损；实际报价通过共享风险模型只缩量不放大。跟踪极值及参数按订单持久保存，保护不额外推迟一整根4h。
- Demo资金费和佣金以交易所账簿为准；本地4h模拟仍使用现有聚合撮合与资金费估算，和上一轮逐时历史资金费回放存在口径差别。
- 线上行情保留最多1000根滚动4h数据，递归指标的初始化与历史全前缀存在数值差别。历史全期收益+15.47%是186组中事后最高值，不能视为线上收益预测。

## 验证与追溯

`cargo fmt --check`、`cargo check --all-targets --jobs 1`、`cargo test --all-targets --jobs 1`均通过，453项测试通过、0项失败，10项因环境前置条件忽略。新增回归覆盖数据库闭合K线适配、动态币池、组合限制、信号去重、实时成交锚定与风险、禁用固定止盈、持仓极值持久化和保护生效时点。

本次构建还复跑原A/B八个历史基线场景，逐笔成交、资金费、净额和权益最大差异为0。原研究A/B继续保持`researchOnly=true`，新线上ID复用其分析和复核算法，没有复制回测成交或风险模型。

部署二进制为 `data/ml/runtime-altcoin-20261023/bin/nofx-server.exe`，SHA256为 `5d91474bd71adcefb40629438ad5e955de610739c2e2dfcfb535365ad2bfe01f`。构建采用dev配置、当前package opt-level=1、关闭调试符号与增量编译；121份Rust/Cargo/静态JSON源文件摘要与检查时快照一致。

- [线上策略模板](../configs/altcoin-live-20261022.json)
- [PM2运行配置](../ecosystem.altcoin-live-20261023.json)
- [验收状态](../output/altcoin-online-activation-20261022/runtime-status.json)
- [构建与源文件追溯](../output/altcoin-online-activation-20261022/provenance.json)
- [基线等价验证](../output/altcoin-online-activation-20261022/baseline-parity.json)
- [原策略状态备份](../output/altcoin-online-activation-20261022/strategies-before.json)

运行配置同时保存为`ecosystem.nofx-runtime.json`。常规重启可在项目目录使用：

```powershell
$env:PM2_HOME='D:/UGit/nofx-new/.pm2'
node node_modules/pm2/bin/pm2 startOrRestart ecosystem.altcoin-live-20261023.json --only nofx-api --update-env
node node_modules/pm2/bin/pm2 save
```

原策略参数和启用状态已在变更前备份，旧研究参数与回测结果保留原样。运行依赖本机既有代理保持可用；断网或账户同步过期时，原共享风控会阻止新增订单。
