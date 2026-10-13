# Fynd Swidge for WDK

[![Powered by WDK](https://img.shields.io/badge/Powered_by-WDK-26A17B)](https://docs.wdk.tether.io/)

A [WDK](https://docs.wdk.tether.io/) Swidge module for same-chain, exact-input swaps routed by [Fynd](https://github.com/propeller-heads/fynd), the PropellerHeads DEX aggregator. Use the hosted Fynd API or point the module at your own Fynd server. Fynd supplies routes and calldata; WDK handles approvals, signing, broadcast and transaction lookup.

It implements `ISwidgeProtocol` from `@tetherto/wdk-wallet` `^1.0.0-beta.23`, tested with `@tetherto/wdk` `1.0.0-beta.19` and `@tetherto/wdk-wallet-evm` `1.0.0-beta.21`.

## Supported chains

Matches the [hosted API's chain list](https://github.com/propeller-heads/fynd/blob/main/docs/get-started/hosted-api.md#supported-chains) as of October 13, 2026. New chains require a module release.

| Chain | ID | API slug | Native token |
| --- | ---: | --- | --- |
| Ethereum | 1 | `ethereum` | ETH |
| Base | 8453 | `base` | ETH |
| Arbitrum | 42161 | `arbitrum` | ETH |
| BNB Smart Chain | 56 | `bsc` | BNB |
| Polygon | 137 | `polygon` | POL |
| Unichain | 130 | `unichain` | ETH |
| Robinhood Chain | 4663 | `robinhood` | ETH |

`getSupportedTokens()` lists the tokens Fynd tracks on the configured chain: quality 100, zero transfer tax, plus the native token.

## Settlement through the Tycho router

Swaps built from Fynd quotes must settle through the Tycho router for their chain, with its fees intact, as the [Fynd License](https://github.com/propeller-heads/fynd/blob/main/LICENSE.md) requires. This module only sends swaps to that router and rejects calldata for any other destination.

## Install

This alpha package is private and unpublished. With Node.js 22+ and pnpm 11:

```sh
pnpm install --frozen-lockfile
pnpm build
cp .env.example .env
```

## Configure

| Option | Default | Meaning |
| --- | --- | --- |
| `chainId` | required | Numeric ID from the table above. |
| `apiKey` | none | Raw `Authorization` value for the hosted API, without `Bearer`. |
| `baseUrl` | `https://fynd-api.propellerheads.xyz` | Hosted API, or your proxy in front of it. Requests go to `{baseUrl}/v1/{slug}`. |
| `selfHostedUrl` | none | Your own Fynd server. Requests go to `{selfHostedUrl}/v1`. Cannot be combined with `apiKey` or `baseUrl`. |
| `quoteSender` | none | Nonzero address for quotes without an account. The account address takes precedence. |
| `deadlineSeconds` | `120` | How long a signed swap stays valid. The router rejects it after that. |
| `timeoutMs` | `10000` | Per request, including response bodies and the whole token list. |
| `approvalTimeoutMs` | `180000` | Confirmation deadline for each approval. |
| `maxNetworkFeeBps`, `maxProtocolFeeBps` | none | Execution caps, as `number` or `bigint`. See [fees](#fees-and-failures). |

Keep API keys on a backend or behind your own proxy. HTTPS is required except on localhost; URLs cannot contain credentials, queries or fragments. Requests are not retried.

Give WDK an ethers provider with `cacheTimeout: -1`, as in the example below. From an RPC URL string, WDK builds a provider that caches the pending nonce for 250 ms, so back-to-back transactions from one account can reuse a nonce and fail. This affects every WDK module, not only this one.

Configure WDK and the module for the same chain; the module cannot check the account's RPC network. Execution requires an ordinary, non-delegated EVM account that can sign typed data. ERC-4337, paymasters, EIP-7702 and Permit2 are unsupported.

### Self-hosted Fynd

Run Fynd yourself with the [self-host quickstart](https://github.com/propeller-heads/fynd/tree/main/docs/get-started/quickstart), then set `selfHostedUrl` and leave out `apiKey`. One Fynd server serves one chain; it needs its own RPC node and a Tycho API key, and running it is subject to the Fynd License. Its router must match the pinned router for the chain, or every quote is rejected.

## Use

Fill `.env`, save this as `wallet.mjs` in the package directory, then run the commands below. The default action quotes. Execution spends funds and requires `MIN_AMOUNT_OUT`, in output-token base units. For status, set `SWAP_ID` to the returned hash.

```js
import WDK from '@tetherto/wdk'
import WalletManagerEvm from '@tetherto/wdk-wallet-evm'
import { JsonRpcProvider } from 'ethers'
import FyndSwidgeProtocol, { FyndExecutionError } from '@propellerheads/wdk-protocol-swidge-fynd'

const required = name => {
  if (!process.env[name]) throw new Error(`Set ${name}`)
  return process.env[name]
}
const chainId = Number(process.env.CHAIN_ID ?? '1')
const walletName = 'evm'
const fynd = process.env.FYND_SELF_HOSTED_URL
  ? { selfHostedUrl: process.env.FYND_SELF_HOSTED_URL }
  : { apiKey: required('FYND_API_KEY'), baseUrl: process.env.FYND_BASE_URL || undefined }
// No response cache, so each transaction reads a fresh nonce.
const provider = new JsonRpcProvider(required('RPC_URL'), chainId, { staticNetwork: true, cacheTimeout: -1 })
const wdk = new WDK(required('WDK_SEED_PHRASE'))
  .registerWallet(walletName, WalletManagerEvm, { provider, chainId })
  .registerProtocol(walletName, 'fynd', FyndSwidgeProtocol, { chainId, ...fynd })

try {
  const account = await wdk.getAccount(walletName, 0)
  const protocol = account.getSwidgeProtocol('fynd')
  const action = process.env.ACTION ?? 'quote'
  if (action === 'status') {
    console.dir(await protocol.getSwidgeStatus(required('SWAP_ID')), { depth: null })
  } else {
    if (action !== 'quote' && action !== 'execute') throw new Error('Unknown ACTION')
    const options = {
      fromToken: required('FROM_TOKEN'), toToken: required('TO_TOKEN'),
      fromTokenAmount: BigInt(required('AMOUNT_IN')), slippage: 0.005,
      ...(process.env.RECIPIENT ? { recipient: process.env.RECIPIENT } : {})
    }
    if (action === 'quote') {
      console.dir(await protocol.quoteSwidge(options), { depth: null })
    } else {
      const caps = {
        ...(process.env.MAX_NETWORK_FEE_BPS ? { maxNetworkFeeBps: BigInt(process.env.MAX_NETWORK_FEE_BPS) } : {}),
        ...(process.env.MAX_PROTOCOL_FEE_BPS ? { maxProtocolFeeBps: BigInt(process.env.MAX_PROTOCOL_FEE_BPS) } : {})
      }
      const minAmountOut = BigInt(required('MIN_AMOUNT_OUT'))
      console.dir(await protocol.swidge({ ...options, minAmountOut }, caps), { depth: null })
    }
  }
} catch (error) {
  if (error instanceof FyndExecutionError) {
    console.error({ stage: error.stage, transactions: error.transactions,
      submissionUnknown: error.submissionUnknown })
  } else {
    console.error(error instanceof Error ? error.message : 'Operation failed')
  }
  process.exitCode = 1
} finally {
  wdk.dispose()
  provider.destroy()
}
```

```sh
ACTION=quote node --env-file=.env wallet.mjs
ACTION=execute node --env-file=.env wallet.mjs
ACTION=status node --env-file=.env wallet.mjs
```

Keep `.env` local. Production wallets should use their existing custody flow for signer material.

## API

| Method | Result |
| --- | --- |
| `quoteSwidge(options)` | Non-binding quote; checks the minimum and slippage without applying fee caps. |
| `swidge(options, config?)` | Approves if needed, requotes after approval, signs the swap deadline, broadcasts one swap and returns `id`, `hash`, `transactions` and quoted amounts and fees. |
| `getSwidgeStatus(id, options?)` | Looks up the original hash through a full or read-only account. |
| `getSupportedChains()` | The supported chains above. |
| `getSupportedTokens(options?)` | Tokens on the configured chain, from one consistent block. `fromToken` filtering is unsupported. |

Swap options require `fromToken`, `toToken` and `fromTokenAmount`. `swidge` also requires `minAmountOut`, a positive floor in output-token base units that you set independently of Fynd. Optional: `recipient` (the sender by default), `slippage` (default `0.005`, or 0.5%) and a matching `toChain`. Chain hints accept the numeric ID, decimal string or API slug.

Amounts are base-unit `bigint` values or safe integers. Native ETH, BNB and POL use `0x0000000000000000000000000000000000000000` or the all-`e` address; wrapped native tokens are ERC-20s. Exact-output, cross-chain and same-token swaps, `refundAddress`, fee-on-transfer and rebasing tokens are unsupported.

Quotes return net `toTokenAmount`, executable `toTokenAmountMin`, itemized `fees`, `networkFeeComplete` and an optional decimal `priceImpact`. Slippage checks use Fynd's reported output and rounding, not an independent market price; `minAmountOut` is the independent floor. Execution fetches a fresh quote.

Each executed swap carries zero-fee client parameters naming the sender, signed by the sender's account with EIP-712. That lets the router enforce `deadlineSeconds`: a swap mined after its deadline reverts instead of settling at a stale price. No client fee is charged.

Token discovery uses Fynd's experimental `/tokens` endpoint. A changed block or total during pagination, or an expired timeout, fails the call without partial results.

## Fees and failures

| Fynd cost | Swidge fee `type` | Token | `included` | Legacy `swap`/`quoteSwap` `fee` |
| --- | --- | --- | --- | --- |
| Router fee | `protocol` | Output token | `true`, already deducted from `toTokenAmount` | Added in (mixed units) |
| Network cost | `network` | Native token | `false` | Added in (mixed units) |

Same-chain swaps have no bridge fee, and the legacy `bridge`/`quoteBridge` helpers are unsupported. WDK's legacy `swap` helpers add both fees into one number in different tokens, so use Swidge's itemized fees. Positive slippage can increase the settled router fee.

`networkFeeComplete` is true only with an account, no pending approval and a successful WDK estimate on Ethereum, BNB Smart Chain or Polygon. On Base, Arbitrum, Unichain and Robinhood Chain the estimate misses the L1 data fee. Without a WDK estimate, Fynd's gas × gas price is an indicative fallback; an omitted network fee means unknown cost, not zero.

Caps apply only to execution. The protocol cap compares the router fee with gross output. The network cap needs a complete estimate as above; it compares cost with the native input or an input-to-native valuation quote, and otherwise rejects before any write. Per-call caps override constructor values; `undefined` inherits, and zero remains active.

Execution skips sufficient allowance, otherwise approves the exact input, resetting nonzero insufficient Ethereum USDT allowance first. It confirms approvals before requoting. **A later quote, cap, minimum or slippage failure can leave approvals active and gas spent.** Confirmed approval fees are added to the result's network fee.

Persist returned transaction hashes. `FyndExecutionError` exposes `stage`, `transactions`, `submissionUnknown` and `cause`. If submission is unknown, reconcile wallet history before resubmitting.

Run one execution per account at a time. WDK takes each nonce from the pending transaction count, so the module refuses a second `swidge` from the same chain and address until the first returns. Other code sending from that account meanwhile can still reuse a nonce.

| WDK receipt | Swidge status |
| --- | --- |
| Pending or dropped | `pending` |
| Confirmed or final, succeeded | `completed` |
| Confirmed or final, reverted (including after the deadline) | `failed` |
| Not found | throws `NoSuchElementError` |

Replacement tracking belongs to the wallet. A supplied hash is not checked to be a Fynd swap, and `completed` does not mean irreversible finality.

### Errors

| Error | When |
| --- | --- |
| `ValueError` | Invalid configuration or options, missing `minAmountOut` for execution, delegated account. |
| `InvalidTokenError` | A token is not an EVM address or the native address. |
| `AccountRequiredError`, `ReadOnlyAccountRequiredError` | The call needs a writable or read-only account. |
| `MaximumFeeExceededError` | A quoted fee exceeds its cap. |
| `ProviderError` | Fynd HTTP, timeout or response-format failures. |
| `SwidgeError` | `reason` is `INVALID_TRANSACTION`, `UNSUPPORTED_ROUTER`, `SLIPPAGE_TOO_HIGH`, `COULD_NOT_MET_THRESHOLD`, `FEE_ESTIMATE_UNAVAILABLE`, `APPROVAL_FAILED`, `ALLOWANCE_INSUFFICIENT`, `EXECUTION_IN_PROGRESS` or `FYND_<STATUS>` for a failed Fynd quote. |
| `NotImplementedError` | Pair-scoped token discovery. |
| `FyndExecutionError` | Execution stopped after it started; see above. |

Wallet and RPC failures can propagate their own errors. Messages and causes are not stable contracts. See [compatibility](docs/compatibility.md) for WDK and router details.

## Development

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Tests need Anvil 1.7.1 on `PATH` (or `ANVIL_BIN`) and loopback ports. They run fixture contracts, Node and Bare locally. `tests/live-fork.test.js` also runs against the hosted API and Tycho's deployed Ethereum router on a mainnet fork when `FYND_API_KEY` and `ETHEREUM_RPC_URL` are set.

[Source](https://github.com/propeller-heads/fynd-tether-wdk) · [Fynd support](https://t.me/+B4CNQwv7dgIyYTJl) · [Security reports](SECURITY.md)

Copyright 2026 PropellerHeads AG. Licensed under [Apache 2.0](LICENSE).
