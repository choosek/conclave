/**
 * GET /api/feed?limit=25
 *
 * The covenant feed — Conclave's home view, and the piece the CLI has no analog
 * for (it is per-id only). Discovery uses `nextTriggerId()` + `triggerMeta(id)`,
 * so the list never depends on an `eth_getLogs` window; only the price records and
 * live share counts come from two bounded scans that degrade gracefully.
 */

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
import type { Covenant, FeedResponse } from "../src/shared/types.js";

const ZERO = "0x0000000000000000000000000000000000000000";

/** The mutable and immutable meta a feed row is built from. */
interface Meta {
  id: bigint;
  mode: number;
  k: number;
  m: number;
  expiry: number;
  t1: number;
  t2: number;
  commit: string;
  ceiling: bigint;
  resolved: boolean;
  firstShareAt: number;
  escrow: bigint;
  refundOwed: bigint;
  hook: {
    address: string;
    hookGas: number;
    hookOk: boolean;
    bountyOff: boolean;
    retryDeadline: number;
  } | null;
}

async function readMeta(
  pub: PublicClient,
  market: `0x${string}`,
  id: bigint,
): Promise<Meta> {
  const [meta, hook] = await Promise.all([
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
  ]);
  return {
    id,
    mode: Number(pick(meta, 0, "mode")),
    k: Number(pick(meta, 1, "k")),
    m: Number(pick(meta, 2, "m")),
    expiry: Number(pick(meta, 3, "expiry")),
    t1: Number(pick(meta, 4, "t1")),
    t2: Number(pick(meta, 5, "t2")),
    commit: pick(meta, 6, "commit"),
    ceiling: pick(meta, 7, "ceiling"),
    resolved: Boolean(pick(meta, 8, "resolved")),
    firstShareAt: Number(pick(meta, 9, "firstShareAt")),
    escrow: pick(meta, 10, "escrow"),
    refundOwed: pick(meta, 11, "refundOwed"),
    hook: hook
      ? {
          address: pick(hook, 0, "hook"),
          hookGas: Number(pick(hook, 1, "hookGas")),
          hookOk: Boolean(pick(hook, 2, "hookOk")),
          bountyOff: Boolean(pick(hook, 5, "bountyOff")),
          retryDeadline: Number(pick(hook, 4, "retryDeadline")),
        }
      : null,
  };
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  let addr: Awaited<ReturnType<typeof addresses>>;
  try {
    addr = await addresses();
  } catch (error) {
    return fail(res, 502, "not on a live deployment", (error as Error).message);
  }
  const pub = client();
  const market = addr.market as `0x${string}`;
  const limit = Math.max(
    1,
    Math.min(Number(queryParam(req, "limit") ?? 25), 60),
  );

  let next: bigint;
  let block: Awaited<ReturnType<PublicClient["getBlock"]>>;
  try {
    [next, block] = await Promise.all([
      pub.readContract({
        address: market,
        abi: triggerMarketAbi,
        functionName: "nextTriggerId",
      }) as Promise<bigint>,
      pub.getBlock(),
    ]);
  } catch (error) {
    return fail(res, 502, "could not read market", (error as Error).message);
  }
  const nowUnix = Number(block.timestamp);

  const total = Number(next) - 1; // ids are 1-based; nextTriggerId is not yet minted
  if (total <= 0) {
    const empty: FeedResponse = { nowUnix, total: 0, shown: 0, covenants: [] };
    return send(res, empty);
  }

  const ids: bigint[] = [];
  for (let id = total; id > Math.max(0, total - limit); id--) {
    ids.push(BigInt(id));
  }

  // Two bounded scans: the price records (immutable) and the live share slots.
  const [postedLogs, shareLogs] = await Promise.all([
    marketLogs("TriggerPosted").catch(() => []),
    marketLogs("SharePosted").catch(() => []),
  ]);

  const postedById = new Map<
    string,
    { publicCondition: unknown; author: unknown }
  >();
  for (const log of postedLogs) {
    postedById.set(String(log.args.triggerId), {
      publicCondition: log.args.publicCondition,
      author: log.args.author,
    });
  }
  const slotsById = new Map<string, Set<number>>();
  for (const log of shareLogs) {
    const key = String(log.args.triggerId);
    if (!slotsById.has(key)) {
      slotsById.set(key, new Set());
    }
    slotsById.get(key)?.add(Number(log.args.slot));
  }

  const metas = await Promise.all(
    ids.map((id) => readMeta(pub, market, id).catch(() => null)),
  );

  const covenants: Covenant[] = metas
    .filter((meta): meta is Meta => meta !== null)
    .map((meta) => {
      const key = String(meta.id);
      const posted = postedById.get(key);
      const slots = slotsById.get(key) ?? new Set<number>();
      const sharesPosted = slots.size;
      const state = covenantState({
        resolved: meta.resolved,
        expiry: meta.expiry,
        k: meta.k,
        sharesPosted,
        nowUnix,
      });
      const condition = decodeCondition({
        recordHex:
          typeof posted?.publicCondition === "string"
            ? posted.publicCondition
            : null,
        mode: meta.mode,
        metaT1: meta.t1,
        metaT2: meta.t2,
      });
      const hook =
        meta.hook?.address && meta.hook.address !== ZERO
          ? {
              address: meta.hook.address,
              hookGas: meta.hook.hookGas,
              hookOk: meta.hook.hookOk,
              bountyOff: meta.hook.bountyOff,
              retryDeadline: meta.hook.retryDeadline || null,
            }
          : null;
      return {
        id: meta.id.toString(),
        author: typeof posted?.author === "string" ? posted.author : null,
        mode: meta.mode,
        k: meta.k,
        m: meta.m,
        sharesPosted,
        slots: [...slots].sort((a, b) => a - b),
        expiry: meta.expiry,
        firstShareAt: meta.firstShareAt || null,
        resolved: meta.resolved,
        state,
        condition,
        escrow: meta.escrow.toString(),
        escrowEth: formatEth(meta.escrow),
        hook,
      };
    });

  const body: FeedResponse = {
    nowUnix,
    total,
    shown: covenants.length,
    covenants,
  };
  return send(res, body);
}
