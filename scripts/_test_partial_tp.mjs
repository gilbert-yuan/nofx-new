// 分批止盈（Partial Take Profit）回归测试（2026-09-11）
//
// 背景：主止盈 3.0R 与样本平均最大浮盈 MFE ≈ 1.9R 存在结构性缺口，3R 几乎从不兑现。
// 本测试锁死分批止盈的六项关键性质：
//   1. 档位计算（R 口径、以实际成交价为基准、丢弃不早于主止盈的档）
//   2. 触发与比例（TP1 平 40% / TP2 平 40% / 剩余 20% 奔主止盈）
//   3. 入场费按比例分摊（各批份额 + 剩余份额 = 1，不重复计也不漏计）
//   4. TP1 后剩余仓位止损抬到净保本线（把单锁成无风险）
//   5. 跨轮续跑（tpStage / realized* 从 order 恢复，不重复平同一批）
//   6. 关闭开关后行为完全不变（全仓等主止盈）
//
// 用法：
//   node scripts/_test_partial_tp.mjs
//     → 跑启用场景，并自动拉起一个 NOFX_PARTIAL_TP=false 的子进程验证关闭场景。
//   NOFX_PARTIAL_TP=false node scripts/_test_partial_tp.mjs
//     → 只跑关闭场景（子进程模式，由主进程拉起）。
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PARTIAL_TP, partialTpLevels, netBreakEvenBps } from '../server/shared/strategyGuards.js';
import { createAccountSimulator } from '../server/tradingSimulator.js';
import { normalizePlan } from '../server/research.js';
import { settlePaperOrder } from '../server/simulatedAccount.js';

let failures = 0;
const ok = (cond, label, extra = '') => {
  if (cond) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ ${label} ${extra}`); failures++; }
};
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

// ── 公共几何：entry 区 100，R = 0.8，主止盈 102.9 ────────────────────────────
const R = 0.8;
const ENTRY_LIMIT = 100;
const STOP = 99.2;
const MAIN_TP = 102.9;
const SLIP = 5 / 10000;
// 限价挂单成交价 = entryLimit × (1 + slippageBps/10000)（多头）
const ENTRY = ENTRY_LIMIT * (1 + SLIP);          // 100.05
const NOTIONAL = 10;
const QTY = NOTIONAL / ENTRY;                    // ≈ 0.09995
const ENTRY_FEE = NOTIONAL * 6 / 10000;          // 0.006

const OFF = process.env.NOFX_PARTIAL_TP === 'false';

function kline(openTime, open, high, low, close, volume = 1000) {
  return { openTime, open, high, low, close, volume };
}

/** 前 25 根平静横盘（MA20=100、ATR≈0.2），保证指标有效且不触发任何出场。 */
function baseRows(first) {
  const rows = [];
  for (let i = 0; i < 25; i++) rows.push(kline(first + i * 60000, 100, 100.1, 99.9, 100));
  return rows;
}

function makePlan(extra = {}) {
  return {
    entryMin: 99.5, entryMax: 100.5, entryLimit: ENTRY_LIMIT, stopLoss: STOP, takeProfit: MAIN_TP,
    validForBars: 0, maxHoldBars: 120, riskUnit: R, ...extra
  };
}

/** 构造一份通过了 normalizePlan 校验的分析记录（含 firstEntryAt）。 */
function makeRec(rows, now) {
  const market = { symbol: 'TESTUSDT', interval: '1m', dataAsOf: new Date(now).toISOString(), klines: rows };
  return normalizePlan(
    { positionRecommendation: 'OPEN_LONG', action: 'BUY', confidence: 0.8, reason: '', risk: '', plan: makePlan() },
    market, now);
}

const report = () => {
  console.log(failures ? `\n❌ ${failures} 项失败` : '\n✅ 全部通过');
  process.exit(failures ? 1 : 0);
};

// ═══════════════════════════════════════════════════════════════════════════
// 关闭场景（子进程）：NOFX_PARTIAL_TP=false
// ═══════════════════════════════════════════════════════════════════════════
if (OFF) {
  console.log('\n[子进程] NOFX_PARTIAL_TP=false：行为必须完全不变');

  ok(PARTIAL_TP.enabled === false, 'PARTIAL_TP.enabled=false');
  ok(partialTpLevels({ long: true, entry: ENTRY, riskUnit: R, mainTakeProfit: MAIN_TP }).length === 0,
    'partialTpLevels 返回空档位');

  const now = 60000 * Math.ceil(Date.now() / 60000);
  const first = now + 60000;
  const rows = baseRows(first);
  rows.push(kline(first + 25 * 60000, 100, 100.1, 99.85, 100));        // 成交
  rows.push(kline(first + 26 * 60000, 100, 100.95, 99.95, 100.6));     // 越过 TP1 区
  rows.push(kline(first + 27 * 60000, 100.6, 101.75, 100.6, 101.5));   // 越过 TP2 区
  rows.push(kline(first + 28 * 60000, 101.5, 103.0, 101.5, 102.9));    // 主止盈

  const rec = makeRec(rows, now);
  const r = createAccountSimulator().evaluate(rec, rows, rows.at(-1).openTime + 60000);

  ok(r.status === 'closed' && r.reason === 'take_profit', '仍在主止盈一次性平仓', `status=${r.status} reason=${r.reason}`);
  ok((r.partialFills || 0) === 0, 'partialFills=0（未发生分批）', `got ${r.partialFills}`);
  // 全仓在主止盈平掉 vs 分批：分批的平均出场价更低，故关闭时净盈亏应更高
  ok(Number.isFinite(r.net) && r.net > 0, '关闭分批时净盈亏为正', `net=${r.net}`);
  console.log(`    关闭分批 net=${r.net.toFixed(6)}（供与启用场景对照）`);
  report();
}

// ═══════════════════════════════════════════════════════════════════════════
// 子进程 B：NOFX_TP_BREAKEVEN=true（验证保本抬升这条路本身是对的）
// ═══════════════════════════════════════════════════════════════════════════
if (process.env.NOFX_TP_BREAKEVEN === 'true') {
  console.log('\n[子进程B] NOFX_TP_BREAKEVEN=true：TP1 后止损抬保本');

  ok(PARTIAL_TP.moveStopToBreakEven === true, 'moveStopToBreakEven=true');

  const now = 60000 * Math.ceil(Date.now() / 60000);
  const first = now + 60000;
  const rows = baseRows(first);
  rows.push(kline(first + 25 * 60000, 100, 100.1, 99.85, 100));        // 成交
  // 本根 low 必须高于保本线(≈100.31)，否则 TP1 与保本止损会撞在同一根，
  // 出场价会被 _checkExit 取 min(open, 止损) 拉到 open 上，测不到保本位。
  rows.push(kline(first + 26 * 60000, 100.5, 100.95, 100.45, 100.7));  // 触及 TP1，平 40%
  rows.push(kline(first + 27 * 60000, 100.6, 100.7, 100.20, 100.25));  // 回撤击穿保本线

  const rec = makeRec(rows, now);
  const r = createAccountSimulator().evaluate(rec, rows, rows.at(-1).openTime + 60000);

  const costDist = ENTRY * netBreakEvenBps({ feeBps: 6, slippageBps: 5 }) / 10000;
  const beStop = ENTRY + costDist;
  ok(r.status === 'closed' && r.reason === 'stop_loss', '保本线被回撤击穿，以止损收场', `status=${r.status} reason=${r.reason}`);
  ok(near(r.exit, beStop * (1 - SLIP), 1e-9), '出场价 = 净保本线（而非初始止损 99.2）',
    `exit=${r.exit} 保本=${beStop}`);
  ok(r.partialFills === 1, '只成交了 TP1 一批', `got ${r.partialFills}`);
  ok(r.net > 0, '虽然以止损收场，净盈亏仍为正（TP1 已把利润落袋）', `net=${r.net}`);
  console.log(`    保本线=${beStop.toFixed(5)} exit=${Number(r.exit).toFixed(5)} net=${Number(r.net).toFixed(6)}`);
  report();
}

// ═══════════════════════════════════════════════════════════════════════════
// 主套件：分批止盈启用
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[1] 档位计算（R 口径、以实际成交价为基准）');
{
  ok(PARTIAL_TP.enabled === true, 'PARTIAL_TP 默认启用（回滚：NOFX_PARTIAL_TP=false）');
  const levels = partialTpLevels({ long: true, entry: ENTRY, riskUnit: R, mainTakeProfit: MAIN_TP });
  ok(levels.length === 2, '返回两档', `got ${levels.length}`);
  ok(near(levels[0].price, ENTRY + PARTIAL_TP.tp1R * R, 1e-9), 'TP1 = entry + tp1R×R', `got ${levels[0]?.price}`);
  ok(near(levels[1].price, ENTRY + PARTIAL_TP.tp2R * R, 1e-9), 'TP2 = entry + tp2R×R', `got ${levels[1]?.price}`);
  ok(levels[0].price < levels[1].price && levels[1].price < MAIN_TP, '档位严格递增且早于主止盈');
  ok(near(levels[0].closePct + levels[1].closePct, 0.8, 1e-9), '两批合计 80%，留 20% 奔跑仓');

  // 主止盈比 TP2 还近 → TP2 永远轮不到，应被丢弃
  const trimmed = partialTpLevels({ long: true, entry: ENTRY, riskUnit: R, mainTakeProfit: ENTRY + 1.5 * R });
  ok(trimmed.length === 1 && trimmed[0].stage === 1, '主止盈更近时丢弃 TP2（避免死分支）', `got ${trimmed.length}`);

  // 空头镜像：档位在下方
  const short = partialTpLevels({ long: false, entry: ENTRY, riskUnit: R, mainTakeProfit: ENTRY - 3 * R });
  ok(short.length === 2 && near(short[0].price, ENTRY - PARTIAL_TP.tp1R * R, 1e-9), '空头档位在入场价下方',
    `got ${short[0]?.price}`);

  // R 无效时不得产出档位
  ok(partialTpLevels({ long: true, entry: ENTRY, riskUnit: NaN, mainTakeProfit: MAIN_TP }).length === 0,
    'riskUnit 无效时返回空档位');
}

console.log('\n[2] 完整分批：TP1 → TP2 → 剩余奔主止盈');
let oneShot = null;
{
  const now = 60000 * Math.ceil(Date.now() / 60000);
  const first = now + 60000;
  const rows = baseRows(first);
  rows.push(kline(first + 25 * 60000, 100, 100.1, 99.85, 100));        // 限价成交
  rows.push(kline(first + 26 * 60000, 100, 100.95, 99.95, 100.6));     // 触及 TP1(100.85)
  rows.push(kline(first + 27 * 60000, 100.6, 101.75, 100.6, 101.5));   // 触及 TP2(101.65)
  rows.push(kline(first + 28 * 60000, 101.5, 103.0, 101.5, 102.9));    // 触及主止盈

  const rec = makeRec(rows, now);
  const r = createAccountSimulator().evaluate(rec, rows, rows.at(-1).openTime + 60000);
  oneShot = { rec, rows, r, now };

  ok(r.status === 'closed' && r.reason === 'take_profit', '最终在主止盈收尾', `status=${r.status} reason=${r.reason}`);
  ok(r.partialFills === 2, 'partialFills=2（TP1 + TP2 各一批）', `got ${r.partialFills}`);

  // 手算期望：三批分别按各自档位价成交，各批入场费按份额分摊
  const p1 = (ENTRY + PARTIAL_TP.tp1R * R) * (1 - SLIP);
  const p2 = (ENTRY + PARTIAL_TP.tp2R * R) * (1 - SLIP);
  const p3 = MAIN_TP * (1 - SLIP);
  const q1 = QTY * PARTIAL_TP.tp1ClosePct, q2 = QTY * PARTIAL_TP.tp2ClosePct, q3 = QTY - q1 - q2;
  const expectGross = (p1 - ENTRY) * q1 + (p2 - ENTRY) * q2 + (p3 - ENTRY) * q3;
  const expectExitFee = (p1 * q1 + p2 * q2 + p3 * q3) * 6 / 10000;
  const expectEntryFee = ENTRY_FEE;   // 各批份额之和 = 1

  ok(near(r.gross, expectGross, 1e-9), 'gross = 三批按各档价成交之和', `got ${r.gross} expect ${expectGross}`);
  ok(near(r.fee, expectEntryFee + expectExitFee, 1e-9),
    'fee = 全额入场费 + 各批出场费（份额之和恰为 1，不重复不漏计）', `got ${r.fee} expect ${expectEntryFee + expectExitFee}`);
  ok(r.net > 0, '分批止盈净盈亏为正', `net=${r.net}`);
  console.log(`    net=${Number(r.net || 0).toFixed(6)} gross=${Number(r.gross || 0).toFixed(6)} fee=${Number(r.fee || 0).toFixed(6)} fills=${r.partialFills}`);

  // 分批的平均出场价低于主止盈 → 净盈亏应低于「全仓等主止盈」的对照组（在关闭场景里打印）
}

console.log('\n[3] 跨轮续跑：分批进度不得丢失 / 不得重复平同一批');
{
  const { rec, rows, now } = oneShot;
  // 第一轮：只推进到 TP1 成交的那一根之后
  const rows1 = rows.slice(0, 27);   // 含 i=26（触及 TP1）
  const r1 = createAccountSimulator().evaluate(rec, rows1, rows1.at(-1).openTime + 60000);

  ok(r1.status === 'open', '第一轮后仍持仓（未结束）', `status=${r1.status}`);
  ok(r1.tpStage === 1, 'tpStage=1（TP1 已成交）', `got ${r1.tpStage}`);
  ok(near(r1.realizedQty, QTY * PARTIAL_TP.tp1ClosePct, 1e-9), '已实现数量 = 40% 原始仓位', `got ${r1.realizedQty}`);
  ok(near(r1.quantity, QTY * (1 - PARTIAL_TP.tp1ClosePct), 1e-9), '剩余数量 = 60%', `got ${r1.quantity}`);
  ok(r1.realizedNet > 0, '第一轮已实现盈亏为正（TP1 锁定盈利）', `realizedNet=${r1.realizedNet}`);
  ok(!Number.isFinite(r1.tpStopFloor),
    '默认不抬保本：tpStopFloor 未设置（止损节奏仍交给已验证的 trailing 阶梯）', `got ${r1.tpStopFloor}`);

  // 第二轮：把第一轮状态写成「订单形态」继续跑（模拟 advancePaperOrder 回写后再次推进）
  const order2 = {
    plan: rec.plan, initialPlan: { ...rec.plan }, direction: 'OPEN_LONG',
    symbol: 'TESTUSDT', interval: '1m',
    nextTime: r1.nextTime, notional: NOTIONAL, leverage: 1, margin: NOTIONAL,
    costs: { feeBps: 6, slippageBps: 5, fundingBpsPer8h: 3, notional: NOTIONAL },
    protectionRevisions: [],
    entry: r1.entry, entryAt: r1.entryAt, heldBars: r1.heldBars,
    quantity: r1.quantity, entryFee: r1.entryFee,
    tpStage: r1.tpStage, tpStopFloor: r1.tpStopFloor,
    realizedGross: r1.realizedGross, realizedFee: r1.realizedFee,
    realizedFunding: r1.realizedFunding, realizedNet: r1.realizedNet, realizedQty: r1.realizedQty
  };
  const r2 = createAccountSimulator().evaluate(order2, rows, rows.at(-1).openTime + 60000);

  ok(r2.status === 'closed' && r2.reason === 'take_profit', '第二轮收尾于主止盈', `status=${r2.status} reason=${r2.reason}`);
  ok(r2.partialFills === 2, '第二轮后 partialFills=2（未重复平 TP1）', `got ${r2.partialFills}`);
  ok(near(r2.net, oneShot.r.net, 1e-9),
    '两轮跑完与一轮跑完的净盈亏一致（分批状态可安全跨轮）', `two-phase=${r2.net} one-shot=${oneShot.r.net}`);
  ok(near(r2.gross, oneShot.r.gross, 1e-9), '两轮 gross 与一轮一致', `got ${r2.gross}`);
}

console.log('\n[4] 默认不抬保本：TP1 后回撤不得被扫出（止损仍为初始止损）');
{
  const now = 60000 * Math.ceil(Date.now() / 60000);
  const first = now + 60000;
  const rows = baseRows(first);
  rows.push(kline(first + 25 * 60000, 100, 100.1, 99.85, 100));        // 成交
  rows.push(kline(first + 26 * 60000, 100, 100.95, 99.95, 100.6));     // 触及 TP1，平 40%
  // 回撤到 100.20：远低于保本线(≈100.31)但高于初始止损 99.2。
  // 若保本抬升默认开启，这一根就会被扫出、持仓时间被腰斩 —— 与「盈利靠持仓时间」相悖，
  // 且已有的 trailing 阶梯（1R 档 lockR=0.30R）本就提供几乎等效的锁盈。
  rows.push(kline(first + 27 * 60000, 100.6, 100.7, 100.20, 100.25));

  const rec = makeRec(rows, now);
  const r = createAccountSimulator().evaluate(rec, rows, rows.at(-1).openTime + 60000);

  ok(r.status === 'open', '回撤未击穿初始止损，继续持仓（未被保本线扫出）', `status=${r.status} reason=${r.reason}`);
  ok(r.tpStage === 1, 'TP1 已成交（利润落袋）', `tpStage=${r.tpStage}`);
  ok(r.realizedNet > 0, '已实现盈亏为正', `realizedNet=${r.realizedNet}`);
  ok(near(r.quantity, QTY * (1 - PARTIAL_TP.tp1ClosePct), 1e-9), '剩余 60% 仓位仍在场', `qty=${r.quantity}`);
  console.log(`    status=${r.status} tpStage=${r.tpStage} realizedNet=${Number(r.realizedNet).toFixed(6)}`);
}

console.log('\n[5] settlePaperOrder（手工/智能平仓路径）必须并入已实现盈亏');
{
  // 构造一笔「已分批成交一批」的持仓，再用手工平仓收尾
  const batchQty = QTY * PARTIAL_TP.tp1ClosePct;
  const p1 = (ENTRY + PARTIAL_TP.tp1R * R) * (1 - SLIP);
  const realizedNet = (p1 - ENTRY) * batchQty - ENTRY_FEE * PARTIAL_TP.tp1ClosePct - p1 * batchQty * 6 / 10000;

  const order = {
    direction: 'OPEN_LONG', status: 'open', entry: ENTRY, entryAt: new Date(0).toISOString(),
    notional: NOTIONAL, margin: NOTIONAL, leverage: 1,
    quantity: QTY - batchQty, entryFee: ENTRY_FEE,
    costs: { feeBps: 6, slippageBps: 5, fundingBpsPer8h: 3, notional: NOTIONAL },
    plan: makePlan(),
    realizedNet, realizedGross: (p1 - ENTRY) * batchQty, realizedQty: batchQty,
    realizedFee: ENTRY_FEE * PARTIAL_TP.tp1ClosePct + p1 * batchQty * 6 / 10000, realizedFunding: 0
  };

  settlePaperOrder(order, ENTRY, 'manual', Date.parse(order.entryAt));
  ok(order.status === 'closed', '手工平仓生效');
  // 完整手算：已实现部分 + 剩余仓盈亏 − 剩余仓入场费份额 − 剩余仓出场费
  const exitP = ENTRY * (1 - SLIP);          // 手工平仓也要吃掉出场滑点
  const qRemain = QTY - batchQty;
  const expectNet = realizedNet
    + (exitP - ENTRY) * qRemain
    - ENTRY_FEE * (1 - PARTIAL_TP.tp1ClosePct)
    - exitP * qRemain * 6 / 10000;
  ok(near(order.net, expectNet, 1e-9),
    'net 并入 realizedNet（旧实现会漏掉已分批的利润）', `net=${order.net} 期望=${expectNet}`);
  ok(order.net > 0, '已锁定利润未被吞掉', `net=${order.net}`);
}

// ── 拉起子进程验证关闭场景 ────────────────────────────────────────────────
console.log('\n[6] 拉起子进程验证开关（关闭分批 / 开启保本）');
{
  const cases = [
    ['NOFX_PARTIAL_TP=false（回到全仓等主止盈）', { NOFX_PARTIAL_TP: 'false' }],
    ['NOFX_TP_BREAKEVEN=true（TP1 后抬保本）', { NOFX_TP_BREAKEVEN: 'true' }]
  ];
  for (const [label, env] of cases) {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      env: { ...process.env, ...env }, encoding: 'utf8'
    });
    const out = `${child.stdout || ''}${child.stderr || ''}`;
    console.log(`    ── ${label}`);
    console.log(out.trim().split('\n').map(l => `    ${l}`).join('\n'));
    ok(child.status === 0, `子进程 ${label} 全部通过`, `exit=${child.status}`);
  }
}

report();
