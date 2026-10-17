# 净收益模型训练启动记录

本轮后台任务已于 **2026-10-16 23:25:36（UTC+8）** 启动。23:31 检查时，编排进程 `246640` 和 Rust 训练进程 `242140` 均在运行，心跳正常，873 个合约的缓存收益样本已全部加载，正在加载共享账户回放行情。

训练固定比较 60 / 90 天窗口以及保留 / 去掉 Chronos 特征的 4 个候选。主候选预先确定为 `90d-with-chronos`。每个方向分别训练 LightGBM 净收益回归模型，按周更新，使用独立的滚动样本外预测校准与选择门槛，再在同一个 1,000 USDT 账户内连续回放最后 4 周。Chronos 使用已校验的推理缓存，本轮不微调其神经网络权重。

启动前验证已完成：

- `cargo fmt --check`、`cargo check --all-targets --locked` 通过。
- `cargo test --all-targets --locked`：308 项通过，10 项忽略；另行显式运行的 4 项原生 LightGBM 兼容性测试全部通过。
- BTC、ETH、0G 和已退出评估区间的 AERGO 四币端到端试跑完成全部 4 个候选；该试跑只验证流程，不代表盈利结果。
- Release 可执行文件已构建并冻结到任务输出目录；当前 Demo 配置、策略及模型文件哈希保持不变。

完整训练尚未完成，暂时没有本轮收益结论。最终结果仍属于历史研究，候选不会自动替换 Demo 模型；需要用方案冻结之后的新数据做前向验证。

运行资料：

- [实时工作流状态](../output/ml-profit-train-20261016/workflow-status.json)
- [原生训练阶段](../output/ml-profit-train-20261016/training-status.json)
- [冻结协议](../output/ml-profit-train-20261016/run-config.json)
- [启动验证证据](../data/ml/profit-train-verification-20261016/verification.json)
- [完整训练说明与恢复方法](../docs/ml-profit-training.md)

此文件记录启动时快照；当前阶段以实时状态文件为准。
