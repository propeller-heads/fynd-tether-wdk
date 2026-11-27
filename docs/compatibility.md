# Compatibility

`0.1.0-alpha.0` is private and unpublished. Usage and configuration: [README](../README.md).

## Dependencies and runtime

| Dependency | Kind | Version |
| --- | --- | --- |
| `@tetherto/wdk-wallet` | dependency | `^1.0.0-beta.23` |
| `ethers` | dependency | `6.17.0` |
| `bare-node-runtime` | dependency | `1.5.1` |
| `@tetherto/wdk-wallet-evm` | optional peer; tests use `1.0.0-beta.21` | `^1.0.0-beta.21` |
| `@tetherto/wdk` | dev only; the app supplies core | `1.0.0-beta.19` |

`@tetherto/wdk-wallet-evm` appears only in JSDoc types, and each release pins `@tetherto/wdk-wallet` exactly. As a dependency it would install a second `wdk-wallet` in every app. The module never imports core, so `@tetherto/wdk` is only a dev dependency.

The package is ESM JavaScript with committed, hand-maintained declarations in `types/`. It needs Node.js 22+ or Bare 1.35+, and Bare loads it through a conditional entrypoint.

`@tetherto/wdk-wallet` is a caret range on purpose. `WDK.registerProtocol` checks `instanceof SwidgeProtocol` against core's copy of `@tetherto/wdk-wallet`, and core declares a caret range, so the module must resolve the same copy. EVM beta.21 pins its own wallet beta.21, so account errors can come from a second copy and cross-package `instanceof` checks on them are unreliable.

Strict TypeScript `WDK.registerWallet(..., WalletManagerEvm, ...)` still fails on conflicting private `_seed` declarations, even without Fynd. JavaScript registration works. The type fixtures record this upstream error and check Fynd's constructor, `registerProtocol` and public interfaces.

From an RPC URL string, WDK beta.21 builds `new JsonRpcProvider(url, network, { staticNetwork: true })`, which keeps ethers' 250 ms response cache. Two transactions sent from one account within that window read the same pending nonce, and the second fails or replaces the first. Integrators should pass a provider with `cacheTimeout: -1`. This is a WDK issue, not specific to this module.

WDK has no public `quoteApprove`. The module passes no gas overrides to `approve` or `sendTransaction`; the account's provider sets gas and the transaction chain ID. Configure WDK and Fynd for the same chain; module configuration does not verify the provider's network.

## Errors and legacy helpers

The module throws WDK's `ValueError`, `InvalidTokenError`, `AccountRequiredError`, `ProviderRequiredError`, `MaximumFeeExceededError`, `ProviderError` and `SwidgeError`. `FyndExecutionError` adds transaction progress; inherited legacy wrappers expose it through `cause`. Translated errors keep the original as `cause`. That includes `fetch` failures: Node and Bare causes name the failure (refused, DNS, TLS, redirect, reset) and carry no request headers, and `baseUrl` cannot hold credentials. HTTP error bodies are never included. A `JSON.parse` cause for a malformed 2xx body quotes a short excerpt: about 10 characters on each side of the parse error.

RPC failures from account reads become `ProviderError`: ethers `NETWORK_ERROR`, `SERVER_ERROR` and `TIMEOUT`, socket errors such as `ECONNREFUSED` and `ENOTFOUND` that ethers passes through, and JSON-RPC errors such as rate limits (`INTERNAL_SERVER_ERROR`). ethers files every `eth_call` JSON-RPC error as `CALL_EXCEPTION`, so an allowance call becomes `InvalidTokenError` only when it carries revert data or a revert message, or returns undecodable data. Only simulation failures (`CALL_EXCEPTION`, `INSUFFICIENT_FUNDS`) fall back to Fynd's gas estimate; a rate-limited gas estimate is also a `CALL_EXCEPTION`, so it falls back too, with the fee marked incomplete. Other errors pass through unchanged.

`reason` values come from `ProviderErrorReason` and `SwidgeErrorReason`, plus five Swidge reasons WDK does not define yet: `NO_ROUTE_FOUND`, `INSUFFICIENT_LIQUIDITY`, `FEE_ESTIMATE_UNAVAILABLE`, `APPROVAL_FAILED` and `EXECUTION_IN_PROGRESS`. They are proposed for `SwidgeErrorReason`.

WDK's legacy scalar fee adds unlike token denominations. Use Swidge's itemized fees. See [fees and failures](../README.md#fees-and-failures).

## Router contract

The nine addresses are the active TychoRouterV3 deployments in Tycho's [deployment registry](https://raw.githubusercontent.com/propeller-heads/tycho/main/crates/tycho-execution/config/deployment_registry.json) (registry version 2026-11-23), effective November 16, 2026 ([deployment record](https://github.com/propeller-heads/tycho/commit/8aab890549e09358f5de1b3fc3eb3d6af9906a92)). Tycho redeployed every router that day to fix a vault-accounting vulnerability, without the usual 30-day notice, and listed the previous routers as superseded. The new routers are built from [TychoRouterV3 at `94845b6a`](https://github.com/propeller-heads/tycho/blob/94845b6ac42b6dbe3007f4f380c21d64dd47a443/crates/tycho-execution/contracts/src/TychoRouterV3.sol). Against the earlier [`tycho-execution 0.423.0` source](https://github.com/propeller-heads/tycho/blob/8be328bfc02c6f46cf39f60ef8b31cbb5d1b0d39/crates/tycho-execution/contracts/src/TychoRouterV3.sol), `ClientFeeParams`, `CLIENT_FEE_TYPEHASH`, `_verifyClientSignature` and the `singleSwap`, `sequentialSwap` and `splitSwap` signatures are unchanged, so only the addresses changed here. On November 27, 2026, each of the nine addresses had code on its chain with the `TychoRouter` version `1` EIP-712 domain for that chain, the expected `CLIENT_FEE_TYPEHASH` and all three swap selectors.

On the same day, hosted Fynd's `/info` reported the pinned chain ID and router on all nine chains. Tycho's registry also lists an active router on Plasma (chain ID 9745), but hosted Fynd answers `unknown_chain` for it, so the module does not support Plasma.

Tycho can replace a router again. When it does, the module rejects every quote until a release updates the pins, because `/info` reports a router that differs from the pinned one.

Approvals target the pinned router. Validation checks the outer call arguments and rejects unknown selectors; nested routes depend on Fynd and the router's executors.

The router enforces a deadline only when the client-fee receiver is nonzero (`_verifyClientSignature`). For execution, the module asks Fynd for zero-fee client parameters naming the sender, with a deadline `deadlineSeconds` ahead. Fynd leaves a zeroed 65-byte signature at `transaction.client_fee_signature_offset`. The module checks the decoded parameters, signs the `ClientFee` struct with the account's `signTypedData` (domain `TychoRouter`, version `1`, the chain ID and router address), writes the signature over the placeholder and checks that the calldata decodes with it. With the sender as receiver, the router's fee rates resolve to the same client as the zero-receiver default for an EOA, and the client fee is zero.

Quotes are never signed or sent, so they request no client-fee parameters and accept any zero-fee parameters Fynd chooses.

## Live fork runs

`tests/live-fork.test.js` checks the signing above against each chain's deployed router on an Anvil fork, for every chain whose `<CHAIN>_RPC_URL` is set: the on-chain EIP-712 domain and `CLIENT_FEE_TYPEHASH` match, a signed swap from the native token settles, and the router rejects it after the deadline or with a changed signature. The Ethereum fork is pinned to `ETHEREUM_FORK_BLOCK_NUMBER`, which fixes the router code and state these checks run against. Other chains fork 10 blocks behind their head, because public RPCs keep only recent state. Fynd quotes live state, so a run's quote and route cannot be reproduced. The swap allows 5% slippage for price movement since the fork block, and the Ethereum settlement check can fail once the pinned block is old enough that routes use newer pools; re-pin to a recent block then. Record each run's block and Fynd version (`version` from `/info`) below.

Anvil does not reproduce every chain exactly, so a fork can reject a route that executes on the live chain:

- **Base:** Anvil 1.7.1 forks Base with its Jovian spec, which lacks the CLZ opcode (EIP-7939) that Ekubo v3 uses. Fynd transactions through Ekubo v3 that reverted on the fork succeeded in an `eth_call` on Base. The test forks Base with `--hardfork osaka`.
- **Robinhood Chain and Elysium:** these Arbitrum Orbit chains answer `arbBlockNumber()` from the ArbSys precompile (`0x64`), but Anvil copies it as an `INVALID` opcode, so Elysium pools that read it reverted on the fork. The test installs a stub that answers that call with the fork's block number. Arbitrum One gets no stub, because Anvil forks it with the L1 block number.
- **Arc:** ERC-20 USDC (`0x3600…`) moves balances through a native precompile at `0x1800…` that Anvil does not implement, so routes that call USDC's `transfer` revert on a fork, while the same transfer succeeds in an `eth_call` on Arc. Arc settles on a fork only when Fynd's route avoids that call.
- **RPCs:** publicnode's Arbitrum and Unichain endpoints keep about 100 blocks of state and return HTTP 403 for older state mid-run. Use `https://arb1.arbitrum.io/rpc` and `https://mainnet.unichain.org`.

| Date | Fork block | Fynd | Result |
| --- | --- | --- | --- |
| October 13, 2026 | latest (unpinned), ETH to USDC | hosted 0.111.1, self-hosted 0.108.0 | Passed |
| November 27, 2026 | 26504600 (pinned default) | hosted 0.129.3 | Failed: all three tests stopped at the `/info` router check, because the pins still named the routers Tycho superseded on November 16 |
| November 27, 2026 | 26504600 (pinned default) | hosted 0.129.3 | Passed, after updating the pins to the November 16 routers |

Two nine-chain runs on November 27, 2026, with hosted Fynd 0.129.3. Ethereum used block 26504600; the other chains forked 10 blocks behind their head, which vitest does not print. Run 4 added the Base, ArbSys and RPC fixes above.

| Chain | Run 3 | Run 4 |
| --- | --- | --- |
| Ethereum | Passed | Passed |
| Base | Failed: every route used Ekubo v3, which needs CLZ | Settles and rejects passed. Signs failed: gas estimation reverted without data on an RFQ route |
| Arbitrum | Passed | Signs failed once; all three passed when rerun alone |
| BNB Smart Chain | Settles failed: the mined swap reverted, reason not captured; not seen again in run 4 or in diagnostics | Passed |
| Polygon | Passed | Passed |
| Unichain | Passed | Passed |
| Robinhood Chain | Passed | Passed |
| Arc | Passed | Failed: the route called ERC-20 USDC's `transfer` |
| Elysium | Rejects failed: the route reached ArbSys through an RFQ leg | Passed |

## Hosted and self-hosted Fynd

The hosted gateway serves each chain at `/v1/{slug}` and needs an API key. A self-hosted Fynd serves one chain at `/v1` without authentication. Both return the same request and response bodies. The module checks `/info` once per instance and rejects a chain ID or router address that differs from the pinned values.

## Unresolved

- Not yet published to npm.
- Whether some routes need more gas than WDK's estimate on live chains. In fork replays of raw Fynd transactions, three routes failed at Anvil's exact estimate and succeeded with twice the gas: an RFQ route on Base, a PancakeSwap v3 route on Arbitrum, and a Base Aerodrome pool whose hook reverted with `IG` well below the limit. The module passes no gas overrides, so WDK's estimate sets the limit.
- Tether's Generic Implementation Requirements document has not been reviewed.
- Tether confirmation for exact-input scope, account binding, fee estimates and caps, legacy fees, original-hash status and token discovery semantics.

## Upgrades

- **WDK:** review published account methods, chain population, approvals, typed-data signing, receipts, errors and Swidge types. Check class identity, direct account construction and registration in a fresh packed consumer.
- **Fynd:** compare deployed responses with parser fixtures, including slippage, fee arithmetic, the signature offset, gas units, token discovery and timeout and error handling. Run the live fork test.
- **Router:** compare deployed code, ABI, EIP-712 domain, client-fee type and fee behavior against the pinned sources. Update constants, validator, fixture router and tests together.
- **Package:** update `types/` by hand for changed JSDoc; test exports, cap boundaries, approvals, partial failures, status and discovery. Run Node and Bare checks, audit dependencies and inspect the pack for secrets. Record changed contracts in the changelog.
