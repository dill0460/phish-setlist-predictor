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

// The canonical groupings, each with the placement rule the DATA supports — not a uniform
// "same set, contiguous", which was v29's overreach. Measured over the full corpus:
//   groove   Mike's/Hydrogen/Weekapaug — same set 98.4%. With Hydrogen: M>H>W contiguous
//            (94% / 100% adjacent). WITHOUT Hydrogen: one song sandwiched between M and W is
//            the near-universal shape (78.7%; direct M>W is 0.8% — 4 shows in 502).
//   chrono   Tweezer/Reprise — 69% land in DIFFERENT sets (Reprise: the encore, 195/205),
//            and the same-set minority is 91% non-adjacent. The ONLY real structure is
//            chronology: Reprise follows a Tweezer played earlier. Never force the set.
//   adjacent Horse/Silent — same set 100%, adjacent 100%.
const CHAINS = [
  { names: ["Mike's Song", 'I Am Hydrogen', 'Weekapaug Groove'], mode: 'groove' },
  { names: ['Tweezer', 'Tweezer Reprise'], mode: 'chrono' },
  { names: ['The Horse', 'Silent in the Morning'], mode: 'adjacent' },
];

// Enforce the chains on an assembled call, IN PLACE. `arrs` is [set1, set2, encore] as id
// arrays; `idOf` maps names to ids. Deterministic throughout (a re-run commits an identical
// call); count-neutral swaps take the last unbonded song — never index 0 of set 1, which is
// the graded opener; already-satisfied chains are left byte-identical.
function enforceChains(arrs, idOf) {
  const findArr = id => arrs.find(a => a.includes(id)) || null;
  const bonded = new Set(CHAINS.flatMap(c => c.names).map(idOf).filter(x => x != null));

  const moveToHome = (id, home) => {          // count-neutral cross-set move
    const cur = findArr(id);
    if (cur === home) return;
    const oldIdx = cur.indexOf(id);
    cur.splice(oldIdx, 1);
    let swap = -1;
    for (let i = home.length - 1; i >= 1; i--) if (!bonded.has(home[i])) { swap = i; break; }
    if (swap >= 0) { const [out] = home.splice(swap, 1); cur.splice(Math.min(oldIdx, cur.length), 0, out); }
    home.push(id);
  };
  const placeSeq = (home, anc, seq) => {      // chain contiguous at the anchor's position
    const others = home.filter(id => !seq.includes(id));
    let before = 0;
    for (const id of home) { if (id === anc) break; if (others.includes(id)) before++; }
    home.length = 0;
    home.push(...others.slice(0, before), ...seq, ...others.slice(before));
  };

  for (const { names, mode } of CHAINS) {
    const ids = names.map(idOf);
    const anc = ids[0];
    if (anc == null || !findArr(anc)) continue;
    const present = ids.filter(id => id != null && findArr(id));
    if (present.length < 2) continue;
    const home = findArr(anc);

    if (mode === 'chrono') {
      // Reprise only needs to come LATER in the show than Tweezer. If it does, hands off.
      const dep = present[1];
      const order = a => arrs.indexOf(a);
      const da = findArr(dep);
      const violated = order(da) < order(home) || (da === home && home.indexOf(dep) < home.indexOf(anc));
      if (!violated) continue;
      if (da === home) {                       // same set, wrong order: Reprise to the set's end
        home.splice(home.indexOf(dep), 1);
        home.push(dep);
      } else {                                 // earlier set: send it to its modal home, the
        const encore = arrs[2];                // encore, as the finale (count-neutral swap)
        da.splice(da.indexOf(dep), 1);
        let swap = -1;
        for (let i = encore.length - 1; i >= 0; i--) if (!bonded.has(encore[i])) { swap = i; break; }
        if (swap >= 0) { const [out] = encore.splice(swap, 1); da.push(out); }
        encore.push(dep);
      }
      continue;
    }

    // groove / adjacent: same set, canonical order.
    const satisfied = present.every(id => findArr(id) === home) &&
      present.every((id, k) => k === 0 || home.indexOf(id) > home.indexOf(present[k - 1]));
    const hyd = mode === 'groove' ? idOf(names[1]) : null;
    const hasHyd = hyd != null && findArr(hyd) != null;
    const mw = mode === 'groove' && !hasHyd;
    const gapOk = !mw || !satisfied ? false :
      home.indexOf(present[1]) - home.indexOf(present[0]) >= 2;   // sandwich already in place
    if (satisfied && (!mw || gapOk)) continue;

    for (const id of present) moveToHome(id, home);
    placeSeq(home, anc, present);

    // Mike's Groove without Hydrogen: slide one non-chain neighbour between M and W —
    // direct M>W is a 0.8% event and should not be what a committed call shows.
    if (mw && home.length >= 3) {
      const mi = home.indexOf(present[0]), wi = home.indexOf(present[1]);
      if (wi === mi + 1) {
        let si = -1;
        if (wi + 1 < home.length && !bonded.has(home[wi + 1])) si = wi + 1;
        else if (mi - 1 >= 1 && !bonded.has(home[mi - 1])) si = mi - 1;   // never the opener
        else if (mi - 1 === 0 && home !== arrs[0] && !bonded.has(home[0])) si = 0;
        if (si >= 0) {
          const [spacer] = home.splice(si, 1);
          home.splice(home.indexOf(present[1]), 0, spacer);
        }
      }
    }
  }
  return arrs;
}

// ---------------------------------------------------------------------------
// COMPLETE THE PAIRS: anchor present, dependent missing (v34).
//
// The bond check in buildConsensus only guarded ONE direction: a dependent whose anchor missed
// the cut gets replaced. It never guarded the other: an ANCHOR that makes the cut while its
// dependent loses its seat. That is the same marginals-destroy-joint-structure bug as v20 and
// v29, in the one direction nobody checked. Observed: the committed 2026-10-03 call opened set 2
// with Mike's Song and carried no Weekapaug Groove, although Weekapaug sat in the night's own
// top 20 (it simply lost its set-2 seat to higher-ranked songs, because seats are assigned song
// by song). The log shows the same orphan on 2024-07-31, 2025-06-20, 2025-07-20 and 2026-07-19.
// Tweezer without its Reprise (the AC N1 call) is the same defect.
//
// Real conditionals, so the modal call must carry the dependent: P(Weekapaug | Mike's) = 0.96,
// P(Silent | Horse) = 0.93, P(Reprise | Tweezer) = 0.78 in 2022+ (0.85 since 2009). All well over
// 0.5, i.e. a consensus that holds the anchor and not the dependent is the minority shape.
//
// The dependent takes the weakest unprotected, unbonded song's seat in the destination set (the
// anchor's own set; the encore for the Reprise), so set sizes hold. Skipped when the dependent is
// already in the call or is ruled out (played earlier in the run). Deterministic.
// `weak(id)`: lower = weaker. `protect(id, arr)`: true = never evict (opener / closer).
// ---------------------------------------------------------------------------
const PAIRS = [
  { anc: "Mike's Song", dep: 'Weekapaug Groove', dest: 'anchorSet', gap: 2 },   // one song sandwiched (78.7%)
  { anc: 'The Horse', dep: 'Silent in the Morning', dest: 'anchorSet', gap: 1 },  // back to back (100%)
  { anc: 'Tweezer', dep: 'Tweezer Reprise', dest: 'encore' },                     // finale
];
function completePairs(arrs, idOf, o = {}) {
  const added = [];
  const findArr = id => arrs.find(a => a.includes(id)) || null;
  const bonded = new Set([...CHAINS.flatMap(c => c.names), ...PAIRS.flatMap(p => [p.anc, p.dep])]
    .map(idOf).filter(x => x != null));
  for (const { anc, dep, dest, gap } of PAIRS) {
    const a = idOf(anc), d = idOf(dep);
    if (a == null || d == null || !findArr(a) || findArr(d)) continue;
    if (o.blocked && o.blocked(d)) continue;
    const home = dest === 'encore' ? arrs[2] : findArr(a);
    let victim = -1, vw = Infinity;
    for (let i = home.length - 1; i >= 0; i--) {       // ties go to the later seat
      const id = home[i];
      if (bonded.has(id) || (o.protect && o.protect(id, home))) continue;
      const w = o.weak ? o.weak(id) : 0;
      if (w < vw) { vw = w; victim = i; }
    }
    if (victim >= 0) home.splice(victim, 1);           // else: no safe seat to free, count +1
    if (dest === 'encore') home.push(d);
    else home.splice(Math.min(home.indexOf(a) + gap, home.length), 0, d);   // beside the anchor, real spacing
    added.push({ dep: dep, anchor: anc });
  }
  return added;
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
    if (!stat.has(id)) stat.set(id, { n: 0, s1: 0, s2: 0, e: 0, open1: 0, close1: 0, open2: 0, close2: 0, finale: 0,
                                      pos1: 0, posN1: 0, pos2: 0, posN2: 0 });
    return stat.get(id);
  };

  for (let i = 0; i < draws; i++) {
    const n1 = Math.max(6, E.sampleSetCount('s1', c.n1));
    const n2 = Math.max(4, E.sampleSetCount('s2', c.n2));
    const ne = Math.max(1, E.sampleSetCount('e', c.ne));
    const sl = E.buildSetlist(c.rows, n1, n2, ne);
    // A reentry copy (the return of a woven-in song) is the same performance, not a second
    // appearance: counting it gave a song two votes in one night, and in another set.
    sl.set1.forEach((r, j) => { if (r.reentry) return; const t = get(r.id); t.n++; t.s1++; if (j === 0) t.open1++; if (j === sl.set1.length - 1) t.close1++; });
    sl.set2.forEach((r, j) => { if (r.reentry) return; const t = get(r.id); t.n++; t.s2++; if (j === 0) t.open2++; if (j === sl.set2.length - 1) t.close2++; });
    // where each song sat among the middle slots (0 = after the opener, 1 = before the closer)
    for (const [arr, k] of [[sl.set1, '1'], [sl.set2, '2']]) {
      const mid = arr.slice(1, -1).filter(r => !r.reentry);
      mid.forEach((r, j) => { const t = get(r.id); t['pos' + k] += mid.length > 1 ? j / (mid.length - 1) : 0.5; t['posN' + k]++; });
    }
    sl.encore.forEach((r, j) => { if (r.reentry) return; const t = get(r.id); t.n++; t.e++; if (j === sl.encore.length - 1) t.finale++; });
  }

  const rowById = new Map(c.rows.map(r => [r.id, r]));
  // Target counts: the medians of the mined distribution — the ranked-mode counts, because
  // the official call is a point estimate, not a sampled night. Read straight from
  // SET_COUNTS: c.n1/n2/ne are SAMPLED per compute() call in realistic mode, and using them
  // here made the official list size wander between 15 and 25 songs across shows.
  const med = (k, fb) => (E.SET_COUNTS && E.SET_COUNTS[k] && E.SET_COUNTS[k].med) || fb;
  const n1 = med('s1', 10), n2 = med('s2', 8), ne = med('e', 2);

  // Selection: each set is filled from ITS OWN appearance ranking across the draws — a song
  // earns a set-1 seat by how often it actually appeared in set 1, not by global rank plus a
  // modal-set fallback. The old scheme let jam vehicles that missed a set-2 seat OVERFLOW
  // into set 1 (the committed 8/1 call carried Piper — 3% of its modern appearances are
  // set 1 — as a first-set song), displacing genuinely set-1-typical picks. Measured cost of
  // this scheme: ~0.28 expected song hits per show (~5%); bought: set-lean composition that
  // matches real shows (set 1 75% vs real 74%, set 2 31% vs 33%) instead of 69/34 with
  // overflow artifacts. The committed top-20 list remains the pure accuracy instrument —
  // this changes only which structured SETLIST is claimed. Scarce sets pick first (encore,
  // then set 2) so the big set never strip-mines their small candidate cohorts.
  const ranked = [...stat.entries()].sort((a, b) => b[1].n - a[1].n);
  const s1 = [], s2 = [], e = [];
  const inShow = new Set();
  {
    const sel = [[e, ne, 'e'], [s2, n2, 's2'], [s1, n1, 's1']];
    const modal = t => (t.e >= t.s1 && t.e >= t.s2) ? 'e' : (t.s1 >= t.s2 ? 's1' : 's2');
    for (const [arr, cap, key] of sel) {
      // Pass 1, MODAL-GUARDED: only songs whose modal location is this set. Without the
      // guard, scarce-first seating drafted 46 Days — the night's #1 song and a set-1
      // opener — into the encore purely because its encore count topped that (small)
      // ranking. A seat claim needs both: appeared here often, AND here is its home.
      for (const relax of [false, true]) {
        const byKey = [...stat.entries()]
          .filter(([id, t]) => !inShow.has(id) && t[key] > 0 && (relax || modal(t) === key))
          .sort((a, b) => b[1][key] - a[1][key] || b[1].n - a[1].n);
        for (const [id] of byKey) {
          if (arr.length >= cap) break;
          arr.push(id); inShow.add(id);
        }
        if (arr.length >= cap) break;
      }
      if (arr.length < cap) {                     // cohort fully dry (tiny pools): global rank
        for (const [id] of ranked) {
          if (arr.length >= cap) break;
          if (!inShow.has(id)) { arr.push(id); inShow.add(id); }
        }
      }
    }
  }

  // Bond invariant on the final pick: a dependent whose anchor didn't make the consensus is
  // replaced by the next-ranked eligible song (same rule the generator enforces per night).
  // I Am Hydrogen is a dependent too — it appears without Mike's Song in only ~3% of its
  // real outings, and it was previously unlisted here.
  const BONDS = [['Tweezer Reprise', 'Tweezer'], ['Weekapaug Groove', "Mike's Song"], ['Silent in the Morning', 'The Horse'], ['I Am Hydrogen', "Mike's Song"]];
  const nameOf = id => (rowById.get(id) || E.SONGS.find(s => s.id === id) || {}).name || String(id);
  const idOf = nm => { const s = E.SONGS.find(x => x.name === nm); return s ? s.id : null; };
  // v34: while a Tweezer sits unpaid earlier in the run, a Tweezer-less Reprise is the point,
  // not an orphan (RUN_DEBT_STATE is set by the compute() above).
  const owedDep = (E.RUN_DEBT_STATE && E.RUN_DEBT_STATE.owed) ? E.RUN_DEBT_STATE.depId : null;
  for (const [depNm, ancNm] of BONDS) {
    const dep = idOf(depNm), anc = idOf(ancNm);
    if (dep == null || anc == null || !inShow.has(dep) || inShow.has(anc)) continue;
    if (owedDep != null && dep === owedDep) continue;
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
  // Middles in running order: the average slot each song was drawn into across the draws (it used
  // to be the vote count, which put the most likely song second whatever its habit). A song never
  // drawn into this set's middle sits mid-set; ties fall back to the vote count.
  const order = (arr, openKey, closeKey, k) => {
    if (arr.length < 2) return arr;
    const by = key => (x, y) => (stat.get(y)?.[key] || 0) - (stat.get(x)?.[key] || 0);
    const rest = arr.slice();
    rest.sort(by(openKey)); const opener = rest.shift();
    rest.sort(by(closeKey)); const closer = rest.pop();
    const at = id => { const t = stat.get(id); return t && t['posN' + k] ? t['pos' + k] / t['posN' + k] : 0.5; };
    rest.sort((x, y) => (at(x) - at(y)) || ((stat.get(y)?.n || 0) - (stat.get(x)?.n || 0)));
    return [opener, ...rest, ...(closer != null ? [closer] : [])];
  };
  const s1o = order(s1, 'open1', 'close1', '1');
  const s2o = order(s2, 'open2', 'close2', '2');
  const eo = e.slice().sort((x, y) => (stat.get(x)?.finale || 0) - (stat.get(y)?.finale || 0)); // finale last

  // Anchor present, dependent missing: seat the dependent (see COMPLETE THE PAIRS above). Runs
  // AFTER ordering so the dependent lands at its real spacing from the anchor instead of wherever
  // the vote sort would put it, and so the opener / closer seats are known and protected.
  const pairsAdded = completePairs([s1o, s2o, eo], idOf, {
    weak: id => stat.get(id)?.n || 0,
    protect: (id, arr) => arr[arr.length - 1] === id || (arr !== eo && arr[0] === id),
    blocked: id => { const r = rowById.get(id); return !r || r.runRepeat || r.offTheme || r.pred <= 0.002; },
  });

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
    open5, draws, pairsAdded,
  };
}

module.exports = { buildConsensus, hashSeed, enforceChains, completePairs, CHAINS };
