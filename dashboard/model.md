# The model behind Token Radar (radar-3)

Token Radar answers one question: if a protocol's present record were priced like the token-bearing
protocols around it, what would its token be worth? It does not predict whether or when a token is
issued. Every row is a protocol whose DefiLlama record carries no market cap, CoinGecko id or symbol.

## One function, no names

    implied = round(
      tvl_usd
      × category_multiple
      × clamp((tvl_usd / $100M) ^ -0.06, 0.55, 1.35)
      × (1 + 0.22 × tanh(clamp(change_7d, -60, 100) / 18))
      × maturity(age_days)
    )

The five terms, and why each is there:

1. **TVL** is the protocol's own measure of value secured. It is the anchor.
2. **Category multiple** converts TVL to fully diluted value. It is learned per category from the
   snapshot's own token-bearing protocols; a DEX and a lending market do not earn the same multiple.
3. **Size damping** applies `(tvl / $100M) ^ -0.06`, clamped to 0.55..1.35: very large protocols pay a
   slightly lower multiple per dollar of TVL (a 10x larger TVL cuts it about 13%), not half.
4. **Seven-day growth** moves the value by at most ±22% through `tanh`, and the input is clamped to
   -60%..+100%. A +400% week is usually a one-off inflow, not a durable re-rating. A null change is
   neutral and the row records that it was unreported.
5. **Time without a token**, from `listed_at` to `as_of`, runs the multiple from 0.82 at listing to 1.18
   at four years. It is a track-record adjustment, not the main driver. A null listing day is neutral.

The only fields the model reads are `tvl_usd`, `change_7d`, `listed_at`, `category`, `mcap_usd`,
`gecko_id` and `symbol`. Protocol names are never read by the model; they appear only in the farm plan's
instructions to the reader.

## How the category multiple is learned

For each category with token-bearing peers in the snapshot:

1. Take each peer's `mcap_usd / tvl_usd`. Drop impossible ratios outside 0.01..8 and peers below $1M TVL
   before any statistic; those are data errors, not market signals.
2. Take the median, and the scaled median absolute deviation (1.4826 × MAD, floored at 0.01).
3. Drop peers further than 3 scaled MADs from the median when at least five ratios remain, then take the
   median of what survives. A category with two to four peers is not trimmed to nothing.
4. Shrink that robust median toward a stated category prior with weight n/(n+4), where n is the number
   of surviving peers: 4 peers move the multiple 50% of the way, 12 peers 75%.
5. Cap the peer median to 0.04..1.00 before the blend.

A category with fewer than two peers keeps its stated prior, and the detail view says so: no peer fit is
claimed from one observation. A category with no stated prior starts from the snapshot-wide robust
median of every token-bearing peer, so even an unfamiliar category is anchored in the data. The page
prints the prior, the peer count, the surviving count, the peer median and the applied multiple for
every category in its calibration table, and every row's detail view repeats its own factors.

## Farm plans

Plans are generated, not hand-written. The category chooses the actions (supply and borrow for lending,
LP and gauge for a DEX, a curated vault for a risk curator, a subscription and KYC for RWA, a hedge for a
derivative, a stake for a staking pool); the first chain chooses wallet setup, gas and bridging (Ethereum
needs an L1 gas balance, Solana needs SOL and no bridge, Base needs the official bridge); TVL chooses the
position size ($100 to $500) and age chooses the hold (30 to 60 days). Every step states a cost and a
time, and the last steps cover the points programme, a TVL check and a written record.

The program is a pure function of the sealed snapshot: no network, no clock, no random source and no
name list, so two runs write the same bytes.
