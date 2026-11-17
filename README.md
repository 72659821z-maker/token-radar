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
| `dashboard/` | `index.html`, `app.css`, `app.js`. No framework, no network, no external asset. |
| `screenshots/` | Three whole PNGs: the board, a protocol detail view, a filtered view. |
| `dossier.json` | `buildDossier('/output', {text_max_bytes: 65536})` from `vendor/makefun-board.ts`, the library the scorer also uses. |

## The value model (`lib/model.ts`, `radar-2`)

The model answers a narrow question: **if this protocol's present record were priced like the token-bearing
protocols around it, what would its token be worth?** It does not claim a token exists or will launch.

```
age_days   = as_of - listed_at, clamped at 0 (null when unrecorded)
cat_mult   = category FDV/TVL multiple, learned from the snapshot's own token-bearing peers
             when the category has >= 4 of them, else a stated prior
size_damp  = clamp((tvl_usd / $100M) ^ -0.06, 0.55, 1.35)
base       = tvl_usd * cat_mult * size_damp
growth_x   = 1 + 0.20 * tanh(clamp(change_7d, -50, +80) / 20)
maturity_x = age known: 0.80 + 0.35 * min(age_days, 1460) / 1460; age unknown: 1.00
implied    = round(base * growth_x * maturity_x), clamped to [1, 1e14]
```

- **TVL** is the protocol's own measure of economic activity, and the category multiple is the exchange
  rate between TVL and fully diluted value. The multiple is not hand-waved: for every category with at
  least four token-bearing protocols in the snapshot, the model takes their median market-cap/TVL,
  caps it to `[0.05, 0.65]`, and blends it 45/55 with a stated prior. Categories with thin samples keep
  the prior. This is why token presence matters: live protocols are the calibration, never the ranking.
- **Size damping** (`-0.06` elasticity) is a second-order correction. At equal multiples, token markets
  pay a little less per dollar of TVL as protocols get very large; a 10x larger TVL cuts the multiple by
  about 13%, not by half.
- **Seven-day growth** is bounded momentum. A +400% week is usually an incentive program or a one-off
  inflow, so `tanh` compresses the tails and the clamp keeps a bad print from producing an absurd value.
  A null reading is neutral.
- **Age with no token** is the track-record term. A protocol that has run for years without a token has
  the record a launch would be judged on; one listed last month does not. It moves the value by at most
  ±17.5%, because it is a confidence adjustment, not the main driver. A missing listing day is neutral.
- **Token presence is a gate.** Protocols whose record carries a market cap, CoinGecko id or symbol are
  never ranked as pre-token. Their actual market caps appear in the dashboard's Live token tab.

The candidate set is the watchlist (all 40 slugs, the floor) plus every other pre-token protocol in the
snapshot that is not a wrapped, staked, bridged, exchange-branded or versioned product. That yields 195
rows on this snapshot: the 40 watchlist protocols and 155 the watchlist did not name, including protocols
above the floor that the watchlist's parent-protocol rule left out.

## Farm plans

`farmSteps` in `lib/model.ts` derives seven steps per protocol from its category, first chain, TVL and age:
a dedicated wallet and capital amount, the category's main position, a companion action, a weekly cadence,
a hold window, a claim-safety check and a log. Every step carries an explicit **cost** and **time**, and
the strings are the exact ones written to `board.json`, so the page cannot drift from the board.

## Dashboard

A midnight instrument-panel palette (mint signal, cyan secondary, amber caution), one spacing scale and one
type scale. The board is sortable on every column and filterable by text, category and chain; the row count
updates live. Clicking a row opens a full detail view with the model's equation, the live-peer calibration,
the record-not-proof caveat and the farm plan. The Live token tab shows the token-bearing peers and their
market-cap/TVL ratios. No network at render time: `data.js` is the only data source and every asset is local.

## Layout

```
main.ts                 program/v1 entrypoint
lib/model.ts            snapshot parsing, value model, farm plans, board writer
vendor/makefun-board.ts make.fun's dossier library (copied byte for byte from the kit)
dashboard/index.html    the page
dashboard/app.css       the theme
dashboard/app.js        the renderer
screenshots/            board, detail, filtered
tools/gate-check.mjs    local replica of the seven gate rows (development aid)
README.md, LICENSE
```

## License

MIT. See `LICENSE`.
