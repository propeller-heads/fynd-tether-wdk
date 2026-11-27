# Changelog

## 0.1.0-alpha.0 (unreleased)

- Add quotes, exact-input execution, status and token discovery for all seven hosted Fynd chains.
- Support a self-hosted Fynd server through `selfHostedUrl`.
- Sign zero-fee client parameters on every executed swap so the router enforces `deadlineSeconds` (default 120).
- Require `minAmountOut` for execution.
- Apply network fee caps on Ethereum, BNB Smart Chain and Polygon.
- Validate router calls and caller limits; preserve transaction progress after failures.
- Report failures with WDK error classes and `ProviderErrorReason` or `SwidgeErrorReason` values, keeping the original error as `cause`; five more Swidge reasons are proposed to WDK.
- Depend only on `@tetherto/wdk-wallet`, `ethers` and `bare-node-runtime`; `@tetherto/wdk-wallet-evm` is an optional peer dependency.
- Add Node and Bare support, hand-maintained declarations, tests and usage docs.
