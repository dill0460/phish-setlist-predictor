// Distributional before/after harness. Usage: node stats.js app_template.html [N] [seed]
// Runs the REAL engine against a real built index.html, N seeded nights, and prints the
// distributions next to the REAL 2022+ baselines (measured from the project CSV, 204-218
// shows). Baselines were 2009+ until the era alignment; the engine's count and minute tables
// now both describe 2022+, so comparing generated nights to 2009+ figures would call correct
// behaviour a regression (real set 1 is 8.85 songs now, not 10.08).
const { buildEngine } = require('./harness.js');
const E = buildEngine(process.argv[2], 'index.html');
E.setSeed(parseInt(process.argv[4] || '1', 10));
const N = parseInt(process.argv[3] || '1500', 10);
const R = [];
for (let i = 0; i < N; i++) {
  const c = E.compute(); const sl = E.buildSetlist(c.rows, c.n1, c.n2, c.ne);
  const D = a => new Set(a.map(r => r.id)).size;
  let re = null; for (const k of ['set1', 'set2']) {
    const a = sl[k], ix = {}; a.forEach((r, j) => { (ix[r.id] = ix[r.id] || []).push(j); });
    for (const v of Object.values(ix)) if (v.length > 1) re = { gap: v[1] - v[0] };
  }
  if (!re) { const s1 = new Set(sl.set1.map(r => r.id)); if (sl.set2.some(r => s1.has(r.id))) re = { gap: null }; }
  R.push({ n1: c.n1, n2: c.n2, d1: D(sl.set1), d2: D(sl.set2), de: D(sl.encore), m: sl.minutes,
    lm1: sl.set1.filter(r => E.durMedian(r) >= 10).length, lm2: sl.set2.filter(r => E.durMedian(r) >= 10).length, re });
}
const q = (a, p) => { a = a.slice().sort((x, y) => x - y); return a[Math.floor(p * (a.length - 1))]; };
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const tot = R.map(r => r.m.s1 + r.m.s2 + r.m.e);
const totSongs = R.map(r => r.d1 + r.d2 + r.de);
const ratio = R.map(r => r.m.s1 / r.m.s2);
console.log(process.argv[2]);
// Real 2022+ baselines (project CSV): s1 mean 8.85 med 9 · s2 mean 6.92 med 7 · e mean 2.19
// · total songs mean 17.97 med 18, p02 14, under-15 2.5% · minutes and bounds from SET_MIN.
console.log(' set1 distinct  mean %s  p05 %s p50 %s p95 %s   (real 2022+ mean 8.85)', mean(R.map(r => r.d1)).toFixed(2), q(R.map(r => r.d1), .05), q(R.map(r => r.d1), .5), q(R.map(r => r.d1), .95));
console.log(' set2 distinct  mean %s  p05 %s p50 %s p95 %s   (real 2022+ mean 6.92)', mean(R.map(r => r.d2)).toFixed(2), q(R.map(r => r.d2), .05), q(R.map(r => r.d2), .5), q(R.map(r => r.d2), .95));
console.log(' total songs    mean %s  p05 %s p50 %s   under 15: %s%%   (real mean 17.97, med 18, under-15 2.5%%)', mean(totSongs).toFixed(2), q(totSongs, .05), q(totSongs, .5), (100 * totSongs.filter(v => v < 15).length / N).toFixed(1));
console.log(' total minutes  med %s  p95 %s  over bound(%s): %s%%', q(tot, .5).toFixed(1), q(tot, .95).toFixed(1), E.SET_BOUNDS.total[1], (100 * tot.filter(v => v > E.SET_BOUNDS.total[1]).length / N).toFixed(1));
console.log(' set1 minutes   med %s  over bound(%s): %s%%', q(R.map(r => r.m.s1), .5).toFixed(1), E.SET_BOUNDS.s1[1], (100 * R.filter(r => r.m.s1 > E.SET_BOUNDS.s1[1]).length / N).toFixed(1));
console.log(' set2 minutes   med %s  over bound(%s): %s%%', q(R.map(r => r.m.s2), .5).toFixed(1), E.SET_BOUNDS.s2[1], (100 * R.filter(r => r.m.s2 > E.SET_BOUNDS.s2[1]).length / N).toFixed(1));
console.log(' s1:s2 ratio    med %s  outside 0.73-1.58: %s%%  p99 %s   (real: ~10%% outside — it is a 5th-95th band)', q(ratio, .5).toFixed(2), (100 * ratio.filter(v => v < 0.73 || v > 1.58).length / N).toFixed(1), q(ratio, .99).toFixed(2));
console.log(' long songs s1  mean %s   s2 mean %s   (2022+ real: re-measure via mine_longsongs — 2009+ was 1.93 / 2.87)', mean(R.map(r => r.lm1)).toFixed(2), mean(R.map(r => r.lm2)).toFixed(2));
const re = R.filter(r => r.re);
const adj = re.filter(r => r.re.gap === 1).length, sw = re.filter(r => r.re.gap >= 2 && r.re.gap <= 4).length;
console.log(' reentry rate   %s%% (real 22%%)   adjacent %s%% (real 1.8%%)  sandwich %s%% (real 85%%)',
  (100 * re.length / N).toFixed(1), re.length ? (100 * adj / re.length).toFixed(1) : '-', re.length ? (100 * sw / re.length).toFixed(1) : '-');
console.log(' over cap: s1 %s%%  s2 %s%%   under cap: s1 %s%%  s2 %s%%',
  (100 * R.filter(r => r.d1 > r.n1).length / N).toFixed(1), (100 * R.filter(r => r.d2 > r.n2).length / N).toFixed(1),
  (100 * R.filter(r => r.d1 < r.n1).length / N).toFixed(1), (100 * R.filter(r => r.d2 < r.n2).length / N).toFixed(1));
