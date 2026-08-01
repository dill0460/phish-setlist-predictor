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

// The canonical groupings that must share a set, in playing order. Same trios/pairs the
// generator enforces by name (v20): anchor first, dependents after it, all in one set.
const CHAINS = [
  ["Mike's Song", 'I Am Hydrogen', 'Weekapaug Groove'],
  ['Tweezer', 'Tweezer Reprise'],
  ['The Horse', 'Silent in the Morning'],
];

// Enforce the chains on an assembled call, IN PLACE. `arrs` is [set1, set2, encore] as id
// arrays; `idOf` maps a song name to its id (null if unknown). Rules, all deterministic:
//   - the ANCHOR's set is home; any chain member in a different set moves to home,
//     placed with the anchor in chain order (so an anchor that closes a set hands the
//     closer slot to its dependent — Mike's Song then Weekapaug closing is the real shape);
//   - each move is count-neutral where possible: the last unbonded non-opener song of the
//     home set is swapped into the vacated slot (consensus mids are sorted strongest-first,
//     so the last is the weakest — and taking it cannot displace the opener call, which is
//     graded on s1[0]);
//   - already-satisfied chains are left byte-identical (idempotent).
function enforceChains(arrs, idOf) {
  const findArr = id => arrs.find(a => a.includes(id)) || null;
  const chainIds = CHAINS.map(c => c.map(idOf));
  const bonded = new Set(chainIds.flat().filter(x => x != null));
  for (const ids of chainIds) {
    const anc = ids[0];
    if (anc == null) continue;
    const home = findArr(anc);
    if (!home) continue;
    const present = ids.filter(id => id != null && findArr(id));
    if (present.length < 2) continue;

    // 1. Move strays into the anchor's set, swapping the weakest resident out to keep sizes.
    for (const id of present) {
      const cur = findArr(id);
      if (cur === home) continue;
      const oldIdx = cur.indexOf(id);
      cur.splice(oldIdx, 1);
      let swap = -1;
      for (let i = home.length - 1; i >= 1; i--) {       // never take index 0: the opener call
        if (!bonded.has(home[i])) { swap = i; break; }
      }
      if (swap >= 0) {
        const [out] = home.splice(swap, 1);
        cur.splice(Math.min(oldIdx, cur.length), 0, out);
      }
      home.push(id);                                     // position fixed in step 2
    }

    // 2. Canonical order: the chain sits contiguously where the anchor sat, anchor first.
    const seq = ids.filter(id => id != null && home.includes(id));
    const others = home.filter(id => !seq.includes(id));
    let before = 0;
    for (const id of home) { if (id === anc) break; if (others.includes(id)) before++; }
    home.length = 0;
    home.push(...others.slice(0, before), ...seq, ...others.slice(before));
  }
  return arrs;
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
  // I Am Hydrogen is a dependent too — it appears without Mike's Song in only ~3% of its
  // real outings, and it was previously unlisted here.
  const BONDS = [['Tweezer Reprise', 'Tweezer'], ['Weekapaug Groove', "Mike's Song"], ['Silent in the Morning', 'The Horse'], ['I Am Hydrogen', "Mike's Song"]];
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

  // SAME-SET + ORDERING invariant on the assembled call — the aggregation counterpart of the
  // generator's v20 makeRoom fix, which this assembler never got. Selection above gives each
  // song its MODAL set independently, and marginal votes can split a pair even though every
  // underlying draw kept it together: observed live on 2026-08-01, Weekapaug Groove closing
  // set 1 while Mike's Song closed set 2 — a structure with zero real precedent (same set
  // 98.4%, anchor first ~100%). Anchor's set wins; chain members move in beside it in
  // canonical order; every move swaps the weakest unbonded song back the other way so the
  // set sizes hold. Deterministic — no randomness — so a re-run still commits an identical call.
  enforceChains([s1o, s2o, eo], idOf);

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

module.exports = { buildConsensus, hashSeed, enforceChains, CHAINS };
