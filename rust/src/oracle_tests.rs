//! Immutable snapshots of the former backend. These tests execute only native Rust.
use serde_json::Value;
fn text_parts(value: &str) -> Vec<String> {
    let mut result = vec![];
    let mut part = String::new();
    let mut numeric = None;
    for ch in value.chars() {
        let kind = ch.is_ascii_digit() || matches!(ch, '.' | '-' | '+' | 'e' | 'E');
        if numeric.is_some_and(|n| n != kind) {
            result.push(std::mem::take(&mut part));
        }
        numeric = Some(kind);
        part.push(ch);
    }
    if !part.is_empty() {
        result.push(part);
    }
    result
}
fn compare(actual: &Value, expected: &Value, path: &str) {
    match (actual, expected) {
        (Value::Number(a), Value::Number(b)) => {
            let a = a.as_f64().unwrap();
            let b = b.as_f64().unwrap();
            assert!((a - b).abs() <= 1e-8 * (1. + b.abs()), "{path}: {a} != {b}");
        }
        (Value::Object(a), Value::Object(b)) => {
            for (k, v) in b {
                if matches!(k.as_str(), "generatedAt" | "timestamp") {
                    continue;
                }
                compare(a.get(k).unwrap_or(&Value::Null), v, &format!("{path}.{k}"));
            }
            for k in a.keys() {
                if !matches!(k.as_str(), "generatedAt" | "timestamp") {
                    assert!(
                        b.contains_key(k) || a[k].is_null(),
                        "{path}: unexpected field {k}"
                    );
                }
            }
        }
        (Value::Array(a), Value::Array(b)) => {
            assert_eq!(a.len(), b.len(), "{path}: array length differs");
            for (i, (a, b)) in a.iter().zip(b).enumerate() {
                compare(a, b, &format!("{path}[{i}]"));
            }
        }
        (Value::String(a), Value::String(b)) if a != b => {
            let a = text_parts(a);
            let b = text_parts(b);
            assert_eq!(a.len(), b.len(), "{path}: text differs");
            for (a, b) in a.iter().zip(&b) {
                match (a.parse::<f64>(), b.parse::<f64>()) {
                    (Ok(a), Ok(b)) => assert!(
                        (a - b).abs() <= 1e-8 * (1. + b.abs()),
                        "{path}: text number {a} != {b}"
                    ),
                    _ => assert_eq!(a, b, "{path}"),
                }
            }
        }
        _ => assert_eq!(actual, expected, "{path}"),
    }
}
#[test]
fn flow_local_replay_and_fill_accounting_match_legacy() {
    let cases: Vec<Value> = serde_json::from_str(include_str!("backend_oracles.json")).unwrap();
    for (i, c) in cases.iter().enumerate() {
        let input = &c["input"];
        let actual = match c["kind"].as_str().unwrap() {
            "flow" => crate::flow::analyze(input),
            "local" => crate::analytics::local_analysis(input),
            "local_multi" => crate::analytics::local_multi(input, &c["aux"], &c["adaptive"]),
            "replay" => crate::analytics::replay(input, c["rows"].as_array().unwrap()),
            "ledger" => crate::ledger::derive(
                input["orders"].as_array().unwrap(),
                input["environment"].as_str().unwrap(),
                input["fills"].as_array().unwrap(),
                input["funding"].as_array().unwrap(),
                input["adoptedPositions"].as_array().unwrap(),
                c["start"].as_i64().unwrap(),
            )
            .unwrap(),
            _ => unreachable!(),
        };
        compare(&actual, &c["expected"], &format!("case {i} {}", c["kind"]));
    }
}
