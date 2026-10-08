use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use sqlx::{
    PgPool, Postgres, Transaction,
    postgres::{PgConnectOptions, PgPoolOptions, PgSslMode},
};
use std::{
    collections::{BTreeMap, BTreeSet},
    str::FromStr,
    time::Duration,
};

#[derive(Clone)]
pub struct Db {
    pub pool: PgPool,
}
#[derive(Clone)]
struct Def {
    name: &'static str,
    order: bool,
    key: Option<&'static str>,
    variants: Vec<(&'static str, Vec<&'static str>)>,
    list: bool,
    scalar: bool,
    fields: Vec<(&'static str, &'static str)>,
}
fn fields(
    text: &'static str,
    number: &'static str,
    boolean: &'static str,
    time: &'static str,
) -> Vec<(&'static str, &'static str)> {
    [
        (text, "TEXT"),
        (number, "DOUBLE PRECISION"),
        (boolean, "BOOLEAN"),
        (time, "TIMESTAMPTZ"),
    ]
    .into_iter()
    .flat_map(|(keys, ty)| keys.split_whitespace().map(move |key| (key, ty)))
    .collect()
}
fn def(
    name: &'static str,
    order: bool,
    root: Vec<&'static str>,
    f: Vec<(&'static str, &'static str)>,
) -> Def {
    Def {
        name,
        order,
        key: None,
        variants: vec![("", root)],
        list: false,
        scalar: false,
        fields: f,
    }
}
fn definitions() -> Vec<Def> {
    let mut d = vec![
        def(
            "simulated_accounts",
            false,
            vec![],
            fields("", "initialBalance", "unlimitedCapital", ""),
        ),
        def(
            "simulated_orders",
            true,
            vec![],
            fields(
                "id recordId symbol interval direction status marketProvider error reason lastReviewRunId",
                "margin leverage notional entry entryFee quantity exit gross fees funding net roi markPrice unrealized liquidationPrice heldBars nextTime isolatedLossAdjustment",
                "automatic ambiguousBar",
                "createdAt entryAt exitAt expiresAt markAt",
            ),
        ),
        def(
            "simulated_order_plans",
            true,
            vec![],
            fields(
                "entryRule",
                "entryMin entryMax stopLoss takeProfit validForBars maxHoldBars netRewardRisk",
                "",
                "",
            ),
        ),
        def(
            "simulated_order_costs",
            true,
            vec!["costs"],
            fields("", "feeBps slippageBps fundingBpsPer8h notional", "", ""),
        ),
        def(
            "simulated_order_analysis",
            true,
            vec!["analysisContext"],
            fields(
                "strategyVersion analysisEngine confidenceType reason risk automationRunId",
                "confidence",
                "",
                "dataAsOf",
            ),
        ),
        def(
            "simulated_order_signals",
            true,
            vec!["analysisContext", "signal"],
            fields(
                "symbol exchange marketProvider interval positionRecommendation action confidenceType reason risk suggestion analysisEngine",
                "confidence recommendedLeverage",
                "eligible",
                "dataAsOf generatedAt firstEntryAt expiresAt",
            ),
        ),
        def(
            "simulated_order_scopes",
            true,
            vec!["analysisContext", "scope"],
            fields(
                "interval engine symbolsText",
                "limit maxSymbols batchSize",
                "",
                "",
            ),
        ),
        def(
            "simulated_order_scope_symbols",
            true,
            vec!["analysisContext", "scope", "symbols"],
            fields("value", "", "", ""),
        ),
        def(
            "simulated_order_validation_issues",
            true,
            vec![],
            fields("value", "", "", ""),
        ),
        def(
            "simulated_order_protection_revisions",
            true,
            vec!["protectionRevisions"],
            fields("", "stopLoss takeProfit effectiveFrom", "", "at"),
        ),
        def(
            "simulated_order_reviews",
            true,
            vec!["reviewHistory"],
            fields(
                "engine action reason",
                "stopLoss takeProfit effectiveFrom confidence",
                "",
                "at",
            ),
        ),
        def(
            "simulated_automation_settings",
            false,
            vec!["automation"],
            fields("engine interval", "version margin", "enabled", ""),
        ),
        def(
            "simulated_automation_jobs",
            false,
            vec![],
            fields(
                "owner runId engine",
                "index total held failed updated eligible submitted startedAt finishedAt leaseUntil nextAt",
                "running",
                "",
            ),
        ),
        def(
            "simulated_automation_symbols",
            false,
            vec![],
            fields("value", "", "", ""),
        ),
        def(
            "simulated_automation_errors",
            false,
            vec![],
            fields("value", "", "", ""),
        ),
    ];
    d[2].key = Some("plan_kind");
    d[2].variants = vec![
        ("current", vec!["plan"]),
        ("initial", vec!["initialPlan"]),
        ("signal", vec!["analysisContext", "signal", "plan"]),
    ];
    d[7].list = true;
    d[7].scalar = true;
    d[8].key = Some("source");
    d[8].variants = vec![
        ("context", vec!["analysisContext", "validationIssues"]),
        (
            "signal",
            vec!["analysisContext", "signal", "validationIssues"],
        ),
    ];
    d[8].list = true;
    d[8].scalar = true;
    d[9].list = true;
    d[10].list = true;
    d[10].fields.extend([
        ("previous.stopLoss", "DOUBLE PRECISION"),
        ("previous.takeProfit", "DOUBLE PRECISION"),
    ]);
    for i in [12, 13, 14] {
        d[i].key = Some("job_kind");
        let suffix = if i == 13 {
            Some("symbols")
        } else if i == 14 {
            Some("errors")
        } else {
            None
        };
        d[i].variants = ["scan", "review"]
            .into_iter()
            .map(|kind| {
                let mut p = vec!["automation", kind];
                if let Some(s) = suffix {
                    p.push(s);
                }
                (kind, p)
            })
            .collect();
        if i > 12 {
            d[i].list = true;
            d[i].scalar = true;
        }
    }
    d
}
fn snake(s: &str) -> String {
    let mut result = String::new();
    for c in s.chars() {
        if c.is_uppercase() {
            result.push('_');
            result.extend(c.to_lowercase());
        } else if c == '.' {
            result.push('_')
        } else {
            result.push(c)
        }
    }
    result
}
fn columns(d: &Def) -> Vec<(String, &'static str)> {
    let mut c = vec![("account_id".to_owned(), "INTEGER")];
    if d.order {
        c.push(("order_id".to_owned(), "TEXT"));
    }
    if let Some(k) = d.key {
        c.push((k.to_owned(), "TEXT"));
    }
    if d.list {
        c.push(("sequence".to_owned(), "INTEGER"));
    }
    if d.name == "simulated_orders" {
        c.push(("order_position".to_owned(), "INTEGER"));
    }
    c.extend(
        d.fields
            .iter()
            .filter(|(k, _)| !(d.name == "simulated_orders" && *k == "id"))
            .map(|(k, t)| (snake(k), *t)),
    );
    c
}
fn keys(d: &Def) -> Vec<&str> {
    let mut k = vec!["account_id"];
    if d.order {
        k.push("order_id");
    }
    if let Some(key) = d.key {
        k.push(key);
    }
    if d.list {
        k.push("sequence");
    }
    k
}
impl Db {
    pub async fn connect() -> Result<Self> {
        let mut options = if let Ok(url) = std::env::var("DATABASE_URL") {
            PgConnectOptions::from_str(&url)?
        } else {
            PgConnectOptions::new()
                .host(&std::env::var("PGHOST").unwrap_or("127.0.0.1".into()))
                .port(
                    std::env::var("PGPORT")
                        .ok()
                        .and_then(|p| p.parse().ok())
                        .unwrap_or(5432),
                )
                .database(&std::env::var("PGDATABASE").unwrap_or("nofx_lite".into()))
                .username(&std::env::var("PGUSER").unwrap_or("postgres".into()))
                .password(&std::env::var("PGPASSWORD").unwrap_or_default())
        };
        options = options.ssl_mode(
            if matches!(
                std::env::var("PGSSL")
                    .unwrap_or_default()
                    .to_lowercase()
                    .as_str(),
                "1" | "true" | "yes" | "on"
            ) {
                PgSslMode::Require
            } else {
                PgSslMode::Disable
            },
        );
        let pool = PgPoolOptions::new()
            .max_connections(12)
            .acquire_timeout(Duration::from_secs(10))
            .connect_with(options)
            .await?;
        let db = Self { pool };
        db.init().await?;
        Ok(db)
    }
    pub(crate) async fn init(&self) -> Result<()> {
        sqlx::raw_sql("CREATE TABLE IF NOT EXISTS market_klines(symbol TEXT NOT NULL,interval TEXT NOT NULL,open_time BIGINT NOT NULL,open DOUBLE PRECISION NOT NULL,high DOUBLE PRECISION NOT NULL,low DOUBLE PRECISION NOT NULL,close DOUBLE PRECISION NOT NULL,volume DOUBLE PRECISION NOT NULL,close_time BIGINT NOT NULL,quote_volume DOUBLE PRECISION NOT NULL,trade_count INTEGER NOT NULL,taker_buy_volume DOUBLE PRECISION,taker_buy_quote_volume DOUBLE PRECISION,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),PRIMARY KEY(symbol,interval,open_time)); ALTER TABLE market_klines ADD COLUMN IF NOT EXISTS taker_buy_volume DOUBLE PRECISION; ALTER TABLE market_klines ADD COLUMN IF NOT EXISTS taker_buy_quote_volume DOUBLE PRECISION; CREATE TABLE IF NOT EXISTS research_records(id TEXT PRIMARY KEY,created_at TIMESTAMPTZ NOT NULL,record JSONB NOT NULL);CREATE INDEX IF NOT EXISTS research_records_time ON research_records(created_at DESC);CREATE TABLE IF NOT EXISTS kline_sync_state(symbol TEXT NOT NULL,interval TEXT NOT NULL,last_open_time BIGINT,last_sync_at TIMESTAMPTZ,last_status TEXT NOT NULL DEFAULT 'idle',last_error TEXT NOT NULL DEFAULT '',PRIMARY KEY(symbol,interval));CREATE TABLE IF NOT EXISTS trade_sync_state(symbol TEXT PRIMARY KEY,last_trade_id BIGINT,last_trade_time BIGINT,last_sync_at TIMESTAMPTZ,last_status TEXT NOT NULL DEFAULT 'idle',last_error TEXT NOT NULL DEFAULT '');").execute(&self.pool).await?;
        let legacy:bool=sqlx::query_scalar("SELECT to_regclass('simulated_accounts') IS NULL AND to_regclass('simulated_account') IS NOT NULL").fetch_one(&self.pool).await?;
        if legacy {
            bail!(
                "Legacy simulated_account schema requires migration before starting Rust API; existing data has been preserved."
            );
        }
        for d in definitions() {
            let k = keys(&d);
            let cols = columns(&d)
                .iter()
                .map(|(c, t)| {
                    format!(
                        "\"{c}\" {t}{}",
                        if k.contains(&c.as_str()) {
                            " NOT NULL"
                        } else {
                            ""
                        }
                    )
                })
                .collect::<Vec<_>>()
                .join(",");
            let pk = k
                .iter()
                .map(|c| format!("\"{c}\""))
                .collect::<Vec<_>>()
                .join(",");
            let fk = if d.name == "simulated_accounts" {
                "CHECK(account_id=1)"
            } else if d.order && d.name != "simulated_orders" {
                "FOREIGN KEY(account_id,order_id) REFERENCES simulated_orders(account_id,order_id) ON DELETE CASCADE"
            } else {
                "FOREIGN KEY(account_id) REFERENCES simulated_accounts(account_id) ON DELETE CASCADE"
            };
            sqlx::query(&format!(
                "CREATE TABLE IF NOT EXISTS {}({cols},PRIMARY KEY({pk}),{fk})",
                d.name
            ))
            .execute(&self.pool)
            .await?;
        }
        for (order, name) in [
            (false, "simulated_account_extensions"),
            (true, "simulated_order_extensions"),
        ] {
            let ordercol = if order { "order_id TEXT NOT NULL," } else { "" };
            let pk = if order {
                "account_id,order_id,path"
            } else {
                "account_id,path"
            };
            let fk = if order {
                "FOREIGN KEY(account_id,order_id) REFERENCES simulated_orders(account_id,order_id) ON DELETE CASCADE"
            } else {
                "FOREIGN KEY(account_id) REFERENCES simulated_accounts(account_id) ON DELETE CASCADE"
            };
            sqlx::query(&format!("CREATE TABLE IF NOT EXISTS {name}(account_id INTEGER NOT NULL,{ordercol}path TEXT[] NOT NULL,value_kind TEXT NOT NULL,text_value TEXT,number_value DOUBLE PRECISION,boolean_value BOOLEAN,PRIMARY KEY({pk}),{fk})")).execute(&self.pool).await?;
        }
        sqlx::query("INSERT INTO simulated_accounts(account_id,initial_balance)VALUES(1,10000)ON CONFLICT DO NOTHING").execute(&self.pool).await?;
        self.mutate_account(|state| {
            if state["fusedPoolStartedAt"].is_null() {
                state["fusedPoolStartedAt"] = json!(crate::iso(crate::now_ms()));
            }
            state["unlimitedCapital"] = json!(false);
            Ok(Value::Null)
        })
        .await?;
        Ok(())
    }
    pub async fn save_klines(&self, symbol: &str, interval: &str, rows: &[Value]) -> Result<usize> {
        let mut tx = self.pool.begin().await?;
        let mut unique = BTreeMap::new();
        for r in rows {
            unique.insert(crate::number(&r["openTime"], -1.) as i64, r);
        }
        let batch:Vec<Value>=unique.values().map(|r|json!({"open_time":crate::number(&r["openTime"],0.)as i64,"open":crate::number(&r["open"],0.),"high":crate::number(&r["high"],0.),"low":crate::number(&r["low"],0.),"close":crate::number(&r["close"],0.),"volume":crate::number(&r["volume"],0.),"close_time":crate::number(&r["closeTime"],0.)as i64,"quote_volume":crate::number(&r["quoteVolume"],0.),"trade_count":crate::number(&r["tradeCount"],0.)as i32,"taker_buy_volume":r["takerBuyVolume"],"taker_buy_quote_volume":r["takerBuyQuoteVolume"]})).collect();
        if !batch.is_empty() {
            sqlx::query("INSERT INTO market_klines(symbol,interval,open_time,open,high,low,close,volume,close_time,quote_volume,trade_count,taker_buy_volume,taker_buy_quote_volume)SELECT $1,$2,r.* FROM jsonb_to_recordset($3)AS r(open_time BIGINT,open DOUBLE PRECISION,high DOUBLE PRECISION,low DOUBLE PRECISION,close DOUBLE PRECISION,volume DOUBLE PRECISION,close_time BIGINT,quote_volume DOUBLE PRECISION,trade_count INTEGER,taker_buy_volume DOUBLE PRECISION,taker_buy_quote_volume DOUBLE PRECISION)ON CONFLICT(symbol,interval,open_time)DO UPDATE SET open=EXCLUDED.open,high=EXCLUDED.high,low=EXCLUDED.low,close=EXCLUDED.close,volume=EXCLUDED.volume,close_time=EXCLUDED.close_time,quote_volume=EXCLUDED.quote_volume,trade_count=EXCLUDED.trade_count,taker_buy_volume=EXCLUDED.taker_buy_volume,taker_buy_quote_volume=EXCLUDED.taker_buy_quote_volume,updated_at=NOW()") .bind(symbol).bind(interval).bind(json!(batch)).execute(&mut *tx).await?;
        }
        tx.commit().await?;
        Ok(rows.len())
    }
    pub async fn candles(
        &self,
        symbol: &str,
        interval: &str,
        limit: i64,
        start: Option<i64>,
        end: Option<i64>,
    ) -> Result<Vec<Value>> {
        let mut rows=sqlx::query_scalar::<_,Value>("SELECT jsonb_build_object('symbol',symbol,'interval',interval,'openTime',open_time,'open',open,'high',high,'low',low,'close',close,'volume',volume,'closeTime',close_time,'quoteVolume',quote_volume,'tradeCount',trade_count,'takerBuyVolume',taker_buy_volume,'takerBuyQuoteVolume',taker_buy_quote_volume,'refreshedAt',updated_at)FROM market_klines WHERE symbol=$1 AND interval=$2 AND($4::bigint IS NULL OR open_time>=$4)AND($5::bigint IS NULL OR open_time<$5)ORDER BY open_time DESC LIMIT $3").bind(symbol).bind(interval).bind(limit.clamp(1,10_000_000)).bind(start).bind(end).fetch_all(&self.pool).await?;
        rows.reverse();
        Ok(rows)
    }
    pub async fn summary(&self) -> Result<Value> {
        Ok(json!(sqlx::query_scalar::<_,Value>("SELECT jsonb_build_object('symbol',symbol,'interval',interval,'rows',COUNT(*),'firstOpenTime',MIN(open_time),'lastOpenTime',MAX(open_time))FROM market_klines GROUP BY symbol,interval ORDER BY symbol,interval").fetch_all(&self.pool).await?))
    }
    pub async fn sync_states(&self) -> Result<Value> {
        Ok(json!(sqlx::query_scalar::<_,Value>("SELECT jsonb_build_object('symbol',symbol,'interval',interval,'lastOpenTime',last_open_time,'lastSyncAt',last_sync_at,'lastStatus',last_status,'lastError',last_error)FROM kline_sync_state ORDER BY symbol,interval").fetch_all(&self.pool).await?))
    }
    pub async fn sync_state(
        &self,
        symbol: &str,
        interval: &str,
        time: Option<i64>,
        status: &str,
        error: &str,
    ) -> Result<()> {
        sqlx::query("INSERT INTO kline_sync_state(symbol,interval,last_open_time,last_sync_at,last_status,last_error)VALUES($1,$2,$3,NOW(),$4,$5)ON CONFLICT(symbol,interval)DO UPDATE SET last_open_time=COALESCE(EXCLUDED.last_open_time,kline_sync_state.last_open_time),last_sync_at=NOW(),last_status=EXCLUDED.last_status,last_error=EXCLUDED.last_error").bind(symbol).bind(interval).bind(time).bind(status).bind(error).execute(&self.pool).await?;
        Ok(())
    }
    pub async fn save_record(&self, record: &Value) -> Result<()> {
        let mut light = record.clone();
        light
            .as_object_mut()
            .context("Invalid research record")?
            .remove("market");
        if let Some(strategy) = light["snapshot"]["strategy"].as_object_mut() {
            strategy.remove("systemPrompt");
            strategy.remove("rules");
        }
        let time = chrono::DateTime::parse_from_rfc3339(
            record["at"].as_str().context("record timestamp")?,
        )?
        .with_timezone(&chrono::Utc);
        sqlx::query("INSERT INTO research_records(id,created_at,record)VALUES($1,$2,$3)ON CONFLICT(id)DO NOTHING").bind(record["id"].as_str().context("record id")?).bind(time).bind(light).execute(&self.pool).await?;
        Ok(())
    }
    pub async fn record(&self, id: &str) -> Result<Option<Value>> {
        Ok(
            sqlx::query_scalar("SELECT record FROM research_records WHERE id=$1")
                .bind(id)
                .fetch_optional(&self.pool)
                .await?,
        )
    }
    pub async fn records(
        &self,
        date: &str,
        symbol: &str,
        limit: i64,
        offset: i64,
        snapshots: bool,
    ) -> Result<Vec<Value>> {
        let start = if date.is_empty() {
            None
        } else {
            Some(
                chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")?
                    .and_hms_opt(0, 0, 0)
                    .unwrap()
                    .and_utc(),
            )
        };
        let end = start.map(|s| s + chrono::Duration::days(1));
        let fields = if snapshots {
            "record"
        } else {
            "record-'market'-'snapshot'"
        };
        Ok(sqlx::query_scalar(&format!("SELECT {fields} FROM research_records WHERE($1::timestamptz IS NULL OR created_at>=$1)AND($2::timestamptz IS NULL OR created_at<$2)AND($3='' OR record->>'symbol'=$3 OR record->'symbols' ? $3)ORDER BY created_at DESC,id DESC LIMIT $4 OFFSET $5")).bind(start).bind(end).bind(symbol).bind(limit).bind(offset).fetch_all(&self.pool).await?)
    }
    pub async fn account(&self, light: bool, order_id: Option<&str>) -> Result<Value> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
            .execute(&mut *tx)
            .await?;
        let v = read_account(&mut tx, light, order_id).await?;
        tx.commit().await?;
        Ok(v)
    }
    pub async fn mutate_account<F>(&self, f: F) -> Result<Value>
    where
        F: FnOnce(&mut Value) -> Result<Value>,
    {
        self.mutate_account_mode(false, None, f).await
    }
    pub async fn mutate_account_light<F>(&self, f: F) -> Result<Value>
    where
        F: FnOnce(&mut Value) -> Result<Value>,
    {
        self.mutate_account_mode(true, None, f).await
    }
    pub async fn mutate_order<F>(&self, id: &str, f: F) -> Result<Value>
    where
        F: FnOnce(&mut Value) -> Result<Value>,
    {
        self.mutate_account_mode(false, Some(id), f).await
    }
    async fn mutate_account_mode<F>(
        &self,
        light: bool,
        order_id: Option<&str>,
        f: F,
    ) -> Result<Value>
    where
        F: FnOnce(&mut Value) -> Result<Value>,
    {
        let mut tx = self.pool.begin().await?;
        sqlx::query("SELECT pg_advisory_xact_lock(790217)")
            .execute(&mut *tx)
            .await?;
        let before = read_account(&mut tx, light, order_id).await?;
        let mut after = before.clone();
        let result = f(&mut after)?;
        let previous = project(&before)?;
        let next = project(&after)?;
        // Compare rows by primary key; historical rows are left untouched.
        let mut names: Vec<String> = definitions().iter().map(|d| d.name.to_owned()).collect();
        names.extend([
            "simulated_account_extensions".to_owned(),
            "simulated_order_extensions".to_owned(),
        ]);
        for name in names.iter().rev() {
            let old = previous.get(name).cloned().unwrap_or_default();
            let new_keys: BTreeSet<String> = next[name].iter().map(|v| row_key(name, v)).collect();
            for r in &old {
                if !new_keys.contains(&row_key(name, r)) {
                    delete_row(&mut tx, name, r).await?;
                }
            }
        }
        for name in &names {
            let old_by_key: BTreeMap<String, Value> = previous[name]
                .iter()
                .map(|v| (row_key(name, v), v.clone()))
                .collect();
            for r in &next[name] {
                if old_by_key.get(&row_key(name, r)) != Some(r) {
                    upsert_row(&mut tx, name, r).await?;
                }
            }
        }
        tx.commit().await?;
        Ok(result)
    }
}
async fn read_account(
    tx: &mut Transaction<'_, Postgres>,
    light: bool,
    order_id: Option<&str>,
) -> Result<Value> {
    let mut tables = BTreeMap::new();
    for d in definitions() {
        let filter = if !d.order {
            ""
        } else if order_id.is_some() {
            " AND t.order_id=$1"
        } else if light && d.name != "simulated_orders" {
            " AND t.order_id IN(SELECT order_id FROM simulated_orders WHERE account_id=1 AND status IN('pending','open'))"
        } else {
            ""
        };
        let query = format!(
            "SELECT to_jsonb(t)FROM {} t WHERE t.account_id=1{filter}",
            d.name
        );
        let rows = if d.order && order_id.is_some() {
            sqlx::query_scalar::<_, Value>(&query)
                .bind(order_id)
                .fetch_all(&mut **tx)
                .await?
        } else {
            sqlx::query_scalar::<_, Value>(&query)
                .fetch_all(&mut **tx)
                .await?
        };
        tables.insert(d.name.to_owned(), rows);
    }
    for (order, name) in [
        (false, "simulated_account_extensions"),
        (true, "simulated_order_extensions"),
    ] {
        let filter = if order && order_id.is_some() {
            " AND t.order_id=$1"
        } else if order && light {
            " AND(t.order_id IN(SELECT order_id FROM simulated_orders WHERE account_id=1 AND status IN('pending','open'))OR path=ARRAY['analysisContext','strategyId']::text[] OR path=ARRAY['analysisContext','strategyName']::text[] OR path[1] IN('exchangeSync','exchange','realizedQty','realizedNet','manualCloseRequested','manualEntryCancelled'))"
        } else {
            ""
        };
        let query = format!(
            "SELECT to_jsonb(t)FROM {name} t WHERE t.account_id=1{filter} ORDER BY array_length(path,1)"
        );
        let rows = if order && order_id.is_some() {
            sqlx::query_scalar::<_, Value>(&query)
                .bind(order_id)
                .fetch_all(&mut **tx)
                .await?
        } else {
            sqlx::query_scalar::<_, Value>(&query)
                .fetch_all(&mut **tx)
                .await?
        };
        tables.insert(name.to_owned(), rows);
    }
    hydrate(&tables)
}
pub fn put(root: &mut Value, path: &[String], value: Value) {
    if path.is_empty() {
        *root = value;
        return;
    }
    if root.is_array()
        && let Ok(i) = path[0].parse::<usize>()
    {
        let a = root.as_array_mut().unwrap();
        while a.len() <= i {
            a.push(Value::Null);
        }
        put(&mut a[i], &path[1..], value);
        return;
    }
    if !root.is_object() {
        *root = json!({});
    }
    put(&mut root[&path[0]], &path[1..], value)
}
fn get<'a>(root: &'a Value, path: &[String]) -> Option<&'a Value> {
    let mut v = root;
    for key in path {
        v = if v.is_array() {
            v.get(key.parse::<usize>().ok()?)?
        } else {
            v.get(key)?
        };
    }
    Some(v)
}
fn hydrate(tables: &BTreeMap<String, Vec<Value>>) -> Result<Value> {
    let main = tables.get("simulated_orders").cloned().unwrap_or_default();
    let mut orders: BTreeMap<String, Value> = main
        .iter()
        .map(|r| {
            (
                r["order_id"].as_str().unwrap_or("").to_owned(),
                json!({"id":r["order_id"]}),
            )
        })
        .collect();
    let mut state = json!({});
    for name in ["simulated_account_extensions", "simulated_order_extensions"] {
        for r in tables.get(name).into_iter().flatten() {
            let path: Vec<String> = r["path"]
                .as_array()
                .context("Invalid extension path")?
                .iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect();
            let value = match r["value_kind"].as_str() {
                Some("object") => json!({}),
                Some("array") => json!([]),
                Some("string") => r["text_value"].clone(),
                Some("number") => r["number_value"].clone(),
                Some("boolean") => r["boolean_value"].clone(),
                _ => Value::Null,
            };
            if let Some(id) = r["order_id"].as_str() {
                if let Some(o) = orders.get_mut(id) {
                    put(o, &path, value);
                }
            } else {
                put(&mut state, &path, value);
            }
        }
    }
    for d in definitions() {
        for r in tables.get(d.name).into_iter().flatten() {
            let owner = if d.order {
                match orders.get_mut(r["order_id"].as_str().unwrap_or("")) {
                    Some(o) => o,
                    None => continue,
                }
            } else {
                &mut state
            };
            let variant = d.key.and_then(|k| r[k].as_str()).unwrap_or("");
            let Some((_, root)) = d.variants.iter().find(|(k, _)| *k == variant) else {
                continue;
            };
            for (key, ty) in &d.fields {
                if d.name == "simulated_orders" && *key == "id" {
                    continue;
                }
                let raw = &r[snake(key)];
                if raw.is_null() {
                    continue;
                }
                let mut path: Vec<String> = root.iter().map(|s| s.to_string()).collect();
                if d.list {
                    path.push(r["sequence"].to_string());
                }
                if !d.scalar {
                    path.extend(key.split('.').map(str::to_owned));
                }
                let v = if *ty == "TIMESTAMPTZ" {
                    crate::timestamp(raw)
                        .map(|t| json!(crate::iso(t)))
                        .unwrap_or_else(|| raw.clone())
                } else {
                    raw.clone()
                };
                put(owner, &path, v);
            }
        }
    }
    let mut sorted = main;
    sorted.sort_by_key(|r| r["order_position"].as_i64().unwrap_or(0));
    state["orders"] = json!(
        sorted
            .iter()
            .filter_map(|r| orders.remove(r["order_id"].as_str().unwrap_or("")))
            .collect::<Vec<_>>()
    );
    Ok(state)
}
fn project(state: &Value) -> Result<BTreeMap<String, Vec<Value>>> {
    let defs = definitions();
    let mut tables: BTreeMap<String, Vec<Value>> =
        defs.iter().map(|d| (d.name.to_owned(), vec![])).collect();
    tables.insert("simulated_account_extensions".into(), vec![]);
    tables.insert("simulated_order_extensions".into(), vec![]);
    let mut account = state.clone();
    account
        .as_object_mut()
        .context("Account must be object")?
        .remove("orders");
    let mut owners = vec![(None, 0, &account)];
    let mut ids = BTreeSet::new();
    for (i, o) in state["orders"]
        .as_array()
        .context("Orders must be array")?
        .iter()
        .enumerate()
    {
        let id = o["id"]
            .as_str()
            .filter(|s| !s.is_empty())
            .context("Missing order ID")?;
        if !ids.insert(id) {
            bail!("Duplicate order ID");
        }
        owners.push((Some(id), i, o));
    }
    for (id, pos, owner) in owners {
        let mut mapped = BTreeSet::new();
        for d in defs.iter().filter(|d| d.order == id.is_some()) {
            for (variant, root) in &d.variants {
                let path: Vec<String> = root.iter().map(|s| s.to_string()).collect();
                let Some(object) = get(owner, &path).filter(|v| !v.is_null()) else {
                    continue;
                };
                let items: Vec<&Value> = if d.list {
                    object
                        .as_array()
                        .map(|a| a.iter().collect())
                        .unwrap_or_default()
                } else {
                    vec![object]
                };
                for (i, item) in items.into_iter().enumerate() {
                    let mut row = json!({"account_id":1});
                    if let Some(id) = id {
                        row["order_id"] = json!(id);
                    }
                    if let Some(k) = d.key {
                        row[k] = json!(variant);
                    }
                    if d.list {
                        row["sequence"] = json!(i);
                    }
                    if d.name == "simulated_orders" {
                        row["order_position"] = json!(pos);
                    }
                    for (key, ty) in &d.fields {
                        let mut fieldpath = path.clone();
                        if d.list {
                            fieldpath.push(i.to_string());
                        }
                        if !d.scalar {
                            fieldpath.extend(key.split('.').map(str::to_owned));
                        }
                        let Some(v) = (if d.scalar {
                            Some(item)
                        } else {
                            get(item, &key.split('.').map(str::to_owned).collect::<Vec<_>>())
                        }) else {
                            continue;
                        };
                        let fits = match *ty {
                            "DOUBLE PRECISION" => v.is_number(),
                            "BOOLEAN" => v.is_boolean(),
                            "TIMESTAMPTZ" => v.is_string() && crate::timestamp(v).is_some(),
                            _ => v.is_string(),
                        };
                        if fits {
                            mapped.insert(fieldpath);
                            if !(d.name == "simulated_orders" && *key == "id") {
                                row[snake(key)] = v.clone();
                            }
                        }
                    }
                    for (c, _) in columns(d) {
                        if row.get(&c).is_none() {
                            row[c] = Value::Null;
                        }
                    }
                    tables.get_mut(d.name).unwrap().push(row);
                }
            }
        }
        let name = if id.is_some() {
            "simulated_order_extensions"
        } else {
            "simulated_account_extensions"
        };
        flatten(owner, &[], id, &mapped, tables.get_mut(name).unwrap());
    }
    Ok(tables)
}
fn flatten(
    v: &Value,
    path: &[String],
    id: Option<&str>,
    mapped: &BTreeSet<Vec<String>>,
    out: &mut Vec<Value>,
) {
    let kind = if v.is_object() {
        "object"
    } else if v.is_array() {
        "array"
    } else if v.is_null() {
        "null"
    } else if v.is_string() {
        "string"
    } else if v.is_boolean() {
        "boolean"
    } else {
        "number"
    };
    if !path.is_empty() && (!mapped.contains(path) || v.is_array() || v.is_object()) {
        let mut r = json!({"account_id":1,"path":path,"value_kind":kind,"text_value":null,"number_value":null,"boolean_value":null});
        if let Some(id) = id {
            r["order_id"] = json!(id);
        }
        match kind {
            "string" => r["text_value"] = v.clone(),
            "number" => r["number_value"] = v.clone(),
            "boolean" => r["boolean_value"] = v.clone(),
            _ => {}
        }
        out.push(r);
    }
    if let Some(obj) = v.as_object() {
        for (k, c) in obj {
            let mut p = path.to_vec();
            p.push(k.clone());
            flatten(c, &p, id, mapped, out);
        }
    } else if let Some(a) = v.as_array() {
        for (i, c) in a.iter().enumerate() {
            let mut p = path.to_vec();
            p.push(i.to_string());
            flatten(c, &p, id, mapped, out);
        }
    }
}
fn table_keys(name: &str) -> Vec<String> {
    if name.ends_with("_extensions") {
        let mut k = vec!["account_id".into()];
        if name == "simulated_order_extensions" {
            k.push("order_id".into());
        }
        k.push("path".into());
        k
    } else {
        keys(&definitions().into_iter().find(|d| d.name == name).unwrap())
            .iter()
            .map(|s| s.to_string())
            .collect()
    }
}
fn row_key(name: &str, row: &Value) -> String {
    json!(
        table_keys(name)
            .iter()
            .map(|k| row[k].clone())
            .collect::<Vec<_>>()
    )
    .to_string()
}
async fn delete_row(tx: &mut Transaction<'_, Postgres>, name: &str, row: &Value) -> Result<()> {
    let condition = table_keys(name)
        .iter()
        .map(|k| format!("t.\"{k}\"=r.\"{k}\""))
        .collect::<Vec<_>>()
        .join(" AND ");
    sqlx::query(&format!(
        "DELETE FROM {name} t USING jsonb_populate_record(NULL::{name},$1) r WHERE {condition}"
    ))
    .bind(row)
    .execute(&mut **tx)
    .await?;
    Ok(())
}
async fn upsert_row(tx: &mut Transaction<'_, Postgres>, name: &str, row: &Value) -> Result<()> {
    let k = table_keys(name);
    let cols = row
        .as_object()
        .unwrap()
        .keys()
        .map(|c| format!("\"{c}\""))
        .collect::<Vec<_>>()
        .join(",");
    let updates = row
        .as_object()
        .unwrap()
        .keys()
        .filter(|c| !k.contains(c))
        .map(|c| format!("\"{c}\"=EXCLUDED.\"{c}\""))
        .collect::<Vec<_>>()
        .join(",");
    let conflict = k
        .iter()
        .map(|c| format!("\"{c}\""))
        .collect::<Vec<_>>()
        .join(",");
    let action = if updates.is_empty() {
        "DO NOTHING".to_owned()
    } else {
        format!("DO UPDATE SET {updates}")
    };
    sqlx::query(&format!("INSERT INTO {name}({cols})SELECT {cols} FROM jsonb_populate_record(NULL::{name},$1)ON CONFLICT({conflict}){action}")).bind(row).execute(&mut **tx).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn normalized_roundtrip_preserves_nested_extensions() {
        let state = json!({"initialBalance":1000,"unlimitedCapital":false,"entriesPaused":true,"orders":[{"id":"x","status":"open","direction":"OPEN_LONG","createdAt":"2026-10-08T00:00:00.000Z","margin":10,"plan":{"entryMin":12,"smartExit":{"enabled":true}},"reviewHistory":[{"action":"HOLD","previous":{"stopLoss":3}}],"exchangeSync":{"demo":{"status":"pending"}},"analysisContext":{"signal":{"validationIssues":[]}},"nullable":null}]});
        let tables = project(&state).unwrap();
        assert_eq!(hydrate(&tables).unwrap(), state);
    }
    #[test]
    fn duplicates_rejected() {
        assert!(project(&json!({"orders":[{"id":"a"},{"id":"a"}]})).is_err());
    }
}
