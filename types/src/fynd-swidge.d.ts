/** Fynd exact-input swaps through the hosted API or a self-hosted Fynd. Configure the WDK wallet with the same chainId. */
export default class FyndSwidgeProtocol extends SwidgeProtocol {
    /**
     * Creates a Fynd Swidge protocol.
     * @overload
     * @param {WalletAccount | undefined} account - WDK EVM account; full to execute, read-only for quotes and status.
     * @param {FyndConfig} config - The Fynd configuration.
     * @throws {ValueError} If the configuration or account is not supported.
     */
    constructor(account: WalletAccount | undefined, config: FyndConfig);
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
    quoteSwidge(options: SwidgeOptions): Promise<FyndSwidgeQuote>;
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
    swidge(options: SwidgeOptions, config?: SwidgeProtocolConfig): Promise<FyndSwidgeResult>;
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
    getSwidgeStatus(id: string, options?: import("@tetherto/wdk-wallet/protocols").SwidgeStatusOptions): Promise<import("@tetherto/wdk-wallet/protocols").SwidgeStatusResult>;
    /**
     * Returns the chains the module supports. Each instance swaps on its configured chain only.
     *
     * @returns {Promise<import('@tetherto/wdk-wallet/protocols').SwidgeSupportedChain[]>} The supported chains.
     */
    getSupportedChains(): Promise<import("@tetherto/wdk-wallet/protocols").SwidgeSupportedChain[]>;
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
    getSupportedTokens(options?: import("@tetherto/wdk-wallet/protocols").SwidgeSupportedTokensOptions): Promise<import("@tetherto/wdk-wallet/protocols").SwidgeSupportedToken[]>;
    #private;
}
export type WalletAccount = import("@tetherto/wdk-wallet").IWalletAccountReadOnly;
export type SwidgeOptions = import("@tetherto/wdk-wallet/protocols").SwidgeOptions;
export type SwidgeProtocolConfig = import("@tetherto/wdk-wallet/protocols").SwidgeProtocolConfig;
export type SwidgeQuote = import("@tetherto/wdk-wallet/protocols").SwidgeQuote;
export type SwidgeResult = import("@tetherto/wdk-wallet/protocols").SwidgeResult;
export type SwidgeTransaction = import("@tetherto/wdk-wallet/protocols").SwidgeTransaction;
export type SwidgeFee = import("@tetherto/wdk-wallet/protocols").SwidgeFee;
export type SwapRequest = {
    tokenIn: string;
    tokenOut: string;
    amountIn: bigint;
    sender: string;
    recipient: string;
    minAmountOut: bigint;
    slippage: string;
};
export type NetworkEstimate = {
    amount: bigint;
    complete: boolean;
};
export type Prepared = {
    quote: import("./fynd-api.js").EncodedQuote;
    request: SwapRequest;
    transaction: {
        to: string;
        data: string;
        value: bigint;
    };
    approvals: bigint[];
    network: NetworkEstimate;
};
/**
 * A Swidge quote that also reports whether the network fee estimate covers every network cost.
 */
export type FyndSwidgeQuote = SwidgeQuote & {
    networkFeeComplete: boolean;
};
/**
 * A Swidge result that also reports whether the network fee estimate covers every network cost.
 */
export type FyndSwidgeResult = SwidgeResult & {
    networkFeeComplete: boolean;
};
/**
 * Fynd Swidge configuration, passed to `registerProtocol` or the constructor.
 * Use the hosted API (`apiKey`, optionally `baseUrl`) or a self-hosted Fynd (`selfHostedUrl`), not both.
 */
export type FyndConfig = {
    /**
     * - Supported chain ID; configure the WDK wallet with the same chain.
     */
    chainId: import("./router.js").Chain["id"];
    /**
     * - Hosted API key, sent as the raw `Authorization` header. Not allowed with `selfHostedUrl`.
     */
    apiKey?: string | undefined;
    /**
     * - Hosted API URL, or your proxy in front of it. Default `https://fynd-api.propellerheads.xyz`. Not allowed with `selfHostedUrl`.
     */
    baseUrl?: string | undefined;
    /**
     * - URL of your own single-chain Fynd server. Excludes `baseUrl` and `apiKey`.
     */
    selfHostedUrl?: string | undefined;
    /**
     * - Sender address for quotes without an account; the account address takes precedence.
     */
    quoteSender?: string | undefined;
    /**
     * - Timeout per Fynd request in milliseconds, including the body and the whole token list. Default 10000.
     */
    timeoutMs?: number | undefined;
    /**
     * - Confirmation timeout per approval in milliseconds. Default 180000.
     */
    approvalTimeoutMs?: number | undefined;
    /**
     * - Seconds a signed swap stays valid before the router rejects it. Default 120.
     */
    deadlineSeconds?: number | undefined;
    /**
     * - Default network fee cap for `swidge`, in basis points of the input value. No cap by default.
     */
    maxNetworkFeeBps?: number | bigint | undefined;
    /**
     * - Default router fee cap for `swidge`, in basis points of the gross output. No cap by default.
     */
    maxProtocolFeeBps?: number | bigint | undefined;
};
import { SwidgeProtocol } from '@tetherto/wdk-wallet/protocols';
