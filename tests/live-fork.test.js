// Copyright 2026 PropellerHeads AG

// Opt-in: runs the adapter against Fynd and Tycho's deployed Ethereum router on an Anvil
// mainnet fork. Set ETHEREUM_RPC_URL (a mainnet RPC that can serve recent state) and either
// FYND_API_KEY for the hosted API or FYND_SELF_HOSTED_URL for your own Ethereum Fynd server.
// No real funds move.
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Contract, Interface, JsonRpcProvider, TypedDataEncoder, Wallet, ZeroAddress, id, toBeHex } from 'ethers'
import WDK from '@tetherto/wdk'
import WalletManagerEvm from '@tetherto/wdk-wallet-evm'
import FyndSwidgeProtocol from '../index.js'
import { CHAINS, clientFeeTypedData } from '../src/router.js'

const apiKey = process.env.FYND_API_KEY
const selfHostedUrl = process.env.FYND_SELF_HOSTED_URL
const forkUrl = process.env.ETHEREUM_RPC_URL
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
// A fresh wallet funded on the fork only. Anvil's public dev accounts carry EIP-7702
// delegations on mainnet, which the adapter refuses.
const mnemonic = /** @type {import('ethers').Mnemonic} */ (Wallet.createRandom().mnemonic).phrase
const routerAbi = new Interface([
  'function eip712Domain() view returns (bytes1, string name, string version, uint256 chainId, address verifyingContract, bytes32, uint256[])',
  'function CLIENT_FEE_TYPEHASH() view returns (bytes32)',
  'function singleSwap(uint256,address,address,uint256,uint256,address,(uint32,address,uint256,uint256,bytes) clientFeeParams,bytes)',
  'function sequentialSwap(uint256,address,address,uint256,uint256,address,(uint32,address,uint256,uint256,bytes) clientFeeParams,bytes)',
  'function splitSwap(uint256,address,address,uint256,uint256,uint256,address,(uint32,address,uint256,uint256,bytes) clientFeeParams,bytes)'
])
const swap = { fromToken: ZeroAddress, toToken: USDC, fromTokenAmount: 10n ** 16n }

let anvil, provider, wdk, account, fynd, sender

async function freePort () {
  const server = createServer().listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address())
  await new Promise(resolve => server.close(resolve))
  return port
}

async function signedSwap () {
  const quote = await fynd.quoteSwidge(swap)
  const result = await fynd.swidge({ ...swap, minAmountOut: quote.toTokenAmountMin * 98n / 100n })
  return { result, submitted: await provider.getTransaction(result.hash) }
}

describe.skipIf(!(apiKey || selfHostedUrl) || !forkUrl)('Fynd and the deployed Ethereum router on a mainnet fork', () => {
  beforeAll(async () => {
    const port = await freePort()
    anvil = spawn(process.env.ANVIL_BIN ?? 'anvil', ['--fork-url', String(forkUrl), '--port', String(port), '--chain-id', '1'], { stdio: 'ignore' })
    provider = new JsonRpcProvider(`http://127.0.0.1:${port}`, 1, { staticNetwork: true, cacheTimeout: -1 })
    for (let attempt = 0; ; attempt++) {
      try { await provider.getBlockNumber(); break } catch (error) { if (attempt > 200) throw error }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    wdk = new WDK(mnemonic)
      .registerWallet('ethereum', WalletManagerEvm, { provider, chainId: 1 })
      .registerProtocol('ethereum', 'fynd', FyndSwidgeProtocol, { chainId: 1, ...(selfHostedUrl ? { selfHostedUrl } : { apiKey }) })
    account = await wdk.getAccount('ethereum', 0)
    sender = (await account.getAddress()).toLowerCase()
    await provider.send('anvil_setBalance', [sender, toBeHex(10n ** 18n)])
    fynd = account.getSwidgeProtocol('fynd')
  }, 30000)

  afterAll(async () => {
    wdk?.dispose()
    provider?.destroy()
    if (anvil && anvil.exitCode === null) {
      const exited = once(anvil, 'exit')
      anvil.kill('SIGTERM')
      await exited
    }
  })

  it('signs with the domain and type the deployed router declares', async () => {
    const router = new Contract(CHAINS.ethereum.router, routerAbi, provider)
    const [, name, version, chainId, verifyingContract] = await router.eip712Domain()
    const { submitted } = await signedSwap()
    const typed = clientFeeTypedData(submitted, CHAINS.ethereum)
    expect({ name, version, chainId, verifyingContract: verifyingContract.toLowerCase() })
      .toEqual({ ...typed.domain, chainId: 1n })
    expect(await router.CLIENT_FEE_TYPEHASH()).toBe(id(TypedDataEncoder.from(typed.types).encodeType('ClientFee')))
  }, 60000)

  it('settles a signed ETH to USDC swap through the deployed router', async () => {
    const usdc = new Contract(USDC, ['function balanceOf(address) view returns (uint256)'], provider)
    const before = await usdc.balanceOf(sender)
    const { result, submitted } = await signedSwap()
    const receipt = await account.waitForTransaction(result.hash, { target: 'confirmed', timeout: 30000 })
    expect(receipt.success).toBe(true)
    const fee = routerAbi.parseTransaction(submitted).args.clientFeeParams
    expect([fee[0], fee[1].toLowerCase(), fee[2]]).toEqual([0n, sender, 0n])
    expect(await usdc.balanceOf(sender) - before).toBeGreaterThanOrEqual(result.toTokenAmountMin)
  }, 60000)

  it('lets the deployed router reject the signed swap after its deadline or with a changed signature', async () => {
    await provider.send('anvil_setAutomine', [false])
    try {
      const { result, submitted } = await signedSwap()
      const fee = routerAbi.parseTransaction(submitted).args.clientFeeParams
      const tampered = submitted.data.replace(fee[4].slice(2, 12), 'ffffffffff')
      await expect(provider.call({ from: sender, to: submitted.to, value: submitted.value, data: tampered })).rejects.toThrow()
      await provider.send('evm_setNextBlockTimestamp', [Number(fee[3]) + 1])
      await provider.send('anvil_mine', [1])
      expect((await account.getTransaction(result.hash)).success).toBe(false)
    } finally {
      await provider.send('anvil_setAutomine', [true])
    }
  }, 60000)
})
