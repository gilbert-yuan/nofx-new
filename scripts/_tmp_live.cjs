const fs = require('fs'); const os = require('os'); const path = require('path');
const f = path.join(os.tmpdir(), 'nofx_live.txt');
const lines = [];
(async () => {
  try {
    const r = await fetch('http://127.0.0.1:3100/api/health', { signal: AbortSignal.timeout(5000) });
    lines.push('HEALTH ' + r.status + ' ' + (await r.text()).slice(0, 300));
  } catch (e) { lines.push('HEALTH_ERR ' + e.message); }
  try {
    const r = await fetch('http://127.0.0.1:3100/api/automation/status', { signal: AbortSignal.timeout(8000) });
    lines.push('AUTO ' + r.status + ' ' + (await r.text()).slice(0, 800));
  } catch (e) { lines.push('AUTO_ERR ' + e.message); }
  try {
    const r = await fetch('http://127.0.0.1:3100/api/config', { signal: AbortSignal.timeout(5000) });
    const j = await r.json();
    const c = j.config || j;
    lines.push('ENGINE ' + JSON.stringify({ analysis: c.analysis, traderEnabled: c.trader && c.trader.enabled, marketSync: c.marketSync }));
  } catch (e) { lines.push('CONFIG_ERR ' + e.message); }
  lines.push('ENV_MIN_TREND_SCORE=' + (process.env.NOFX_MIN_TREND_SCORE ?? '(unset)'));
  fs.writeFileSync(f, lines.join('\n'), 'utf8');
})();
