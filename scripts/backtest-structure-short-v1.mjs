import { main } from './backtest/system.mjs';
main(process.argv.slice(2), 'structure-short-v1').catch(error => { console.error(error.message); process.exitCode = 1; });
