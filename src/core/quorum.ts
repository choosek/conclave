/**
 * The model behind Conclave's signature element, the quorum meter.
 *
 * A covenant is sealed to a committee of `m` nodes and opens when any `k` of them
 * post shares. The meter renders that assembly: `m` segments, the first
 * `sharesPosted` of them filled, with a tick marking the `k`-of-`m` threshold —
 * and, the moment the k-th share lands, the whole thing reads as reconstructable.
 * This module computes that geometry as pure data; the client turns the data into
 * markup. Keeping the arithmetic here (rather than in the renderer) is what lets
 * the threshold, clamping, and tick-placement rules be tested exhaustively.
 */

/** The rendered geometry of one quorum meter. */
export interface QuorumModel {
  /** `true` once `k` or more shares are posted: the payload is reconstructable. */
  ready: boolean;
  /** One entry per committee slot, in order; `true` where a share is posted. */
  segments: boolean[];
  /** Horizontal position of the k-of-m tick, as a percentage of the meter's
   *  width, or `null` when a tick would be meaningless (`k` at or beyond `m`, or
   *  degenerate `k`/`m`). */
  tickPercent: number | null;
}

/**
 * Derive the meter geometry from the posted count and the `k`-of-`m` parameters.
 *
 * `sharesPosted` is clamped into `[0, m]` so a stray double-count can never draw
 * more filled segments than the committee has slots, and `k` is treated as
 * reached at `sharesPosted >= k` (with `k > 0`). The tick is placed at the
 * boundary *after* the k-th segment — `k / m` of the width — and omitted when it
 * would sit at or past the end (`k >= m`) or when the parameters are degenerate.
 */
export function quorumModel(
  sharesPosted: number,
  k: number,
  m: number,
): QuorumModel {
  const slots = Math.max(0, Math.floor(m));
  const filled = Math.max(0, Math.min(Math.floor(sharesPosted), slots));
  const threshold = Math.floor(k);

  const segments: boolean[] = [];
  for (let index = 0; index < slots; index++) {
    segments.push(index < filled);
  }

  const ready = threshold > 0 && filled >= threshold;
  const tickPercent =
    threshold > 0 && threshold < slots ? (threshold / slots) * 100 : null;

  return { ready, segments, tickPercent };
}
