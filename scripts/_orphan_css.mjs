/**
 * 找出 Vue SFC 中被 scoped style 定义、但模板/脚本里已不再使用的 class（孤儿样式）。
 * 用法：node scripts/_orphan_css.mjs src/components/TradingView.vue
 */
import { readFileSync } from 'node:fs';

const file = process.argv[2];
const src = readFileSync(file, 'utf8');
const cut = src.indexOf('<style');
const markup = src.slice(0, cut);
const css = src.slice(cut);

const names = new Set();
for (const m of css.matchAll(/^\.([A-Za-z0-9_-]+)/gm)) names.add(m[1]);

const orphans = [];
for (const n of [...names].sort()) {
  const re = new RegExp(`(^|[^A-Za-z0-9_-])${n.replace(/[-]/g, '\\-')}([^A-Za-z0-9_-]|$)`);
  if (!re.test(markup)) orphans.push(n);
}

console.log(`style 中定义的 class: ${names.size} 个`);
console.log(`孤儿（模板未使用）: ${orphans.length} 个`);
console.log(orphans.join('\n'));
