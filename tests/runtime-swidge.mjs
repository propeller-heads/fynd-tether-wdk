// Copyright 2026 PropellerHeads AG

// Main flow from an app's point of view: register, getSwidgeProtocol, swidge. wdk-account.test.js
// runs it under Bare from the packed package against a local Anvil chain and mock Fynd.
import WDK from '@tetherto/wdk'
import WalletManagerEvm from '@tetherto/wdk-wallet-evm'
import { JsonRpcProvider, ZeroAddress } from 'ethers'
import FyndSwidgeProtocol from '@propellerheads/wdk-protocol-swidge-fynd'

const { RPC_URL, FYND_BASE_URL, TO_TOKEN, RECIPIENT } = process.env
// Anvil's public, disposable development mnemonic. Never use for real funds.
const mnemonic = 'test test test test test test test test test test test junk'
const provider = new JsonRpcProvider(RPC_URL, 1, { staticNetwork: true, cacheTimeout: -1 })
const wdk = new WDK(mnemonic)
  .registerWallet('ethereum', WalletManagerEvm, { provider, chainId: 1 })
  .registerProtocol('ethereum', 'fynd', FyndSwidgeProtocol, { chainId: 1, baseUrl: FYND_BASE_URL })
try {
  const account = await wdk.getAccount('ethereum', 0)
  const protocol = account.getSwidgeProtocol('fynd')
  const result = await protocol.swidge({
    fromToken: ZeroAddress, toToken: TO_TOKEN, fromTokenAmount: 10n ** 16n, minAmountOut: 1n, recipient: RECIPIENT
  })
  console.log(JSON.stringify({
    runtime: typeof Bare === 'undefined' ? 'node' : 'bare',
    module: import.meta.resolve('@propellerheads/wdk-protocol-swidge-fynd'),
    instance: protocol instanceof FyndSwidgeProtocol,
    hash: result.hash
  }))
} finally {
  wdk.dispose()
  provider.destroy()
}
