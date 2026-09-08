/**
 * 数据库表结构优化方案
 *
 * 目标：将 JSONB 嵌套数据扁平化为独立表，支持高效查询和分析
 */

-- ============================================================================
-- 1. 模拟账户优化：将订单从 JSON 拆分为独立表
-- ============================================================================

-- 新表：paper_orders (模拟订单表)
CREATE TABLE IF NOT EXISTS paper_orders (
  -- 基础字段
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL,                    -- 关联的分析记录ID
  symbol TEXT NOT NULL,
  interval TEXT NOT NULL,
  direction TEXT NOT NULL,                     -- OPEN_LONG / OPEN_SHORT
  status TEXT NOT NULL,                        -- pending / open / closed / expired / cancelled

  -- 资金管理
  margin NUMERIC(20,8) NOT NULL,
  leverage INTEGER NOT NULL,
  notional NUMERIC(20,8) NOT NULL,

  -- 交易执行
  entry NUMERIC(20,10),                        -- 入场价格
  entry_at TIMESTAMPTZ,                        -- 入场时间
  entry_fee NUMERIC(20,8),                     -- 入场手续费
  quantity NUMERIC(30,10),                     -- 持仓数量

  exit NUMERIC(20,10),                         -- 出场价格
  exit_at TIMESTAMPTZ,                         -- 出场时间
  reason TEXT,                                 -- 平仓原因: stop_loss / take_profit / timeout / liquidation / manual

  -- 盈亏统计
  gross NUMERIC(20,8),                         -- 毛收益
  fees NUMERIC(20,8),                          -- 总手续费
  funding NUMERIC(20,8),                       -- 资金费用
  net NUMERIC(20,8),                           -- 净收益
  roi NUMERIC(10,6),                           -- 回报率

  -- 持仓状态
  mark_price NUMERIC(20,10),                   -- 标记价格
  mark_at TIMESTAMPTZ,                         -- 标记时间
  unrealized NUMERIC(20,8),                    -- 未实现盈亏
  liquidation_price NUMERIC(20,10),            -- 强平价格
  held_bars INTEGER DEFAULT 0,                 -- 已持有K线数

  -- 时间管理
  created_at TIMESTAMPTZ NOT NULL,
  next_time BIGINT NOT NULL,                   -- 下次处理时间戳
  expires_at TIMESTAMPTZ NOT NULL,

  -- 元数据
  automatic BOOLEAN DEFAULT false,
  market_provider TEXT DEFAULT 'okx',
  error TEXT DEFAULT '',
  ambiguous_bar BOOLEAN DEFAULT false,
  isolated_loss_adjustment NUMERIC(20,8) DEFAULT 0,

  -- JSONB 字段（保留复杂结构）
  plan JSONB NOT NULL,                         -- 交易计划
  initial_plan JSONB NOT NULL,                 -- 初始计划（用于对比）
  costs JSONB NOT NULL,                        -- 成本参数
  protection_revisions JSONB DEFAULT '[]',     -- 保护价格修订历史
  review_history JSONB DEFAULT '[]',           -- 复核历史
  analysis_context JSONB,                      -- 完整分析上下文

  -- 索引
  CONSTRAINT valid_status CHECK (status IN ('pending', 'open', 'closed', 'expired', 'cancelled')),
  CONSTRAINT valid_direction CHECK (direction IN ('OPEN_LONG', 'OPEN_SHORT'))
);

-- 索引优化
CREATE INDEX IF NOT EXISTS idx_paper_orders_symbol ON paper_orders(symbol);
CREATE INDEX IF NOT EXISTS idx_paper_orders_status ON paper_orders(status);
CREATE INDEX IF NOT EXISTS idx_paper_orders_record_id ON paper_orders(record_id);
CREATE INDEX IF NOT EXISTS idx_paper_orders_created_at ON paper_orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_paper_orders_exit_at ON paper_orders(exit_at DESC);
CREATE INDEX IF NOT EXISTS idx_paper_orders_strategy ON paper_orders((analysis_context->>'strategyVersion'));
CREATE INDEX IF NOT EXISTS idx_paper_orders_closed ON paper_orders(status) WHERE status = 'closed';
CREATE INDEX IF NOT EXISTS idx_paper_orders_active ON paper_orders(status, next_time);

-- 新表：paper_account_config (账户配置)
CREATE TABLE IF NOT EXISTS paper_account_config (
  id INTEGER PRIMARY KEY CHECK(id=1),
  initial_balance NUMERIC(20,8) NOT NULL DEFAULT 10000,
  unlimited_capital BOOLEAN DEFAULT false,
  automation JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);


-- ============================================================================
-- 2. 研究记录优化：将分析信号拆分为独立表
-- ============================================================================

-- 新表：analysis_signals (分析信号表)
CREATE TABLE IF NOT EXISTS analysis_signals (
  -- 主键
  id TEXT PRIMARY KEY,                         -- record_id:symbol 组合
  record_id TEXT NOT NULL,                     -- 关联的研究记录
  symbol TEXT NOT NULL,

  -- 分析结果
  action TEXT NOT NULL,                        -- WAIT / BUY / SELL
  position_recommendation TEXT NOT NULL,       -- WAIT / OPEN_LONG / OPEN_SHORT
  eligible BOOLEAN NOT NULL,
  confidence NUMERIC(6,4),
  confidence_type TEXT,

  -- 分析内容
  reason TEXT,
  risk TEXT,
  suggestion TEXT,

  -- 交易计划
  plan JSONB,                                  -- 完整的 plan 对象
  recommended_leverage INTEGER,

  -- 时间管理
  generated_at TIMESTAMPTZ NOT NULL,
  data_as_of TIMESTAMPTZ NOT NULL,
  first_entry_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,

  -- 市场信息
  exchange TEXT NOT NULL,
  interval TEXT NOT NULL,
  market_provider TEXT NOT NULL,

  -- 策略版本
  strategy_version TEXT,
  analysis_engine TEXT NOT NULL,               -- local / ai

  -- 验证问题
  validation_issues JSONB DEFAULT '[]',

  -- 关联信息
  automation_run_id TEXT,

  -- 时间戳
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 索引优化
CREATE INDEX IF NOT EXISTS idx_analysis_signals_record_id ON analysis_signals(record_id);
CREATE INDEX IF NOT EXISTS idx_analysis_signals_symbol ON analysis_signals(symbol);
CREATE INDEX IF NOT EXISTS idx_analysis_signals_eligible ON analysis_signals(eligible, generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_analysis_signals_strategy ON analysis_signals(strategy_version, generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_analysis_signals_engine ON analysis_signals(analysis_engine, generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_analysis_signals_confidence ON analysis_signals(confidence DESC);
CREATE INDEX IF NOT EXISTS idx_analysis_signals_expires ON analysis_signals(expires_at);

-- 新表：research_records_meta (研究记录元数据)
-- 保留原 research_records 表存储完整快照，新增元数据表用于快速查询
CREATE TABLE IF NOT EXISTS research_records_meta (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,                          -- single / range / all
  symbols TEXT[] NOT NULL,                     -- 分析的币种列表
  interval TEXT NOT NULL,
  kline_count INTEGER,
  market_count INTEGER,

  -- 策略信息
  strategy_version TEXT,
  analysis_engine TEXT NOT NULL,

  -- 统计信息
  signal_count INTEGER DEFAULT 0,              -- 信号数量
  eligible_count INTEGER DEFAULT 0,            -- 有效信号数量

  -- 自动化信息
  automation_run_id TEXT,

  -- 状态
  error TEXT DEFAULT '',
  research_only BOOLEAN DEFAULT true,

  -- 时间戳
  created_at TIMESTAMPTZ NOT NULL,

  -- 索引
  CONSTRAINT valid_type CHECK (type IN ('single', 'range', 'all'))
);

CREATE INDEX IF NOT EXISTS idx_research_meta_created ON research_records_meta(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_research_meta_strategy ON research_records_meta(strategy_version);
CREATE INDEX IF NOT EXISTS idx_research_meta_symbols ON research_records_meta USING GIN(symbols);


-- ============================================================================
-- 3. 视图：便捷查询
-- ============================================================================

-- 视图：活跃订单
CREATE OR REPLACE VIEW v_active_orders AS
SELECT
  id, symbol, direction, status, margin, leverage,
  entry, entry_at, mark_price, unrealized, roi,
  created_at, expires_at,
  analysis_context->>'strategyVersion' as strategy_version,
  analysis_context->>'analysisEngine' as analysis_engine
FROM paper_orders
WHERE status IN ('pending', 'open')
ORDER BY next_time;

-- 视图：已平仓订单统计
CREATE OR REPLACE VIEW v_closed_orders_stats AS
SELECT
  symbol,
  COUNT(*) as total,
  SUM(CASE WHEN net > 0 THEN 1 ELSE 0 END) as wins,
  SUM(CASE WHEN net < 0 THEN 1 ELSE 0 END) as losses,
  ROUND(AVG(CASE WHEN net > 0 THEN 1.0 ELSE 0.0 END), 4) as win_rate,
  ROUND(SUM(net), 4) as total_net,
  ROUND(AVG(net), 4) as avg_net,
  ROUND(AVG(roi), 4) as avg_roi,
  ROUND(AVG(held_bars), 1) as avg_held_bars
FROM paper_orders
WHERE status = 'closed'
GROUP BY symbol
ORDER BY total_net DESC;

-- 视图：按策略版本统计
CREATE OR REPLACE VIEW v_orders_by_strategy AS
SELECT
  analysis_context->>'strategyVersion' as strategy_version,
  COUNT(*) as total,
  SUM(CASE WHEN net > 0 THEN 1 ELSE 0 END) as wins,
  ROUND(AVG(CASE WHEN net > 0 THEN 1.0 ELSE 0.0 END), 4) as win_rate,
  ROUND(SUM(net), 4) as total_net,
  ROUND(AVG(roi), 4) as avg_roi
FROM paper_orders
WHERE status = 'closed' AND analysis_context IS NOT NULL
GROUP BY analysis_context->>'strategyVersion'
ORDER BY total_net DESC;

-- 视图：有效信号统计
CREATE OR REPLACE VIEW v_eligible_signals AS
SELECT
  symbol,
  COUNT(*) as signal_count,
  ROUND(AVG(confidence), 4) as avg_confidence,
  analysis_engine,
  strategy_version
FROM analysis_signals
WHERE eligible = true
  AND expires_at > NOW()
GROUP BY symbol, analysis_engine, strategy_version
ORDER BY signal_count DESC;
