export function validateOrder({ order, config, account, price, positions }) {
  const side = String(order.side || '').toUpperCase();
  const symbol = String(order.symbol || '').toUpperCase();
  const quantity = Number(order.quantity || 0);
  const leverage = Number(order.leverage ?? 1);
  const confidence = Number(order.confidence);

  if (!symbol) return reject('Missing symbol.');
  if (!['BUY', 'SELL'].includes(side)) return reject('Side must be BUY or SELL.');
  if (!Number.isFinite(quantity) || quantity <= 0) return reject('Quantity must be positive.');
  if (!Number.isFinite(price) || price <= 0) return reject('Price is unavailable.');
  if (!Array.isArray(positions) || positions.some(p => !Number.isFinite(Number(p.positionAmt)))) return reject('Valid position snapshot is required.');
  const held = positions.filter(p => p.symbol === symbol && Number(p.positionAmt) !== 0);
  const notional = quantity * price;
  if (!Number.isFinite(notional)) return reject('Order notional is invalid.');
  if (order.reduceOnly) {
    if (held.length !== 1 || (held[0].positionSide && held[0].positionSide !== 'BOTH')) return reject('A single one-way position is required to close.');
    const amount = Number(held[0].positionAmt);
    if (side !== (amount > 0 ? 'SELL' : 'BUY') || quantity > Math.abs(amount)) return reject('Close direction or quantity does not match position.');
    return { ok: true, reason: 'Validated reduce-only close.', notional };
  }
  if (!Number.isInteger(leverage) || leverage < 1) return reject('Leverage must be a positive integer.');
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return reject('Confidence must be between 0 and 1.');
  if (![config.trader.maxLeverage, config.trader.minConfidence, config.trader.maxPositionNotionalPct].every(v => typeof v === 'number' && Number.isFinite(v))) return reject('Risk limits are invalid.');
  if (config.trader.maxLeverage < 1 || config.trader.minConfidence < 0 || config.trader.minConfidence > 1 || config.trader.maxPositionNotionalPct <= 0 || config.trader.maxPositionNotionalPct > 1) return reject('Risk limits are outside allowed ranges.');
  if (leverage > config.trader.maxLeverage) {
    return reject(`Leverage ${leverage} exceeds max ${config.trader.maxLeverage}.`);
  }
  if (confidence < config.trader.minConfidence) {
    return reject(`Confidence ${confidence} is below min ${config.trader.minConfidence}.`);
  }

  const walletBalance = Number(account?.totalWalletBalance || account?.totalMarginBalance || 0);
  if (!Number.isFinite(walletBalance) || walletBalance <= 0) return reject('Valid positive account equity is required.');
  if (held.length) return reject('An existing position blocks repeated entries for this symbol.');
  const maxNotional = walletBalance * config.trader.maxPositionNotionalPct;

  if (walletBalance > 0 && notional > maxNotional) {
    return reject(`Order notional ${notional.toFixed(2)} exceeds max ${maxNotional.toFixed(2)}.`);
  }
  const totalLimit = Number(config.trader.maxTotalNotionalPct ?? config.trader.maxPositionNotionalPct);
  if (!Number.isFinite(totalLimit) || totalLimit <= 0 || totalLimit > 1) return reject('Total exposure limit is invalid.');
  let exposure = 0;
  for (const position of positions) {
    if (Number(position.positionAmt) === 0) continue;
    const markPrice = Number(position.markPrice);
    if (!Number.isFinite(markPrice) || markPrice <= 0) return reject('Position mark price is unavailable.');
    exposure += Math.abs(Number(position.positionAmt)) * markPrice;
  }
  if (exposure + notional > walletBalance * totalLimit) return reject('Cumulative position exposure exceeds limit.');

  return { ok: true, reason: 'Order passed local risk checks.', notional };
}

export function normalizeDecision(decision) {
  const action = String(decision?.action || 'HOLD').toUpperCase();
  return {
    action: ['BUY', 'SELL', 'CLOSE', 'HOLD'].includes(action) ? action : 'HOLD',
    side: ['BUY', 'SELL'].includes(String(decision?.side || '').toUpperCase())
      ? String(decision.side).toUpperCase()
      : '',
    symbol: String(decision?.symbol || '').toUpperCase(),
    quantity: Number(decision?.quantity || 0),
    leverage: Number(decision?.leverage || 1),
    confidence: Number(decision?.confidence || 0),
    reason: String(decision?.reason || '')
  };
}

function reject(reason) {
  return { ok: false, reason, notional: 0 };
}
