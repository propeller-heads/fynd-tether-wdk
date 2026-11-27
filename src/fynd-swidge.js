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

import { Interface, isError, isHexString } from 'ethers'
import { InvalidTokenError, NoSuchElementError, ProviderError, ProviderErrorReason, ProviderRequiredError, ValueError } from '@tetherto/wdk-wallet'
import { AccountRequiredError, SwidgeProtocol, SwidgeError, SwidgeErrorReason } from '@tetherto/wdk-wallet/protocols'
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
/** @typedef {import('@tetherto/wdk-wallet/protocols').SwidgeProtocolConfig} SwidgeProtocolConfig */
/** @typedef {import('@tetherto/wdk-wallet/protocols').SwidgeQuote} SwidgeQuote */
/** @typedef {import('@tetherto/wdk-wallet/protocols').SwidgeResult} SwidgeResult */
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
 * A Swidge quote that also reports whether the network fee estimate covers every network cost.
 * @typedef {SwidgeQuote & {networkFeeComplete: boolean}} FyndSwidgeQuote
 */
/**
 * A Swidge result that also reports whether the network fee estimate covers every network cost.
 * @typedef {SwidgeResult & {networkFeeComplete: boolean}} FyndSwidgeResult
 */
/**
 * Fynd Swidge configuration, passed to `registerProtocol` or the constructor.
 * Use the hosted API (`apiKey`, optionally `baseUrl`) or a self-hosted Fynd (`selfHostedUrl`), not both.
 * @typedef {object} FyndConfig
 * @property {import('./router.js').Chain['id']} chainId - Supported chain ID; configure the WDK wallet with the same chain.
 * @property {string} [apiKey] - Hosted API key, sent as the raw `Authorization` header. Not allowed with `selfHostedUrl`.
 * @property {string} [baseUrl] - Hosted API URL, or your proxy in front of it. Default `https://fynd-api.propellerheads.xyz`. Not allowed with `selfHostedUrl`.
 * @property {string} [selfHostedUrl] - URL of your own single-chain Fynd server. Excludes `baseUrl` and `apiKey`.
 * @property {string} [quoteSender] - Sender address for quotes without an account; the account address takes precedence.
 * @property {number} [timeoutMs] - Timeout per Fynd request in milliseconds, including the body and the whole token list. Default 10000.
 * @property {number} [approvalTimeoutMs] - Confirmation timeout per approval in milliseconds. Default 180000.
 * @property {number} [deadlineSeconds] - Seconds a signed swap stays valid before the router rejects it. Default 120.
 * @property {number | bigint} [maxNetworkFeeBps] - Default network fee cap for `swidge`, in basis points of the input value. No cap by default.
 * @property {number | bigint} [maxProtocolFeeBps] - Default router fee cap for `swidge`, in basis points of the gross output. No cap by default.
 */

const ERC20 = new Interface(['function approve(address spender,uint256 amount) returns (bool)'])
const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7'
// Chains without an L1 data fee, where WDK's gas estimate covers the whole network cost.
const COMPLETE_FEE_ESTIMATE_CHAINS = new Set([1, 56, 137])
// WDK takes each nonce from the pending transaction count, so overlapping executions from one
// sender could sign the same nonce. One execution per chain and sender runs at a time.
const EXECUTING_SENDERS = new Set()
// WDK errors that approve and sendTransaction throw before anything is broadcast. Matched by
// name because WDK EVM pins its own copy of @tetherto/wdk-wallet.
const BEFORE_BROADCAST = new Set(['ProviderRequiredError', 'ValueError', 'MaximumFeeExceededError'])
// ethers error codes, and the Node and Bare socket codes ethers passes through unwrapped.
/** @type {Record<string, string>} */
const RPC_FAILURES = {
  NETWORK_ERROR: ProviderErrorReason.NETWORK_ERROR,
  SERVER_ERROR: ProviderErrorReason.INTERNAL_SERVER_ERROR,
  TIMEOUT: ProviderErrorReason.REQUEST_TIMEOUT,
  ECONNREFUSED: ProviderErrorReason.NETWORK_ERROR,
  ECONNRESET: ProviderErrorReason.NETWORK_ERROR,
  ENOTFOUND: ProviderErrorReason.NETWORK_ERROR,
  EAI_AGAIN: ProviderErrorReason.NETWORK_ERROR,
  EHOSTUNREACH: ProviderErrorReason.NETWORK_ERROR,
  ENETUNREACH: ProviderErrorReason.NETWORK_ERROR,
  EPIPE: ProviderErrorReason.NETWORK_ERROR,
  ETIMEDOUT: ProviderErrorReason.REQUEST_TIMEOUT
}

/** @param {WalletAccount} account @returns {account is EvmAccount} */
function hasEvmAllowance (account) {
  return typeof account === 'object' && account !== null && 'getAllowance' in account && typeof account.getAllowance === 'function'
}

/** @param {unknown} error */
function simulationFailed (error) {
  return isError(error, 'CALL_EXCEPTION') || isError(error, 'INSUFFICIENT_FUNDS')
}

/**
 * WDK's fee estimate, or undefined when the simulation fails (a revert, or a balance the
 * transaction would exceed) or the fee is not positive. Other failures propagate.
 * @param {() => Promise<{fee: unknown}>} quote @returns {Promise<bigint | undefined>}
 */
async function feeEstimate (quote) {
  let fee
  try {
    fee = (await rpc(quote)).fee
  } catch (error) {
    if (simulationFailed(error)) return undefined
    throw error
  }
  return (typeof fee === 'bigint' || Number.isSafeInteger(fee)) && BigInt(/** @type {bigint | number} */ (fee)) > 0n
    ? amount(fee, 'fee estimate')
    : undefined
}

/**
 * Whether ethers reported a JSON-RPC error that is not a revert: `UNKNOWN_ERROR`, or a
 * `CALL_EXCEPTION` without revert data or a revert message (ethers files every `eth_call`
 * error, such as a rate limit, as `CALL_EXCEPTION`).
 * @param {unknown} error
 */
function jsonRpcFailure (error) {
  // ethers attaches the JSON-RPC error as `error` on UNKNOWN_ERROR and as `info.error` on CALL_EXCEPTION.
  if (isError(error, 'UNKNOWN_ERROR')) return /** @type {{error?: unknown}} */ (error).error != null
  const rpcError = /** @type {{info?: {error?: {message?: unknown}}}} */ (error)?.info?.error
  return !!rpcError && isError(error, 'CALL_EXCEPTION') && error.data == null && !/revert/i.test(String(rpcError.message))
}

/**
 * Run an account RPC read, mapping RPC failures to ProviderError and, for token reads,
 * a reverted or undecodable ERC-20 call to InvalidTokenError. Other errors pass through.
 * @template T @param {() => Promise<T>} call @param {boolean} [tokenRead]
 */
async function rpc (call, tokenRead = false) {
  try {
    return await call()
  } catch (error) {
    const code = /** @type {{code?: unknown}} */ (error)?.code
    let reason = typeof code === 'string' && Object.hasOwn(RPC_FAILURES, code) ? RPC_FAILURES[code] : undefined
    if (!reason && (isError(error, 'UNKNOWN_ERROR') || tokenRead) && jsonRpcFailure(error)) {
      reason = ProviderErrorReason.INTERNAL_SERVER_ERROR
    }
    if (reason) throw new ProviderError('The RPC provider request failed.', { reason, cause: error })
    if (tokenRead && (isError(error, 'CALL_EXCEPTION') || isError(error, 'BAD_DATA'))) {
      throw new InvalidTokenError('fromToken is not an ERC-20 token on this chain.', { cause: error })
    }
    throw error
  }
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
   * Creates a Fynd Swidge protocol.
   * @overload
   * @param {WalletAccount | undefined} account - WDK EVM account; full to execute, read-only for quotes and status.
   * @param {FyndConfig} config - The Fynd configuration.
   * @throws {ValueError} If the configuration or account is not supported.
   */
  /**
   * @param {WalletAccount} [account]
   * @param {Partial<FyndConfig>} [config]
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
   * Quotes an exact-input swap on the configured chain. The quote is non-binding, applies no
   * fee caps, and its fees are estimates; `networkFeeComplete` reports whether the network fee
   * covers every network cost.
   *
   * @param {SwidgeOptions} options - The swap options.
   * @returns {Promise<FyndSwidgeQuote>} The quoted amounts and fees.
   * @throws {ValueError} If the options are not valid, or there is no account and no `quoteSender`.
   * @throws {InvalidTokenError} If a token is not an EVM address, or `fromToken` is not an ERC-20 token.
   * @throws {ProviderRequiredError} If the account is not connected to a provider.
   * @throws {ProviderError} If Fynd or the RPC provider fails, or Fynd returns an invalid response or transaction.
   * @throws {SwidgeError} If the executable minimum misses `slippage` (`SLIPPAGE_TOO_HIGH`) or `minAmountOut`
   *   (`COULD_NOT_MET_THRESHOLD`), or Fynd finds no route (`NO_ROUTE_FOUND`, `INSUFFICIENT_LIQUIDITY`).
   */
  async quoteSwidge (options) {
    const prepared = await this.#prepare({ ...options }, false)
    return this.#resultQuote(prepared)
  }

  /**
   * Executes an exact-input swap on the configured chain: approves the input if needed, requotes
   * after approval, signs the swap deadline and broadcasts one swap. Returns once the swap is
   * broadcast; read its outcome with {@link getSwidgeStatus}.
   *
   * @param {SwidgeOptions} options - The swap options; `minAmountOut` is required.
   * @param {SwidgeProtocolConfig} [config] - Fee caps for this call; `undefined` caps inherit the constructor's.
   * @returns {Promise<FyndSwidgeResult>} The swap hash, transactions, and quoted amounts and fees.
   * @throws {AccountRequiredError} If the protocol has no full EVM account.
   * @throws {ValueError} If the options are not valid or the account is delegated.
   * @throws {InvalidTokenError} If a token is not an EVM address, or `fromToken` is not an ERC-20 token.
   * @throws {ProviderRequiredError} If the account is not connected to a provider.
   * @throws {ProviderError} If Fynd or the RPC provider fails, or Fynd returns an invalid response or transaction.
   * @throws {MaximumFeeExceededError} If a quoted fee exceeds its cap, or the transaction exceeds the account's
   *   `transactionMaxFee` before anything is broadcast.
   * @throws {SwidgeError} Before any transaction, if the quote misses `slippage` (`SLIPPAGE_TOO_HIGH`) or
   *   `minAmountOut` (`COULD_NOT_MET_THRESHOLD`), Fynd finds no route (`NO_ROUTE_FOUND`, `INSUFFICIENT_LIQUIDITY`),
   *   a network fee cap cannot be checked (`FEE_ESTIMATE_UNAVAILABLE`), or another swap from the account is
   *   executing (`EXECUTION_IN_PROGRESS`).
   * @throws {FyndExecutionError} If execution stops after it began sending: a transaction was or may have
   *   been broadcast, or the wallet rejected one in simulation (`submissionUnknown` is then false).
   *   `reason` is the cause's Swidge reason, or `undefined`.
   */
  async swidge (options, config = {}) {
    options = { ...options }
    config = { ...config }
    const account = this.#account
    if (!account || typeof account.approve !== 'function' || typeof account.sendTransaction !== 'function' ||
        typeof account.signTypedData !== 'function') {
      throw new AccountRequiredError('A writable ordinary WDK EVM account is required.')
    }
    const getDelegation = account.getDelegation
    if (typeof getDelegation !== 'function' || (await rpc(() => getDelegation.call(account))).isDelegated) {
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
    /** @type {import('./errors.js').FyndExecutionStage} */
    let stage = 'approval'
    let submissionUnknown = false
    /** @param {unknown} error @returns {never} */
    const rejected = error => {
      if (BEFORE_BROADCAST.has(/** @type {Error} */ (error)?.name) || simulationFailed(error)) submissionUnknown = false
      throw error
    }
    let spent = 0n
    try {
      for (const approvalAmount of prepared.approvals) {
        stage = approvalAmount === 0n ? 'allowance reset' : 'approval'
        submissionUnknown = true
        const submitted = await account.approve({ token: prepared.request.tokenIn, spender: this.#chain.router, amount: approvalAmount })
          .catch(rejected)
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
          throw new SwidgeError('Allowance remains insufficient after approval.', { reason: 'APPROVAL_FAILED' })
        }
        await this.#enforceLimits(prepared, limits)
      }
      stage = 'swap submission'
      submissionUnknown = true
      const submitted = await account.sendTransaction(prepared.transaction).catch(rejected)
      if (!isHexString(submitted.hash, 32)) throw new ValueError('WDK returned an invalid swap hash.')
      transactions.push({ hash: submitted.hash, chain: this.#chain.id, type: 'source' })
      submissionUnknown = false
      // Add confirmed approval fees once, after refreshing the swap estimate.
      prepared.network.amount += spent
      const result = this.#resultQuote(prepared)
      return { ...result, id: submitted.hash, hash: submitted.hash, transactions }
    } catch (cause) {
      // Nothing was broadcast, so WDK's own error is the whole story.
      if (!transactions.length && !submissionUnknown && BEFORE_BROADCAST.has(/** @type {Error} */ (cause)?.name)) throw cause
      throw new FyndExecutionError(stage, transactions, submissionUnknown, cause)
    }
  }

  /**
   * Reads the status of a swap from its returned hash through the account's provider. Unmined,
   * dropped and unrecognized receipts are `pending`; `completed` does not mean irreversible finality.
   *
   * @param {string} id - The hash `swidge` returned.
   * @param {import('@tetherto/wdk-wallet/protocols').SwidgeStatusOptions} [options] - Optional chain hints; they must match the configured chain.
   * @returns {Promise<import('@tetherto/wdk-wallet/protocols').SwidgeStatusResult>} The swap status.
   * @throws {ValueError} If the id is not a transaction hash or a chain hint differs from the configured chain.
   * @throws {ProviderRequiredError} If the protocol has no account, or the account is not connected to a provider.
   * @throws {NoSuchElementError} If no transaction exists for the hash.
   * @throws {ProviderError} If the RPC provider fails.
   */
  async getSwidgeStatus (id, options = {}) {
    if (!isHexString(id, 32)) throw new ValueError('id must be a transaction hash.')
    this.#checkChain(options.fromChain)
    this.#checkChain(options.toChain)
    const account = this.#account
    if (!account) throw new ProviderRequiredError('Status lookup requires a WDK EVM account connected to a provider.')
    const receipt = await rpc(() => account.getTransaction(id))
    if (!receipt) throw new NoSuchElementError('The transaction was not found.')
    const settled = ['confirmed', 'final'].includes(receipt.finality) && typeof receipt.success === 'boolean'
    /** @type {import('@tetherto/wdk-wallet/protocols').SwidgeStatus} */
    const status = settled ? (receipt.success ? 'completed' : 'failed') : 'pending'
    return { status, transactions: [{ hash: id, chain: this.#chain.id, type: /** @type {const} */ ('source') }] }
  }

  /**
   * Returns the chains the module supports. Each instance swaps on its configured chain only.
   *
   * @returns {Promise<import('@tetherto/wdk-wallet/protocols').SwidgeSupportedChain[]>} The supported chains.
   */
  async getSupportedChains () {
    return Object.values(CHAINS).map(chain => ({ id: chain.id, name: chain.name, type: 'evm', nativeToken: chain.nativeSymbol }))
  }

  /**
   * Returns the tokens Fynd tracks on the configured chain (quality 100, zero transfer tax) plus the
   * native token, from one consistent block. Fynd routes between any listed tokens, so with `fromToken`
   * the result is the same list without `fromToken`. A `fromToken` that is not listed excludes nothing.
   *
   * @param {import('@tetherto/wdk-wallet/protocols').SwidgeSupportedTokensOptions} [options] - Optional chain hints and source token.
   * @returns {Promise<import('@tetherto/wdk-wallet/protocols').SwidgeSupportedToken[]>} The supported tokens.
   * @throws {ValueError} If a chain hint differs from the configured chain.
   * @throws {ProviderError} If Fynd fails, returns invalid metadata, or the list changes during pagination.
   */
  async getSupportedTokens (options = {}) {
    this.#checkChain(options.fromChain)
    this.#checkChain(options.toChain)
    const from = typeof options.fromToken === 'string' ? options.fromToken.toLowerCase() : undefined
    const excluded = from === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' ? NATIVE : from
    await this.#checkRouter()
    const tokens = await this.#api.tokens()
    return [
      { token: NATIVE, address: NATIVE, chain: this.#chain.id, symbol: this.#chain.nativeSymbol, decimals: 18 },
      ...tokens
        .filter(item => token(item.address) !== NATIVE)
        .map(item => ({ token: item.address, ...item, chain: this.#chain.id }))
    ].filter(item => item.address !== excluded)
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
      throw new SwidgeError('The executable minimum exceeds the requested slippage.', { reason: SwidgeErrorReason.SLIPPAGE_TOO_HIGH })
    }
    let transaction = validateTransaction(quote, request, this.#chain, clientFee)
    if (quote.minimum < request.minAmountOut) {
      throw new SwidgeError('The executable minimum is below minAmountOut.', { reason: SwidgeErrorReason.COULD_NOT_MET_THRESHOLD })
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
        throw new ProviderError('Fynd metadata does not match the supported chain and router.', {
          reason: ProviderErrorReason.INTERNAL_SERVER_ERROR
        })
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
    const account = this.#account
    if (tokenIn === NATIVE || !account) return []
    const allowance = amount(await rpc(() => account.getAllowance(tokenIn, this.#chain.router), true), 'allowance', true)
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
      const fee = await feeEstimate(() => account.quoteSendTransaction({ to: tokenIn, value: 0n, data }))
      if (fee === undefined) complete = false
      else total += fee
    }
    const fee = await feeEstimate(() => account.quoteSendTransaction(transaction))
    if (fee === undefined) {
      complete = false
      total += fallback
    } else {
      total += fee
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
