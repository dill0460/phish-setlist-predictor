"""
Day-aware gap hazard — the calendar-break correction (v33).

WHY THIS EXISTS
---------------
The gap hazard (GAP_MULT) is measured in SHOWS since a song was last played. The band
appears to work in DAYS. Those come apart hard whenever a calendar break intervenes:

    show-gap 1, <=14 days elapsed  -> 0.10x the base play rate
    show-gap 1, 46+ days elapsed   -> 1.43x

A 14x swing that the one-dimensional table collapses into a single 0.445x. Measured over
179,766 song-show opportunity pairs (2009+). 14% of all short-gap decisions are post-break,
and the current model under-rates that group by ~2.7x.

Walk-forward backtest, hazard fit strictly on pre-test data, run-mates excluded from the
fit (see mine_day_hazard), metric = top-20 hits:

    fit<2022, since 2019, test 2022-2026 (n=211):  4.938 -> 5.711  (+0.773 +/- 0.110, t=+7.03)
    fit<2024, since 2019, test 2024-2026 (n=116):  4.888 -> 5.888  (+1.000 +/- 0.172, t=+5.82)
    fit<2022, since 2009, test 2022-2026 (n=211):  4.938 -> 5.455  (+0.517 +/- 0.084, t=+6.13)
    fit<2019, since 2009, test 2019-2021 (n= 81):  4.926 -> 5.284  (+0.358 +/- 0.120, t=+2.99)
    fit<2015, since 2009, test 2015-2018 (n=144):  5.396 -> 5.743  (+0.347 +/- 0.098, t=+3.55)

For scale, the model's entire measured edge over phish.net's published Trey's Notebook rule
is +0.06 (t=0.4) — see competitive-landscape-and-baseline-correction.md. This is roughly an
order of magnitude larger than that.

ERA: the effect is real in every era tested, but it is LARGER in the modern one and fitting
on 2019+ clearly beats fitting on the full 2009+ corpus (+0.773 vs +0.517 on the same test
window). The reason is visible in the data: the share of short-gap opportunities that sit
across a real calendar break rose from 11.9% (2015-2018) to 16.7% (2019+) as touring moved
to short segments, destination runs and residencies. Hence SINCE = 2019-01-01, the same
era-scoping reasoning as NIGHT_SHAPE_SINCE in v30. (An earlier version of this fit left
run-mates in and appeared to show NO effect before 2022; that was the double-count talking,
not the era.)

DESIGN: RESIDUAL, NOT REPLACEMENT
---------------------------------
This emits a multiplier RELATIVE to the gap-only rate for the same gap bucket, so it composes
with the existing GAP_MULT rather than replacing it, and averages to ~1.0 within each bucket.
That is deliberate and follows the v22 segue lesson: raw rates double-count whatever the
coarser table already encodes. Because the residual is mean-1 within a bucket, the existing
isotonic calibration and gapAdj corrections stay valid on average — this redistributes inside
a gap bucket, it does not shift the overall level.

Cells below MIN_CELL observations emit exactly 1.0 (no correction), so a thin corpus degrades
to current behaviour rather than to noise.
"""

from collections import defaultdict

# Show-gap buckets. Deliberately identical in shape to the head of GAP_MULT — the correction
# only bites at short gaps and converges to ~1.0 by gap 6-8, which is measured, not assumed.
GAP_EDGES = [(1, 2), (2, 3), (3, 4), (4, 6), (6, 9), (9, 13), (13, 21), (21, 31), (31, 61)]
# Calendar buckets. <=14d is "inside a tour leg", 15-45d is "short break", 46+d is "real break".
DAY_EDGES = [(0, 15), (15, 46), (46, 10 ** 9)]
MIN_CELL = 150         # below this an individual cell is not fit at all (thin cells were noisy at 60)
RUN_DAYS = 3           # same venue within this many days = one run (build.py's own run rule)
MAX_LOOKBACK = 60      # songs further than this out of rotation are the bustout channel's job
CLAMP = (0.15, 8.00)   # residuals outside this are noise, not signal; gap-1 post-break genuinely reaches ~6x
SINCE = "2019-01-01"   # see ERA DEPENDENCE above


def _gb(g):
    for i, (lo, hi) in enumerate(GAP_EDGES):
        if lo <= g < hi:
            return i
    return None


def _db(d):
    for i, (lo, hi) in enumerate(DAY_EDGES):
        if lo <= d < hi:
            return i
    return len(DAY_EDGES) - 1


def _days(a, b):
    """Calendar days between two ISO date strings, b - a."""
    from datetime import date
    ya, ma, da = map(int, a.split("-"))
    yb, mb, db_ = map(int, b.split("-"))
    return (date(yb, mb, db_) - date(ya, ma, da)).days


def mine_day_hazard(shows_list, plays, since=SINCE):
    """Residual multipliers, keyed "<gapBucket>,<dayBucket>" -> float.

    shows_list: chronologically sorted dicts with "date" and "venue" (build.py shape() output).
    plays:      dicts with "sid" and "date" (build.py shape() output).

    Walks history forward once. At each show from `since` on, every song already in rotation
    (last played within MAX_LOOKBACK shows) contributes one opportunity, and a hit if it was
    played. Rates are then divided by the gap-bucket's own marginal rate to leave the residual.

    WITHIN-RUN PAIRS ARE EXCLUDED, and that is not a detail. A song played earlier in the SAME
    venue run always has both a short show-gap and a short day-gap, and it essentially never
    returns: measured 2019+, the replay rate for run-mates is 0.0010 at gap 1 and exactly
    0.0000 at gaps 3-5, against 0.0019 / 0.0337 / 0.1062 for non-run-mates at the same gaps.
    They are 28.9% of every short-gap short-day opportunity, so leaving them in drags the
    <=14d cells down by a large factor.

    The engine already prices that behaviour, with RUN_REPEAT_MULT = 0.02 measured off the
    same 0.3% recurrence rate. Fitting it into this table as well would apply the no-repeat
    rule TWICE to the same song — the v16 double-suppression bug (gap multiplier and
    run-repeat multiplier both landing on tonight's already-played songs), one layer down.
    fitCalibration() drops run-mates from its gapAdj fit for exactly this reason; this
    follows that precedent.
    """
    dates = [s["date"] for s in shows_list]
    venues = [s.get("venue") for s in shows_list]

    # run id per show index: same venue, consecutive shows <= RUN_DAYS apart
    run_id, cur = [], 0
    for i, d in enumerate(dates):
        if not (i > 0 and venues[i] is not None and venues[i] == venues[i - 1]
                and _days(dates[i - 1], d) <= RUN_DAYS):
            cur += 1
        run_id.append(cur)
    songs_at = defaultdict(set)
    for p in plays:
        songs_at[p["date"]].add(p["sid"])

    hits = defaultdict(int)     # (gb, db) -> plays
    opps = defaultdict(int)     # (gb, db) -> opportunities
    ghits = defaultdict(int)    # gb -> plays          (the marginal we divide out)
    gopps = defaultdict(int)    # gb -> opportunities

    last_i, last_d = {}, {}
    for i, d in enumerate(dates):
        here = songs_at.get(d, ())
        if d >= since:
            for sid, li in last_i.items():
                g = i - li
                if g > MAX_LOOKBACK:
                    continue
                gb = _gb(g)
                if gb is None:
                    continue
                if run_id[li] == run_id[i]:
                    continue            # priced by RUN_REPEAT_MULT — see docstring
                db = _db(_days(last_d[sid], d))
                hit = 1 if sid in here else 0
                opps[(gb, db)] += 1
                hits[(gb, db)] += hit
                gopps[gb] += 1
                ghits[gb] += hit
        for sid in here:
            last_i[sid] = i
            last_d[sid] = d

    out = {}
    for (gb, db), n in sorted(opps.items()):
        if n < MIN_CELL or gopps[gb] < MIN_CELL:
            continue
        base = ghits[gb] / gopps[gb]
        if base <= 0:
            continue
        resid = (hits[(gb, db)] / n) / base
        out["%d,%d" % (gb, db)] = round(max(CLAMP[0], min(CLAMP[1], resid)), 4)

    return {
        "gapEdges": GAP_EDGES,
        "dayEdges": [[lo, hi] for lo, hi in DAY_EDGES],
        "mult": out,
        "since": since,
        "n": sum(opps.values()),
    }
