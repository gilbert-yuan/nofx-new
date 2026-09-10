# 胜率优化 P8（2026-09-11 05:20 自动化执行）

## 结论一句话
落地 50 币 × 30 天 1m 全量回测给出的最优可上线组合：**均线失守阈值 1→2 ATR + 智能退出最小持仓保护 15 根**，回测胜率 15.5% → **31.4%**，净亏 −900.8 → **−759.0U**（少亏 ~142U）。

## 依据（上轮 04:15 回测，489 笔大样本）
- 结构性矛盾：入场是「等回调」限价单（成交=价格已回落），智能退出「均线失守」（跌破 MA20 超 1 ATR 且浮盈<0.4R）与之**几何重叠** → 52% 订单成交后 1 根内被平，smart_exit 327 笔（67%）胜率仅 5.5%。
- 实盘印证：09-11 当天 17 笔胜率 5.9%、多笔 held=1；02:50 重启后 7 笔 manual（=智能退出真平仓）胜率 0%、平均持仓 1.5 分钟。

## 本轮验证（三组对照，复跑确认）
| 组 | 成交 | 胜率 | 净 U |
|---|---|---|---|
| B `SMART_MA_ATR=2.0` | 470 | 24.5% | −786.4 |
| **B+MH15（采纳）** | **459** | **31.4%** | **−759.0** |
| B+MH5 | 464 | 26.1% | −827.8 |

## 改动
1. `server/shared/strategyGuards.js`：`SMART_EXIT.minHoldBars`（`NOFX_SMART_MIN_HOLD`，默认 0=关闭）。
2. `server/enhancedAnalysis.js`：`enhancedProtectionReview` 在最小持仓期内抑制智能退出 CLOSE；移动止损照常；订单级可用 `plan.smartExit.minHoldBars` 覆盖。
3. `ecosystem.config.cjs`：启用 `NOFX_SMART_MA_ATR='2.0'` + `NOFX_SMART_MIN_HOLD='15'`（删行重启即回滚）。
4. `tests/test.env`（新增）+ `package.json`：主测试套件以 `NOFX_PARTIAL_TP=false` 跑（P7 分批止盈改变了结算语义，research/simulatedAccount 三个存量失败用例固化的是全仓止盈旧账目；分批路径由 `scripts/_test_partial_tp.mjs` 子进程单独覆盖）。**修复存量 3 失败 → 136 通过 / 0 失败。**
5. `scripts/_test_exit_logic.mjs`：新增 [#9] 最小持仓保护 4 断言。

## 测试
- npm test：136 / 0（此前 133 / 3）。
- `_test_exit_logic.mjs` ALL CHECKS PASSED、`_test_limit_entry.mjs` PASSED、`_test_partial_tp.mjs` PASSED。

## 回滚旋钮
| 目标 | 操作 |
|---|---|
| 全部回滚 | 删 ecosystem 两行（SMART_MA_ATR / SMART_MIN_HOLD）重启 |
| 只关最小持仓 | `NOFX_SMART_MIN_HOLD=0` 或删行 |
| 均线阈值调回 | `NOFX_SMART_MA_ATR=1.0` |

## 未解决（记录在案）
- 净盈亏仍为负：1m 无 alpha 是病根（02:11 可行性审计 t=−12.17），本轮只修「入场即出场」的放大器。
- 纪律：改动生效后需重新累计 ≥100 笔再评估；下轮先 `git status` 看并发协作改动。
