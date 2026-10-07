import { main } from './backtest/system.mjs';
main(process.argv.slice(2), 'h4-trend-breakout-v1').catch(error => { console.error(error.message); process.exitCode = 1; });
