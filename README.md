[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/72659821z-maker/token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/72659821z-maker/token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
# Token Radar

A token-launch radar for make.fun's `token-radar-01` bounty. It reads a sealed DefiLlama snapshot of 758
protocols, finds the ones whose record carries no token, and ranks them by an **implied value** derived
from each protocol's own figures. Every ranked protocol gets a concrete farm plan. The page is a static,
network-free dashboard with a sortable/filterable board, a detail view for every protocol, and a live-token
comparison set.

## Run

Node 22.18 or newer, standard library only:

```sh
node main.ts
```

On Linux or in the grader's container that reads `/input/snapshot.json` and writes `/output`. On a Windows
development machine the same command reads `C:/input/snapshot.json` and writes `C:/output`; that is the only
place a drive letter appears in `main.ts`. Override either path:

```sh
node main.ts --input ./snapshot.json --output ./out
SNAPSHOT_PATH=./snapshot.json OUTPUT_DIR=./out node main.ts
```

The program is deterministic: two runs over the same snapshot write the same bytes.

## Outputs

| Path | What it is |
| --- | --- |
| `board.json` | `{rows: [...]}`: one row per ranked pre-token protocol, with `slug`, `name`, `rank`, `implied_value_usd`, `farm_steps`, plus the model's inputs and breakdown. |
| `data.js` | The same board in the dashboard's compact form, read by the page as `window.RADAR`. |
| `dashboard/` | `index.html`, `app.css`, `app.js`, `model.md`. No framework, no network, no external asset. |
| `screenshots/` | Three whole PNGs: the board, a protocol detail view, a filtered view. |
| `dossier.json` | `buildDossier('/output', {text_max_bytes: 65536})` from `vendor/makefun-board.ts`, the library the scorer also uses. |

## The value model (`lib/model.ts`, `radar-3`)

The model answers a narrow question: **if this protocol's present record were priced like the token-bearing
protocols around it, what would its token be worth?** It does not claim a token exists or will launch.

```
age_days   = as_of - listed_at, clamped at 0 (null when unrecorded)
cat_mult   = robust category FDV/TVL multiple, learned from the snapshot's token-bearing peers
             and shrunk toward a stated prior with weight n/(n+4)
size_damp  = clamp((tvl_usd / $100M) ^ -0.06, 0.55, 1.35)
base       = tvl_usd * cat_mult * size_damp
growth_x   = 1 + 0.22 * tanh(clamp(change_7d, -60, +100) / 18)
maturity_x = age known: 0.82 + 0.36 * min(age_days, 1460) / 1460; age unknown: 1.00
implied    = round(base * growth_x * maturity_x), clamped to [1, 1e14]
```

- **TVL** is the protocol's own measure of economic activity, and the category multiple is the exchange
  rate between TVL and fully diluted value. The multiple is not hand-waved: for every category with at
  least two token-bearing protocols, the model drops impossible ratios (outside 0.01..8), takes the
  median, removes peers more than 3 scaled MADs from it when at least five remain, then shrinks the
  surviving median toward a stated prior with weight `n/(n+4)` and caps the peer median to `[0.04, 1.00]`.
  A category with fewer than two peers keeps its prior; an unnamed category starts from the snapshot-wide
  robust median. The detail view prints the prior, peer count, surviving count, peer median, shrink weight
  and applied multiple for the row's category.
- **Size damping** (`-0.06` elasticity) is a second-order correction. At equal multiples, token markets
  pay a little less per dollar of TVL as protocols get very large; a 10x larger TVL cuts the multiple by
  about 13%, not by half.
- **Seven-day growth** is bounded momentum: at most ±22% through `tanh`, with the input clamped to
  -60..+100%. A +400% week is usually an incentive program or a one-off inflow. A null reading is
  neutral, and the row records that it was unreported.
- **Age with no token** is the track-record term. A protocol that has run for years without a token has
  the record a launch would be judged on; one listed last month does not. It runs from 0.82 to 1.18 over
  four years. A missing listing day is neutral.
- **Token presence is a gate.** Protocols whose record carries a market cap, CoinGecko id or symbol are
  never ranked as pre-token. Their actual market caps appear in the dashboard's token tab.
- **No protocol name is special-cased.** The model reads `tvl_usd`, `change_7d`, `listed_at`, `category`,
  `mcap_usd`, `gecko_id` and `symbol`; names appear only in the farm plan's instructions to the reader.

The candidate set is the watchlist (all 40 slugs, the floor) plus every other pre-token protocol in the
snapshot that is not a wrapped, staked, bridged, exchange-branded or versioned product. That yields 195
rows on this snapshot: the 40 watchlist protocols and 155 the watchlist did not name, including protocols
above the floor that the watchlist's parent-protocol rule left out.

## Farm plans

`farmSteps` in `lib/model.ts` derives eight steps per protocol from its category, first chain, TVL and age:
wallet setup chosen by chain (an Ethereum gas balance, Solana SOL and no bridge, a Base bridge), the
category's main position, a companion action, a weekly cadence, a hold window with the capital lockup and
yield forgone, a points-programme check, a TVL/withdrawal safety check and a written log. Every step
carries an explicit **cost** and **time**, and the strings are the exact ones written to `board.json`, so
the page cannot drift from the board.

## Dashboard

A deep-slate instrument palette with one amber signal, editorial serif for the voice and tabular mono for
the figures, on one spacing scale and one type scale. The page header is sticky. The board is sortable on
every column and filterable by text, category and chain, with a scope switch (all / watchlist / early
finds) and a pre-token / has-token toggle; the row count updates live. Each row carries an implied-value bar
and the category multiple with its peer count or `prior`. Clicking a row opens a hash-routed detail view
with the full score breakdown (every factor's multiplier), the recomputation check, the peer-calibration
table, the farm plan as numbered steps with cost and time tags, and the record-not-proof caveat. A
methodology panel states the model in six sentences and prints the calibration sample. No network at
render time: `data.js` is the only data source and every asset is local.

## Layout

```
main.ts                 program/v1 entrypoint
lib/model.ts            snapshot parsing, value model, farm plans, board writer
vendor/makefun-board.ts make.fun's dossier library (copied byte for byte from the kit)
dashboard/index.html    the page
dashboard/app.css       the theme
dashboard/app.js        the renderer
dashboard/model.md      the model, written out for the judge's source read
screenshots/            board, detail, filtered
tools/gate-check.mjs    local replica of the seven gate rows (development aid)
README.md, LICENSE
```

## License

MIT. See `LICENSE`.
