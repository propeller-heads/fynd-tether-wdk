// Copyright 2026 PropellerHeads AG
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { Interface, isHexString } from 'ethers'
import { NoSuchElementError, NotImplementedError, ProviderError, ValueError } from '@tetherto/wdk-wallet'
import { AccountRequiredError, ReadOnlyAccountRequiredError, SwidgeProtocol, SwidgeError } from '@tetherto/wdk-wallet/protocols'
import { FyndApi } from './fynd-api.js'
import { CHAINS, clientFeeTypedData, insertSignature, validateTransaction } from './router.js'
import { NATIVE, address, amount, cap, enforceCap, minimumForSlippage, slippage, token } from './amounts.js'
import { FyndExecutionError } from './errors.js'

/** @typedef {import('@tetherto/wdk-wallet').IWalletAccountReadOnly} WalletAccount */
/**
 * @typedef {WalletAccount &
 *   Pick<import('@tetherto/wdk-wallet-evm').WalletAccountReadOnlyEvm, 'getAllowance' | 'quoteSendTransaction'> &
 *   Partial<Pick<import('@tetherto/wdk-wallet-evm').WalletAccountEvm, 'getDelegation' | 'approve' | 'sendTransaction' | 'signTypedData'>>
 * } EvmAccount
 */
/**
 * @typedef {EvmAccount & Required<Pick<import('@tetherto/wdk-wallet-evm').WalletAccountEvm,
 *   'approve' | 'sendTransaction'>>} WritableAccount
 */
/** @typedef {import('@tetherto/wdk-wallet/protocols').SwidgeOptions} SwidgeOptions */
/** @typedef {import('@tetherto/wdk-wallet/protocols').SwidgeProtocolConfig} FeeCaps */
/** @typedef {import('@tetherto/wdk-wallet/protocols').SwidgeTransaction} SwidgeTransaction */
/** @typedef {import('@tetherto/wdk-wallet/protocols').SwidgeFee} SwidgeFee */
/**
 * @typedef {{tokenIn:string, tokenOut:string, amountIn:bigint, sender:string,
 *   recipient:string, minAmountOut:bigint, slippage:string}} SwapRequest
 * @typedef {{amount:bigint, complete:boolean}} NetworkEstimate
 * @typedef {{quote:import('./fynd-api.js').EncodedQuote, request:SwapRequest,
 *   transaction:{to:string,data:string,value:bigint}, approvals:bigint[],
 *   network:NetworkEstimate}} Prepared
 */
/**
 * @typedef {FeeCaps & {
 *   chainId: import('./router.js').Chain['id'],
 *   apiKey?: string,
 *   baseUrl?: string,
 *   selfHostedUrl?: string,
 *   quoteSender?: string,
 *   timeoutMs?: number,
 *   approvalTimeoutMs?: number,
 *   deadlineSeconds?: number
 * }} FyndConfig
 */

const ERC20 = new Interface(['function approve(address spender,uint256 amount) returns (bool)'])
const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7'
// Chains without an L1 data fee, where WDK's gas estimate covers the whole network cost.
const COMPLETE_FEE_ESTIMATE_CHAINS = new Set([1, 56, 137])
// WDK takes each nonce from the pending transaction count, so overlapping executions from one
// sender could sign the same nonce. One execution per chain and sender runs at a time.
const EXECUTING_SENDERS = new Set()

/** @param {WalletAccount} account @returns {account is EvmAccount} */
function hasEvmAllowance (account) {
  return typeof account === 'object' && account !== null && 'getAllowance' in account && typeof account.getAllowance === 'function'
}

/** Fynd exact-input swaps through the hosted API or a self-hosted Fynd. Configure the WDK wallet with the same chainId. */
export default class FyndSwidgeProtocol extends SwidgeProtocol {
  /** @type {EvmAccount | undefined} */
  #account
  #chainName
  #chain
  #settings
  #approvalTimeoutMs
  #deadlineSeconds
  #api
  /** @type {Promise<void> | undefined} */
  #routerCheck
  /**
   * WDK registration needs optional constructor parameters. chainId remains required
   * at runtime; FyndConfig provides the strict configuration type.
   * @param {WalletAccount} [account] @param {Partial<FyndConfig>} [config]
   */
  constructor (account, config = {}) {
    const caps = { maxNetworkFeeBps: config?.maxNetworkFeeBps, maxProtocolFeeBps: config?.maxProtocolFeeBps }
    if (account) super(account, caps)
    else super(undefined, caps)
    const supported = Object.entries(CHAINS).find(([, chain]) => chain.id === config?.chainId)
    if (!supported) throw new ValueError('chainId must be a supported Fynd chain ID.')
    if (account && !hasEvmAllowance(account)) throw new ValueError('A WDK EVM account with public allowance support is required.')
    this.#account = account
    this.#chainName = supported[0]
    this.#chain = supported[1]
    this.#settings = Object.freeze({ ...caps, quoteSender: config.quoteSender })
    this.#approvalTimeoutMs = config.approvalTimeoutMs ?? 180000
    if (!Number.isSafeInteger(this.#approvalTimeoutMs) || this.#approvalTimeoutMs <= 0) {
      throw new ValueError('approvalTimeoutMs must be a positive safe integer.')
    }
    this.#deadlineSeconds = config.deadlineSeconds ?? 120
    if (!Number.isSafeInteger(this.#deadlineSeconds) || this.#deadlineSeconds <= 0) {
      throw new ValueError('deadlineSeconds must be a positive safe integer.')
    }
    cap(config.maxNetworkFeeBps, 'maxNetworkFeeBps')
    cap(config.maxProtocolFeeBps, 'maxProtocolFeeBps')
    if (config.quoteSender !== undefined) address(config.quoteSender, 'quoteSender')
    this.#api = new FyndApi({
      baseUrl: config.baseUrl, selfHostedUrl: config.selfHostedUrl, apiKey: config.apiKey,
      timeoutMs: config.timeoutMs, chain: this.#chainName
    })
  }

  /**
   * Non-binding quote. networkFeeComplete reports whether estimates cover every
   * network cost. All fees remain estimates.
   * @param {SwidgeOptions} options
   * @returns {Promise<import('@tetherto/wdk-wallet/protocols').SwidgeQuote & {networkFeeComplete: boolean}>}
   */
  async quoteSwidge (options) {
    const prepared = await this.#prepare({ ...options }, false)
    return this.#resultQuote(prepared)
  }

  /** @param {SwidgeOptions} options @param {FeeCaps} [config]
   * @returns {Promise<import('@tetherto/wdk-wallet/protocols').SwidgeResult & {networkFeeComplete: boolean}>}
   */
  async swidge (options, config = {}) {
    options = { ...options }
    config = { ...config }
    const account = this.#account
    if (!account || typeof account.approve !== 'function' || typeof account.sendTransaction !== 'function' ||
        typeof account.signTypedData !== 'function') {
      throw new AccountRequiredError('A writable ordinary WDK EVM account is required.')
    }
    if (typeof account.getDelegation !== 'function' || (await account.getDelegation()).isDelegated) {
      throw new ValueError('Execution requires an ordinary, non-delegated WDK EVM account.')
    }
    const {
      maxNetworkFeeBps = this.#settings.maxNetworkFeeBps,
      maxProtocolFeeBps = this.#settings.maxProtocolFeeBps
    } = config
    const limits = {
      maxNetworkFeeBps: cap(maxNetworkFeeBps, 'maxNetworkFeeBps'),
      maxProtocolFeeBps: cap(maxProtocolFeeBps, 'maxProtocolFeeBps')
    }
    const sender = `${this.#chain.id}:${address(await account.getAddress(), 'account address')}`
    if (EXECUTING_SENDERS.has(sender)) {
      throw new SwidgeError('Another Fynd swap from this account is still executing; wait for it to return.',
        { reason: 'EXECUTION_IN_PROGRESS' })
    }
    EXECUTING_SENDERS.add(sender)
    try {
      return await this.#execute(/** @type {WritableAccount} */ (account), options, limits)
    } finally {
      EXECUTING_SENDERS.delete(sender)
    }
  }

  /**
   * @param {WritableAccount} account @param {SwidgeOptions} options
   * @param {{maxNetworkFeeBps?: bigint, maxProtocolFeeBps?: bigint}} limits
   */
  async #execute (account, options, limits) {
    let prepared = await this.#prepare(options, true)
    await this.#enforceLimits(prepared, limits)
    /** @type {SwidgeTransaction[]} */
    const transactions = []
    let stage = 'approval'
    let submissionUnknown = false
    let spent = 0n
    try {
      for (const approvalAmount of prepared.approvals) {
        stage = approvalAmount === 0n ? 'allowance reset' : 'approval'
        submissionUnknown = true
        const submitted = await account.approve({ token: prepared.request.tokenIn, spender: this.#chain.router, amount: approvalAmount })
        // Record the hash before fee parsing or receipt lookup can fail.
        if (!isHexString(submitted.hash, 32)) throw new ValueError('WDK returned an invalid approval hash.')
        transactions.push({ hash: submitted.hash, chain: this.#chain.id, type: 'approval' })
        submissionUnknown = false
        stage = 'approval confirmation'
        const receipt = await account.waitForTransaction(submitted.hash, { target: 'confirmed', timeout: this.#approvalTimeoutMs })
        if (!['confirmed', 'final'].includes(receipt.finality) || receipt.success !== true) {
          throw new SwidgeError('Approval did not confirm successfully.', { reason: 'APPROVAL_FAILED' })
        }
        spent += amount(receipt.fee, 'approval receipt fee', true)
      }
      if (transactions.length) {
        stage = 'quote refresh'
        prepared = await this.#prepare(options, true)
        if (prepared.approvals.length) {
          throw new SwidgeError('Allowance remains insufficient after approval.', { reason: 'ALLOWANCE_INSUFFICIENT' })
        }
        await this.#enforceLimits(prepared, limits)
      }
      stage = 'swap submission'
      submissionUnknown = true
      const submitted = await account.sendTransaction(prepared.transaction)
      if (!isHexString(submitted.hash, 32)) throw new ValueError('WDK returned an invalid swap hash.')
      transactions.push({ hash: submitted.hash, chain: this.#chain.id, type: 'source' })
      submissionUnknown = false
      // Add confirmed approval fees once, after refreshing the swap estimate.
      prepared.network.amount += spent
      const result = this.#resultQuote(prepared)
      return { ...result, id: submitted.hash, hash: submitted.hash, transactions }
    } catch (cause) {
      throw new FyndExecutionError(stage, transactions, submissionUnknown, cause)
    }
  }

  /** @param {string} id @param {import('@tetherto/wdk-wallet/protocols').SwidgeStatusOptions} [options]
   * @returns {Promise<import('@tetherto/wdk-wallet/protocols').SwidgeStatusResult>}
   */
  async getSwidgeStatus (id, options = {}) {
    if (!isHexString(id, 32)) throw new ValueError('id must be a transaction hash.')
    this.#checkChain(options.fromChain)
    this.#checkChain(options.toChain)
    if (!this.#account) throw new ReadOnlyAccountRequiredError('Status lookup requires a WDK EVM account.')
    const receipt = await this.#account.getTransaction(id)
    if (!receipt) throw new NoSuchElementError('The transaction was not found.')
    /** @type {import('@tetherto/wdk-wallet/protocols').SwidgeStatus} */
    let status
    const settled = ['confirmed', 'final'].includes(receipt.finality) && typeof receipt.success === 'boolean'
    if (receipt.finality === 'pending' || receipt.finality === 'dropped') status = 'pending'
    else if (settled) status = receipt.success ? 'completed' : 'failed'
    else throw new ProviderError('WDK returned an unrecognized transaction status.', { reason: 'INVALID_RESPONSE' })
    return { status, transactions: [{ hash: id, chain: this.#chain.id, type: /** @type {const} */ ('source') }] }
  }

  /** @returns {Promise<import('@tetherto/wdk-wallet/protocols').SwidgeSupportedChain[]>} */
  async getSupportedChains () {
    return Object.values(CHAINS).map(chain => ({ id: chain.id, name: chain.name, type: 'evm', nativeToken: chain.nativeSymbol }))
  }

  /** @param {import('@tetherto/wdk-wallet/protocols').SwidgeSupportedTokensOptions} [options]
   * @returns {Promise<import('@tetherto/wdk-wallet/protocols').SwidgeSupportedToken[]>}
   */
  async getSupportedTokens (options = {}) {
    this.#checkChain(options.fromChain)
    this.#checkChain(options.toChain)
    if (options.fromToken !== undefined) {
      throw new NotImplementedError('Fynd pair-scoped token discovery')
    }
    await this.#checkRouter()
    const tokens = await this.#api.tokens()
    return [
      { token: NATIVE, address: NATIVE, chain: this.#chain.id, symbol: this.#chain.nativeSymbol, decimals: 18 },
      ...tokens
        .filter(item => token(item.address) !== NATIVE)
        .map(item => ({ token: item.address, ...item, chain: this.#chain.id }))
    ]
  }

  /** @param {string | number | undefined} chain */
  #checkChain (chain) {
    if (chain !== undefined && chain !== this.#chain.id && chain !== this.#chainName && chain !== String(this.#chain.id)) {
      throw new ValueError('Only swaps and discovery on the configured chain are supported.')
    }
  }

  /** @param {SwidgeOptions} options @param {boolean} execute @returns {Promise<SwapRequest>} */
  async #request (options, execute) {
    if (!options || options.toTokenAmount !== undefined) throw new ValueError('Fynd supports exact-input swaps only.')
    if (execute && options.minAmountOut === undefined) {
      throw new ValueError('Set minAmountOut, in output-token base units, to execute a swap.')
    }
    this.#checkChain(options.toChain)
    if (options.refundAddress !== undefined) throw new ValueError('refundAddress is not supported for atomic same-chain swaps.')
    const tokenIn = token(options.fromToken)
    const tokenOut = token(options.toToken)
    if (tokenIn === tokenOut) throw new ValueError('The input and output tokens must differ.')
    const amountIn = amount(options.fromTokenAmount, 'fromTokenAmount')
    const sender = address(this.#account ? await this.#account.getAddress() : this.#settings.quoteSender, 'account address or quoteSender')
    const recipient = address(options.recipient ?? sender, 'recipient')
    if (sender === NATIVE || recipient === NATIVE) throw new ValueError('Sender and recipient must be nonzero addresses.')
    return {
      tokenIn, tokenOut, amountIn, sender, recipient,
      minAmountOut: options.minAmountOut === undefined ? 0n : amount(options.minAmountOut, 'minAmountOut', !execute),
      slippage: slippage(options.slippage)
    }
  }

  /**
   * Quote and validate a swap. For execution, Fynd encodes zero-fee client parameters naming
   * the sender, and the sender signs them so the router enforces the swap deadline.
   * @param {SwidgeOptions} options @param {boolean} execute @returns {Promise<Prepared>}
   */
  async #prepare (options, execute) {
    const request = await this.#request(options, execute)
    await this.#checkRouter()
    const clientFee = execute
      ? { receiver: request.sender, deadline: BigInt(Math.floor(Date.now() / 1000) + this.#deadlineSeconds) }
      : undefined
    const order = { ...request, receiver: request.recipient }
    const quote = await this.#api.quote(order, { slippage: request.slippage, clientFee })
    const netOutput = quote.grossOutput - quote.routerFee - quote.clientFee
    if (quote.minimum < minimumForSlippage(netOutput, request.slippage)) {
      throw new SwidgeError('The executable minimum exceeds the requested slippage.', { reason: 'SLIPPAGE_TOO_HIGH' })
    }
    let transaction = validateTransaction(quote, request, this.#chain, clientFee)
    if (quote.minimum < request.minAmountOut) {
      throw new SwidgeError('The executable minimum is below minAmountOut.', { reason: 'COULD_NOT_MET_THRESHOLD' })
    }
    if (clientFee) {
      if (!this.#account?.signTypedData) throw new AccountRequiredError('A writable ordinary WDK EVM account is required.')
      const signature = await this.#account.signTypedData(clientFeeTypedData(transaction, this.#chain))
      transaction = insertSignature(transaction, quote.signatureOffset, signature)
    }
    const approvals = await this.#approvalAmounts(request.tokenIn, request.amountIn)
    const network = await this.#networkEstimate(quote, transaction, request.tokenIn, approvals)
    return { quote, request, transaction, approvals, network }
  }

  /** Fetch Fynd's chain and router once per instance; retry after a failure. */
  async #checkRouter () {
    const check = this.#routerCheck ?? this.#api.info().then(info => {
      if (info.chainId !== this.#chain.id || info.routerAddress?.toLowerCase() !== this.#chain.router.toLowerCase()) {
        throw new SwidgeError('Fynd metadata does not match the supported chain and router.', { reason: 'UNSUPPORTED_ROUTER' })
      }
    })
    this.#routerCheck = check
    try {
      await check
    } catch (error) {
      this.#routerCheck = undefined
      throw error
    }
  }

  /** @param {Prepared} prepared @param {{maxNetworkFeeBps?: bigint, maxProtocolFeeBps?: bigint}} limits */
  async #enforceLimits ({ quote, request, approvals, network }, { maxNetworkFeeBps: networkCap, maxProtocolFeeBps: protocolCap }) {
    enforceCap(quote.routerFee, quote.grossOutput, protocolCap, 'protocol')
    if (networkCap !== undefined) {
      if (approvals.length) {
        throw new SwidgeError('A network fee cap requires sufficient allowance before execution; ' +
          'future approvals cannot be simulated.', { reason: 'FEE_ESTIMATE_UNAVAILABLE' })
      }
      if (!network.complete) {
        throw new SwidgeError('The full network cost cannot be estimated before spending; ' +
          'the requested cap cannot be checked.', { reason: 'FEE_ESTIMATE_UNAVAILABLE' })
      }
      const value = request.tokenIn === NATIVE ? request.amountIn : (await this.#api.quote(
        { ...request, receiver: request.recipient, tokenOut: NATIVE },
        { encode: false }
      )).grossOutput
      enforceCap(network.amount, value, networkCap, 'network')
    }
  }

  /** @param {string} tokenIn @param {bigint} amountIn */
  async #approvalAmounts (tokenIn, amountIn) {
    if (tokenIn === NATIVE || !this.#account) return []
    const allowance = amount(await this.#account.getAllowance(tokenIn, this.#chain.router), 'allowance', true)
    if (allowance >= amountIn) return []
    return this.#chain.id === 1 && tokenIn === USDT && allowance > 0n ? [0n, amountIn] : [amountIn]
  }

  /**
   * Estimates are complete only on chains without an L1 data fee, without future approvals.
   * @param {import('./fynd-api.js').EncodedQuote} quote
   * @param {{to:string,data:string,value:bigint}} transaction
   * @param {string} tokenIn
   * @param {bigint[]} approvals
   */
  async #networkEstimate (quote, transaction, tokenIn, approvals) {
    // Fynd's gas × gas price is an indicative fallback when WDK cannot estimate the swap.
    const fallback = quote.gasPrice !== undefined && quote.gasPrice > 0n ? quote.gas * quote.gasPrice : 0n
    const account = this.#account
    if (!account) return { amount: fallback, complete: false }
    let total = 0n
    let complete = COMPLETE_FEE_ESTIMATE_CHAINS.has(this.#chain.id) && approvals.length === 0
    for (const approval of approvals) {
      const data = ERC20.encodeFunctionData('approve', [this.#chain.router, approval])
      try {
        total += amount((await account.quoteSendTransaction({ to: tokenIn, value: 0n, data })).fee, 'approval estimate')
      } catch {
        complete = false
      }
    }
    try {
      total += amount((await account.quoteSendTransaction(transaction)).fee, 'swap estimate')
    } catch {
      complete = false
      total += fallback
    }
    return { amount: total, complete }
  }

  /** @param {Prepared} prepared */
  #resultQuote ({ quote, request, network }) {
    /** @type {SwidgeFee[]} */
    const fees = [{
      type: 'protocol', amount: quote.routerFee, token: request.tokenOut, chain: this.#chain.id, included: true,
      description: 'Quoted Tycho router fee; positive-slippage fees can add to the settled fee.'
    }]
    if (network.amount > 0n) {
      fees.unshift({
        type: 'network', amount: network.amount, token: NATIVE, chain: this.#chain.id, included: false,
        description: network.complete
          ? 'Estimated network cost for all transactions; not a settlement guarantee.'
          : 'Partial network estimate; may omit transaction costs and chain-specific fees.'
      })
    }
    return {
      fromTokenAmount: quote.amountIn,
      toTokenAmount: quote.grossOutput - quote.routerFee - quote.clientFee,
      toTokenAmountMin: quote.minimum,
      fees,
      ...(quote.priceImpact === undefined ? {} : { priceImpact: quote.priceImpact }),
      networkFeeComplete: network.complete
    }
  }
}
