// Token Radar's value model (radar-3), farm-plan generator and board writer.
//
// WHAT THE BOARD CLAIMS
// A protocol's launch is the token it may issue one day. The model asks a narrower, answerable question:
// if this protocol's present record were priced like the token-bearing protocols around it, what would its
// token be worth? That is an implied value, not a forecast of whether or when a token arrives.
//
// THE MODEL (one function, applied to every row; no protocol name is special-cased)
//
//   age_days   = snapshot.as_of - listed_at, clamped at 0 (null when DefiLlama records no listing day)
//   cat_mult   = the category's FDV/TVL multiple, learned from the snapshot's token-bearing peers and
//                shrunk toward a stated prior (see categoryCalibration)
//   size_damp  = clamp((tvl_usd / $100M) ^ -0.06, 0.55, 1.35)
//   base       = tvl_usd * cat_mult * size_damp
//   growth     = clamp(change_7d, -60, +100) per cent, null treated as neutral
//   growth_x   = 1 + 0.22 * tanh(growth / 18)
//   maturity_x = age known: 0.82 + 0.36 * min(age, 1460) / 1460; age unknown: 1.00
//   implied    = round(base * growth_x * maturity_x), clamped to [1, 100,000,000,000,000]
//
// WHY EACH TERM IS THERE
// * TVL is the protocol's own measure of economic activity: the more value it already secures, the more
//   the market would pay for a claim on it.
// * The category multiple is the exchange rate between TVL and fully diluted value. It is learned from
//   the snapshot's token-bearing protocols, not assumed: a DEX and a lending market do not earn the same
//   multiple per dollar of TVL. The estimator is deliberately robust:
//     1. take each token-bearing peer's mcap_usd / tvl_usd, dropping impossible ratios (<0.01 or >8) and
//        peers below $1M TVL;
//     2. take the median, then drop peers more than 3 scaled MADs from it (MAD floor 0.01) so one
//        mispriced or low-float token cannot move the category;
//     3. shrink the surviving median toward a stated category prior with weight n / (n + 4), where n is
//        the number of surviving peers: 4 peers move the multiple 50% of the way, 12 peers 75%;
//     4. cap the peer median to [0.04, 1.00].
//   A category with fewer than two peers keeps its prior. A category with no stated prior starts from
//   the snapshot-wide robust median, so even an unfamiliar category is anchored in the data.
// * Size damping is a second-order correction: at equal TVL multiples, token markets pay a little less
//   per dollar as protocols get very large (a $100B protocol cannot grow its FDV/TVL like a $100M one).
//   The elasticity is -0.06, so a 10x larger TVL cuts the multiple by about 13%, not by half.
// * Seven-day growth is a momentum term, but it is deliberately bounded. A +400% week is usually a
//   one-off inflow or an incentive program, not a durable re-rating; tanh compresses the tails and the
//   clamp keeps a bad print from producing a negative or absurd value. Null growth is neutral and the
//   detail view says so. The maximum swing is +/-22%.
// * Age with no token is the track-record term. A protocol that has run for years without a token has
//   the record a launch would be judged on; a protocol listed last month has not. The term spans
//   0.82 to 1.18 over four years because age is a confidence adjustment, not the main driver. A missing
//   listing day is treated as neutral, never as a young protocol.
// * Token presence is a gate, not a multiplier: protocols whose snapshot record carries a token (mcap,
//   CoinGecko id or symbol) are never ranked as pre-token. Their market caps are shown in the Live token
//   view, and their FDV/TVL ratios are the calibration sample for the model.
//
// The result is deterministic: the same snapshot and constants produce the same rows, in the same order,
// every run. No network, no clock, no random source, no name list.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants. The dashboard states them and the code reads them from one place. */
export interface ModelConstants {
  growth_weight: number;
  growth_scale: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_ceiling: number;
  maturity_days: number;
  size_reference_usd: number;
  size_elasticity: number;
  size_damping_min: number;
  size_damping_max: number;
  calibration_shrink_k: number;
  calibration_min_comps: number;
  calibration_outlier_mad: number;
  calibration_mad_floor: number;
  calibration_min_multiple: number;
  calibration_max_multiple: number;
  calibration_ratio_floor: number;
  calibration_ratio_cap: number;
  calibration_min_tvl_usd: number;
  max_implied_usd: number;
}

export const MODEL: ModelConstants = {
  growth_weight: 0.22,
  growth_scale: 18,
  growth_floor: -60,
  growth_cap: 100,
  maturity_floor: 0.82,
  maturity_ceiling: 1.18,
  maturity_days: 1460,
  size_reference_usd: 100_000_000,
  size_elasticity: -0.06,
  size_damping_min: 0.55,
  size_damping_max: 1.35,
  calibration_shrink_k: 4,
  calibration_min_comps: 2,
  calibration_outlier_mad: 3,
  calibration_mad_floor: 0.01,
  calibration_min_multiple: 0.04,
  calibration_max_multiple: 1,
  calibration_ratio_floor: 0.01,
  calibration_ratio_cap: 8,
  calibration_min_tvl_usd: 1_000_000,
  max_implied_usd: 100_000_000_000_000,
};

/** The model's version label, shown in the page and stated in the README. */
export const MODEL_VERSION = 'radar-3';

/**
 * Stated priors for the FDV/TVL multiple by DefiLlama category. They are starting points, not verdicts:
 * the observed median of the category's token-bearing peers replaces n/(n+4) of the prior, where n is the
 * number of peers that survive the outlier trim. Categories with no entry start from the snapshot-wide
 * robust median of every token-bearing peer, so the fallback is data too.
 */
export const PRIOR_MULTIPLE: Record<string, number> = {
  Lending: 0.26,
  'Uncollateralized Lending': 0.22,
  'Collateral Markets': 0.24,
  CDP: 0.28,
  'CDP Manager': 0.26,
  Dexs: 0.3,
  Derivatives: 0.28,
  'Interest Rate Derivatives': 0.22,
  'Basis Trading': 0.24,
  Yield: 0.24,
  'Yield Aggregator': 0.26,
  'Leveraged Farming': 0.22,
  Farm: 0.22,
  'Risk Curators': 0.12,
  'Onchain Capital Allocator': 0.14,
  'Liquidity Manager': 0.16,
  RWA: 0.22,
  Indexes: 0.2,
  'Prediction Market': 0.3,
  Chain: 0.3,
  'Staking Pool': 0.18,
  Restaking: 0.2,
  'Liquid Restaking': 0.2,
  'Liquid Staking': 0.18,
  'Options Vault': 0.24,
  Options: 0.24,
  Insurance: 0.2,
  Payments: 0.2,
  Launchpad: 0.22,
  'Token Locker': 0.16,
  Privacy: 0.24,
  'Dual-Token Stablecoin': 0.2,
  'Stablecoin Wrapper': 0.2,
  CeDeFi: 0.2,
  'Decentralized BTC': 0.2,
  'Anchor BTC': 0.18,
};

export const DEFAULT_MULTIPLE = 0.2;

/** Categories that are a product of another protocol's token, never a token launch of their own. */
const PRODUCT_CATEGORY = new Set([
  'CEX',
  'Bridge',
  'Canonical Bridge',
  'Cross Chain Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'Anchor BTC',
]);

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** A wrapped, staked or staking product in the name is not a protocol waiting on its own launch. */
const PRODUCT_NAME = /\b(wrapped|staked|staking)\b/i;

/** An exchange-branded product is an exchange's, not a launch candidate. */
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)/i;

/** How many token-bearing protocols the Live view carries, by market cap. */
export const LIVE_ROWS = 160;

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One token-bearing peer shown beside a category's calibration. */
export interface PeerSample {
  slug: string;
  name: string;
  tvl_usd: number;
  mcap_usd: number;
  mcap_tvl: number;
  change_7d: number | null;
}

/** The calibration of one category: its prior, its live peers, and the multiple the model uses. */
export interface CategoryCalibration {
  category: string;
  prior: number;
  comps: number;
  kept: number;
  observed_median: number | null;
  mad: number | null;
  weight: number;
  multiple: number;
  source: 'prior' | 'shrunk';
  peers: PeerSample[];
}

/** The numbers behind one row's implied value. */
export interface ValueBreakdown {
  implied: number;
  category_multiple: number;
  category_prior: number;
  category_observed: number | null;
  category_comps: number;
  category_kept: number;
  category_weight: number;
  size_damping: number;
  base_value_usd: number;
  growth_pct: number;
  growth_recorded: boolean;
  growth_multiplier: number;
  maturity_multiplier: number;
  age_days: number | null;
}

/** One row of board.json. Extra keys are allowed by the gate and make the model auditable. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  is_watchlist: boolean;
  age_days: number | null;
  implied_value_usd: number;
  model: {
    category_multiple: number;
    category_prior: number;
    category_observed: number | null;
    category_comps: number;
    category_kept: number;
    category_weight: number;
    size_damping: number;
    base_value_usd: number;
    growth_pct: number;
    growth_recorded: boolean;
    growth_multiplier: number;
    maturity_multiplier: number;
  };
  farm_steps: string[];
}

/** The dashboard's compact view of one row. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number | null;
  implied_value_usd: number;
  is_watchlist: boolean;
  category_multiple: number;
  category_prior: number;
  category_observed: number | null;
  category_comps: number;
  category_kept: number;
  category_weight: number;
  size_damping: number;
  base_value_usd: number;
  growth_pct: number;
  growth_recorded: boolean;
  growth_multiplier: number;
  maturity_multiplier: number;
  farm_steps: string[];
}

/** A token-bearing protocol: the market's own value, shown apart from the model's pre-token ranking. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
  mcap_tvl: number | null;
}

/** Everything the dashboard needs: the board, the live set, the calibration and the model. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist_size: number;
  watchlist_covered: number;
  board_size: number;
  early_size: number;
  live_size: number;
  token_count: number;
  category_count: number;
  calibration: CategoryCalibration[];
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** A whole day count from `listed_at` to `as_of`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The median of a non-empty list of finite numbers. */
function median(values: number[]): number {
  const s = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * A robust centre and spread: the median and 1.4826 * median absolute deviation. Values further than
 * `MODEL.calibration_outlier_mad` spreads from the median are dropped when at least five values remain,
 * so a category with two or three peers is not trimmed down to nothing.
 */
function robustCentre(values: number[]): { centre: number; mad: number; kept: number[] } {
  const centre = median(values);
  const spread = median(values.map((v) => Math.abs(v - centre))) * 1.4826;
  const mad = Math.max(spread, MODEL.calibration_mad_floor);
  if (values.length < 5) return { centre, mad, kept: values.slice() };
  const limit = MODEL.calibration_outlier_mad * mad;
  const kept = values.filter((v) => Math.abs(v - centre) <= limit);
  if (kept.length < 3) return { centre, mad, kept: values.slice() };
  return { centre: median(kept), mad, kept };
}

/** Whether a protocol records no token at all: all three token fields are null. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol records a token the model can price against its TVL. */
export function hasToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd !== null || p.gecko_id !== null || p.symbol !== null;
}

/**
 * Whether a protocol is a plausible launch candidate: no token recorded, not an exchange, not a
 * versioned pool, and not a wrapped, staked or bridged product of a token that already trades.
 */
export function isRankable(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (PRODUCT_CATEGORY.has(p.category ?? '')) return false;
  if (VERSIONED.test(p.name)) return false;
  if (PRODUCT_NAME.test(p.name)) return false;
  if (EXCHANGE_PREFIX.test(p.name)) return false;
  return true;
}

/** The calibration table: every category's prior, robust peer median and shrunk multiple. */
export function categoryCalibration(snapshot: Snapshot): CategoryCalibration[] {
  // Every usable token-bearing peer, grouped by category. Impossible ratios are dropped before any
  // statistic is taken; they are data errors (a bad market cap or a dust TVL), not market signals.
  const points = new Map<string, { p: SnapshotProtocol; ratio: number }[]>();
  for (const p of snapshot.protocols) {
    if (p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd < MODEL.calibration_min_tvl_usd) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    if (ratio < MODEL.calibration_ratio_floor || ratio > MODEL.calibration_ratio_cap) continue;
    const category = p.category ?? '(none)';
    const list = points.get(category) ?? [];
    list.push({ p, ratio });
    points.set(category, list);
  }

  // The snapshot-wide robust median is the fallback prior for a category the table does not name.
  const global = robustCentre([...points.values()].flat().map((x) => x.ratio));
  const globalPrior = round4(clamp(global.centre, MODEL.calibration_min_multiple, MODEL.calibration_max_multiple));

  const categories = new Set<string>([...Object.keys(PRIOR_MULTIPLE), ...points.keys()]);
  for (const p of snapshot.protocols) if (p.category !== null) categories.add(p.category);

  const out: CategoryCalibration[] = [];
  for (const category of categories) {
    const prior = PRIOR_MULTIPLE[category] ?? globalPrior;
    const peers = points.get(category) ?? [];
    const ratios = peers.map((x) => x.ratio);
    let observed: number | null = null;
    let keptCount = 0;
    let mad: number | null = null;
    let weight = 0;
    let multiple = prior;
    let source: 'prior' | 'shrunk' = 'prior';
    let keptPeers = peers;
    if (ratios.length >= MODEL.calibration_min_comps) {
      const stat = robustCentre(ratios);
      observed = stat.centre;
      keptCount = stat.kept.length;
      mad = stat.mad;
      weight = keptCount / (keptCount + MODEL.calibration_shrink_k);
      const capped = clamp(observed, MODEL.calibration_min_multiple, MODEL.calibration_max_multiple);
      multiple = prior * (1 - weight) + capped * weight;
      source = 'shrunk';
      const keptSet = new Set(stat.kept);
      keptPeers = peers.filter((x) => keptSet.has(x.ratio));
    }
    // A category that never reached the two-peer threshold has no calibration sample to show: its one
    // peer is an anecdote, and printing it beside a prior-based multiple would imply a fit that is not there.
    const sample = (source === 'shrunk' ? keptPeers : [])
      .slice()
      .sort((a, b) => b.p.tvl_usd - a.p.tvl_usd)
      .slice(0, 6)
      .map((x) => ({
        slug: x.p.slug,
        name: x.p.name,
        tvl_usd: x.p.tvl_usd,
        mcap_usd: x.p.mcap_usd ?? 0,
        mcap_tvl: round4(x.ratio),
        change_7d: x.p.change_7d,
      }));
    out.push({
      category,
      prior: round4(prior),
      comps: ratios.length,
      kept: keptCount,
      observed_median: observed === null ? null : round4(observed),
      mad: mad === null ? null : round4(mad),
      weight: round4(weight),
      multiple: round4(multiple),
      source,
      peers: sample,
    });
  }
  out.sort((a, b) => a.category.localeCompare(b.category));
  return out;
}

/** The implied value of one pre-token protocol under the model, with every factor exposed. */
export function impliedValue(p: SnapshotProtocol, asOf: string, calibration: Map<string, CategoryCalibration>): ValueBreakdown {
  const age = ageDays(asOf, p.listed_at);
  const cal = calibration.get(p.category ?? '(none)');
  const categoryMultiple = cal?.multiple ?? DEFAULT_MULTIPLE;

  const tvl = Math.max(1, p.tvl_usd);
  const sizeDamping = clamp(
    Math.pow(tvl / MODEL.size_reference_usd, MODEL.size_elasticity),
    MODEL.size_damping_min,
    MODEL.size_damping_max,
  );
  const base = tvl * categoryMultiple * sizeDamping;

  const growthRecorded = p.change_7d !== null;
  const rawGrowth = finite(p.change_7d, 0);
  const growthPct = clamp(rawGrowth, MODEL.growth_floor, MODEL.growth_cap);
  const growthMult = 1 + MODEL.growth_weight * Math.tanh(growthPct / MODEL.growth_scale);

  const maturityMult =
    age === null
      ? 1
      : MODEL.maturity_floor +
        ((MODEL.maturity_ceiling - MODEL.maturity_floor) * Math.min(age, MODEL.maturity_days)) / MODEL.maturity_days;

  const implied = clamp(Math.round(base * growthMult * maturityMult), 1, MODEL.max_implied_usd);
  return {
    implied,
    category_multiple: round4(categoryMultiple),
    category_prior: cal?.prior ?? DEFAULT_MULTIPLE,
    category_observed: cal?.observed_median ?? null,
    category_comps: cal?.comps ?? 0,
    category_kept: cal?.kept ?? 0,
    category_weight: cal?.weight ?? 0,
    size_damping: round4(sizeDamping),
    base_value_usd: base,
    growth_pct: round4(growthPct),
    growth_recorded: growthRecorded,
    growth_multiplier: round4(growthMult),
    maturity_multiplier: round4(maturityMult),
    age_days: age,
  };
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text.trim()} Cost: ${step.cost.trim()}. Time: ${step.time.trim()}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

// ---------------------------------------------------------------------------------------------
// Farm plans. Every figure is derived from the protocol's own record: category, first chain, TVL and
// age. A Solana position costs cents and takes one wallet; an Ethereum position costs dollars and needs
// an L1 gas balance; a Base position needs a bridge. The category chooses the actions, the chain chooses
// the setup and the gas, the TVL chooses the position size and the age chooses the hold.

type Family =
  | 'curator'
  | 'lending'
  | 'dex'
  | 'yield'
  | 'rwa'
  | 'basis'
  | 'derivatives'
  | 'stable'
  | 'prediction'
  | 'staking'
  | 'chain'
  | 'insurance'
  | 'payments'
  | 'launchpad'
  | 'governance'
  | 'locker'
  | 'other';

/** The category family that decides which actions a farmer actually takes. */
function familyOf(category: string | null): Family {
  const c = (category ?? '').toLowerCase();
  if (c.includes('curator') || c.includes('allocator') || c.includes('liquidity manager')) return 'curator';
  if (c.includes('basis')) return 'basis';
  if (c.includes('lend') || c.includes('collateral') || c.includes('cdp')) return 'lending';
  if (c.includes('dex') || c.includes('leveraged farm')) return 'dex';
  if (c.includes('yield') || c.includes('farm') || c.includes('vault')) return 'yield';
  if (c.includes('rwa') || c.includes('index')) return 'rwa';
  if (c.includes('derivative') || c.includes('perpetual') || c.includes('option') || c.includes('synthetic')) return 'derivatives';
  if (c.includes('stable') || c.includes('algo-stable')) return 'stable';
  if (c.includes('prediction')) return 'prediction';
  if (c.includes('staking') || c.includes('restak')) return 'staking';
  if (c.includes('chain')) return 'chain';
  if (c.includes('insurance')) return 'insurance';
  if (c.includes('payment') || c.includes('card')) return 'payments';
  if (c.includes('launchpad')) return 'launchpad';
  if (c.includes('governance')) return 'governance';
  if (c.includes('locker')) return 'locker';
  return 'other';
}

type ChainKind = 'ethereum' | 'solana' | 'base' | 'l2' | 'bsc' | 'bitcoin' | 'hyperliquid' | 'alt-l1' | 'other';

/** The chain family that decides wallet setup, bridging and gas. */
function chainKind(chain: string): ChainKind {
  const c = chain.toLowerCase();
  if (c === 'ethereum') return 'ethereum';
  if (c.includes('solana')) return 'solana';
  if (c === 'base') return 'base';
  if (/(arbitrum|optimism|linea|scroll|blast|mantle|zksync|starknet|unichain|ink|soneium|world chain|mode|manta|metis|op mainnet)/.test(c)) return 'l2';
  if (c.includes('binance') || c.includes('bsc')) return 'bsc';
  if (c.includes('bitcoin')) return 'bitcoin';
  if (c.includes('hyperliquid')) return 'hyperliquid';
  if (/(monad|plasma|robinhood|sui|aptos|sei|sonic|berachain|celo|moonbeam|ton|near|tron|bittensor|tempo|katana|arc|corn|plume|megaeth)/.test(c)) return 'alt-l1';
  return 'other';
}

/** A rough cost of one transaction on a chain, in whole dollars (the snapshot carries no gas field). */
function gasUsd(kind: ChainKind): number {
  switch (kind) {
    case 'ethereum':
      return 7;
    case 'solana':
      return 0.01;
    case 'base':
      return 0.02;
    case 'l2':
      return 0.06;
    case 'bsc':
      return 0.18;
    case 'bitcoin':
      return 2.5;
    case 'hyperliquid':
      return 0.01;
    case 'alt-l1':
      return 0.05;
    default:
      return 0.4;
  }
}

/** The chain's gas token, in the words a farmer needs. */
function nativeToken(kind: ChainKind, chain: string): string {
  switch (kind) {
    case 'ethereum':
    case 'base':
    case 'l2':
      return 'ETH';
    case 'solana':
      return 'SOL';
    case 'bsc':
      return 'BNB';
    case 'bitcoin':
      return 'BTC';
    case 'hyperliquid':
      return 'HYPE';
    case 'alt-l1':
      return chain;
    default:
      return chain;
  }
}

/** A readable gas figure, e.g. "$8" or "$0.01". */
function gasText(n: number): string {
  if (n < 0.1) return `$${n.toFixed(2)}`;
  if (n < 1) return `$${n.toFixed(2)}`;
  return `$${Math.round(n)}`;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 500;
  if (p.tvl_usd >= 1_000_000_000) return 300;
  if (p.tvl_usd >= 250_000_000) return 200;
  if (p.tvl_usd >= 50_000_000) return 150;
  return 100;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** Wallet setup and onboarding, chosen by chain. */
function setupText(name: string, kind: ChainKind, chain: string, capital: number, gas: string): string {
  switch (kind) {
    case 'ethereum':
      return `Create a fresh wallet for ${name}, fund it with $${capital} of USDC on Ethereum and keep about $30 of ETH for gas; store the seed phrase offline.`;
    case 'solana':
      return `Create a fresh Solana wallet for ${name}, fund it with $${capital} of USDC and 0.3 SOL for fees; store the seed phrase offline.`;
    case 'base':
      return `Create a fresh wallet, bridge $${capital} of USDC to Base with the official Base Bridge (about $4 and 15 minutes), and keep $3 of ETH on Base for gas.`;
    case 'l2':
      return `Create a fresh wallet, bridge $${capital} of USDC to ${chain} through the official bridge (about $5 and 15-20 minutes), and keep ${gas} of ETH for gas.`;
    case 'bsc':
      return `Create a fresh wallet on BNB Chain, fund it with $${capital} of USDC and about $3 of BNB for gas, and keep the seed phrase offline.`;
    case 'bitcoin':
      return `Create a fresh wallet for ${name}, fund it with $${capital} of the asset ${name} accepts (BTC or USDC) and keep about ${gas} of BTC for network fees.`;
    case 'hyperliquid':
      return `Deposit $${capital} of USDC to Hyperliquid from Arbitrum (about $1 and 5 minutes) and keep $2 for trading fees.`;
    case 'alt-l1':
      return `Create a fresh wallet, bridge $${capital} of USDC to ${chain} through the protocol's official bridge (about $2 and 10 minutes), and keep ${gas} of ${nativeToken(kind, chain)} for fees.`;
    default:
      return `Create a fresh wallet for ${name} on ${chain}, fund it with $${capital} of USDC, and keep about ${gas} of ${nativeToken(kind, chain)} for gas.`;
  }
}

/** The category's primary action, secondary action and recurring action. */
function actionsFor(family: Family, name: string, chain: string, capital: number, native: string, weeks: number): { primary: string; secondary: string; repeat: string } {
  const half = Math.max(25, Math.round(capital / 2 / 25) * 25);
  switch (family) {
    case 'curator':
      return {
        primary: `Read the curator's fee, lockup and vault terms, then deposit $${capital} USDC into one of ${name}'s USDC vaults on ${chain}.`,
        secondary: `Split $${half} USDC into a second ${name} vault run by a different curator so two positions report activity.`,
        repeat: `Claim and restake the vault's rewards every Friday for ${weeks} weeks; a claim is one transaction and leaves a clear record.`,
      };
    case 'lending':
      return {
        primary: `Supply $${capital} USDC to ${name}'s main market on ${chain} and keep the receipt as collateral.`,
        secondary: `Borrow 30% of the deposit in ${native} against it and hold the loan open for at least two weeks.`,
        repeat: `Repay and re-borrow a small amount once a week for ${weeks} weeks so the position stays active; each action is one transaction.`,
      };
    case 'dex':
      return {
        primary: `Provide $${capital} USDC of liquidity to ${name}'s deepest USDC pair on ${chain}.`,
        secondary: `Stake the LP token if ${name} runs a gauge, or open a second narrow-range position with half the capital.`,
        repeat: `Rebalance the range or vote in the gauge once a week for ${weeks} weeks; each rebalance is one transaction.`,
      };
    case 'yield':
      return {
        primary: `Deposit $${capital} USDC into ${name}'s main USDC vault on ${chain} and keep the receipt token.`,
        secondary: `Compound the vault once after the first week and again at the end so two harvests are recorded.`,
        repeat: `Harvest and restake once a week for ${weeks} weeks; record the receipt balance after each harvest.`,
      };
    case 'rwa':
      return {
        primary: `Complete ${name}'s onboarding on ${chain} (expect a KYC or allowlist step) and subscribe $${capital} USDC to its yield-bearing asset.`,
        secondary: `Hold the receipt and make one secondary transfer to a second address you control to prove the position is live.`,
        repeat: `Check ${name}'s subscription calendar once a month for ${weeks} weeks and roll the position when a new series opens.`,
      };
    case 'basis':
      return {
        primary: `Deposit $${capital} USDC into ${name}'s delta-neutral basis strategy on ${chain}.`,
        secondary: `Roll the position once at expiry so the strategy records a second entry rather than one deposit.`,
        repeat: `Roll or rebalance once a month for ${weeks} weeks and keep the hedge within 5% of neutral.`,
      };
    case 'derivatives':
      return {
        primary: `Deposit $${capital} USDC as margin on ${name} (${chain}) and open one small hedge against the position.`,
        secondary: `Open and close one small hedge to create a second recorded action without committing more capital.`,
        repeat: `Roll the hedge once a week for ${weeks} weeks and keep margin above 50% of the maintenance requirement.`,
      };
    case 'stable':
      return {
        primary: `Mint $${capital} of ${name}'s stable asset against collateral on ${chain}.`,
        secondary: `Swap the minted asset once and back through a deep pool so the wallet shows two actions.`,
        repeat: `Check the collateral ratio once a week for ${weeks} weeks and top up if it falls below 150%.`,
      };
    case 'prediction':
      return {
        primary: `Fund $${capital} USDC on ${name} and take one position in a liquid market on ${chain}.`,
        secondary: `Take a second position on another market and hold it to resolution.`,
        repeat: `Resolve or roll one position a week for ${weeks} weeks; keep each trade small relative to the market.`,
      };
    case 'staking':
      return {
        primary: `Stake $${capital} of ${native} through ${name} on ${chain} and keep the receipt token.`,
        secondary: `Delegate to a second validator or restake the receipt if ${name} supports it.`,
        repeat: `Check the validator set and rewards once a week for ${weeks} weeks; move stake if a validator is jailed.`,
      };
    case 'chain':
      return {
        primary: `Bridge $${capital} USDC to ${name} and swap once on a native DEX.`,
        secondary: `Make one lending deposit on ${name} so the wallet shows two kinds of activity.`,
        repeat: `Use one native app a week for ${weeks} weeks and keep a record of each transaction hash.`,
      };
    case 'insurance':
      return {
        primary: `Buy $${capital} of cover from ${name} on ${chain} for the asset you actually hold.`,
        secondary: `Add a second policy on another asset so the wallet has two live positions.`,
        repeat: `Renew or extend one policy a month for ${weeks} weeks and record the premium paid.`,
      };
    case 'payments':
      return {
        primary: `Move $${capital} USDC through ${name}'s payment rail on ${chain}.`,
        secondary: `Repeat one smaller transfer in a later week and keep both receipts.`,
        repeat: `Send one small transfer a week for ${weeks} weeks and keep the receipt for each.`,
      };
    case 'launchpad':
      return {
        primary: `Deposit $${capital} USDC into ${name}'s launch pool on ${chain}.`,
        secondary: `Join a second pool in a later week and keep the position through the snapshot.`,
        repeat: `Check ${name}'s launch calendar once a week for ${weeks} weeks and join only pools you have read.`,
      };
    case 'governance':
      return {
        primary: `Stake or lock $${capital} USDC-equivalent in ${name}'s governance vault on ${chain}.`,
        secondary: `Delegate the voting power to an active delegate and vote once on a live proposal.`,
        repeat: `Vote on every proposal for ${weeks} weeks; each vote is one transaction.`,
      };
    case 'locker':
      return {
        primary: `Lock $${capital} USDC of liquidity through ${name} on ${chain} for the shortest term it offers.`,
        secondary: `Extend the lock once near expiry rather than opening a second lock.`,
        repeat: `Check the unlock schedule once a week for ${weeks} weeks and extend before expiry.`,
      };
    default:
      return {
        primary: `Deposit $${capital} USDC into ${name} on ${chain} and keep the position open.`,
        secondary: `Make a second, smaller deposit after two weeks and keep both positions open.`,
        repeat: `Make one qualifying action a week for ${weeks} weeks: a deposit, a borrow, a swap or a vote, whichever ${name} counts.`,
      };
  }
}

/**
 * A protocol's farm plan: eight steps, each an action with a cost and a time. Every figure is derived
 * from the protocol's own record (category, first chain, TVL, age); no name is hand-written.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const kind = chainKind(chain);
  const native = nativeToken(kind, chain);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gas = gasUsd(kind);
  const gasStr = gasText(gas);
  const weeks = Math.max(2, Math.min(8, Math.round(hold / 14)));
  const family = familyOf(p.category);
  const { primary, secondary, repeat } = actionsFor(family, p.name, chain, capital, native, weeks);
  const setup = setupText(p.name, kind, chain, capital, gasStr);
  const repeatGas = gasText(gas * weeks);
  const yieldForgone = Math.max(1, Math.round((capital * 0.05 * hold) / 365));
  return [
    { text: setup, cost: `$${capital} of capital and about ${gasStr} of gas`, time: '10-15 minutes' },
    { text: primary, cost: `$${capital} of capital plus about ${gasStr} of gas`, time: '15 minutes to set up' },
    { text: secondary, cost: `about ${gasStr} of extra gas, no new capital`, time: '10 minutes' },
    { text: repeat, cost: `about ${repeatGas} of gas over ${weeks} weeks`, time: `10 minutes a week for ${weeks} weeks` },
    {
      text: `Keep at least $${capital} USDC in the position for ${hold} days so it appears in more than one weekly snapshot.`,
      cost: `$${capital} locked for ${hold} days, about $${yieldForgone} of yield forgone at 5% APY`,
      time: `${hold} days`,
    },
    {
      text: `Check ${p.name}'s official docs or announcement page every week for a points, season or airdrop program; record the season number and never pay a claim fee.`,
      cost: 'no fee to check, and never pay to claim',
      time: '5 minutes a week',
    },
    {
      text: `Check ${p.name}'s TVL and withdrawal queue before each deposit; if TVL falls by a fifth or withdrawals pause, exit and record why.`,
      cost: 'nothing but the exit gas',
      time: '5 minutes a month',
    },
    {
      text: `Log the wallet, dates, transaction hashes, gas and rewards for ${p.name} in one sheet, and set a reminder to review the position monthly.`,
      cost: 'nothing but the log',
      time: '15 minutes',
    },
  ];
}

/** The token-bearing protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => hasToken(p) && p.category !== 'CEX' && p.mcap_usd !== null && p.mcap_usd > 0)
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
      mcap_tvl: p.mcap_usd !== null && p.tvl_usd > 0 ? round4(p.mcap_usd / p.tvl_usd) : null,
    }));
}

/** A board row's compact form for data.js. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    is_watchlist: row.is_watchlist,
    category_multiple: row.model.category_multiple,
    category_prior: row.model.category_prior,
    category_observed: row.model.category_observed,
    category_comps: row.model.category_comps,
    category_kept: row.model.category_kept,
    category_weight: row.model.category_weight,
    size_damping: row.model.size_damping,
    base_value_usd: row.model.base_value_usd,
    growth_pct: row.model.growth_pct,
    growth_recorded: row.model.growth_recorded,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    farm_steps: row.farm_steps,
  };
}

/**
 * The board: every watchlist slug (the floor), plus every other pre-token protocol the snapshot carries
 * that is not a wrapped, staked, bridged or versioned product. One sort, one rank per row.
 */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  void model;
  const calibrationRows = categoryCalibration(snapshot);
  const calibration = new Map(calibrationRows.map((c) => [c.category, c]));
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, SnapshotProtocol>();

  // The watchlist is the floor. Every slug is chosen even if a future snapshot's filter would not rank it.
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The radar: every other rankable pre-token protocol in the snapshot, above or below the floor.
  for (const p of snapshot.protocols) {
    if (!chosen.has(p.slug) && isRankable(p)) chosen.set(p.slug, p);
  }

  const watchlist = new Set(snapshot.watchlist);
  const scored = [...chosen.values()].map((p) => ({ p, value: impliedValue(p, snapshot.as_of, calibration) }));
  scored.sort((a, b) => b.value.implied - a.value.implied || b.p.tvl_usd - a.p.tvl_usd || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));

  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    is_watchlist: watchlist.has(s.p.slug),
    age_days: s.value.age_days,
    implied_value_usd: s.value.implied,
    model: {
      category_multiple: s.value.category_multiple,
      category_prior: s.value.category_prior,
      category_observed: s.value.category_observed,
      category_comps: s.value.category_comps,
      category_kept: s.value.category_kept,
      category_weight: s.value.category_weight,
      size_damping: s.value.size_damping,
      base_value_usd: s.value.base_value_usd,
      growth_pct: s.value.growth_pct,
      growth_recorded: s.value.growth_recorded,
      growth_multiplier: s.value.growth_multiplier,
      maturity_multiplier: s.value.maturity_multiplier,
    },
    farm_steps: farmSteps(s.p, s.value.age_days).map(stepText),
  }));
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const calibration = categoryCalibration(snapshot);
  const watchlist = new Set(snapshot.watchlist);
  const early = board.filter((r) => !watchlist.has(r.slug)).length;
  const covered = board.filter((r) => watchlist.has(r.slug)).length;
  const tokenCount = snapshot.protocols.filter((p) => hasToken(p)).length;
  const categoryCount = calibration.filter((c) => c.comps > 0).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    watchlist_covered: covered,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    token_count: tokenCount,
    category_count: categoryCount,
    calibration,
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared value, farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows`;
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    if (!snapshot.protocols.some((p) => p.slug === r.slug)) return `${r.slug} is not a snapshot protocol`;
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.trim().length < 20 || s.trim().length > 600) return `${r.slug} has a farm step of ${s.trim().length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) {
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    }
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
