# Compatibility

`0.1.0-alpha.0` is private and unpublished. Usage and configuration: [README](../README.md).

## Dependencies and runtime

| Dependency | Version |
| --- | --- |
| `@tetherto/wdk` | `1.0.0-beta.19` |
| `@tetherto/wdk-wallet` | `^1.0.0-beta.23` |
| `@tetherto/wdk-wallet-evm` | `1.0.0-beta.21` |
| `ethers` | `6.17.0` |
| `bare-node-runtime` | `1.5.1` |

ESM JavaScript, JSDoc-generated declarations, Node.js 22+, and a conditional Bare entrypoint.

`@tetherto/wdk-wallet` is a caret range on purpose. `WDK.registerProtocol` checks `instanceof SwidgeProtocol` against core's copy of `@tetherto/wdk-wallet`, and core declares a caret range, so the module must resolve the same copy. EVM beta.21 pins its own wallet beta.21, so account errors can come from a second copy and cross-package `instanceof` checks on them are unreliable.

Strict TypeScript `WDK.registerWallet(..., WalletManagerEvm, ...)` still fails on conflicting private `_seed` declarations, even without Fynd. JavaScript registration works. The type fixtures record this upstream error and check Fynd's constructor, `registerProtocol` and public interfaces.

From an RPC URL string, WDK beta.21 builds `new JsonRpcProvider(url, network, { staticNetwork: true })`, which keeps ethers' 250 ms response cache. Two transactions sent from one account within that window read the same pending nonce, and the second fails or replaces the first. Integrators should pass a provider with `cacheTimeout: -1`. This is a WDK issue, not specific to this module.

WDK has no public `quoteApprove`. The module passes no gas overrides to `approve` or `sendTransaction`; the account's provider sets gas and the transaction chain ID. Configure WDK and Fynd for the same chain; module configuration does not verify the provider's network.

## Errors and legacy helpers

The module throws WDK's `ValueError`, `InvalidTokenError`, `AccountRequiredError`, `ReadOnlyAccountRequiredError`, `MaximumFeeExceededError`, `ProviderError`, `SwidgeError` and `NotImplementedError`. `FyndExecutionError` adds transaction progress; inherited legacy wrappers expose it through `cause`.

WDK's legacy scalar fee adds unlike token denominations. Use Swidge's itemized fees. See [fees and failures](../README.md#fees-and-failures).

## Router contract

Addresses and ABI follow `tycho-execution 0.423.0`: [deployments](https://github.com/propeller-heads/tycho/blob/8be328bfc02c6f46cf39f60ef8b31cbb5d1b0d39/crates/tycho-execution/config/router_addresses.json), [TychoRouterV3](https://github.com/propeller-heads/tycho/blob/8be328bfc02c6f46cf39f60ef8b31cbb5d1b0d39/crates/tycho-execution/contracts/src/TychoRouterV3.sol). The seven addresses matched the [router registry](https://raw.githubusercontent.com/propeller-heads/tycho/main/crates/tycho-execution/config/deployment_registry.json) on October 13, 2026.

Approvals target the pinned router. Validation checks the outer call arguments and rejects unknown selectors; nested routes depend on Fynd and the router's executors.

The router enforces a deadline only when the client-fee receiver is nonzero (`_verifyClientSignature`). For execution, the module asks Fynd for zero-fee client parameters naming the sender, with a deadline `deadlineSeconds` ahead. Fynd leaves a zeroed 65-byte signature at `transaction.client_fee_signature_offset`. The module checks the decoded parameters, signs the `ClientFee` struct with the account's `signTypedData` (domain `TychoRouter`, version `1`, the chain ID and router address), writes the signature over the placeholder and checks that the calldata decodes with it. With the sender as receiver, the router's fee rates resolve to the same client as the zero-receiver default for an EOA, and the client fee is zero.

Quotes are never signed or sent, so they request no client-fee parameters and accept any zero-fee parameters Fynd chooses.

`tests/live-fork.test.js` checked this on October 13, 2026 against the deployed Ethereum router, with both the hosted API (Fynd 0.111.1) and a self-hosted Fynd 0.108.0: the on-chain EIP-712 domain and `CLIENT_FEE_TYPEHASH` match, a signed swap settles, and the router rejects it after the deadline or with a changed signature.

## Hosted and self-hosted Fynd

The hosted gateway serves each chain at `/v1/{slug}` and needs an API key. A self-hosted Fynd serves one chain at `/v1` without authentication. Both return the same request and response bodies. The module checks `/info` once per instance and rejects a chain ID or router address that differs from the pinned values.

## Unresolved

- License: none granted yet.
- npm scope and package name (to confirm with Tether) and publisher.
- Tether's Generic Implementation Requirements document has not been reviewed.
- Tether confirmation for exact-input scope, account binding, fee estimates and caps, legacy fees, original-hash status and token discovery semantics.

## Upgrades

- **WDK:** review published account methods, chain population, approvals, typed-data signing, receipts, errors and Swidge types. Check class identity, direct account construction and registration in a fresh packed consumer.
- **Fynd:** compare deployed responses with parser fixtures, including slippage, fee arithmetic, the signature offset, gas units, token discovery and timeout and error handling. Run the live fork test.
- **Router:** compare deployed code, ABI, EIP-712 domain, client-fee type and fee behavior against the pinned sources. Update constants, validator, fixture router and tests together.
- **Package:** rebuild declarations; test exports, cap boundaries, approvals, partial failures, status and discovery. Run Node and Bare checks, audit dependencies and inspect the pack for secrets. Record changed contracts in the changelog.
