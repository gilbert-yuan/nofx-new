const fs = require('fs'); const os = require('os'); const path = require('path');
const { execSync } = require('child_process');
const f = path.join(os.tmpdir(), 'nofx_pm2env.txt');
let out = '';
try {
  const raw = execSync('node_modules\\.bin\\pm2.cmd jlist', {
    cwd: 'D:\\UGit\\nofx-new',
    env: { ...process.env, PM2_HOME: 'D:/UGit/nofx-new/.pm2' },
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  const list = JSON.parse(raw);
  const lines = [];
  for (const p of list) {
    const e = p.pm2_env || {};
    const keys = Object.keys(e).filter(k => /^NOFX_/.test(k));
    lines.push(`${p.name} status=${e.status} restarts=${e.restart_time} uptime_ms=${e.pm_uptime}`);
    lines.push('  NOFX vars: ' + (keys.length ? keys.map(k => `${k}=${e[k]}`).join(', ') : '(none)'));
    lines.push('  NODE_ENV=' + e.NODE_ENV + ' PORT=' + e.PORT);
  }
  out = lines.join('\n');
} catch (e) {
  out = 'ERR ' + e.message + '\nstdout:' + (e.stdout || '') + '\nstderr:' + (e.stderr || '');
}
fs.writeFileSync(f, out, 'utf8');
