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
  before the target date, at the current settings, with themed runs excluded.

On top of that: song pairings mined from history (Mike's Song → Weekapaug Groove, The Horse →
Silent in the Morning, Tweezer → Tweezer Reprise) are drawn as single units; songs that only
ever appear as closers or encores are barred from mid-set; cool-down songs are identified by
how often they actually follow a long jam rather than by length; and songs locked to one
calendar date (Auld Lang Syne) are excluded unless you're predicting that date.

## Data

- Setlists: [phish.net API v5](https://docs.phish.net/) (needs a free API key)
- Song durations: [phish.in API v2](https://phish.in/api-docs)

## Rebuilding

```bash
PHISHNET_API_KEY=your_key python build.py
```

That fetches everything, recomputes every derived table, and writes `index.html`.
A scheduled GitHub Action runs it daily and commits the result, so the site stays
current on its own.

## Credits

Setlist data is the work of the [Mockingbird Foundation](https://phish.net/), a
non-profit run by volunteers. Consider [donating](https://phish.net/donate).
