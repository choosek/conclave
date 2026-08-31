/**
 * GET /api/simulate?id=N
 *
 * The X-ray: the one thing no other tool can do, because only Blacklight produces
 * the moment it needs. Between the k-th share landing and the reveal executing,
 * the payload is reconstructable but has not run yet. Here it is reconstructed
 * locally, then the real settlement path is dry-run to report what the reveal will
 * do — and how long that has already been public to everyone else.
 *
 * The verdict comes from an `eth_call` of the actual `post_result` (SDK ABI, never
 * transcribed), so a revert decodes against the protocol's own errors. The hook
 * outcome is isolated with a second call to `onReveal`, because a hook that
 * declines still lets `post_result` succeed — `HookInvoked.ok` means acknowledged,
 * not succeeded. Token movements come from a best-effort trace and degrade to
 * "unavailable on this RPC" rather than being guessed.
 */

import {
  bytesToHex,
  fetchShares,
  NONCE_BYTES,
  reconstructLocally,
} from "@nillion/blacklight-l1-sdk";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { type Abi, decodeFunctionResult, encodeFunctionData } from "viem";
import {
  addresses,
  client,
  HOOK_ACK,
  pick,
  triggerMarketAbi,
} from "../src/server/chain.js";
import { decodeRevert } from "../src/server/decode.js";
import { fail, queryParam, send } from "../src/server/http.js";
import type { SimulateResponse, TransferInfo } from "../src/shared/types.js";

const ZERO = "0x0000000000000000000000000000000000000000";
/** Any address; `post_result` is permissionless, so the caller does not matter. */
const SIM_FROM = "0x000000000000000000000000000000000000dEaD" as const;
/** `Transfer(address,address,uint256)`. */
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** The integrator hook interface (universal, per the reveal contract). Used only
 *  to encode an isolated `onReveal` dry-run; it is not a protocol event, so the
 *  topic-collision concern that governs the protocol ABIs does not apply. */
const REVEAL_HOOK_ABI = [
  {
    type: "function",
    name: "onReveal",
    stateMutability: "nonpayable",
    inputs: [
      { name: "triggerId", type: "uint256" },
      { name: "plaintext", type: "bytes" },
    ],
    outputs: [{ name: "", type: "bytes4" }],
  },
] as const satisfies Abi;

/** A single call frame from a `callTracer` trace, with optional emitted logs. */
interface TraceFrame {
  logs?: { address?: string; topics?: string[]; data?: string }[];
  calls?: TraceFrame[];
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  const idRaw = queryParam(req, "id");
  if (idRaw === null || idRaw === "") {
    return fail(res, 400, "missing ?id");
  }
  let id: bigint;
  try {
    id = BigInt(idRaw);
  } catch {
    return fail(res, 400, "id must be an integer");
  }

  let addr: Awaited<ReturnType<typeof addresses>>;
  try {
    addr = await addresses();
  } catch (error) {
    return fail(res, 502, "not on a live deployment", (error as Error).message);
  }
  const pub = client();
  const market = addr.market as `0x${string}`;

  let meta: unknown;
  let block: Awaited<ReturnType<typeof pub.getBlock>>;
  try {
    [meta, block] = await Promise.all([
      pub.readContract({
        address: market,
        abi: triggerMarketAbi,
        functionName: "triggerMeta",
        args: [id],
      }),
      pub.getBlock(),
    ]);
  } catch (error) {
    return fail(res, 404, `no covenant #${idRaw}`, (error as Error).message);
  }
  const nowUnix = Number(block.timestamp);
  const k = Number(pick(meta, 1, "k"));
  const commit = pick<string>(meta, 6, "commit");
  const resolved = Boolean(pick(meta, 8, "resolved"));
  const firstShareAt = Number(pick(meta, 9, "firstShareAt"));

  // Already opened: the plaintext is public on-chain, so there is nothing to preview.
  if (resolved) {
    const body: SimulateResponse = {
      id: id.toString(),
      resolved: true,
      reconstructable: false,
      note: "Covenant already opened; read the reveal in detail.",
    };
    return send(res, body);
  }

  let shares: Awaited<ReturnType<typeof fetchShares>> = [];
  try {
    shares = await fetchShares(pub, market, id);
  } catch {
    shares = [];
  }
  const sharesPosted = shares.length;

  if (sharesPosted < k) {
    const body: SimulateResponse = {
      id: id.toString(),
      resolved: false,
      reconstructable: false,
      sharesPosted,
      k,
      note: `Sealed to the committee — ${sharesPosted} of ${k} shares posted. Nothing is reconstructable until the k-th lands.`,
    };
    return send(res, body);
  }

  // k or more shares: reconstruct the committed plaintext locally (free).
  let reconstruction: ReturnType<typeof reconstructLocally>;
  try {
    reconstruction = reconstructLocally(shares, k, commit as `0x${string}`);
  } catch (error) {
    return fail(res, 500, "reconstruction failed", (error as Error).message);
  }
  if (!reconstruction) {
    const body: SimulateResponse = {
      id: id.toString(),
      resolved: false,
      reconstructable: false,
      sharesPosted,
      k,
      note: "Enough shares are posted, but no valid k-subset reconstructs to the commitment yet (some shares may be malformed).",
    };
    return send(res, body);
  }

  const plaintext = reconstruction.plaintext;
  const payload = plaintext.slice(0, plaintext.length - NONCE_BYTES); // strip the 32-byte nonce
  const plaintextHex = bytesToHex(plaintext);
  const payloadHex = bytesToHex(payload);
  const usedSharesHex = reconstruction.usedShares.map((share) =>
    bytesToHex(share),
  );

  // Hook configuration for this covenant.
  let hookAddress: string | null = null;
  let hookGas: number | null = null;
  let bountyOff = false;
  try {
    const hookMeta = await pub.readContract({
      address: market,
      abi: triggerMarketAbi,
      functionName: "hookMeta",
      args: [id],
    });
    hookAddress = pick<string>(hookMeta, 0, "hook");
    hookGas = Number(pick(hookMeta, 1, "hookGas"));
    bountyOff = Boolean(pick(hookMeta, 5, "bountyOff"));
    if (hookAddress === ZERO) {
      hookAddress = null;
    }
  } catch {
    // Leave hook fields at their defaults.
  }

  // Primary verdict: dry-run the real settlement path (post_result).
  const settleData = encodeFunctionData({
    abi: triggerMarketAbi,
    functionName: "post_result",
    args: [id, plaintextHex, reconstruction.usedSlots, usedSharesHex],
  });
  let settlement: SimulateResponse["settlement"];
  try {
    await pub.call({ account: SIM_FROM, to: market, data: settleData });
    settlement = { willSettle: true };
  } catch (error) {
    const decoded = decodeRevert(error);
    settlement = {
      willSettle: false,
      revert: decoded.message,
      error: decoded.name,
    };
  }

  // Isolate the hook outcome: onReveal(id, plaintext) from the market.
  let hookOutcome: SimulateResponse["hookOutcome"] = null;
  if (hookAddress) {
    try {
      const data = encodeFunctionData({
        abi: REVEAL_HOOK_ABI,
        functionName: "onReveal",
        args: [id, plaintextHex],
      });
      const returned = await pub.call({
        account: market,
        to: hookAddress as `0x${string}`,
        data,
      });
      const returnData = returned?.data ?? "0x";
      let acknowledged = false;
      try {
        const decoded = decodeFunctionResult({
          abi: REVEAL_HOOK_ABI,
          functionName: "onReveal",
          data: returnData,
        });
        acknowledged = String(decoded).toLowerCase() === HOOK_ACK;
      } catch {
        acknowledged = String(returnData).toLowerCase().startsWith(HOOK_ACK);
      }
      hookOutcome = {
        acknowledged,
        returned: returnData,
        note: acknowledged
          ? "Hook returns HOOK_ACK — it will act (or decide to do nothing) and settle."
          : "Hook does NOT return HOOK_ACK — it declines; the reveal still succeeds but nothing settles.",
      };
    } catch (error) {
      const decoded = decodeRevert(error);
      hookOutcome = {
        acknowledged: false,
        reverts: true,
        revert: decoded.message,
        note: "Hook reverts in isolation — a reverting hook cannot be told from a gas-starved one.",
      };
    }
  }

  // Best-effort token movements via a call trace (many RPCs disallow this).
  let transfers: TransferInfo[] | null = null;
  let traceNote: string | null = null;
  try {
    const request = pub.request as unknown as (args: {
      method: string;
      params: unknown[];
    }) => Promise<unknown>;
    const trace = (await request({
      method: "debug_traceCall",
      params: [
        { from: SIM_FROM, to: market, data: settleData },
        "latest",
        { tracer: "callTracer", tracerConfig: { withLog: true } },
      ],
    })) as TraceFrame;
    transfers = extractTransfers(trace);
  } catch {
    traceNote =
      "Token-movement trace not available on this RPC endpoint — verdict above is unaffected.";
  }

  const openForSecs = firstShareAt ? Math.max(0, nowUnix - firstShareAt) : null;

  const body: SimulateResponse = {
    id: id.toString(),
    resolved: false,
    reconstructable: true,
    sharesPosted,
    k,
    usedSlots: reconstruction.usedSlots,
    payload: {
      hex: payloadHex,
      len: payload.length,
      plaintextLen: plaintext.length,
    },
    hook: hookAddress ? { address: hookAddress, hookGas, bountyOff } : null,
    settlement,
    hookOutcome,
    transfers,
    traceNote,
    mev: {
      reconstructableNow: true,
      openForSecs,
      note:
        "This payload is reconstructable by anyone right now and executes at least one block later. " +
        "The order is public before it runs; slippage on any swap is the extraction cap, not gas price.",
    },
  };
  return send(res, body);
}

/** Flatten a `callTracer` (withLog) trace and pull ERC-20 Transfer events. */
function extractTransfers(trace: TraceFrame): TransferInfo[] {
  const out: TransferInfo[] = [];
  const visit = (frame: TraceFrame | undefined): void => {
    if (!frame) {
      return;
    }
    for (const log of frame.logs ?? []) {
      const topics = log.topics ?? [];
      if (
        topics[0]?.toLowerCase() === TRANSFER_TOPIC &&
        topics.length >= 3 &&
        log.address
      ) {
        out.push({
          token: log.address,
          from: `0x${topics[1].slice(26)}`,
          to: `0x${topics[2].slice(26)}`,
          value:
            log.data && log.data !== "0x" ? BigInt(log.data).toString() : "0",
        });
      }
    }
    for (const call of frame.calls ?? []) {
      visit(call);
    }
  };
  visit(trace);
  return out;
}
