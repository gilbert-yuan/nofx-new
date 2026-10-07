import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { request, ProxyAgent } from 'undici';
import { BinanceClient } from '../../server/binanceClient.js';
import { abs, DAY, MINUTE, duration, writeJSON, hash } from './config.mjs';

const FIELDS = ['openTime', 'open', 'high', 'low', 'close', 'volume', 'quoteVolume', 'tradeCount', 'takerBuyVolume', 'takerBuyQuoteVolume'];
export class CandleSeries {
  constructor(capacity = 65536) { this.length = 0; this.columns = FIELDS.map(() => new Float64Array(capacity)); }
  push(values) {
    if (this.length === this.columns[0].length) this.columns = this.columns.map(a => { const b = new Float64Array(a.length * 2); b.set(a); return b; });
    for (let k = 0; k < FIELDS.length; k++) this.columns[k][this.length] = values[k] ?? NaN;
    this.length++;
  }
  at(i) {
    if (i < 0) i += this.length;
    if (i < 0 || i >= this.length) return null;
    const r = Object.fromEntries(FIELDS.map((k, j) => [k, this.columns[j][i]]));
    r.confirmed = true; return r;
  }
  time(i) { return this.columns[0][i]; }
  lowerBound(t) { let l = 0, h = this.length; while (l < h) { const m = (l + h) >>> 1; if (this.time(m) < t) l = m + 1; else h = m; } return l; }
  slice(a, b) { const out = []; for (let i = Math.max(0, a); i < Math.min(this.length, b); i++) out.push(this.at(i)); return out; }
}
function parseLine(line) {
  if (line.startsWith('{')) {
    const r = JSON.parse(line); return FIELDS.map(k => Number(r[k] ?? NaN));
  }
  const p = line.trim().split(',');
  if (p.length < 6 || !/^\d+$/.test(p[0])) return null;
  let t = Number(p[0]); if (t > 1e14) t /= 1000;
  // Existing .ndjson files are six-column CSV; official archives have twelve columns.
  return [t, ...p.slice(1, 6).map(Number), p[7] == null || p[7] === '' ? NaN : Number(p[7]),
    p[8] == null || p[8] === '' ? NaN : Number(p[8]), p[9] == null || p[9] === '' ? NaN : Number(p[9]),
    p[10] == null || p[10] === '' ? NaN : Number(p[10])];
}
function valid(p) {
  return p && p.slice(0, 6).every(Number.isFinite) && p[0] % MINUTE === 0 && p[1] > 0 && p[4] > 0
    && p[2] >= Math.max(p[1], p[4]) && p[3] > 0 && p[3] <= Math.min(p[1], p[4]) && p[5] >= 0;
}
export async function readCandles(file, from = -Infinity, to = Infinity) {
  const data = new CandleSeries(), digest = createHash('sha256');
  let carry = '', invalidRows = 0, duplicateRows = 0, gaps = 0, quoteRows = 0, previous = -Infinity;
  const availableRows = Object.fromEntries(FIELDS.slice(6).map(k => [k, 0]));
  const consume = line => {
    if (!line.trim()) return;
    let p; try { p = parseLine(line); } catch { invalidRows++; return; }
    if (!p) return;
    if (!valid(p)) { invalidRows++; return; }
    if (p[0] < previous) throw new Error(`${path.basename(file)} K线未按时间排序`);
    if (p[0] === previous) { duplicateRows++; return; }
    previous = p[0];
    if (p[0] < from || p[0] >= to) return;
    if (data.length && p[0] !== data.time(data.length - 1) + MINUTE) gaps++;
    if (Number.isFinite(p[6])) quoteRows++;
    for (let k = 6; k < FIELDS.length; k++) if (Number.isFinite(p[k])) availableRows[FIELDS[k]]++;
    data.push(p);
  };
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 1024 * 1024 })) {
    digest.update(chunk);
    const parts = (carry + chunk.toString('utf8')).split('\n'); carry = parts.pop();
    for (const line of parts) consume(line);
  }
  consume(carry);
  return { data, quality: { sha256: digest.digest('hex'), invalidRows, duplicateRows, gapRuns: gaps, quoteRows, availableRows } };
}
export function resample(series, interval) {
  const ms = duration(interval); if (ms === MINUTE) return series;
  const out = new CandleSeries(Math.max(64, Math.ceil(series.length * MINUTE / ms)));
  let bucket = -1, values, count = 0, previous;
  const flush = () => { if (values && count === ms / MINUTE && previous === bucket + ms - MINUTE) out.push(values); };
  for (let i = 0; i < series.length; i++) {
    const t = series.time(i), b = Math.floor(t / ms) * ms;
    if (b !== bucket) { flush(); bucket = b; count = 0; values = FIELDS.map((_, k) => series.columns[k][i]); values[0] = b; }
    else {
      values[2] = Math.max(values[2], series.columns[2][i]); values[3] = Math.min(values[3], series.columns[3][i]);
      values[4] = series.columns[4][i];
      for (let k = 5; k < FIELDS.length; k++) values[k] += series.columns[k][i];
    }
    if (t === bucket + count * MINUTE) count++; else count = -1e9;
    previous = t;
  }
  flush(); return out;
}
export function closedWindow(series, interval, time, count) {
  const ms = duration(interval), end = series.lowerBound(Math.floor(time / ms) * ms);
  if (end < count) return null;
  const first = end - count;
  if (series.time(end - 1) + ms !== Math.floor(time / ms) * ms || series.time(end - 1) - series.time(first) !== (count - 1) * ms) return null;
  return series.slice(first, end);
}
export function findFiles(c) {
  const result = new Map();
  for (const directory of [...c.data.legacyDirectories, c.data.directory]) {
    const dir = abs(path.join(directory, 'klines'));
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) if (/^[\p{L}\p{N}_]+USDT\.(ndjson|csv)$/u.test(name))
      result.set(name.replace(/\.(ndjson|csv)$/, ''), path.join(dir, name));
  }
  return result;
}
export function selectedSymbols(c, files = findFiles(c)) {
  const symbols = c.data.symbols === 'all' ? [...files.keys()] : c.data.symbols;
  if (!Array.isArray(symbols) || !symbols.length) throw new Error('没有币种；先运行 data，或指定已有数据的目录和币种');
  return [...new Set(symbols.map(x => String(x).toUpperCase()))].sort();
}
export function fileFingerprint(file) {
  if (!file || !fs.existsSync(file)) return null;
  const s = fs.statSync(file); return { file: path.relative(abs('.'), file).replaceAll('\\', '/'), bytes: s.size, modifiedMs: s.mtimeMs };
}
export function coverage(series, c, quality) {
  const from = Date.parse(c.period.from), to = Date.parse(c.period.to);
  const a = series.lowerBound(from), b = series.lowerBound(to), bars = b - a;
  const first = bars ? series.time(a) : null, last = bars ? series.time(b - 1) + MINUTE : null;
  const observedDays = bars * MINUTE / DAY, ratio = bars / ((to - from) / MINUTE);
  const historyStatus = ratio >= c.data.minCoverage ? 'full_history' : 'partial_history';
  const eligible = bars > 0 && observedDays >= c.data.minObservedDays && (historyStatus === 'full_history' || c.data.allowPartialHistory);
  return { bars, requestedBars: (to - from) / MINUTE, coverage: ratio, observedDays,
    first: first == null ? null : new Date(first).toISOString(), last: last == null ? null : new Date(last).toISOString(),
    historyStatus, eligible, reason: eligible ? null : bars === 0 ? 'no_data_in_period'
      : observedDays < c.data.minObservedDays ? 'insufficient_observed_days' : 'coverage_below_threshold',
    quality, missingFields: FIELDS.slice(6).filter(k => (quality.availableRows?.[k] ?? 0) < series.length) };
}
function unzip(buf) {
  let end = buf.length - 22;
  while (end >= Math.max(0, buf.length - 65557) && buf.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < Math.max(0, buf.length - 65557)) throw new Error('ZIP 中央目录缺失');
  const cd = buf.readUInt32LE(end + 16);
  if (buf.readUInt32LE(cd) !== 0x02014b50) throw new Error('ZIP 中央目录无效');
  const size = buf.readUInt32LE(cd + 20), offset = buf.readUInt32LE(cd + 42), method = buf.readUInt16LE(cd + 10);
  const start = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
  if (start + size > buf.length) throw new Error('ZIP 长度异常');
  const raw = buf.subarray(start, start + size);
  if (![0, 8].includes(method)) throw new Error(`ZIP 压缩方式 ${method} 不支持`);
  return (method === 8 ? zlib.inflateRawSync(raw) : raw).toString('utf8');
}
function client(c) {
  const proxy = c.data.proxy || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  const dispatcher = proxy ? new ProxyAgent(proxy) : undefined;
  return { dispatcher, async get(url, optional = false) {
    let error;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await request(url, { dispatcher, headersTimeout: 30000, bodyTimeout: 45000 });
        const bytes = Buffer.from(await res.body.arrayBuffer());
        if (optional && res.statusCode === 404) return null;
        if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}`);
        return bytes;
      } catch (e) { error = e; if (attempt < 2) await new Promise(r => setTimeout(r, 500 * 2 ** attempt)); }
    }
    // Do not log signed URLs, proxy credentials or exchange config.
    throw new Error(`公共行情请求失败：${error.code || error.message}`);
  } };
}
async function archiveSymbols(net) {
  const names = new Set(); let marker = '';
  do {
    const u = new URL('https://s3-ap-northeast-1.amazonaws.com/data.binance.vision');
    u.searchParams.set('prefix', 'data/futures/um/monthly/klines/'); u.searchParams.set('delimiter', '/');
    if (marker) u.searchParams.set('marker', marker);
    const xml = (await net.get(u.toString())).toString('utf8');
    const prefixes = [...xml.matchAll(/<CommonPrefixes>\s*<Prefix>([^<]+)<\/Prefix>\s*<\/CommonPrefixes>/g)].map(m => m[1]);
    for (const prefix of prefixes) { const name = prefix.split('/').at(-2); if (/^[\p{L}\p{N}_]+USDT$/u.test(name)) names.add(name); }
    marker = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? /<NextMarker>([^<]+)<\/NextMarker>/.exec(xml)?.[1] || prefixes.at(-1) : '';
    if (!marker && /<IsTruncated>true<\/IsTruncated>/.test(xml)) throw new Error('历史币种列表分页标记缺失');
  } while (marker);
  return [...names];
}
async function archiveMonths(net, symbol) {
  const months = new Set(); let marker = '';
  do {
    const u = new URL('https://s3-ap-northeast-1.amazonaws.com/data.binance.vision');
    u.searchParams.set('prefix', `data/futures/um/monthly/klines/${symbol}/1m/`);
    if (marker) u.searchParams.set('marker', marker);
    const xml = (await net.get(u.toString())).toString('utf8');
    const keys = [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map(m => m[1]);
    for (const key of keys) {
      const date = /-1m-(\d{4}-\d{2})\.zip$/.exec(key)?.[1];
      if (date) months.add(date);
    }
    marker = /<IsTruncated>true<\/IsTruncated>/.test(xml)
      ? /<NextMarker>([^<]+)<\/NextMarker>/.exec(xml)?.[1] || keys.at(-1) : '';
    if (!marker && /<IsTruncated>true<\/IsTruncated>/.test(xml)) throw new Error('月归档分页标记缺失');
  } while (marker);
  return [...months].sort();
}
export async function downloadData(c, log = console.log) {
  const net = client(c), directory = abs(c.data.directory), previousFiles = findFiles(c);
  const market = new BinanceClient({ demo: false, proxyUrl: c.data.proxy || process.env.HTTPS_PROXY || process.env.HTTP_PROXY });
  fs.mkdirSync(path.join(directory, 'klines'), { recursive: true });
  const from = Date.parse(c.period.from) - c.period.warmupDays * DAY, to = Date.parse(c.period.to);
  let universe = c.data.symbols, universeWarnings = [], currentContracts = new Map();
  try {
    try {
      const exchange = await market.exchangeInfo();
      currentContracts = new Map(exchange.symbols.filter(s => s.quoteAsset === 'USDT' && s.contractType === 'PERPETUAL').map(s => [s.symbol, s]));
    } catch (e) { if (universe === 'all') throw e; universeWarnings.push('current_contract_inventory_unavailable'); }
    if (universe === 'all') {
      const archived = await archiveSymbols(net);
      universe = [...new Set([...archived, ...currentContracts.keys(), ...previousFiles.keys()])].sort();
    }
    if (!Array.isArray(universe) || !universe.length) throw new Error('数据源返回的币种列表为空');
    const result = [], queue = [...universe];
    async function worker() {
      for (;;) {
        const symbol = queue.shift(); if (!symbol) return;
        try {
          if (!/^[\p{L}\p{N}_]+USDT$/u.test(symbol)) throw new Error('币种名无效');
          const outputFile = path.join(directory, 'klines', `${symbol}.ndjson`), provenanceFile = path.join(directory, 'provenance', `${symbol}.json`);
          if (fs.existsSync(provenanceFile) && fs.existsSync(outputFile)) {
            const saved = JSON.parse(fs.readFileSync(provenanceFile, 'utf8'));
            if (saved.from === new Date(from).toISOString() && saved.to === c.period.to
              && saved.checksumPolicy === c.data.verifyChecksums && saved.outputFingerprint
              && JSON.stringify(saved.outputFingerprint) === JSON.stringify(fileFingerprint(outputFile))) {
              result.push({ symbol, bars: saved.bars, status: saved.bars ? 'cached_verified_download' : 'no_history_in_period', missingArchives: saved.missingArchives.length });
              writeJSON(path.join(directory, 'download-status.json'), { complete: false, completed: result.length, total: universe.length, result });
              log(`[data] ${result.length}/${universe.length} ${symbol}: cached`); continue;
            }
          }
          const rows = new Map(), provenance = [], missingArchives = [], months = await archiveMonths(net, symbol);
          const existing = previousFiles.get(symbol);
          if (existing) {
            const old = await readCandles(existing, from, to);
            for (let i = 0; i < old.data.length; i++) rows.set(old.data.time(i), old.data.at(i));
            provenance.push({ source: 'legacy-or-existing', ...fileFingerprint(existing), sha256: old.quality.sha256 });
          }
          // Completed calendar months use monthly packs; missing monthly packs fall back to daily packs.
          // Avoid probing every pre-listing day or years after a delisting with thousands of 404 requests.
          const contract = currentContracts.get(symbol), active = contract?.status === 'TRADING';
          const firstMonth = months[0] ? Date.parse(`${months[0]}-01T00:00:00Z`) : Number(contract?.onboardDate || to);
          const lastMonth = months.at(-1) ? new Date(`${months.at(-1)}-01T00:00:00Z`) : null;
          const archiveEnd = !active && lastMonth
            ? Math.min(to, Date.UTC(lastMonth.getUTCFullYear(), lastMonth.getUTCMonth() + 2, 1)) : to;
          let cursor = Math.floor(Math.max(from, firstMonth) / DAY) * DAY;
          const archive = async (kind, date) => {
            const name = `${symbol}-1m-${date}.zip`, base = `https://data.binance.vision/data/futures/um/${kind}/klines/${symbol}/1m/${name}`;
            const local = path.join(directory, 'archives', symbol, name), checksumFile = `${local}.CHECKSUM`;
            let bytes = fs.existsSync(local) ? fs.readFileSync(local) : await net.get(base, true);
            if (!bytes) return false;
            const sha256 = createHash('sha256').update(bytes).digest('hex');
            if (c.data.verifyChecksums) {
              const checksum = fs.existsSync(checksumFile) ? fs.readFileSync(checksumFile) : await net.get(`${base}.CHECKSUM`);
              if (checksum.toString().trim().split(/\s+/)[0] !== sha256) throw new Error(`${name} SHA256 校验失败`);
              fs.mkdirSync(path.dirname(local), { recursive: true }); fs.writeFileSync(checksumFile, checksum);
            }
            fs.mkdirSync(path.dirname(local), { recursive: true }); if (!fs.existsSync(local)) fs.writeFileSync(local, bytes);
            for (const line of unzip(bytes).split('\n')) { const p = parseLine(line); if (valid(p) && p[0] >= from && p[0] < to) rows.set(p[0], Object.fromEntries(FIELDS.map((k, i) => [k, p[i]]))); }
            provenance.push({ source: base, sha256, checksumVerified: c.data.verifyChecksums }); return true;
          };
          while (cursor < archiveEnd) {
            const date = new Date(cursor), monthEnd = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
            const month = date.toISOString().slice(0, 7), stop = Math.min(monthEnd, archiveEnd);
            if (months.includes(month) && await archive('monthly', month)) { cursor = stop; continue; }
            while (cursor < stop) {
              const day = new Date(cursor).toISOString().slice(0, 10);
              if (!(await archive('daily', day))) missingArchives.push(day);
              cursor += DAY;
            }
          }
          // REST only fills dates where archive coverage is missing; all rows remain closed candles.
          if (c.data.restFallback) for (const day of missingArchives.filter(d => Date.parse(`${d}T00:00:00Z`) >= to - c.data.restLookbackDays * DAY)) {
            const a = Math.max(from, Date.parse(`${day}T00:00:00Z`)), b = Math.min(to, Date.parse(`${day}T00:00:00Z`) + DAY);
            for (let t = a; t < b;) {
              let page;
              try { page = await market.publicRequest('/fapi/v1/klines', { symbol, interval: '1m', startTime: t, endTime: b - 1, limit: 1000 }); }
              catch (e) { provenance.push({ source: 'REST', date: day, error: e.code || 'public_market_unavailable' }); break; }
              if (!Array.isArray(page) || !page.length) break;
              for (const entry of page) { const p = parseLine(entry.join(',')); if (valid(p) && p[0] >= from && p[0] < to) rows.set(p[0], Object.fromEntries(FIELDS.map((k, i) => [k, p[i]]))); }
              const next = Number(page.at(-1)[0]) + MINUTE; if (next <= t) break; t = next;
            }
          }
          const file = path.join(directory, 'klines', `${symbol}.ndjson`), temp = `${file}.tmp`, fd = fs.openSync(temp, 'w');
          try {
            let chunk = '';
            for (const t of [...rows.keys()].sort((a, b) => a - b)) {
              const r = rows.get(t);
              chunk += `${[t, r.open, r.high, r.low, r.close, r.volume, t + MINUTE - 1, r.quoteVolume, r.tradeCount, r.takerBuyVolume, r.takerBuyQuoteVolume, 0].map(x => Number.isFinite(x) ? x : '').join(',')}\n`;
              if (chunk.length > 1024 * 1024) { fs.writeSync(fd, chunk); chunk = ''; }
            }
            if (chunk) fs.writeSync(fd, chunk);
          } finally { fs.closeSync(fd); }
          fs.renameSync(temp, file);
          writeJSON(provenanceFile, { symbol, from: new Date(from).toISOString(), to: c.period.to, provenance, missingArchives,
            bars: rows.size, checksumPolicy: c.data.verifyChecksums, outputFingerprint: fileFingerprint(file), archiveMonths: months });
          result.push({ symbol, bars: rows.size, status: rows.size ? 'downloaded' : 'no_history_in_period', missingArchives: missingArchives.length });
        } catch (e) { result.push({ symbol, status: 'error', error: e.message }); }
        writeJSON(path.join(directory, 'download-status.json'), { complete: false, completed: result.length, total: universe.length, result });
        log(`[data] ${result.length}/${universe.length} ${symbol}: ${result.at(-1).status}`);
      }
    }
    await Promise.all(Array.from({ length: Math.min(c.data.downloadWorkers, universe.length) }, worker));
    const manifest = { generatedAt: new Date().toISOString(), market: c.data.market, from: c.period.from, to: c.period.to,
      loadFrom: new Date(from).toISOString(), symbols: result.sort((a, b) => a.symbol.localeCompare(b.symbol)), universeWarnings,
      historicalUniverseIncluded: c.data.symbols === 'all', complete: result.every(r => r.status !== 'error'), fingerprint: hash(result) };
    writeJSON(path.join(directory, 'meta.json'), manifest); writeJSON(path.join(directory, 'download-status.json'), manifest);
    return manifest;
  } finally { await Promise.all([net.dispatcher?.close(), market.dispatcher?.close()]); }
}
