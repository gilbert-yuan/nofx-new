import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLOSE_REASONS, CLOSE_REASON_GROUPS, FALLBACK_CLOSE_REASON,
  STOP_REASON_CODES, TAKE_PROFIT_REASON_CODES,
  closeReasonLabel, closeReasonGroup, closeReasonCatalog,
  isCloseReason, normalizeCloseReason, isStopReason, isTakeProfitReason
} from '../shared/closeReasons.js';
import { TradingSimulator } from '../server/tradingSimulator.js';

/**
 * 平仓理由的口径守卫。
 *
 * 「平仓后给出平仓理由，方便后期统计」能否成立，全靠两件事：
 *   1. 落库的 reason 是**稳定机器码**（可 GROUP BY），不是中文长句；
 *   2. 同一个 code 在任何时候都代表同一件事（初始止损 ≠ 移动止损 ≠ 保本止损）。
 * 本文件把这两条钉死，防止后续改动悄悄退化回「什么都记 stop_loss」。
 */

test('平仓理由字典自洽：每个 code 的 group 都在分组表内，且标签非空', () => {
  const groupIds = new Set(CLOSE_REASON_GROUPS.map(g => g.id));
  for (const [code, meta] of Object.entries(CLOSE_REASONS)) {
    assert.ok(groupIds.has(meta.group), `${code} 的分组 ${meta.group} 未定义`);
    assert.ok(meta.label && meta.label.length > 0, `${code} 缺少中文标签`);
    assert.ok(meta.desc && meta.desc.length > 0, `${code} 缺少说明`);
  }
  // 止损/止盈集合必须是字典里真实存在的 code
  for (const c of [...STOP_REASON_CODES, ...TAKE_PROFIT_REASON_CODES]) {
    assert.ok(isCloseReason(c), `${c} 不在 CLOSE_REASONS 字典里`);
  }
});

test('normalizeCloseReason：已知 code 原样返回，中文长句归一，未知兜底 manual', () => {
  // 已知 code 直通
  for (const code of Object.keys(CLOSE_REASONS)) {
    assert.equal(normalizeCloseReason(code), code);
  }
  // 历史中文长句（复核层改造前直接把描述写进 reason）
  assert.equal(normalizeCloseReason('均线失守（偏离1.23ATR）且浮盈仅 0.11R，趋势证伪，主动离场'), 'smart_exit_ma');
  assert.equal(normalizeCloseReason('RSI严重超买(83.2)且浮盈 1.50R，建议获利了结'), 'smart_exit_rsi');
  assert.equal(normalizeCloseReason('MACD死叉且浮盈 1.20R，建议止盈'), 'smart_exit_macd');
  // 非字符串 / 空值
  assert.equal(normalizeCloseReason(null), FALLBACK_CLOSE_REASON);
  assert.equal(normalizeCloseReason(undefined), FALLBACK_CLOSE_REASON);
  assert.equal(normalizeCloseReason(''), FALLBACK_CLOSE_REASON);
  assert.equal(normalizeCloseReason('某种全新的退出'), FALLBACK_CLOSE_REASON);
});

test('止损/止盈归类：细分 code 也要算进各自的桶（否则统计会系统性少算）', () => {
  for (const c of STOP_REASON_CODES) assert.ok(isStopReason(c), `${c} 应归为止损`);
  for (const c of TAKE_PROFIT_REASON_CODES) assert.ok(isTakeProfitReason(c), `${c} 应归为止盈`);
  // 非止损类不得混入
  for (const c of ['take_profit', 'timeout', 'smart_exit_ma', 'liquidation', 'manual']) {
    assert.ok(!isStopReason(c), `${c} 不应归为止损`);
  }
  assert.ok(!isTakeProfitReason('stop_loss'));
  assert.ok(!isTakeProfitReason('trailing_stop'));
});

test('closeReasonLabel / Group：未知值不炸，展示不空白', () => {
  assert.equal(closeReasonLabel('trailing_stop'), '移动止损');
  assert.equal(closeReasonLabel('break_even_stop'), '保本止损');
  assert.equal(closeReasonLabel('partial_take_profit'), '分批止盈');
  assert.equal(closeReasonGroup('smart_exit_ma'), 'smart');
  assert.equal(closeReasonGroup('take_profit'), 'tp');
  assert.equal(closeReasonGroup('不认识的理由'), 'manual');
  assert.equal(closeReasonLabel(''), '');
  // 目录可被前端直接渲染
  const catalog = closeReasonCatalog();
  assert.ok(catalog.length >= 12);
  for (const item of catalog) {
    assert.ok(item.code && item.label && item.group && item.groupLabel && item.desc);
  }
});

// ──────────────── 结算引擎：止损/止盈细分 ────────────────

const sim = new TradingSimulator({ mode: 'account', enableLiquidation: false });

const bar = (o, h, l, c) => ({ open: o, high: h, low: l, close: c });

/** 直接驱动 _checkExit，验证细分理由（不依赖 K 线序列，最稳） */
function exitReason({ row, stopLoss, takeProfit, entry = 100, initialStop = 99, tpStage = 0, breakEvenDist = 0, long = true, held = 1 }) {
  const r = sim._checkExit(
    row,
    { stopLoss, takeProfit, maxHoldBars: 120 },
    entry,
    held,
    long ? 1 : -1,
    undefined,
    { initialStop, tpStage, entry, long, breakEvenDist }
  );
  return r?.reason;
}

test('止损细分：初始止损 / 移动止损 / 保本止损 三个 code 各不相同', () => {
  const row = bar(99.5, 99.6, 98.0, 98.5); // 下探到 98，打掉 99 的止损

  // 1) 未被抬升过 → 初始止损
  assert.equal(
    exitReason({ row, stopLoss: 99, takeProfit: 106, initialStop: 99 }),
    'stop_loss'
  );

  // 2) 被移动止损抬到 99 → 与初始止损不同 → 移动止损
  assert.equal(
    exitReason({ row, stopLoss: 99, takeProfit: 106, initialStop: 98 }),
    'trailing_stop'
  );

  // 3) 抬升过但离保本线还很远 → 移动止损（多单保本线在 entry 之上，99 显然不是）
  assert.equal(
    exitReason({ row, stopLoss: 99, takeProfit: 106, initialStop: 98, breakEvenDist: 0.02 }),
    'trailing_stop',
    '多单保本线 = entry + 0.02 = 100.02，止损 99 离得远，应判为移动止损'
  );
  assert.equal(
    exitReason({ row, stopLoss: 100.02, takeProfit: 106, initialStop: 98, breakEvenDist: 0.02 }),
    'break_even_stop',
    '止损恰在 entry + 保本距离 → 保本止损'
  );
});

test('止盈细分：整仓止盈 / 分批后了结 两个 code 各不相同', () => {
  const row = bar(105, 107, 104.9, 106.5); // 冲上 107，打掉 106 的止盈
  assert.equal(
    exitReason({ row, stopLoss: 99, takeProfit: 106, tpStage: 0 }),
    'take_profit'
  );
  assert.equal(
    exitReason({ row, stopLoss: 99, takeProfit: 106, tpStage: 2 }),
    'partial_take_profit',
    '已经分批减过仓，剩余奔跑仓了结应记分批止盈'
  );
});

test('持有到期与爆仓保持原有 code（不因细分而漂移）', () => {
  const flat = bar(100, 100.5, 99.5, 100);
  assert.equal(
    exitReason({ row: flat, stopLoss: 99, takeProfit: 106, held: 999 }),
    'timeout'
  );
});

test('空头方向：止损抬升判定取反（价格更低 = 抬升）', () => {
  const row = bar(100.5, 101.8, 100.4, 101.5); // 上冲打掉 101 的空头止损
  assert.equal(
    exitReason({ row, stopLoss: 101, takeProfit: 94, initialStop: 101, long: false }),
    'stop_loss'
  );
  assert.equal(
    exitReason({ row, stopLoss: 101, takeProfit: 94, initialStop: 102, long: false }),
    'trailing_stop',
    '空头止损从 102 收紧到 101 属于抬升'
  );
});
