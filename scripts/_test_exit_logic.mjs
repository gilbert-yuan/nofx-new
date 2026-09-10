// 出场逻辑系统性重构回归测试（2026-09-10，Tasks #1-#8）
//
//   #1 移动止损「保本跳变」修复（R 口径渐进阶梯）
//   #2 智能退出三条规则口径统一（均线失守只砍浮盈<保护线的单；RSI/MACD 用 R 口径）
//   #3 初始止损口径抽成 RISK_RULE（数值保持 0.008）
//   #4 主止盈可达（2.5R）
//   #5 杠杆/保证金风险语义（共享 RISK_RULE + marginRiskPct）
//   #6 双引擎复核触发口径统一（localProtectionReview 改 R 口径）
//   #7 复核单调性以「历史最紧止损」为基准
//   #8 均线失守下沉到根级（tradingSimulator）
import {
  TRAILING_RULE, SMART_EXIT, RISK_RULE,
  computeTrailStop, planRiskUnit, profitRFrom, trailStepFor
} from '../server/shared/strategyGuards.js';
import { enhancedAnalysis, enhancedProtectionReview } from '../server/enhancedAnalysis.js';
import { localProtectionReview, applyPaperProtectionReview, tightestStop } from '../server/shared/protectionReview.js';
import { normalizePlan } from '../server/research.js';
import { createAccountSimulator } from '../server/tradingSimulator.js';

let failures = 0;
const ok = (cond, label, extra = '') => {
  if (cond) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ ${label} ${extra}`); failures++; }
};
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

// ── 公共几何：price=100，R=0.8（0.8%），ATR=0.2（R/4），符合 1m 实况 ────────────
const ENTRY = 100;
const R = 0.8;
const ATR = 0.2;

console.log('\n[#1] computeTrailStop：首次触发不得「保本跳变」');
{
  // 浮盈 0.4R → 0 档：跟踪 0.70R
  const close04 = ENTRY + 0.4 * R;                       // 100.32
  const t04 = computeTrailStop({ long: true, entry: ENTRY, close: close04, atr: ATR, riskUnit: R, profitR: 0.4, baseStop: ENTRY - R });
  ok(near(t04.stop, close04 - 0.70 * R, 1e-9), '0.4R 时止损 = close − 0.70R', `got ${t04.stop}`);
  ok(t04.stop < ENTRY, '0.4R 时止损仍在入场价之下（旧实现会跳到 entry+0.2ATR）', `got ${t04.stop}`);
  ok(t04.step.atR === 0, '0.4R 命中 0 档');

  // 浮盈 1.0R → 1 档：跟踪 0.50R，锁盈 0.30R（且不低于成本保本线）
  const close10 = ENTRY + 1.0 * R;
  const t10 = computeTrailStop({ long: true, entry: ENTRY, close: close10, atr: ATR, riskUnit: R, profitR: 1.0, baseStop: ENTRY - R });
  ok(near(t10.stop, close10 - 0.50 * R, 1e-9), '1.0R 时止损 = close − 0.50R', `got ${t10.stop}`);
  ok(t10.lockStop !== null && t10.lockStop > ENTRY, '1.0R 时锁盈位在入场价之上（成本线之上）', `lock=${t10.lockStop}`);
  ok(t10.stop > t04.stop, '阶梯单调：1.0R 止损紧于 0.4R');

  // 浮盈 2.0R → 2 档：跟踪 0.40R
  const close20 = ENTRY + 2.0 * R;
  const t20 = computeTrailStop({ long: true, entry: ENTRY, close: close20, atr: ATR, riskUnit: R, profitR: 2.0, baseStop: t10.stop });
  ok(near(t20.stop, close20 - 0.40 * R, 1e-9), '2.0R 时止损 = close − 0.40R', `got ${t20.stop}`);
  ok(trailStepFor(2.0).lockR === 0.80, '2.0R 命中 2 档（锁盈 0.8R）');

  // 单调性：浮盈回落到 0 时不得放松止损
  const back = computeTrailStop({ long: true, entry: ENTRY, close: close10, atr: ATR, riskUnit: R, profitR: 0, baseStop: t20.stop });
  ok(near(back.stop, t20.stop, 1e-9), '浮盈回落时止损保持历史最紧值（单调只紧不松）', `got ${back.stop}`);

  // 反转保护：baseStop 被异常抬高到现价之上 → reversed
  const bad = computeTrailStop({ long: true, entry: ENTRY, close: ENTRY + 0.1, atr: ATR, riskUnit: R, profitR: 0.1, baseStop: ENTRY + 5 });
  ok(bad.reversed === true, '止损越过现价时 reversed=true（调用方应保持原值）');

  // 空头镜像
  const s = computeTrailStop({ long: false, entry: ENTRY, close: ENTRY - 0.4 * R, atr: ATR, riskUnit: R, profitR: 0.4, baseStop: ENTRY + R });
  ok(near(s.stop, ENTRY - 0.4 * R + 0.70 * R, 1e-9) && s.reversed === false, '空头 0.4R 止损 = close + 0.70R', `got ${s.stop}`);
}

console.log('\n[#3/#5] 共享常量与 R 辅助函数');
{
  ok(near(RISK_RULE.minStopPct, 0.008, 1e-12), 'RISK_RULE.minStopPct 保持 0.008（成本结构所迫，未放宽）');
  ok(RISK_RULE.maxLeverage === 5, 'RISK_RULE.maxLeverage = 5');
  const plan = { entryMin: 99.5, entryMax: 100.5, entryLimit: 99.8, stopLoss: 99.0 };
  ok(near(planRiskUnit(plan, 'long'), 0.8, 1e-9), 'planRiskUnit 以 entryLimit 为锚 = 0.8');
  ok(near(planRiskUnit({ riskUnit: 1.23, stopLoss: 99 }, 'long'), 1.23, 1e-9), 'plan.riskUnit 固化值优先');
  ok(near(profitRFrom({ long: true, entry: 100, close: 100.4, riskUnit: 0.8 }), 0.5, 1e-9), 'profitRFrom 多头 0.5R');
}

console.log('\n[#2] 智能退出口径统一');
{
  ok(near(SMART_EXIT.maExitMaxProfitR, TRAILING_RULE.triggerR, 1e-12), '均线失守门槛 = 移动止损触发线（同一阈值）');
  ok(SMART_EXIT.tpMinR === 2.0, 'RSI/MACD 门槛改为 R 口径 2.0R（不再硬编码 5%）');

  // 均线失守：浮盈 −0.375R（< 保护线）→ CLOSE
  const calm = calmRows(30, ENTRY, ATR);
  calm[calm.length - 1] = bar(99.7, 99.7 + 0.1, 99.6, 99.7);
  const order = mkOrder();
  const r1 = enhancedProtectionReview(order, { klines: calm });
  ok(r1.action === 'CLOSE' && /均线失守/.test(r1.reason), '浮亏+均线失守 → CLOSE', JSON.stringify(r1).slice(0, 120));

  // 已走出保护空间（浮盈 ≥ 保护线）：即使跌破均线也不由均线规则砍（交给移动止损）
  const calm2 = calmRows(30, ENTRY, ATR);
  calm2[calm2.length - 1] = bar(ENTRY + 1.0 * R, ENTRY + 1.0 * R + 0.05, ENTRY + 0.7, ENTRY + 1.0 * R);
  const order2 = mkOrder();
  const r2 = enhancedProtectionReview(order2, { klines: calm2 });
  ok(r2.action === 'UPDATE_PROTECTION', '浮盈 1.0R 时由移动止损接管（非 CLOSE）', `action=${r2.action}`);
}

console.log('\n[#1] enhancedProtectionReview 不再发生保本跳变');
{
  const rows = calmRows(30, ENTRY, ATR);
  rows[rows.length - 1] = bar(ENTRY + 0.4 * R, ENTRY + 0.4 * R + 0.05, ENTRY + 0.1, ENTRY + 0.4 * R);
  const r = enhancedProtectionReview(mkOrder(), { klines: rows });
  ok(r.action === 'UPDATE_PROTECTION', '浮盈 0.4R 触发移动止损', `action=${r.action} reason=${r.reason}`);
  ok(r.stopLoss < ENTRY, '新止损仍在入场价之下（旧实现 = entry+0.2ATR ≈ 100.04）', `got ${r.stopLoss}`);
  ok(near(r.stopLoss, ENTRY + 0.4 * R - 0.70 * R, 1e-6), '止损 = close − 0.70R', `got ${r.stopLoss}`);
  ok(r.takeProfit > 100, '顺势扩盈：止盈只放宽不收窄');
}

console.log('\n[#6] localProtectionReview 触发口径改 R');
{
  const rows = calmRows(20, ENTRY, ATR);
  // 浮盈 0.15R（旧口径 0.15% < 2% → HOLD；新口径 0.15R < 0.4R → 也是 HOLD）
  rows[rows.length - 1] = bar(ENTRY + 0.15, ENTRY + 0.2, ENTRY + 0.05, ENTRY + 0.15);
  const hold = localProtectionReview(mkOrder(), { klines: rows });
  ok(hold.action === 'HOLD', '浮盈 0.15R 未达 0.4R → HOLD', `action=${hold.action}`);

  // 浮盈 0.44R（旧口径 0.35% < 2% 会 HOLD；新口径生效）→ UPDATE_PROTECTION
  const rows2 = calmRows(20, ENTRY, ATR);
  rows2[rows2.length - 1] = bar(ENTRY + 0.35, ENTRY + 0.4, ENTRY + 0.2, ENTRY + 0.35);
  const upd = localProtectionReview(mkOrder(), { klines: rows2 });
  ok(upd.action === 'UPDATE_PROTECTION', '浮盈 0.44R 即触发保护（旧实现要 2%）', `action=${upd.action}`);
  ok(upd.stopLoss < ENTRY, '本地引擎止损同样不跳变', `got ${upd.stopLoss}`);
}

console.log('\n[#7] 复核单调性以「历史最紧止损」为基准');
{
  const order = mkOrder();
  order.initialPlan = { stopLoss: 99.2, takeProfit: 102 };
  order.protectionRevisions = [{ stopLoss: 99.5, takeProfit: 102 }, { stopLoss: 99.7, takeProfit: 102 }];
  order.plan = { stopLoss: 99.7, takeProfit: 102, riskUnit: R };
  order.markPrice = ENTRY + 0.3;
  ok(near(tightestStop(order, true), 99.7, 1e-9), 'tightestStop 多头取历史最大 = 99.7');
  const shortOrder = { direction: 'OPEN_SHORT', entry: ENTRY, plan: { stopLoss: 100.4 }, initialPlan: { stopLoss: 100.9 }, protectionRevisions: [{ stopLoss: 100.6 }] };
  ok(near(tightestStop(shortOrder, false), 100.4, 1e-9), 'tightestStop 空头取历史最小 = 100.4');

  // 放宽止损的建议必须被拒（即使 order.plan.stopLoss 恰好更松，也不会被当作基准）
  const loosen = { direction: 'OPEN_LONG', status: 'open', entry: ENTRY, markPrice: ENTRY + 0.3, interval: '1m',
    plan: { stopLoss: 99.7, takeProfit: 102 }, initialPlan: { stopLoss: 99.2, takeProfit: 102 },
    protectionRevisions: [{ stopLoss: 99.5 }, { stopLoss: 99.7 }], error: null, reviewHistory: [] };
  loosen.markAt = new Date(Math.floor(Date.now() / 60000) * 60000).toISOString();
  const rep = applyPaperProtectionReview(loosen, { action: 'UPDATE_PROTECTION', stopLoss: 99.4, takeProfit: 102.5, confidence: 0.8 });
  ok(rep.action === 'held', '放宽止损的建议被拒（action=held）', `action=${rep.action} reason=${rep.reason}`);
}

console.log('\n[#8] 根级均线失守（tradingSimulator）');
{
  const now = 60000 * Math.ceil(Date.now() / 60000);
  const first = now + 60000;
  const rows = [];
  // 前 25 根平静在 100（MA20=100，ATR≈0.2）
  for (let i = 0; i < 25; i++) rows.push(kline(first + i * 60000, 100, 100.1, 99.9, 100));
  // 第 26 根：触达 entryLimit=100 成交
  rows.push(kline(first + 25 * 60000, 100, 100.1, 99.85, 100));
  // 第 27 根：不带未来数据地跌破 MA20 且偏离 > 1 ATR，而止损（99.2）未被触及
  rows.push(kline(first + 26 * 60000, 100, 100, 99.6, 99.7));

  const market = { symbol: 'TESTUSDT', interval: '1m', dataAsOf: new Date(now).toISOString(), klines: rows };
  const plan = {
    entryMin: 99.5, entryMax: 100.5, entryLimit: 100, stopLoss: 99.2, takeProfit: 102,
    validForBars: 0, maxHoldBars: 120, riskUnit: R,
    smartExit: { barLevel: true, maPeriod: 20, maBreakAtr: 1.0, maExitMaxProfitR: 0.4 }
  };
  const rec = normalizePlan(
    { positionRecommendation: 'OPEN_LONG', action: 'BUY', confidence: 0.8, reason: '', risk: '', plan },
    market, now);
  ok(rec.eligible === true, 'normalizePlan 保留 riskUnit/smartExit 后仍合法', JSON.stringify(rec.validationIssues));
  ok(near(rec.plan.riskUnit, R, 1e-9), 'normalizePlan 透传 riskUnit（此前会被静默丢弃）');
  ok(rec.plan.smartExit && rec.plan.smartExit.barLevel === true, 'normalizePlan 透传 smartExit');
  ok(rec.plan.takeProfit1 === undefined || typeof rec.plan.takeProfit1 === 'number', 'takeProfit1/2/3 可选透传不报错');

  const r = createAccountSimulator().evaluate(rec, rows, rows.at(-1).openTime + 60000);
  ok(r.status === 'closed' && r.reason === 'smart_exit_ma', '根级均线失守平仓（reason=smart_exit_ma）', `status=${r.status} reason=${r.reason}`);
  ok(Number.isFinite(r.exit) && r.exit < 100, '平仓价取当根收盘（99.7 附近）', `exit=${r.exit}`);

  // 关闭根级开关后应回落到 hold（不再于该根平仓）
  const rec2 = normalizePlan(
    { positionRecommendation: 'OPEN_LONG', action: 'BUY', confidence: 0.8, reason: '', risk: '', plan: { ...plan, smartExit: { ...plan.smartExit, barLevel: false } } },
    market, now);
  const r2 = createAccountSimulator().evaluate(rec2, rows, rows.at(-1).openTime + 60000);
  ok(r2.status !== 'closed' || r2.reason !== 'smart_exit_ma', 'NOFX_SMART_EXIT_BAR_LEVEL=false 时不根级平仓', `status=${r2.status} reason=${r2.reason}`);
}

console.log('\n[#9] 最小持仓保护（P8：入场 N 根内禁智能退出 CLOSE）');
{
  // 均线失守场景（浮亏 + 跌破 MA20 超 1 ATR）——默认无 minHoldBars 时必 CLOSE（见 #2）
  const calm = calmRows(30, ENTRY, ATR);
  calm[calm.length - 1] = bar(99.7, 99.7 + 0.1, 99.6, 99.7);

  const inHold = { ...mkOrder(), heldBars: 3, plan: { ...mkOrder().plan, smartExit: { minHoldBars: 15 } } };
  const rIn = enhancedProtectionReview(inHold, { klines: calm });
  ok(rIn.action !== 'CLOSE', 'heldBars=3 < 15 → 智能退出被抑制', `action=${rIn.action}`);

  const afterHold = { ...mkOrder(), heldBars: 16, plan: { ...mkOrder().plan, smartExit: { minHoldBars: 15 } } };
  const rAfter = enhancedProtectionReview(afterHold, { klines: calm });
  ok(rAfter.action === 'CLOSE' && /均线失守/.test(rAfter.reason), 'heldBars=16 ≥ 15 → 智能退出恢复生效', `action=${rAfter.action}`);

  // 保护期内移动止损仍要正常工作：浮盈 0.4R → UPDATE_PROTECTION（而非 HOLD）
  const rows04 = calmRows(30, ENTRY, ATR);
  rows04[rows04.length - 1] = bar(ENTRY + 0.4 * R, ENTRY + 0.4 * R + 0.05, ENTRY + 0.1, ENTRY + 0.4 * R);
  const rTrail = enhancedProtectionReview({ ...inHold, markPrice: ENTRY + 0.4 * R }, { klines: rows04 });
  ok(rTrail.action === 'UPDATE_PROTECTION', '保护期内移动止损照常生效（0.4R → UPDATE_PROTECTION）', `action=${rTrail.action}`);

  // 无 plan.smartExit.minHoldBars 的旧订单走全局默认 0 → 行为不变
  const legacy = enhancedProtectionReview(mkOrder(), { klines: calm });
  ok(legacy.action === 'CLOSE', '旧订单（无 plan.smartExit.minHoldBars）行为不变（全局默认关闭）', `action=${legacy.action}`);
}

console.log('\n[集成] enhancedAnalysis 计划携带 R 基准 / smartExit / marginRiskPct');
{
  // 「上升通道 + 正弦回踩」的合成行情：能通过增强引擎的全部闸门（评分/RR/RSI/追高过滤）。
  // 参数是搜索得到的（slope 0.06 / amp 1.6 / period 26 / phase 16）——直线拉升会被「追高过滤」挡掉。
  const rows = syntheticTrendRows(180, { slope: 0.06, amp: 1.6, period: 26, phase: 16 });
  const market = { symbol: 'TESTUSDT', interval: '1m', dataAsOf: new Date().toISOString(), klines: rows,
    marketProvider: 'binance' };
  let sig;
  try { sig = enhancedAnalysis(market); } catch (e) { sig = { action: 'ERR', error: e.message }; }
  console.log(`    action=${sig.action} score=${sig.plan?.trendStrengthScore ?? '-'} leverage=${sig.plan?.recommendedLeverage ?? '-'} marginRiskPct=${sig.plan?.marginRiskPct !== undefined ? (sig.plan.marginRiskPct * 100).toFixed(2) + '%' : '-'}`);
  ok(sig.action !== 'ERR', 'enhancedAnalysis 不抛异常', sig.error || '');
  ok(sig.action === 'BUY' && !!sig.plan, '合成强趋势行情能正常出单（未被新参数挡死）', `action=${sig.action} reason=${String(sig.reason).slice(0, 60)}`);
  if (sig.plan) {
    ok(sig.plan.riskUnit > 0, 'plan.riskUnit > 0', `got ${sig.plan.riskUnit}`);
    ok(sig.plan.smartExit && sig.plan.smartExit.maPeriod === 20, 'plan.smartExit 已写入');
    ok(sig.plan.marginRiskPct > 0 && sig.plan.marginRiskPct <= 1, 'plan.marginRiskPct 为真实保证金风险', `got ${sig.plan.marginRiskPct}`);
    ok(sig.plan.recommendedLeverage >= 1 && sig.plan.recommendedLeverage <= RISK_RULE.maxLeverage, '杠杆在 [1, maxLeverage] 内', `got ${sig.plan.recommendedLeverage}`);
    ok(sig.plan.marginRiskPct <= RISK_RULE.riskBudgetPct + 1e-9, '真实保证金风险不超预算（语义自洽）', `marginRiskPct=${sig.plan.marginRiskPct}`);
    // #4：主止盈 = entryMax + 3.0R（受 RR 闸门约束的下界约 2.875R，取 3.0 留余量）
    const expectedTp = sig.plan.entryMax + 3.0 * sig.plan.riskUnit;
    const nearTp = Math.abs(sig.plan.takeProfit - expectedTp) / expectedTp;
    console.log(`    takeProfit=${sig.plan.takeProfit.toFixed(4)} 期望(3.0R)≈${expectedTp.toFixed(4)} 偏差=${(nearTp * 100).toFixed(2)}%`);
    ok(nearTp < 0.02, '主止盈 = entryMax + 3.0R（SR 未收窄时）', `偏差 ${(nearTp * 100).toFixed(2)}%`);
    // RR 闸门必须仍然可满足（否则 2.5R 那次把系统搞停摆的坑会重演）
    ok(sig.plan.riskRewardRatio >= 2.5, '入场 RR 闸门仍可满足（未因下调止盈而停摆）', `RR=${sig.plan.riskRewardRatio}`);
  } else {
    console.log('    （合成行情未出信号，跳过计划字段断言）');
  }
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

// ───────────────────────────── 工具 ─────────────────────────────
function bar(close, high = close + 0.05, low = close - 0.05, open = close) {
  return { open, high: Math.max(high, open, close), low: Math.min(low, open, close), close, volume: 1000 };
}
function kline(openTime, open, high, low, close, volume = 1000) {
  return { openTime, open, high, low, close, volume };
}
function calmRows(n, price, atr) {
  const half = atr / 2;
  const rows = [];
  for (let i = 0; i < n; i++) rows.push(bar(price, price + half, price - half, price));
  return rows;
}
/** 上升通道 + 正弦回踩：既能给趋势评分，又不会触发「追高过滤」。 */
function syntheticTrendRows(n, { start = 100, slope = 0.06, amp = 1.6, period = 26, phase = 0, vol = 1200 } = {}) {
  const rows = [];
  let prev = start;
  for (let i = 0; i < n; i++) {
    const close = start + slope * i + amp * Math.sin((i + phase) / period * 2 * Math.PI);
    const open = prev;
    const range = 0.35 + 0.25 * Math.abs(Math.sin(i * 0.7));
    rows.push({
      openTime: 1700000000000 + i * 60000,
      open, close,
      high: Math.max(open, close) + range,
      low: Math.min(open, close) - range,
      volume: vol + (i % 9) * 55
    });
    prev = close;
  }
  return rows;
}
function mkOrder() {
  return {
    direction: 'OPEN_LONG',
    entry: ENTRY,
    plan: { stopLoss: ENTRY - R, takeProfit: ENTRY + 2.5 * R, riskUnit: R },
    costs: { feeBps: 6, slippageBps: 5 }
  };
}
function mkOrderShort() {
  return {
    direction: 'OPEN_SHORT',
    entry: ENTRY,
    plan: { stopLoss: ENTRY + R, takeProfit: ENTRY - 2.5 * R, riskUnit: R },
    costs: { feeBps: 6, slippageBps: 5 }
  };
}
