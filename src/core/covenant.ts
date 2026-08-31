/**
 * The covenant lifecycle, reduced to a single derived state.
 *
 * A covenant moves through a fixed progression — sealed, then collecting shares,
 * then reconstructable once the k-th lands, then either opened or (if its window
 * closed first) expired. The rest of the app keys off this one label: the feed
 * tag, the detail header, and whether the X-ray or a keeper action applies. The
 * derivation is a pure function of the on-chain facts plus chain time, so it is
 * computed once on the server and tested here against every ordering.
 */

import type { CovenantState } from "../shared/types.js";

/** The on-chain facts the state is derived from. `nowUnix` must be chain time
 *  (the latest block's timestamp), because expiry is a comparison the contract
 *  makes against `block.timestamp`, not against the wall clock. */
export interface CovenantFacts {
  resolved: boolean;
  expiry: number;
  k: number;
  sharesPosted: number;
  nowUnix: number | null;
}

/**
 * Reduce a covenant's facts to its lifecycle state.
 *
 * `resolved` wins over everything: an opened covenant is `opened` regardless of
 * its clock. Otherwise a covenant past its `expiry` is `expired` (the shares it
 * has no longer matter). Below expiry, `k` reached (`sharesPosted >= k`, `k > 0`)
 * is `reconstructable`; any shares at all is `collecting`; none is `sealed`.
 */
export function covenantState(facts: CovenantFacts): CovenantState {
  const { resolved, expiry, k, sharesPosted, nowUnix } = facts;
  if (resolved) {
    return "opened";
  }
  if (expiry && nowUnix !== null && nowUnix > expiry) {
    return "expired";
  }
  if (k > 0 && sharesPosted >= k) {
    return "reconstructable";
  }
  if (sharesPosted > 0) {
    return "collecting";
  }
  return "sealed";
}
