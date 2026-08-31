/**
 * GET /api/config
 *
 * Reports whether the app is pointed at the live deployment and the chain
 * parameters Conclave reads rather than hard-codes: the module set resolved off
 * C0, the `ProtocolConfig` getters, the fleet-liveness verdict, and a summary of
 * the candidate committee. Each read is wrapped so one failure degrades a single
 * field instead of the whole panel; a failure to resolve C0 at all is reported as
 * either an unreachable RPC or a genuinely unwired config, since those call for
 * different fixes.
 */

import {
  deriveLivePin,
  fetchCandidates,
  summariseCandidates,
} from "@nillion/blacklight-l1-sdk";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import type { PublicClient } from "viem";
import {
  addresses,
  C0,
  CHAIN_ID,
  client,
  formatNilDisplay,
  protocolConfigAbi,
} from "../src/server/chain";
import { send } from "../src/server/http";
import type {
  ConfigResponse,
  FleetInfo,
  ProtocolParams,
} from "../src/shared/types";

/** Read one `ProtocolConfig` getter, returning `null` rather than throwing. */
async function readParam(
  pub: PublicClient,
  config: `0x${string}`,
  name: string,
): Promise<unknown> {
  try {
    return await pub.readContract({
      address: config,
      abi: protocolConfigAbi,
      // `name` is dynamic; the getters it names all take no arguments.
      functionName: name as never,
    });
  } catch {
    return null;
  }
}

const asNumber = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);
const asString = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);

export default async function handler(
  _req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  const pub = client();

  let addr: Awaited<ReturnType<typeof addresses>>;
  try {
    addr = await addresses();
  } catch (error) {
    const message = String((error as Error).message ?? error);
    // A transport failure ("RPC down") is not an unwired config; say which.
    const transport =
      /HTTP request failed|fetch failed|request failed|ECONNREFUSED|timeout/i.test(
        message,
      );
    const body: ConfigResponse = {
      chainId: CHAIN_ID,
      config: C0,
      live: false,
      code: transport ? "rpc_unreachable" : "unwired",
      reason: transport
        ? "RPC endpoint unreachable — set SEPOLIA_RPC_URL to a working Sepolia provider"
        : "config holds no wired deployment — pointed at a superseded or wrong address",
      detail: message.slice(0, 200),
    };
    return send(res, body);
  }

  const config = addr.config as `0x${string}`;
  const [
    protocolFee,
    defaultHookGas,
    maxHookGas,
    maxM,
    maxRetryWindowSecs,
    keyTTL,
    minStake,
    maxPlaintextBytes,
  ] = await Promise.all([
    readParam(pub, config, "protocolFee"),
    readParam(pub, config, "defaultHookGas"),
    readParam(pub, config, "maxHookGas"),
    readParam(pub, config, "maxM"),
    readParam(pub, config, "maxRetryWindowSecs"),
    readParam(pub, config, "keyTTL"),
    readParam(pub, config, "minStake"),
    readParam(pub, config, "maxPlaintextBytes"),
  ]);

  const params: ProtocolParams = {
    protocolFee: asString(protocolFee),
    protocolFeeNil: formatNilDisplay(protocolFee as bigint | null),
    defaultHookGas: asNumber(defaultHookGas),
    maxHookGas: asNumber(maxHookGas),
    maxM: asNumber(maxM),
    maxRetryWindowSecs: asNumber(maxRetryWindowSecs),
    keyTTLSecs: asNumber(keyTTL),
    minStake: asString(minStake),
    minStakeNil: formatNilDisplay(minStake as bigint | null),
    maxPlaintextBytes: asNumber(maxPlaintextBytes),
  };

  // Fleet liveness — read the verdict before trusting node counts.
  let fleet: FleetInfo;
  try {
    const pin = await deriveLivePin(pub, {
      registry: addr.registry,
      staking: addr.staking,
      market: addr.market,
      config: addr.config,
    });
    fleet = {
      verdict: pin.fleet,
      liveNodes: pin.nodeIds.length,
      window: {
        fromBlock: pin.window.fromBlock.toString(),
        toBlock: pin.window.toBlock.toString(),
        lookbackSecs: pin.window.lookbackSecs.toString(),
        triggersPosted: pin.window.triggersPosted,
        sharesSeen: pin.window.sharesSeen,
      },
    };
  } catch (error) {
    fleet = {
      verdict: "unknown",
      detail: String((error as Error).message ?? error).slice(0, 120),
    };
  }

  // Candidate committee — one display row per node.
  let nodes: ConfigResponse["nodes"];
  try {
    const candidates = await fetchCandidates(pub, {
      registry: addr.registry,
      staking: addr.staking,
    });
    const rows = summariseCandidates(candidates);
    nodes = {
      total: rows.length,
      active: rows.filter((row) => !row.retired).length,
      rows: rows.slice(0, 40).map((row) => ({
        nodeId: row.nodeId.toString(),
        keyId: row.keyId.toString(),
        keyCount: row.keyCount,
        stake: row.stake.toString(),
        stakeDisplay: formatNilDisplay(row.stake),
        markup: row.markup,
        fired: row.fired.toString(),
        retired: row.retired,
        operator: row.operator ?? null,
      })),
    };
  } catch (error) {
    nodes = {
      total: null,
      detail: String((error as Error).message ?? error).slice(0, 120),
    };
  }

  const body: ConfigResponse = {
    chainId: CHAIN_ID,
    config: C0,
    live: true,
    addresses: {
      config: addr.config,
      market: addr.market,
      registry: addr.registry,
      staking: addr.staking,
      emissions: addr.emissions,
      nil: addr.nil,
    },
    params,
    fleet,
    nodes,
  };
  return send(res, body);
}
