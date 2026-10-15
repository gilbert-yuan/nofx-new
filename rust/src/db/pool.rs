use super::Db;
use anyhow::{Context, Result, bail};
use serde::Serialize;
use serde_json::{Value, json};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use std::time::Duration;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolConfig {
    pub max_connections: u32,
    pub min_connections: u32,
    pub acquire_timeout_ms: u64,
    pub idle_timeout_ms: u64,
    pub max_lifetime_ms: u64,
    pub test_before_acquire: bool,
    pub lock_timeout_ms: u64,
}

impl Default for PoolConfig {
    fn default() -> Self {
        Self {
            max_connections: 12,
            min_connections: 2,
            acquire_timeout_ms: 10_000,
            idle_timeout_ms: 600_000,
            max_lifetime_ms: 1_800_000,
            test_before_acquire: true,
            lock_timeout_ms: 10_000,
        }
    }
}

impl PoolConfig {
    pub fn from_env() -> Result<Self> {
        Self::from_lookup(|key| match std::env::var(key) {
            Ok(value) => Ok(Some(value)),
            Err(std::env::VarError::NotPresent) => Ok(None),
            Err(_) => bail!("{key} 必须是有效 UTF-8"),
        })
    }

    fn from_lookup(get: impl Fn(&str) -> Result<Option<String>>) -> Result<Self> {
        let defaults = Self::default();
        let integer = |key: &str, fallback: u64| -> Result<u64> {
            match get(key)? {
                None => Ok(fallback),
                Some(value) => value
                    .trim()
                    .parse()
                    .with_context(|| format!("{key} 必须是非负整数")),
            }
        };
        let max_connections = u32::try_from(integer(
            "NOFX_DB_POOL_MAX_CONNECTIONS",
            defaults.max_connections.into(),
        )?)
        .context("NOFX_DB_POOL_MAX_CONNECTIONS 超出有效范围")?;
        let min_connections = u32::try_from(integer(
            "NOFX_DB_POOL_MIN_CONNECTIONS",
            defaults.min_connections.into(),
        )?)
        .context("NOFX_DB_POOL_MIN_CONNECTIONS 超出有效范围")?;
        let test_before_acquire = match get("NOFX_DB_POOL_TEST_BEFORE_ACQUIRE")? {
            None => defaults.test_before_acquire,
            Some(value) => match value.trim().to_ascii_lowercase().as_str() {
                "1" | "true" | "yes" | "on" => true,
                "0" | "false" | "no" | "off" => false,
                _ => bail!("NOFX_DB_POOL_TEST_BEFORE_ACQUIRE 必须是 true 或 false"),
            },
        };
        let config = Self {
            max_connections,
            min_connections,
            acquire_timeout_ms: integer(
                "NOFX_DB_POOL_ACQUIRE_TIMEOUT_MS",
                defaults.acquire_timeout_ms,
            )?,
            idle_timeout_ms: integer("NOFX_DB_POOL_IDLE_TIMEOUT_MS", defaults.idle_timeout_ms)?,
            max_lifetime_ms: integer("NOFX_DB_POOL_MAX_LIFETIME_MS", defaults.max_lifetime_ms)?,
            test_before_acquire,
            lock_timeout_ms: integer("NOFX_DB_LOCK_TIMEOUT_MS", defaults.lock_timeout_ms)?,
        };
        config.validate()?;
        Ok(config)
    }

    pub fn validate(&self) -> Result<()> {
        // Trading operations hold advisory-lock transactions while using other connections.
        if !(4..=1024).contains(&self.max_connections) {
            bail!("NOFX_DB_POOL_MAX_CONNECTIONS 必须在 4..=1024 之间");
        }
        if self.min_connections > self.max_connections {
            bail!("NOFX_DB_POOL_MIN_CONNECTIONS 不能大于最大连接数");
        }
        for (key, value, minimum, maximum) in [
            (
                "NOFX_DB_POOL_ACQUIRE_TIMEOUT_MS",
                self.acquire_timeout_ms,
                1,
                u32::MAX as u64,
            ),
            (
                "NOFX_DB_POOL_IDLE_TIMEOUT_MS",
                self.idle_timeout_ms,
                0,
                u32::MAX as u64,
            ),
            (
                "NOFX_DB_POOL_MAX_LIFETIME_MS",
                self.max_lifetime_ms,
                0,
                u32::MAX as u64,
            ),
            (
                "NOFX_DB_LOCK_TIMEOUT_MS",
                self.lock_timeout_ms,
                1,
                i32::MAX as u64,
            ),
        ] {
            if value < minimum || value > maximum {
                bail!("{key} 必须在 {minimum}..={maximum} 毫秒之间");
            }
        }
        Ok(())
    }

    pub fn options(&self) -> Result<PgPoolOptions> {
        self.validate()?;
        let optional_duration = |ms| (ms != 0).then(|| Duration::from_millis(ms));
        let lock_timeout = format!("{}ms", self.lock_timeout_ms);
        Ok(PgPoolOptions::new()
            .max_connections(self.max_connections)
            .min_connections(self.min_connections)
            .acquire_timeout(Duration::from_millis(self.acquire_timeout_ms))
            .idle_timeout(optional_duration(self.idle_timeout_ms))
            .max_lifetime(optional_duration(self.max_lifetime_ms))
            .test_before_acquire(self.test_before_acquire)
            .after_connect(move |connection, _| {
                let timeout = lock_timeout.clone();
                Box::pin(async move {
                    sqlx::query("SELECT set_config('lock_timeout', $1, false)")
                        .bind(timeout)
                        .execute(connection)
                        .await?;
                    Ok(())
                })
            }))
    }
}

impl Db {
    pub async fn connect_with(options: PgConnectOptions, config: PoolConfig) -> Result<Self> {
        let pool = config
            .options()?
            .connect_with(options)
            .await
            .context("建立 PostgreSQL 连接池失败")?;
        let db = Self::from_pool(pool);
        if let Err(error) = db.init().await {
            db.pool.close().await;
            return Err(error);
        }
        tracing::info!(?config, "PostgreSQL connection pool ready");
        Ok(db)
    }

    /// A local snapshot: this remains available even when all connections are busy.
    pub fn pool_status(&self) -> Value {
        let options = self.pool.options();
        let size = self.pool.size();
        let idle = (self.pool.num_idle() as u32).min(size);
        let millis = |duration: Option<Duration>| duration.map(|v| v.as_millis());
        json!({
            "size": size,
            "idle": idle,
            "inUse": size - idle,
            "availableCapacity": options.get_max_connections().saturating_sub(size),
            "closed": self.pool.is_closed(),
            "accountWriteBusy": self.write_gate.try_lock().is_err(),
            "config": {
                "maxConnections": options.get_max_connections(),
                "minConnections": options.get_min_connections(),
                "acquireTimeoutMs": options.get_acquire_timeout().as_millis(),
                "idleTimeoutMs": millis(options.get_idle_timeout()),
                "maxLifetimeMs": millis(options.get_max_lifetime()),
                "testBeforeAcquire": options.get_test_before_acquire(),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(values: &[(&str, &str)]) -> Result<PoolConfig> {
        PoolConfig::from_lookup(|key| {
            Ok(values
                .iter()
                .find(|(k, _)| *k == key)
                .map(|(_, v)| v.to_string()))
        })
    }

    #[test]
    fn defaults_and_overrides_configure_the_actual_pool() {
        assert_eq!(config(&[]).unwrap(), PoolConfig::default());
        let config = config(&[
            ("NOFX_DB_POOL_MAX_CONNECTIONS", "24"),
            ("NOFX_DB_POOL_MIN_CONNECTIONS", "4"),
            ("NOFX_DB_POOL_ACQUIRE_TIMEOUT_MS", "1500"),
            ("NOFX_DB_POOL_IDLE_TIMEOUT_MS", "0"),
            ("NOFX_DB_POOL_MAX_LIFETIME_MS", "0"),
            ("NOFX_DB_POOL_TEST_BEFORE_ACQUIRE", " OFF "),
            ("NOFX_DB_LOCK_TIMEOUT_MS", "2500"),
        ])
        .unwrap();
        let options = config.options().unwrap();
        assert_eq!(options.get_max_connections(), 24);
        assert_eq!(options.get_min_connections(), 4);
        assert_eq!(options.get_acquire_timeout(), Duration::from_millis(1500));
        assert_eq!(options.get_idle_timeout(), None);
        assert_eq!(options.get_max_lifetime(), None);
        assert!(!options.get_test_before_acquire());
        assert_eq!(config.lock_timeout_ms, 2500);
    }

    #[test]
    fn invalid_pool_settings_are_rejected_before_connecting() {
        for (key, value) in [
            ("NOFX_DB_POOL_MAX_CONNECTIONS", "0"),
            ("NOFX_DB_POOL_MAX_CONNECTIONS", "3"),
            ("NOFX_DB_POOL_MAX_CONNECTIONS", "1025"),
            ("NOFX_DB_POOL_MAX_CONNECTIONS", "4294967296"),
            ("NOFX_DB_POOL_MIN_CONNECTIONS", "13"),
            ("NOFX_DB_POOL_ACQUIRE_TIMEOUT_MS", "0"),
            ("NOFX_DB_POOL_IDLE_TIMEOUT_MS", "-1"),
            ("NOFX_DB_POOL_MAX_LIFETIME_MS", "NaN"),
            ("NOFX_DB_POOL_MAX_LIFETIME_MS", "4294967296"),
            ("NOFX_DB_POOL_TEST_BEFORE_ACQUIRE", "maybe"),
            ("NOFX_DB_LOCK_TIMEOUT_MS", "0"),
            ("NOFX_DB_LOCK_TIMEOUT_MS", "2147483648"),
        ] {
            assert!(
                config(&[(key, value)])
                    .unwrap_err()
                    .to_string()
                    .contains(key)
            );
        }
    }

    #[tokio::test]
    async fn cloned_account_writers_wait_before_acquiring_a_connection() {
        let db = Db::from_pool(
            PoolConfig {
                min_connections: 0,
                acquire_timeout_ms: 20,
                ..PoolConfig::default()
            }
            .options()
            .unwrap()
            .connect_lazy_with(PgConnectOptions::new().host("127.0.0.1").port(9)),
        );
        let writer = db.clone();
        let guard = db.write_gate.lock().await;
        let error = writer
            .mutate_account_light(|_| panic!("queued mutation must not run"))
            .await
            .unwrap_err();
        assert!(error.is::<super::super::AccountWriteBusy>());
        assert_eq!(db.pool_status()["accountWriteBusy"], true);
        assert_eq!(db.pool_status()["size"], 0);
        drop(guard);
        assert_eq!(writer.pool_status()["accountWriteBusy"], false);
        db.pool.close().await;
        let error = writer
            .mutate_account_light(|_| panic!("closed pool must not run mutation"))
            .await
            .unwrap_err();
        assert!(matches!(
            error.downcast_ref::<sqlx::Error>(),
            Some(sqlx::Error::PoolClosed)
        ));
    }

    #[tokio::test]
    async fn status_does_not_acquire_or_expose_connection_credentials() {
        let pool = PoolConfig {
            min_connections: 0,
            ..PoolConfig::default()
        }
        .options()
        .unwrap()
        .connect_lazy_with(
            PgConnectOptions::new()
                .host("private-host")
                .username("private-user")
                .password("private-password"),
        );
        let db = Db::from_pool(pool);
        let status = db.pool_status();
        assert_eq!(status["config"]["maxConnections"], 12);
        assert_eq!(status["size"], 0);
        for secret in ["private-host", "private-user", "private-password"] {
            assert!(!status.to_string().contains(secret));
        }
        db.pool.close().await;
        assert_eq!(db.pool_status()["closed"], true);
        assert!(matches!(
            db.pool.acquire().await,
            Err(sqlx::Error::PoolClosed)
        ));
    }
}
