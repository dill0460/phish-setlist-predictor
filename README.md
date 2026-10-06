# Phish Setlist Predictor

Predicts the setlist of an upcoming Phish show from 40+ years of setlist history.

**Live site:** https://dill0460.github.io/phish-setlist-predictor/

## What it does

Three views, all driven by an adjustable time window and recency weighting:

- **Predicted Setlist** — a full slot-by-slot show (set 1 / set 2 / encore). *Realistic* mode
  rolls each song independently at its calibrated probability and fills each set to a time
  budget, so a night of long jams fits fewer songs. *Most likely* mode is a ranked list
  showing every input to the formula.
- **Song Likelihood** — every song scored, plus a bustout watch for songs returning from
  a long absence.
- **Frequency Explorer** — how often each song is played over any date range you choose.

## How the prediction works

```
P(song is played) = recency-weighted frequency × gap multiplier → calibrated
```

- **Recency-weighted frequency** — distinct shows the song appeared in ÷ shows in the window.
  A song woven in and out of one night counts once. Older shows are down-weighted by an
  adjustable half-life, so a song's score tracks where it is now, not its lifetime average.
- **Gap multiplier** — measured from the full history: a song is suppressed right after it's
  played (0.45× the next show), peaks in the "due" zone 4–8 shows out (1.12×), and falls well
  below baseline past ~20 shows (0.22×). This term does most of the predictive work.
- **Calibration** — raw scores are refit against what actually happened in the ~120 shows
  before the target date, at the current settings (nothing held out). A final pass checks the
  finished number itself, so a song shown at 50% really plays about half the time.
- **Night total** — each night's probabilities are scaled together so they add up to what a
  real night holds (measured on the last 100 shows), so boosts take from other songs instead of
  making the night longer, and a night after a long break is not over-filled.

On top of that: song pairings mined from history (Mike's Song → Weekapaug Groove, The Horse →
Silent in the Morning, Tweezer → Tweezer Reprise) are drawn as single units; songs that only
ever appear as closers or encores are barred from mid-set; cool-down songs are identified by
how often they actually follow a long jam rather than by length; and songs locked to one
calendar date (Auld Lang Syne) are excluded unless you're predicting that date.

The realistic setlist is built to the shape of the **last 100 shows**: songs per set, long
jams per set, set lengths and how set 1 compares with set 2. Minutes are shown in real track
time (calibrated on phish.in recordings). The running order inside each set follows each
song's measured habit (Down with Disease early in set 2, Harry Hood late), not its probability.
Tour openers are recognised from phish.net's tour names.

**Learned corrections** (`contexts.js`, run by the Action after `build.py`): the model is replayed
on every show since 2010 as it would have predicted it the day before, and what it keeps missing
is learned and applied — songs already played once this tour come back less, staples more; new
songs less than their first burst suggests; and kinds of night (tour openers, first and last
nights of a run, tour finales, New Year's Eve, stand-alone runs such as Dick's, NYE, Mexico and
Sphere, and Dick's itself) have their own favourites and lengths.

**Special nights**: New Year's Eve gets a third (midnight) set that opens with Auld Lang Syne
followed by one specific guess at the year's big song; Halloween's second set is the musical
costume, left as a placeholder because it can't be predicted. The official call favours song
accuracy: the most likely songs overall, each seated in its usual set. The replay
is cached in `data/context_cache.json`; after a template change the first build replays
everything once (several minutes). Soundchecks, TV spots and radio
sessions in the setlist data are left out of the history: they are not concerts.

## Data

- Setlists: [phish.net API v5](https://docs.phish.net/) (needs a free API key)
- Song durations and real set lengths: [phish.in API v2](https://phish.in/api-docs)

## Rebuilding

```bash
PHISHNET_API_KEY=your_key python build.py
```

That fetches everything, recomputes every derived table, and writes `index.html`.
A scheduled GitHub Action runs it daily and commits the result, so the site stays
current on its own.

## Testing a change

```bash
node test_ui.js                  # structural rules every generated night must obey
node backtest.js                 # the before/after scoreboard (about 10 minutes)
node backtest.js --quick         # probabilities only (about a minute)
node compare.js before.json after.json   # paired before/after, from backtest.js --json
```

`backtest.js` predicts each of the last 150 shows using only the shows before it, then scores
the top-20 list (how many were played), the Brier score (are the percentages honest?), the
official call, and how realistic the generated nights look against real ones. Run
`node backtest.js --fetch-phishin` once to download the phish.in track times it uses for
set lengths and running order.

## Credits

Setlist data is the work of the [Mockingbird Foundation](https://phish.net/), a
non-profit run by volunteers. Consider [donating](https://phish.net/donate).
