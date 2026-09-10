// 参数实验：在回放框架上测试 评分门槛 x 止盈倍数 x 保本规则 组合，并分析 MFE
const { Client } = require('pg');

const DB = 'postgres://postgres:admin@127.0.0.1:5432/nofx_lite';
const FEE_BPS = 6, SLIP_BPS = 5, FUNDING_BPS_8H = 3, MAX_HOLD = 120;

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
  return bars.slice(-20).reduce((a, b) => a + b.close, 0) / 20;
}

function settle(dir, entry, rawExit, quantity, margin, leverage, held, reason) {
  const exit = rawExit * (1 - dir * SLIP_BPS / 10000);
  const notional = margin * leverage;
  const gross = dir * (exit - entry) * (notional / entry);
  const entryFee = notional * FEE_BPS / 10000;
  const exitFee = exit * (notional / entry) * FEE_BPS / 10000;
  const funding = notional * FUNDING_BPS_8H / 10000 * held * 60000 / 28800000;
  let net = gross - entryFee - exitFee - funding;
  const maxLoss = -margin - entryFee;
  if (net < maxLoss) net = maxLoss;
  return { net, reason, held };
}

// 通用回放：tpMult(止盈=tpMult*riskUnit)，beRule: null | 'ru1'(盈利>1RU保本) | 'pct2'(盈利>2%保本)
function replay(o, bars, startIdx, tpMult, beRule) {
  const long = o.direction === 'OPEN_LONG';
  const dir = long ? 1 : -1;
  const entry = o.entry;
  const a0 = atr14(bars.slice(0, startIdx));
  if (!a0 || a0 <= 0) return null;
  const riskUnit = Math.max(2 * a0, entry * 0.008);
  let stop = long ? entry - riskUnit : entry + riskUnit;
  let tp = long ? entry + tpMult * riskUnit : entry - tpMult * riskUnit;
  let beDone = false, mfe = 0;
  for (let held = 0; held < MAX_HOLD && startIdx + held < bars.length; held++) {
    const row = bars[startIdx + held];
    mfe = Math.max(mfe, long ? (row.high - entry) / riskUnit : (entry - row.low) / riskUnit);
    const hitStop = long ? row.low <= stop : row.high >= stop;
    const hitTarget = long ? row.high >= tp : row.low <= tp;
    if (hitStop) {
      const stopPrice = long ? Math.min(row.open, stop) : Math.max(row.open, stop);
      return { ...settle(dir, entry, stopPrice, 0, o.margin, o.leverage, held, 'stop_loss'), mfe };
    }
    if (hitTarget) {
      return { ...settle(dir, entry, tp, 0, o.margin, o.leverage, held, 'take_profit'), mfe };
    }
    if (held > 0 && held % 5 === 0 && !beDone) {
      const a = atr14(bars.slice(0, startIdx + held + 1));
      const profit = long ? (row.close - entry) / entry : (entry - row.close) / entry;
      const trigger = beRule === 'ru1' ? (long ? row.close - entry : entry - row.close) > riskUnit : profit > 0.02;
      if (a > 0 && trigger) {
        const be = long ? entry + 0.2 * a : entry - 0.2 * a;
        stop = long ? Math.max(stop, be) : Math.min(stop, be);
        beDone = true;
      }
    }
  }
  const last = bars[Math.min(startIdx + MAX_HOLD, bars.length) - 1];
  return { ...settle(dir, entry, last.close, 0, o.margin, o.leverage, MAX_HOLD, 'timeout'), mfe };
}

async function main() {
  const c = new Client(DB);
  await c.connect();
  const orders = (await c.query(`
    SELECT o.order_id, o.symbol, o.direction, o.entry, o.entry_at, o.exit_at, o.leverage, o.margin, o.net, o.reason, o.created_at,
      COALESCE(a.confidence, 0.6) conf
    FROM simulated_orders o
    LEFT JOIN LATERAL (SELECT confidence FROM simulated_order_analysis x WHERE x.order_id=o.order_id LIMIT 1) a ON true
    WHERE o.status='closed' AND o.entry IS NOT NULL AND o.entry_at IS NOT NULL
    ORDER BY o.created_at`)).rows;

  const needBefore = 22 * 60000, needAfter = (MAX_HOLD + 10) * 60000;
  const minT = Math.min(...orders.map(o => Date.parse(o.entry_at))) - needBefore;
  const maxT = Math.max(...orders.map(o => Date.parse(o.exit_at ?? o.entry_at))) + needAfter;
  const symbols = [...new Set(orders.map(o => o.symbol))];
  const klineMap = new Map();
  for (const symbol of symbols) {
    const like = await c.query(
      `SELECT symbol FROM (SELECT DISTINCT symbol FROM market_klines WHERE interval='1m') t WHERE symbol = $1 OR symbol = $2`,
      ['OKX_PUBLIC_' + symbol, symbol]);
    const key = like.rows.map(r => r.symbol).sort((a, b) => (b.startsWith('OKX_PUBLIC_') ? 1 : 0) - (a.startsWith('OKX_PUBLIC_') ? 1 : 0))[0];
    if (!key) { klineMap.set(symbol, null); continue; }
    const rows = await c.query(
      `SELECT open_time, open, high, low, close FROM market_klines WHERE symbol=$1 AND interval='1m' AND open_time >= $2 AND open_time <= $3 ORDER BY open_time`,
      [key, minT, maxT]);
    klineMap.set(symbol, rows.rows.map(r => ({
      openTime: Number(r.open_time), open: +r.open, high: +r.high, low: +r.low, close: +r.close
    })));
  }

  const locate = (bars, t) => {
    if (!bars || !bars.length) return -1;
    let lo = 0, hi = bars.length - 1, ans = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (bars[m].openTime >= t) { ans = m; hi = m - 1; } else lo = m + 1; }
    return ans;
  };

  const prepared = [];
  for (const o of orders) {
    const bars = klineMap.get(o.symbol);
    const idx = bars ? locate(bars, Date.parse(o.entry_at)) : -1;
    if (idx < 22 || idx >= bars.length) continue;
    const before = bars.slice(0, idx);
    const a = atr14(before), m = ma20(before);
    if (!a || !m) continue;
    const ext = (before[before.length - 1].close - m) / a;
    const score = Math.round((Number(o.conf) - 0.60) * 250); // confidence -> 100分制评分
    prepared.push({ o, bars, idx, ext, score });
  }
  console.log('可回放订单:', prepared.length);

  const report = (name, list) => {
    if (!list.length) { console.log(name, '无订单'); return; }
    const wins = list.filter(x => x.net > 0).length;
    const net = list.reduce((a, x) => a + x.net, 0);
    const r = {};
    for (const x of list) r[x.reason] = (r[x.reason] || 0) + 1;
    console.log(`${name.padEnd(28)} n=${String(list.length).padStart(4)} 胜率=${(100 * wins / list.length).toFixed(1)}% 净=${net.toFixed(0).padStart(6)} 平均=${(net / list.length).toFixed(2)} [${Object.entries(r).map(([k, v]) => k.slice(0, 4) + ':' + v).join(' ')}]`);
  };

  // MFE 分析（新止损规则下）
  console.log('\n=== MFE 分析（以 riskUnit 为单位，全部订单） ===');
  const mfeBuckets = [0, 0.5, 1, 1.5, 2, 3, 99];
  const mfeCounts = new Array(mfeBuckets.length).fill(0);
  for (const p of prepared) {
    const r = replay(p.o, p.bars, p.idx, 2, null);
    if (!r) continue;
    for (let b = 0; b < mfeBuckets.length; b++) {
      const upper = mfeBuckets[b] === 99 ? Infinity : mfeBuckets[b];
      const lower = b === 0 ? -Infinity : mfeBuckets[b - 1];
      if (r.mfe > lower && r.mfe <= upper) { mfeCounts[b]++; break; }
    }
  }
  mfeBuckets.forEach((u, b) => {
    const lower = b === 0 ? '<0.5' : mfeBuckets[b - 1];
    console.log(`MFE<=${u === 99 ? '∞' : u} (${lower}~]: ${mfeCounts[b]}`);
  });

  // 基线：场景C过滤（防重复+冷却）+ 追高过滤后，测试参数组合
  const seen = new Map();
  const filtered = [];
  for (const p of prepared) {
    const long = p.o.direction === 'OPEN_LONG';
    if (long ? p.ext > 1.5 : p.ext < -1.5) continue;
    const sym = p.o.symbol;
    const st = seen.get(sym) || { openUntil: 0, lastStopAt: 0 };
    const entryT = Date.parse(p.o.entry_at);
    if (st.openUntil > entryT) continue;
    if (st.lastStopAt && entryT - st.lastStopAt < 60 * 60000) continue;
    const exitT = p.o.exit_at ? Date.parse(p.o.exit_at) : entryT;
    st.openUntil = Math.max(st.openUntil, exitT);
    if (p.o.reason === 'stop_loss' && p.o.exit_at) st.lastStopAt = Math.max(st.lastStopAt, exitT);
    seen.set(sym, st);
    filtered.push(p);
  }
  console.log('\n过滤后订单:', filtered.length);
  report('基线(旧规则实际结果)', filtered.map(p => ({ net: p.o.net, reason: p.o.reason })));

  console.log('\n=== 参数组合实验（过滤后订单集） ===');
  for (const gate of [60, 65, 70]) {
    for (const tpMult of [2, 2.5, 3]) {
      for (const beRule of [null, 'ru1']) {
        const results = [];
        for (const p of filtered) {
          if (p.score < gate) continue;
          const r = replay(p.o, p.bars, p.idx, tpMult, beRule);
          if (r) results.push(r);
        }
        report(`评分>=${gate} tp=${tpMult}RU be=${beRule || 'off'}`, results);
      }
    }
  }
  await c.end();
}

main().catch(e => { console.error('ERR', e); process.exit(1); });
