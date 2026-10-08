/**
 * 极简 CDP 截图/交互验证脚本（零依赖，Node 22 内置 WebSocket + fetch）
 * 用法：node scripts/_cdp_shot.mjs <url> <out.png> ["js1" "js2" ...]
 * 前置：已启动 chrome --headless=new --remote-debugging-port=9222 --user-data-dir=<tmp>
 */
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const [url, out, ...steps] = process.argv.slice(2);
if (!url || !out) { console.error('usage: node _cdp_shot.mjs <url> <out.png> [js...]'); process.exit(2); }
const CDP = process.env.CDP || 'http://127.0.0.1:9222';

let targets;
for (let i = 0; i < 60; i++) {
  try {
    targets = await (await fetch(CDP + '/json')).json();
    if (targets.some(t => t.type === 'page')) break;
  } catch { /* 守护进程尚未就绪 */ }
  await sleep(250);
}
const page = (targets || []).find(t => t.type === 'page');
if (!page) { console.error('no page target'); process.exit(3); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  const slot = pending.get(m.id);
  if (slot) { pending.delete(m.id); slot(m); }
});
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve);
  ws.addEventListener('error', reject);
});
const send = (method, params = {}) => new Promise(res => {
  const id = ++seq;
  pending.set(id, res);
  ws.send(JSON.stringify({ id, method, params }));
});

await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
// 关掉 HTTP 缓存：index.html / 资产刷新后必须拿到新构建，否则会误判「改动没生效」
await send('Network.setCacheDisabled', { cacheDisabled: true });
// 可用 CDP_WIDTH/CDP_HEIGHT 覆盖视口（默认走 Chrome 窗口尺寸，窄视口会触发响应式断点）
const vw = Number(process.env.CDP_WIDTH || 0);
const vh = Number(process.env.CDP_HEIGHT || 0);
if (vw || vh) {
  await send('Emulation.setDeviceMetricsOverride', {
    width: vw || 1280, height: vh || 900, deviceScaleFactor: 1, mobile: false
  });
}
// 先跳到 about:blank：hash 路由下 Page.navigate 到相同 URL 不会真正重新加载
await send('Page.navigate', { url: 'about:blank' });
await sleep(400);
await send('Page.navigate', { url });
await sleep(7000); // 等 SPA 拉数据渲染

for (const expr of steps) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  const v = r.result?.result?.value ?? r.result?.exceptionDetails?.text ?? null;
  console.log('EVAL>', expr.length > 70 ? expr.slice(0, 70) + '…' : expr);
  console.log('  ->', typeof v === 'string' ? v : JSON.stringify(v));
  await sleep(1800);
}

const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
console.log('saved', out);
ws.close();
process.exit(0);
