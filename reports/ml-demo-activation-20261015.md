# Binance Demo 模型自动执行验收

2026-10-15，用户明确选择「按现有 Binance Demo 配置自动交易」后，关闭主 API 的研究运行模式，启用 `chronos-lightgbm-v1`。模型历史评估文件未修改。

## 本次运行

- 工作台与主 API：<http://127.0.0.1:3101>，Rust 服务 PID `219084`。
- 预测器：`127.0.0.1:18084`，PID `170632`，`live_public` 模式。
- 17:06:01（UTC+8）启动原生自动任务，`operating_mode:demo_auto`、`research_mode:false`、`active:true`。
- 只启用模型策略，既有七个策略的新增交易开关关闭，参数和旧订单保留。配置修改前已在 `data/backups/` 备份。
- `syncPaperOrdersToDemo:true`，`syncPaperOrdersToLive:false`；实盘账户未启用，模型执行也有 Demo 环境硬限制。
- 默认每轮扫描 20 个币种，本轮符合训练清单、交易状态与成交额条件的交集是 244 个，后续轮转。每轮最多新增一单。
- 当前进程每 10 秒进行模型持仓复核；账户同步循环在每次请求结束后等待 15 秒再重试。

重启旧服务的组合命令被自动审批拒绝，返回原因为 `blocked by policy`。因此保留 3100 的旧进程，并在 3101 启动新构建；启用前确认旧实例自动任务停止。请使用 3101 查看本次运行。新进程启动时设置 `NOFX_AUTOSTART=false`，检查配置和账户后再通过原生 API 启动自动任务。

## 首轮结果与限制

首轮在 17:10:45 完成：20 个币种成功取得模型预测，创建 1 笔本地模型订单，确认提交数为 0。该轮存在账户更新排队超时，以及 WAL 公共行情连接超时；行情失败未使用冻结数据回退。

ENAUSDT 订单 `94507e64-f33c-4d96-ab2e-2548676c5ce1` 为待处理状态，名义金额 50 USDT、1 倍杠杆。首轮记录的 Demo 同步状态为 `not_submitted`，原因为账户更新排队超时。创建记录不代表交易所已接受或成交，后续状态以账户及自动化页面为准。

Demo 签名只读账户同步曾成功，当前资金和占用检查通过后才生成订单；运行期间也发生间歇连接错误和资金快照过期。系统在这些阶段拦截开仓并继续自动重试，没有放宽时效或对账规则。

部分已平仓历史成交明细不完整，`accountingComplete:false`。当前持仓、成交收益同步、资金占用和开仓许可由现有共享资金池检查；当前持仓对账异常继续阻止执行。UI 展示历史完整性提示。

本次沿用已有训练结果。样本外回放亏损，历史模型评估仍为 `research_only`；Demo 运行开关不会改变评估结论。Chronos 权重未更新，已有适配是预测校准。

## 风控与验证

模型订单复用原生 Rust 成交、费用、账户锁、保护单和出场实现。按共享账户权益约束单笔止损预算最多 1%，名义金额最多 50 USDT 且不超过权益 20%，固定 1 倍杠杆；止损 2 ATR、止盈 5 ATR，沿用共享出场规则。共享模型账本记录当日 3% 亏损暂停和 10% 最大回撤拦截，跨进程重启保留。

创建订单及首次发送前均重新检查，禁止保护价格覆盖、重复小时信号、同币种占用与实盘路由。Demo 持仓复核仅处理模型订单，账户检查仍覆盖其他策略与外部持仓。

- `cargo fmt --check`：通过。
- `cargo check --all-targets`：通过。
- `cargo test --all-targets`：234 通过、0 失败、7 个仓库标记忽略的用例未运行。
- `cargo build --locked --bin nofx-server`：通过。
- `npm run build`：通过，65 个模块。
- 浏览器实测：ETH 最新闭合小时预测、LightGBM 偏空分类、2 ATR 止损/5 ATR 止盈、Demo 仓位、账户权益和历史成交提示均可见。

运行二进制 SHA-256：`358d94642624f8cf107da3c754759119e17b6d53aef18c3355ee4ae75838f946`。

训练 manifest、训练报告、采集 manifest 的 SHA-256 与前轮记录一致，分别为 `a0c8572868debc30b7d2eb3d6f4eeff670515e56c0d95664a363d0cd74df0345`、`d639c908f2cac90118551517a4599be2a6669cd3b9fe7fd4bd971bc5fd87e290`、`d01cb4605d996f9dd6080bea19f768b439c8b6a967d57be7b9626e8003c9f337`。

## 证据与操作

本机验收快照保存在 `data/ml/demo-service-20261015/evidence/`：

- `server-provenance.json`：进程、端口与二进制哈希。
- `demo-configuration.json`：不含密钥的模式和策略配置。
- `demo-account-activation.json`、`demo-activation.json`：账户检查及任务启动。
- `demo-runtime.json`、`demo-health.json`：首轮与运行快照。
- `model-order-verification.json`：模型订单、保护价格及 Demo 状态。
- `final-status.json`：17:14:45 的最终核对；自动任务继续运行，ENA 仍未提交，当前账户同步未就绪。
- `verification.json`：构建、测试和差异检查结果。
- `demo-workbench.jpg`：工作台截图。

快照表示采集时刻，运行中的自动任务会继续改变账户与执行状态。需要停止自动任务时调用 `POST http://127.0.0.1:3101/api/automation/stop`；交易所已有订单及保护单仍需按账户实际状态处理。

配置与实现说明见[模型交易链路](../docs/ml-trading-pipeline.md)。
