//! Fixed localhost bridge to the monthly research model. It never forwards
//! credentials, account settings, user-supplied forecasts or order requests.

use anyhow::{Context, Result};
use axum::http::StatusCode;
use reqwest::Client;
use serde_json::{Value, json};
use std::time::Duration;

pub struct Gateway {
    client: Client,
    base: String,
}

impl Gateway {
    pub fn from_env() -> Result<Self> {
        let port = std::env::var("NOFX_MONTHLY_ML_PORT")
            .unwrap_or_else(|_| "18084".into())
            .parse::<u16>()
            .context("NOFX_MONTHLY_ML_PORT must be a valid TCP port")?;
        anyhow::ensure!(port > 0, "NOFX_MONTHLY_ML_PORT must be nonzero");
        Self::new(port)
    }

    fn new(port: u16) -> Result<Self> {
        Ok(Self {
            client: Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(2))
                .timeout(Duration::from_secs(45))
                .build()?,
            base: format!("http://127.0.0.1:{port}"),
        })
    }

    pub async fn request(&self, method: &str, path: &str, input: &Value) -> (StatusCode, Value) {
        let upstream_path = match (method, path) {
            ("GET", "/api/ml/health") => "/health",
            ("GET", "/api/ml/models") => "/models",
            ("POST", "/api/ml/signal") => {
                if input
                    .as_object()
                    .is_none_or(|object| object.len() != 1 || !object.contains_key("symbol"))
                    || input["symbol"]
                        .as_str()
                        .is_none_or(|symbol| crate::exchange::valid_symbol(symbol).is_err())
                {
                    return (
                        StatusCode::BAD_REQUEST,
                        json!({"error":"模型信号仅接受有效 symbol；不接受方向、订单、账户或外部特征"}),
                    );
                }
                "/signal"
            }
            _ => return (StatusCode::NOT_FOUND, json!({"error":"模型接口不存在"})),
        };
        let mut request = self.client.request(
            if method == "POST" {
                reqwest::Method::POST
            } else {
                reqwest::Method::GET
            },
            format!("{}{upstream_path}", self.base),
        );
        if method == "POST" {
            request = request.json(input);
        }
        let result = async {
            let mut response = request.send().await?;
            let status = response.status();
            anyhow::ensure!(!status.is_redirection(), "Model service redirect refused");
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await? {
                anyhow::ensure!(
                    bytes.len() + chunk.len() <= 2 * 1024 * 1024,
                    "Model response too large"
                );
                bytes.extend_from_slice(&chunk);
            }
            let value: Value = serde_json::from_slice(&bytes)?;
            anyhow::ensure!(value.is_object(), "Model response must be an object");
            if status.is_success() {
                anyhow::ensure!(
                    value["advisory_only"] == true
                        && value["orders_enabled"] == false
                        && value["real_trading_enabled"] == false,
                    "Upstream is not the read-only monthly model service"
                );
            }
            Ok::<_, anyhow::Error>((status, value))
        }
        .await;
        match result {
            Ok(output) => output,
            Err(error) => {
                tracing::warn!(%error, "Monthly ML advisory service unavailable");
                (
                    StatusCode::SERVICE_UNAVAILABLE,
                    json!({"error":"月度模型服务尚未就绪，请启动 nofx-ml-monthly-predict --serve", "status":"unavailable", "orders_enabled":false}),
                )
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        Json, Router,
        routing::{get, post},
    };

    #[tokio::test]
    async fn gateway_forwards_only_advisory_routes_and_rejects_order_overrides() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let gateway = Gateway::new(listener.local_addr().unwrap().port()).unwrap();
        let router = Router::new()
            .route(
                "/health",
                get(|| async { Json(json!({"ok":true,"orders_enabled":false,"advisory_only":true,"real_trading_enabled":false})) }),
            )
            .route("/models", get(|| async { Json(json!({"orders_enabled":true})) }))
            .route(
                "/signal",
                post(|Json(value): Json<Value>| async move {
                    Json(json!({"symbol":value["symbol"],"action":"HOLD","orders_enabled":false,"advisory_only":true,"real_trading_enabled":false}))
                }),
            );
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let (status, response) = gateway
            .request("POST", "/api/ml/signal", &json!({"symbol":"BTCUSDT"}))
            .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(response["symbol"], "BTCUSDT");
        assert_eq!(response["orders_enabled"], false);
        assert_eq!(
            gateway.request("GET", "/api/ml/models", &json!({})).await.0,
            StatusCode::SERVICE_UNAVAILABLE
        );
        for input in [
            json!({"symbol":"BTCUSDT","action":"BUY"}),
            json!({"symbol":"BTCUSDT","candles":[]}),
            json!({"symbol":"../trade"}),
        ] {
            assert_eq!(
                gateway.request("POST", "/api/ml/signal", &input).await.0,
                StatusCode::BAD_REQUEST
            );
        }
        assert_eq!(
            gateway.request("POST", "/api/ml/trade", &json!({})).await.0,
            StatusCode::NOT_FOUND
        );
        server.abort();
    }

    #[tokio::test]
    async fn gateway_refuses_redirect_instead_of_following_to_another_service() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let gateway = Gateway::new(listener.local_addr().unwrap().port()).unwrap();
        let router = Router::new().route(
            "/health",
            get(|| async { axum::response::Redirect::temporary("http://127.0.0.1:18082/paper") }),
        );
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        assert_eq!(
            gateway.request("GET", "/api/ml/health", &json!({})).await.0,
            StatusCode::SERVICE_UNAVAILABLE
        );
        server.abort();
    }
}
