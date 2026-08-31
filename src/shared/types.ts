/**
 * The wire contract between the serverless API and the browser client.
 *
 * Every `/api` route returns one of these shapes as JSON, and the client
 * consumes them through the typed fetch wrappers in `src/client/api.ts`. Numeric
 * on-chain quantities that can exceed `Number.MAX_SAFE_INTEGER` (escrow, ceiling,
 * threshold, NIL amounts) cross the wire as decimal strings; quantities that are
 * always small (unix seconds, block numbers, share counts, `k`/`m`) cross as
 * numbers. Where a value is also shown to a person, the API sends a preformatted
 * display string alongside the raw one, so the client never re-implements the
 * SDK's number semantics.
 */

/** Covenant lifecycle state, derived from meta, share count, and chain time. */
export type CovenantState =
  | "sealed" // no shares posted yet
  | "collecting" // at least one share, fewer than k
  | "reconstructable" // k or more shares, not yet opened
  | "opened" // resolved: the payload has been revealed
  | "expired"; // past expiry without opening

/** A price clause decoded from a covenant's release condition. */
export interface PriceClause {
  asset: string;
  op: string; // ">=" or "<="
  threshold1e8: string; // raw 10^-8 USD units
  thresholdUsd: string; // exact decimal string for display
}

/** A time-window clause: unix seconds, both bounds present. */
export interface WindowClause {
  t1: number;
  t2: number;
}

/** The decoded release condition. A covenant may carry a price clause, a time
 *  window, or both; a Private covenant's price clause is sealed and reported via
 *  `sealed` rather than `price`. */
export interface DecodedCondition {
  mode: number; // 0 Private, 1 Public
  price: PriceClause | null;
  window: WindowClause | null;
  sealed: boolean;
  raw: string | null; // the 52-byte record as hex, when public
}

/** Settlement-hook configuration and, once resolved, its outcome. */
export interface HookInfo {
  address: string;
  hookGas: number;
  hookOk: boolean;
  retryWindow: number;
  retryDeadline: number | null;
  bountyOff: boolean;
}

/** One row of the covenant feed. */
export interface Covenant {
  id: string;
  author: string | null;
  mode: number;
  k: number;
  m: number;
  sharesPosted: number;
  slots: number[];
  expiry: number;
  firstShareAt: number | null;
  resolved: boolean;
  state: CovenantState;
  condition: DecodedCondition;
  escrow: string;
  escrowEth: string | null;
  hook: Pick<
    HookInfo,
    "address" | "hookGas" | "hookOk" | "bountyOff" | "retryDeadline"
  > | null;
}

/** `GET /api/feed`. */
export interface FeedResponse {
  nowUnix: number;
  total: number;
  shown: number;
  covenants: Covenant[];
}

/** One committee slot in the detail view: its assigned key/node and whether a
 *  share has been posted into it. */
export interface CommitteeSlot {
  slot: number;
  keyId: string | null;
  nodeId: string | null;
  shared: boolean;
}

/** One entry in a covenant's event timeline. */
export interface TimelineEntry {
  type: string;
  block: number;
  logIndex: number;
  txHash: string;
  args: Record<string, unknown>;
}

/** The commitment-verified reveal, present once a covenant is opened. */
export interface RevealInfo {
  verified: boolean;
  commit: string;
  reconstructor: string;
  usedSlots: number[];
  payloadHex: string;
  payloadLen: number;
  plaintextLen: number;
}

/** `GET /api/trigger?id=N`. */
export interface TriggerDetail {
  id: string;
  nowUnix: number;
  state: CovenantState;
  mode: number;
  k: number;
  m: number;
  sharesPosted: number;
  expiry: number;
  firstShareAt: number | null;
  resolved: boolean;
  commit: string;
  author: string | null;
  ceiling: string;
  ceilingGwei: string | null;
  escrow: string;
  escrowEth: string | null;
  refundOwed: string;
  refundOwedEth: string | null;
  layers: number | null;
  postTx: string | null;
  condition: DecodedCondition;
  committee: CommitteeSlot[];
  hook: HookInfo | null;
  reveal: RevealInfo | null;
  timeline: TimelineEntry[];
}

/** One ERC-20 transfer observed in a simulated settlement trace. */
export interface TransferInfo {
  token: string;
  from: string;
  to: string;
  value: string;
}

/** `GET /api/simulate?id=N`.
 *
 *  Before k shares are posted the payload is not reconstructable and only the
 *  first three fields plus `note` are populated; once it is, the settlement
 *  verdict and the hook outcome are filled in. */
export interface SimulateResponse {
  id: string;
  resolved: boolean;
  reconstructable: boolean;
  sharesPosted?: number;
  k?: number;
  note?: string;
  usedSlots?: number[];
  payload?: { hex: string; len: number; plaintextLen: number };
  hook?: { address: string; hookGas: number | null; bountyOff: boolean } | null;
  settlement?: { willSettle: boolean; revert?: string; error?: string | null };
  hookOutcome?: {
    acknowledged: boolean;
    reverts?: boolean;
    revert?: string;
    returned?: string;
    note: string;
  } | null;
  transfers?: TransferInfo[] | null;
  traceNote?: string | null;
  mev?: {
    reconstructableNow: boolean;
    openForSecs: number | null;
    note: string;
  };
}

/** The resolved on-chain module set, read off C0. */
export interface Addresses {
  config: string;
  market: string;
  registry: string;
  staking: string;
  emissions: string;
  nil: string;
}

/** The `ProtocolConfig` parameters surfaced in the deployment strip. */
export interface ProtocolParams {
  protocolFee: string | null;
  protocolFeeNil: string | null;
  defaultHookGas: number | null;
  maxHookGas: number | null;
  maxM: number | null;
  maxRetryWindowSecs: number | null;
  keyTTLSecs: number | null;
  minStake: string | null;
  minStakeNil: string | null;
  maxPlaintextBytes: number | null;
}

/** The fleet-liveness verdict from `deriveLivePin`. */
export interface FleetInfo {
  verdict: string; // "serving" | "down" | "idle" | "unknown"
  liveNodes?: number;
  window?: {
    fromBlock: string;
    toBlock: string;
    lookbackSecs: string;
    triggersPosted: number;
    sharesSeen: number;
  };
  detail?: string;
}

/** One row of the candidate-committee summary. */
export interface NodeRow {
  nodeId: string;
  keyId: string;
  keyCount: number;
  stake: string;
  stakeDisplay: string | null;
  markup: number;
  fired: string;
  retired: boolean;
  operator: string | null;
}

/** `GET /api/config`. `live` is the headline: it is `true` only when C0 resolves
 *  to a fully wired deployment. */
export interface ConfigResponse {
  chainId: number;
  config: string;
  live: boolean;
  code?: "rpc_unreachable" | "unwired";
  reason?: string;
  detail?: string;
  addresses?: Addresses;
  params?: ProtocolParams;
  fleet?: FleetInfo | null;
  nodes?: {
    total: number | null;
    active?: number;
    rows?: NodeRow[];
    detail?: string;
  } | null;
}

/** A keeper action the browser can sign. */
export type KeeperAction = "reveal" | "retry" | "settle";

/** `POST /api/keeper-tx`. `tx` is ready to hand to `eth_sendTransaction`; the
 *  server has already dry-run it, and `simulated` is `"ok"` or the decoded
 *  reason it would revert. */
export interface KeeperTxResponse {
  action: KeeperAction;
  id: string;
  tx: { to: string; data: string; value: string; chainId: number };
  simulated: string;
  note: string;
}

/** The uniform error body every route returns on failure. */
export interface ErrorResponse {
  error: string;
  detail?: string;
}
