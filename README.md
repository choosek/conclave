# Conclave

[![lint-check-test](https://github.com/your-org/conclave/actions/workflows/lint-check-test.yaml/badge.svg)](https://github.com/your-org/conclave/actions)
[![network: Sepolia](https://img.shields.io/badge/network-Sepolia-3fd082)](https://sepolia.etherscan.io/)

A monitor for MPC-based threshold-release schemes that tracks committee quorum, observes reconstruction, and previews settlement.

A threshold-release scheme takes a payload, splits it into `k`-of-`m` [Shamir](https://en.wikipedia.org/wiki/Shamir%27s_secret_sharing) shares, encrypts each share to a selected committee node, and binds the whole thing to a release condition. The committee evaluates that condition off-chain and publishes shares; once `k` shares are public anyone can reconstruct the payload, and — where the scheme supports it — a hook executes settlement logic in the reveal transaction. Conclave is a read-only surface for that lifecycle: it lists what is pending, watches each committee assemble toward its threshold, marks the instant the payload becomes reconstructable, and, in the window before it settles, reconstructs the payload locally and dry-runs the reveal to show what it will do.

The one network Conclave currently supports is [Nillion](https://nillion.com/) [Blacklight L1](https://github.com/NillionNetwork/blacklight-l1-sdk) on the [Sepolia](https://sepolia.etherscan.io/) testnet, where a release is called a *covenant* and the release condition is a price threshold, a time window, or both. Nothing in the model is specific to it — a *release* is the general object, and Blacklight is the first network behind the seam.

## What It Does

Conclave keys off the single lifecycle a release reduces to, and gives each phase a surface. Read top to bottom, that is three steps:

| Step | What Conclave does | The moment it covers |
|------|--------------------|----------------------|
| **1 · Track the quorum** | Lists every release on the network with its decoded condition, its `k`-of-`m` share progress, and its committee laid out slot by slot — discovered from `nextTriggerId` and per-release meta, without scanning event ranges. | `sealed → collecting` |
| **2 · Observe reconstruction** | Marks the instant the `k`-th share lands and the payload becomes reconstructable — the moment the secret goes public — and begins measuring how long it has been exposed. | `reconstructable` |
| **3 · Preview the settlement** | In the window before the reveal executes, reconstructs the payload locally against the on-chain commitment and dry-runs the real settlement path: settle or revert (with the protocol's own error), whether the hook acknowledges, what tokens move, and how long the order has already been public. | `before it opens` |

Reading any of this — the feed, a release's detail, the settlement preview — needs no wallet. A wallet is required only to *send* one of the permissionless keeper actions, and even then only to sign a transaction Conclave has already built and simulated.

## Why It Matters

A threshold-release scheme is a *conditional-secret primitive*, not an "encrypted smart contract," and it is worth being exact about what that buys and what it does not. It provides real **waiting-phase privacy**: a stop, a bid, or an agent instruction can stay hidden from public observers while it waits on its condition. But that privacy is **time-bounded** — once `k` shares are public the plaintext is reconstructable permanently — and it does not provide **front-running resistance**. The `k`-th share makes the order reconstructible at least a full block before it executes, and the share transactions are visible in the mempool earlier still; an atomic settlement hook cannot close a disclosure window that opened in the previous block. Nillion's own builder brief says this plainly — *you do not have it*. Secrecy below `k` is cryptographic; correctly timed release *at* `k` is economic and operational: each node judges the condition on its own off-chain feed, there is no committee vote or SLA, and in private mode the condition is hidden from the public but not from the committee members, any `k` of whom can reconstruct early.

Conclave is built on that reading rather than against it. It does not claim to seal the execution boundary — it makes the boundary **legible and measured**, which is what a primitive at this stage actually needs. The committee panel lays out the `k`-of-`m` set slot by slot, so the reconstruction surface is something you look at rather than infer. The reconstructable state is marked the instant it is reached. And the settlement preview carries a **Front-running exposure** readout — an `open Xm Ys` clock on how long the payload has already been public — that treats the share-to-settlement gap as a first-class quantity instead of a footnote. The result is an instrument aimed squarely at the properties a threshold-release has to be judged on before it is trusted with value: **feed correctness**, the **`k`-of-`m` collusion surface**, **liveness**, and **share-to-settlement MEV**. Conclave measures the seams; it does not paper over them.

## How A Release Works

A release progresses through a fixed set of states, and the whole interface derives from the one it is in:

| State             | Meaning                                                                                         |
|-------------------|-------------------------------------------------------------------------------------------------|
| `sealed`          | The payload is sealed to the committee; no shares posted yet.                                    |
| `collecting`      | The condition has begun to draw shares — at least one, fewer than `k`.                           |
| `reconstructable` | `k` or more shares are posted: the payload can be reconstructed, and executes a block or so later.|
| `opened`          | The reveal has run; the plaintext is public and the commitment is verifiable.                    |
| `expired`         | The window closed before `k` shares arrived; the release can only be settled out.                |

The **release condition** is what the committee evaluates. On a network that publishes it in the clear (Blacklight's *public* covenants), the price threshold — asset, comparator, and price in 10⁻⁸ USD units — and any time window are readable; a *private* release seals the threshold to the committee, and Conclave reports it as sealed while still showing any public window. The **committee** is the `m` nodes the payload is split across; a release opens when any `k` of them post shares, so the assembly toward `k` is the thing worth watching — which is why it is Conclave's signature element, the *quorum meter*.

## The X-Ray

Between the `k`-th share landing and the reveal executing, a release is reconstructable but has not run. Only a threshold-release scheme opens this window, and it is the one question nothing else surfaces: *what will the reveal do?* In that window Conclave reconstructs the payload locally — verifying it against the on-chain commitment — and dry-runs the real settlement path, reporting whether the reveal will settle or revert (named with the protocol's own error), whether the settlement hook will acknowledge, what tokens move, and, via the **Front-running exposure** clock, how long the order has already been public to everyone else. No release is ever opened by looking: the preview is a local reconstruction and an `eth_call` simulation, and settlement runs only if you choose a keeper action and sign it.

## The Views

**Feed** — every release on the deployment, discovered without event-range scanning, each row showing its decoded condition, a compact quorum meter, its escrow, and its state. It refreshes on the network's block cadence while the tab is focused, so committee assembly and the reconstructable moment appear live.

**Detail** — one release in full: the condition record decoded, the committee laid out slot by slot with live share status, the escrow and hook configuration, the event timeline, and — for a reconstructable release — the X-ray. A pending release also offers whichever permissionless keeper action applies.

## Architecture

Conclave is a static client plus a handful of serverless functions, and it keeps a hard line between them. Every use of the release network's SDK and of [viem](https://viem.sh/) is confined to the server: the event reads, the reconstruction WebAssembly, and the settlement simulation are Node-bound by design, and keeping them server-side means the browser bundle ships no contract ABIs and no crypto — the client only ever reads JSON from `/api` and talks to the user's wallet. The code splits four ways:

```
src/core/     pure logic, no I/O — state derivation, quorum-meter geometry, condition shaping, formatting
src/server/   the chain seam — reading releases, decoding conditions, the reconstruct-and-simulate preview, http helpers
src/shared/   the wire types the API and client agree on
src/client/   the browser SPA (imports only src/core + src/shared)
api/          serverless routes, each a thin adapter over src/server
```

The split is enforced by dependency direction: `src/core` imports nothing, the client imports only `src/core` and `src/shared`, and every SDK-touching line lives under `src/server` or `api`. Supporting a second threshold-release network is a matter of adding its adapter behind the same `src/server` seam and the same wire types; the client and the pure core do not change.

## Running It Locally

The project uses [pnpm](https://pnpm.io/):

```shell
corepack enable
pnpm install
pnpm build          # bundle the client to public/app.js
```

Then run it either way. The first needs no extra tooling; the second emulates the platform:

```shell
pnpm dev:local      # a dependency-light Node server: serves public/ and routes /api/*  → http://localhost:3000
pnpm dev            # vercel dev, if you have the Vercel CLI                              → http://localhost:3000
```

`pnpm dev:local` runs `scripts/dev-server.ts`, which serves the built client and dispatches `/api/*` to the same handler files Vercel runs, shimming the two request fields they read. It is a convenience for local testing; production runs on Vercel. Either way the `/api` functions need a reachable Sepolia RPC — with no environment set they use a public endpoint, and if the deployment header reads "RPC unavailable," set `SEPOLIA_RPC_URL` (see [Configuration](#configuration)).

## Deployment

Conclave deploys to [Vercel](https://vercel.com/). By CLI:

```shell
pnpm build          # bundles the client to public/app.js
vercel --prod
```

Or import the repository in the Vercel dashboard. `vercel.json` is read automatically: Vercel runs the `buildCommand` to produce the client bundle, serves `public/` as static assets, and turns each file in `api/` into a serverless function. Set any environment variables under **Project → Settings → Environment Variables**.

> This project pins `"framework": null` in `vercel.json` and depends on no web framework, so Vercel serves it as a static site with serverless functions rather than auto-detecting a framework preset. Keep it that way: if a dependency ever pulls a framework (for example, `vite`) into `package.json`, Vercel may misdetect the project and try to run that framework's dev/build command instead.

The SDK binds its Node-target WebAssembly core **at import time** (`crypto.js` instantiates the module on load), so every `/api` function that touches the SDK — which is all of them — needs the `.wasm` binary in its serverless bundle. The Node loader reads it as `` `${__dirname}/cryptomata_core_bg.wasm` ``, a template-literal path Vercel's file tracer does not statically resolve, so the binary is **not** traced automatically and must be named explicitly. `vercel.json` already does this for every function:

```json
"functions": {
  "api/*.ts": {
    "maxDuration": 30,
    "includeFiles": "node_modules/@nillion/blacklight-l1-sdk/dist/wasm/**"
  }
}
```

Without it, functions deploy but throw `ENOENT` on the missing `.wasm` at cold start and return an HTML 500 — which surfaces in the client as a `JSON.parse` error on the first `/api` call. It works locally regardless, because the file is present in `node_modules` on disk.

## Configuration

All environment variables are optional; with none set, the app reads a public Sepolia RPC and the currently supported network's live config.

| Variable            | Default                                        | Purpose                                                                                                                                   |
|---------------------|------------------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------|
| `SEPOLIA_RPC_URL`   | `https://ethereum-sepolia-rpc.publicnode.com`  | Sepolia JSON-RPC used by `/api` (server-side only, never shipped to the browser). Point at a paid/authenticated provider for reliability and larger `eth_getLogs` limits. |
| `BLACKLIGHT_CONFIG` | `0xebB338689fB32317DDFD8282F8a42dcA6271cB2d`   | The supported network's config anchor — Blacklight's `ProtocolConfig` proxy (C0), the one address the app pins. Set this only to follow a redeploy. |
| `SCAN_BLOCKS`       | `5000`                                         | How many recent blocks the event scans cover; falls back to 1,800 automatically if a provider rejects the range.                          |

Wallet discovery uses [EIP-6963](https://eips.ethereum.org/EIPS/eip-6963), so [MetaMask](https://metamask.io/), [Rainbow](https://rainbow.me/), and any other compliant injected wallet appear in the picker, with a fallback to a single injected provider. Keeper actions switch the wallet to Sepolia (adding the chain if it is unknown) before sending.

## Development

### Testing And Conventions

Formatting and linting are enforced by [Biome](https://biomejs.dev/), type checking by the [TypeScript](https://www.typescriptlang.org/) compiler in `strict` mode, and testing by [Vitest](https://vitest.dev/):

```shell
pnpm lint           # biome check
pnpm typecheck      # tsc
pnpm test           # vitest run
```

[Git hooks](https://git-scm.com/book/en/v2/Customizing-Git-Git-Hooks) are managed by [lefthook](https://lefthook.dev/) and installed with `pnpm install-hooks`: formatting is applied pre-commit, [Conventional Commits](https://www.conventionalcommits.org/) are enforced on the message, and the lint/typecheck/test triad runs pre-push. The same triad runs in [GitHub Actions](https://github.com/features/actions) on every push and pull request.

Coverage is gated at 100% (lines, branches, functions, statements) over `src/core`. That scope is deliberate: the `core` modules are pure, deterministic, and dependency-free, so they can be — and are — covered in full, and they hold the logic most worth pinning (the quorum-meter geometry, the state derivation, the condition shaping, the presentation helpers). The serverless handlers and the browser client are I/O against a live chain and a wallet; they are exercised against an unreachable RPC to confirm they degrade to clean errors rather than crashing, but their live behavior is validated on deploy rather than coverage-gated here.

### Project Structure

The split above is the convention to preserve. Pure logic that could run anywhere belongs in `src/core` and is tested there. Anything that needs the SDK or viem is server-only and belongs in `src/server`, behind the `api/` handlers. The browser client is a single module under `src/client`, bundled by [esbuild](https://esbuild.github.io/); it imports `src/core` so the client and server agree on formatting and on the meter geometry, and it imports nothing from `src/server`. The wire types in `src/shared/types.ts` are the contract between the two halves: every route returns one of them, and the client consumes them.

### Contributions

Contributions are welcome. Please ensure `pnpm lint`, `pnpm typecheck`, and `pnpm test` all pass, keep `src/core` at full coverage, and write commit messages in the Conventional Commits form the hooks enforce.

## License

[MIT](LICENSE). Conclave is not affiliated with Nillion, and nothing it reports is financial advice.
