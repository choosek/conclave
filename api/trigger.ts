/**
 * GET /api/trigger?id=N
 *
 * Full detail for one covenant: meta and hook configuration, the committee laid
 * out slot-by-slot with live share status, the decoded condition, the event
 * timeline, and — once opened — the commitment-verified reveal (payload with the
 * trailing nonce already stripped by the SDK).
 */

import {
  bytesToHex,
  fetchCandidates,
  fetchShares,
  readReveal,
  verifyReveal,
} from "@nillion/blacklight-l1-sdk";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import type { PublicClient } from "viem";
import { covenantState } from "../src/core/covenant.js";
import {
  addresses,
  client,
  formatEth,
  marketLogs,
  pick,
  triggerMarketAbi,
} from "../src/server/chain.js";
import { decodeCondition } from "../src/server/decode.js";
import { fail, queryParam, send } from "../src/server/http.js";
import type {
  CommitteeSlot,
  HookInfo,
  RevealInfo,
  TimelineEntry,
  TriggerDetail,
} from "../src/shared/types.js";

const ZERO = "0x0000000000000000000000000000000000000000";

/** Per-event timeline scans, each filtered by the indexed `triggerId`. */
const TIMELINE_EVENTS = [
  "TriggerPosted",
  "SharePosted",
  "ShareBatchResult",
  "HookInvoked",
  "HookRetried",
  "TriggerResolved",
  "TriggerExpired",
  "RefundIssued",
  "RefundOwed",
  "RefundClaimed",
  "ExpirySharePaid",
] as const;

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
  let hook: unknown;
  let block: Awaited<ReturnType<PublicClient["getBlock"]>>;
  try {
    [meta, hook, block] = await Promise.all([
      pub.readContract({
        address: market,
        abi: triggerMarketAbi,
        functionName: "triggerMeta",
        args: [id],
      }),
      pub
        .readContract({
          address: market,
          abi: triggerMarketAbi,
          functionName: "hookMeta",
          args: [id],
        })
        .catch(() => null),
      pub.getBlock(),
    ]);
  } catch (error) {
    return fail(res, 404, `no covenant #${idRaw}`, (error as Error).message);
  }
  const nowUnix = Number(block.timestamp);

  const m = {
    mode: Number(pick(meta, 0, "mode")),
    k: Number(pick(meta, 1, "k")),
    m: Number(pick(meta, 2, "m")),
    expiry: Number(pick(meta, 3, "expiry")),
    t1: Number(pick(meta, 4, "t1")),
    t2: Number(pick(meta, 5, "t2")),
    commit: pick<string>(meta, 6, "commit"),
    ceiling: pick<bigint>(meta, 7, "ceiling"),
    resolved: Boolean(pick(meta, 8, "resolved")),
    firstShareAt: Number(pick(meta, 9, "firstShareAt")),
    escrow: pick<bigint>(meta, 10, "escrow"),
    refundOwed: pick<bigint>(meta, 11, "refundOwed"),
  };

  // The immutable post: the condition record, committee keyIds, author, layers.
  let posted: {
    recordHex: string | null;
    keyIds: bigint[];
    author: string | null;
    layers: number;
    txHash: string;
  } | null = null;
  try {
    const logs = await marketLogs("TriggerPosted", { triggerId: id });
    if (logs.length) {
      const log = logs[logs.length - 1];
      const keyIds = (log.args.keyIds as bigint[] | undefined) ?? [];
      const layers = (log.args.layers as unknown[] | undefined) ?? [];
      posted = {
        recordHex:
          typeof log.args.publicCondition === "string"
            ? log.args.publicCondition
            : null,
        keyIds,
        author: typeof log.args.author === "string" ? log.args.author : null,
        layers: layers.length,
        txHash: log.transactionHash,
      };
    }
  } catch {
    // Older than the scan window; fall back to meta below.
  }

  const condition = decodeCondition({
    recordHex: posted?.recordHex ?? null,
    mode: m.mode,
    metaT1: m.t1,
    metaT2: m.t2,
  });

  // Shares posted so far, plus a keyId→nodeId map for the full committee layout.
  let shares: Awaited<ReturnType<typeof fetchShares>> = [];
  try {
    shares = await fetchShares(pub, market, id);
  } catch {
    shares = [];
  }
  const shareBySlot = new Map(shares.map((share) => [share.slot, share]));

  let keyIdToNode = new Map<string, bigint>();
  try {
    const candidates = await fetchCandidates(pub, {
      registry: addr.registry,
      staking: addr.staking,
    });
    keyIdToNode = new Map(
      candidates.map((candidate) => [
        String(candidate.keyId),
        candidate.nodeId,
      ]),
    );
  } catch {
    // Committee node ids fall back to share evidence only.
  }

  const committee: CommitteeSlot[] = [];
  for (let slot = 0; slot < m.m; slot++) {
    const keyId = posted?.keyIds?.[slot];
    const postedShare = shareBySlot.get(slot);
    const nodeId =
      postedShare?.nodeId ??
      (keyId !== undefined ? keyIdToNode.get(String(keyId)) : undefined) ??
      null;
    committee.push({
      slot,
      keyId: keyId !== undefined ? String(keyId) : null,
      nodeId: nodeId !== null ? String(nodeId) : null,
      shared: Boolean(postedShare),
    });
  }
  const sharesPosted = shares.length;
  const state = covenantState({
    resolved: m.resolved,
    expiry: m.expiry,
    k: m.k,
    sharesPosted,
    nowUnix,
  });

  // Event timeline.
  let timeline: TimelineEntry[] = [];
  try {
    const perEvent = await Promise.all(
      TIMELINE_EVENTS.map((name) =>
        marketLogs(name, { triggerId: id })
          .then((logs) => logs.map((log) => ({ name, log })))
          .catch(() => []),
      ),
    );
    timeline = perEvent
      .flat()
      .map(({ name, log }) => ({
        type: name,
        block: Number(log.blockNumber),
        logIndex: Number(log.logIndex),
        txHash: log.transactionHash,
        args: serializeArgs(log.args),
      }))
      .sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  } catch {
    timeline = [];
  }

  // Reveal (opened covenants only). verifyReveal checks keccak256(plaintext)==commit.
  let reveal: RevealInfo | null = null;
  if (m.resolved) {
    try {
      const verified = await verifyReveal(pub, market, id).catch(() => null);
      const result = verified ?? (await readReveal(pub, market, id));
      if (result) {
        reveal = {
          verified: Boolean(verified),
          commit: verified?.commit ?? m.commit,
          reconstructor: result.reconstructor,
          usedSlots: result.usedSlots,
          payloadHex: bytesToHex(result.payload),
          payloadLen: result.payload.length,
          plaintextLen: result.plaintext.length,
        };
      }
    } catch {
      reveal = null;
    }
  }

  const hookInfo: HookInfo | null = (() => {
    if (!hook) {
      return null;
    }
    const address = pick<string>(hook, 0, "hook");
    if (!address || address === ZERO) {
      return null;
    }
    return {
      address,
      hookGas: Number(pick(hook, 1, "hookGas")),
      hookOk: Boolean(pick(hook, 2, "hookOk")),
      retryWindow: Number(pick(hook, 3, "retryWindow")),
      retryDeadline: Number(pick(hook, 4, "retryDeadline")) || null,
      bountyOff: Boolean(pick(hook, 5, "bountyOff")),
    };
  })();

  const body: TriggerDetail = {
    id: id.toString(),
    nowUnix,
    state,
    mode: m.mode,
    k: m.k,
    m: m.m,
    sharesPosted,
    expiry: m.expiry,
    firstShareAt: m.firstShareAt || null,
    resolved: m.resolved,
    commit: m.commit,
    author: posted?.author ?? null,
    ceiling: m.ceiling?.toString() ?? "0",
    ceilingGwei:
      m.ceiling !== undefined ? (Number(m.ceiling) / 1e9).toString() : null,
    escrow: m.escrow?.toString() ?? "0",
    escrowEth: formatEth(m.escrow),
    refundOwed: m.refundOwed?.toString() ?? "0",
    refundOwedEth: formatEth(m.refundOwed),
    layers: posted?.layers ?? null,
    postTx: posted?.txHash ?? null,
    condition,
    committee,
    hook: hookInfo,
    reveal,
    timeline,
  };
  return send(res, body);
}

/** Convert event args (bigints, byte strings) to display-safe JSON, dropping the
 *  positional duplicates viem includes alongside the named keys. */
function serializeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args ?? {})) {
    if (/^\d+$/.test(key)) {
      continue;
    }
    if (typeof value === "bigint") {
      out[key] = value.toString();
    } else if (Array.isArray(value)) {
      out[key] = value.map((item) =>
        typeof item === "bigint" ? item.toString() : item,
      );
    } else {
      out[key] = value;
    }
  }
  return out;
}
