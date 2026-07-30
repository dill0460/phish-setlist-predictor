// Shared grading rules, so the retroactive backfill and the live snapshot can never drift.
// Both read the same PLAYS payload out of a built index.html.
function openerOf(playRows) {            // slot code 0 = set-1 opener
  const r = playRows.find(p => p.sl.includes(0));
  return r ? r.sid : null;
}

// Nailed = the official call's set-1 opener was the real opener. Close = the real opener was
// among the five ranked opener candidates committed with it. Matches how the rest of the
// landscape reports an opener hit rate, so the numbers are comparable.
function gradeOpener(entry, realOpener) {
  if (realOpener == null) return null;
  const called = entry.official && entry.official.s1 && entry.official.s1[0];
  if (called === realOpener) return 'nailed';
  if ((entry.open5 || []).includes(realOpener)) return 'close';
  return 'miss';
}

function gradeEntry(entry, playRows) {
  const played = new Set(playRows.map(p => p.sid));
  const allOf = [...entry.official.s1, ...entry.official.s2, ...entry.official.e];
  return {
    played: played.size,
    hit20: entry.top20.filter(id => played.has(id)).length,
    hitOf: allOf.filter(id => played.has(id)).length,
    nOf: allOf.length,
    open: gradeOpener(entry, openerOf(playRows)),
    realOpen: openerOf(playRows),
  };
}
module.exports = { openerOf, gradeOpener, gradeEntry };
