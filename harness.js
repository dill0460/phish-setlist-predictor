// ---------------------------------------------------------------------------
// Test harness: loads the REAL generator out of app_template.html and runs it
// headlessly in Node against the REAL data out of a built index.html.
//
// Why not a Python reimplementation: the shipped generator is JavaScript. Testing
// a parallel Python copy of it proves nothing about what visitors actually get —
// the two can drift silently, and the bugs found in this project (uncapped song
// count, uncapped topUp, ceiling clumping) were all in the JS, not in any model.
//
// How it works: the template's script block is extracted and truncated just before
// render(), which is where DOM work begins. Everything above that is the engine —
// compute(), buildSetlist(), the samplers — and it runs fine with a stubbed `els`.
// The __*_JSON__ placeholders are filled from a real index.html, so these tests
// exercise the same tables the live site uses, not synthetic fixtures.
// ---------------------------------------------------------------------------
const fs = require('fs');

function extractJsonTables(indexHtml) {
  const out = {};
  // the three big payloads live in <script type="application/json"> tags
  for (const [ph, id] of [['__SHOWS_JSON__', 'shows-data'],
                          ['__SONGS_JSON__', 'songs-data'],
                          ['__PLAYS_JSON__', 'plays-data']]) {
    const m = indexHtml.match(new RegExp(`id=['"]${id}['"][^>]*>([\\s\\S]*?)</script>`));
    if (!m) throw new Error(`index.html is missing ${id}`);
    out[ph] = m[1].trim();
  }
  // everything else was substituted inline as `const NAME = <json>;`. Note the template
  // placeholder names and the resulting const names do NOT always match (__PAIRS_JSON__
  // becomes PAIR_RULES), so this mapping is explicit rather than derived.
  const inline = {
    __PAIRS_JSON__: 'PAIR_RULES', __COOL_JSON__: 'COOL_AFF', __REENTRY_JSON__: 'REENTRY',
    __SETCOUNTS_JSON__: 'SET_COUNTS', __LONGSONGS_JSON__: 'LONG_SONGS',
    __DATELOCK_JSON__: 'DATE_LOCKED', __RUNPOS_JSON__: 'RUN_POS',
    __SETAFF_JSON__: 'SET_AFF', __TOUROPEN_JSON__: 'TOUR_OPEN',
    __CLOSER_JSON__: 'CLOSER', __JAMRATE_JSON__: 'JAM_RATE',
    __BREATHERS_JSON__: 'BREATHERS', __UPCOMING_JSON__: 'UPCOMING',
    __SETMIN_JSON__: 'SET_MIN', __STATIC_CAL_JSON__: 'STATIC_CAL',
    __DAYHAZ_JSON__: 'DAY_HAZ',
    __PREDLOG_JSON__: 'PRED_LOG', __LIVE_JSON__: 'LIVE_SET',
    __SEGUES_JSON__: 'SEGUES',
  };
  // A table can legitimately be absent: index.html may predate a table the template
  // introduced. Substituting null lets the engine load anyway (the guarded code paths
  // handle it) and the missing names are reported so tests needing them SKIP loudly
  // rather than silently passing against absent data.
  out.__missing__ = [];
  for (const [ph, name] of Object.entries(inline)) {
    // The value ends at a `;` that is followed only by optional spaces and an optional
    // trailing line comment before the newline. Anchoring on a bare `;\n` is wrong:
    // several of these declarations carry an inline `// ...` note after the semicolon,
    // and a lazy match would then run on and swallow the next declaration whole.
    const tail = ';[ \\t]*(?://[^\\n]*)?\\n';
    let m = indexHtml.match(new RegExp(`const ${name} = new Set\\(([\\s\\S]*?)\\)${tail}`));
    if (m) { out[ph] = m[1]; continue; }
    m = indexHtml.match(new RegExp(`const ${name} = ([\\s\\S]*?)${tail}`));
    if (!m) { out[ph] = 'null'; out.__missing__.push(name); continue; }
    out[ph] = m[1];
  }
  return out;
}

function buildEngine(templatePath, indexPath) {
  const tpl = fs.readFileSync(templatePath, 'utf8');
  const idx = fs.readFileSync(indexPath, 'utf8');

  const blocks = [...tpl.matchAll(/<script(?![^>]*src=)(?![^>]*application\/json)[^>]*>([\s\S]*?)<\/script>/g)]
    .map(m => m[1]);
  let js = blocks.join('\n');

  // cut at render(): below that line the script manipulates the DOM
  const cut = js.indexOf('function render()');
  if (cut < 0) throw new Error('could not find render() — template layout changed');
  js = js.slice(0, cut);

  const tables = extractJsonTables(idx);
  const missing = tables.__missing__ || [];
  delete tables.__missing__;

  // SHOWS/SONGS/PLAYS are not inlined in the script — the page reads them out of
  // <script type="application/json"> tags in the HTML body. Those tags are not part of
  // the extracted JS, so the JSON.parse calls are rewritten to the literal data instead
  // of being fed a stubbed empty element.
  for (const [ph, id] of [['__SHOWS_JSON__', 'shows-data'],
                          ['__SONGS_JSON__', 'songs-data'],
                          ['__PLAYS_JSON__', 'plays-data']]) {
    js = js.split(`JSON.parse(document.getElementById('${id}').textContent)`)
           .join(tables[ph]);
  }

  for (const [ph, val] of Object.entries(tables)) js = js.split(ph).join(val);
  js = js.replace(/__SHOW_COUNT__|__SONG_COUNT__/g, '0').replace(/__BUILD_STAMP__/g, 'test');

  // The template declares `const els = {}` and populates it from the DOM. In Node there
  // is no DOM, so that block is removed and replaced by the proxy stub below. Anything
  // that only *writes* to els (default values, .max attributes) is harmless against the
  // proxy and is left in place.
  js = js.replace(/const \$ = id => document\.getElementById\(id\);/, '')
         .replace(/const els = \{\};[\s\S]*?\.forEach\(id => els\[id\] = \$\(id\)\);/, '');

  // the engine reads its settings off `els`; stub the 14 fields it actually touches
  //
  // Math is shadowed with a seeded PRNG. Every finding in this project is a RATE
  // ("14.5% of nights exceed the set-1 minute bound"), so an unseeded suite makes two
  // runs incomparable: a fix and a lucky seed look identical. mulberry32 is 4 lines and
  // exact; seed 1 is the default so a bare `node test_ui.js` is reproducible.
  const stub = `
    const Math = Object.create(globalThis.Math);
    let __seed = 1 >>> 0;
    Math.random = function () {
      __seed = (__seed + 0x6D2B79F5) >>> 0;
      let t = __seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    function setSeed(s) { __seed = s >>> 0; }
    const __vals = {
      yearsBack:'5', customStart:'', customEnd:'', refEnd:'', recency:'100',
      runPos:'', themeYear:'', nextDate:'', bustGap:'100', upcoming:'',
      gameType:'ptour', tourLen:'20', searchPredict:'', searchFreq:'',
    };
    const els = new Proxy({}, { get: (t, k) => ({
      get value() { return __vals[k] !== undefined ? __vals[k] : ''; },
      set value(v) { __vals[k] = v; },
      classList: { add(){}, remove(){}, contains(){ return false; } },
      addEventListener(){}, querySelectorAll(){ return []; }, textContent:'', style:{},
    })});
    const __el = () => ({ value:'', max:'', textContent:'', style:{}, disabled:false,
      classList:{add(){},remove(){},contains(){return false;}}, addEventListener(){},
      querySelectorAll(){return [];}, getAttribute(){return null;}, appendChild(){},
      setAttribute(){}, options:[], selectedIndex:0 });
    const $ = () => __el();
    const document = { getElementById: () => __el(), querySelectorAll: () => [],
                       addEventListener(){}, createElement: () => __el() };
    function setSetting(k, v) { __vals[k] = v; }
    function getSetting(k) { return __vals[k]; }
  `;

  const mod = new Function(stub + js + `
    ;return { compute, buildSetlist, setSetting, getSetting, setSeed,
              durOf, durMedian, sampleQuantiles, sampleSetCount, sampleLongFloor,
              setNightStretch, newNightLengths, enforceLongFloor, applyReentry,
              SET_COUNTS, LONG_SONGS, LONG_THRESH, REENTRY, REENTRY_BY_SID,
              SONGS, SHOWS, SET_BOUNDS, NIGHT_STRETCH_W,
              get slModeSample() { return slModeSample; },
              setSampleMode(v) { slModeSample = v; } };
  `);
  const api = mod();
  api.__missing__ = missing;
  return api;
}

module.exports = { buildEngine };
