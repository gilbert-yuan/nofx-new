import fs from 'node:fs';
import path from 'node:path';
const DIR = path.resolve('data/backtest');
const j = JSON.parse(fs.readFileSync(path.join(DIR, process.argv[2] || 'r70.json'), 'utf8'));
console.log('placed =', j.placed.length, '| cancels =', j.cancels.length, '| trades =', j.trades.length);
console.log('placed[0] =', JSON.stringify(j.placed[0]));
console.log('trades[0] =', JSON.stringify(j.trades[0]));
console.log('trades[1] =', JSON.stringify(j.trades[1]));
console.log('trades keys =', Object.keys(j.trades[0] || {}).join(','));
