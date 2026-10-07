import { main } from './backtest/system.mjs';
main(process.argv.slice(2), 'h4-chandelier-breakout-v1').catch(error => { console.error(error.message); process.exitCode = 1; });
