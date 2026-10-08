use super::*;
use crate::indicator_history::Sample;

impl Db {
    pub async fn save_indicator_samples(&self, symbol: &str, samples: &[Sample]) -> Result<usize> {
        if samples.is_empty() {
            return Ok(0);
        }
        let rows:Vec<_>=samples.iter().map(|s|json!({"kind":s.kind,"observed_at":s.observed_at,"available_at":s.available_at,"origin":s.origin,"data":s.data})).collect();
        let result=sqlx::query("INSERT INTO market_indicator_history(symbol,kind,observed_at,available_at,origin,data) SELECT $1,r.* FROM jsonb_to_recordset($2) AS r(kind TEXT,observed_at BIGINT,available_at BIGINT,origin TEXT,data JSONB) ON CONFLICT(symbol,kind,observed_at,origin) DO NOTHING").bind(symbol).bind(json!(rows)).execute(&self.pool).await?;
        Ok(result.rows_affected() as usize)
    }
    pub async fn indicator_samples(
        &self,
        symbol: &str,
        start: i64,
        end: i64,
    ) -> Result<Vec<Sample>> {
        let rows:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('kind',kind,'observedAt',observed_at,'availableAt',available_at,'origin',origin,'data',data) FROM market_indicator_history WHERE symbol=$1 AND observed_at>=$2 AND observed_at<$3 AND available_at<$3 ORDER BY observed_at,available_at").bind(symbol).bind(start).bind(end).fetch_all(&self.pool).await?;
        rows.into_iter()
            .map(|v| serde_json::from_value(v).map_err(Into::into))
            .collect()
    }
}
