#!/usr/bin/env python3
"""
Build the Phish Setlist Predictor.

Fetches setlist history from the phish.net API and song durations from phish.in,
computes every derived table the app needs, and writes a single self-contained
index.html.

Usage:
    PHISHNET_API_KEY=xxxx python build.py

Run it again any time to refresh with the latest shows; it is fully idempotent.
"""

import json
import math
import os
import sys
import time
import bisect
import statistics
from collections import defaultdict, Counter
from datetime import date
from urllib.request import urlopen, Request
from urllib.error import HTTPError, URLError

# Stage business phish.net files alongside real songs. These are not predictable
# and should never appear in a setlist. "Big Ball Jam" and "Crowd Control" are
# genuine songs despite their names, so they stay in.
NON_SONGS = {
    "Jam", "Banter", "Soundcheck", "Intro", "Rhombus Narration",
    "Secret Language Instructions", "Digital Delay Loop Jam", "Mind Left Body Jam",
    "Rotation Jam", "Costume Contest", "Piano Boogie Woogie Jam", "Flatbed Truck Jam",
    "Merry Pranksters Jam", "Art Jam", "Ambient Jam", "Tower Jam", "Storage Jam",
    "Drive-In Jam", "Woodlands Jam",
}

HERE = os.path.dirname(os.path.abspath(__file__))
TEMPLATE = os.path.join(HERE, "app_template.html")
OUTPUT = os.path.join(HERE, "index.html")
CACHE = os.path.join(HERE, "data")


def assign_run_positions(shows):
    """Tag each show (dict with 'date' and 'venue', chronologically sorted) with its real
    position in a multi-night run: same venue, gaps of <= 3 days. Used for BOTH the historical
    show list and the upcoming schedule, so run position is a known fact — never a guess —
    for any show we actually have a date and venue for."""
    if not shows:
        return shows
    to_d = lambda s: date(*map(int, s.split("-")))
    runs, cur = [], [shows[0]]
    for prev, s in zip(shows, shows[1:]):
        if s["venue"] == prev["venue"] and (to_d(s["date"]) - to_d(prev["date"])).days <= 3:
            cur.append(s)
        else:
            runs.append(cur)
            cur = [s]
    runs.append(cur)
    for run in runs:
        for i, s in enumerate(run):
            s["runN"] = f"night {i + 1} of {len(run)}" if len(run) > 1 else "single night"
            if len(run) < 3:
                s["runPos"] = "none"
            elif i == 0:
                s["runPos"] = "open"
            elif i == len(run) - 1:
                s["runPos"] = "close"
            else:
                s["runPos"] = "middle"
    return shows

# Date ranges kept OUT of the calibration fit. Deliberately EMPTY.
#
# An earlier version excluded three whole 2026 tour names ("2026 Summer Tour", "2026 Sphere",
# "2026 Mexico") as "themed runs" — which was never principled (2024 Mexico, 2025 Mexico and
# 2024 Sphere were all kept) and discarded every 2026 show but one, leaving the calibration
# anchored on six-month-stale data. Narrowing it to just the 90s-themed MSG run was then
# measured and found to move the calibration by at most 1.5 points on a single mid-tier song.
# Not worth having: themed nights are part of what the band does, they wash out over a 120-show
# window, and discarding inconvenient data is exactly what a sceptical reader should distrust.
# The hook stays for a genuinely unusable stretch (a benefit show with a guest band, say).
EXCLUDED_RANGES = []


def in_excluded_range(d):
    return any(lo <= d <= hi for lo, hi in EXCLUDED_RANGES)


PHISHNET_KEY = os.environ.get("PHISHNET_API_KEY", "").strip()
FIRST_YEAR = 1983
UA = {"User-Agent": "phish-setlist-predictor (github.com/dill0460)"}


def get_json(url, tries=3):
    for attempt in range(tries):
        try:
            with urlopen(Request(url, headers=UA), timeout=60) as r:
                return json.loads(r.read().decode("utf-8"))
        except (HTTPError, URLError) as e:
            if attempt == tries - 1:
                raise
            time.sleep(2 * (attempt + 1))
    return None


# ----------------------------------------------------------------------------
# 1. Fetch setlists
# ----------------------------------------------------------------------------
def fetch_setlists():
    if not PHISHNET_KEY:
        sys.exit("PHISHNET_API_KEY is not set. Get a key at https://phish.net/api/keys")
    rows = []
    this_year = date.today().year
    for year in range(FIRST_YEAR, this_year + 1):
        url = f"https://api.phish.net/v5/setlists/showyear/{year}.json?apikey={PHISHNET_KEY}"
        try:
            payload = get_json(url)
        except Exception as e:
            print(f"  ! {year}: {e}", file=sys.stderr)
            continue
        data = (payload or {}).get("data") or []
        rows.extend(data)
        print(f"  {year}: {len(data)} rows")
    if not rows:
        sys.exit("No setlist rows fetched — check the API key and network access.")
    return phish_only(rows)


def phish_only(rows):
    """The v5 setlists endpoints can return side-project setlists (Trey Anastasio Band,
    Mike Gordon, ...) alongside Phish — which silently doubles the show count and floods
    the model with songs Phish has never played. Keep artistid 1 only. Defensive: if no
    artist field exists on the rows, keep everything rather than nuking the dataset."""
    if not any(("artistid" in r) or ("artist_slug" in r) for r in rows[:200]):
        print("  ! no artist field on setlist rows — skipping artist filter", file=sys.stderr)
        return rows
    out = [r for r in rows
           if str(r.get("artistid", "")) == "1"
           or str(r.get("artist_slug", "")).lower() == "phish"
           or ("artistid" not in r and "artist_slug" not in r)]
    dropped = len(rows) - len(out)
    print(f"  artist filter: kept {len(out)} Phish rows, dropped {dropped} side-project rows")
    if not out:
        sys.exit("Artist filter removed everything — the API's artist fields changed shape; aborting rather than building an empty site.")
    return out


def fetch_upcoming(recent_shows=None):
    """Scheduled shows, so the app can offer them directly. Primary route is the shows-by-year
    endpoint — the same family the setlist fetch uses and known to work — with the old
    query-param endpoints kept as fallbacks (they have been flaky across API versions and were
    returning nothing, which left the site claiming no shows were announced). Filtered to
    Phish (artistid 1): the phish.net schedule also carries side-project gigs (Mike Gordon,
    Bob Wagner & Friends, ...) that must not enter the picker."""
    today = date.today().isoformat()
    this_year = date.today().year
    raw = []
    for year in (this_year, this_year + 1):
        url = f"https://api.phish.net/v5/shows/showyear/{year}.json?apikey={PHISHNET_KEY}&order_by=showdate"
        try:
            payload = get_json(url, tries=2)
        except Exception:
            continue
        raw.extend((payload or {}).get("data") or [])
    if not any((r.get("showdate") or "") >= today for r in raw):
        for url in [
            f"https://api.phish.net/v5/shows/showdate_gt/{today}.json?apikey={PHISHNET_KEY}&order_by=showdate",
            f"https://api.phish.net/v5/shows.json?apikey={PHISHNET_KEY}&showdate_gt={today}&order_by=showdate",
        ]:
            try:
                payload = get_json(url, tries=2)
            except Exception:
                continue
            raw.extend((payload or {}).get("data") or [])
    # >= today, not > : on show day the show people most want predicted is TONIGHT'S, and a
    # strict comparison made it vanish from the picker at midnight.
    rows = [r for r in raw
            if (r.get("showdate") or "") >= today
            and str(r.get("artistid", 1)) == "1"
            and not str(r.get("exclude", 0)) == "1"]
    if not rows:
        print("  no upcoming shows found (fine — the picker just stays hidden)")
        return []
    seen, out = set(), []
    for r in sorted(rows, key=lambda x: x["showdate"]):
        d = r["showdate"]
        if d in seen:
            continue
        seen.add(d)
        out.append({"date": d, "venue": r.get("venue") or "", "city": r.get("city") or "",
                    "state": r.get("state") or r.get("country") or ""})
    # Prepend the tail of real history so a run already underway (night 1 already happened)
    # is recognized as continuing rather than mistaken for a fresh opening night.
    context = [{"date": s["date"], "venue": s["venue"]} for s in (recent_shows or [])[-6:]]
    combined = context + out
    assign_run_positions(combined)
    out = combined[len(context):]
    print(f"  {len(out)} upcoming shows through {out[-1]['date']}")
    return out[:40]


def fetch_durations():
    """Median song length (minutes) from phish.in, modern era only. Optional."""
    agg = defaultdict(list)
    page = 1
    while page <= 60:
        url = f"https://phish.in/api/v2/tracks?per_page=500&page={page}&sort=date:desc"
        try:
            payload = get_json(url, tries=2)
        except Exception as e:
            print(f"  ! durations page {page}: {e}", file=sys.stderr)
            break
        tracks = (payload or {}).get("tracks") or []
        if not tracks:
            break
        stop = False
        for t in tracks:
            if not t.get("duration") or not t.get("show_date"):
                continue
            if t["show_date"] < "2009-01-01":
                stop = True
                break
            for s in t.get("songs") or []:
                agg[s["title"]].append(t["duration"])
        page += 1
        if stop:
            break
    out = {}
    for title, ds in agg.items():
        if len(ds) < 3:
            continue
        ds.sort()
        mins = [d / 60000.0 for d in ds]

        def q(p):
            """Linear-interpolated quantile."""
            if len(mins) == 1:
                return mins[0]
            i = p * (len(mins) - 1)
            lo = int(i)
            hi = min(lo + 1, len(mins) - 1)
            return mins[lo] + (i - lo) * (mins[hi] - mins[lo])

        med = q(0.5)
        # Five-point summary drives per-night length sampling in the set builder.
        # Songs with too few observations get a flat (degenerate) distribution so
        # they behave exactly like the old fixed-median code path.
        if len(mins) >= 8:
            quants = [round(q(p), 1) for p in (0.10, 0.25, 0.50, 0.75, 0.90)]
        else:
            quants = [round(med, 1)] * 5
        out[title] = {
            "med": round(med, 1),
            "q": quants,
            "n": len(mins),
        }
    print(f"  durations for {len(out)} songs")
    return out


# ----------------------------------------------------------------------------
# 2. Shape the data
# ----------------------------------------------------------------------------
# Slot codes: 0 S1 open, 1 S1 song, 2 S1 close, 3 S2 open, 4 S2 song, 5 S2 close, 6 encore
def classify_show(entries):
    by_set = defaultdict(list)
    for e in entries:
        by_set[e["set"]].append(e)
    song_slots = defaultdict(set)
    n1 = n2 = ne = 0
    for setname, es in by_set.items():
        es.sort(key=lambda x: x["position"])
        distinct = {x["songid"] for x in es}
        if setname == "1":
            base, n1 = 0, len(distinct)
        elif setname in ("2", "3", "4"):
            base = 3
            n2 += len(distinct) if setname == "2" else 0
        else:
            base, ne = 6, ne + len(distinct)
        if base == 6:
            for x in es:
                song_slots[x["songid"]].add(6)
            continue
        for x in es:
            song_slots[x["songid"]].add(base + 1)
        first, last = es[0]["songid"], es[-1]["songid"]
        song_slots[first].discard(base + 1)
        song_slots[first].add(base)
        if len(es) > 1:
            song_slots[last].discard(base + 1)
            song_slots[last].add(base + 2)
    return song_slots, n1, n2, ne


def shape(raw, durations):
    shows, by_show = {}, defaultdict(list)
    for r in raw:
        sid = r["showid"]
        by_show[sid].append(r)
        if sid not in shows:
            shows[sid] = {
                "id": sid, "date": r["showdate"], "tour": r["tourname"], "tourid": r["tourid"],
                "venue": r["venue"], "city": r["city"], "state": r["state"] or r["country"],
            }
    shows_list = sorted(shows.values(), key=lambda x: x["date"])

    songs, plays = {}, []
    for s in shows_list:
        slots, n1, n2, ne = classify_show(by_show[s["id"]])
        s["n1"], s["n2"], s["ne"] = n1, n2, ne
        for songid, sl in slots.items():
            plays.append({"sid": songid, "date": s["date"], "sl": sorted(sl)})
    for r in raw:
        sid = r["songid"]
        if sid not in songs:
            songs[sid] = {"id": sid, "name": r["song"], "debut": r["showdate"], "last": r["showdate"], "shows": 0}
        songs[sid]["debut"] = min(songs[sid]["debut"], r["showdate"])
        songs[sid]["last"] = max(songs[sid]["last"], r["showdate"])
    # drop stage business before anything downstream sees it
    songs = {k: v for k, v in songs.items() if v["name"] not in NON_SONGS}
    plays = [p for p in plays if p["sid"] in songs]
    seen = defaultdict(set)
    for p in plays:
        seen[p["sid"]].add(p["date"])
    originals = {}
    for r in raw:
        if r.get("is_original") is not None:
            originals[r["songid"]] = r["is_original"]
    for sid, s in songs.items():
        if originals.get(sid) == 0:
            s["cover"] = 1          # phish.net's "not a Phish original" flag
    originals = {}
    for r in raw:
        if r.get("is_original") is not None:
            originals[r["songid"]] = r["is_original"]
    dnorm = {k.lower(): v for k, v in durations.items()}
    for sid, s in songs.items():
        if originals.get(sid) == 0:
            s["cover"] = 1          # phish.net's "not a Phish original" flag
        s["shows"] = len(seen[sid])
        d = dnorm.get(s["name"].lower())
        if d is not None:
            # `dur` stays a scalar median: the odds table displays it and cool-down
            # affinity keys off it. `durq` carries the distribution for the set builder.
            s["dur"] = d["med"]
            if d["q"][0] != d["q"][4]:
                s["durq"] = d["q"]
    for s in shows_list:
        s.pop("tourid", None)
    return shows_list, list(songs.values()), plays


# ----------------------------------------------------------------------------
# 3. Derived tables
# ----------------------------------------------------------------------------
def mine_pairs(raw):
    """Song pairings that hold up across history, with their placement pattern."""
    show_songs = defaultdict(dict)
    names = {}
    for r in raw:
        names[r["songid"]] = r["song"]
        d, sid = r["showdate"], r["songid"]
        if sid not in show_songs[d] or r["position"] < show_songs[d][sid][1]:
            show_songs[d][sid] = (r["set"], r["position"])
    n_with = defaultdict(int)
    ordered = defaultdict(lambda: [0, 0, 0])
    co = defaultdict(int)
    for d, here in show_songs.items():
        for sid in here:
            n_with[sid] += 1
        items = sorted(here.items(), key=lambda kv: kv[1][1])
        for i in range(len(items)):
            for j in range(i + 1, len(items)):
                a, (sa, pa) = items[i]
                b, (sb, pb) = items[j]
                ordered[(a, b)][0] += 1
                if sa == sb:
                    ordered[(a, b)][1] += 1
                    if pb - pa == 1:
                        ordered[(a, b)][2] += 1
                co[frozenset((a, b))] += 1
    rules = []
    for key, nAB in co.items():
        if nAB < 20:
            continue
        a, b = tuple(key)
        if ordered.get((b, a), [0])[0] > ordered.get((a, b), [0])[0]:
            a, b = b, a
        o = ordered[(a, b)]
        if o[0] / nAB < 0.8:
            continue
        pBA, pAB = nAB / n_with[a], nAB / n_with[b]
        if max(pBA, pAB) < 0.65:
            continue
        same, adj = o[1] / o[0], o[2] / o[0]
        rules.append({
            "a": a, "b": b, "an": names[a], "bn": names[b],
            "pBA": round(pBA, 2), "pAB": round(pAB, 2), "n": nAB,
            "place": "adj" if adj >= 0.7 else ("sameset" if same >= 0.7 else "free"),
        })
    rules.sort(key=lambda r: -r["n"])
    print(f"  {len(rules)} pair rules")
    return rules


def build_stamp(template_text):
    """UTC timestamp + a short hash of the template source.

    Without this there is no way to tell a freshly deployed index.html from a
    CDN-cached one: the template filename never changes, so a stale page looks
    identical to a current one. The hash covers template-only edits, which would
    not move a timestamp on their own if the data fetch were skipped.
    """
    import hashlib
    h = hashlib.sha256(template_text.encode("utf-8")).hexdigest()[:8]
    return time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime()) + " · " + h


def mine_setcounts(raw):
    """Empirical distribution of distinct songs per set (2009+).

    The generator previously targeted the MEDIAN of the last 50 shows — a fixed
    10/8/2 with no variance — and then ignored it anyway, filling each set to a
    minute budget instead. With a short-song pool (a 1996-themed night) that
    produced 15-song first sets, which sit at the 98th percentile of reality.
    Sampling from this table instead gives the real spread, including the short
    jam-heavy second sets the old code could never generate.
    """
    shows = defaultdict(lambda: defaultdict(set))
    for r in raw:
        if r["showdate"] < "2009-01-01":
            continue
        st = r["set"]
        key = "e" if st in ("e", "E") else ("s%s" % st if st in ("1", "2") else None)
        if key:
            shows[r["showdate"]][key].add(r["songid"])

    out = {}
    for key in ("s1", "s2", "e"):
        c = Counter()
        for d, sets in shows.items():
            n = len(sets.get(key, ()))
            if n:
                c[n] += 1
        tot = sum(c.values()) or 1
        # cumulative CDF as [count, cumulative_probability] pairs
        cdf, acc = [], 0.0
        for n in sorted(c):
            acc += c[n] / tot
            cdf.append([n, round(acc, 5)])
        med = sorted(c.elements())[tot // 2] if tot else 0
        out[key] = {"cdf": cdf, "med": med, "n": tot}
        print(f"  {key}: median {med}, {len(cdf)} distinct counts, n={tot}")
    return out


def mine_reentry(raw):
    """Songs that appear more than once in a single night, and where the repeat lands.

    Measured 2009+: ~22% of shows contain a reentrant song, but the behaviour is
    confined to a short list (Tweezer, Hold Your Head Up, Alumni Blues, TMWSIY,
    Down with Disease ...) and the placement is overwhelmingly a same-set sandwich
    2-4 slots after the first pass, not a free-floating second appearance.
    """
    shows = defaultdict(list)
    for r in raw:
        if r["showdate"] < "2009-01-01":
            continue
        shows[r["showdate"]].append(r)

    n_shows = len(shows)
    appears = Counter()      # shows the song appeared in at all
    reenters = Counter()     # shows the song reentered in
    place = defaultdict(Counter)
    sid_of = {}

    for d, rs in shows.items():
        rs = sorted(rs, key=lambda r: int(r["position"]))
        idx = defaultdict(list)
        for i, r in enumerate(rs):
            idx[r["song"]].append((i, r["set"]))
            sid_of[r["song"]] = r["songid"]
        for nm, occ in idx.items():
            appears[nm] += 1
            if len(occ) < 2:
                continue
            reenters[nm] += 1
            for a, b in zip(occ, occ[1:]):
                gap = b[0] - a[0]
                same = a[1] == b[1]
                if gap == 1:
                    k = "adj"
                elif same and gap <= 4:
                    k = "sandwich"
                elif same:
                    k = "far"
                else:
                    k = "crossset"
                place[nm][k] += 1

    out = []
    for nm, n in reenters.items():
        if n < 2:                      # need a repeated habit, not a one-off
            continue
        tot = sum(place[nm].values())
        out.append({
            "sid": sid_of.get(nm),
            "name": nm,
            # P(reenters | played) — the rate the set builder rolls against
            "rate": round(n / max(1, appears[nm]), 3),
            "n": n,
            "place": {k: round(v / tot, 3) for k, v in place[nm].items()},
        })
    out.sort(key=lambda r: -r["n"])
    print(f"  {len(out)} reentrant songs ({sum(r['n'] for r in out)} events / {n_shows} shows)")
    return out


def mine_cool_affinity(raw, durations):
    """How much more often a song follows a 10+ min jam in a set-2 mid slot."""
    # durations values are now {"med","q","n"} dicts; this pass only needs the median
    dnorm = {k.lower(): v["med"] for k, v in durations.items()}
    dur = lambda n: dnorm.get(n.lower())
    seqs = defaultdict(list)
    for r in raw:
        if r["showdate"] < "2009-01-01" or r["set"] != "2":
            continue
        seqs[r["showdate"]].append((r["position"], r["song"], r["songid"]))
    after, total, sid_of = defaultdict(int), defaultdict(int), {}
    n_after = n_mid = 0
    for d, items in seqs.items():
        items.sort()
        for i in range(1, len(items) - 1):
            _, nm, sid = items[i]
            sid_of[nm] = sid
            total[nm] += 1
            n_mid += 1
            pd = dur(items[i - 1][1])
            if pd is not None and pd >= 10:
                after[nm] += 1
                n_after += 1
    if not n_mid:
        return {}
    base = n_after / n_mid
    alpha = 6
    out = {}
    for nm, t in total.items():
        if t < 6:
            continue
        out[str(sid_of[nm])] = round(((after[nm] + alpha * base) / (t + alpha)) / base, 3)
    print(f"  cool-down affinity for {len(out)} songs (base rate {base:.1%})")
    return out


def mine_date_locked(raw):
    """Songs essentially only ever played on one calendar date (e.g. Auld Lang Syne)."""
    by_song, names = defaultdict(set), {}
    for r in raw:
        names[r["songid"]] = r["song"]
        by_song[r["songid"]].add(r["showdate"])
    out = {}
    for sid, ds in by_song.items():
        if len(ds) < 3:
            continue
        md = defaultdict(int)
        for d in ds:
            md[d[5:]] += 1
        top, n = max(md.items(), key=lambda x: x[1])
        if n / len(ds) >= 0.7:
            out[str(sid)] = top
            print(f"  date-locked: {names[sid]} -> {top} ({n}/{len(ds)})")
    return out


def set_minutes(shows_list, songs, plays, since="2022-01-01"):
    dur = {s["id"]: s.get("dur") for s in songs}
    by_date = defaultdict(list)
    for p in plays:
        by_date[p["date"]].append(p)
    s1, s2, e, total = [], [], [], []
    for s in shows_list:
        if s["date"] < since:
            continue
        tot = defaultdict(float)
        miss = defaultdict(int)
        for p in by_date[s["date"]]:
            d = dur.get(p["sid"])
            grp = "s1" if 0 in p["sl"] or 1 in p["sl"] or 2 in p["sl"] else ("e" if 6 in p["sl"] else "s2")
            if d is None:
                miss[grp] += 1
            else:
                tot[grp] += d
        if miss["s1"] <= 2 and tot["s1"]:
            s1.append(tot["s1"])
        if miss["s2"] <= 2 and tot["s2"]:
            s2.append(tot["s2"])
        if miss["e"] <= 1 and tot["e"]:
            e.append(tot["e"])
        if miss["s1"] <= 2 and miss["s2"] <= 2 and tot["s1"] and tot["s2"]:
            total.append(tot["s1"] + tot["s2"] + (tot["e"] if miss["e"] <= 1 else 0))
    med = lambda a: round(statistics.median(a)) if a else 0
    sd = lambda a: round(statistics.pstdev(a), 1) if len(a) > 1 else 0
    pct = lambda a, p, lo, hi: (round(sorted(a)[max(0, min(len(a) - 1, int(len(a) * p)))])
                                if a else round((lo + hi) / 2))
    out = {
        "s1": med(s1) or 73, "s2": med(s2) or 67, "e": med(e) or 15,
        "s1Sd": sd(s1) or 12, "s2Sd": sd(s2) or 12, "eSd": sd(e) or 5,
        "bounds": {
            "s1": [pct(s1, 0.05, 50, 70), pct(s1, 0.95, 90, 100)],
            "s2": [pct(s2, 0.05, 45, 65), pct(s2, 0.95, 85, 95)],
            "e": [pct(e, 0.05, 5, 10), pct(e, 0.95, 20, 30)],
            "total": [pct(total, 0.05, 120, 140), pct(total, 0.95, 175, 200)],
        },
    }
    print(f"  set minutes: {out}")
    return out


def fit_static_calibration(shows_list, songs, plays, gap_mult):
    """Seed calibration curve; the app refits this dynamically in the browser."""
    dates = [s["date"] for s in shows_list]
    didx = {d: i for i, d in enumerate(dates)}
    by = defaultdict(list)
    for p in plays:
        by[p["sid"]].append(didx[p["date"]])
    for k in by:
        by[k].sort()
    debut = {s["id"]: didx[s["debut"]] for s in songs}
    # Calibration exclusions are a DATE RANGE, not tour names. Only one stretch qualifies:
    # the 2026 90s-themed MSG run plus the shows immediately before it, which leaned on newer
    # material to keep the older songs fresh for the theme. Everything else — Sphere runs,
    # Mexico runs, NYE runs — is a normal run with a normal setlist and belongs in the fit.
    # (The old list excluded all three 2026 tour names, which threw out every 2026 show but
    # one and left the calibration anchored on data six months stale.)
    test = [i for i, s in enumerate(shows_list)
            if i > 200 and not in_excluded_range(s["date"])][-143:]
    if len(test) < 40:
        return [[0, 0], [0.2, 0.25], [0.6, 0.75]]
    hl = 100.0
    edges = [0, .01, .02, .03, .05, .075, .10, .125, .15, .20, 1.01]
    bins = [[0, 0.0, 0] for _ in edges[:-1]]
    for T in test:
        A = T - 1
        d = dates[T]
        ws = bisect.bisect_left(dates, f"{int(d[:4]) - 5}{d[4:]}")
        W = [0.5 ** ((A - i) / hl) for i in range(A + 1)]
        PW = [0.0] * (A + 2)
        for i in range(A + 1):
            PW[i + 1] = PW[i] + W[i]
        played = set()
        for sid, idxs in by.items():
            j = bisect.bisect_left(idxs, T)
            if j < len(idxs) and idxs[j] == T:
                played.add(sid)
        for sid, idxs in by.items():
            eff = max(ws, debut[sid])
            if eff > A:
                continue
            lo, hi = bisect.bisect_left(idxs, eff), bisect.bisect_right(idxs, A)
            num = sum(W[i] for i in idxs[lo:hi])
            den = PW[A + 1] - PW[eff]
            f = num / den if den > 0 else 0
            j = bisect.bisect_left(idxs, T)
            p = min(1.0, f * gap_mult[min(max(A - idxs[j - 1] + 1, 1), 20)]) if j > 0 else f
            if p <= 0:
                continue
            for b in range(len(edges) - 1):
                if edges[b] <= p < edges[b + 1]:
                    bins[b][0] += 1
                    bins[b][1] += p
                    bins[b][2] += 1 if sid in played else 0
                    break
    blocks = [[b[1] / b[0], b[2] / b[0], b[0]] for b in bins if b[0] >= 30]
    i = 0
    while i < len(blocks) - 1:  # pool adjacent violators
        if blocks[i][1] > blocks[i + 1][1]:
            x1, y1, w1 = blocks[i]
            x2, y2, w2 = blocks[i + 1]
            blocks[i:i + 2] = [[(x1 * w1 + x2 * w2) / (w1 + w2), (y1 * w1 + y2 * w2) / (w1 + w2), w1 + w2]]
            i = max(0, i - 1)
        else:
            i += 1
    pts = [[0.0, 0.0]] + [[round(b[0], 4), round(b[1], 4)] for b in blocks]
    if len(pts) >= 3:
        (xa, ya), (xb, yb) = pts[-2], pts[-1]
        slope = (yb - ya) / max(1e-9, xb - xa)
        pts.append([0.6, round(min(0.9, yb + slope * (0.6 - xb)), 3)])
    print(f"  calibration seed fit on {len(test)} shows")
    return pts


def mine_run_position(raw, modern="2009-01-01"):
    """Opening- and closing-night effects across multi-night runs at one venue.

    Normalised on a share-of-slots basis, because closing nights genuinely run
    longer (21.4 songs vs 18.0 on openers) and would otherwise inflate everything.
    """
    venues, songs_at, names = {}, defaultdict(set), {}
    for r in raw:
        if r["showdate"] < modern:
            continue
        names[r["songid"]] = r["song"]
        venues[r["showdate"]] = r["venue"]
        songs_at[r["showdate"]].add(r["songid"])
    dates = sorted(venues)
    if not dates:
        return {"open": {}, "close": {}}
    to_d = lambda s: date(*map(int, s.split("-")))
    runs, cur = [], [dates[0]]
    for prev, d in zip(dates, dates[1:]):
        if venues[d] == venues[prev] and (to_d(d) - to_d(prev)).days <= 3:
            cur.append(d)
        else:
            runs.append(cur)
            cur = [d]
    runs.append(cur)
    multi = [r for r in runs if len(r) >= 3]
    first, last, mid = Counter(), Counter(), Counter()
    tf = tl = tm = 0
    for r in multi:
        for s in songs_at[r[0]]:
            first[s] += 1
        tf += len(songs_at[r[0]])
        for s in songs_at[r[-1]]:
            last[s] += 1
        tl += len(songs_at[r[-1]])
        for d in r[1:-1]:
            for s in songs_at[d]:
                mid[s] += 1
            tm += len(songs_at[d])
    skip = NON_SONGS | {"Auld Lang Syne"}   # date-locked handled separately
    out = {"open": {}, "close": {}}
    for key, cnt, tot, others in [("close", last, tl, [(first, tf), (mid, tm)]),
                                  ("open", first, tf, [(last, tl), (mid, tm)])]:
        for s in cnt:
            if names.get(s) in skip:
                continue
            oc = sum(c[s] for c, _ in others)
            ot = sum(x for _, x in others)
            if cnt[s] < 8 or oc + cnt[s] < 12 or ot <= 0:
                continue
            base = oc / ot
            if base <= 0:
                continue
            exp = base * tot
            z = (cnt[s] - exp) / math.sqrt(max(exp, 1e-9))
            if z < 3.0:                       # strict: ~500 songs tested per position
                continue
            out[key][str(s)] = round(min(2.2, cnt[s] / exp), 2)
    print(f"  run position: {len(out['open'])} opening-night, {len(out['close'])} closing-night effects")
    return out


def mine_set_affinity(raw, pair_rules, modern="2009-01-01"):
    """Pairs that turn up in the same set well beyond chance (excluding the hard pairs)."""
    existing = {frozenset((r["a"], r["b"])) for r in pair_rules}
    per_set, names = defaultdict(lambda: defaultdict(set)), {}
    for r in raw:
        if r["showdate"] < modern:
            continue
        names[r["songid"]] = r["song"]
        grp = "1" if r["set"] == "1" else ("e" if r["set"].startswith("e") else "2")
        per_set[r["showdate"]][grp].add(r["songid"])
    sc, pc, nsets = Counter(), Counter(), 0
    for d, grps in per_set.items():
        for g, ss in grps.items():
            if g == "e":
                continue
            nsets += 1
            ss = list(ss)
            for s in ss:
                sc[s] += 1
            for i in range(len(ss)):
                for j in range(i + 1, len(ss)):
                    pc[frozenset((ss[i], ss[j]))] += 1
    out = []
    for pr, n in pc.items():
        if n < 12 or pr in existing:
            continue
        a, b = tuple(pr)
        if names.get(a) in NON_SONGS or names.get(b) in NON_SONGS:
            continue
        ea, eb = sc[a] / nsets, sc[b] / nsets
        exp = ea * eb * nsets
        if exp < 4:
            continue
        z = (n - exp) / math.sqrt(exp * (1 - ea * eb))
        if z > 4.5 and n / exp > 1.6:
            out.append({"a": a, "b": b, "an": names[a], "bn": names[b],
                        "lift": round(n / exp, 2), "n": n})
    out.sort(key=lambda x: -x["lift"])
    print(f"  {len(out)} within-set affinity pairs")
    return out


def mine_tour_openers(raw, modern="2009-01-01"):
    """Warm-up songs: set 1 of the first show of a tour, after time off."""
    tours, s1, names = defaultdict(list), defaultdict(set), {}
    for r in raw:
        if r["showdate"] < modern:
            continue
        names[r["songid"]] = r["song"]
        tours[r["tourname"]].append(r["showdate"])
        if r["set"] == "1":
            s1[r["showdate"]].add(r["songid"])
    firsts = {min(ds) for ds in tours.values()}
    fc, oc, tf, to = Counter(), Counter(), 0, 0
    for d, ss in s1.items():
        if d in firsts:
            for x in ss:
                fc[x] += 1
            tf += len(ss)
        else:
            for x in ss:
                oc[x] += 1
            to += len(ss)
    out = {}
    for x in fc:
        if names.get(x) in NON_SONGS or fc[x] < 5 or fc[x] + oc[x] < 10 or to <= 0:
            continue
        base = oc[x] / to
        if base <= 0:
            continue
        exp = base * tf
        z = (fc[x] - exp) / math.sqrt(max(exp, 1e-9))
        if z > 2.5:
            out[str(x)] = round(min(2.5, fc[x] / exp), 2)
    print(f"  {len(out)} tour-opener warm-up songs")
    return out


# Ballads and low-energy songs — the pool a set-2 breather is drawn from. This is the one
# curated list in the build, and deliberately so: tempo and mood appear in no dataset, and the
# structural signals cannot tell a ballad from a short fast song (NICU sits 98.6% mid-set,
# exactly like Lifeboy; Poor Heart is 100% mid-set but is a bluegrass sprint). Edit freely.
BREATHER_SONGS = [
    # Ballads and low-energy songs — the pool a set-2 breather is drawn from.
    "Waste", "Shade", "Lonely Trip", "Lifeboy", "Leaves", "Dirt", "Strange Design",
    "Wading in the Velvet Sea", "Brian and Robert", "Billy Breathes", "Fast Enough for You",
    "Bug", "Farmhouse", "Joy", "Miss You", "If I Could", "Mountains in the Mist", "Driver",
    "Anything But Me", "Sea and Sand", "Bliss", "Winterqueen", "Beauty of a Broken Heart",
    "Let Me Lie", "All of These Dreams", "Army of One", "Evening Song", "Corinna",
    "Secret Smile", "The Connection", "Olivia's Pool", "Bittersweet Motel", "Sleep",
    "Roggae", "Wingsuit", "The Horse", "Silent in the Morning", "Devotion to a Dream",
    "Dancing in Midair",
    # Ruled out as not mellow: NICU, My Friend My Friend, Tela, Waking Up Dead, Show of Life,
    #   Frankie Says, Everything Is Hollow, Death Don't Hurt Very Long, Poor Heart, Cities,
    #   Plasma, Sample in a Jar. Ruled out as finales: Tweezer Reprise, Shine a Light.
    # Still undecided: Prince Caspian, The Lizards, A Song I Heard the Ocean Sing,
    #   Halfway to the Moon, Sweet Adeline, Sleeping Monkey, Ass Handed, Sanity, Horn,
    #   Steep, Swept Away, Dogs Stole Things, Sing Monica.
]


def breather_ids(songs):
    by = {s["name"].lower(): s["id"] for s in songs}
    ids = sorted({by[n.lower()] for n in BREATHER_SONGS if n.lower() in by})
    print(f"  {len(ids)} breather songs matched")
    return ids


def mine_jam_rate(raw, modern="2009-01-01"):
    """Share of performances flagged as a notable jam — a usable proxy for intensity.
    It cleanly separates a breather (Lifeboy 0.07, Waste 0.01) from a hard-edged song that
    merely tends to follow jams (My Friend, My Friend 0.17, Cities 0.30)."""
    jam, tot = Counter(), Counter()
    for r in raw:
        if r["showdate"] < modern:
            continue
        tot[r["songid"]] += 1
        if r.get("isjamchart"):
            jam[r["songid"]] += 1
    out = {str(s): round((jam[s] + 0.5) / (tot[s] + 6), 3) for s in tot if tot[s] >= 5}
    print(f"  jam rate for {len(out)} songs")
    return out


def mine_closers(raw, modern="2009-01-01"):
    """P(song ends the night | it was played) — the last song is always a banger."""
    names, seen, last = {}, defaultdict(set), {}
    for r in raw:
        if r["showdate"] < modern:
            continue
        names[r["songid"]] = r["song"]
        seen[r["showdate"]].add(r["songid"])
        rank = (1 if r["set"].startswith("e") else 0, r["set"], r["position"])
        cur = last.get(r["showdate"])
        if cur is None or rank > cur[0]:
            last[r["showdate"]] = (rank, r["songid"])
    if not seen:
        return {}
    played = Counter()
    for d, ss in seen.items():
        for s in ss:
            played[s] += 1
    closes = Counter(v[1] for v in last.values())
    n_shows = len(last)
    base = 1.0 / (sum(len(s) for s in seen.values()) / n_shows)
    alpha = 8
    out = {}
    for s in played:
        if played[s] < 5 or names.get(s) in NON_SONGS:
            continue
        out[str(s)] = round((closes[s] + alpha * base) / (played[s] + alpha), 4)
    print(f"  closer scores for {len(out)} songs")
    return out


GAP_MULT = [None, 0.445, 0.782, 0.935, 1.049, 1.12, 1.116, 1.088, 1.06, 0.972, 0.979,
            0.892, 0.864, 0.789, 0.733, 0.746, 0.742, 0.666, 0.663, 0.644, 0.222]


def main():
    print("Fetching setlists from phish.net...")
    raw = fetch_setlists()
    print(f"  {len(raw)} song-performance rows")

    print("Fetching song durations from phish.in...")
    try:
        durations = fetch_durations()
    except Exception as e:
        print(f"  ! durations unavailable ({e}) — continuing without them", file=sys.stderr)
        durations = {}

    # Dump the duration distributions to a plain CSV next to index.html. This is a
    # diagnostic artifact, not an input: it makes the sampled-length tuning inspectable
    # without needing a local Python install. Safe to delete; the build never reads it.
    try:
        import csv as _csv
        with open("durations.csv", "w", newline="", encoding="utf-8") as fh:
            w = _csv.writer(fh)
            w.writerow(["song", "observations", "p10", "p25", "p50", "p75", "p90"])
            for name in sorted(durations):
                v = durations[name]
                w.writerow([name, v["n"]] + list(v["q"]))
        print(f"  wrote durations.csv ({len(durations)} songs)")
    except Exception as e:
        print(f"  ! could not write durations.csv ({e})", file=sys.stderr)

    print("Shaping...")
    shows_list, songs, plays = shape(raw, durations)
    assign_run_positions(shows_list)   # every historical show gets its real run position — known, not guessed
    print(f"  {len(shows_list)} shows, {len(songs)} songs, {len(plays)} (song, show) records")

    print("Fetching upcoming shows...")
    try:
        upcoming = fetch_upcoming(shows_list)
    except Exception as e:
        print(f"  ! upcoming unavailable ({e})", file=sys.stderr)
        upcoming = []

    print("Mining patterns...")
    pairs = mine_pairs(raw)
    runpos = mine_run_position(raw)
    setaff = mine_set_affinity(raw, pairs)
    cool = mine_cool_affinity(raw, durations)
    print("Mining reentrant songs...")
    reentry = mine_reentry(raw)
    print("Mining set-count distributions...")
    setcounts = mine_setcounts(raw)
    touropen = mine_tour_openers(raw)
    closer = mine_closers(raw)
    jamrate = mine_jam_rate(raw)
    breathers = breather_ids(songs)
    locked = mine_date_locked(raw)
    minutes = set_minutes(shows_list, songs, plays)
    cal = fit_static_calibration(shows_list, songs, plays, GAP_MULT)

    os.makedirs(CACHE, exist_ok=True)
    for name, obj in [("shows", shows_list), ("songs", songs), ("plays", plays),
                      ("pair_rules", pairs), ("cool_affinity", cool), ("run_position", runpos),
                      ("set_affinity", setaff), ("tour_opener", touropen), ("closer_score", closer), ("jam_rate", jamrate), ("breathers", breathers),
                      ("date_locked", locked), ("set_minutes", minutes), ("calibration", cal),
                      ("upcoming", upcoming)]:
        with open(os.path.join(CACHE, f"{name}.json"), "w") as f:
            json.dump(obj, f, separators=(",", ":"))

    print("Rendering index.html...")
    esc = lambda s: s.replace("</", "<\\/")
    j = lambda o: json.dumps(o, separators=(",", ":"))
    html = open(TEMPLATE, encoding="utf-8").read()
    for k, v in {
        "__SHOWS_JSON__": esc(j(shows_list)),
        "__SONGS_JSON__": esc(j(songs)),
        "__PLAYS_JSON__": esc(j(plays)),
        "__PAIRS_JSON__": j(pairs),
        "__COOL_JSON__": j(cool),
        "__BUILD_STAMP__": build_stamp(html),
        "__REENTRY_JSON__": j(reentry),
        "__SETCOUNTS_JSON__": j(setcounts),
        "__DATELOCK_JSON__": j(locked),
        "__RUNPOS_JSON__": j(runpos),
        "__SETAFF_JSON__": j(setaff),
        "__TOUROPEN_JSON__": j(touropen),
        "__CLOSER_JSON__": j(closer),
        "__JAMRATE_JSON__": j(jamrate),
        "__BREATHERS_JSON__": j(breathers),
        "__UPCOMING_JSON__": j(upcoming),
        "__SETMIN_JSON__": j(minutes),
        "__STATIC_CAL_JSON__": j(cal),
        "__LATEST_DATE__": shows_list[-1]["date"],
        "__SHOW_COUNT__": f"{len(shows_list):,}",
        "__SONG_COUNT__": f"{len(songs):,}",
    }.items():
        html = html.replace(k, v)
    with open(OUTPUT, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"Done — {OUTPUT} ({os.path.getsize(OUTPUT) / 1048576:.2f} MB), "
          f"latest show {shows_list[-1]['date']}")


if __name__ == "__main__":
    main()
