import { fetch, ProxyAgent } from 'undici';

const MAX_AI_REQUEST_CONCURRENCY = 5;
const DEFAULT_AI_REQUEST_CONCURRENCY = 5;
const aiRequestLimiter = createAiRequestLimiter(DEFAULT_AI_REQUEST_CONCURRENCY);
const modelProxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
const modelDispatcher = modelProxyUrl ? new ProxyAgent(modelProxyUrl) : undefined;

export async function analyzeMarkets({ config, strategy, market }) {
  if (!config.model.enabled || !config.model.apiKey) {
    return { analyses: [], error: 'Model is disabled or missing API key.' };
  }

  const payload = {
    model: config.model.model,
    temperature: 0.2,
    messages: [
      {
        role: 'system',
        content:
          `${strategy.systemPrompt}\nAnalyze every symbol independently. This is research only: never place orders. ` +
          'Return JSON only in the form {"analyses":[{"symbol":"BTCUSDT","action":"BUY|SELL|HOLD",' +
          '"positionRecommendation":"OPEN_LONG|OPEN_SHORT|WAIT",' +
          '"confidence":0,"reason":"...","risk":"...","suggestion":"...",' +
          '"plan":{"entryMin":0,"entryMax":0,"stopLoss":0,"takeProfit":0,"validForBars":3,"maxHoldBars":12}}]}. ' +
          'Use numeric values, confidence in [0,1] is self-assessment, not measured win probability. ' +
          'Only provided closed candles are available. No account positions are provided; do not recommend closing positions. ' +
          'Entry default: next future candle open within entryMin..entryMax after generation, never intrabar. ' +
          'Optional limit order: if plan.entryLimit (number) is provided, entry is a limit order filled when price pulls back to entryLimit (long: low<=entryLimit; short: high>=entryLimit), not the next-candle-open band. ' +
          'validForBars: 0 means GTC (no expiry limit); otherwise integer 1..6. maxHoldBars 1..120. For longs stopLoss < entryMin <= entryMax < takeProfit; reverse for shorts. ' +
          'Use WAIT with plan:null if evidence is weak. Return exactly one result for each supplied symbol. Explain invalidation in risk.',
      },
      {
        role: 'user',
        content: JSON.stringify({
          objective: `Analyze USDT perpetual reference markets using closed ${strategy.interval} OHLCV data from each marketProvider. Execution venue is Binance, whose listings and prices may differ. Never assume every reference symbol is tradable there.`,
          rules: strategy.rules,
          market
        })
      }
    ]
  };

  const body = await requestModel({ config, payload });
  const content = body.choices?.[0]?.message?.content || '{}';
  return parseAnalysis(content);
}

export async function makeDecision({ config, strategy, market, account, positions }) {
  if (!config.model.enabled || !config.model.apiKey) {
    return fallbackDecision('Model is disabled or missing API key.');
  }

  const payload = {
    model: config.model.model,
    temperature: 0.2,
    messages: [
      {
        role: 'system',
        content: `${strategy.systemPrompt}\nEvaluate a possible Binance USDT perpetual entry from closed candles. Return JSON only: {"action":"BUY|SELL|HOLD","symbol":"BTCUSDT","quantity":0,"leverage":1,"confidence":0,"reason":"...","takeProfit":0,"stopLoss":0}. quantity is in base asset units, e.g. 0.001 BTC, never a contract count. Do not increase existing positions. For BUY stopLoss < current price < takeProfit; reverse for SELL. Prefer HOLD when evidence is weak. Confidence is self-assessment in [0,1], not win probability.`
      },
      {
        role: 'user',
        content: JSON.stringify(
          {
            rules: strategy.rules,
            risk: config.trader,
            market,
            accountSummary: summarizeAccount(account),
            positions: summarizePositions(positions)
          },
          null,
          2
        )
      }
    ]
  };

  const body = await requestModel({ config, payload });

  const content = body.choices?.[0]?.message?.content || '{}';
  return parseDecision(content);
}

export async function reviewPosition({ config, strategy, position, market }) {
  if (!config.model.enabled || !config.model.apiKey) return { action: 'HOLD', confidence: 0, reason: 'Model is disabled or missing API key.' };
  const payload = {
    model: config.model.model,
    temperature: 0.1,
    messages: [
      { role: 'system', content: `${strategy.systemPrompt}\nReview one existing Binance USDT perpetual position after a closed ${strategy.interval} candle. positionAmt > 0 means long, < 0 means short. Return JSON only: {"action":"HOLD|CLOSE|UPDATE_PROTECTION","confidence":0,"reason":"...","takeProfit":0,"stopLoss":0}. Do not open or increase a position. Use CLOSE only if justified. For UPDATE_PROTECTION return positive numeric prices: stopLoss < current price < takeProfit for long, reverse for short. Confidence is self-assessment in [0,1], not win probability.` },
      { role: 'user', content: JSON.stringify({ rules: strategy.rules, position, market }) }
    ]
  };
  const body = await requestModel({ config, payload });
  return parseDecision(body.choices?.[0]?.message?.content || '{}');
}

async function requestModel({ config, payload }) {
  return aiRequestLimiter.run(
    async () => {
      const endpoint = `${config.model.baseUrl.replace(/\/$/, '')}/chat/completions`;
      let res;
      try {
        res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.model.apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload),
          dispatcher: modelDispatcher,
          signal: AbortSignal.timeout(120000)
        });
      } catch (cause) {
        const detail = cause?.cause?.message || cause?.message || '网络请求失败';
        throw new Error(`无法连接 AI 模型服务：${detail}。请检查模型地址、代理和网络连接。`);
      }
      const body = await parseModelResponse(res);
      if (!res.ok || body.error) throw new Error(body.error?.message || `Model request failed with ${res.status}`);
      if (!normalizeModelContent(body.choices?.[0]?.message?.content)) {
        throw new Error(body.choices?.[0]?.finish_reason === 'length' ? '模型输出达到长度限制，未返回分析内容。请减少每批币种数。' : '模型服务未返回分析内容，请检查模型配置后重试。');
      }
      return body;
    },
    config.model.maxConcurrentRequests
  );
}

function createAiRequestLimiter(defaultConcurrency) {
  let concurrency = normalizeEffectiveConcurrency(defaultConcurrency);
  let active = 0;
  const queue = [];

  return {
    run(task, requestedConcurrency) {
      concurrency = normalizeEffectiveConcurrency(requestedConcurrency);
      return new Promise((resolve, reject) => {
        queue.push({ task, resolve, reject });
        drain();
      });
    }
  };

  function drain() {
    while (active < concurrency && queue.length) {
      const item = queue.shift();
      active += 1;
      Promise.resolve()
        .then(item.task)
        .then(item.resolve, item.reject)
        .finally(() => {
          active -= 1;
          drain();
        });
    }
  }
}

function normalizeEffectiveConcurrency(value) {
  const requested = Number(value);
  if (!Number.isFinite(requested)) return DEFAULT_AI_REQUEST_CONCURRENCY;
  return Math.min(MAX_AI_REQUEST_CONCURRENCY, Math.max(1, Math.trunc(requested)));
}

async function parseModelResponse(res) {
  const contentType = res.headers.get('content-type') || '';
  const text = await res.text();
  if (!contentType.includes('application/json')) {
    return {
      error: {
        message: `Model service returned non-JSON content (${res.status}). Verify the configured API base URL and model provider.`
      }
    };
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { error: { message: `Model service returned invalid JSON (${res.status}).` } };
  }
}

function fallbackDecision(reason) {
  return {
    action: 'HOLD',
    symbol: '',
    quantity: 0,
    contracts: 0,
    leverage: 1,
    confidence: 0,
    reason
  };
}

function parseAnalysis(content) {
  const text = normalizeModelContent(content);
  const candidates = [text, ...extractJsonCandidates(text)];

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(stripCodeFence(candidate));
      const analyses = normalizeAnalyses(parsed);
      if (analyses.length || isEmptyAnalysisPayload(parsed)) {
        return { analyses, error: '' };
      }
    } catch {
      // Try the next balanced JSON fragment before reporting a provider error.
    }
  }

  return { analyses: [], error: 'Model did not return valid analysis JSON.' };
}

function parseDecision(content) {
  const text = normalizeModelContent(content);
  const candidates = [text, ...extractJsonCandidates(text)];
  for (const candidate of candidates) {
    try {
      return JSON.parse(stripCodeFence(candidate));
    } catch {
      // Try the next candidate.
    }
  }
  return fallbackDecision('Model did not return valid JSON.');
}

function normalizeModelContent(content) {
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          return part.text || part.content || '';
        }
        return '';
      })
      .join('')
      .trim();
  }
  if (content && typeof content === 'object') return JSON.stringify(content);
  return String(content || '').trim();
}

function stripCodeFence(value) {
  return value
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function extractJsonCandidates(text) {
  const candidates = [];
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== '{' && text[start] !== '[') continue;
    const stack = [];
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === '{' || char === '[') {
        stack.push(char);
        continue;
      }
      if (char !== '}' && char !== ']') continue;
      const expected = char === '}' ? '{' : '[';
      if (stack.pop() !== expected) break;
      if (!stack.length) {
        candidates.push(text.slice(start, index + 1));
        break;
      }
    }
  }
  return candidates;
}

function normalizeAnalyses(parsed) {
  const rawItems = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.analyses)
      ? parsed.analyses
      : parsed && typeof parsed === 'object' &&
          (parsed.symbol || parsed.action || parsed.positionRecommendation)
        ? [parsed]
        : [];

  return rawItems
    .filter((raw) => raw && typeof raw === 'object' && !Array.isArray(raw))
    .map((raw) => {
      const rawAction = String(
        raw.positionRecommendation || raw.action || 'WAIT'
      ).toUpperCase();
      const positionRecommendation = normalizePositionRecommendation(rawAction);
      return {
        ...raw,
        action: normalizeLegacyAction(raw.action, positionRecommendation),
        positionRecommendation
      };
    });
}

function normalizePositionRecommendation(value) {
  return {
    BUY: 'OPEN_LONG',
    SELL: 'OPEN_SHORT',
    HOLD: 'WAIT'
  }[value] || (['OPEN_LONG', 'OPEN_SHORT', 'CLOSE_LONG', 'CLOSE_SHORT', 'WAIT'].includes(value)
    ? value
    : 'WAIT');
}

function normalizeLegacyAction(value, positionRecommendation) {
  const action = String(value || '').toUpperCase();
  if (['BUY', 'SELL', 'HOLD'].includes(action)) return action;
  if (positionRecommendation === 'OPEN_LONG') return 'BUY';
  if (positionRecommendation === 'OPEN_SHORT') return 'SELL';
  return 'HOLD';
}

function isEmptyAnalysisPayload(parsed) {
  return Boolean(parsed && typeof parsed === 'object' &&
    !Array.isArray(parsed) && Array.isArray(parsed.analyses));
}

function summarizeAccount(account) {
  if (!account) return null;
  return {
    totalWalletBalance: account.totalWalletBalance || account.totalEq,
    totalMarginBalance: account.totalMarginBalance || account.isoEq,
    availableBalance: account.availableBalance || account.details?.find?.((item) => item.ccy === 'USDT')?.availBal
  };
}

function summarizePositions(positions) {
  return (positions || [])
    .filter((p) => Number(p.positionAmt || p.pos) !== 0)
    .map((p) => ({
      symbol: p.symbol || p.instId,
      positionAmt: p.positionAmt || p.pos,
      entryPrice: p.entryPrice || p.avgPx,
      unrealizedProfit: p.unRealizedProfit || p.upl,
      leverage: p.leverage || p.lever
    }));
}
