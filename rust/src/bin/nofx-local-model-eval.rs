//! Local-model entry-veto experiment, with frozen candles and the production paper engine.
//! No database, account configuration, exchange requests, or order submission services are used.
use anyhow::{Context, Result, bail};
use clap::Parser;
use nofx_core::{analytics, backtest::History, iso, number, paper, research, timestamp};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{fs, path::PathBuf, time::Instant};

const INTERVAL: &str = "15m";
const BAR_MS: i64 = 900_000;
const WINDOW: usize = 80;
const PENDING_BARS: usize = 96;
const RESERVED_HOLDOUT_START: i64 = 1_790_944_920_000;

#[derive(Parser)]
#[command(about = "只读本地模型 BUY/WAIT 过滤实验；历史样本不代表组合收益")]
struct Args {
    #[arg(
        long,
        default_value = "output/profit-improvement-20261011/data/BTCUSDT.json"
    )]
    history: PathBuf,
    #[arg(long, default_value = "BTCUSDT")]
    symbol: String,
    #[arg(long, default_value = "http://127.0.0.1:18080/v1")]
    base_url: String,
    #[arg(long, default_value = "qwen2.5-0.5b-instruct")]
    model: String,
    /// Diagnose explicit BUY/WAIT instruction following and schema order; no history is read.
    #[arg(long)]
    sanity_only: bool,
    #[arg(long, default_value_t = 24, value_parser = clap::value_parser!(u32).range(1..=200))]
    samples: u32,
    /// Used training/validation window only; the source's final 20% stays reserved.
    #[arg(long, default_value_t = 1_788_871_320_000_i64)]
    start: i64,
    #[arg(long, default_value_t = 1_790_944_920_000_i64)]
    end: i64,
    #[arg(long, default_value = "output/local-model-eval-20261014.json")]
    output: PathBuf,
}

#[derive(Clone)]
struct Candidate {
    at: i64,
    signal: Value,
    payload: Value,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "UPPERCASE")]
enum Decision {
    Buy,
    Wait,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ModelDecision {
    decision: Decision,
    reason: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BareDecision {
    decision: Decision,
}

#[derive(Clone, Copy)]
enum SanityFormat {
    BuyFirst,
    WaitFirst,
    Raw,
}

impl SanityFormat {
    fn name(self) -> &'static str {
        match self {
            Self::BuyFirst => "schema_buy_first",
            Self::WaitFirst => "schema_wait_first",
            Self::Raw => "raw",
        }
    }

    fn enum_order(self) -> Value {
        match self {
            Self::BuyFirst => json!(["BUY", "WAIT"]),
            Self::WaitFirst => json!(["WAIT", "BUY"]),
            Self::Raw => Value::Null,
        }
    }
}

struct SanityCase {
    name: &'static str,
    prompt: &'static str,
    expected: Decision,
    format: SanityFormat,
}

fn sanity_cases() -> Vec<SanityCase> {
    let definitions = [
        (
            "explicit_wait",
            "Output exactly {\"decision\":\"WAIT\"}.",
            Decision::Wait,
            vec![
                SanityFormat::BuyFirst,
                SanityFormat::WaitFirst,
                SanityFormat::Raw,
            ],
        ),
        (
            "explicit_buy",
            "Output exactly {\"decision\":\"BUY\"}.",
            Decision::Buy,
            vec![SanityFormat::BuyFirst, SanityFormat::Raw],
        ),
        (
            "eligible_false",
            "Rule: if eligible is false, decision must be WAIT; if eligible is true, decision must be BUY. Input: {\"eligible\":false}. Output one JSON object with only the decision field.",
            Decision::Wait,
            vec![SanityFormat::WaitFirst, SanityFormat::Raw],
        ),
        (
            "eligible_true",
            "Rule: if eligible is false, decision must be WAIT; if eligible is true, decision must be BUY. Input: {\"eligible\":true}. Output one JSON object with only the decision field.",
            Decision::Buy,
            vec![SanityFormat::BuyFirst, SanityFormat::Raw],
        ),
    ];
    definitions
        .into_iter()
        .flat_map(|(name, prompt, expected, formats)| {
            formats.into_iter().map(move |format| SanityCase {
                name,
                prompt,
                expected,
                format,
            })
        })
        .collect()
}

async fn sanity_call(client: &reqwest::Client, args: &Args, case: &SanityCase) -> Value {
    let system = "Follow the user's instruction exactly. Return only a JSON object with the decision field. Do not add explanations or extra fields.";
    let mut request = json!({
        "model":args.model,"temperature":0,"seed":42,"max_tokens":48,
        "messages":[{"role":"system","content":system},{"role":"user","content":case.prompt}]
    });
    if !matches!(case.format, SanityFormat::Raw) {
        request["response_format"] = json!({"type":"json_schema","json_schema":{
            "name":"sanity_decision","strict":true,"schema":{
                "type":"object","additionalProperties":false,"required":["decision"],
                "properties":{"decision":{"type":"string","enum":case.format.enum_order()}}
            }
        }});
    }
    let start = Instant::now();
    let mut raw_content = Value::Null;
    let mut usage = Value::Null;
    let mut finish_reason = Value::Null;
    let result: Result<Decision> = async {
        let response = client
            .post(format!(
                "{}/chat/completions",
                args.base_url.trim_end_matches('/')
            ))
            .json(&request)
            .send()
            .await?;
        let status = response.status();
        let body: Value = response
            .json()
            .await
            .context("non-JSON model HTTP response")?;
        if !status.is_success() {
            bail!("model HTTP {status}: {}", body["error"]);
        }
        raw_content = body["choices"][0]["message"]["content"].clone();
        usage = body["usage"].clone();
        finish_reason = body["choices"][0]["finish_reason"].clone();
        let parsed: BareDecision =
            serde_json::from_str(raw_content.as_str().context("missing model content")?)
                .context("invalid bare decision JSON")?;
        Ok(parsed.decision)
    }
    .await;
    let (actual, error, passed) = match result {
        Ok(actual) => (json!(actual), Value::Null, actual == case.expected),
        Err(error) => (Value::Null, json!(format!("{error:#}")), false),
    };
    json!({
        "case":case.name,"format":case.format.name(),"enumOrder":case.format.enum_order(),
        "systemPrompt":system,"userPrompt":case.prompt,"responseFormat":request["response_format"],
        "expected":case.expected,"actual":actual,"passed":passed,"error":error,
        "rawContent":raw_content,"latencyMs":start.elapsed().as_millis(),
        "finishReason":finish_reason,"usage":usage
    })
}

async fn run_sanity(client: &reqwest::Client, args: &Args) -> Result<()> {
    let mut report = json!({
        "version":1,"mode":"sanity-only","researchOnly":true,"historyRead":false,"simulatorUsed":false,
        "model":args.model,"baseUrl":args.base_url,"temperature":0,"seed":42,"maxTokens":48,
        "purpose":"Separate enum-order effects and basic instruction failure from market reasoning",
        "calls":[],"completed":false
    });
    let mut calls = Vec::new();
    for case in sanity_cases() {
        let result = sanity_call(client, args, &case).await;
        println!(
            "sanity {} {} expected={} actual={} passed={}",
            case.name,
            case.format.name(),
            result["expected"],
            result["actual"],
            result["passed"]
        );
        calls.push(result);
        report["calls"] = json!(calls);
        save(&args.output, &report)?;
    }
    let by_format: Vec<_> = [SanityFormat::BuyFirst,SanityFormat::WaitFirst,SanityFormat::Raw]
        .into_iter().map(|format| {
            let rows: Vec<_> = calls.iter().filter(|c| c["format"] == format.name()).collect();
            json!({"format":format.name(),"calls":rows.len(),"passed":rows.iter().filter(|c|c["passed"]==true).count(),"errors":rows.iter().filter(|c|!c["error"].is_null()).count()})
        }).collect();
    report["summary"] = json!({
        "calls":calls.len(),"passed":calls.iter().filter(|c|c["passed"]==true).count(),
        "errors":calls.iter().filter(|c|!c["error"].is_null()).count(),"byFormat":by_format
    });
    report["completed"] = json!(true);
    save(&args.output, &report)?;
    println!(
        "sanity summary={} report={}",
        report["summary"],
        args.output.display()
    );
    Ok(())
}

fn parse_decision(content: &str) -> Result<ModelDecision> {
    let parsed: ModelDecision = serde_json::from_str(content).context("invalid decision JSON")?;
    if parsed.reason.trim().is_empty() || parsed.reason.chars().count() > 240 {
        bail!("reason must contain 1..240 characters");
    }
    Ok(parsed)
}

fn mean(rows: &[Value], period: usize) -> f64 {
    rows[rows.len() - period..]
        .iter()
        .map(|r| number(&r["close"], f64::NAN))
        .sum::<f64>()
        / period as f64
}

fn guard_issues(payload: &Value) -> Vec<&'static str> {
    let mut issues = Vec::new();
    if payload["eligible"] != true {
        issues.push("signal_not_eligible");
    }
    if payload["dataFresh"] != true || number(&payload["closedCandleCount"], 0.) < 50. {
        issues.push("stale_or_insufficient_closed_candles");
    }
    let price = number(&payload["price"], f64::NAN);
    let fast = number(&payload["ma20"], f64::NAN);
    let slow = number(&payload["ma50"], f64::NAN);
    let atr = number(&payload["atr14"], f64::NAN);
    if payload["trendEvidence"] != true || !(price >= fast && fast > slow) {
        issues.push("missing_or_conflicting_long_trend");
    }
    if !atr.is_finite()
        || atr <= 0.
        || !price.is_finite()
        || price <= 0.
        || !(0.0005..=0.08).contains(&(atr / price))
        || (price - fast).abs() > atr
    {
        issues.push("invalid_volatility_or_chasing");
    }
    let plan = &payload["plan"];
    let min = number(&plan["entryMin"], f64::NAN);
    let max = number(&plan["entryMax"], f64::NAN);
    let stop = number(&plan["stopLoss"], f64::NAN);
    let target = number(&plan["takeProfit"], f64::NAN);
    let entry = number(&plan["entryLimit"], max);
    if ![min, max, stop, target, entry]
        .iter()
        .all(|v| v.is_finite() && *v > 0.)
        || !(stop < min && min <= max && max < target && stop < entry && entry < target)
    {
        issues.push("invalid_long_protection_prices");
    }
    let hold = number(&plan["maxHoldBars"], f64::NAN);
    if !hold.is_finite() || hold.fract() != 0. || !(1. ..=120.).contains(&hold) {
        issues.push("invalid_holding_horizon");
    }
    if number(&payload["netRewardRisk"], 0.) < 1. {
        issues.push("net_reward_risk_below_one");
    }
    issues
}

/// The model-visible input is built exclusively from the closed prefix.
fn candidate_at(rows: &[Value], end: usize, symbol: &str) -> Result<Option<Candidate>> {
    if end < WINDOW || end > rows.len() {
        return Ok(None);
    }
    let at =
        timestamp(&rows[end - 1]["openTime"]).context("invalid historical open time")? + BAR_MS;
    let market = research::prepare_market(symbol, INTERVAL, &rows[..end], WINDOW, at)?;
    let raw = analytics::local_analysis(&market);
    let signal = research::normalize_plan(&raw, &market, at);
    if signal["eligible"] != true || signal["positionRecommendation"] != "OPEN_LONG" {
        return Ok(None);
    }
    let closed = market["klines"]
        .as_array()
        .context("missing closed candles")?;
    let atr = closed[closed.len() - 14..]
        .iter()
        .enumerate()
        .map(|(i, r)| {
            let previous = number(&closed[closed.len() - 15 + i]["close"], f64::NAN);
            let high = number(&r["high"], f64::NAN);
            let low = number(&r["low"], f64::NAN);
            (high - low)
                .max((high - previous).abs())
                .max((low - previous).abs())
        })
        .sum::<f64>()
        / 14.;
    let payload = json!({
        "symbol":symbol, "interval":INTERVAL, "asOf":iso(at),
        "closedCandleCount":closed.len(), "dataFresh":true, "eligible":true,
        "trendEvidence":true, "price":closed.last().unwrap()["close"],
        "ma20":mean(closed,20), "ma50":mean(closed,50), "atr14":atr,
        "netRewardRisk":signal["plan"]["netRewardRisk"], "plan":signal["plan"],
        "costs":research::costs(), "marginUsdt":100, "leverage":1
    });
    if !guard_issues(&payload).is_empty() {
        return Ok(None);
    }
    Ok(Some(Candidate {
        at,
        signal,
        payload,
    }))
}

fn eligible_candidates(rows: &[Value], symbol: &str) -> (Vec<Candidate>, usize) {
    let mut candidates = Vec::new();
    let mut invalid_windows = 0;
    for end in WINDOW..rows.len() {
        match candidate_at(rows, end, symbol) {
            Ok(Some(candidate)) => {
                let hold = number(&candidate.signal["plan"]["maxHoldBars"], 120.) as usize;
                let horizon = end + PENDING_BARS + hold + 2;
                if horizon <= rows.len()
                    && rows[end - 1..horizon].windows(2).all(|pair| {
                        timestamp(&pair[1]["openTime"]).unwrap_or(i64::MAX)
                            - timestamp(&pair[0]["openTime"]).unwrap_or(0)
                            == BAR_MS
                    })
                {
                    candidates.push(candidate);
                }
            }
            Ok(None) => {}
            Err(_) => invalid_windows += 1,
        }
    }
    (candidates, invalid_windows)
}

fn evenly_spaced(total: usize, requested: usize) -> Vec<usize> {
    let count = total.min(requested);
    match count {
        0 => vec![],
        1 => vec![total / 2],
        _ => (0..count).map(|i| i * (total - 1) / (count - 1)).collect(),
    }
}

fn closed_before(rows: &[Value], end: i64) -> Vec<Value> {
    rows.iter()
        .filter(|r| timestamp(&r["openTime"]).is_some_and(|at| at + BAR_MS <= end))
        .cloned()
        .collect()
}

async fn ask_model(client: &reqwest::Client, args: &Args, payload: &Value) -> Value {
    let start = Instant::now();
    let guard = guard_issues(payload);
    let schema = json!({"type":"object","additionalProperties":false,"required":["decision","reason"],"properties":{"decision":{"type":"string","enum":["BUY","WAIT"]},"reason":{"type":"string","minLength":1,"maxLength":240}}});
    let request = json!({
        "model":args.model, "temperature":0, "seed":42, "max_tokens":160,
        "response_format":{"type":"json_schema","json_schema":{"name":"entry_veto","strict":true,"schema":schema}},
        "messages":[
            {"role":"system","content":"Review this proposed LONG trade using ONLY the supplied closed-candle evidence. Return BUY to permit the fixed research plan only when eligible and dataFresh are true, closedCandleCount >=50, trendEvidence is true, price >= ma20 > ma50, volatility is reasonable, stopLoss is below entry, takeProfit above entry, and netRewardRisk >=1. Reject stale data, missing trend evidence, invalid protection, low reward/risk, or excessive volatility with WAIT. Uncertain evidence: WAIT. Do not invent prices or future returns. Output exactly JSON with decision BUY or WAIT and a short English reason, at most 30 words. This is an offline experiment; BUY never places a real order."},
            {"role":"user","content":payload.to_string()}
        ]
    });
    let mut raw_content = None;
    let result: Result<(ModelDecision, Value)> = async {
        let response = client
            .post(format!(
                "{}/chat/completions",
                args.base_url.trim_end_matches('/')
            ))
            .json(&request)
            .send()
            .await?;
        let status = response.status();
        let body: Value = response
            .json()
            .await
            .context("non-JSON model HTTP response")?;
        if !status.is_success() {
            bail!("model HTTP {status}: {}", body["error"]);
        }
        let raw = body["choices"][0]["message"]["content"]
            .as_str()
            .context("missing model content")?
            .to_owned();
        raw_content = Some(raw.clone());
        let parsed = parse_decision(&raw)?;
        Ok((parsed, body["usage"].clone()))
    }
    .await;
    match result {
        Ok((parsed, usage)) => json!({
            "modelDecision":parsed.decision,
            "effectiveDecision":if guard.is_empty(){parsed.decision}else{Decision::Wait},
            "reason":parsed.reason, "rawContent":raw_content, "error":null,
            "guardIssues":guard, "latencyMs":start.elapsed().as_millis(), "usage":usage
        }),
        Err(error) => json!({
            "modelDecision":null, "effectiveDecision":"WAIT", "reason":"Model failure: fail closed",
            "rawContent":raw_content, "error":format!("{error:#}"), "guardIssues":guard,
            "latencyMs":start.elapsed().as_millis()
        }),
    }
}

fn simulate(candidate: &Candidate, rows: &[Value], symbol: &str) -> Result<Value> {
    let mut state = json!({"initialBalance":1000,"unlimitedCapital":false,"orders":[]});
    let record = json!({"id":format!("local-model-{}",candidate.at),"marketProvider":"binance","analysisEngine":"local","analyses":[candidate.signal]});
    let mut order = paper::submit_paper_order(
        &mut state,
        &record,
        &json!({"symbol":symbol,"margin":100,"leverage":1}),
        candidate.at,
    )?;
    let end = candidate.at
        + 86_400_000
        + number(&candidate.signal["plan"]["maxHoldBars"], 120.) as i64 * BAR_MS
        + 2 * BAR_MS;
    // Chronological advancement preserves the production pending-expiry rule.
    for row in rows {
        let at = timestamp(&row["openTime"]).context("invalid simulation candle time")? + BAR_MS;
        if at <= candidate.at || at > end {
            continue;
        }
        paper::advance_paper_order(&mut order, rows, at)?;
        if !order["error"].as_str().unwrap_or("").is_empty() {
            bail!(
                "shared simulator encountered a data gap: {}",
                order["error"]
            );
        }
        if !matches!(order["status"].as_str(), Some("pending" | "open")) {
            break;
        }
    }
    if matches!(order["status"].as_str(), Some("pending" | "open")) {
        bail!("candidate did not settle within its full simulation horizon");
    }
    Ok(json!({
        "status":order["status"], "entry":order["entry"], "entryAt":order["entryAt"],
        "exit":order["exit"], "exitAt":order["exitAt"], "reason":order["reason"],
        "net":number(&order["net"],0.), "gross":order["gross"], "fee":order["fee"],
        "funding":order["funding"], "heldBars":order["heldBars"], "ambiguousBar":order["ambiguousBar"],
        "costs":order["costs"], "margin":100, "leverage":1
    }))
}

fn controls() -> Vec<(String, Value, bool)> {
    let positive = json!({
        "synthetic":true,"symbol":"SYNTHETIC","interval":"15m","closedCandleCount":80,
        "dataFresh":true,"eligible":true,"trendEvidence":true,"price":100.5,
        "ma20":100.,"ma50":99.,"atr14":1.,"netRewardRisk":1.5,
        "plan":{"entryMin":99.7,"entryMax":100.7,"entryLimit":100.,"stopLoss":98.,"takeProfit":104.,"maxHoldBars":12},
        "costs":research::costs(),"marginUsdt":100,"leverage":1
    });
    let changes = [
        ("invalid_stop", "stopLoss", json!(101.)),
        ("invalid_take_profit", "takeProfit", json!(99.)),
    ];
    let mut result = Vec::new();
    for (name, key, value) in changes {
        let mut input = positive.clone();
        input["plan"][key] = value;
        result.push((name.into(), input, false));
    }
    for (name, key, value) in [
        ("stale_data", "dataFresh", json!(false)),
        ("ineligible_signal", "eligible", json!(false)),
        ("low_net_reward_risk", "netRewardRisk", json!(0.6)),
        ("missing_trend", "trendEvidence", json!(false)),
        ("insufficient_candles", "closedCandleCount", json!(20)),
        ("extreme_volatility", "atr14", json!(12.)),
    ] {
        let mut input = positive.clone();
        input[key] = value;
        result.push((name.into(), input, false));
    }
    result.push(("plausible_positive".into(), positive.clone(), true));
    let mut stronger = positive;
    stronger["ma50"] = json!(98.);
    stronger["netRewardRisk"] = json!(2.5);
    stronger["plan"]["takeProfit"] = json!(106.);
    result.push(("plausible_stronger_positive".into(), stronger, true));
    result
}

fn summarize(rows: &[Value], filtered: bool) -> Value {
    let selected: Vec<_> = rows
        .iter()
        .filter(|r| !filtered || r["model"]["effectiveDecision"] == "BUY")
        .collect();
    let closed: Vec<_> = selected
        .iter()
        .filter(|r| r["outcome"]["status"] == "closed")
        .collect();
    let wins = closed
        .iter()
        .filter(|r| number(&r["outcome"]["net"], 0.) > 0.)
        .count();
    let net = closed
        .iter()
        .map(|r| number(&r["outcome"]["net"], 0.))
        .sum::<f64>();
    json!({
        "permittedCandidates":selected.len(), "closedTrades":closed.len(), "wins":wins,
        "winRatePct":if closed.is_empty(){Value::Null}else{json!(100.*wins as f64/closed.len() as f64)},
        "netPnlUsdt":net, "expiredCandidates":selected.iter().filter(|r| r["outcome"]["status"] == "expired").count()
    })
}

fn save(path: &PathBuf, report: &Value) -> Result<()> {
    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, serde_json::to_vec_pretty(report)?)?;
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    let endpoint = url::Url::parse(&args.base_url).context("invalid model URL")?;
    if endpoint.scheme() != "http"
        || !matches!(endpoint.host_str(), Some("127.0.0.1" | "localhost" | "::1"))
    {
        bail!("this experiment requires an HTTP model endpoint on localhost");
    }
    if args.output.exists() {
        bail!("output already exists; choose a new report path");
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()?;
    if args.sanity_only {
        return run_sanity(&client, &args).await;
    }
    if args.start >= args.end {
        bail!("start must precede end");
    }
    if args.end > RESERVED_HOLDOUT_START {
        bail!("end exceeds the frozen campaign's reserved final 20% boundary; use an earlier end");
    }
    let bytes = fs::read(&args.history).context("read frozen history")?;
    let history: History = serde_json::from_slice(&bytes).context("parse frozen History JSON")?;
    let source_rows = history
        .datasets
        .get(INTERVAL)
        .context("history has no 15m candles")?;
    let rows = closed_before(source_rows, args.end);
    let (mut candidates, invalid_windows) = eligible_candidates(&rows, &args.symbol);
    candidates.retain(|c| c.at >= args.start && c.at < args.end);
    if candidates.is_empty() {
        bail!("no valid historical long candidates with a complete future horizon");
    }
    let selected = evenly_spaced(candidates.len(), args.samples as usize);
    let mut report = json!({
        "version":1,"mode":"historical-entry-veto","researchOnly":true,"retrospectiveSample":true,"portfolioBacktest":false,
        "futureDataVisibleToModel":false,"history":args.history,"symbol":args.symbol,
        "historySha256":hex::encode(<sha2::Sha256 as sha2::Digest>::digest(&bytes)),
        "model":args.model,"baseUrl":args.base_url,"temperature":0,"seed":42,"maxTokens":160,
        "marginUsdtPerCandidate":100,"leverage":1,"costs":research::costs(),
        "availableCandidates":candidates.len(),"invalidHistoricalWindows":invalid_windows,
        "startTime":iso(args.start),"endTime":iso(args.end),
        "dataAtOrAfterFrozenCampaignCutoffUsed":false,
        "frozenCampaignCutoff":iso(RESERVED_HOLDOUT_START),
        "cutoffScope":"Final 20% boundary of profit-improvement-20261011; custom datasets use the same timestamp cutoff",
        "selection":"Evenly spaced among eligible closed-prefix long signals, before observing outcomes",
        "limitations":[
            "Small retrospective sample; overlapping isolated trades are not a funded portfolio",
            "Historical candidate selection requires sufficient future coverage but does not inspect future prices",
            "Model receives rule-derived features and a fixed plan; this evaluates veto behavior, not independent forecasting",
            "Rule scores and model decisions are not calibrated probabilities or evidence of profitability",
            "Historical prices, fixed costs and simulator assumptions omit real market impact"
        ],"samples":[],"controls":[],"consistency":[]
    });
    let mut samples = Vec::new();
    for (position, &index) in selected.iter().enumerate() {
        let candidate = &candidates[index];
        let model = ask_model(&client, &args, &candidate.payload).await;
        let outcome = simulate(candidate, &rows, &args.symbol)?;
        println!(
            "sample {}/{} {} model={} net={}",
            position + 1,
            selected.len(),
            iso(candidate.at),
            model["effectiveDecision"],
            outcome["net"]
        );
        samples.push(json!({"at":iso(candidate.at),"payload":candidate.payload,"model":model,"outcome":outcome}));
        report["samples"] = json!(samples);
        save(&args.output, &report)?;
    }
    let mut control_results = Vec::new();
    for (name, payload, positive) in controls() {
        let model = ask_model(&client, &args, &payload).await;
        println!(
            "control {name} model={} effective={}",
            model["modelDecision"], model["effectiveDecision"]
        );
        control_results.push(json!({
            "name":name,"payload":payload,"positiveAdvisory":positive,
            "expectedNegativeDecision":if positive{Value::Null}else{json!("WAIT")},"model":model
        }));
        report["controls"] = json!(control_results);
        save(&args.output, &report)?;
    }
    let mut repeats = Vec::new();
    for index in evenly_spaced(samples.len(), 3) {
        let mut calls = vec![samples[index]["model"].clone()];
        for _ in 0..2 {
            calls.push(ask_model(&client, &args, &samples[index]["payload"]).await);
        }
        let valid = calls.iter().all(|r| r["error"].is_null());
        let consistent = valid
            && calls
                .iter()
                .all(|r| r["modelDecision"] == calls[0]["modelDecision"]);
        repeats.push(json!({"at":samples[index]["at"],"allCallsValid":valid,"consistent":consistent,"calls":calls}));
    }
    let negative: Vec<_> = control_results
        .iter()
        .filter(|r| r["positiveAdvisory"] == false)
        .collect();
    let model_negative_wait = negative
        .iter()
        .filter(|r| r["model"]["modelDecision"] == "WAIT")
        .count();
    let negative_guard_wait = negative
        .iter()
        .filter(|r| r["model"]["effectiveDecision"] == "WAIT")
        .count();
    report["baseline"] = summarize(&samples, false);
    report["filtered"] = summarize(&samples, true);
    report["modelErrors"] = json!(
        samples
            .iter()
            .filter(|r| !r["model"]["error"].is_null())
            .count()
    );
    report["controlSummary"] = json!({
        "negativeCount":negative.len(),"modelRejectedNegatives":model_negative_wait,
        "guardRejectedNegatives":negative_guard_wait,"positiveCount":control_results.len()-negative.len(),
        "positiveBuyCount":control_results.iter().filter(|r| r["positiveAdvisory"] == true && r["model"]["modelDecision"] == "BUY").count(),
        "modelErrors":control_results.iter().filter(|r| !r["model"]["error"].is_null()).count()
    });
    report["consistency"] = json!(repeats);
    report["completed"] = json!(true);
    save(&args.output, &report)?;
    println!(
        "baseline={} filtered={} report={}",
        report["baseline"],
        report["filtered"],
        args.output.display()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanity_diagnostics_cover_both_decisions_enum_orders_and_raw_output() {
        let cases = sanity_cases();
        assert_eq!(cases.len(), 9);
        let explicit_wait: Vec<_> = cases.iter().filter(|c| c.name == "explicit_wait").collect();
        assert_eq!(explicit_wait.len(), 3);
        assert!(explicit_wait.iter().all(|c| c.expected == Decision::Wait));
        for format in [
            SanityFormat::BuyFirst,
            SanityFormat::WaitFirst,
            SanityFormat::Raw,
        ] {
            assert!(
                explicit_wait
                    .iter()
                    .any(|c| c.format.name() == format.name())
            );
        }
        assert!(
            cases
                .iter()
                .any(|c| c.name == "eligible_false" && c.expected == Decision::Wait)
        );
        assert!(
            cases
                .iter()
                .any(|c| c.name == "eligible_true" && c.expected == Decision::Buy)
        );
        assert_eq!(
            serde_json::from_str::<BareDecision>(r#"{"decision":"WAIT"}"#)
                .unwrap()
                .decision,
            Decision::Wait
        );
        assert!(
            serde_json::from_str::<BareDecision>(r#"{"decision":"WAIT","reason":"extra"}"#)
                .is_err()
        );
    }

    #[test]
    fn parser_rejects_malformed_ambiguous_or_unbounded_answers() {
        assert_eq!(
            parse_decision(r#"{"decision":"BUY","reason":"Valid evidence"}"#)
                .unwrap()
                .decision,
            Decision::Buy
        );
        for invalid in [
            "BUY",
            r#"{"decision":"SELL","reason":"No"}"#,
            r#"{"decision":"buy","reason":"Yes"}"#,
            r#"{"decision":"BUY","reason":""}"#,
            r#"{"decision":"BUY","reason":"Yes","confidence":1}"#,
            r#"{"decision":"BUY"}"#,
        ] {
            assert!(parse_decision(invalid).is_err(), "accepted {invalid}");
        }
        assert!(
            parse_decision(&json!({"decision":"BUY","reason":"x".repeat(241)}).to_string())
                .is_err()
        );
    }

    #[test]
    fn negative_controls_have_independent_guards_and_positive_controls_pass() {
        for (name, payload, positive) in controls() {
            assert_eq!(
                guard_issues(&payload).is_empty(),
                positive,
                "control {name}"
            );
        }
    }

    #[test]
    fn model_input_and_signal_are_unchanged_when_future_prices_change() {
        let mut rows: Vec<Value> = (0..100).map(|i| {
            let close = 100. + i as f64 * 0.03;
            json!({"openTime":i*BAR_MS,"open":close,"close":close,"high":close+0.5,"low":close-0.5,"volume":1,"confirmed":true})
        }).collect();
        let first = candidate_at(&rows, 80, "BTCUSDT").unwrap().unwrap();
        for row in &mut rows[80..] {
            for key in ["open", "close", "high", "low"] {
                row[key] = json!(1_000_000.);
            }
        }
        let second = candidate_at(&rows, 80, "BTCUSDT").unwrap().unwrap();
        assert_eq!(first.payload, second.payload);
        assert_eq!(first.signal, second.signal);
        assert_eq!(timestamp(&first.payload["asOf"]), Some(80 * BAR_MS));
        assert!(!first.payload.to_string().contains("1000000"));
    }

    #[test]
    fn reserved_cutoff_excludes_unclosed_and_future_outcome_bars() {
        let rows = vec![
            json!({"openTime":RESERVED_HOLDOUT_START-2*BAR_MS}),
            json!({"openTime":RESERVED_HOLDOUT_START-BAR_MS}),
            json!({"openTime":RESERVED_HOLDOUT_START}),
            json!({"openTime":RESERVED_HOLDOUT_START+BAR_MS}),
        ];
        let used = closed_before(&rows, RESERVED_HOLDOUT_START);
        assert_eq!(used.len(), 2);
        assert!(
            used.iter()
                .all(|r| timestamp(&r["openTime"]).unwrap() + BAR_MS <= RESERVED_HOLDOUT_START)
        );
        assert_eq!(closed_before(&rows, RESERVED_HOLDOUT_START - 1).len(), 1);
    }

    #[test]
    fn shared_engine_uses_future_entry_and_charges_shared_costs() {
        let mut rows: Vec<Value> = (0..300).map(|i| {
            let close = 100. + i as f64 * 0.03;
            json!({"openTime":i*BAR_MS,"open":close,"close":close,"high":close+0.5,"low":close-0.5,"volume":1,"confirmed":true})
        }).collect();
        let candidate = candidate_at(&rows, 80, "BTCUSDT").unwrap().unwrap();
        rows[81]["low"] = json!(number(&candidate.signal["plan"]["entryLimit"], 0.) - 0.1);
        let result = simulate(&candidate, &rows, "BTCUSDT").unwrap();
        assert_eq!(result["status"], "closed");
        assert!(timestamp(&result["entryAt"]).unwrap() > candidate.at);
        assert_eq!(result["costs"], research::costs());
        assert!(number(&result["fee"], 0.) > 0.);
        assert!(number(&result["net"], 0.) < number(&result["gross"], 0.));
    }
}
