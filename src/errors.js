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

import { SwidgeError } from '@tetherto/wdk-wallet/protocols'

/** Execution failure with transaction progress for reconciliation. */
export class FyndExecutionError extends SwidgeError {
  /**
   * @param {string} stage
   * @param {import('@tetherto/wdk-wallet/protocols').SwidgeTransaction[]} transactions
   * @param {boolean} submissionUnknown
   * @param {unknown} cause
   */
  constructor (stage, transactions, submissionUnknown, cause) {
    super(`Fynd execution stopped during ${stage}; inspect transaction progress before retrying.`, {
      reason: 'EXECUTION_STOPPED', cause
    })
    this.name = 'FyndExecutionError'
    this.stage = stage
    this.transactions = transactions.map(transaction => ({ ...transaction }))
    this.submissionUnknown = submissionUnknown
  }
}
