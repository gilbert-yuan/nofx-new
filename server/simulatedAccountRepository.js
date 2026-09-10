import { isDeepStrictEqual } from 'node:util';

// Every business field below is a real SQL column. Array members are child rows.
// The two extension tables preserve null/empty containers and uncommon extra
// scalar fields without putting an order, plan or history in a JSON column.
const fields = (text = '', number = '', boolean = '', timestamp = '') => [
  ...text.split(' ').filter(Boolean).map(key => [key, 'TEXT']),
  ...number.split(' ').filter(Boolean).map(key => [key, 'DOUBLE PRECISION']),
  ...boolean.split(' ').filter(Boolean).map(key => [key, 'BOOLEAN']),
  ...timestamp.split(' ').filter(Boolean).map(key => [key, 'TIMESTAMPTZ'])
];
const snake = name => name.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`);
// Legacy expiry columns/status are retained only to round-trip historical records.
// New plans and orders do not generate or enforce entry deadlines.
const planFields = fields('entryRule', 'entryMin entryMax stopLoss takeProfit validForBars maxHoldBars netRewardRisk');
const jobFields = fields('owner runId engine', 'index total held failed updated eligible submitted startedAt finishedAt leaseUntil nextAt', 'running');
const orderFields = fields('id recordId symbol interval direction status marketProvider error reason lastReviewRunId',
  'margin leverage notional entry entryFee quantity exit gross fees funding net roi markPrice unrealized liquidationPrice heldBars nextTime isolatedLossAdjustment',
  'automatic ambiguousBar', 'createdAt entryAt exitAt expiresAt markAt');

const definitions = [
  { name: 'simulated_accounts', fields: fields('', 'initialBalance', 'unlimitedCapital'), root: [] },
  { name: 'simulated_orders', order: true, fields: orderFields, root: [] },
  { name: 'simulated_order_plans', order: true, key: 'plan_kind', variants: { current: ['plan'], initial: ['initialPlan'], signal: ['analysisContext', 'signal', 'plan'] }, fields: planFields },
  { name: 'simulated_order_costs', order: true, root: ['costs'], fields: fields('', 'feeBps slippageBps fundingBpsPer8h notional') },
  { name: 'simulated_order_analysis', order: true, root: ['analysisContext'], fields: fields('strategyVersion analysisEngine confidenceType reason risk automationRunId', 'confidence', '', 'dataAsOf') },
  { name: 'simulated_order_signals', order: true, root: ['analysisContext', 'signal'], fields: fields('symbol exchange marketProvider interval positionRecommendation action confidenceType reason risk suggestion analysisEngine',
    'confidence recommendedLeverage', 'eligible', 'dataAsOf generatedAt firstEntryAt expiresAt') },
  { name: 'simulated_order_scopes', order: true, root: ['analysisContext', 'scope'], fields: fields('interval engine symbolsText', 'limit maxSymbols batchSize') },
  { name: 'simulated_order_scope_symbols', order: true, root: ['analysisContext', 'scope', 'symbols'], list: true, scalar: true, fields: fields('value') },
  { name: 'simulated_order_validation_issues', order: true, key: 'source', variants: { context: ['analysisContext', 'validationIssues'], signal: ['analysisContext', 'signal', 'validationIssues'] }, list: true, scalar: true, fields: fields('value') },
  { name: 'simulated_order_protection_revisions', order: true, root: ['protectionRevisions'], list: true, fields: fields('', 'stopLoss takeProfit effectiveFrom', '', 'at') },
  { name: 'simulated_order_reviews', order: true, root: ['reviewHistory'], list: true, fields: [
    ...fields('engine action reason', 'stopLoss takeProfit effectiveFrom confidence', '', 'at'),
    ['previous.stopLoss', 'DOUBLE PRECISION'], ['previous.takeProfit', 'DOUBLE PRECISION']
  ] },
  { name: 'simulated_automation_settings', root: ['automation'], fields: fields('engine interval', 'version margin', 'enabled') },
  { name: 'simulated_automation_jobs', key: 'job_kind', variants: { scan: ['automation', 'scan'], review: ['automation', 'review'] }, fields: jobFields },
  { name: 'simulated_automation_symbols', key: 'job_kind', variants: { scan: ['automation', 'scan', 'symbols'], review: ['automation', 'review', 'symbols'] }, list: true, scalar: true, fields: fields('value') },
  { name: 'simulated_automation_errors', key: 'job_kind', variants: { scan: ['automation', 'scan', 'errors'], review: ['automation', 'review', 'errors'] }, list: true, scalar: true, fields: fields('value') }
];
const extensionColumns = [['path', 'TEXT[]'], ['value_kind', 'TEXT'], ['text_value', 'TEXT'], ['number_value', 'DOUBLE PRECISION'], ['boolean_value', 'BOOLEAN']];
const columnsFor = def => [
  ['account_id', 'INTEGER'], ...(def.order ? [['order_id', 'TEXT']] : []),
  ...(def.key ? [[def.key, 'TEXT']] : []), ...(def.list ? [['sequence', 'INTEGER']] : []),
  ...(def.name === 'simulated_orders' ? [['order_position', 'INTEGER']] : []),
  ...(def.extension ? extensionColumns : def.fields.filter(([key]) => !(def.name === 'simulated_orders' && key === 'id')).map(([key, type]) => [snake(key.replaceAll('.', '_')), type]))
];
const allDefinitions = [...definitions,
  { name: 'simulated_account_extensions', extension: true },
  { name: 'simulated_order_extensions', order: true, extension: true }
];
const primaryKeys = def => ['account_id', ...(def.order ? ['order_id'] : []), ...(def.key ? [def.key] : []), ...(def.list ? ['sequence'] : []), ...(def.extension ? ['path'] : [])];
const quote = value => `"${value}"`;

export const simulatedAccountSchema = allDefinitions.map(def => {
  const keys = primaryKeys(def);
  const columns = columnsFor(def).map(([name, type]) => `${quote(name)} ${type}${keys.includes(name) ? ' NOT NULL' : ''}`);
  columns.push(`PRIMARY KEY (${keys.map(quote).join(',')})`);
  if (def.name === 'simulated_accounts') columns.push('CHECK (account_id = 1)');
  else if (def.order && def.name !== 'simulated_orders') columns.push('FOREIGN KEY (account_id, order_id) REFERENCES simulated_orders(account_id, order_id) ON DELETE CASCADE');
  else columns.push('FOREIGN KEY (account_id) REFERENCES simulated_accounts(account_id) ON DELETE CASCADE');
  if (['simulated_automation_symbols', 'simulated_automation_errors'].includes(def.name)) {
    columns.push('FOREIGN KEY (account_id, job_kind) REFERENCES simulated_automation_jobs(account_id, job_kind) ON DELETE CASCADE');
  }
  if (def.name === 'simulated_orders') {
    columns.push("CHECK (status IN ('pending','open','closed','expired','cancelled'))");
    columns.push("CHECK (direction IN ('OPEN_LONG','OPEN_SHORT'))");
  }
  if (def.extension) columns.push("CHECK (value_kind IN ('object','array','null','string','number','boolean'))");
  return `CREATE TABLE IF NOT EXISTS ${def.name} (${columns.join(',\n')});`;
}).join('\n') + `
CREATE INDEX IF NOT EXISTS simulated_orders_active_idx ON simulated_orders(account_id, next_time) WHERE status IN ('pending','open');
CREATE INDEX IF NOT EXISTS simulated_orders_symbol_idx ON simulated_orders(account_id, symbol, created_at DESC);
CREATE INDEX IF NOT EXISTS simulated_orders_record_idx ON simulated_orders(account_id, record_id, symbol);
CREATE INDEX IF NOT EXISTS simulated_orders_closed_idx ON simulated_orders(account_id, exit_at DESC) WHERE status = 'closed';
CREATE INDEX IF NOT EXISTS simulated_order_analysis_strategy_idx ON simulated_order_analysis(strategy_version, analysis_engine);
CREATE TABLE IF NOT EXISTS simulated_account_migrations (
  version INTEGER PRIMARY KEY, migrated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source_order_count INTEGER NOT NULL, source_digest TEXT NOT NULL
);
`;

const get = (obj, path) => path.reduce((value, key) => value?.[key], obj);
function put(obj, path, value) {
  let target = obj;
  for (const key of path.slice(0, -1)) {
    if (!Object.hasOwn(target, key)) Object.defineProperty(target, key, { value: {}, enumerable: true, writable: true, configurable: true });
    target = target[key];
  }
  Object.defineProperty(target, path.at(-1), { value, enumerable: true, writable: true, configurable: true });
}
function scalarFits(value, type) {
  return type === 'DOUBLE PRECISION' ? typeof value === 'number' && Number.isFinite(value)
    : type === 'BOOLEAN' ? typeof value === 'boolean'
      : type === 'TIMESTAMPTZ' ? typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
        : typeof value === 'string';
}

// A pure projection is shared by migration, verification and incremental writes.
export function projectAccount(state) {
  const rows = Object.fromEntries(allDefinitions.map(def => [def.name, []]));
  const orders = state.orders || [];
  if (!Array.isArray(orders)) throw new Error('orders must be an array');
  const ids = new Set();
  for (const order of orders) {
    if (typeof order.id !== 'string' || !order.id || ids.has(order.id)) throw new Error('Missing or duplicate simulated order ID');
    ids.add(order.id);
  }
  const projectOwner = (owner, orderId, orderPosition) => {
    const mapped = new Set();
    for (const def of definitions.filter(d => !!d.order === (orderId !== undefined))) {
      const variants = def.variants || { '': def.root };
      for (const [variant, root] of Object.entries(variants)) {
        const object = get(owner, root);
        if (object === undefined || object === null) continue;
        const items = def.list ? (Array.isArray(object) ? object : []) : [object];
        items.forEach((item, sequence) => {
          const row = { account_id: 1 };
          if (def.order) row.order_id = orderId;
          if (def.key) row[def.key] = variant;
          if (def.list) row.sequence = sequence;
          if (def.name === 'simulated_orders') row.order_position = orderPosition;
          for (const [key, type] of def.fields) {
            const path = [...root, ...(def.list ? [String(sequence)] : []), ...(def.scalar ? [] : key.split('.'))];
            const value = def.scalar ? item : get(item, key.split('.'));
            if (scalarFits(value, type)) {
              mapped.add(JSON.stringify(path));
              if (!(def.name === 'simulated_orders' && key === 'id')) row[snake(key.replaceAll('.', '_'))] = value;
            }
          }
          rows[def.name].push(row);
        });
      }
    }
    const walk = (value, path) => {
      if (value === undefined) return;
      if (value !== null && typeof value === 'object') {
        if (path.length) addExtension(Array.isArray(value) ? 'array' : 'object', path);
        for (const [key, child] of Object.entries(value)) walk(child, [...path, key]);
      } else if (!mapped.has(JSON.stringify(path))) {
        const kind = value === null ? 'null' : typeof value;
        if (kind === 'number' && !Number.isFinite(value)) {
          // 防御：上游可能因"立即触发/未触发"输出 Infinity/NaN；降级为 null 并 warn，不阻塞整体持久化
          console.warn(`[simulatedAccountRepository] 非有限数值 ${path.join('.')}=${value}，已降级为 null`);
          addExtension('null', path, null);
        } else if (!['null', 'string', 'number', 'boolean'].includes(kind)) {
          throw new Error(`Unsupported state value at ${path.join('.')}`);
        } else {
          addExtension(kind, path, value);
        }
      }
    };
    const addExtension = (kind, path, value) => rows[orderId === undefined ? 'simulated_account_extensions' : 'simulated_order_extensions'].push({
      account_id: 1, ...(orderId === undefined ? {} : { order_id: orderId }), path, value_kind: kind,
      ...(kind === 'string' ? { text_value: value } : kind === 'number' ? { number_value: value } : kind === 'boolean' ? { boolean_value: value } : {})
    });
    walk(owner, []);
  };
  const { orders: ignored, ...account } = state;
  projectOwner(account);
  orders.forEach((order, position) => projectOwner(order, order.id, position));
  return rows;
}

export function hydrateAccount(tables) {
  const state = {};
  const orders = new Map((tables.simulated_orders || []).map(row => [row.order_id, { id: row.order_id }]));
  for (const name of ['simulated_account_extensions', 'simulated_order_extensions']) {
    for (const row of [...(tables[name] || [])].sort((a, b) => a.path.length - b.path.length)) {
      const owner = row.order_id === undefined ? state : orders.get(row.order_id);
      if (!owner) continue;
      const value = row.value_kind === 'object' ? {} : row.value_kind === 'array' ? [] : row.value_kind === 'null' ? null
        : row.value_kind === 'string' ? row.text_value : row.value_kind === 'number' ? row.number_value : row.boolean_value;
      put(owner, row.path, value);
    }
  }
  for (const def of definitions) {
    for (const row of tables[def.name] || []) {
      const owner = def.order ? orders.get(row.order_id) : state;
      if (!owner) continue;
      const root = def.variants ? def.variants[row[def.key]] : def.root;
      for (const [key, type] of def.fields) {
        if (def.name === 'simulated_orders' && key === 'id') continue;
        let value = row[snake(key.replaceAll('.', '_'))];
        if (value === null || value === undefined) continue;
        if (type === 'TIMESTAMPTZ') value = new Date(value).toISOString();
        const path = [...root, ...(def.list ? [String(row.sequence)] : []), ...(def.scalar ? [] : key.split('.'))];
        put(owner, path, value);
      }
    }
  }
  state.orders = [...(tables.simulated_orders || [])].sort((a, b) => a.order_position - b.order_position).map(row => orders.get(row.order_id));
  return state;
}

const rowKey = (def, row) => JSON.stringify(primaryKeys(def).map(key => row[key]));
const comparable = (def, row) => Object.fromEntries(columnsFor(def).map(([key]) => [key, row[key] ?? null]));

/** 大表（行数 ≥ 此阈值）改用分桶快速 diff */
const FAST_DIFF_MIN_ROWS = 500;

/** 整桶签名：用原生 JSON.stringify 代替 JS 层递归深比较，快一个数量级 */
const bucketSignature = (def, rows) => JSON.stringify(rows.map((row) => comparable(def, row)));

/**
 * 按 order_id 分桶的差异计算。
 *
 * 背景：simulated_order_extensions 已达 9 万行，而每次 mutate 只会改动极少数订单。
 * 原先对全部行逐行执行 comparable() + isDeepStrictEqual（JS 层递归），实测占
 * mutate 总耗时的 ~80%（约 15s/次），直接把事件循环堵死、导致 API 响应数秒。
 *
 * 优化：先按 order_id 分桶，用原生序列化做整桶签名比较；整桶未变则跳过该桶所有行。
 * 只有签名不同的桶才回退到逐行深比较，语义与原来完全一致。
 */
function diffRowsByBucket(def, previousRows, nextRows) {
  const bucketBy = (rows) => {
    const map = new Map();
    for (const row of rows) {
      const key = row.order_id;
      let list = map.get(key);
      if (!list) { list = []; map.set(key, list); }
      list.push(row);
    }
    return map;
  };
  const prevBuckets = bucketBy(previousRows);
  const nextBuckets = bucketBy(nextRows);
  const changed = [];

  for (const [orderId, rows] of nextBuckets) {
    const prevRows = prevBuckets.get(orderId);
    // 行数相同且整桶签名一致 ⇒ 该订单这部分数据完全没变
    if (prevRows && prevRows.length === rows.length && bucketSignature(def, prevRows) === bucketSignature(def, rows)) continue;
    const old = new Map((prevRows || []).map((row) => [rowKey(def, row), comparable(def, row)]));
    for (const row of rows) {
      if (!isDeepStrictEqual(old.get(rowKey(def, row)), comparable(def, row))) changed.push(row);
    }
  }
  return changed;
}
async function insertRows(client, def, rows) {
  const columns = columnsFor(def).map(([name]) => name);
  const keys = primaryKeys(def);
  const updates = columns.filter(c => !keys.includes(c)).map(c => `${quote(c)}=EXCLUDED.${quote(c)}`);
  for (let offset = 0; offset < rows.length; offset += 200) {
    const values = [];
    const tuples = rows.slice(offset, offset + 200).map(row => '(' + columns.map(column => { values.push(row[column] ?? null); return `$${values.length}`; }).join(',') + ')');
    await client.query(`INSERT INTO ${def.name} (${columns.map(quote).join(',')}) VALUES ${tuples.join(',')}
      ON CONFLICT (${keys.map(quote).join(',')}) ${updates.length ? `DO UPDATE SET ${updates.join(',')}` : 'DO NOTHING'}`, values);
  }
}

export class SimulatedAccountRepository {
  constructor(pool) { this.pool = pool; }
  async init() {
    const result = await this.pool.query("SELECT to_regclass('simulated_accounts') AS accounts, to_regclass('simulated_account') AS legacy");
    if (!result.rows[0].accounts) {
      if (result.rows[0].legacy) throw new Error('Run npm run migrate:simulated-account before starting the API.');
      await this.pool.query(simulatedAccountSchema);
      await this.pool.query('INSERT INTO simulated_accounts(account_id,initial_balance) VALUES(1,10000) ON CONFLICT DO NOTHING');
    }
    if (!(await this.pool.query('SELECT 1 FROM simulated_accounts WHERE account_id=1')).rowCount) throw new Error('Normalized simulated account is not initialized');
  }
  /**
   * @param {object} options
   * @param {boolean} [options.summary] 只加载摘要所需的少量表
   * @param {string} [options.orderId] 只加载指定订单（订单级表）
   * @param {boolean} [options.light] 轻量模式：订单级明细表（extensions/reviews/plans…）
   *   只加载「活跃订单」的数据。历史（已平仓）订单的明细不参与读取与写回。
   *
   *   背景：simulated_order_extensions 已达 9 万行，其中已平仓订单占 99.6%，
   *   而每次 mutate 要把它们全部读出、深拷贝、逐行深比较，实测单次阻塞 8~19 秒，
   *   是 API 整体变慢的根因。
   *
   *   安全性：writeChanges 的删除只针对 previous 中出现的行；轻量模式下未加载的
   *   历史行既不在 previous 也不在 next，因此不会被误删，也不会被重新插入。
   *   代价是 mutate 回调内读不到历史订单的明细，故仅限确认不需要历史数据的写路径使用。
   */
  async readFrom(client, { summary = false, orderId, light = false } = {}) {
    const tables = {};
    const summaryTables = new Set(['simulated_accounts', 'simulated_orders', 'simulated_order_costs', 'simulated_order_plans', 'simulated_automation_settings', 'simulated_automation_jobs', 'simulated_account_extensions']);
    let activeOrderIds = null;
    if (light) {
      const res = await client.query(
        `SELECT order_id FROM simulated_orders WHERE account_id=1 AND status IN ('pending','open')`
      );
      activeOrderIds = res.rows.map(row => row.order_id);
    }
    for (const def of allDefinitions) {
      if (summary && !summaryTables.has(def.name)) continue;
      const filterOrder = orderId !== undefined && def.order;
      // 订单主表始终全量（业务逻辑需遍历/查找全部订单）；只有明细子表才按需裁剪
      const childTable = def.order && def.name !== 'simulated_orders';
      let sql = `SELECT * FROM ${def.name} WHERE account_id=1`;
      const params = [];
      if (filterOrder) {
        sql += ' AND order_id=$1';
        params.push(orderId);
      } else if (light && childTable) {
        sql += ' AND order_id = ANY($1::text[])';
        params.push(activeOrderIds);
      }
      if (summary && def.name === 'simulated_order_plans') sql += " AND plan_kind='current'";
      tables[def.name] = (await client.query(sql, params)).rows;
    }
    return hydrateAccount(tables);
  }
  async read(options) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const state = await this.readFrom(client, options);
      await client.query('COMMIT');
      return state;
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  async writeChanges(client, before, after) {
    const previous = before ? projectAccount(before) : Object.fromEntries(allDefinitions.map(def => [def.name, []]));
    const next = projectAccount(after);
    // Children first on removal; parents first on insertion. Only changed rows are written.
    for (const def of [...allDefinitions].reverse()) {
      const keep = new Set(next[def.name].map(row => rowKey(def, row)));
      for (const row of previous[def.name]) {
        if (keep.has(rowKey(def, row))) continue;
        const keys = primaryKeys(def);
        await client.query(`DELETE FROM ${def.name} WHERE ${keys.map((key, i) => `${quote(key)}=$${i + 1}`).join(' AND ')}`, keys.map(key => row[key]));
      }
    }
    for (const def of allDefinitions) {
      const nextRows = next[def.name];
      let changed;
      if (nextRows.length >= FAST_DIFF_MIN_ROWS && nextRows[0] && 'order_id' in nextRows[0]) {
        // 大表走分桶快路径：一次 mutate 通常只改动极少数订单，
        // 按 order_id 分桶后整桶签名相同即可跳过该桶全部行的逐行深比较。
        changed = diffRowsByBucket(def, previous[def.name], nextRows);
      } else {
        const old = new Map(previous[def.name].map(row => [rowKey(def, row), comparable(def, row)]));
        changed = nextRows.filter(row => !isDeepStrictEqual(old.get(rowKey(def, row)), comparable(def, row)));
      }
      await insertRows(client, def, changed);
    }
  }
  async mutate(fn, options = {}) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Preserve the existing account-wide transaction boundary for reservations,
      // job leases and concurrent reviews. No lost read/modify/write updates.
      await client.query('SELECT account_id FROM simulated_accounts WHERE account_id=1 FOR UPDATE');
      const before = await this.readFrom(client, options);
      const state = structuredClone(before);
      const result = await fn(state);
      await this.writeChanges(client, before, state);
      await client.query('COMMIT');
      return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
}
