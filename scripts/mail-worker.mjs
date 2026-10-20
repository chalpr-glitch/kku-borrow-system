/**
 * KKU OAS Borrowing System - Background Mail Processing Worker & CLI Runner
 * Runtime: Node.js (Background Daemon / Scheduled Worker / CLI)
 * 
 * Entry Point: node scripts/mail-worker.mjs
 * 
 * Re-exports core worker functions from functions/worker-core.mjs to maintain
 * single source of truth across Cloud Functions and background CLI scripts.
 */

export {
  initAdmin,
  getDb,
  isMockGatewayAllowed,
  getGatewayConfig,
  dispatchViaGateway,
  validateRequestStatusBeforeSendAdmin,
  claimMailJob,
  processSingleMailJob,
  processMailQueueOnce,
} from '../functions/worker-core.mjs';

import { initAdmin, processMailQueueOnce, getDb } from '../functions/worker-core.mjs';

export const db = new Proxy({}, {
  get(_target, prop) {
    const firestore = getDb();
    const val = firestore[prop];
    return typeof val === 'function' ? val.bind(firestore) : val;
  }
});

if (process.argv[1] && process.argv[1].endsWith('mail-worker.mjs')) {
  console.log('📬 KKU OAS Mail Background Worker started...');
  processMailQueueOnce()
    .then((res) => {
      console.log(
        `Worker completed cycle: Processed ${res.processedCount} (Success: ${res.successCount}, Error: ${res.failureCount}, Skipped: ${res.skippedCount || 0}, Reconciled: ${res.reconciledCount || 0})`
      );
    })
    .catch((err) => {
      console.error('Worker run failed:', err);
    });
}
