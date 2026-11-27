/**
 * Execution failure with transaction progress for reconciliation. `reason` is the cause's
 * Swidge reason (a `SwidgeErrorReason` value or a reason proposed to WDK, such as
 * `APPROVAL_FAILED`), `INSUFFICIENT_BALANCE` for an ethers `INSUFFICIENT_FUNDS` cause, or
 * `undefined`.
 */
export class FyndExecutionError extends SwidgeError {
    /**
     * @param {FyndExecutionStage} stage
     * @param {import('@tetherto/wdk-wallet/protocols').SwidgeTransaction[]} transactions
     * @param {boolean} submissionUnknown
     * @param {unknown} cause
     */
    constructor(stage: FyndExecutionStage, transactions: import("@tetherto/wdk-wallet/protocols").SwidgeTransaction[], submissionUnknown: boolean, cause: unknown);
    /** @type {FyndExecutionStage} */
    stage: FyndExecutionStage;
    transactions: {
        hash: string;
        chain?: string | number;
        type?: "source" | "destination" | "approval" | "refund" | "other";
    }[];
    submissionUnknown: boolean;
}
/**
 * Where execution stopped. `approval`, `allowance reset` and `swap submission` send a
 * transaction; `approval confirmation` waits for one; `quote refresh` requotes after approvals.
 */
export type FyndExecutionStage = "approval" | "allowance reset" | "approval confirmation" | "quote refresh" | "swap submission";
import { SwidgeError } from '@tetherto/wdk-wallet/protocols';
