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
export function validateTransaction(quote: {
    amountIn: bigint;
    grossOutput: bigint;
    minimum: bigint;
    clientFee: bigint;
    transaction: {
        to: string;
        value: bigint;
        data: string;
    };
}, request: {
    tokenIn: string;
    tokenOut: string;
    amountIn: bigint;
    recipient: string;
}, chain: Chain, clientFee?: ClientFee): {
    to: string;
    value: bigint;
    data: string;
};
/**
 * The EIP-712 data the router verifies for client-fee parameters, built from the calldata
 * the wallet will send.
 * @param {{ data: string }} transaction - A transaction accepted by {@link validateTransaction}.
 * @param {Chain} chain
 */
export function clientFeeTypedData(transaction: {
    data: string;
}, chain: Chain): {
    domain: {
        name: string;
        version: string;
        chainId: 1 | 8453 | 42161 | 56 | 137 | 130 | 4663;
        verifyingContract: "0xe41c726421007e133a59365432fe886a73b45126" | "0xd374c00614f95492d816b5957e3797ce3f0c445c" | "0x1b82e8c16ce8e17535c9b6b8ad107f61b0b192b5" | "0xee7ece626064bda1c6afdb8a281afe44eabd3242" | "0x4db0b661dc706f7e09e54273028b22f61f8f94c2" | "0x556dff14e4a42259ebce4fa087323c1047e9a55a" | "0x6f460540b03651d2ad0ec28f777e4a0480a756a5";
    };
    types: Readonly<{
        ClientFee: {
            name: string;
            type: string;
        }[];
    }>;
    message: {
        clientFeeBps: any;
        clientFeeReceiver: any;
        maxClientContribution: any;
        deadline: any;
        amountIn: any;
        tokenIn: any;
        tokenOut: any;
        expectedAmountOut: any;
        minAmountOut: any;
        receiver: any;
        swaps: any;
    };
};
/**
 * Write a client-fee signature over the placeholder Fynd reserved at `offset`, then check
 * that the calldata decodes with exactly that signature.
 * @param {{ to: string, value: bigint, data: string }} transaction
 * @param {number | undefined} offset - Byte offset of the placeholder within the calldata.
 * @param {unknown} signature - 65-byte hex signature from the wallet.
 * @returns {{ to: string, value: bigint, data: string }}
 */
export function insertSignature(transaction: {
    to: string;
    value: bigint;
    data: string;
}, offset: number | undefined, signature: unknown): {
    to: string;
    value: bigint;
    data: string;
};
/** @typedef {(typeof CHAINS)[keyof typeof CHAINS]} Chain */
/** @typedef {{ receiver: string, deadline: bigint }} ClientFee */
export const CHAINS: Readonly<{
    ethereum: Readonly<{
        id: 1;
        name: "Ethereum";
        router: "0xe41c726421007e133a59365432fe886a73b45126";
        nativeSymbol: "ETH";
    }>;
    base: Readonly<{
        id: 8453;
        name: "Base";
        router: "0xd374c00614f95492d816b5957e3797ce3f0c445c";
        nativeSymbol: "ETH";
    }>;
    arbitrum: Readonly<{
        id: 42161;
        name: "Arbitrum";
        router: "0x1b82e8c16ce8e17535c9b6b8ad107f61b0b192b5";
        nativeSymbol: "ETH";
    }>;
    bsc: Readonly<{
        id: 56;
        name: "BNB Smart Chain";
        router: "0xee7ece626064bda1c6afdb8a281afe44eabd3242";
        nativeSymbol: "BNB";
    }>;
    polygon: Readonly<{
        id: 137;
        name: "Polygon";
        router: "0x4db0b661dc706f7e09e54273028b22f61f8f94c2";
        nativeSymbol: "POL";
    }>;
    unichain: Readonly<{
        id: 130;
        name: "Unichain";
        router: "0x556dff14e4a42259ebce4fa087323c1047e9a55a";
        nativeSymbol: "ETH";
    }>;
    robinhood: Readonly<{
        id: 4663;
        name: "Robinhood Chain";
        router: "0x6f460540b03651d2ad0ec28f777e4a0480a756a5";
        nativeSymbol: "ETH";
    }>;
}>;
export type Chain = (typeof CHAINS)[keyof typeof CHAINS];
export type ClientFee = {
    receiver: string;
    deadline: bigint;
};
