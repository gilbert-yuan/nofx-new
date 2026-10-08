//! Durable monthly research. Each result is one strategy/parameter/symbol replay.
//! Only public market history and local research files are written.
use crate::{
    backtest::{self, History},
    db::Db,
    exchange::{Exchange, storage_symbol, valid_symbol},
    indicator_history, interval_ms, iso, now_ms, number,
    optimizer::{self, SearchDim, SearchSpec},
    store::Store,
    strategies, timestamp,
};
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

pub fn read_json(path: &Path) -> Result<Value> {
    Ok(serde_json::from_str(
        fs::read_to_string(path)?.trim_start_matches('\u{feff}'),
    )?)
}
pub fn write_json(path: &Path, value: &Value) -> Result<()> {
    fs::create_dir_all(path.parent().context("结果文件需要父目录")?)?;
    let temporary = path.with_extension("json.tmp");
    let mut file = File::create(&temporary)?;
    file.write_all(serde_json::to_string(value)?.as_bytes())?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    fs::rename(temporary, path)?;
    Ok(())
}
pub fn lock_directory(directory: &Path) -> Result<File> {
    fs::create_dir_all(directory)?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(directory.join("worker.lock"))?;
    file.try_lock()
        .context("此研究目录已有工作进程，不能重复启动")?;
    Ok(file)
}
pub fn engine_version() -> String {
    let mut hash = Sha256::new();
    for source in [
        include_str!("campaign.rs"),
        include_str!("backtest.rs"),
        include_str!("optimizer.rs"),
        include_str!("strategies.rs"),
        include_str!("market_filters.rs"),
        include_str!("paper.rs"),
        include_str!("ledger.rs"),
        include_str!("simulator.rs"),
        include_str!("automation_guards.rs"),
        include_str!("market_indicators.rs"),
        include_str!("indicator_history.rs"),
        include_str!("automation.rs"),
        include_str!("analytics/adaptive.rs"),
        include_str!("analytics/local.rs"),
        include_str!("analytics.rs"),
        include_str!("adaptive_defaults.json"),
        include_str!("flow.rs"),
        include_str!("flow_defaults.json"),
        include_str!("strategies/enhanced.rs"),
        include_str!("strategies/h4.rs"),
        include_str!("strategies/structure.rs"),
        include_str!("strategies/yao.rs"),
        include_str!("strategies/opportunity.rs"),
        include_str!("strategies/indicators.rs"),
        include_str!("strategies/registry.json"),
        include_str!("research.rs"),
        include_str!("lib.rs"),
        include_str!("../../Cargo.toml"),
        include_str!("../../Cargo.lock"),
        include_str!("../../rust-toolchain.toml"),
    ] {
        hash.update(source.as_bytes());
    }
    hex::encode(hash.finalize())
}
pub fn research_config(config: &Value) -> Value {
    // No exchange/model credentials can enter a research manifest.
    json!({"trader":config["trader"],"marketSync":{"dataOnly":false}})
}
pub fn environment_snapshot() -> BTreeMap<String, String> {
    std::env::vars()
        .filter(|(key, _)| {
            key.starts_with("NOFX_")
                && !["KEY", "SECRET", "TOKEN", "PASSWORD"]
                    .iter()
                    .any(|word| key.contains(word))
        })
        .collect()
}

pub fn search_space(id: &str, base: &Value) -> Result<BTreeMap<String, Vec<Value>>> {
    let definition = strategies::definition(id).context("未知策略")?;
    let mut space = BTreeMap::new();
    for schema in definition["paramSchema"].as_array().unwrap() {
        let key = schema["key"].as_str().unwrap();
        if !["indicator", "filter", "entry", "protection", "exit"]
            .contains(&schema["group"].as_str().unwrap_or(""))
            || schema["type"] == "boolean"
            || ["longOnly", "shortOnly"].contains(&key)
        {
            continue;
        }
        let center = number(&base[key], f64::NAN);
        if !center.is_finite() || center == 0. {
            continue;
        }
        let step = number(&schema["step"], 1.).max(1e-9);
        let mut values = vec![base[key].clone()];
        for factor in [0.8, 1.2] {
            let value = json!(((center * factor / step).round() * step).clamp(
                number(&schema["min"], center),
                number(&schema["max"], center)
            ));
            let mut params = base.clone();
            params[key] = value.clone();
            if strategies::resolve_params(id, &params)?["rejected"]
                .as_array()
                .unwrap()
                .is_empty()
                && !values.contains(&value)
            {
                values.push(value);
            }
        }
        if values.len() > 1 {
            space.insert(key.into(), values);
        }
    }
    // Match the historical units used by market_filters; no unrecorded order book.
    for (key, values) in [
        ("marketOiEnabled", json!([false, true])),
        ("marketOiWindowMinutes", json!([5, 15, 60])),
        ("marketOiMinPct", json!([-1, 0, 0.5, 1])),
        ("marketOiMaxPct", json!([5, 10, 1000])),
        ("marketFlowEnabled", json!([false, true])),
        ("marketFlowMinFraction", json!([0.5, 0.55, 0.6, 0.65])),
        ("marketFlowMinActivity", json!([0, 1, 1.25])),
        ("marketFlowMaxVwapDeviationPct", json!([1, 2, 100])),
        ("marketFundingEnabled", json!([false, true])),
        ("marketFundingMinPct", json!([-5, -0.05, -0.01])),
        ("marketFundingMaxPct", json!([0.01, 0.05, 5])),
        ("marketGlobalRatioEnabled", json!([false, true])),
        ("marketGlobalRatioMin", json!([0, 0.5, 1])),
        ("marketGlobalRatioMax", json!([2, 3, 100])),
        ("marketTopRatioEnabled", json!([false, true])),
        ("marketTopRatioMin", json!([0, 0.5, 1])),
        ("marketTopRatioMax", json!([2, 3, 100])),
    ] {
        space.insert(key.into(), values.as_array().unwrap().clone());
    }
    Ok(space)
}
fn spec(manifest: &Value, id: &str) -> SearchSpec {
    let strategy = &manifest["strategies"][id];
    SearchSpec {
        strategy_id: id.into(),
        base: strategy["params"].clone(),
        dims: strategy["space"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(key, values)| SearchDim {
                key: key.clone(),
                values: values.as_array().unwrap().clone(),
            })
            .collect(),
    }
}

pub fn representative_symbols(
    contracts: &[Value],
    tickers: &[Value],
    count: usize,
    from: i64,
) -> Vec<String> {
    let eligible: BTreeSet<_> = contracts
        .iter()
        .filter(|row| {
            row["status"] == "TRADING"
                && row["contractType"] == "PERPETUAL"
                && row["quoteAsset"] == "USDT"
                && row["marginAsset"] == "USDT"
                && number(&row["onboardDate"], f64::MAX) < (from - 84 * 86_400_000) as f64
        })
        .filter_map(|row| row["symbol"].as_str())
        .collect();
    let mut rows: Vec<_> = tickers
        .iter()
        .filter(|row| {
            row["symbol"].as_str().is_some_and(|s| eligible.contains(s))
                && number(&row["quoteVolume"], 0.) >= 20_000_000.
        })
        .collect();
    let mut selected = vec![];
    for name in [
        "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT",
    ] {
        if eligible.contains(name) && selected.len() < count {
            selected.push(name.to_string());
        }
    }
    rows.sort_by(|a, b| number(&b["quoteVolume"], 0.).total_cmp(&number(&a["quoteVolume"], 0.)));
    for row in &rows {
        let name = row["symbol"].as_str().unwrap().to_string();
        if selected.len() >= count.saturating_sub(3) {
            break;
        }
        if !selected.contains(&name) {
            selected.push(name);
        }
    }
    let amplitude =
        |row: &Value| number(&row["highPrice"], 0.) / number(&row["lowPrice"], 1.).max(1e-12) - 1.;
    rows.sort_by(|a, b| amplitude(b).total_cmp(&amplitude(a)));
    for row in rows {
        let name = row["symbol"].as_str().unwrap().to_string();
        if selected.len() >= count {
            break;
        }
        if !selected.contains(&name) {
            selected.push(name);
        }
    }
    selected
}
pub async fn create_manifest(
    root: &Path,
    settings: &Value,
    db: &Db,
    exchange: &Exchange,
) -> Result<Value> {
    let end = now_ms().div_euclid(60_000) * 60_000;
    let days = number(&settings["days"], 30.) as i64;
    if !(1..=31).contains(&days) {
        bail!("days 需要在 1～31");
    }
    let start = end - days * 86_400_000;
    let store =
        Store::new(root.join(std::env::var("DATA_DIR").unwrap_or_else(|_| "data".into()))).await?;
    let config = store.read("config").await?;
    let list = strategies::list(&config, &store.read("strategies").await?);
    let mut selected = serde_json::Map::new();
    for strategy in list["strategies"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|s| s["enabled"] == true)
    {
        let id = strategy["id"].as_str().unwrap();
        selected.insert(
            id.into(),
            json!({"name":strategy["name"],"params":strategy["params"],
            "space":search_space(id, &strategy["params"])?}),
        );
    }
    if selected.is_empty() {
        bail!("当前没有启用的策略");
    }
    let symbols: Vec<String> = if let Some(values) = settings["symbols"].as_array() {
        values
            .iter()
            .map(|v| {
                v.as_str()
                    .context("symbols 元素必须是字符串")
                    .map(str::to_uppercase)
            })
            .collect::<Result<_>>()?
    } else {
        let contracts = exchange
            .public_request("/fapi/v1/exchangeInfo", &json!({}))
            .await?;
        let tickers = exchange
            .public_request("/fapi/v1/ticker/24hr", &json!({}))
            .await?;
        representative_symbols(
            contracts["symbols"]
                .as_array()
                .context("合约信息格式错误")?,
            tickers.as_array().context("行情格式错误")?,
            number(&settings["symbolCount"], 12.) as usize,
            start,
        )
    };
    if symbols.is_empty() {
        bail!("没有可用的代表币种");
    }
    for symbol in &symbols {
        valid_symbol(symbol)?;
    }
    let account = db.account(true, None).await?;
    let manifest = json!({"version":1,"createdAt":iso(now_ms()),"startTime":start,"endTime":end,
        "engineVersion":engine_version(),"environment":environment_snapshot(),"strategies":selected,
        "symbols":symbols,"config":research_config(&config),"adaptive":account["adaptiveConfig"],"settings":settings,
        "costs":crate::research::costs(),"researchOnly":true,
        "limitations":["每个币种独立账户、等权汇总，不能视为共享资金池的全市场组合收益",
            "代表币种按当前成交额和波动选取，存在存活和选币偏差",
            "统计 REST 最早约 29 天；缺失时共享指标过滤禁止入场，不补零",
            "保留生产风控与固定成本模型；盘口、历史最小数量和网络成交延迟不重建"]});
    optimizer::split_range(start, end, &settings["optimization"])?;
    Ok(manifest)
}

fn ids(manifest: &Value) -> Vec<String> {
    manifest["strategies"]
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect()
}
fn symbols(manifest: &Value) -> Vec<String> {
    manifest["symbols"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().into())
        .collect()
}
fn result_path(directory: &Path, index: usize, id: &str, symbol: &str) -> PathBuf {
    directory
        .join("trials")
        .join(format!("{index:04}-{id}-{symbol}.json"))
}
pub fn coverage(history: &History, start: i64, end: i64) -> f64 {
    let expected = (end - start) / 60_000;
    if expected <= 0 {
        return 0.;
    }
    let actual = history
        .datasets
        .get("1m")
        .map(|rows| {
            rows.iter()
                .filter(|r| timestamp(&r["openTime"]).is_some_and(|t| t >= start && t < end))
                .count()
        })
        .unwrap_or(0);
    actual as f64 / expected as f64
}
pub fn aggregate(rows: &[Value], key: &str) -> Value {
    let mut trades = 0.;
    let mut ret = 0.;
    let mut max_dd: f64 = 0.;
    let mut missing = 0.;
    let mut gaps = 0.;
    let mut trading_symbols = 0;
    for row in rows {
        let result = &row[key];
        let closed = number(&result["closedTrades"], 0.);
        trades += closed;
        ret += number(&result["returnPct"], 0.);
        max_dd = max_dd.max(number(&result["maxDrawdownPct"], 0.));
        missing += result["missing"]
            .as_object()
            .map(|v| v.values().map(|v| number(v, 0.)).sum::<f64>())
            .unwrap_or(0.);
        gaps += number(&result["marketGaps"], 0.);
        if closed > 0. {
            trading_symbols += 1;
        }
    }
    json!({"closedTrades":trades,"returnPct":ret/rows.len().max(1) as f64,
        "maxDrawdownPct":max_dd,"missingChecks":missing,"marketGaps":gaps,
        "tradingSymbols":trading_symbols,"symbolCount":rows.len()})
}
fn trial_complete(
    directory: &Path,
    manifest: &Value,
    index: usize,
    id: &str,
) -> Result<Option<Value>> {
    let mut rows = vec![];
    for symbol in symbols(manifest) {
        let path = result_path(directory, index, id, &symbol);
        if !path.exists() {
            return Ok(None);
        }
        rows.push(read_json(&path)?);
    }
    if rows.iter().any(|row| row["params"] != rows[0]["params"]) {
        bail!("同一候选的币种结果使用了不同参数，不能汇总");
    }
    let mut trial = json!({"index":index,"params":rows[0]["params"],"training":aggregate(&rows,"training"),
        "validation":aggregate(&rows,"validation")});
    let opt = &manifest["settings"]["optimization"];
    let sufficient = number(&trial["training"]["closedTrades"], 0.)
        >= number(&opt["minTrades"], 10.)
        && number(&trial["validation"]["closedTrades"], 0.)
            >= number(&opt["minValidationTrades"], 5.)
        && number(&trial["training"]["tradingSymbols"], 0.)
            >= number(&opt["minTradingSymbols"], 3.)
        && trial["training"]["marketGaps"] == 0.
        && trial["validation"]["marketGaps"] == 0.;
    trial["sufficient"] = json!(sufficient);
    trial["score"] = if sufficient {
        json!(optimizer::score_trial(&trial, opt))
    } else {
        Value::Null
    };
    Ok(Some(trial))
}
pub fn summary(directory: &Path, manifest: &Value) -> Result<Value> {
    let mut reports = serde_json::Map::new();
    let mut completed = 0;
    let mut units = 0;
    for id in ids(manifest) {
        let mut trials = vec![];
        for index in 0..number(&manifest["settings"]["maxTrials"], 64.) as usize {
            for symbol in symbols(manifest) {
                if result_path(directory, index, &id, &symbol).exists() {
                    units += 1;
                }
            }
            if let Some(trial) = trial_complete(directory, manifest, index, &id)? {
                completed += 1;
                trials.push(trial);
            }
        }
        let baseline = trials
            .iter()
            .find(|t| t["index"] == 0)
            .cloned()
            .unwrap_or(Value::Null);
        trials.sort_by(|a, b| {
            number(&b["score"], f64::NEG_INFINITY)
                .total_cmp(&number(&a["score"], f64::NEG_INFINITY))
        });
        let best = trials
            .iter()
            .find(|t| t["sufficient"] == true)
            .cloned()
            .unwrap_or(Value::Null);
        let improves_baseline = !best.is_null()
            && number(&best["validation"]["returnPct"], 0.)
                > number(&baseline["validation"]["returnPct"], 0.)
            && number(&best["validation"]["returnPct"], 0.) > 0.
            && number(&best["training"]["maxDrawdownPct"], 100.)
                <= number(&manifest["settings"]["optimization"]["maxDrawdown"], 0.3) * 100.;
        reports.insert(
            id.clone(),
            json!({"name":manifest["strategies"][&id]["name"],"baseline":baseline,
            "best":best,"completedCandidates":trials.len(),"ranking":trials,
            "improvesBaselineOnValidation":improves_baseline,
            "holdout":directory.join(format!("holdout-{id}.json")).exists()}),
        );
    }
    let total = ids(manifest).len()
        * symbols(manifest).len()
        * number(&manifest["settings"]["maxTrials"], 64.) as usize;
    Ok(
        json!({"updatedAt":iso(now_ms()),"completedUnits":units,"totalUnits":total,
        "completedCandidates":completed,"startTime":iso(timestamp(&manifest["startTime"]).unwrap()),
        "endTime":iso(timestamp(&manifest["endTime"]).unwrap()),"symbols":manifest["symbols"],
        "strategies":reports,"selection":"同一参数跨币种等权汇总；训练收益减回撤、验证不稳定惩罚；测试留到搜索完成",
        "researchOnly":true,"limitations":manifest["limitations"]}),
    )
}
fn candidate(directory: &Path, manifest: &Value, index: usize, id: &str) -> Result<Value> {
    let path = directory
        .join("parameters")
        .join(format!("{index:04}-{id}.json"));
    if path.exists() {
        return read_json(&path);
    }
    let spec = spec(manifest, id);
    let params = if index == 0 {
        spec.base.clone()
    } else {
        let ranking = summary(directory, manifest)?;
        let center = ranking["strategies"][id]["best"]["params"]
            .as_object()
            .map(|_| ranking["strategies"][id]["best"]["params"].clone())
            .unwrap_or_else(|| spec.base.clone());
        let mut seed =
            number(&manifest["settings"]["seed"], 20261008.) as u64 + index as u64 * 7919;
        for byte in id.bytes() {
            seed = seed.wrapping_mul(31).wrapping_add(byte as u64);
        }
        if seed == 0 {
            seed = 1;
        }
        let mut params = optimizer::sample_params(
            &spec,
            &mut seed,
            &center,
            if index.is_multiple_of(4) { 1. } else { 0.25 },
        );
        params["marketBookEnabled"] = json!(false);
        params["marketRequireData"] = json!(true);
        params
    };
    write_json(&path, &params)?;
    Ok(params)
}
async fn history(
    directory: &Path,
    manifest: &Value,
    symbol: &str,
    db: &Db,
    exchange: &Exchange,
) -> Result<History> {
    let path = directory.join("data").join(format!("{symbol}.json"));
    if path.exists() {
        return Ok(serde_json::from_value(read_json(&path)?)?);
    }
    let start = timestamp(&manifest["startTime"]).unwrap();
    let end = timestamp(&manifest["endTime"]).unwrap();
    let mut covered = BTreeMap::<String, usize>::new();
    let mut all_ids = ids(manifest);
    all_ids.sort_by_key(|id| {
        std::cmp::Reverse(
            strategies::definition(id).unwrap()["needsAux"]
                .as_array()
                .map(Vec::len)
                .unwrap_or(0),
        )
    });
    let mut downloads = vec![];
    for id in &all_ids {
        let definition = strategies::definition(id).unwrap();
        let mut required = BTreeMap::from([("1m".to_string(), 1520_usize)]);
        for tf in definition["needsAux"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            required.insert(
                tf.into(),
                number(&definition["marketWindows"][tf], 200.) as usize,
            );
        }
        if let Some(tf) = definition["planInterval"].as_str() {
            required.entry(tf.into()).or_insert(200);
        }
        if required
            .iter()
            .all(|(tf, window)| covered.get(tf).is_some_and(|current| current >= window))
        {
            continue;
        }
        let result = indicator_history::fetch(
            db,
            exchange,
            &json!({"symbol":symbol,"strategyId":id,"startTime":start,"endTime":end}),
        )
        .await?;
        downloads.push(result.clone());
        write_json(
            &directory.join("downloads").join(format!("{symbol}.json")),
            &json!({"results":downloads}),
        )?;
        if result["complete"] != true {
            bail!("{symbol} 公共历史请求部分失败：{}", result["errors"]);
        }
        for (tf, window) in required {
            covered
                .entry(tf)
                .and_modify(|v| *v = (*v).max(window))
                .or_insert(window);
        }
    }
    let mut datasets = BTreeMap::new();
    for (tf, window) in covered {
        let dt = interval_ms(&tf).context("策略周期错误")?;
        let rows = db
            .candles(
                &storage_symbol(symbol, "binance")?,
                &tf,
                100_000,
                Some(start - (window as i64 + 2) * dt),
                Some(end),
            )
            .await?;
        if rows.is_empty() {
            bail!("{symbol}/{tf} 历史为空");
        }
        datasets.insert(tf, rows);
    }
    let samples = db
        .indicator_samples(symbol, start - 2 * 86_400_000, end)
        .await?;
    let history = History { datasets, samples };
    if coverage(&history, start, end) < number(&manifest["settings"]["minimumCoverage"], 0.99) {
        bail!("{symbol} 1m 历史覆盖不足 99%，不能当作完整月度样本");
    }
    write_json(&path, &serde_json::to_value(&history)?)?;
    Ok(history)
}
pub fn status(directory: &Path, phase: &str, unit: Value) -> Result<()> {
    write_json(
        &directory.join("status.json"),
        &json!({"at":iso(now_ms()),"pid":std::process::id(),"phase":phase,"unit":unit}),
    )
}
pub async fn run(
    root: &Path,
    directory: &Path,
    settings: &Value,
    max_units: usize,
    watch: bool,
) -> Result<()> {
    let _lock = lock_directory(directory)?;
    let db = Db::connect().await?;
    let exchange = Exchange::public()?;
    let manifest_path = directory.join("manifest.json");
    let manifest = if manifest_path.exists() {
        read_json(&manifest_path)?
    } else {
        let manifest = create_manifest(root, settings, &db, &exchange).await?;
        write_json(&manifest_path, &manifest)?;
        manifest
    };
    if manifest["engineVersion"] != engine_version() {
        bail!("回放代码已变化，请为新版本使用新的输出目录，旧结果保持可查");
    }
    if manifest["environment"] != serde_json::to_value(environment_snapshot())? {
        bail!("风控环境参数已变化，不能混合旧结果；请恢复原环境或用新目录");
    }
    let split = optimizer::split_range(
        timestamp(&manifest["startTime"]).unwrap(),
        timestamp(&manifest["endTime"]).unwrap(),
        &manifest["settings"]["optimization"],
    )?;
    let config = backtest::trading_config(&manifest["config"]);
    let initial = number(&manifest["settings"]["initialBalance"], 10000.);
    let mut completed = 0;
    let mut cached: Option<(String, History)> = None;
    write_json(
        &directory.join("summary.json"),
        &summary(directory, &manifest)?,
    )?;
    loop {
        let mut progress = false;
        let mut unavailable = BTreeSet::new();
        // Freeze month-limited statistics before spending hours on replay.
        for symbol in symbols(&manifest) {
            if directory.join("STOP").exists() {
                return Ok(());
            }
            if directory
                .join("data")
                .join(format!("{symbol}.json"))
                .exists()
            {
                continue;
            }
            status(directory, "downloading", json!({"symbol":symbol}))?;
            if let Err(error) = history(directory, &manifest, &symbol, &db, &exchange).await {
                unavailable.insert(symbol.clone());
                write_json(
                    &directory.join("errors").join(format!("{symbol}.json")),
                    &json!({"at":iso(now_ms()),"symbol":symbol,"error":format!("{error:#}")}),
                )?;
                eprintln!("历史暂不可用 {symbol}: {error:#}");
            }
        }
        if !unavailable.is_empty() {
            status(
                directory,
                "data_retry",
                json!({"symbols":unavailable,"retryAfterSeconds":300}),
            )?;
            if !watch {
                bail!("月度数据尚未齐备，进度已保存，可稍后重试");
            }
            tokio::time::sleep(std::time::Duration::from_secs(300)).await;
            continue;
        }
        for index in 0..number(&manifest["settings"]["maxTrials"], 64.) as usize {
            for symbol in symbols(&manifest) {
                if unavailable.contains(&symbol) {
                    continue;
                }
                for id in ids(&manifest) {
                    let path = result_path(directory, index, &id, &symbol);
                    if path.exists() {
                        continue;
                    }
                    if directory.join("STOP").exists() || (max_units > 0 && completed >= max_units)
                    {
                        status(directory, "paused", json!({"completedThisRun":completed}))?;
                        return Ok(());
                    }
                    let unit = json!({"candidate":index,"strategy":id,"symbol":symbol});
                    if !cached.as_ref().is_some_and(|(name, _)| name == &symbol) {
                        status(directory, "downloading", unit.clone())?;
                        match history(directory, &manifest, &symbol, &db, &exchange).await {
                            Ok(history) => cached = Some((symbol.clone(), history)),
                            Err(error) => {
                                status(
                                    directory,
                                    "data_error",
                                    json!({"unit":unit,"error":format!("{error:#}")}),
                                )?;
                                eprintln!("历史暂不可用 {symbol}: {error:#}");
                                break;
                            }
                        }
                    }
                    let params = candidate(directory, &manifest, index, &id)?;
                    let spec = spec(&manifest, &id);
                    status(directory, "replaying", unit.clone())?;
                    let mut result = optimizer::evaluate_params(
                        &symbol,
                        &spec,
                        &params,
                        &cached.as_ref().unwrap().1,
                        &config,
                        &manifest["adaptive"],
                        &split,
                        initial,
                        number(&manifest["settings"]["optimization"]["minTrades"], 10.),
                    )?;
                    result["unit"] = unit.clone();
                    result["finishedAt"] = json!(iso(now_ms()));
                    write_json(&path, &result)?;
                    let report = summary(directory, &manifest)?;
                    write_json(&directory.join("summary.json"), &report)?;
                    completed += 1;
                    progress = true;
                    println!(
                        "完成 {id}/{symbol} 参数 {index}：训练 {}%，{} 笔；验证 {}%，{} 笔。总进度 {}/{}",
                        result["training"]["returnPct"],
                        result["training"]["closedTrades"],
                        result["validation"]["returnPct"],
                        result["validation"]["closedTrades"],
                        report["completedUnits"],
                        report["totalUnits"]
                    );
                }
            }
        }
        let report = summary(directory, &manifest)?;
        // Open the untouched final period only after this strategy's search is complete.
        for id in ids(&manifest) {
            let heldout_path = directory.join(format!("holdout-{id}.json"));
            let row = &report["strategies"][&id];
            if heldout_path.exists()
                || number(&row["completedCandidates"], 0.)
                    < number(&manifest["settings"]["maxTrials"], 64.)
            {
                continue;
            }
            if row["best"].is_null() {
                write_json(
                    &heldout_path,
                    &json!({"skipped":true,"reason":"训练/验证成交数或币种覆盖不足，没有可靠候选"}),
                )?;
                continue;
            }
            let mut results = vec![];
            for symbol in symbols(&manifest) {
                let hist = history(directory, &manifest, &symbol, &db, &exchange).await?;
                status(directory, "holdout", json!({"strategy":id,"symbol":symbol}))?;
                let result = optimizer::holdout(
                    &symbol,
                    &spec(&manifest, &id),
                    &row["best"]["params"],
                    &hist,
                    &config,
                    &manifest["adaptive"],
                    &split,
                    initial,
                )?;
                results.push(json!({"symbol":symbol,"holdout":result}));
            }
            write_json(
                &heldout_path,
                &json!({"params":row["best"]["params"],"aggregate":aggregate(&results,"holdout"),"symbols":results}),
            )?;
        }
        write_json(
            &directory.join("summary.json"),
            &summary(directory, &manifest)?,
        )?;
        status(
            directory,
            if progress {
                "batch_complete"
            } else {
                "waiting"
            },
            json!({"completedThisRun":completed}),
        )?;
        if !watch {
            return Ok(());
        }
        tokio::time::sleep(std::time::Duration::from_secs(300)).await;
        if directory.join("STOP").exists() {
            return Ok(());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn atomic_results_and_process_lock_survive_resume() {
        let dir = tempfile::tempdir().unwrap();
        let first = lock_directory(dir.path()).unwrap();
        assert!(lock_directory(dir.path()).is_err());
        let path = dir.path().join("result.json");
        write_json(&path, &json!({"unit":1})).unwrap();
        write_json(&path, &json!({"unit":2})).unwrap();
        assert_eq!(read_json(&path).unwrap()["unit"], 2);
        drop(first);
        assert!(lock_directory(dir.path()).is_ok());
    }
    #[test]
    fn aggregate_is_equal_weight_and_reports_worst_symbol_drawdown() {
        let rows = vec![
            json!({"training":{"returnPct":10,"maxDrawdownPct":3,"closedTrades":2}}),
            json!({"training":{"returnPct":-2,"maxDrawdownPct":8,"closedTrades":1,"missing":{"oi":4},"marketGaps":2}}),
        ];
        let result = aggregate(&rows, "training");
        assert_eq!(result["returnPct"], 4.);
        assert_eq!(result["maxDrawdownPct"], 8.);
        assert_eq!(result["missingChecks"], 4.);
        assert_eq!(result["marketGaps"], 2.);
        assert_eq!(result["tradingSymbols"], 2);
    }
    #[test]
    fn manifest_config_excludes_credentials() {
        let cfg = research_config(
            &json!({"trader":{"minConfidence":0.7},"binance":{"apiKey":"secret"},"model":{"apiKey":"secret"}}),
        );
        assert!(cfg.get("binance").is_none());
        assert!(cfg.get("model").is_none());
        assert_eq!(cfg["trader"]["minConfidence"], 0.7);
    }
    #[test]
    fn candidates_resume_identically_without_touching_holdout() {
        let dir = tempfile::tempdir().unwrap();
        let id = "enhanced-trend-v1";
        let base = strategies::defaults(id);
        let manifest = json!({"startTime":1700000040000_i64,"endTime":1702592040000_i64,
            "symbols":["BTCUSDT"],"settings":{"maxTrials":2,"seed":7},
            "strategies":{id:{"params":base,"space":search_space(id,&base).unwrap()}}});
        let one = candidate(dir.path(), &manifest, 1, id).unwrap();
        assert_eq!(one, candidate(dir.path(), &manifest, 1, id).unwrap());
        assert!(!dir.path().join(format!("holdout-{id}.json")).exists());
        assert_eq!(one["marketBookEnabled"], false);
        assert_eq!(one["marketRequireData"], true);
    }
    #[test]
    fn all_registered_strategy_search_spaces_keep_base_risk_limits() {
        for strategy in strategies::definitions() {
            let id = strategy["id"].as_str().unwrap();
            let base = strategy["defaults"].clone();
            let space = search_space(id, &base).unwrap();
            assert!(space.contains_key("marketOiEnabled"));
            assert!(!space.contains_key("maxLeverage"));
            assert!(!space.contains_key("riskBudgetPct"));
            assert!(!space.contains_key("marketBookEnabled"));
        }
    }
    #[test]
    fn partial_candidate_is_not_ranked_and_data_gaps_disqualify_it() {
        let dir = tempfile::tempdir().unwrap();
        let id = "enhanced-trend-v1";
        let manifest = json!({"symbols":["BTCUSDT","ETHUSDT"],"settings":{"optimization":{
            "minTrades":10,"minValidationTrades":5,"minTradingSymbols":2}}});
        let row = json!({"params":{"marketFlowEnabled":true},
            "training":{"closedTrades":10,"returnPct":5,"maxDrawdownPct":2,"marketGaps":0},
            "validation":{"closedTrades":5,"returnPct":3,"maxDrawdownPct":1,"marketGaps":0}});
        write_json(&result_path(dir.path(), 0, id, "BTCUSDT"), &row).unwrap();
        assert!(
            trial_complete(dir.path(), &manifest, 0, id)
                .unwrap()
                .is_none()
        );
        write_json(&result_path(dir.path(), 0, id, "ETHUSDT"), &row).unwrap();
        assert_eq!(
            trial_complete(dir.path(), &manifest, 0, id)
                .unwrap()
                .unwrap()["sufficient"],
            true
        );
        let mut broken = row.clone();
        broken["training"]["marketGaps"] = json!(1);
        write_json(&result_path(dir.path(), 0, id, "ETHUSDT"), &broken).unwrap();
        assert_eq!(
            trial_complete(dir.path(), &manifest, 0, id)
                .unwrap()
                .unwrap()["sufficient"],
            false
        );
        broken["params"]["marketFlowEnabled"] = json!(false);
        write_json(&result_path(dir.path(), 0, id, "ETHUSDT"), &broken).unwrap();
        assert!(trial_complete(dir.path(), &manifest, 0, id).is_err());
    }
}
