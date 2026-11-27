// Copyright 2026 PropellerHeads AG

// Opt-in: for each chain whose <CHAIN>_RPC_URL is set (ETHEREUM_RPC_URL, BASE_RPC_URL, ...), runs the
// adapter against Fynd and Tycho's deployed router on an Anvil fork of that chain. Set FYND_API_KEY for
// the hosted API, or FYND_SELF_HOSTED_URL for your own Fynd server with only that server's chain RPC set.
// Ethereum forks a pinned block (ETHEREUM_FORK_BLOCK_NUMBER, default below; `latest` forks the head),
// so its RPC must be an archive RPC. Other chains fork 10 blocks behind their head, because public RPCs
// keep only recent state and load-balanced ones can lag a block; set <CHAIN>_FORK_BLOCK_NUMBER with an
// archive RPC to pin one. Fynd still quotes live state, so quotes are not reproducible and swaps allow
// 5% slippage for price drift. No real funds move.
// Record the block and Fynd version of each verified run in docs/compatibility.md.
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
// Native input and a stablecoin output per chain; amounts are native base units worth a few dollars.
// `hardfork` overrides Anvil's spec where it lags the live chain: Anvil forks Base as Jovian, which
// lacks CLZ (EIP-7939), so Ekubo v3 routes revert on the fork while executing on Base. `arbSys` marks
// Arbitrum Orbit chains whose ArbSys precompile Anvil does not implement (see ARB_SYS_STUB).
const SWAPS = {
  // Mainnet block of November 27, 2026 (05:58 UTC); update together with docs/compatibility.md.
  ethereum: { toToken: '0xdac17f958d2ee523a2206206994597c13d831ec7', symbol: 'USDT', amount: 10n ** 16n, pinnedBlock: '26504600' },
  base: { toToken: '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2', symbol: 'USDT', amount: 10n ** 16n, hardfork: 'osaka' },
  arbitrum: { toToken: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', symbol: 'USD₮0', amount: 10n ** 16n },
  bsc: { toToken: '0x55d398326f99059ff775485246999027b3197955', symbol: 'USDT', amount: 10n ** 16n },
  polygon: { toToken: '0xc2132d05d31c914a87c6611c10748aeb04b58e8f', symbol: 'USDT0', amount: 10n ** 20n },
  unichain: { toToken: '0x9151434b16b9763660705744891fa906f660ecc5', symbol: 'USD₮0', amount: 10n ** 16n },
  robinhood: { toToken: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', symbol: 'USDG', amount: 10n ** 16n, arbSys: true },
  arc: { toToken: '0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1', symbol: 'EURC', amount: 10n ** 19n },
  elysium: { toToken: '0xb47c4c8f73f009cc0c0d3f92b388d13e293f0b65', symbol: 'USDC', amount: 10n ** 17n, arbSys: true }
}
// On Arbitrum chains the fork copies ArbSys (0x64) as a bare INVALID opcode, so pools that read
// arbBlockNumber() revert. This stub answers that one call with the fork's block number and reverts otherwise.
// That number is the L2 block on Orbit forks. Anvil forks Arbitrum One with the L1 block number, where the
// stub would answer wrongly, so Arbitrum One gets none; none of its routes has needed ArbSys.
const ARB_SYS = '0x0000000000000000000000000000000000000064'
const ARB_SYS_STUB = '0x5f3560e01c63a3b1b31d146011575f5ffd5b435f5260205ff3'
const routerAbi = new Interface([
  'function eip712Domain() view returns (bytes1, string name, string version, uint256 chainId, address verifyingContract, bytes32, uint256[])',
  'function CLIENT_FEE_TYPEHASH() view returns (bytes32)',
  'function singleSwap(uint256,address,address,uint256,uint256,address,(uint32,address,uint256,uint256,bytes) clientFeeParams,bytes)',
  'function sequentialSwap(uint256,address,address,uint256,uint256,address,(uint32,address,uint256,uint256,bytes) clientFeeParams,bytes)',
  'function splitSwap(uint256,address,address,uint256,uint256,uint256,address,(uint32,address,uint256,uint256,bytes) clientFeeParams,bytes)'
])

// The innermost reverting call of a callTracer trace, so a failed settlement says where it broke.
function revertPoint (frame) {
  const failed = frame.calls?.findLast(call => call.error)
  return failed ? revertPoint(failed) : `${frame.to} ${frame.input.slice(0, 10)} ${frame.error}${frame.revertReason ? `: ${frame.revertReason}` : ''}`
}

async function freePort () {
  const server = createServer().listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address())
  await new Promise(resolve => server.close(resolve))
  return port
}

for (const [slug, { toToken, symbol, amount, pinnedBlock, hardfork, arbSys }] of Object.entries(SWAPS)) {
  const chain = CHAINS[/** @type {keyof typeof CHAINS} */ (slug)]
  const prefix = slug.toUpperCase()
  const forkUrl = process.env[`${prefix}_RPC_URL`]
  const forkBlock = process.env[`${prefix}_FORK_BLOCK_NUMBER`] || pinnedBlock || '-10'
  const swap = { fromToken: ZeroAddress, toToken, fromTokenAmount: amount, slippage: 0.05 }
  let anvil, provider, wdk, account, fynd, sender

  async function signedSwap () {
    const quote = await fynd.quoteSwidge(swap)
    const result = await fynd.swidge({ ...swap, minAmountOut: quote.toTokenAmountMin * 98n / 100n })
    return { result, submitted: await provider.getTransaction(result.hash) }
  }

  describe.skipIf(!(apiKey || selfHostedUrl) || !forkUrl)(`Fynd and the deployed ${chain.name} router on a fork`, () => {
    beforeAll(async () => {
      const port = await freePort()
      const options = [...(forkBlock === 'latest' ? [] : [`--fork-block-number=${forkBlock}`]), ...(hardfork ? ['--hardfork', hardfork] : [])]
      anvil = spawn(process.env.ANVIL_BIN ?? 'anvil', ['--fork-url', String(forkUrl), ...options, '--port', String(port), '--chain-id', String(chain.id)], { stdio: 'ignore' })
      provider = new JsonRpcProvider(`http://127.0.0.1:${port}`, chain.id, { staticNetwork: true, cacheTimeout: -1 })
      for (let attempt = 0; ; attempt++) {
        try { await provider.getBlockNumber(); break } catch (error) { if (attempt > 400) throw error }
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      if (arbSys) await provider.send('anvil_setCode', [ARB_SYS, ARB_SYS_STUB])
      // A fresh wallet funded on the fork only. Anvil's public dev accounts carry EIP-7702
      // delegations on mainnet, which the adapter refuses.
      const mnemonic = /** @type {import('ethers').Mnemonic} */ (Wallet.createRandom().mnemonic).phrase
      wdk = new WDK(mnemonic)
        .registerWallet(slug, WalletManagerEvm, { provider, chainId: chain.id })
        .registerProtocol(slug, 'fynd', FyndSwidgeProtocol, { chainId: chain.id, ...(selfHostedUrl ? { selfHostedUrl } : { apiKey }) })
      account = await wdk.getAccount(slug, 0)
      sender = (await account.getAddress()).toLowerCase()
      await provider.send('anvil_setBalance', [sender, toBeHex(amount * 1000n)])
      fynd = account.getSwidgeProtocol('fynd')
    }, 60000)

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
      const router = new Contract(chain.router, routerAbi, provider)
      const [, name, version, chainId, verifyingContract] = await router.eip712Domain()
      const { submitted } = await signedSwap()
      const typed = clientFeeTypedData(submitted, chain)
      expect({ name, version, chainId, verifyingContract: verifyingContract.toLowerCase() })
        .toEqual({ ...typed.domain, chainId: BigInt(chain.id) })
      expect(await router.CLIENT_FEE_TYPEHASH()).toBe(id(TypedDataEncoder.from(typed.types).encodeType('ClientFee')))
    }, 120000)

    it(`settles a signed ${chain.nativeSymbol} to ${symbol} swap through the deployed router`, async () => {
      const output = new Contract(toToken, ['function balanceOf(address) view returns (uint256)'], provider)
      const before = await output.balanceOf(sender)
      const { result, submitted } = await signedSwap()
      const receipt = await account.waitForTransaction(result.hash, { target: 'confirmed', timeout: 60000 })
      const trace = receipt.success ? undefined : await provider.send('debug_traceTransaction', [result.hash, { tracer: 'callTracer' }])
      expect(receipt.success, trace && `reverted at ${revertPoint(trace)}`).toBe(true)
      const fee = routerAbi.parseTransaction(submitted).args.clientFeeParams
      expect([fee[0], fee[1].toLowerCase(), fee[2]]).toEqual([0n, sender, 0n])
      expect(await output.balanceOf(sender) - before).toBeGreaterThanOrEqual(result.toTokenAmountMin)
    }, 120000)

    it('lets the deployed router reject the signed swap after its deadline or with a changed signature', async () => {
      await provider.send('anvil_setAutomine', [false])
      try {
        const { result, submitted } = await signedSwap()
        const fee = routerAbi.parseTransaction(submitted).args.clientFeeParams
        const call = data => provider.call({ from: sender, to: submitted.to, value: submitted.value, data })
        // The unchanged swap must succeed now, so the rejections below come from the signature and deadline.
        await expect(call(submitted.data)).resolves.toMatch(/^0x/)
        const tampered = submitted.data.replace(fee[4].slice(2, 12), 'ffffffffff')
        await expect(call(tampered)).rejects.toThrow()
        await provider.send('evm_setNextBlockTimestamp', [Number(fee[3]) + 1])
        await provider.send('anvil_mine', [1])
        expect((await account.getTransaction(result.hash)).success).toBe(false)
      } finally {
        await provider.send('anvil_setAutomine', [true])
      }
    }, 120000)
  })
}
