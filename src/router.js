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

import { ProviderError, ProviderErrorReason, ValueError } from '@tetherto/wdk-wallet'
import { getAddress, Interface, ZeroAddress } from 'ethers'
import { token } from './amounts.js'

/** @typedef {(typeof CHAINS)[keyof typeof CHAINS]} Chain */
/** @typedef {{ receiver: string, deadline: bigint }} ClientFee */

// Active TychoRouterV3 per chain in Tycho's deployment registry, effective 2026-11-16.
// Source and upgrades: docs/compatibility.md#router-contract.
export const CHAINS = Object.freeze({
  ethereum: Object.freeze({ id: 1, name: 'Ethereum', router: '0xe41c726421007e133a59365432fe886a73b45126', nativeSymbol: 'ETH' }),
  base: Object.freeze({ id: 8453, name: 'Base', router: '0xd374c00614f95492d816b5957e3797ce3f0c445c', nativeSymbol: 'ETH' }),
  arbitrum: Object.freeze({ id: 42161, name: 'Arbitrum', router: '0x1b82e8c16ce8e17535c9b6b8ad107f61b0b192b5', nativeSymbol: 'ETH' }),
  bsc: Object.freeze({ id: 56, name: 'BNB Smart Chain', router: '0xee7ece626064bda1c6afdb8a281afe44eabd3242', nativeSymbol: 'BNB' }),
  polygon: Object.freeze({ id: 137, name: 'Polygon', router: '0x4db0b661dc706f7e09e54273028b22f61f8f94c2', nativeSymbol: 'POL' }),
  unichain: Object.freeze({ id: 130, name: 'Unichain', router: '0x556dff14e4a42259ebce4fa087323c1047e9a55a', nativeSymbol: 'ETH' }),
  robinhood: Object.freeze({ id: 4663, name: 'Robinhood Chain', router: '0x6f460540b03651d2ad0ec28f777e4a0480a756a5', nativeSymbol: 'ETH' }),
  arc: Object.freeze({ id: 5042, name: 'Arc', router: '0x52a1bc20f2b78461d7a03c32f6c7388d4587980f', nativeSymbol: 'USDC' }),
  elysium: Object.freeze({ id: 99901, name: 'Elysium', router: '0x643577f3b0cb8ce1b1b73c6e872b907acacd2662', nativeSymbol: 'HYPE' })
})

const ROUTER_NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
const FEE_TUPLE = '(uint32 clientFeeBps,address clientFeeReceiver,uint256 maxClientContribution,uint256 deadline,bytes clientSignature)'
const PARAMETERS = 'uint256 amountIn,address tokenIn,address tokenOut,uint256 expectedAmountOut,uint256 minAmountOut'
const routerInterface = new Interface([
  `function singleSwap(${PARAMETERS},address receiver,${FEE_TUPLE} clientFeeParams,bytes swaps) payable returns (uint256)`,
  `function sequentialSwap(${PARAMETERS},address receiver,${FEE_TUPLE} clientFeeParams,bytes swaps) payable returns (uint256)`,
  `function splitSwap(${PARAMETERS},uint256 nTokens,address receiver,${FEE_TUPLE} clientFeeParams,bytes swaps) payable returns (uint256)`
])
// Fynd reserves a zeroed 65-byte ECDSA signature for the client to overwrite.
const SIGNATURE_PLACEHOLDER = '0x' + '00'.repeat(65)
// Field order of the router's CLIENT_FEE_TYPEHASH (TychoRouterV3).
const CLIENT_FEE_TYPES = Object.freeze({
  ClientFee: [
    { name: 'clientFeeBps', type: 'uint32' },
    { name: 'clientFeeReceiver', type: 'address' },
    { name: 'maxClientContribution', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'amountIn', type: 'uint256' },
    { name: 'tokenIn', type: 'address' },
    { name: 'tokenOut', type: 'address' },
    { name: 'expectedAmountOut', type: 'uint256' },
    { name: 'minAmountOut', type: 'uint256' },
    { name: 'receiver', type: 'address' },
    { name: 'swaps', type: 'bytes' }
  ]
})

/** Fynd calldata that does not match the request is a provider failure. @param {string} message @param {unknown} [cause] */
function invalid (message, cause) {
  return new ProviderError(`Invalid Fynd transaction: ${message}`, { reason: ProviderErrorReason.INTERNAL_SERVER_ERROR, cause })
}

/** @param {string} data */
function decode (data) {
  const call = routerInterface.parseTransaction({ data })
  if (!call) throw invalid('unsupported router method')
  return call
}

/**
 * Check the supported router call's outer arguments before approvals or signing.
 * This does not inspect the opaque pool/executor route or independently price it.
 *
 * With `clientFee`, the calldata must carry that zero-fee receiver and deadline with an
 * unsigned placeholder, ready for {@link insertSignature}. Without it (quotes, which are never
 * sent), any zero-fee parameters are accepted.
 *
 * @param {{ amountIn: bigint, grossOutput: bigint, minimum: bigint, clientFee: bigint,
 *   transaction: { to: string, value: bigint, data: string } }} quote
 * @param {{ tokenIn: string, tokenOut: string, amountIn: bigint, recipient: string }} request
 * @param {Chain} chain
 * @param {ClientFee} [clientFee]
 * @returns {{ to: string, value: bigint, data: string }}
 */
export function validateTransaction (quote, request, chain, clientFee) {
  const { transaction } = quote
  let tokenIn, tokenOut, recipient, destination
  try {
    tokenIn = token(request.tokenIn)
    tokenOut = token(request.tokenOut)
    recipient = getAddress(request.recipient).toLowerCase()
    destination = getAddress(transaction.to).toLowerCase()
  } catch (error) {
    throw invalid('invalid token, recipient or destination address', error)
  }
  if (destination !== chain.router || recipient === chain.router || recipient === ZeroAddress) {
    throw invalid('router or recipient does not match the supported wallet swap')
  }
  if (quote.amountIn !== request.amountIn || request.amountIn <= 0n || quote.grossOutput <= 0n ||
      quote.minimum <= 0n || quote.minimum > quote.grossOutput || quote.clientFee !== 0n) {
    throw invalid('invalid quote amounts or unsupported client fee')
  }
  const expectedValue = tokenIn === ZeroAddress ? request.amountIn : 0n
  if (transaction.value !== expectedValue) {
    throw invalid('native value does not match the input amount')
  }
  if (typeof transaction.data !== 'string' || !/^0x(?:[0-9a-fA-F]{2}){4,}$/.test(transaction.data)) {
    throw invalid('malformed calldata')
  }

  try {
    // Solidity ignores trailing bytes; ethers decodes the call with its Fynd watermark.
    const call = decode(transaction.data)
    const { args } = call
    const routerTokenIn = tokenIn === ZeroAddress ? ROUTER_NATIVE : tokenIn
    const routerTokenOut = tokenOut === ZeroAddress ? ROUTER_NATIVE : tokenOut
    if (args.amountIn !== request.amountIn || args.tokenIn.toLowerCase() !== routerTokenIn ||
        args.tokenOut.toLowerCase() !== routerTokenOut || args.receiver.toLowerCase() !== recipient ||
        args.expectedAmountOut !== quote.grossOutput || args.minAmountOut !== quote.minimum) {
      throw invalid('calldata does not match the requested swap and quote')
    }
    const fee = args.clientFeeParams
    if (fee.clientFeeBps !== 0n || fee.maxClientContribution !== 0n) {
      throw invalid('client fee or signing parameters are unsupported')
    }
    if (clientFee && (fee.clientFeeReceiver.toLowerCase() !== clientFee.receiver ||
        fee.deadline !== clientFee.deadline || fee.clientSignature !== SIGNATURE_PLACEHOLDER)) {
      throw invalid('client fee or signing parameters are unsupported')
    }
    if (args.swaps === '0x' || (call.name === 'splitSwap' && args.nTokens < 2n)) {
      throw invalid('empty or invalid swap route')
    }
  } catch (error) {
    if (error instanceof ProviderError) throw error
    throw invalid('malformed calldata or unsupported router method', error)
  }
  return { to: destination, value: transaction.value, data: transaction.data }
}

/**
 * The EIP-712 data the router verifies for client-fee parameters, built from the calldata
 * the wallet will send.
 * @param {{ data: string }} transaction - A transaction accepted by {@link validateTransaction}.
 * @param {Chain} chain
 */
export function clientFeeTypedData (transaction, chain) {
  const { args } = decode(transaction.data)
  const fee = args.clientFeeParams
  return {
    domain: { name: 'TychoRouter', version: '1', chainId: chain.id, verifyingContract: chain.router },
    types: CLIENT_FEE_TYPES,
    message: {
      clientFeeBps: fee.clientFeeBps,
      clientFeeReceiver: fee.clientFeeReceiver,
      maxClientContribution: fee.maxClientContribution,
      deadline: fee.deadline,
      amountIn: args.amountIn,
      tokenIn: args.tokenIn,
      tokenOut: args.tokenOut,
      expectedAmountOut: args.expectedAmountOut,
      minAmountOut: args.minAmountOut,
      receiver: args.receiver,
      swaps: args.swaps
    }
  }
}

/**
 * Write a client-fee signature over the placeholder Fynd reserved at `offset`, then check
 * that the calldata decodes with exactly that signature.
 * @param {{ to: string, value: bigint, data: string }} transaction
 * @param {number | undefined} offset - Byte offset of the placeholder within the calldata.
 * @param {unknown} signature - 65-byte hex signature from the wallet.
 * @returns {{ to: string, value: bigint, data: string }}
 */
export function insertSignature (transaction, offset, signature) {
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    throw new ValueError('WDK returned an invalid client-fee signature.')
  }
  if (offset === undefined) throw invalid('Fynd returned no client-fee signature offset')
  const start = 2 + offset * 2
  const end = start + 130
  if (transaction.data.slice(start, end) !== SIGNATURE_PLACEHOLDER.slice(2)) {
    throw invalid('the client-fee signature offset does not point at the placeholder')
  }
  const signed = signature.toLowerCase()
  const data = transaction.data.slice(0, start) + signed.slice(2) + transaction.data.slice(end)
  let decoded
  try {
    decoded = decode(data).args.clientFeeParams.clientSignature
  } catch {
    decoded = undefined
  }
  if (decoded !== signed) {
    throw invalid('the client-fee signature offset does not match the signature field')
  }
  return { ...transaction, data }
}
