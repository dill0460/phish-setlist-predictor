// ---------------------------------------------------------------------------
// The consensus "official" setlist.
//
// The agreed design (see claude/live-scoreboard-plan.md): NOT one random draw — a single
// spin is one plausible night, and grading one spin grades luck. NOT hand-tuned per show —
// a recipe that changes nightly makes the track record meaningless. Instead: run many draws
// of the real generator at default settings, count how often each song appears and where,
// and assemble the most consensual night under the same structure rules the generator obeys.
// The recipe is fixed here, once; every show gets the same treatment.
//
// Determinism: the caller seeds the engine's PRNG (harness.js) from the show date, so the
// same build inputs always commit the same official setlist — a re-run of the Action cannot
// silently re-roll the call.
// ---------------------------------------------------------------------------

function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function buildConsensus(E, opts = {}) {
  const draws = opts.draws || 500;
  if (opts.seed != null && E.setSeed) E.setSeed(opts.seed);

  // One compute() — the probability table doesn't change across draws, only the assembly
  // randomness does. (compute() itself samples n1/n2/ne, so counts are re-sampled per draw
  // below exactly the way the page does it.)
  const c = E.compute();
  const stat = new Map(); // sid -> counts
  const get = id => {
    if (!stat.has(id)) stat.set(id, { n: 0, s1: 0, s2: 0, e: 0, open1: 0, close1: 0, open2: 0, close2: 0, finale: 0 });
    return stat.get(id);
  };

  for (let i = 0; i < draws; i++) {
    const n1 = Math.max(6, E.sampleSetCount('s1', c.n1));
    const n2 = Math.max(4, E.sampleSetCount('s2', c.n2));
    const ne = Math.max(1, E.sampleSetCount('e', c.ne));
    const sl = E.buildSetlist(c.rows, n1, n2, ne);
    sl.set1.forEach((r, j) => { const t = get(r.id); t.n++; t.s1++; if (j === 0) t.open1++; if (j === sl.set1.length - 1) t.close1++; });
    sl.set2.forEach((r, j) => { const t = get(r.id); t.n++; t.s2++; if (j === 0) t.open2++; if (j === sl.set2.length - 1) t.close2++; });
    sl.encore.forEach((r, j) => { const t = get(r.id); t.n++; t.e++; if (j === sl.encore.length - 1) t.finale++; });
  }

  const rowById = new Map(c.rows.map(r => [r.id, r]));
  // Target counts: the medians of the mined distribution — the ranked-mode counts, because
  // the official call is a point estimate, not a sampled night. Read straight from
  // SET_COUNTS: c.n1/n2/ne are SAMPLED per compute() call in realistic mode, and using them
  // here made the official list size wander between 15 and 25 songs across shows.
  const med = (k, fb) => (E.SET_COUNTS && E.SET_COUNTS[k] && E.SET_COUNTS[k].med) || fb;
  const n1 = med('s1', 10), n2 = med('s2', 8), ne = med('e', 2);

  // Selection: rank by consensus appearance count; each song claims its modal set.
  const ranked = [...stat.entries()].sort((a, b) => b[1].n - a[1].n);
  const s1 = [], s2 = [], e = [];
  const inShow = new Set();
  for (const [id, t] of ranked) {
    if (inShow.has(id)) continue;
    const pref = t.e >= t.s1 && t.e >= t.s2 ? [e, s1, s2] : (t.s1 >= t.s2 ? [s1, s2, e] : [s2, s1, e]);
    const caps = new Map([[s1, n1], [s2, n2], [e, ne]]);
    for (const arr of pref) {
      if (arr.length < caps.get(arr)) { arr.push(id); inShow.add(id); break; }
    }
    if (s1.length >= n1 && s2.length >= n2 && e.length >= ne) break;
  }

  // Bond invariant on the final pick: a dependent whose anchor didn't make the consensus is
  // replaced by the next-ranked eligible song (same rule the generator enforces per night).
  const BONDS = [['Tweezer Reprise', 'Tweezer'], ['Weekapaug Groove', "Mike's Song"], ['Silent in the Morning', 'The Horse']];
  const nameOf = id => (rowById.get(id) || E.SONGS.find(s => s.id === id) || {}).name || String(id);
  const idOf = nm => { const s = E.SONGS.find(x => x.name === nm); return s ? s.id : null; };
  for (const [depNm, ancNm] of BONDS) {
    const dep = idOf(depNm), anc = idOf(ancNm);
    if (dep == null || anc == null || !inShow.has(dep) || inShow.has(anc)) continue;
    for (const arr of [s1, s2, e]) {
      const i = arr.indexOf(dep);
      if (i < 0) continue;
      const next = ranked.find(([id]) => !inShow.has(id) &&
        !BONDS.some(([d2]) => idOf(d2) === id));       // never swap in another dependent
      inShow.delete(dep);
      if (next) { arr[i] = next[0]; inShow.add(next[0]); } else arr.splice(i, 1);
    }
  }

  // Ordering inside each set: opener = the pick most often drawn as that set's opener,
  // closer likewise, middles by consensus count. Encore: the finale-est song lands last.
  const order = (arr, openKey, closeKey) => {
    if (arr.length < 2) return arr;
    const by = k => (x, y) => (stat.get(y)?.[k] || 0) - (stat.get(x)?.[k] || 0);
    const rest = arr.slice();
    rest.sort(by(openKey)); const opener = rest.shift();
    rest.sort(by(closeKey)); const closer = rest.pop();
    rest.sort((x, y) => (stat.get(y)?.n || 0) - (stat.get(x)?.n || 0));
    return [opener, ...rest, ...(closer != null ? [closer] : [])];
  };
  const s1o = order(s1, 'open1', 'close1');
  const s2o = order(s2, 'open2', 'close2');
  const eo = e.slice().sort((x, y) => (stat.get(x)?.finale || 0) - (stat.get(y)?.finale || 0)); // finale last

  const withNames = ids => ids.map(id => ({ id, name: nameOf(id), share: +((stat.get(id)?.n || 0) / draws).toFixed(3) }));
  // Ranked opener candidates, scored the same way the Fantasy picks score an opener:
  // P(played at all) x P(it's a set-1 opener when played). Committed so the opener call can
  // be graded the way the rest of the landscape grades it — nailed, or inside the top 5.
  const open5 = c.rows.filter(r => r.pred > 0.002 && !r.offTheme && !r.runRepeat)
    .slice().sort((a, b) => (b.pred * b.slotP[0]) - (a.pred * a.slotP[0])).slice(0, 5)
    .map(r => r.id);
  return {
    set1: withNames(s1o), set2: withNames(s2o), encore: withNames(eo),
    top20: c.rows.slice().sort((a, b) => b.pred - a.pred).slice(0, 20).map(r => ({ id: r.id, name: r.name, p: +r.pred.toFixed(4) })),
    open5, draws,
  };
}

module.exports = { buildConsensus, hashSeed };
