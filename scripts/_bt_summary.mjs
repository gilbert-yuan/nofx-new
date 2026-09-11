import fs from 'node:fs';
import path from 'node:path';
const DIR = path.resolve('data/backtest');
const files = process.argv.slice(2).length ? process.argv.slice(2) : fs.readdirSync(DIR).filter(f => f.startsWith('result') || f.startsWith('bt-') || /^r\d+\.json$/.test(f));
for (const f of files) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
    const orders = j.orders || j.closed || j.trades || [];
    const closed = orders.filter(o => (o.status === 'closed') && o.net != null);
    const n = closed.length;
    if (!n) { console.log(`${f}: 无已平仓 (keys=${Object.keys(j).join(',')})`); continue; }
    const wins = closed.filter(o => o.net > 0).length;
    const net = closed.reduce((s, o) => s + Number(o.net || 0), 0);
    const gross = closed.reduce((s, o) => s + Number(o.gross || 0), 0);
    const fees = closed.reduce((s, o) => s + Number(o.fees || 0), 0);
    const held = closed.reduce((s, o) => s + Number(o.heldBars ?? o.held_bars ?? 0), 0) / n;
    const reasons = {};
    closed.forEach(o => { reasons[o.reason] = (reasons[o.reason] || 0) + 1; });
    const cfg = j.config || j.meta || {};
    console.log(`${f}\n  成交${n} 胜率${(100 * wins / n).toFixed(1)}% 净${net.toFixed(1)} 均单${(net / n).toFixed(3)} 毛${gross.toFixed(1)} 费${fees.toFixed(1)} 持仓${held.toFixed(1)}`);
    console.log(`  cfg=${JSON.stringify(cfg).slice(0, 220)}`);
    console.log(`  出场=${JSON.stringify(reasons)}`);
  } catch (e) { console.log(`${f}: ERR ${e.message}`); }
}
