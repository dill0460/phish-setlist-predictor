#!/usr/bin/env node
// ---------------------------------------------------------------------------
// snapshot.js — the track record's only writer. Runs in the Action AFTER build.py:
//
//     python build.py
//     node snapshot.js
//     git commit index.html data/predictions_log.json ...
//
// Two jobs, both idempotent:
//   GRADE     any ungraded entry whose show now has real setlist data. A graded entry is
//             never touched again — that invariant is the whole point of the scoreboard.
//   SNAPSHOT  the next upcoming show that has no entry yet: commit the consensus official
//             call (500 seeded draws, default settings) plus the ranked top-20.
//
// It then patches the freshly built index.html in place so the page ships the same log
// that gets committed. Determinism: the PRNG is seeded from the show date, so re-running
// the Action on the same data cannot re-roll a committed call.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const { buildEngine } = require('./harness.js');
const { buildConsensus, hashSeed, enforceChains, completePairs } = require('./consensus.js');
const { gradeEntry } = require('./grade.js');

const HERE = __dirname;
const TPL = path.join(HERE, 'app_template.html');
const IDX = path.join(HERE, 'index.html');
const LOG = path.join(HERE, 'data', 'predictions_log.json');

const E = buildEngine(TPL, IDX);
const idx = fs.readFileSync(IDX, 'utf8');
const PLAYS = JSON.parse(idx.match(/id=['"]plays-data['"][^>]*>([\s\S]*?)<\/script>/)[1]);
const UPCOMING = (() => {
  const m = idx.match(/const UPCOMING = ([\s\S]*?);[ \t\r]*(?:\/\/[^\n]*)?\n/);   // \r: CRLF-safe
  return m ? JSON.parse(m[1]) : [];
})();

const byDate = new Map();   // date -> raw play rows; slot codes are needed to grade the opener
for (const p of PLAYS) { if (!byDate.has(p.date)) byDate.set(p.date, []); byDate.get(p.date).push(p); }

let log = { v: 1, entries: [] };
try { log = JSON.parse(fs.readFileSync(LOG, 'utf8')); } catch (e) { /* first run */ }
const have = new Set(log.entries.map(e => e.date));
let changed = false;

// ---- REPAIR ---------------------------------------------------------------
// Structure-only fix for committed-but-UNGRADED calls that violate the same-set bond
// invariant (consensus.js could split Mike's Groove across sets before 2026-08-01 — modal-set
// aggregation; observed live that night). The SONG LIST is untouched: the same ids, so the
// grade (hitOf counts flattened ids) and the opener call (s1[0] is never displaced) cannot
// change — this repairs an impossible structure, it does not re-roll a prediction. Graded
// entries are never touched, same as everywhere else.
{
  const idOfName = nm => { const x = E.SONGS.find(s2 => s2.name === nm); return x ? x.id : null; };
  for (const e of log.entries) {
    if (e.graded || e.skip || !e.official) continue;
    const beforeJson = JSON.stringify([e.official.s1, e.official.s2, e.official.e]);
    const arrs = [e.official.s1, e.official.s2, e.official.e];

    // v34: an anchor with no dependent (Mike's Song without Weekapaug, Tweezer without Reprise)
    // is a structurally impossible call too (96% / 78-85% real conditionals) and is the one
    // repair that changes the SONG LIST, so it is fenced hard:
    //   - never once the show has begun (data/live_setlist.json carries tonight's songs, or the
    //     date is already past): after the first song, editing a call is editing the answer key;
    //   - never when the dependent was already played earlier in the run;
    //   - the displaced song is the weakest by the entry's own committed top-20 (absent = weakest),
    //     never the set-1 opener (the graded call) nor a set's closer.
    // Reported loudly, every time, so the change is never silent.
    const nowMs = process.env.SNAPSHOT_NOW ? Date.parse(process.env.SNAPSHOT_NOW) : Date.now();   // override is for tests
    const todayMT = new Date(nowMs - 6 * 3600e3).toISOString().slice(0, 10);   // MST-ish; conservative
    let live = null; try { live = JSON.parse(fs.readFileSync(path.join(HERE, 'data', 'live_setlist.json'), 'utf8')); } catch (x) {}
    const started = e.date < todayMT || (live && live.date === e.date && (live.sids || []).length > 0);
    if (!started) {
      const top = e.top20 || [];
      const runMates = new Set();
      {
        const j0 = E.SHOWS.findIndex(s2 => s2.date === e.date);
        const isRun = (j) => E.SHOWS[j] && E.SHOWS[j].venue === e.venue;
        for (let j = (j0 >= 0 ? j0 : E.SHOWS.length) - 1; j >= 0 && isRun(j) &&
             (new Date(E.SHOWS[j + 1] ? E.SHOWS[j + 1].date : e.date) - new Date(E.SHOWS[j].date)) / 864e5 <= 3; j--)
          for (const p of (byDate.get(E.SHOWS[j].date) || [])) runMates.add(p.sid);
      }
      const added = completePairs(arrs, idOfName, {
        weak: id => { const k = top.indexOf(id); return k < 0 ? 0 : 21 - k; },
        protect: (id, arr) => (arr === arrs[0] && arr[0] === id) || arr[arr.length - 1] === id,
        blocked: id => runMates.has(id),
      });
      for (const a of added) console.log(`REPAIRED ${e.date}: committed call had ${a.anchor} without ${a.dep}; ${a.dep} seated (weakest unprotected song displaced)`);
    }
    enforceChains(arrs, idOfName);
    if (JSON.stringify(arrs) !== beforeJson) {
      changed = true;
      console.log(`repaired committed call for ${e.date}: ${JSON.stringify(arrs.map(a => a.length))} songs per set`);
    }
  }
}

// ---- GRADE ----------------------------------------------------------------
for (const e of log.entries) {
  if (e.graded || e.skip) continue;
  const rows = byDate.get(e.date);
  if (!rows || rows.length < 6) continue;      // setlist not posted yet (or partial stub)
  e.res = gradeEntry(e, rows);
  e.graded = true;
  changed = true;
  console.log(`graded ${e.date} ${e.venue}: official ${e.res.hitOf}/${e.res.nOf}, top20 ${e.res.hit20}, opener ${e.res.open}`);
}

// ---- SNAPSHOT --------------------------------------------------------------
// ONLY the immediate next show — never walk the announced schedule. Snapshotting a show
// weeks out would commit a call made on stale data (and the daily build would creep through
// the whole tour in advance). Each show gets its snapshot on the first build where it IS the
// next show — i.e. the morning after the previous one, matching what a visitor sees that day.
const next = UPCOMING.length && !have.has(UPCOMING[0].date) ? UPCOMING[0] : null;
if (next) {
  E.setSetting('nextDate', next.date);
  E.setSetting('runPos', next.runPos && next.runPos !== 'none' ? next.runPos : '');
  const con = buildConsensus(E, { draws: 500, seed: hashSeed(next.date) });
  // The build stamp moved out of the visible footer into an HTML comment (visitors never cared;
  // it stays in the source as the only reliable fresh-vs-cached check). Read the comment first,
  // keep the old footer form as a fallback so this script works against either template.
  const stampM = idx.match(/<!-- Build: ([^>]+?) -->/) || idx.match(/Build <code>([^<]+)<\/code>/);
  log.entries.push({
    date: next.date, venue: next.venue, city: next.city, runN: next.runN || '',
    graded: false, snapAt: stampM ? stampM[1] : 'unknown build',
    top20: con.top20.map(x => x.id), open5: con.open5,
    official: { s1: con.set1.map(x => x.id), s2: con.set2.map(x => x.id), e: con.encore.map(x => x.id) },
  });
  changed = true;
  console.log(`snapshotted ${next.date} ${next.venue} (official ${con.set1.length}+${con.set2.length}+${con.encore.length}, seed ${hashSeed(next.date)})`);
} else {
  console.log('no upcoming show without a committed entry');
}

// ---- WRITE -----------------------------------------------------------------
if (changed) {
  log.entries.sort((a, b) => a.date < b.date ? -1 : 1);
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.writeFileSync(LOG, JSON.stringify(log));
  // Patch the built page so it ships what was committed. Anchored to the const declaration;
  // fails loudly if the template shape changes rather than shipping a stale log.
  const re = /const PRED_LOG = [\s\S]*?;[ \t\r]*(?:\/\/[^\n]*)?\n/;   // \r: CRLF-safe
  if (!re.test(idx)) { console.error('FATAL: PRED_LOG declaration not found in index.html'); process.exit(1); }
  fs.writeFileSync(IDX, idx.replace(re, `const PRED_LOG = ${JSON.stringify(log)};\n`));
  console.log(`wrote ${LOG} (${log.entries.length} entries) and patched index.html`);
} else {
  console.log('nothing to do');
}
