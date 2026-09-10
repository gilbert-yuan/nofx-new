// 回测验证：用真实模拟订单的入场点，回放"旧规则(实际结果) vs 新规则"的出场表现。
// 新规则 = 噪声保护止损(max(2*ATR, 0.8%价格)) + 等比止盈(2*riskUnit) + 盈利>2%才启用移动止损
// 场景A: 新出场规则（全部订单）
// 场景B: A + 追高/追空过滤(偏离MA20 > 1.5 ATR 不入场)
// 场景C: B + 同币种防重复 + 止损60分钟冷却
const { Client } = require('pg');

const DB = 'postgres://postgres:admin@127.0.0.1:5432/nofx_lite';
const FEE_BPS = 6, SLIP_BPS = 5, FUNDING_BPS_8H = 3, MAX_HOLD = 120;
const REVIEW_EVERY = 5; // 复检每5根(5分钟)

function atr14(bars) {
  if (bars.length < 15) return null;
  let sum = 0;
  for (let i = bars.length - 14; i < bars.length; i++) {
    const prevClose = bars[i - 1].close;
    sum += Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - prevClose), Math.abs(bars[i].low - prevClose));
  }
  return sum / 14;
}
function ma20(bars) {
  if (bars.length < 20) return null;
  const s = bars.slice(-20).reduce((a, b) => a + b.close, 0);
  return s / 20;
}

// 回放单个订单的新规则出场
function replay(order, bars, startIdx) {
  const long = order.direction === 'OPEN_LONG';
  const dir = long ? 1 : -1;
  const entry = order.entry;
  const a0 = atr14(bars.slice(0, startIdx));
  if (!a0 || a0 <= 0) return null;
  const riskUnit = Math.max(2 * a0, entry * 0.008);
  let stop = long ? entry - riskUnit : entry + riskUnit;
  let tp = long ? entry + 2 * riskUnit : entry - 2 * riskUnit;
  const notional = order.margin * order.leverage;
  const quantity = notional / entry;
  const entryFee = notional * FEE_BPS / 10000;

  let held = 0;
  for (let i = startIdx; i < bars.length && held < MAX_HOLD; i++, held++) {
    const row = bars[i];
    // 1) 止损优先（跳空取劣价）
    const hitStop = long ? row.low <= stop : row.high >= stop;
    const hitTarget = long ? row.high >= tp : row.low <= tp;
    if (hitStop) {
      const stopPrice = long ? Math.min(row.open, stop) : Math.max(row.open, stop);
      return settle(dir, entry, stopPrice, quantity, notional, entryFee, order, held, 'stop_loss');
    }
    if (hitTarget) {
      return settle(dir, entry, tp, quantity, notional, entryFee, order, held, 'take_profit');
    }
    // 2) 盈利>2%时，每5根复检一次移动止损（只收紧，从下一根生效）
    if (held > 0 && held % REVIEW_EVERY === 0) {
      const a = atr14(bars.slice(0, i + 1));
      if (a > 0) {
        const profit = long ? (row.close - entry) / entry : (entry - row.close) / entry;
        if (profit > 0.02) {
          if (long) {
            stop = Math.max(stop, entry + 0.2 * a, row.close - 1.5 * a);
            tp = Math.max(tp, row.close + 3 * a);
          } else {
            stop = Math.min(stop, entry - 0.2 * a, row.close + 1.5 * a);
            tp = Math.min(tp, row.close - 3 * a);
          }
        }
      }
    }
  }
  // 超时以最后收盘价平仓
  const last = bars[Math.min(startIdx + MAX_HOLD, bars.length) - 1];
  return settle(dir, entry, last.close, quantity, notional, entryFee, order, MAX_HOLD, 'timeout');
}

function settle(dir, entry, rawExit, quantity, notional, entryFee, order, held, reason) {
  const exit = rawExit * (1 - dir * SLIP_BPS / 10000);
  const gross = dir * (exit - entry) * quantity;
  const exitFee = exit * quantity * FEE_BPS / 10000;
  const durationMs = held * 60000;
  const funding = notional * FUNDING_BPS_8H / 10000 * durationMs / 28800000;
  let net = gross - entryFee - exitFee - funding;
  const maxLoss = -order.margin - entryFee;
  if (net < maxLoss) net = maxLoss;
  return { net, reason, held };
}

async function main() {
  const c = new Client(DB);
  await c.connect();

  const orders = (await c.query(`
    SELECT order_id, symbol, direction, entry, entry_at, exit_at, leverage, margin, net, reason,
      created_at, market_provider
    FROM simulated_orders WHERE status='closed' AND entry IS NOT NULL AND entry_at IS NOT NULL ORDER BY created_at
  `)).rows;
  console.log('已平仓订单总数:', orders.length);

  // 每个订单入场前需要至少 20+15 根K线，入场后最多 130 根
  const needBefore = 22 * 60000, needAfter = (MAX_HOLD + 10) * 60000;
  const minT = Math.min(...orders.map(o => Date.parse(o.entry_at))) - needBefore;
  const maxT = Math.max(...orders.map(o => Date.parse(o.exit_at ?? o.entry_at))) + needAfter;

  // 按 symbol 批量取K线（OKX_PUBLIC_ 前缀优先）
  const symbols = [...new Set(orders.map(o => o.symbol))];
  const klineMap = new Map();
  let missing = [];
  for (const symbol of symbols) {
    const like = await c.query(
      `SELECT symbol FROM (SELECT DISTINCT symbol FROM market_klines WHERE interval='1m') t WHERE symbol = $1 OR symbol = $2`,
      ['OKX_PUBLIC_' + symbol, symbol]);
    const key = like.rows.map(r => r.symbol).sort((a, b) => (b.startsWith('OKX_PUBLIC_') ? 1 : 0) - (a.startsWith('OKX_PUBLIC_') ? 1 : 0))[0];
    if (!key) { missing.push(symbol); klineMap.set(symbol, null); continue; }
    const rows = await c.query(
      `SELECT open_time, open, high, low, close FROM market_klines
       WHERE symbol=$1 AND interval='1m' AND open_time >= $2 AND open_time <= $3 ORDER BY open_time`,
      [key, minT, maxT]);
    klineMap.set(symbol, rows.rows.map(r => ({
      openTime: Number(r.open_time), open: +r.open, high: +r.high, low: +r.low, close: +r.close
    })));
  }
  console.log('无K线数据的币种数:', missing.length);

  // 定位入场索引：entry_at 之后(含)的第一根K线
  const locate = (bars, t) => {
    if (!bars || !bars.length) return -1;
    let lo = 0, hi = bars.length - 1, ans = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (bars[m].openTime >= t) { ans = m; hi = m - 1; } else lo = m + 1; }
    return ans;
  };

  // 预处理：每个订单的入场索引、入场前指标（场景B用）
  const prepared = [];
  for (const o of orders) {
    const bars = klineMap.get(o.symbol);
    const idx = bars ? locate(bars, Date.parse(o.entry_at)) : -1;
    if (idx < 22 || idx >= bars.length) continue;
    const before = bars.slice(0, idx);
    const a = atr14(before), m = ma20(before);
    if (!a || !m) continue;
    const closeBefore = before[before.length - 1].close;
    const ext = (closeBefore - m) / a;
    prepared.push({ o, bars, idx, ext });
  }
  console.log('可回放订单数:', prepared.length);

  const stats = list => {
    const n = list.length;
    if (!n) return { n: 0 };
    const wins = list.filter(x => x.net > 0).length;
    const net = list.reduce((a, x) => a + x.net, 0);
    const byReason = {};
    for (const x of list) byReason[x.reason] = (byReason[x.reason] || 0) + 1;
    return {
      n, wr: (100 * wins / n).toFixed(1) + '%',
      net: net.toFixed(0), avg: (net / n).toFixed(2),
      reasons: Object.entries(byReason).map(([k, v]) => `${k}:${v}`).join(' ')
    };
  };

  // ===== 场景A：全部可回放订单 =====
  const baseA = [], newA = [];
  for (const p of prepared) {
    baseA.push({ net: p.o.net });
    const r = replay(p.o, p.bars, p.idx);
    if (r) newA.push(r);
  }
  console.log('\n=== 场景A: 新出场规则(全部订单) ===');
  console.log('实际(旧规则):', JSON.stringify(stats(baseA)));
  console.log('新规则回放:  ', JSON.stringify(stats(newA)));

  // ===== 场景B：+ 追高/追空过滤 =====
  const baseB = [], newB = [];
  for (const p of prepared) {
    const long = p.o.direction === 'OPEN_LONG';
    if (long ? p.ext > 1.5 : p.ext < -1.5) continue; // 被新过滤排除
    baseB.push({ net: p.o.net });
    const r = replay(p.o, p.bars, p.idx);
    if (r) newB.push(r);
  }
  console.log('\n=== 场景B: A + 追高/追空过滤 ===');
  console.log('剩余订单:', baseB.length, `(过滤掉 ${prepared.length - baseB.length} 单)`);
  console.log('实际(旧规则):', JSON.stringify(stats(baseB)));
  console.log('新规则回放:  ', JSON.stringify(stats(newB)));

  // ===== 场景C：B + 同币种防重复 + 止损60分钟冷却 =====
  // 按提交顺序逐单判断，用旧规则的实际出场时间做重叠/冷却判断
  const seen = new Map(); // symbol -> {openUntil, lastStopAt}
  const baseC = [], newC = [], skipped = { dup: 0, cool: 0 };
  for (const p of prepared) {
    const sym = p.o.symbol;
    const st = seen.get(sym) || { openUntil: 0, lastStopAt: 0 };
    const entryT = Date.parse(p.o.entry_at);
    if (st.openUntil > entryT) { skipped.dup++; continue; }
    if (st.lastStopAt && entryT - st.lastStopAt < 60 * 60000) { skipped.cool++; continue; }
    baseC.push({ net: p.o.net });
    const r = replay(p.o, p.bars, p.idx);
    if (r) newC.push(r);
    const exitT = p.o.exit_at ? Date.parse(p.o.exit_at) : entryT;
    st.openUntil = Math.max(st.openUntil, exitT);
    if (p.o.reason === 'stop_loss' && p.o.exit_at) st.lastStopAt = Math.max(st.lastStopAt, exitT);
    seen.set(sym, st);
  }
  console.log('\n=== 场景C: B + 防重复 + 60分钟冷却 ===');
  console.log('剩余订单:', baseC.length, `(去重 ${skipped.dup}, 冷却 ${skipped.cool})`);
  console.log('实际(旧规则):', JSON.stringify(stats(baseC)));
  console.log('新规则回放:  ', JSON.stringify(stats(newC)));

  await c.end();
}

main().catch(e => { console.error('ERR', e); process.exit(1); });
