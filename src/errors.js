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

import { isError } from 'ethers'
import { SwidgeError, SwidgeErrorReason } from '@tetherto/wdk-wallet/protocols'

/**
 * Where execution stopped. `approval`, `allowance reset` and `swap submission` send a
 * transaction; `approval confirmation` waits for one; `quote refresh` requotes after approvals.
 * @typedef {'approval' | 'allowance reset' | 'approval confirmation' | 'quote refresh' | 'swap submission'} FyndExecutionStage
 */

/** @param {unknown} cause @returns {string | undefined} */
function swidgeReason (cause) {
  if (cause instanceof SwidgeError) return cause.reason
  if (isError(cause, 'INSUFFICIENT_FUNDS')) return SwidgeErrorReason.INSUFFICIENT_BALANCE
  return undefined
}

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
  constructor (stage, transactions, submissionUnknown, cause) {
    super(`Fynd execution stopped during ${stage}; inspect transaction progress before retrying.`, {
      reason: /** @type {string} */ (swidgeReason(cause)), cause
    })
    this.name = 'FyndExecutionError'
    /** @type {FyndExecutionStage} */
    this.stage = stage
    this.transactions = transactions.map(transaction => ({ ...transaction }))
    this.submissionUnknown = submissionUnknown
  }
}
