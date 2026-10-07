import { main } from './backtest/system.mjs';
main().catch(error => { console.error(`回测失败：${error.message}`); process.exitCode = 1; });
