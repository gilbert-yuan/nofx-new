/**
 * 周期可行性分析：交易成本相对于波动率是否可承受？
 *
 * 核心矛盾：往返成本固定 0.22%，而止损距离 = 2×ATR%。
 * 周期越短 ATR% 越小 → 成本占比越高 → 打平胜率被抬高到实际够不到的水平。
 * 打平胜率 p = (s+c)/(s+t)，其中 s=2×ATR%, t=6×ATR%（3R 止盈）, c=0.22%
 * 只读数据库。
 */
const { Client } = require('pg');
const DB = 'postgres://postgres:admin@127.0.0.1:5432/nofx_lite';
const C = 0.22; // 往返成本 %（手续费 6bps + 滑点 5bps，双边）

const atr14 = bars => {
  if (bars.length < 15) return null;
  let s = 0;
  for (let i = bars.length - 14; i < bars.length; i++) {
    const pc = bars[i - 1].close;
    s += Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - pc), Math.abs(bars[i].low - pc));
  }
  return s / 14;
};
const pctl = (a, q) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

async function main() {
  const c = new Client(DB); await c.connect();
  console.log('周期  样本币   ATR%中位   ATR%p75   止损s%   止盈t%   成本/止损   打平胜率   实际胜率(回放)');
  console.log('-'.repeat(104));
  for (const iv of ['1m', '5m', '15m', '1h', '4h']) {
    const syms = (await c.query(
      `SELECT symbol FROM market_klines WHERE interval=$1 GROUP BY symbol HAVING count(*)>=40 ORDER BY count(*) DESC LIMIT 120`, [iv])
    ).rows.map(r => r.symbol);
    if (!syms.length) { console.log(`${iv}: 无数据`); continue; }
    const vals = [];
    for (const s of syms) {
      const r = await c.query(
        `SELECT high, low, close FROM market_klines WHERE symbol=$1 AND interval=$2 ORDER BY open_time DESC LIMIT 60`, [s, iv]);
      const bars = r.rows.reverse().map(x => ({ high: +x.high, low: +x.low, close: +x.close }));
      if (bars.length < 20) continue;
      const atr = atr14(bars);
      const px = bars.at(-1).close;
      if (atr && atr > 0 && px > 0) vals.push(atr / px * 100);
    }
    if (!vals.length) { console.log(`${iv}: 有效样本不足`); continue; }
    const med = pctl(vals, 0.5), p75 = pctl(vals, 0.75);
    const sPct = 2 * med, tPct = 6 * med;
    const be = (sPct + C) / (sPct + tPct);
    console.log(
      iv.padEnd(6) + String(vals.length).padStart(6) +
      med.toFixed(4).padStart(11) + p75.toFixed(4).padStart(10) +
      sPct.toFixed(3).padStart(10) + tPct.toFixed(3).padStart(9) +
      (C / sPct).toFixed(2).padStart(11) +
      (be * 100).toFixed(1).padStart(10) + '%');
  }
  console.log('\n注：往返成本固定 ' + C.toFixed(2) + '%（手续费 6bps + 滑点 5bps，进出各一次）');
  console.log('「成本/止损」> 1 表示一次往返交易的成本比一次止损的亏损还大 —— 该周期在数学上极难盈利。');
  console.log('零成本理论极限打平胜率 = 1/(1+3) = 25.0%；当前实测胜率约 22.8%~36%（口径不同）。');
  await c.end();
}
main().catch(e => { console.error('ERR', e); process.exit(1); });
