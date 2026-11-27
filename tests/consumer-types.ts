// Copyright 2026 PropellerHeads AG
import WDK from '@tetherto/wdk'
import Wallet, { WalletAccountEvm, WalletAccountReadOnlyEvm } from '@tetherto/wdk-wallet-evm'
// Imports the package name so this checks the committed types/, not the JSDoc source.
import Fynd, {
  FyndExecutionError, FyndSwidgeProtocol, type FyndConfig, type FyndExecutionStage, type FyndSwidgeQuote,
  type FyndSwidgeResult, type ISwidgeProtocol, type SwidgeOptions, type SwidgeProtocolConfig, type SwidgeQuote,
  type SwidgeResult, type SwidgeTransaction
} from '@propellerheads/wdk-protocol-swidge-fynd'

const config: FyndConfig = { chainId: 1, quoteSender: '0x1111111111111111111111111111111111111111', deadlineSeconds: 300 }
const selfHosted: FyndConfig = { chainId: 8453, selfHostedUrl: 'http://localhost:3000' }
for (const chainId of [1, 8453, 42161, 56, 137, 130, 4663] as const) new Fynd(undefined, { ...config, chainId })
// @ts-expect-error The hosted API does not support this chain.
new Fynd(undefined, { chainId: 2 })
// @ts-expect-error chainId is required.
new Fynd(undefined, {})
// @ts-expect-error chainId is required for registration too.
new WDK('test test test test test test test test test test test junk').registerProtocol('ethereum', 'fynd', Fynd, {})
const protocol: ISwidgeProtocol = new Fynd(undefined, config)
const named: ISwidgeProtocol = new FyndSwidgeProtocol(undefined, config)
const seed = 'test test test test test test test test test test test junk'
const readOnly = new WalletAccountReadOnlyEvm('0x1111111111111111111111111111111111111111', { chainId: 1 })
const full = new WalletAccountEvm(seed, "0'/0/0", { chainId: 1 })
const withReadOnly: ISwidgeProtocol = new Fynd(readOnly, config)
const withFull: ISwidgeProtocol = new Fynd(full, config)
const wdk = new WDK(seed)
wdk.registerProtocol('ethereum', 'fynd', Fynd, config)

// EVM beta.21/core beta.19 have incompatible private WalletManager._seed types.
// Remove this assertion after the upstream fix. Runtime registration has separate tests.
// @ts-expect-error Upstream EVM wallet registration has incompatible private _seed types.
wdk.registerWallet('ethereum', Wallet, { chainId: 1 })
const swap: SwidgeOptions = { fromToken: '0x0000000000000000000000000000000000000000', toToken: '0xdAC17F958D2ee523a2206206994597C13D831ec7', fromTokenAmount: 1n }
const caps: SwidgeProtocolConfig = { maxProtocolFeeBps: 10 }
async function useResults (fynd: FyndSwidgeProtocol): Promise<void> {
  const quote: FyndSwidgeQuote = await fynd.quoteSwidge(swap)
  const base: SwidgeQuote = quote
  const result: FyndSwidgeResult = await fynd.swidge({ ...swap, minAmountOut: 1n }, caps)
  const plain: SwidgeResult = result
  const firstTransaction: SwidgeTransaction | undefined = result.transactions?.[0]
  void [quote.networkFeeComplete, base, plain, firstTransaction]
}
function stageOf (error: unknown): FyndExecutionStage | undefined {
  return error instanceof FyndExecutionError ? error.stage : undefined
}
// @ts-expect-error stage is a closed union.
const badStage: FyndExecutionStage = 'swap'
void useResults
void stageOf
void badStage
void protocol
void selfHosted
void named
void withReadOnly
void withFull
