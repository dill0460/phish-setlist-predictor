#!/usr/bin/env node
// Paired comparison of two backtest.js --json results: node compare.js before.json after.json
// Same shows, same order, so each show is its own control. Reports the mean change and its
// standard error; |t| above ~2 means the change is unlikely to be luck.
const fs = require('fs');
const [a, b] = process.argv.slice(2).map(f => JSON.parse(fs.readFileSync(f, 'utf8')));

function paired(label, A, B, i, better) {
  if (!A || !B) return;
  const pa = new Map(A.map(r => [r[0], r])), rows = B.filter(r => pa.has(r[0]));
  if (!rows.length) return;
  const d = rows.map(r => r[i] - pa.get(r[0])[i]);
  const m = d.reduce((x, y) => x + y, 0) / d.length;
  const sd = Math.sqrt(d.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(1, d.length - 1));
  const se = sd / Math.sqrt(d.length);
  console.log(`${label.padEnd(14)} ${m >= 0 ? '+' : ''}${m.toFixed(3)} per show  (+/- ${se.toFixed(3)}, ` +
    `t=${se > 0 ? (m / se).toFixed(2) : 'n/a'}, ${better} is better, n=${d.length})`);
}

paired('top-20 hits', a.perShow, b.perShow, 1, 'higher');
paired('Brier', a.perShow, b.perShow, 2, 'lower');
paired('official hits', a.perOfficial, b.perOfficial, 1, 'higher');
