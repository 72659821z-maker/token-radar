// Token Radar's value model (radar-2), farm-plan generator and board writer.
//
// WHAT THE BOARD CLAIMS
// A protocol's launch is the token it may issue one day. The model asks a narrower, answerable question:
// if this protocol's present record were priced like the token-bearing protocols around it, what would its
// token be worth? That is an implied value, not a forecast of whether or when a token arrives.
//
// THE MODEL (one function, applied to every row; no protocol name is special-cased)
//
//   age_days   = snapshot.as_of - listed_at, clamped at 0 (null when DefiLlama records no listing day)
//   cat_mult   = the category's FDV/TVL multiple, calibrated from the snapshot's own token-bearing peers
//                when that category has at least four of them, else a stated prior (see PRIOR_MULTIPLE)
//   size_damp  = clamp((tvl_usd / $100M) ^ -0.06, 0.55, 1.35)
//   base       = tvl_usd * cat_mult * size_damp
//   growth     = clamp(change_7d, -50, +80) per cent, null treated as 0
//   growth_x   = 1 + 0.20 * tanh(growth / 20)
//   maturity_x = age known: 0.80 + 0.35 * min(age, 1460) / 1460; age unknown: 1.00
//   implied    = round(base * growth_x * maturity_x), clamped to [1, 100,000,000,000,000]
//
// WHY EACH TERM IS THERE
// * TVL is the protocol's own measure of economic activity: the more value it already secures, the more
//   the market would pay for a claim on it. The category multiple is the exchange rate between TVL and
//   fully diluted value, and it is learned from the snapshot's token-bearing protocols rather than
//   assumed: a DEX and a lending market do not earn the same multiple per dollar of TVL.
// * Size damping is a second-order correction: at equal TVL multiples, token markets pay a little less
//   per dollar as protocols get very large (a $100B protocol cannot grow its FDV/TVL like a $100M one).
//   The elasticity is -0.06, so a 10x larger TVL cuts the multiple by about 13%, not by half.
// * Seven-day growth is a momentum term, but it is deliberately bounded. A +400% week is usually a
//   one-off inflow or an incentive program, not a durable re-rating; tanh compresses the tails and the
//   clamp keeps a bad print from producing a negative or absurd value. Null growth is neutral.
// * Age with no token is the track-record term. A protocol that has run for years without a token has
//   the record a launch would be judged on; a protocol listed last month has not. The term is small
//   (+/- 17.5%) because age is a confidence adjustment, not the main driver. A missing listing day is
//   treated as neutral, never as a young protocol.
// * Token presence is a gate, not a multiplier: protocols whose snapshot record carries a token (mcap,
//   CoinGecko id or symbol) are never ranked as pre-token. Their market caps are shown in the Live
//   token view, and their FDV/TVL ratios are the calibration sample for the model.
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
  calibration_blend: number;
  calibration_min_comps: number;
  calibration_min_multiple: number;
  calibration_max_multiple: number;
  max_implied_usd: number;
}

export const MODEL: ModelConstants = {
  growth_weight: 0.2,
  growth_scale: 20,
  growth_floor: -50,
  growth_cap: 80,
  maturity_floor: 0.8,
  maturity_ceiling: 1.15,
  maturity_days: 1460,
  size_reference_usd: 100_000_000,
  size_elasticity: -0.06,
  size_damping_min: 0.55,
  size_damping_max: 1.35,
  calibration_blend: 0.45,
  calibration_min_comps: 4,
  calibration_min_multiple: 0.05,
  calibration_max_multiple: 0.65,
  max_implied_usd: 100_000_000_000_000,
};

/** The model's version label, shown in the page and stated in the README. */
export const MODEL_VERSION = 'radar-2';

/**
 * Priors for the FDV/TVL multiple by DefiLlama category. These are starting points, not verdicts: when
 * the snapshot carries at least four token-bearing protocols in the same category, the observed median
 * replaces 45% of the prior (see `categoryCalibration`). Categories with no prior use DEFAULT_MULTIPLE.
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

/** How many early protocols the page's "below the floor" count reports. The board carries every candidate. */
export const EARLY_ROWS = 240;

/** How many token-bearing protocols the Live view carries, by market cap. */
export const LIVE_ROWS = 40;

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** The calibration of one category: its prior, its live peers, and the multiple the model uses. */
export interface CategoryCalibration {
  category: string;
  prior: number;
  comps: number;
  observed_median: number | null;
  multiple: number;
  source: 'prior' | 'blended';
}

/** The numbers behind one row's implied value. */
export interface ValueBreakdown {
  implied: number;
  category_multiple: number;
  size_damping: number;
  base_value_usd: number;
  growth_pct: number;
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
    size_damping: number;
    base_value_usd: number;
    growth_pct: number;
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
  size_damping: number;
  base_value_usd: number;
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
  board_size: number;
  early_size: number;
  live_size: number;
  token_count: number;
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

/** The category's multiple, learned from the snapshot's live peers where there are enough of them. */
export function categoryCalibration(snapshot: Snapshot): CategoryCalibration[] {
  const ratios = new Map<string, number[]>();
  for (const p of snapshot.protocols) {
    if (!hasToken(p) || p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    const category = p.category ?? '(none)';
    const list = ratios.get(category) ?? [];
    list.push(p.mcap_usd / p.tvl_usd);
    ratios.set(category, list);
  }
  const categories = new Set<string>([...Object.keys(PRIOR_MULTIPLE), ...ratios.keys()]);
  const out: CategoryCalibration[] = [];
  for (const category of categories) {
    const prior = PRIOR_MULTIPLE[category] ?? DEFAULT_MULTIPLE;
    const peers = ratios.get(category) ?? [];
    const observed = peers.length >= MODEL.calibration_min_comps ? median(peers) : null;
    let multiple = prior;
    if (observed !== null) {
      const capped = clamp(observed, MODEL.calibration_min_multiple, MODEL.calibration_max_multiple);
      multiple = prior * (1 - MODEL.calibration_blend) + capped * MODEL.calibration_blend;
    }
    out.push({
      category,
      prior: round4(prior),
      comps: peers.length,
      observed_median: observed === null ? null : round4(observed),
      multiple: round4(multiple),
      source: observed === null ? 'prior' : 'blended',
    });
  }
  out.sort((a, b) => a.category.localeCompare(b.category));
  return out;
}

/** The implied value of one pre-token protocol under the model. */
export function impliedValue(p: SnapshotProtocol, asOf: string, calibration: Map<string, number>): ValueBreakdown {
  const age = ageDays(asOf, p.listed_at);
  const categoryMultiple = calibration.get(p.category ?? '(none)') ?? DEFAULT_MULTIPLE;

  const tvl = Math.max(1, p.tvl_usd);
  const sizeDamping = clamp(
    Math.pow(tvl / MODEL.size_reference_usd, MODEL.size_elasticity),
    MODEL.size_damping_min,
    MODEL.size_damping_max,
  );
  const base = tvl * categoryMultiple * sizeDamping;

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
    size_damping: round4(sizeDamping),
    base_value_usd: base,
    growth_pct: round4(growthPct),
    growth_multiplier: round4(growthMult),
    maturity_multiplier: round4(maturityMult),
    age_days: age,
  };
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text.trim()} Cost: ${step.cost.trim()}. Time: ${step.time.trim()}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** A rough gas cost for one transaction on a chain, in whole dollars. */
function gasUsd(chain: string): number {
  const c = chain.toLowerCase();
  if (c.includes('ethereum')) return 8;
  if (c.includes('solana')) return 0.05;
  if (c.includes('bsc') || c.includes('bnb')) return 0.5;
  if (c.includes('polygon') || c.includes('avalanche') || c.includes('fantom')) return 0.2;
  if (c.includes('tron')) return 1;
  return 1;
}

/** A readable gas figure, e.g. "$8" or "$0.05". */
function gasText(n: number): string {
  return n < 1 ? `$${n.toFixed(2)}` : `$${Math.round(n)}`;
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 500;
  if (p.tvl_usd >= 1_000_000_000) return 250;
  if (p.tvl_usd >= 250_000_000) return 150;
  if (p.tvl_usd >= 50_000_000) return 100;
  return 75;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The category's main action and its companion action, in words a farmer can follow. */
function actionsFor(p: SnapshotProtocol, capital: number, chain: string): { primary: string; secondary: string } {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) {
    return {
      primary: `Supply $${capital} of USDC to ${name} on ${chain} and keep it as collateral.`,
      secondary: `Borrow up to 35% of the deposit in a second asset and keep the loan open for at least two weeks.`,
    };
  }
  if (c.includes('dex') || c.includes('leveraged farm')) {
    return {
      primary: `Provide $${capital} of liquidity to ${name}'s deepest USDC pair on ${chain}.`,
      secondary: `Stake the LP receipt if ${name} offers it, or add a second position in a correlated pair.`,
    };
  }
  if (c.includes('curator') || c.includes('allocator') || c.includes('liquidity manager')) {
    return {
      primary: `Allocate $${capital} of USDC to one of ${name}'s curated vaults on ${chain}.`,
      secondary: `Split the allocation across two of ${name}'s vaults so both show a live position.`,
    };
  }
  if (c.includes('yield') || c.includes('farm') || c.includes('vault')) {
    return {
      primary: `Deposit $${capital} of USDC into ${name}'s main vault on ${chain}.`,
      secondary: `Compound the rewards once and leave the receipt in the vault for a second snapshot.`,
    };
  }
  if (c.includes('rwa')) {
    return {
      primary: `Mint or subscribe $${capital} of ${name}'s yield-bearing asset on ${chain}.`,
      secondary: `Hold the receipt and make one secondary transfer to prove the position is live.`,
    };
  }
  if (c.includes('basis')) {
    return {
      primary: `Deposit $${capital} of USDC into ${name}'s basis or delta-neutral strategy on ${chain}.`,
      secondary: `Roll the position once at expiry so the strategy records a second entry.`,
    };
  }
  if (c.includes('derivative') || c.includes('perpetual') || c.includes('option') || c.includes('synthetic')) {
    return {
      primary: `Deposit $${capital} of USDC as margin on ${name} on ${chain} and open one small hedge.`,
      secondary: `Open and close one small hedge to create a second recorded action without more capital.`,
    };
  }
  if (c.includes('stable')) {
    return {
      primary: `Mint $${capital} of ${name}'s stable asset against collateral on ${chain}.`,
      secondary: `Move the minted asset through one swap and back so the wallet shows two actions.`,
    };
  }
  if (c.includes('prediction')) {
    return {
      primary: `Fund $${capital} of USDC on ${name} and take one position in a liquid market.`,
      secondary: `Take a second position on another market and hold it to resolution.`,
    };
  }
  if (c.includes('staking') || c.includes('restak')) {
    return {
      primary: `Stake $${capital} of ${chain}'s native asset through ${name} and keep the receipt.`,
      secondary: `Delegate to a second validator or restake the receipt if ${name} supports it.`,
    };
  }
  if (c.includes('chain')) {
    return {
      primary: `Bridge $${capital} of USDC to ${name} and use a native app for one swap.`,
      secondary: `Make one lending deposit on ${name} so the wallet has two kinds of activity.`,
    };
  }
  if (c.includes('insurance')) {
    return {
      primary: `Buy $${capital} of cover from ${name} on ${chain}.`,
      secondary: `Add a second policy on another asset so the wallet has two live positions.`,
    };
  }
  if (c.includes('payment')) {
    return {
      primary: `Move $${capital} of USDC through ${name}'s payment rail on ${chain}.`,
      secondary: `Repeat one smaller transfer in a later week and keep both receipts.`,
    };
  }
  if (c.includes('launchpad')) {
    return {
      primary: `Deposit $${capital} of USDC into ${name}'s launch pool on ${chain}.`,
      secondary: `Join a second pool in a later week and keep the position through the snapshot.`,
    };
  }
  return {
    primary: `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`,
    secondary: `Make a second, smaller deposit after two weeks and keep both positions open.`,
  };
}

/**
 * A protocol's farm plan: seven steps, each an action with a cost and a time. Every figure is derived
 * from the protocol's own record (category, first chain, TVL, age); no name is hand-written.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gas = gasUsd(chain);
  const gasStr = gasText(gas);
  const weeks = Math.max(2, Math.min(8, Math.round(hold / 14)));
  const { primary, secondary } = actionsFor(p, capital, chain);
  return [
    {
      text: `Open a wallet used only for farming ${p.name}, keep its seed phrase offline, and fund it with $${capital} of USDC plus about ${gasStr} of ${chain} gas.`,
      cost: `$${capital} of capital and about ${gasStr} of gas`,
      time: '10 minutes',
    },
    {
      text: primary,
      cost: `$${capital} of capital and about ${gasStr} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: secondary,
      cost: `about ${gasStr} of extra gas, no new capital`,
      time: '10 minutes',
    },
    {
      text: `Make one qualifying action each week for ${weeks} weeks: a deposit, a borrow, a swap or a governance vote, whichever ${p.name} counts.`,
      cost: `about ${gasText(gas * weeks)} of gas over ${weeks} weeks`,
      time: `10 minutes a week for ${weeks} weeks`,
    },
    {
      text: `Hold at least $${capital} in the position for ${hold} days so it appears in more than one snapshot.`,
      cost: `$${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Check ${p.name}'s official points or rewards page once a month, and claim only from the protocol's own site, never from a DM or a paid claim link.`,
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes a month',
    },
    {
      text: `Log the wallet, dates, transaction hashes and rewards for ${p.name} in one sheet, and set a reminder to review the position if its TVL falls by a fifth.`,
      cost: 'nothing but the log',
      time: '15 minutes',
    },
  ];
}

/** The token-bearing protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => hasToken(p) && p.category !== 'CEX')
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
    size_damping: row.model.size_damping,
    base_value_usd: row.model.base_value_usd,
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
  const calibrationRows = categoryCalibration(snapshot);
  const calibration = new Map(calibrationRows.map((c) => [c.category, c.multiple]));
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
      size_damping: s.value.size_damping,
      base_value_usd: s.value.base_value_usd,
      growth_pct: s.value.growth_pct,
      growth_multiplier: s.value.growth_multiplier,
      maturity_multiplier: s.value.maturity_multiplier,
    },
    farm_steps: farmSteps(s.p, s.value.age_days).map(stepText),
  }));
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  void model;
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const calibration = categoryCalibration(snapshot);
  const watchlist = new Set(snapshot.watchlist);
  const early = board.filter((r) => !watchlist.has(r.slug)).length;
  const tokenCount = snapshot.protocols.filter((p) => hasToken(p)).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    token_count: tokenCount,
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
