#!/usr/bin/env node
// ---------------------------------------------------------------------------
// live.js — the show-night poller. Runs every 10 minutes during a show window:
//
//     node live.js
//
// One job: fetch TONIGHT'S setlist as it is being posted and write the song ids to
// data/live_setlist.json, then patch the already-built index.html in place so the Track
// Record tab can tick off the official call in near-real time.
//
// WHAT THIS DOES NOT DO, and why it matters more than what it does:
//
//   * It does not run build.py. Nothing is re-mined, nothing is re-calibrated, no probability
//     changes. A full build during a show would drag the in-progress setlist toward the stats
//     window, which is the v16 double-suppression bug (gap 0.445x AND run-repeat 0.02x on every
//     song already played, scoring the songs that actually hit at ~zero).
//   * It does not run snapshot.js. The official call is committed once, before the show, and is
//     never re-rolled — that invariant is the whole point of the scoreboard. Re-snapshotting
//     mid-show would be grading a prediction made with partial knowledge of the answer.
//   * It does not grade. Grading happens on the next morning build, off the finished setlist,
//     exactly as before.
//
// So the only state this touches is data/live_setlist.json and the LIVE_SET const in
// index.html. If this script never runs, or fails, the site is exactly what it was.
//
// COST: one API call per poll, not the ~44 a full build makes (build.py walks every year from
// 1983). At 10-minute intervals over a 7-hour window that is ~42 calls a night, which is what
// makes the schedule viable at all.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const IDX = path.join(HERE, 'index.html');
const OUT = path.join(HERE, 'data', 'live_setlist.json');
const KEY = (process.env.PHISHNET_API_KEY || '').trim();
const UA = { 'User-Agent': 'phish-setlist-predictor (github.com/dill0460)' };

// Mountain time, the same convention build.py stamps and cuts on: a show on calendar date D
// anywhere in North America starts and ends inside date D in Mountain time.
function todayMT() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}
function stampMT() {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Denver', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(new Date());
}

async function getJson(url, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: UA });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      last = e;
      if (i < tries - 1) await new Promise(s => setTimeout(s, 2000 * (i + 1)));
    }
  }
  throw last;
}

// Two routes, deliberately. The by-date endpoint is tiny and is what we want; the by-year
// endpoint is the one this project has PROVEN works (it is what build.py fetches) and is the
// fallback if the by-date shape ever differs. Falling back costs a bigger payload, not
// correctness — better than a silent empty result on show night.
async function fetchTonight(date) {
  const year = date.slice(0, 4);
  const routes = [
    `https://api.phish.net/v5/setlists/showdate/${date}.json?apikey=${KEY}`,
    `https://api.phish.net/v5/setlists/showyear/${year}.json?apikey=${KEY}`,
  ];
  for (const url of routes) {
    let payload;
    try { payload = await getJson(url, 2); } catch (e) { console.log(`  route failed (${e.message})`); continue; }
    const rows = (payload && payload.data) || [];
    // artistid 1 only — the v5 setlist endpoints also carry Trey Anastasio Band, Mike Gordon
    // and friends, and a side-project gig on the same date would otherwise tick off songs
    // Phish never played tonight.
    const mine = rows.filter(r => (r.showdate || '') === date &&
      (String(r.artistid ?? '1') === '1' || String(r.artist_slug || '').toLowerCase() === 'phish'));
    if (mine.length) return mine;
  }
  return [];
}

(async () => {
  if (!KEY) { console.error('PHISHNET_API_KEY is not set — nothing to poll.'); process.exit(0); }
  const date = todayMT();

  let rows = [];
  try { rows = await fetchTonight(date); }
  catch (e) { console.error(`fetch failed (${e.message}) — leaving the existing live file alone.`); process.exit(0); }

  if (!rows.length) {
    // No show tonight, or the first song has not been posted yet. Either way there is nothing
    // to show. Only rewrite the file if it is currently claiming a DIFFERENT date, so a quiet
    // night clears yesterday's leftovers exactly once instead of churning a commit every poll.
    let prev = null;
    try { prev = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) { /* none yet */ }
    if (prev && prev.date && prev.date !== date && (prev.sids || []).length) {
      fs.mkdirSync(path.dirname(OUT), { recursive: true });
      fs.writeFileSync(OUT, JSON.stringify({ date: null, sids: [], updated: '' }));
      console.log(`cleared stale live file (was ${prev.date})`);
      process.exit(0);
    }
    console.log(`no Phish setlist posted for ${date} yet — nothing to do`);
    process.exit(0);
  }

  // Distinct song ids in performance order. Order matters for readability; a song played twice
  // (Tweezerfest and friends) counts once, matching how the call is graded.
  const seen = new Set();
  const sids = rows
    .slice()
    .sort((a, b) => (String(a.set)).localeCompare(String(b.set)) || (a.position - b.position))
    .map(r => r.songid)
    .filter(id => id != null && !seen.has(id) && seen.add(id));

  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) { /* none yet */ }
  const same = prev && prev.date === date && (prev.sids || []).join(',') === sids.join(',');
  if (same) { console.log(`no change (${sids.length} songs) — skipping write so the Action commits nothing`); process.exit(0); }

  const payload = { date, sids, updated: stampMT() };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload));

  // Patch the built page. Anchored to the const declaration and FAILS LOUDLY rather than
  // shipping a page whose LIVE_SET silently never updates — the same contract snapshot.js uses
  // for PRED_LOG.
  let idx;
  try { idx = fs.readFileSync(IDX, 'utf8'); }
  catch (e) { console.error(`index.html not readable (${e.message}) — wrote ${OUT}, page not patched.`); process.exit(1); }
  const re = /const LIVE_SET = [\s\S]*?;[ \t]*(?:\/\/[^\n]*)?\n/;
  if (!re.test(idx)) { console.error('FATAL: LIVE_SET declaration not found in index.html — is the template current?'); process.exit(1); }
  fs.writeFileSync(IDX, idx.replace(re, `const LIVE_SET = ${JSON.stringify(payload)};\n`));

  console.log(`live ${date}: ${sids.length} songs so far (updated ${payload.updated}) — wrote ${OUT} and patched index.html`);
})();
