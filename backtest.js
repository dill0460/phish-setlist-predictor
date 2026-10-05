#!/usr/bin/env node
// ---------------------------------------------------------------------------
// backtest.js — the before/after scoreboard for any change to the model.
//
//   node backtest.js                       probabilities + official call + realism
//   node backtest.js --quick               probabilities only (about a minute)
//   node backtest.js --fetch-phishin       refresh the phish.in cache used for realism
//
// Options: --shows N (default 150)   --official N (default 60)   --draws N (default 200)
//          --template FILE   --index FILE   --json FILE (also write the numbers as JSON)
//          --salt X   re-seed the official-call draws, to measure how much of a change is luck
//
// WALK-FORWARD, like the live site: every target show is predicted with the stats window
// ending at the show BEFORE it, at the default settings, so nothing from the night being
// predicted (or later) can leak in. The answer key is the setlist data already baked into
// index.html (phish.net). phish.in supplies what phish.net does not carry: real track
// lengths and the running order inside each set, used only by the realism section.
//
// Numbers:
//   top-20 hits     of the 20 songs the model rates most likely, how many were played.
//                   The site's own headline measure (the Track Record tab uses it too).
//   Brier / show    probability accuracy over EVERY song in the catalog: the sum of
//                   (predicted - actual)^2, where actual is 1 if played and 0 if not.
//                   Lower is better. Catches over- and under-confidence that a top-20
//                   count cannot see, because the top-20 only cares about the ranking.
//   expected songs  the sum of every song's probability — what the model thinks the
//                   night's song count is — against what was really played.
//   official call   the committed-style consensus setlist (500 draws on the live site;
//                   --draws here), graded the way snapshot.js grades it.
//   order agreement among called songs that were played in the set they were called for,
//                   the share of song pairs whose running order the call got right.
//                   50% is a coin flip.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const { buildEngine } = require('./harness.js');
const { buildConsensus, hashSeed } = require('./consensus.js');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const flag = k => args.includes('--' + k);
const HERE = __dirname;
const TPL = opt('template', path.join(HERE, 'app_template.html'));
const IDX = opt('index', path.join(HERE, 'index.html'));
const NSHOWS = parseInt(opt('shows', '150'), 10);
const NOFF = flag('quick') ? 0 : parseInt(opt('official', '60'), 10);
const DRAWS = parseInt(opt('draws', '200'), 10);
const SALT = opt('salt', '');                     // re-seeds the official-call draws (noise check)
const CACHE_DIR = path.join(HERE, '.backtest-cache');
const PHISHIN = opt('phishin', path.join(CACHE_DIR, 'phishin.json'));

async function fetchPhishin() {
  const UA = { 'User-Agent': 'phish-setlist-predictor backtest (github.com/dill0460)' };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const get = async url => {
    for (let i = 0; i < 3; i++) {
      try { const r = await fetch(url, { headers: UA }); if (r.ok) return await r.json(); if (r.status === 404) return null; } catch (e) { /* retry */ }
      await sleep(1500 * (i + 1));
    }
    return null;
  };
  let cache = {}; try { cache = JSON.parse(fs.readFileSync(PHISHIN, 'utf8')); } catch (e) { /* first run */ }
  const dates = [];
  for (let page = 1; page <= 20; page++) {
    const j = await get(`https://phish.in/api/v2/shows?per_page=100&page=${page}&sort=date:desc`);
    const shows = (j && j.shows) || [];
    if (!shows.length) break;
    let stop = false;
    for (const s of shows) { if (s.date < '2019-01-01') { stop = true; break; } dates.push(s.date); }
    if (stop) break;
  }
  let n = 0;
  for (const d of dates) {
    if (cache[d]) continue;
    const j = await get(`https://phish.in/api/v2/shows/${d}`);
    if (j && j.tracks) cache[d] = j.tracks.map(t => ({ set: t.set_name, pos: t.position, title: t.title, min: +(t.duration / 60000).toFixed(2) }));
    if (++n % 50 === 0) console.log(`  ${n} shows fetched`);
    await sleep(250);
  }
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(PHISHIN, JSON.stringify(cache));
  console.log(`phish.in cache: ${Object.keys(cache).length} shows -> ${PHISHIN}`);
}

function main() {
  const t0 = Date.now();
  const E = buildEngine(TPL, IDX);
  const idx = fs.readFileSync(IDX, 'utf8');
  const PLAYS = JSON.parse(idx.match(/id=['"]plays-data['"][^>]*>([\s\S]*?)<\/script>/)[1]);
  const played = new Map(), slotsOf = new Map();
  for (const p of PLAYS) {
    if (!played.has(p.date)) { played.set(p.date, new Set()); slotsOf.set(p.date, new Map()); }
    played.get(p.date).add(p.sid); slotsOf.get(p.date).set(p.sid, p.sl);
  }
  const S = E.SHOWS, N = S.length;
  const first = Math.max(1, N - NSHOWS);
  const target = t => {
    const tgt = S[t];
    E.setSetting('refEnd', S[t - 1].date);
    E.setSetting('nextDate', tgt.date);
    E.setSetting('runPos', tgt.runPos && tgt.runPos !== 'none' ? tgt.runPos : '');
    return tgt;
  };
  const out = { template: path.basename(TPL), index: path.basename(IDX), shows: N - first,
                from: S[first].date, to: S[N - 1].date };

  // ---- 1. probabilities -----------------------------------------------------------------
  const edges = [0.30, 0.45, 0.60, 0.80, 1.01];
  const bins = edges.slice(0, -1).map(() => [0, 0, 0]);
  let top20 = 0, brier = 0, expSongs = 0, actSongs = 0;
  const perShow = [];                                         // for paired before/after comparisons
  const grp = { 'after a 14+ day break': [0, 0, 0, 0], 'later night of a run': [0, 0, 0, 0], 'other': [0, 0, 0, 0] };
  for (let t = first; t < N; t++) {
    const tgt = target(t);
    const c = E.compute();
    const pl = played.get(tgt.date) || new Set();
    const ids = new Set();
    let sp = 0, b = 0;
    for (const r of c.rows) {
      ids.add(r.id);
      const y = pl.has(r.id) ? 1 : 0;
      sp += r.pred; b += (r.pred - y) ** 2;
      for (let k = 0; k < edges.length - 1; k++) if (r.pred >= edges[k] && r.pred < edges[k + 1]) { bins[k][0]++; bins[k][1] += r.pred; bins[k][2] += y; }
    }
    for (const id of pl) if (!ids.has(id)) b += 1;           // played with no row at all: p = 0
    const h = c.rows.slice().sort((a, b2) => b2.pred - a.pred).slice(0, 20).filter(r => pl.has(r.id)).length;
    top20 += h; brier += b; expSongs += sp; actSongs += pl.size;
    perShow.push([tgt.date, h, +b.toFixed(4)]);
    const days = (new Date(tgt.date) - new Date(S[t - 1].date)) / 864e5;
    const g = days >= 14 ? 'after a 14+ day break' : (/night [2-9]/.test(tgt.runN || '') ? 'later night of a run' : 'other');
    grp[g][0]++; grp[g][1] += sp; grp[g][2] += pl.size; grp[g][3] += h;
  }
  const n = N - first;
  out.top20 = +(top20 / n).toFixed(3);
  out.brier = +(brier / n).toFixed(3);
  out.expected = +(expSongs / n).toFixed(2);
  out.played = +(actSongs / n).toFixed(2);
  out.groups = Object.fromEntries(Object.entries(grp).filter(([, v]) => v[0]).map(([k, v]) =>
    [k, { shows: v[0], expected: +(v[1] / v[0]).toFixed(2), played: +(v[2] / v[0]).toFixed(2), top20: +(v[3] / v[0]).toFixed(2) }]));
  out.perShow = perShow;
  out.topBands = bins.map((b, k) => ({ band: `${Math.round(edges[k] * 100)}-${Math.round(Math.min(1, edges[k + 1]) * 100)}%`,
    n: b[0], predicted: b[0] ? +(100 * b[1] / b[0]).toFixed(1) : null, actual: b[0] ? +(100 * b[2] / b[0]).toFixed(1) : null }));

  // ---- 2. official call (consensus) ---------------------------------------------------------
  if (NOFF > 0) {
    const f0 = Math.max(1, N - NOFF);
    let hit = 0, called = 0, nailed = 0, close = 0, slot = 0, conc = 0, pairs = 0, ofN = 0;
    const perOfficial = [];
    for (let t = f0; t < N; t++) {
      const tgt = target(t);
      const con = buildConsensus(E, { draws: DRAWS, seed: hashSeed(tgt.date + SALT) });
      const pl = played.get(tgt.date) || new Set(), sl = slotsOf.get(tgt.date) || new Map();
      const sets = [['s1', con.set1.map(x => x.id)], ['s2', con.set2.map(x => x.id)], ['e', con.encore.map(x => x.id)]];
      let h0 = 0;
      for (const [, ids] of sets) { called += ids.length; h0 += ids.filter(id => pl.has(id)).length; }
      hit += h0; perOfficial.push([tgt.date, h0]);
      const realOpen = [...sl.entries()].find(([, v]) => v.includes(0));
      if (realOpen && con.set1[0] && con.set1[0].id === realOpen[0]) nailed++;
      else if (realOpen && (con.open5 || []).includes(realOpen[0])) close++;
      // exact named spots: S1 open/close, S2 open/close, encore
      const want = (k, i, len) => k === 'e' ? 6 : (k === 's1' ? 0 : 3) + (i === 0 ? 0 : (i === len - 1 ? 2 : 1));
      for (const [k, ids] of sets) ids.forEach((id, i) => { const w = want(k, i, ids.length); if ([0, 2, 3, 5, 6].includes(w) && (sl.get(id) || []).includes(w)) slot++; });
      // running order, from the real positions phish.in carries (when cached)
      const realOrder = REAL_ORDER.get(tgt.date);
      if (realOrder) {
        for (const [k, ids] of sets) {
          if (k === 'e') continue;
          const real = realOrder[k];
          const both = ids.filter(id => real.has(id));
          for (let a = 0; a < both.length; a++) for (let b2 = a + 1; b2 < both.length; b2++) {
            pairs++; if (real.get(both[a]) < real.get(both[b2])) conc++;
          }
        }
      }
      ofN++;
    }
    out.official = { shows: ofN, draws: DRAWS, called: +(called / ofN).toFixed(2), hits: +(hit / ofN).toFixed(2),
      precision: +(100 * hit / called).toFixed(1), openerNailed: nailed, openerTop5: close,
      exactSpots: +(slot / ofN).toFixed(2), orderAgreement: pairs ? +(100 * conc / pairs).toFixed(1) : null, orderPairs: pairs };
    out.perOfficial = perOfficial;
  }

  // ---- 3. realism: generated nights against the last 100 real shows -----------------------
  if (NOFF > 0) {
    const L = Math.min(100, N - 1), r0 = N - L;
    const real = { songs: [], s1: [], s2: [], e: [] };
    for (let t = r0; t < N; t++) { const s = S[t]; real.songs.push(s.n1 + s.n2 + s.ne); real.s1.push(s.n1); real.s2.push(s.n2); real.e.push(s.ne); }
    const gen = { songs: [], s1: [], s2: [], e: [], m1: [], m2: [], s1longer: 0, longPos2: [0, 0, 0, 0, 0], open2long: 0, n: 0 };
    E.setSeed(12345);
    for (let t = r0; t < N; t++) {
      target(t);
      const c = E.compute();
      for (let k = 0; k < 2; k++) {
        const sl = E.buildSetlist(c.rows, c.n1, c.n2, c.ne);
        const d = a => new Set(a.map(r => r.id)).size;
        gen.songs.push(d([...sl.set1, ...sl.set2, ...sl.encore])); gen.s1.push(d(sl.set1)); gen.s2.push(d(sl.set2)); gen.e.push(d(sl.encore));
        gen.m1.push(sl.minutes.s1); gen.m2.push(sl.minutes.s2); if (sl.minutes.s1 > sl.minutes.s2) gen.s1longer++;
        const a2 = sl.set2; let li = 0; a2.forEach((r, j) => { if (E.durMedian(r) > E.durMedian(a2[li])) li = j; });
        gen.longPos2[Math.min(4, Math.floor(5 * li / Math.max(1, a2.length - 1)))]++;
        if (a2.length && E.durMedian(a2[0]) >= 10) gen.open2long++;
        gen.n++;
      }
    }
    const mean = a => +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2);
    const q = (a, p) => { const b = a.slice().sort((x, y) => x - y); return +b[Math.floor(p * (b.length - 1))].toFixed(1); };
    const realTimes = REAL_TIMES.filter(x => x.date >= S[r0].date);
    out.realism = {
      songsPerNight: { real: mean(real.songs), generated: mean(gen.songs) },
      set1: { real: mean(real.s1), generated: mean(gen.s1) },
      set2: { real: mean(real.s2), generated: mean(gen.s2) },
      encore: { real: mean(real.e), generated: mean(gen.e) },
      under14songs: { real: +(100 * real.songs.filter(v => v < 14).length / real.songs.length).toFixed(1), generated: +(100 * gen.songs.filter(v => v < 14).length / gen.n).toFixed(1) },
    };
    if (realTimes.length >= 20) {
      out.realism.set1Minutes = { real: q(realTimes.map(x => x.m1), 0.5), generated: q(gen.m1, 0.5) };
      out.realism.set2Minutes = { real: q(realTimes.map(x => x.m2), 0.5), generated: q(gen.m2, 0.5) };
      out.realism.set1LongerThanSet2 = { real: +(100 * realTimes.filter(x => x.m1 > x.m2).length / realTimes.length).toFixed(0), generated: +(100 * gen.s1longer / gen.n).toFixed(0) };
      const rl = [0, 0, 0, 0, 0]; let ro = 0;
      for (const x of realTimes) { rl[x.longPos2]++; if (x.open2long) ro++; }
      out.realism.set2BiggestJamByFifth = { real: rl.map(v => Math.round(100 * v / realTimes.length)), generated: gen.longPos2.map(v => Math.round(100 * v / gen.n)) };
      out.realism.set2OpenerIsLongJam = { real: Math.round(100 * ro / realTimes.length), generated: Math.round(100 * gen.open2long / gen.n) };
      out.realism.realShowsWithTimes = realTimes.length;
    }
  }
  out.seconds = Math.round((Date.now() - t0) / 1000);
  return out;
}

// Real running order and track times, from the phish.in cache (optional).
let REAL_ORDER = new Map(), REAL_TIMES = [];
function loadPhishin(E) {
  let cache; try { cache = JSON.parse(fs.readFileSync(PHISHIN, 'utf8')); } catch (e) { return false; }
  const idByName = new Map(E.SONGS.map(s => [s.name.toLowerCase(), s.id]));
  const medById = new Map(E.SONGS.map(s => [s.id, s.dur != null ? s.dur : 7.2]));
  for (const [d, tracks] of Object.entries(cache)) {
    const set1 = tracks.filter(t => t.set === 'Set 1').sort((a, b) => a.pos - b.pos);
    const set2 = tracks.filter(t => t.set === 'Set 2').sort((a, b) => a.pos - b.pos);
    if (!set1.length || !set2.length) continue;
    const ord = arr => { const m = new Map(); arr.forEach((t, i) => { const id = idByName.get(t.title.toLowerCase()); if (id != null && !m.has(id)) m.set(id, i); }); return m; };
    REAL_ORDER.set(d, { s1: ord(set1), s2: ord(set2) });
    if ([...set1, ...set2].some(t => !(t.min > 0))) continue;          // a track with no audio length
    const m1 = set1.reduce((s, t) => s + t.min, 0), m2 = set2.reduce((s, t) => s + t.min, 0);
    const med = t => { const id = idByName.get(t.title.toLowerCase()); return id != null ? medById.get(id) : 7.2; };
    let li = 0; set2.forEach((t, j) => { if (med(t) > med(set2[li])) li = j; });
    REAL_TIMES.push({ date: d, m1, m2, longPos2: Math.min(4, Math.floor(5 * li / Math.max(1, set2.length - 1))), open2long: med(set2[0]) >= 10 });
  }
  return true;
}

function print(o) {
  console.log(`\nBACKTEST  ${o.template} on ${o.index}   ${o.shows} shows ${o.from} .. ${o.to}   (${o.seconds}s)`);
  console.log(`\n  PROBABILITIES`);
  console.log(`    top-20 hits per show        ${o.top20.toFixed(3)}      (higher is better)`);
  console.log(`    Brier per show              ${o.brier.toFixed(3)}     (lower is better)`);
  console.log(`    expected songs vs played    ${o.expected} vs ${o.played}`);
  for (const [k, v] of Object.entries(o.groups)) console.log(`      ${k.padEnd(24)} ${String(v.shows).padStart(3)} shows   expected ${v.expected} vs played ${v.played}   top-20 ${v.top20}`);
  console.log(`    confident calls             predicted -> actually played`);
  for (const b of o.topBands) if (b.n) console.log(`      ${b.band.padEnd(8)} n=${String(b.n).padStart(4)}   ${b.predicted}% -> ${b.actual}%`);
  if (o.official) {
    const f = o.official;
    console.log(`\n  OFFICIAL CALL  (last ${f.shows} shows, ${f.draws} draws each)`);
    console.log(`    hits                        ${f.hits} of ${f.called} called   (${f.precision}% of called songs played)`);
    console.log(`    opener                      nailed ${f.openerNailed}, in top-5 ${f.openerTop5}`);
    console.log(`    exact named spots per show  ${f.exactSpots}`);
    console.log(`    running-order agreement     ${f.orderAgreement == null ? 'n/a (no phish.in cache)' : f.orderAgreement + '% of ' + f.orderPairs + ' song pairs (50% = coin flip)'}`);
  }
  if (o.realism) {
    console.log(`\n  REALISM  generated nights vs the last 100 real shows`);
    for (const [k, v] of Object.entries(o.realism)) if (v && typeof v === 'object') console.log(`    ${k.padEnd(27)} real ${JSON.stringify(v.real).padEnd(20)} generated ${JSON.stringify(v.generated)}`);
  }
  console.log('');
}

(async () => {
  if (flag('fetch-phishin')) await fetchPhishin();
  const E0 = buildEngine(TPL, IDX);
  loadPhishin(E0);
  const o = main();
  print(o);
  const j = opt('json', null);
  if (j) fs.writeFileSync(j, JSON.stringify(o, null, 1));
})();
