#!/usr/bin/env node
// Paired comparison of two backtest.js --json results: node compare.js before.json after.json
// Same shows, same order, so each show is its own control. Reports the mean change and its
// standard error; |t| above ~2 means the change is unlikely to be luck.
const fs = require('fs');
const [a, b] = process.argv.slice(2).map(f => JSON.parse(fs.readFileSync(f, 'utf8')));
const pa = new Map(a.perShow.map(r => [r[0], r])), rows = b.perShow.filter(r => pa.has(r[0]));
for (const [k, i, better] of [['top-20 hits', 1, 'higher'], ['Brier', 2, 'lower']]) {
  const d = rows.map(r => r[i] - pa.get(r[0])[i]);
  const m = d.reduce((x, y) => x + y, 0) / d.length;
  const sd = Math.sqrt(d.reduce((x, y) => x + (y - m) ** 2, 0) / (d.length - 1));
  const se = sd / Math.sqrt(d.length);
  console.log(`${k.padEnd(12)} ${m >= 0 ? '+' : ''}${m.toFixed(3)} per show  (+/- ${se.toFixed(3)}, t=${(m / se).toFixed(2)}, ${better} is better, n=${d.length})`);
}
