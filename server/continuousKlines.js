import { candleOpenAt, nextOpenTime, validCandle } from './research.js';

// End is frozen for the run, so a long catch-up never chases forming candles.
export async function fetchContinuousKlines({ client, symbol, interval, startTime, limit = 80, now = Date.now(), savePage }) {
  const end = candleOpenAt(now, interval);
  let cursor = startTime;
  while (cursor == null || cursor < end) {
    const pageSize = cursor == null ? limit : (client.maxPageSize || 1000);
    let pageEnd = end;
    if (cursor != null) {
      pageEnd = cursor;
      for (let i = 0; i < pageSize && pageEnd < end; i++) pageEnd = nextOpenTime(pageEnd, interval);
    }
    const raw = await client.klines({ symbol, interval, limit: pageSize, startTime: cursor, endTime: Math.min(pageEnd, end) - 1 });
    const rows = raw.map(row => ({ ...row, openTime: Number(row.openTime), closeTime: nextOpenTime(row.openTime, interval) - 1 }))
      .filter(row => row.openTime < end && (cursor == null || row.openTime >= cursor))
      .sort((a, b) => a.openTime - b.openTime);
    if (!rows.length) throw new Error(`${symbol}：${cursor == null ? '没有已收盘 K 线' : '缺少 ' + new Date(cursor).toISOString() + ' 起的 K 线'}，保留断点等待下次补拉。`);
    let expected = cursor ?? rows[0].openTime;
    for (const row of rows) {
      if (row.confirmed === false || row.openTime !== expected || candleOpenAt(row.openTime, interval) !== row.openTime || !validCandle(row) || row.closeTime >= end) {
        throw new Error(`${symbol}：K 线不连续或无效，预期 ${new Date(expected).toISOString()}，保留断点等待补拉。`);
      }
      expected = nextOpenTime(row.openTime, interval);
    }
    await savePage(rows);
    cursor = expected;
  }
}
