/**
 * The Conclave browser client.
 *
 * A dependency-free single-page client that reads JSON from the `/api` routes and
 * talks to the user's wallet directly (via EIP-6963) only for the optional,
 * permissionless keeper actions. Reading anything — the feed, a release's detail,
 * the X-ray — needs no wallet. Rendering reuses the pure `core` helpers so the
 * client and server agree on formatting and on the quorum-meter geometry, and the
 * feed and an unresolved release's detail refresh on a timer while their view is
 * visible, so committee assembly and the reconstructable moment appear live.
 *
 * This module is bundled to `public/app.js` by `scripts/build-client.ts`.
 */

import {
  escapeHtml,
  formatDateUtc,
  formatDuration,
  formatUsd,
  modeLabel,
  relativeTime,
  truncateAddress,
} from "../core/format";
import { quorumModel } from "../core/quorum";
import type {
  ConfigResponse,
  Covenant,
  CovenantState,
  DecodedCondition,
  FeedResponse,
  KeeperAction,
  KeeperTxResponse,
  SimulateResponse,
  TimelineEntry,
  TriggerDetail,
} from "../shared/types";

/* ------------------------------------------------------------------ */
/* Wallet types (EIP-1193 provider, EIP-6963 discovery)               */
/* ------------------------------------------------------------------ */

interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, handler: (...args: unknown[]) => void): void;
}
interface Eip6963ProviderInfo {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
}
interface Eip6963ProviderDetail {
  info: Eip6963ProviderInfo;
  provider: Eip1193Provider;
}

declare global {
  interface WindowEventMap {
    "eip6963:announceProvider": CustomEvent<Eip6963ProviderDetail>;
  }
  interface Window {
    ethereum?: Eip1193Provider;
  }
}

/* ------------------------------------------------------------------ */
/* Constants and small DOM helpers                                    */
/* ------------------------------------------------------------------ */

const SEPOLIA_HEX = "0xaa36a7"; // 11155111
const EXPLORER = "https://sepolia.etherscan.io";
/** Poll cadence for the live views, at Sepolia's ~12s block time. */
const REFRESH_MS = 12000;

/** Get a required element by id, throwing if the markup is missing (a bug, not a
 *  runtime condition), so downstream code needs no null checks. */
function $(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`missing element #${id}`);
  }
  return element;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    throw new Error(body.error ?? response.statusText);
  }
  return body;
}

/* ------------------------------------------------------------------ */
/* Quorum meter — geometry from core, markup here                     */
/* ------------------------------------------------------------------ */

function quorumMeter(
  posted: number,
  k: number,
  m: number,
  options: { mini?: boolean } = {},
): string {
  const model = quorumModel(posted, k, m);
  const segments = model.segments
    .map((filled) => `<div class="qseg${filled ? " filled" : ""}"></div>`)
    .join("");
  const tick =
    model.tickPercent !== null
      ? `<div class="qtick" style="left:${model.tickPercent}%"></div>`
      : "";
  const meter = `<div class="qmeter" data-ready="${model.ready}">${segments}${tick}</div>`;
  if (options.mini) {
    return `<div class="qmini">${meter}</div><div class="qmini-frac"><b>${posted}</b> / ${k} <span style="color:var(--ink4)">of ${m}</span></div>`;
  }
  return `
    <div class="qhead ${model.ready ? "ready" : ""}">
      <span class="frac"><b>${posted}</b> of ${k} shares · committee of ${m}</span>
      <span class="rc">▲ reconstructable</span>
    </div>
    ${meter}`;
}

/* ------------------------------------------------------------------ */
/* Condition + state rendering                                        */
/* ------------------------------------------------------------------ */

function conditionLine(condition: DecodedCondition): string {
  const parts: string[] = [];
  if (condition.price) {
    parts.push(
      `${escapeHtml(condition.price.asset)} <span class="op">${escapeHtml(
        condition.price.op,
      )}</span> ${formatUsd(condition.price.thresholdUsd)}`,
    );
  }
  if (condition.window) {
    parts.push(
      `window ${formatDateUtc(condition.window.t1)} → ${formatDateUtc(
        condition.window.t2,
      )}`,
    );
  }
  if (condition.sealed) {
    return `<span class="sealed">sealed price condition · committee-only</span>`;
  }
  if (!parts.length) {
    return `<span class="sealed">—</span>`;
  }
  return parts.join(' <span style="color:var(--ink4)">·</span> ');
}

function stateTag(state: CovenantState): string {
  const label: Record<CovenantState, string> = {
    sealed: "Sealed",
    collecting: "Collecting",
    reconstructable: "Reconstructable",
    opened: "Opened",
    expired: "Expired",
  };
  return `<span class="tag ${state}"><span class="tdot"></span>${label[state]}</span>`;
}

/* ------------------------------------------------------------------ */
/* Deployment strip + live pill                                       */
/* ------------------------------------------------------------------ */

async function loadConfig(): Promise<void> {
  try {
    const config = await getJson<ConfigResponse>("/api/config");
    if (!config.live) {
      $("live-dot").className = "dot bad";
      $("live-txt").textContent =
        config.code === "rpc_unreachable"
          ? "RPC unavailable"
          : "wrong deployment";
      $("deploy-verdict").innerHTML =
        `<span class="dot bad"></span> ${escapeHtml(
          config.code === "rpc_unreachable" ? "RPC unreachable" : "not wired",
        )}`;
      $("deploy-b").innerHTML =
        `<div class="kv" style="border:none">${escapeHtml(
          config.reason ?? "config unresolved",
        )}</div>`;
      return;
    }
    $("live-dot").className = "dot live";
    $("live-txt").textContent = "live deployment";
    const fleet = config.fleet ?? { verdict: "?" };
    $("deploy-verdict").innerHTML =
      `<span class="dot live"></span> C0 wired · fleet ${escapeHtml(fleet.verdict)}${
        fleet.liveNodes !== undefined ? ` · ${fleet.liveNodes} live` : ""
      }`;

    const addresses = config.addresses;
    const params = config.params;
    if (!addresses || !params) {
      return;
    }
    const link = (address: string): string =>
      `<a href="${EXPLORER}/address/${address}" target="_blank" rel="noopener">${escapeHtml(
        address,
      )}</a>`;
    $("deploy-b").innerHTML = `
      <div class="kv-grid">
        <div class="kv"><div class="k">ProtocolConfig · C0</div><div class="v addr">${link(addresses.config)}</div></div>
        <div class="kv"><div class="k">TriggerMarket</div><div class="v addr">${link(addresses.market)}</div></div>
        <div class="kv"><div class="k">NodeRegistry</div><div class="v addr">${link(addresses.registry)}</div></div>
        <div class="kv"><div class="k">Staking</div><div class="v addr">${link(addresses.staking)}</div></div>
        <div class="kv"><div class="k">Emissions</div><div class="v addr">${link(addresses.emissions)}</div></div>
        <div class="kv"><div class="k">NIL token</div><div class="v addr">${link(addresses.nil)}</div></div>
        <div class="kv"><div class="k">Protocol fee</div><div class="v">${escapeHtml(params.protocolFeeNil ?? "—")} NIL</div></div>
        <div class="kv"><div class="k">Default / max hook gas</div><div class="v">${params.defaultHookGas ?? "—"} / ${params.maxHookGas ?? "—"}</div></div>
        <div class="kv"><div class="k">Max committee (m) · key TTL</div><div class="v">${params.maxM ?? "—"} · ${params.keyTTLSecs !== null ? formatDuration(params.keyTTLSecs) : "—"}</div></div>
        <div class="kv"><div class="k">Min stake</div><div class="v">${escapeHtml(params.minStakeNil ?? "—")} NIL</div></div>
        <div class="kv"><div class="k">Max plaintext</div><div class="v">${params.maxPlaintextBytes ?? "—"} bytes</div></div>
        <div class="kv"><div class="k">Eligible nodes</div><div class="v">${config.nodes?.active ?? "—"} active / ${config.nodes?.total ?? "—"} total</div></div>
      </div>`;
  } catch (error) {
    $("live-dot").className = "dot bad";
    $("live-txt").textContent = "unreachable";
    $("deploy-verdict").textContent = "could not read C0";
    $("deploy-b").innerHTML =
      `<div class="kv" style="border:none;color:var(--red)">${escapeHtml(
        (error as Error).message,
      )}</div>`;
  }
}

/* ------------------------------------------------------------------ */
/* Feed                                                               */
/* ------------------------------------------------------------------ */

let lastFeedAt = 0;

function feedRowHtml(covenant: Covenant, nowUnix: number): string {
  const timing = covenant.resolved
    ? ""
    : covenant.expiry
      ? `expires ${relativeTime(covenant.expiry, nowUnix)}`
      : "";
  const sub = [
    timing,
    covenant.hook ? `hook ${truncateAddress(covenant.hook.address)}` : "",
    covenant.author ? `by ${truncateAddress(covenant.author)}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const escrow =
    covenant.escrowEth !== null
      ? Number(covenant.escrowEth).toPrecision(3)
      : "—";
  return `
    <div class="feed-row" data-id="${covenant.id}">
      <div class="cid">#${covenant.id}<small>${escapeHtml(modeLabel(covenant.mode))}</small></div>
      <div class="cond">
        <div class="line">${conditionLine(covenant.condition)}</div>
        <div class="sub">${escapeHtml(sub)}</div>
      </div>
      <div class="qmini qwrap tagcell">${quorumMeter(covenant.sharesPosted, covenant.k, covenant.m, { mini: true })}</div>
      <div class="feed-esc">${escrow}<small>ETH escrow</small></div>
      <div class="r tagcell" style="text-align:right">${stateTag(covenant.state)}</div>
    </div>`;
}

async function loadFeed(options: { silent?: boolean } = {}): Promise<void> {
  const mount = $("feed-mount");
  if (!options.silent) {
    mount.innerHTML = `<div class="feed">${'<div class="skel"></div>'.repeat(5)}</div>`;
  }
  try {
    const feed = await getJson<FeedResponse>("/api/feed?limit=30");
    lastFeedAt = Date.now();
    $("feed-count").textContent = feed.total
      ? `${feed.shown} shown · ${feed.total} total`
      : "";
    if (!feed.covenants.length) {
      mount.innerHTML = `<div class="empty">No releases on this deployment yet.<br>When someone posts one, it appears here the moment it is sealed.</div>`;
      updateFeedStamp();
      return;
    }
    const head = `<div class="feed-head"><span>#</span><span>Release condition</span><span>Committee</span><span class="r">Escrow</span><span class="r">State</span></div>`;
    const rows = feed.covenants
      .map((covenant) => feedRowHtml(covenant, feed.nowUnix))
      .join("");
    mount.innerHTML = `<div class="feed">${head}${rows}</div>`;
    for (const row of mount.querySelectorAll<HTMLElement>(".feed-row")) {
      row.addEventListener("click", () =>
        go(row.getAttribute("data-id") ?? ""),
      );
    }
    updateFeedStamp();
  } catch (error) {
    mount.innerHTML = `<div class="errbox">Could not load the feed: ${escapeHtml(
      (error as Error).message,
    )}</div>`;
  }
}

/** Refresh the "updated Ns ago" label from the last successful fetch. This is a
 *  UI-freshness indicator, so it is measured against the wall clock, not chain
 *  time. */
function updateFeedStamp(): void {
  const stamp = document.getElementById("feed-updated");
  if (!stamp || !lastFeedAt) {
    return;
  }
  const seconds = Math.round((Date.now() - lastFeedAt) / 1000);
  stamp.textContent = seconds <= 1 ? "just now" : `updated ${seconds}s ago`;
}

/* ------------------------------------------------------------------ */
/* Detail                                                             */
/* ------------------------------------------------------------------ */

async function loadDetail(
  id: string,
  options: { silent?: boolean } = {},
): Promise<void> {
  const mount = $("detail-mount");
  if (!options.silent) {
    mount.innerHTML = `<div class="loading">Reading release #${escapeHtml(id)}…</div>`;
  }
  let detail: TriggerDetail;
  try {
    detail = await getJson<TriggerDetail>(
      `/api/trigger?id=${encodeURIComponent(id)}`,
    );
  } catch (error) {
    mount.innerHTML = `<div class="errbox">Could not load release #${escapeHtml(
      id,
    )}: ${escapeHtml((error as Error).message)}</div>`;
    return;
  }

  mount.innerHTML = detailHtml(detail);
  wireExpiredKeeper(detail);
  wireRetryKeeper(detail);

  // The X-ray is only meaningful before a covenant opens.
  const xrayMount = $("xray-mount");
  if (detail.resolved) {
    xrayMount.innerHTML = "";
  } else {
    xrayMount.innerHTML = `<div class="xray"><div class="xray-h"><span class="lbl">X-<span class="g">RAY</span></span><span class="st">reconstruct + simulate</span></div><div class="xray-b"><div class="xray-wait">Reconstructing and simulating…</div></div></div>`;
    void loadXray(detail);
  }

  // Once opened or expired, a live detail view has nothing left to poll.
  if (detail.resolved || detail.state === "expired") {
    stopAuto();
  }
}

function detailHtml(detail: TriggerDetail): string {
  const now = detail.nowUnix;
  const stats = `
    <div class="stat-row">
      <div class="stat"><div class="k">State</div><div class="v">${stateTag(detail.state)}</div></div>
      <div class="stat"><div class="k">Threshold</div><div class="v">${detail.sharesPosted} / ${detail.k} <small>of ${detail.m}</small></div></div>
      <div class="stat"><div class="k">Escrow</div><div class="v">${detail.escrowEth !== null ? Number(detail.escrowEth).toPrecision(4) : "—"} <small>ETH</small></div></div>
      <div class="stat"><div class="k">${detail.resolved ? "Opened" : "Expires"}</div><div class="v" style="font-size:13px">${detail.resolved ? "yes" : detail.expiry ? relativeTime(detail.expiry, now) : "—"}</div></div>
    </div>`;

  const condition = detail.condition;
  const recordPanel = `
    <div class="panel">
      <div class="panel-h">Release condition <span class="meta">${escapeHtml(modeLabel(detail.mode))} mode</span></div>
      <div class="panel-b">
        <div style="font-family:var(--mono);font-size:14px;margin-bottom:12px">${conditionLine(condition)}</div>
        ${
          condition.raw
            ? `<div class="record"><span style="color:var(--ink4)">52-byte record</span><br>${escapeHtml(condition.raw)}</div>`
            : `<div class="note">This release is Private — the price threshold is sealed to the committee and never appears on-chain. Any public time window is shown above.</div>`
        }
        ${condition.window ? `<div class="note">Window opens <b>${formatDateUtc(condition.window.t1)}</b> and closes <b>${formatDateUtc(condition.window.t2)}</b>.</div>` : ""}
      </div>
    </div>`;

  const quorumPanel = `
    <div class="panel">
      <div class="panel-h">Quorum</div>
      <div class="panel-b"><div class="qwrap">${quorumMeter(detail.sharesPosted, detail.k, detail.m)}</div></div>
    </div>`;

  const slots = detail.committee
    .map(
      (slot) => `
    <div class="slot ${slot.shared ? "shared" : ""}">
      ${slot.shared ? '<span class="schk">✓</span>' : ""}
      <div class="sn">Slot ${slot.slot}</div>
      <div class="snode">${slot.nodeId !== null ? `node ${escapeHtml(slot.nodeId)}` : '<span style="color:var(--ink4)">unassigned</span>'}</div>
      <div class="skey">${slot.keyId !== null ? `key #${escapeHtml(slot.keyId)}` : ""}${slot.shared ? " · shared" : ""}</div>
    </div>`,
    )
    .join("");
  const committeePanel = `
    <div class="panel">
      <div class="panel-h">Committee <span class="meta">${detail.sharesPosted} of ${detail.m} posted · k = ${detail.k}</span></div>
      <div class="panel-b"><div class="slots">${slots || '<span class="note">Committee membership will show once the post record is in range.</span>'}</div></div>
    </div>`;

  const hookPanel = detail.hook
    ? `
    <div class="panel">
      <div class="panel-h">Settlement hook</div>
      <div class="panel-b">
        <div class="xrow"><div class="xk">Contract</div><div class="xv"><a href="${EXPLORER}/address/${detail.hook.address}" target="_blank" rel="noopener">${escapeHtml(detail.hook.address)}</a></div></div>
        <div class="xrow"><div class="xk">Gas budget</div><div class="xv">${detail.hook.hookGas.toLocaleString()} gas</div></div>
        <div class="xrow"><div class="xk">Retry window</div><div class="xv">${formatDuration(detail.hook.retryWindow)}${detail.hook.retryDeadline ? ` · deadline ${formatDateUtc(detail.hook.retryDeadline)}` : ""}</div></div>
        <div class="xrow"><div class="xk">Status</div><div class="xv ${detail.resolved ? (detail.hook.hookOk ? "ack" : "noack") : ""}">${detail.resolved ? (detail.hook.hookOk ? "acknowledged" : "did NOT acknowledge") : "pending reveal"}</div></div>
        <div class="xrow"><div class="xk">Bounty</div><div class="xv">${detail.hook.bountyOff ? "waived — author reveals" : "open to reconstructors"}</div></div>
        <div id="hook-keeper"></div>
      </div>
    </div>`
    : `
    <div class="panel"><div class="panel-h">Settlement hook</div><div class="panel-b"><div class="note">No hook — this release only opens its payload; nothing is called on reveal.</div></div></div>`;

  const revealPanel = detail.reveal
    ? `
    <div class="panel">
      <div class="panel-h">Reveal <span class="meta">${detail.reveal.verified ? "commitment verified" : "unverified"}</span></div>
      <div class="panel-b">
        <div class="xrow"><div class="xk">Reconstructor</div><div class="xv"><a href="${EXPLORER}/address/${detail.reveal.reconstructor}" target="_blank" rel="noopener">${escapeHtml(detail.reveal.reconstructor)}</a></div></div>
        <div class="xrow"><div class="xk">Used slots</div><div class="xv">${escapeHtml((detail.reveal.usedSlots ?? []).join(", "))}</div></div>
        <div class="xrow"><div class="xk">Payload</div><div class="xv">${detail.reveal.payloadLen} bytes${detail.reveal.verified ? " · keccak256 matches commit" : ""}</div></div>
        <div class="record" style="margin-top:8px">${escapeHtml(detail.reveal.payloadHex)}</div>
      </div>
    </div>`
    : `<div class="panel"><div class="panel-h">Reveal</div><div class="panel-b"><div class="note">Not opened yet. When the k-th share lands, the payload becomes reconstructable and the X-ray above previews the settlement.</div></div></div>`;

  const timeline = detail.timeline?.length
    ? `
    <div class="panel">
      <div class="panel-h">Timeline <span class="meta">${detail.timeline.length} events</span></div>
      <div class="panel-b"><ul class="tl">${detail.timeline.map(timelineRow).join("")}</ul></div>
    </div>`
    : "";

  return `
    <div class="dh">
      <h2>Release #${escapeHtml(detail.id)}<small>${escapeHtml(modeLabel(detail.mode))} · committee of ${detail.m}, threshold ${detail.k}${detail.author ? ` · by ${truncateAddress(detail.author)}` : ""}</small></h2>
      <div class="dh-r">${stateTag(detail.state)}</div>
    </div>
    ${stats}
    <div id="xray-mount"></div>
    ${recordPanel}
    ${quorumPanel}
    ${committeePanel}
    <div class="grid-2">${hookPanel}${revealPanel}</div>
    ${timeline}`;
}

function timelineRow(entry: TimelineEntry): string {
  const label: Record<string, string> = {
    TriggerPosted: "Posted",
    SharePosted: "Share posted",
    ShareBatchResult: "Share batch",
    HookInvoked: "Hook invoked",
    HookRetried: "Hook retried",
    TriggerResolved: "Opened",
    TriggerExpired: "Expired",
    RefundIssued: "Refund issued",
    RefundOwed: "Refund owed",
    RefundClaimed: "Refund claimed",
    ExpirySharePaid: "Expiry share paid",
  };
  const args = entry.args ?? {};
  const failed =
    entry.type === "TriggerExpired" ||
    (entry.type === "HookInvoked" && args.ok === false) ||
    (entry.type === "HookRetried" && args.ok === false);
  const cls =
    entry.type === "TriggerResolved" ? "resolve" : failed ? "fail" : "";
  let detail = "";
  if (entry.type === "SharePosted") {
    detail = `slot ${args.slot} · node ${args.node}`;
  } else if (entry.type === "HookInvoked") {
    detail = args.ok ? "acknowledged" : "did not acknowledge";
  } else if (entry.type === "HookRetried") {
    detail = `${args.ok ? "acknowledged" : "still failing"} · by ${truncateAddress(String(args.caller ?? ""))}`;
  } else if (entry.type === "TriggerResolved") {
    detail = `by ${truncateAddress(String(args.reconstructor ?? ""))} · slots ${(
      (args.usedSlots as unknown[]) ?? []
    ).join(",")}`;
  } else if (args.amount) {
    detail = `${args.amount} wei`;
  }
  return `<li><span class="ev ${cls}">${label[entry.type] ?? entry.type}</span><span class="det">${escapeHtml(detail)}</span><span class="blk"><a href="${EXPLORER}/tx/${entry.txHash}" target="_blank" rel="noopener" style="color:inherit">blk ${entry.block}</a></span></li>`;
}

/* ------------------------------------------------------------------ */
/* X-ray                                                              */
/* ------------------------------------------------------------------ */

async function loadXray(detail: TriggerDetail): Promise<void> {
  const host = document.querySelector<HTMLElement>("#xray-mount .xray-b");
  if (!host) {
    return;
  }
  let simulation: SimulateResponse;
  try {
    simulation = await getJson<SimulateResponse>(
      `/api/simulate?id=${encodeURIComponent(detail.id)}`,
    );
  } catch (error) {
    host.innerHTML = `<div class="xray-wait">Simulation unavailable: ${escapeHtml(
      (error as Error).message,
    )}</div>`;
    return;
  }
  const status = document.querySelector<HTMLElement>("#xray-mount .xray-h .st");
  if (status) {
    status.textContent = simulation.reconstructable
      ? "reconstructable now"
      : "not yet reconstructable";
  }

  if (!simulation.reconstructable) {
    host.innerHTML = `<div class="xray-wait">${escapeHtml(
      simulation.note ?? "Not reconstructable yet.",
    )}</div>`;
    return;
  }

  const settlement = simulation.settlement ?? { willSettle: false };
  const verdict = settlement.willSettle
    ? `<div class="verdict will"><span class="vi">✓</span><span class="vt"><b>The reveal will settle.</b> Dry-running <span style="font-family:var(--mono)">post_result</span> with the reconstructed payload succeeds against current state.</span></div>`
    : `<div class="verdict wont"><span class="vi">✕</span><span class="vt"><b>The reveal would revert.</b> <span class="err">${escapeHtml(settlement.revert ?? "unknown")}</span> — settling now fails against current state.</span></div>`;

  const outcome = simulation.hookOutcome;
  const hookRow = outcome
    ? `
    <div class="xrow"><div class="xk">Hook outcome</div>
      <div class="xv ${outcome.acknowledged ? "ack" : "noack"}">${outcome.reverts ? "reverts in isolation" : outcome.acknowledged ? "acknowledges (HOOK_ACK)" : "declines (no HOOK_ACK)"}</div></div>
    <div class="note" style="margin:0 0 4px">${escapeHtml(outcome.note ?? "")}</div>`
    : "";

  let transfers = "";
  if (simulation.transfers?.length) {
    transfers = `<div class="xrow"><div class="xk">Token moves</div><div class="xv" style="width:100%">${simulation.transfers
      .map(
        (transfer) => `
      <div class="xfer"><span class="ar">→</span><span class="who">${truncateAddress(transfer.from)} → ${truncateAddress(transfer.to)} <span style="color:var(--ink4)">· ${truncateAddress(transfer.token)}</span></span><span class="amt">${escapeHtml(transfer.value)}</span></div>`,
      )
      .join("")}</div></div>`;
  } else if (simulation.traceNote) {
    transfers = `<div class="note">${escapeHtml(simulation.traceNote)}</div>`;
  }

  const openFor = simulation.mev?.openForSecs;
  const mev = `
    <div class="mev">
      <div class="mh">Front-running exposure${openFor !== null && openFor !== undefined ? ` · <span class="clock">open ${formatDuration(openFor)}</span>` : ""}</div>
      <p>${escapeHtml(simulation.mev?.note ?? "")}</p>
    </div>`;

  host.innerHTML = `
    ${verdict}
    <div class="xrow"><div class="xk">Payload</div><div class="xv">${simulation.payload?.len ?? 0} bytes (＋32-byte nonce stripped)</div></div>
    ${hookRow}
    ${transfers}
    <div class="record" style="margin-top:10px">${escapeHtml(simulation.payload?.hex ?? "")}</div>
    ${mev}
    <div class="keeper" id="reveal-keeper">
      <span class="kh">Permissionless keeper action — anyone with Sepolia gas may open this release</span>
      <button class="btn grn sm" id="btn-reveal">Reveal &amp; settle</button>
      <span class="ksim ${settlement.willSettle ? "ok" : "bad"}">${settlement.willSettle ? "dry-run: will succeed · you earn the reconstructor fee" : "dry-run: would revert — sending is not advised"}</span>
    </div>`;

  $("btn-reveal").addEventListener("click", () =>
    keeperAction("reveal", detail.id),
  );
}

/* ------------------------------------------------------------------ */
/* Keeper actions                                                     */
/* ------------------------------------------------------------------ */

function wireExpiredKeeper(detail: TriggerDetail): void {
  if (detail.state !== "expired") {
    return;
  }
  const host = document.querySelector<HTMLElement>(".dh .dh-r");
  if (!host) {
    return;
  }
  const button = document.createElement("button");
  button.className = "btn sm";
  button.textContent = "Settle expired";
  button.addEventListener("click", () => keeperAction("settle", detail.id));
  host.appendChild(button);
}

function wireRetryKeeper(detail: TriggerDetail): void {
  const host = document.getElementById("hook-keeper");
  if (!host || !detail.hook || !detail.resolved || detail.hook.hookOk) {
    return;
  }
  const within =
    !detail.hook.retryDeadline || detail.hook.retryDeadline > detail.nowUnix;
  host.innerHTML = `<div class="keeper"><span class="kh">Hook did not acknowledge${within ? " — retry is open" : " — retry window closed"}</span>${within ? '<button class="btn sm" id="btn-retry">Retry hook</button>' : ""}</div>`;
  const button = document.getElementById("btn-retry");
  if (button) {
    button.addEventListener("click", () => keeperAction("retry", detail.id));
  }
}

async function keeperAction(action: KeeperAction, id: string): Promise<void> {
  try {
    if (!wallet.provider) {
      openWalletModal();
      return;
    }
    await ensureSepolia();
    const response = await fetch("/api/keeper-tx", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, id }),
    });
    const result = (await response.json()) as KeeperTxResponse & {
      error?: string;
    };
    if (!response.ok) {
      alert(`Cannot build transaction: ${result.error ?? response.statusText}`);
      return;
    }
    if (result.simulated && result.simulated !== "ok") {
      if (
        !confirm(
          `This transaction is expected to revert:\n\n${result.simulated}\n\nSend anyway?`,
        )
      ) {
        return;
      }
    }
    const hash = (await wallet.provider.request({
      method: "eth_sendTransaction",
      params: [
        {
          from: wallet.account,
          to: result.tx.to,
          data: result.tx.data,
          value: result.tx.value,
        },
      ],
    })) as string;
    alert(`Submitted.\n\n${action} → ${hash}\n\nView: ${EXPLORER}/tx/${hash}`);
    window.setTimeout(() => void loadDetail(id, { silent: true }), 4000);
  } catch (error) {
    const message =
      (error as { shortMessage?: string }).shortMessage ??
      (error as Error).message ??
      String(error);
    alert(`Transaction failed: ${message}`);
  }
}

/* ------------------------------------------------------------------ */
/* Wallet (EIP-6963: MetaMask, Rainbow, …)                            */
/* ------------------------------------------------------------------ */

const wallet: {
  provider: Eip1193Provider | null;
  account: string | null;
  providers: Eip6963ProviderDetail[];
} = { provider: null, account: null, providers: [] };

window.addEventListener("eip6963:announceProvider", (event) => {
  const detail = event.detail;
  if (!wallet.providers.find((entry) => entry.info.uuid === detail.info.uuid)) {
    wallet.providers.push(detail);
  }
});
window.dispatchEvent(new Event("eip6963:requestProvider"));

function openWalletModal(): void {
  const list = $("wallet-list");
  if (wallet.providers.length) {
    list.innerHTML = wallet.providers
      .map(
        (entry) =>
          `<div class="wopt" data-uuid="${escapeHtml(entry.info.uuid)}"><img src="${escapeHtml(entry.info.icon)}" alt=""/><span class="wn">${escapeHtml(entry.info.name)}</span></div>`,
      )
      .join("");
  } else if (window.ethereum) {
    list.innerHTML = `<div class="wopt" data-injected="1"><span class="wn">Injected wallet</span></div>`;
  } else {
    list.innerHTML = `<div class="wopt"><span class="wnone">No wallet detected. Install MetaMask or Rainbow, then reload. Reading releases needs no wallet — only keeper actions do.</span></div>`;
  }
  for (const option of list.querySelectorAll<HTMLElement>(".wopt[data-uuid]")) {
    option.addEventListener("click", () => {
      const entry = wallet.providers.find(
        (candidate) => candidate.info.uuid === option.getAttribute("data-uuid"),
      );
      if (entry) {
        void connectWith(entry.provider, entry.info.name);
      }
    });
  }
  const injected = list.querySelector<HTMLElement>(".wopt[data-injected]");
  if (injected && window.ethereum) {
    injected.addEventListener("click", () =>
      window.ethereum
        ? void connectWith(window.ethereum, "Injected")
        : undefined,
    );
  }
  $("wallet-modal").classList.add("open");
}

function closeWalletModal(): void {
  $("wallet-modal").classList.remove("open");
}

async function connectWith(
  provider: Eip1193Provider,
  name: string,
): Promise<void> {
  try {
    const accounts = (await provider.request({
      method: "eth_requestAccounts",
    })) as string[];
    wallet.provider = provider;
    wallet.account = accounts[0] ?? null;
    closeWalletModal();
    const button = $("connect-btn");
    button.textContent = `${name} · ${truncateAddress(accounts[0])}`;
    button.classList.remove("ink");
    provider.on?.("accountsChanged", (...args: unknown[]) => {
      const next = (args[0] as string[] | undefined) ?? [];
      wallet.account = next[0] ?? null;
      if (!next[0]) {
        button.textContent = "Connect wallet";
        button.classList.add("ink");
        wallet.provider = null;
      } else {
        button.textContent = `${name} · ${truncateAddress(next[0])}`;
      }
    });
  } catch (error) {
    alert(`Could not connect: ${(error as Error).message}`);
  }
}

async function ensureSepolia(): Promise<void> {
  if (!wallet.provider) {
    return;
  }
  const chainId = await wallet.provider.request({ method: "eth_chainId" });
  if (chainId === SEPOLIA_HEX) {
    return;
  }
  try {
    await wallet.provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: SEPOLIA_HEX }],
    });
  } catch (error) {
    if ((error as { code?: number }).code === 4902) {
      await wallet.provider.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: SEPOLIA_HEX,
            chainName: "Sepolia",
            nativeCurrency: {
              name: "Sepolia Ether",
              symbol: "ETH",
              decimals: 18,
            },
            rpcUrls: ["https://ethereum-sepolia-rpc.publicnode.com"],
            blockExplorerUrls: [EXPLORER],
          },
        ],
      });
    } else {
      throw error;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Auto-refresh controller                                            */
/* ------------------------------------------------------------------ */

let pollTimer: number | null = null;
let tickTimer: number | null = null;

function stopAuto(): void {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
  if (tickTimer !== null) {
    window.clearInterval(tickTimer);
    tickTimer = null;
  }
}

/** Poll the feed on a timer while the feed view is visible and the tab is
 *  focused, re-rendering silently so quorum meters fill and states advance
 *  without a skeleton flash. */
function startFeedAuto(): void {
  stopAuto();
  pollTimer = window.setInterval(() => {
    if (document.visibilityState === "visible") {
      void loadFeed({ silent: true });
    }
  }, REFRESH_MS);
  tickTimer = window.setInterval(updateFeedStamp, 1000);
}

/** Poll a single covenant while it is open to change. `loadDetail` clears the
 *  timer once the covenant resolves or expires. */
function startDetailAuto(id: string): void {
  stopAuto();
  pollTimer = window.setInterval(() => {
    if (document.visibilityState === "visible") {
      void loadDetail(id, { silent: true });
    }
  }, REFRESH_MS);
}

document.addEventListener("visibilitychange", () => {
  // Refresh immediately on return so a backgrounded tab is never stale.
  if (document.visibilityState !== "visible") {
    return;
  }
  const id = new URL(location.href).searchParams.get("id");
  if (id) {
    void loadDetail(id, { silent: true });
  } else if ($("view-feed").style.display !== "none") {
    void loadFeed({ silent: true });
  }
});

/* ------------------------------------------------------------------ */
/* Routing + boot                                                     */
/* ------------------------------------------------------------------ */

function showFeed(): void {
  $("view-detail").style.display = "none";
  $("view-feed").style.display = "";
  startFeedAuto();
}

function showDetail(id: string): void {
  $("view-feed").style.display = "none";
  $("view-detail").style.display = "";
  void loadDetail(id);
  startDetailAuto(id);
}

function go(id: string): void {
  history.pushState({ id }, "", `?id=${encodeURIComponent(id)}`);
  window.scrollTo(0, 0);
  showDetail(id);
}

function route(): void {
  const id = new URL(location.href).searchParams.get("id");
  if (id) {
    showDetail(id);
  } else {
    showFeed();
  }
}

window.addEventListener("popstate", route);

$("brand").addEventListener("click", () => {
  history.pushState({}, "", location.pathname);
  showFeed();
});
$("back").addEventListener("click", () => {
  history.pushState({}, "", location.pathname);
  showFeed();
});
$("deploy-h").addEventListener("click", () =>
  $("deploy").classList.toggle("open"),
);
$("connect-btn").addEventListener("click", () => {
  if (!wallet.account) {
    openWalletModal();
  }
});
$("wallet-close").addEventListener("click", closeWalletModal);
$("wallet-modal").addEventListener("click", (event) => {
  if (event.target === $("wallet-modal")) {
    closeWalletModal();
  }
});

void loadConfig();
void loadFeed();
route();
