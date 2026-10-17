# 多空净收益模型的周度训练

入口是 Rust `nofx-ml-profit-train`，后台编排使用 `scripts/train-profit-model.ps1`。它只写新的研究目录，不读取账户密钥，不下单，不替换当前 Demo 模型。

## 本轮固定协议

- 复用上轮 180 天归档和 Chronos 推理缓存，验证原完成报告、数据清单、缓存及规范化源文件的 SHA-256；不重跑 Chronos，也不重新计算历史交易标签。
- 4 个预先固定的候选：60/90 天训练窗口 × 保留/去掉 Chronos 特征。主候选在运行前固定为 `90d-with-chronos`，不会按最后回放收益重新挑主候选。
- 每个方向分别训练一个 LightGBM L2 净收益回归器。目标来自共享成交引擎的多空反事实净收益，除以固定 50 USDT 名义预算上限；未成交且已过期为 0，未成熟或无法评价为缺失。实际风控成交规模可能小于该预算，因此这不是实际成交名义金额收益率。
- 每周先用较早训练段与末 7 天成熟标签做验证早停，锁定迭代数后，重新拟合截至该周时点全部可用的近期成熟标签。最新训练时点仍受 48 小时观察隔离约束。
- 3 周滚动样本外预测作为预热。每个评估周分别使用更早的一周校准净收益偏差、随后独立的一周验证开仓门槛；门槛验证的 48 小时结算尾部严格早于当前模型时点。重拟合模型的样本内预测不会拿来校准。
- 校准余量按 UTC 日残差均值计算，是全局均值误差启发式，不是单笔交易的置信下界。样本不足时保持 HOLD。
- 在 4 个预先规定的收益门槛与不交易基准之间选择；门槛验证需要至少 10 笔已闭合交易及正净收益。无足够证据时选择 HOLD。
- 最后 4 周在同一个 1,000 USDT 共享账户中连续回放，模型按周更新，资金和风险账本跨周保持连续。每小时按过去连续 24 小时成交额取前 50 个合约，轮转扫描 20 个，每轮最多新增 1 单。止盈止损、分批退出、均线智能退出、资金占用及风险账本复用共享 Rust 实现。
- 评估后为每个候选另存快照截止时点的最新多空模型及门槛。历史上已结束且与回放区间无交集的市场写入覆盖报告，历史训练记录继续保留。

## 启动与恢复

```powershell
cargo build --release --locked --bin nofx-ml-profit-train
pwsh -NoProfile -File scripts/train-profit-model.ps1 -SkipBuild

# 相同二进制和协议的断点恢复
pwsh -NoProfile -File scripts/train-profit-model.ps1 -SkipBuild -Resume
```

默认使用 2 个训练线程；标量推理使用 1 个线程。编排脚本启动前检查系统提交内存余量，使用独立二进制副本与直接文件日志，约每 10 秒刷新工作流心跳。当前会话通过 Windows WMI 服务启动该脚本，使后台进程不依赖当前聊天命令的生命周期。

训练输出目录默认 `output/ml-profit-train-20261016`：

- `workflow-status.json`：后台进程、子进程、心跳、日志与当前训练阶段。
- `training-status.json`：原生训练器阶段、候选、周时点和方向。
- `run-config.json`：固定协议、源文件及二进制哈希、前向验证仍然必需的标记。
- `data-provenance.json` / `market-coverage.json`：目标来源、样本及市场覆盖。
- 各候选的 `asof-*`：多空模型、早停记录、原始样本外预测、独立校准与门槛验证结果。
- 各候选的 `shared-replay.json`：连续共享账户的订单、权益曲线与诊断。
- 最终 `report.json`：4 个候选的历史研究汇总。

输出检查点不可覆盖；协议、代码或二进制改变后使用新的输出目录。恢复会验证身份，拒绝把不同版本的结果混在一起。

## 结论的边界

本次历史区间已经看过，回放是研究证据。新模型仍需使用方案冻结之后产生的新数据进行前向验证；完成历史训练不会自动部署。

当前 1 小时路径使用小时 K 线和每 6 小时的缓存预测，不能重建 Demo 的即时撮合、分钟扫描及历史盘口。共享执行原语和账户资金约束已复用，仍不等于完整 Demo 执行一致性。缓存还缺少每币最后 48 小时未成熟预测，包含退市尾部风险缺口。Chronos 神经网络权重保持不变。

## 15 分钟判断的研究训练

启用中的 `chronos-lightgbm-v1` 仍按 1h 推理。15m 重训另写目录，不替换 Demo 模型。15m 使用原生季度小时归档，禁止用 1h 升采样。Chronos 仍是 12 步，对应 3 小时；标签成熟 48 根（12 小时）；持有仍是 11 根源 K（约 2.75 小时）。

```powershell
cargo build --release --locked --bin nofx-ml-archive --bin nofx-ml-profit-train
pwsh -NoProfile -File scripts/collect-intraday-archive.ps1
pwsh -NoProfile -File scripts/train-profit-model.ps1 -Interval 15m -SkipBuild

# 两币冒烟
pwsh -NoProfile -File scripts/train-profit-model.ps1 -Interval 15m -SkipBuild -Symbols 'BTCUSDT,ETHUSDT' -OutputDir output/ml-profit-train-15m-smoke-20261017
```

默认数据 `data/ml/intraday-archive-20261017`，输出 `output/ml-profit-train-15m-20261017`。历史验收通过前不改 `planInterval`、Demo 扫描周期或现役模型目录。

相关材料：[改进方案](ml-profit-improvement-plan-20261016.md)、[上轮亏损诊断](../reports/ml-profit-diagnosis-20261016.md)。
