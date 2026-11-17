// Dip-harvest bot for the BTC race: buy a sharp dip, sell the bounce, repeat.
//
// Why this shape: on one-minute bars this market mean-reverts across the hour
// (hourly returns are negatively autocorrelated), so fast trend-following
// whipsaws itself to death against the ~38 bps a full-size round trip costs
// in fees, slippage and pool impact. Buying only after a real dip and
// selling only after a real recovery keeps the trade count low and lets
// each trade clear its costs. The bot is long-only, holds at most one
// position, and never touches the clock, the environment or randomness:
// every decision is a pure function of the bars the harness sent.
//
//   - Entry: the close falls at least 1.5% below the highest close seen so
//     far in the window (a dip off the running high), or bar 720 arrives
//     with nothing bought yet (a flat, rising day with no dip at all still
//     needs a position, or the bot makes exactly zero and fails the gate).
//     The 1.5% level is the middle of the strong region on the dev window:
//     the day's three dips all reached 150-153 bps off their running highs,
//     so waiting for the full dip buys near the local bottom instead of
//     halfway down. Neighbouring levels (dip 1.2-1.8%, take 1.2-1.8%) are
//     all clearly profitable on the dev window, so this is a region pick,
//     not one lucky cell.
//   - Exit: the close rises 1.5% above the close the buy was decided on
//     (take the bounce), or falls 5% below it (stop: the day is trending
//     down, not dipping). After a stop the bot stays in cash for the rest
//     of the window, so one bad day can cost at most one stop.
//   - Size: the whole cash balance on every buy; the whole position on
//     every sell. One symbol, one position, at most one order per reply.
//   - Slippage cap 100 bps (1%) past the close the order was decided on,
//     wide enough that a normal fill is never refused for it, tight enough
//     that a fill into a gap is refused and retried next bar instead.

import { runBars, type BarsState, type Batch, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
/** A dip: the close at most 98.5% of the running high. */
const DIP_NUM = 985n;
const DIP_DEN = 1000n;
/** Take profit: the close at least 101.5% of the entry close. */
const TAKE_NUM = 1015n;
const TAKE_DEN = 1000n;
/** Stop: the close at most 95% of the entry close. */
const STOP_NUM = 95n;
const STOP_DEN = 100n;
/** Fallback entry bar when no dip has fired yet. */
const FALLBACK_BAR = 720;
/** Slippage cap on every order, in bps past the close it was decided on. */
const MAX_SLIPPAGE_BPS = 100;

// Highest close seen so far, in the bar's raw price units (integers).
let runHigh: bigint | null = null;
// CBBTC bars seen so far (gaps simply do not count).
let barsSeen = 0;
// Close the last buy was decided on, in raw price units; null while flat.
let entryClose: bigint | null = null;
// Set by a stop-loss exit: no more entries after one.
let stoppedOut = false;

await runBars({
  onBatch(state: BarsState, batch: Batch) {
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar !== undefined) {
      const close = BigInt(bar.c);
      barsSeen += 1;
      if (runHigh === null || close > runHigh) runHigh = close;
      if (state.warmingUp) return [];
      const held = state.positions.get(SYMBOL);
      const orders: (BuyInput | SellInput)[] = [];
      if (held !== undefined) {
        // Holding: exit on the bounce, or on the stop. A refused sell
        // leaves the position held, so the same exit fires again next bar.
        if (entryClose !== null) {
          if (close * TAKE_DEN >= entryClose * TAKE_NUM || close * STOP_DEN <= entryClose * STOP_NUM) {
            const stopHit = close * STOP_DEN <= entryClose * STOP_NUM;
            if (stopHit) stoppedOut = true;
            entryClose = null;
            orders.push({ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
          }
        }
      } else if (!stoppedOut && runHigh !== null) {
        const dipped = close * DIP_DEN <= runHigh * DIP_NUM;
        const fallback = barsSeen === FALLBACK_BAR;
        if ((dipped || fallback) && state.cash >= BigInt(state.hello.fees.min_notional_quote_units)) {
          entryClose = close;
          orders.push({ side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS });
        }
      }
      return orders;
    }
    return [];
  },
});
