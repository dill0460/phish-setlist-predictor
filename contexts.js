#!/usr/bin/env node
// ---------------------------------------------------------------------------
// contexts.js — learns what the model misses on particular KINDS of night. Runs in the Action
// right after build.py and before snapshot.js:
//
//     python build.py && node contexts.js && node snapshot.js
//
// Some nights are not like the others: a tour opener leans on Free, Ghost and Sand; the last night
// of a run and the last show of a tour run long; NYE adds a third set. The model already knows a
// lot of this indirectly (time off, run position), so a table of "songs played more on tour
// openers" double-counts what it already gets right — that version was measured and made the
// predictions worse. This learns the RESIDUAL instead: replay the model on every past night of a
// kind, exactly as it would have predicted it the day before, and compare with what was played.
//
//   song correction   m = (times played + k) / (times the model expected + k)
//   night-size factor F = (songs played + kN) / (songs the model expected + kN)
//
// k and kN are pseudo-counts that pull thin evidence toward "no correction". The page applies
// these only to a matching night (see CONTEXTS in app_template.html, which defines the kinds of
// night identically) and keeps everything else untouched.
//
// The replay is the slow part (~0.5 s a show). Results are cached in data/context_cache.json,
// keyed to the engine source, so a normal day only replays the newest show; a change to
// app_template.html replays everything once (several minutes). If anything fails, the page keeps
// CONTEXT_CORR = null and behaves exactly as before.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { buildEngine } = require('./harness.js');

const HERE = __dirname;
const TPL = path.join(HERE, 'app_template.html');
const IDX = path.join(HERE, 'index.html');
const CACHE = path.join(HERE, 'data', 'context_cache.json');
const OUT = path.join(HERE, 'data', 'context_corrections.json');
const SINCE = process.env.CONTEXT_SINCE || '2010-01-01';
// Learn only from shows BEFORE this date (backtesting the pipeline honestly); default: all.
const UNTIL = process.env.CONTEXT_UNTIL || '9999-12-31';
// Pseudo-counts, chosen by walk-forward test over the 150 shows since 2023-07-28 (each correction
// learned only from earlier shows): kinds of night k=60, song patterns k=30, night size k=40.
const K_SONG = 60;        // per-song correction on a kind of night
const K_CAT = 30;         // song-pattern correction (tour repeats, song age)
const K_SIZE = 40;        // night-size factor
const MIN_NIGHTS = 5;     // a kind of night with fewer past examples is not corrected

const tpl = fs.readFileSync(TPL, 'utf8');
const idxText = fs.readFileSync(IDX, 'utf8');
// The replay must see the model WITHOUT the corrections it is about to learn.
const RE = /const CONTEXT_CORR = [\s\S]*?;[ \t\r]*(?:\/\/[^\n]*)?\n/;
if (!RE.test(idxText)) { console.log('index.html has no CONTEXT_CORR slot (old template) — nothing to do'); process.exit(0); }
const tmp = path.join(HERE, 'data', '.contexts_index.tmp.html');
fs.writeFileSync(tmp, idxText.replace(RE, 'const CONTEXT_CORR = null;\n'));
const E = buildEngine(TPL, tmp);
fs.unlinkSync(tmp);
if (!E.contextsOf || !E.songCatsFor) { console.log('template has no contextsOf()/songCatsFor() — nothing to do'); process.exit(0); }

// engine version: the script block of the template (the page text can change without a replay)
const engineHash = crypto.createHash('sha256')
  .update(tpl.slice(tpl.indexOf('<script>'), tpl.indexOf('function render()'))).digest('hex').slice(0, 12);
// The tables the engine reads (pairs, closers, the calendar correction...) are re-mined every build
// and drift a little with each new show, so the cache is also rebuilt from scratch every 28 days.
const today = new Date().toISOString().slice(0, 10);
const ageDays = d => (Date.parse(today) - Date.parse(d)) / 864e5;
let cache = { engine: engineHash, since: SINCE, built: today, shows: {} };
try {
  const c = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  if (c.engine !== engineHash || c.since !== SINCE) console.log(`engine changed (${c.engine} -> ${engineHash}): replaying every show since ${SINCE}`);
  else if (!c.built || ageDays(c.built) > 28) console.log(`cache is ${c.built ? Math.round(ageDays(c.built)) + ' days' : 'of unknown age'} old: replaying every show since ${SINCE}`);
  else cache = c;
} catch (e) { console.log(`no cache yet: replaying every show since ${SINCE}`); }

const idx = idxText;
const a = idx.indexOf('id="plays-data"'), b = idx.indexOf('>', a) + 1;
const PLAYS = JSON.parse(idx.slice(b, idx.indexOf('</script>', b)));
const played = new Map();
for (const p of PLAYS) { if (!played.has(p.date)) played.set(p.date, new Set()); played.get(p.date).add(p.sid); }

const S = E.SHOWS;
const t0 = Date.now();
let replayed = 0;
for (let t = 1; t < S.length; t++) {
  const s = S[t];
  if (s.date < SINCE || cache.shows[s.date]) continue;
  E.setSetting('refEnd', S[t - 1].date);
  E.setSetting('nextDate', s.date);
  E.setSetting('runPos', s.runPos && s.runPos !== 'none' ? s.runPos : '');
  const rows = E.compute().rows;
  // [songid, prediction] for every song the model gave a real chance; suppressed rows excluded
  cache.shows[s.date] = rows
    .filter(r => r.pred >= 0.003 && !r.runRepeat && !r.offTheme && !r.deepDormant && !r.dateBlocked)
    .map(r => [r.id, +r.pred.toFixed(4)]);
  replayed++;
  if (replayed % 100 === 0) console.log(`  replayed ${replayed} shows (${Math.round((Date.now() - t0) / 1000)}s)`);
}
// drop shows that left the history (a soundcheck removed upstream, a corrected date)
const known = new Set(S.map(s => s.date));
for (const d of Object.keys(cache.shows)) if (!known.has(d)) delete cache.shows[d];
fs.writeFileSync(CACHE, JSON.stringify(cache));
console.log(`context replay: ${replayed} new, ${Object.keys(cache.shows).length} cached (${Math.round((Date.now() - t0) / 1000)}s)`);

// 1. SONG PATTERNS (tour repeats, song age), learned against the bare model
const learnable = [];
for (let t = 1; t < S.length; t++) {
  const s = S[t];
  if (s.date >= UNTIL || !cache.shows[s.date]) continue;
  learnable.push(t);
}
const catStat = new Map();
const catsByShow = new Map();
for (const t of learnable) {
  const s = S[t], pl = played.get(s.date) || new Set(), catsOf = E.songCatsFor(s);
  catsByShow.set(t, catsOf);
  for (const [id, p] of cache.shows[s.date]) {
    for (const key of catsOf(id)) {
      const st = catStat.get(key) || [0, 0];
      st[0] += pl.has(id) ? 1 : 0; st[1] += p; catStat.set(key, st);
    }
  }
}
const cats = {};
for (const [key, [a, x]] of catStat) cats[key] = +((a + K_CAT) / (x + K_CAT)).toFixed(4);
// each show's predictions with the song patterns applied (night total kept), for step 2
const adjusted = new Map();
for (const t of learnable) {
  const rows = cache.shows[S[t].date], catsOf = catsByShow.get(t);
  const total = rows.reduce((a, r) => a + r[1], 0);
  const b = rows.map(([id, p]) => { let m = 1; for (const k of catsOf(id)) m *= cats[k] || 1; return Math.min(0.95, p * m); });
  const sc = E.oddsScaleTo(b, total);
  adjusted.set(t, rows.map((r, i) => [r[0], sc[i]]));
}

// 2. KINDS OF NIGHT, learned against the model WITH the song patterns (so neither double-counts)
const agg = {};
for (const t of learnable) {
  const s = S[t];
  const rows = adjusted.get(t);
  const pl = played.get(s.date) || new Set();
  for (const ctx of E.contextsOf(s, S[t + 1] || null)) {
    const g = agg[ctx] || (agg[ctx] = { n: 0, A: new Map(), X: new Map(), pa: 0, px: 0 });
    g.n++;
    for (const [id, p] of rows) {
      g.X.set(id, (g.X.get(id) || 0) + p); g.px += p;
      if (pl.has(id)) { g.A.set(id, (g.A.get(id) || 0) + 1); g.pa++; }
    }
  }
}
const out = { k: K_SONG, kCat: K_CAT, kN: K_SIZE, since: SINCE, until: UNTIL, engine: engineHash, cats, nights: {}, size: {}, songs: {} };
for (const [ctx, g] of Object.entries(agg)) {
  out.nights[ctx] = g.n;
  if (g.n < MIN_NIGHTS) continue;
  out.size[ctx] = +((g.pa + K_SIZE) / (g.px + K_SIZE)).toFixed(4);
  const m = {};
  for (const [id, x] of g.X) {
    const v = Math.max(0.4, Math.min(3, ((g.A.get(id) || 0) + K_SONG) / (x + K_SONG)));
    if (Math.abs(v - 1) >= 0.03) m[id] = +v.toFixed(3);
  }
  out.songs[ctx] = m;
}
fs.writeFileSync(OUT, JSON.stringify(out));
const names = new Map(E.SONGS.map(s => [s.id, s.name]));
console.log('  song patterns: ' + Object.entries(cats).sort().map(([k, v]) => `${k} x${v}`).join(', '));
for (const ctx of Object.keys(out.songs)) {
  const top = Object.entries(out.songs[ctx]).sort((x, y) => y[1] - x[1]).slice(0, 4).map(([id, v]) => `${names.get(+id)} x${v}`);
  console.log(`  ${ctx.padEnd(10)} ${String(out.nights[ctx]).padStart(4)} nights, size x${out.size[ctx]}; most under-predicted: ${top.join(', ')}`);
}
// patch the built page so it ships what was learned (same pattern as snapshot.js and PRED_LOG)
fs.writeFileSync(IDX, idx.replace(RE, `const CONTEXT_CORR = ${JSON.stringify({ cats: out.cats, size: out.size, songs: out.songs })};\n`));
console.log(`wrote ${path.relative(HERE, OUT)} and patched index.html`);
