/** Fynd API client for the hosted gateway or a self-hosted Fynd. WDK signs and submits transactions. */
export class FyndApi {
    /**
     * The hosted gateway (or a proxy in front of it) serves each chain at `/v1/{chain}`;
     * a self-hosted Fynd serves its one chain at `/v1` without authentication.
     * @param {{baseUrl?: string, selfHostedUrl?: string, apiKey?: string, chain: string, timeoutMs?: number}} config
     */
    constructor({ baseUrl, selfHostedUrl, apiKey, chain, timeoutMs }: {
        baseUrl?: string;
        selfHostedUrl?: string;
        apiKey?: string;
        chain: string;
        timeoutMs?: number;
    });
    /** @returns {Promise<{chainId: number, routerAddress: string | null}>} */
    info(): Promise<{
        chainId: number;
        routerAddress: string | null;
    }>;
    /**
     * @overload
     * @param {FyndOrder} order
     * @param {{encode: false}} options
     * @returns {Promise<ValuationQuote>}
     */
    quote(order: FyndOrder, options: {
        encode: false;
    }): Promise<ValuationQuote>;
    /**
     * @overload
     * @param {FyndOrder} order
     * @param {{slippage: string, clientFee?: import('./router.js').ClientFee, encode?: true}} options
     * @returns {Promise<EncodedQuote>}
     */
    quote(order: FyndOrder, options: {
        slippage: string;
        clientFee?: import("./router.js").ClientFee;
        encode?: true;
    }): Promise<EncodedQuote>;
    /** Returns complete single-block metadata filtered to quality 100/tax 0. @returns {Promise<FyndToken[]>} */
    tokens(): Promise<FyndToken[]>;
    #private;
}
export type FyndOrder = {
    tokenIn: string;
    tokenOut: string;
    amountIn: bigint;
    sender: string;
    receiver: string;
};
export type ValuationQuote = {
    amountIn: bigint;
    grossOutput: bigint;
    gas: bigint;
    gasPrice: bigint | undefined;
    /**
     * - Decimal fraction (0.01 is 1%).
     */
    priceImpact: number | undefined;
};
export type EncodedQuote = ValuationQuote & {
    routerFee: bigint;
    clientFee: bigint;
    minimum: bigint;
    transaction: {
        to: string;
        data: string;
        value: bigint;
    };
    signatureOffset: number | undefined;
};
export type FyndToken = {
    address: string;
    symbol: string;
    decimals: number;
};
