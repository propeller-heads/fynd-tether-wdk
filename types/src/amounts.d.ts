/** @param {unknown} value @param {string} name @param {boolean} [allowZero] */
export function amount(value: unknown, name: string, allowZero?: boolean): bigint;
/** @param {unknown} value @param {string} name */
export function address(value: unknown, name: string): string;
/** @param {unknown} value */
export function token(value: unknown): string;
/** @param {unknown} value */
export function slippage(value?: unknown): string;
/** @param {number | bigint | undefined} value @param {string} name */
export function cap(value: number | bigint | undefined, name: string): bigint | undefined;
/** @param {bigint} fee @param {bigint} denominator @param {bigint | undefined} bps @param {string} name */
export function enforceCap(fee: bigint, denominator: bigint, bps: bigint | undefined, name: string): void;
/** Match Fynd's post-fee, six-decimal slippage truncation (encoder.rs).
 * @param {bigint} netOutput @param {string} slippage
 */
export function minimumForSlippage(netOutput: bigint, slippage: string): bigint;
export const NATIVE: string;
