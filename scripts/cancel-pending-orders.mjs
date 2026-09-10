#!/usr/bin/env node
/**
 * 撤销未成交挂单（status='pending'）。
 *
 * 用途：GTC 限价挂单永不退市，会持续堆积并占用活动订单额度（上限 20 笔）
 * 与保证金/手续费预留，需要时可一键清空。
 *
 * 用法：
 *   node scripts/cancel-pending-orders.mjs            # dry-run，只列出，不改动
 *   node scripts/cancel-pending-orders.mjs --apply    # 真正撤单
 *
 * 可选环境变量：NOFX_API（默认 http://127.0.0.1:3100）
 *
 * 实现说明：系统没有独立的 cancel 接口，POST /api/paper/orders/:id/close
 * 对 pending 订单的语义就是撤单（simulatedAccount.close → status='cancelled'），
 * 保留历史记录而不是物理删除，这是正确的做法。
 * 已成交持仓（status='open'）不在本脚本处理范围内，不会被触碰。
 */
const BASE = process.env.NOFX_API || 'http://127.0.0.1:3100';
const apply = process.argv.includes('--apply');

const get = async url => (await fetch(BASE + url)).json();
const post = async url => (await fetch(BASE + url, { method: 'POST' })).json();

const countBy = orders => {
  const counts = {};
  for (const o of orders) counts[o.status] = (counts[o.status] || 0) + 1;
  return counts;
};

const acct = await get('/api/paper/account');
const all = acct.orders || [];
console.log('订单状态分布:', JSON.stringify(countBy(all)));

const pending = all.filter(o => o.status === 'pending');
const open = all.filter(o => o.status === 'open');

console.log(`\n未成交挂单 pending = ${pending.length} 笔${apply ? '（即将全部撤单）' : '（dry-run，未改动）'}：`);
for (const o of pending) {
  console.log(`  ${o.symbol.padEnd(18)}${String(o.direction).padEnd(12)}挂单价=${o.plan?.entryLimit ?? '-'}  `
    + `保证金=${o.margin}U ${o.leverage}x  下单=${o.createdAt}`);
}
console.log(`\n已成交持仓 open = ${open.length} 笔（本脚本不动）：`);
for (const o of open) console.log(`  ${o.symbol.padEnd(18)}${String(o.direction).padEnd(12)}入场=${o.entry}`);

if (!pending.length) {
  console.log('\n没有未成交挂单，无需操作。');
  process.exit(0);
}
if (!apply) {
  console.log('\n[dry-run] 加 --apply 才会真正撤单。');
  process.exit(0);
}

let ok = 0, failed = 0;
for (const o of pending) {
  try {
    const r = await post(`/api/paper/orders/${o.id}/close`);
    const status = r?.status || r?.order?.status;
    if (status === 'cancelled') { ok++; console.log(`  已撤 ${o.symbol} ${o.id} → ${status}`); }
    else { failed++; console.log(`  异常 ${o.symbol} ${o.id} → ${JSON.stringify(status ?? r).slice(0, 120)}`); }
  } catch (error) {
    failed++;
    console.log(`  失败 ${o.symbol} ${o.id}: ${error.message}`);
  }
}

const after = await get('/api/paper/account');
console.log(`\n撤单完成: 成功 ${ok}, 失败 ${failed}`);
console.log('撤单后状态分布:', JSON.stringify(countBy(after.orders || [])));
