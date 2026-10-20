/**
 * KKU OAS Equipment Borrowing System - Core Background Mail Worker Engine
 * Runtime: Node.js (Functions artifact / background worker / CLI runner)
 *
 * Security Model:
 *  - Uses Server-side Admin SDK / Staff Context
 *  - Reads secrets strictly from process.env or system_settings/gateway_config
 *  - Atomic lock claim on pending jobs via Firestore Transaction (Guards against duplicate dispatches)
 *  - Strict nextAttemptAt backoff enforcement (Cannot be claimed before backoff expires)
 *  - Fail-closed on missing or disabled gateway configuration (CONFIGURATION_ERROR)
 *  - Strict indeterminate delivery handling (Never blindly auto-resend stuck PROCESSING jobs -> RECONCILIATION_REQUIRED)
 *  - Pre-dispatch stale status validation (Skips dispatch if request was already cancelled/returned)
 *  - Dispatches via dedicated mail-gateway.mjs module
 *  - Records complete audit trails in audit_logs collection
 */

import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { isMockGatewayAllowed, dispatchViaGateway } from './mail-gateway.mjs';

export { isMockGatewayAllowed, dispatchViaGateway };

/**
 * Initialize Firebase Admin safely:
 * - In Production: Uses Application Default Credentials (ADC) and automatic GCP project.
 * - In Tests / Emulator: Connects to FIRESTORE_EMULATOR_HOST ONLY if explicitly set in environment.
 * - NEVER hardcodes or defaults FIRESTORE_EMULATOR_HOST or project ID into process.env.
 */
export function initAdmin(options = {}) {
  const reqProjectId =
    options.projectId ||
    process.env.FIREBASE_PROJECT_ID ||
    process.env.GCLOUD_PROJECT ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    (process.env.FIRESTORE_EMULATOR_HOST ? 'demo-kku-oas-test' : undefined);

  if (getApps().length > 0) {
    const app = getApps()[0];
    if (!reqProjectId || app.options.projectId === reqProjectId) {
      return { app, db: getFirestore(app) };
    }
  }

  const appOptions = {};
  if (reqProjectId) {
    appOptions.projectId = reqProjectId;
  }

  const app = initializeApp(appOptions);
  const db = getFirestore(app);
  return { app, db };
}

/** Default shared database instance */
export function getDb(customDb = null) {
  if (customDb) return customDb;
  return initAdmin().db;
}

/** Record worker audit log entry safely without throwing */
async function recordWorkerAuditLog(firestore, action, targetId, details) {
  try {
    await firestore.collection('audit_logs').add({
      action: action || '',
      target: targetId || '',
      targetId: targetId || '',
      details: details || '',
      actor: 'system',
      actorEmail: 'system',
      actorName: 'Cloud Functions Mail Worker',
      actorRole: 'SYSTEM_WORKER',
      timestamp: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    // Audit log failure must not crash worker pipeline
  }
}

/** Fetch Gateway Config from Server-Only Storage (with non-secret metadata fallback from Policy) */
export async function getGatewayConfig(customDb = null) {
  const firestore = getDb(customDb);
  const gatewayDoc = await firestore
    .collection('system_settings')
    .doc('gateway_config')
    .get()
    .catch(() => null);

  let gatewayConfig = gatewayDoc && gatewayDoc.exists ? { ...gatewayDoc.data() } : null;

  if (
    !gatewayConfig ||
    !gatewayConfig.provider ||
    gatewayConfig.provider === 'NONE' ||
    !gatewayConfig.custodianEmail ||
    !gatewayConfig.approverEmail
  ) {
    const policyDoc = await firestore
      .collection('system_settings')
      .doc('policy')
      .get()
      .catch(() => null);

    if (policyDoc && policyDoc.exists) {
      const pData = policyDoc.data() || {};
      // STRICT ALLOWLIST: Never spread pData or read secret fields from system_settings/policy.
      // Credentials (gasWebhookUrl, brevoApiKey, resendApiKey) must reside exclusively in gateway_config.
      const fallbackProvider =
        typeof pData.emailProvider === 'string' && pData.emailProvider !== 'NONE'
          ? pData.emailProvider
          : 'NONE';
      gatewayConfig = {
        ...(gatewayConfig || {}),
        provider:
          gatewayConfig?.provider && gatewayConfig.provider !== 'NONE'
            ? gatewayConfig.provider
            : fallbackProvider,
        custodianEmail:
          gatewayConfig?.custodianEmail ||
          (typeof pData.custodianEmail === 'string' ? pData.custodianEmail : ''),
        approverEmail:
          gatewayConfig?.approverEmail ||
          (typeof pData.approverEmail === 'string' ? pData.approverEmail : ''),
      };
    }
  }

  return gatewayConfig || { provider: 'NONE' };
}

/** Pre-dispatch stale status check on server */
export async function validateRequestStatusBeforeSendAdmin(firestore, requestId, targetStatus) {
  if (!requestId || !targetStatus) return { valid: true };

  try {
    const docSnap = await firestore.collection('borrow_requests').doc(requestId).get();
    if (!docSnap.exists) {
      return { valid: false, reason: `ไม่พบคำขอ ${requestId} ในระบบแล้ว` };
    }
    const current = docSnap.data();
    if (targetStatus && current.status !== targetStatus) {
      if (['CANCELLED', 'RETURNED', 'RETURNED_DAMAGED', 'LOST'].includes(current.status)) {
        return {
          valid: false,
          reason: `คำขอ ${requestId} สิ้นสุดแล้ว (สถานะปัจจุบัน: ${current.status}) ยกเลิกการส่งเตือน`,
        };
      }
      return {
        valid: false,
        reason: `สถานะของคำขอเปลี่ยนเป็น ${current.status} แล้ว (เดิมรอ ${targetStatus})`,
      };
    }
  } catch (err) {
    console.warn(`Failed to pre-check request ${requestId} status:`, err.message);
  }
  return { valid: true };
}

/**
 * Atomic Lock Claim via Firestore Transaction
 * Enforces:
 *  - Must be in PENDING state (or FAILED/ERROR if retry requested)
 *  - nextAttemptAt must be <= nowMs (rejects premature retry claims)
 *  - Handles stale PROCESSING jobs by transitioning to RECONCILIATION_REQUIRED (NEVER blind resend)
 */
export async function claimMailJob(docRef, options = {}) {
  const firestore = docRef.firestore;
  const recoverStaleMs = options.staleTimeoutMs || 300000; // 5 minutes
  const nowMs = Date.now();

  try {
    return await firestore.runTransaction(async (tx) => {
      const docSnap = await tx.get(docRef);
      if (!docSnap.exists) {
        return { claimed: false, reason: 'NOT_FOUND' };
      }
      const job = docSnap.data();

      // 1. Guard against terminal SUCCESS
      if (job.status === 'SUCCESS') {
        return { claimed: false, reason: 'ALREADY_SUCCESS' };
      }

      // 2. Guard against indeterminate delivery / reconciliation required
      if (job.requiresReconciliation || job.status === 'RECONCILIATION_REQUIRED') {
        return { claimed: false, reason: 'RECONCILIATION_REQUIRED' };
      }

      // 3. Guard against active PROCESSING locks (unless recovering stale lock > 5m)
      if (job.status === 'PROCESSING') {
        if (options.recoverStale) {
          const claimedAt = job.claimedAt?.toMillis?.() || 0;
          if (nowMs - claimedAt > recoverStaleMs) {
            // NEVER auto-resend: Delivery may have already succeeded.
            // Mark RECONCILIATION_REQUIRED for audit/manual review.
            tx.update(docRef, {
              status: 'RECONCILIATION_REQUIRED',
              requiresReconciliation: true,
              errorDetails: 'Stale PROCESSING lock detected (>5m). Auto-resend prevented to avoid duplicate emails.',
              staleDetectedAt: Timestamp.now(),
            });
            return { claimed: false, reason: 'STALE_LOCK_RECONCILIATION_REQUIRED' };
          }
        }
        return { claimed: false, reason: 'ALREADY_PROCESSING' };
      }

      // 4. Validate allowed job state for claim:
      // Must be PENDING, or FAILED/ERROR if a retry was requested
      const isRetry = Boolean(options.allowRetry || job.retryRequestedAt);
      if (job.status !== 'PENDING' && !((job.status === 'FAILED' || job.status === 'ERROR') && isRetry)) {
        return { claimed: false, reason: `ALREADY_${job.status}` };
      }

      // 5. Check nextAttemptAt enforcement: Reject premature claims
      if (job.nextAttemptAt) {
        const nextAtMs = job.nextAttemptAt.toMillis
          ? job.nextAttemptAt.toMillis()
          : new Date(job.nextAttemptAt).getTime();

        if (nextAtMs > nowMs) {
          return {
            claimed: false,
            reason: 'RETRY_NOT_DUE',
            nextAttemptAt: nextAtMs,
          };
        }
      }

      // 6. Check maxAttempts
      const currentAttempts = typeof job.attemptCount === 'number' ? job.attemptCount : 0;
      const maxAttempts = typeof job.maxAttempts === 'number' ? job.maxAttempts : 3;
      if (currentAttempts >= maxAttempts) {
        return { claimed: false, reason: 'MAX_ATTEMPTS_EXCEEDED' };
      }

      const nextAttemptCount = currentAttempts + 1;

      // 7. Claim job atomically into PROCESSING
      tx.update(docRef, {
        status: 'PROCESSING',
        attemptCount: FieldValue.increment(1),
        claimedAt: Timestamp.now(),
        claimedBy: options.claimedBy || 'SERVER_WORKER',
        lastAttemptAt: Timestamp.now(),
      });

      return {
        claimed: true,
        job: { ...job, attemptCount: nextAttemptCount },
      };
    });
  } catch (txErr) {
    return { claimed: false, error: txErr.message };
  }
}

/**
 * Process a Single Mail Document with Atomic Transaction Lock
 */
export async function processSingleMailJob(docRefOrId, options = {}) {
  const docRef = typeof docRefOrId === 'string' ? (options.customDb || getDb()).collection('mail').doc(docRefOrId) : docRefOrId;
  const firestore = options.customDb || docRef.firestore || getDb();
  const mockFetch = options.customMockFetch || null;

  // 1. Atomic Lock Claim
  const claimResult = await claimMailJob(docRef, options);
  if (!claimResult.claimed) {
    return {
      success: false,
      claimed: false,
      reason: claimResult.reason,
      nextAttemptAt: claimResult.nextAttemptAt,
      error: claimResult.error,
    };
  }

  const { job } = claimResult;

  // 2. Pre-check Request Stale Status before Dispatch
  if (job.requestId && job.targetStatus) {
    const check = await validateRequestStatusBeforeSendAdmin(firestore, job.requestId, job.targetStatus);
    if (!check.valid) {
      await docRef.update({
        status: 'SKIPPED',
        errorDetails: check.reason,
        sentAt: Timestamp.now(),
      });
      return {
        success: true,
        claimed: true,
        skipped: true,
        reason: check.reason,
      };
    }
  }

  // 3. Resolve Gateway Configuration
  const gatewayConfig = options.gatewayConfig || (await getGatewayConfig(firestore));

  // 4. Dispatch Email via mail-gateway.mjs
  const result = await dispatchViaGateway(job, gatewayConfig, mockFetch, options);

  // 5. Update Document Outcome with Retry & Reconciliation Guards
  const maxAttempts = job.maxAttempts || 3;
  const attemptCount = job.attemptCount || 1;

  if (result.success) {
    await docRef.update({
      status: 'SUCCESS',
      sentAt: Timestamp.now(),
      lastAttemptAt: Timestamp.now(),
      messageId: result.messageId || null,
      errorDetails: null,
      retryCount: Math.max(0, attemptCount - 1),
    });

    if (job.type === 'RETROACTIVE_CSAT_INVITE' && job.requestId) {
      try {
        await firestore.collection('borrow_requests').doc(job.requestId).update({
          surveyInviteSentAt: Timestamp.now(),
          surveyInviteStatus: 'SENT',
          updatedAt: Timestamp.now(),
        });
      } catch (err) {
        console.warn(`Failed to update borrow_requests ${job.requestId} invite sent status:`, err.message);
      }
    }

    // Record Audit Trail
    await recordWorkerAuditLog(
      firestore,
      'DISPATCH_EMAIL_SUCCESS',
      docRef.id,
      `[MailJob: ${docRef.id}] Sent successfully to ${(job.to || []).join(', ')} (type: ${job.type || 'NOTIFICATION'}, attempt: ${attemptCount}/${maxAttempts})`
    );

    return { success: true, claimed: true, messageId: result.messageId };
  }

  // Indeterminate Error: Delivery may or may not have happened.
  // Transition to RECONCILIATION_REQUIRED to prevent duplicate emails.
  if (result.status === 'INDETERMINATE_ERROR') {
    await docRef.update({
      status: 'RECONCILIATION_REQUIRED',
      requiresReconciliation: true,
      errorDetails: result.message,
      lastErrorAt: Timestamp.now(),
      lastAttemptAt: Timestamp.now(),
      retryCount: Math.max(0, attemptCount - 1),
    });

    await recordWorkerAuditLog(
      firestore,
      'DISPATCH_EMAIL_RECONCILIATION_REQUIRED',
      docRef.id,
      `[MailJob: ${docRef.id}] Indeterminate delivery: ${result.message} (Requires verification before retry)`
    );

    return {
      success: false,
      claimed: true,
      retrying: false,
      requiresReconciliation: true,
      error: result.message,
    };
  }

  // Configuration Error: Gateway is disabled or misconfigured.
  // Fail closed to FAILED immediately (no pointless retries).
  if (result.status === 'CONFIGURATION_ERROR') {
    await docRef.update({
      status: 'FAILED',
      errorDetails: result.message,
      lastErrorAt: Timestamp.now(),
      lastAttemptAt: Timestamp.now(),
      failedAt: Timestamp.now(),
      retryCount: Math.max(0, attemptCount - 1),
    });

    await recordWorkerAuditLog(
      firestore,
      'DISPATCH_EMAIL_FAILED',
      docRef.id,
      `[MailJob: ${docRef.id}] Configuration error: ${result.message}`
    );

    return {
      success: false,
      claimed: true,
      retrying: false,
      error: result.message,
    };
  }

  // Deterministic Failure (e.g. Rate Limit 429 / HTTP 503 from confirmed gateway):
  if (attemptCount < maxAttempts) {
    const backoffMs = Math.min(60000 * Math.pow(2, attemptCount - 1), 300000); // 1m, 2m, 4m
    await docRef.update({
      status: 'PENDING', // Re-queue for next attempt
      errorDetails: result.message,
      lastErrorAt: Timestamp.now(),
      lastAttemptAt: Timestamp.now(),
      nextAttemptAt: Timestamp.fromMillis(Date.now() + backoffMs),
      retryCount: attemptCount,
    });

    return { success: false, claimed: true, retrying: true, error: result.message, nextAttemptAt: Date.now() + backoffMs };
  } else {
    // Exceeded max attempts: mark FAILED
    await docRef.update({
      status: 'FAILED',
      errorDetails: result.message,
      lastErrorAt: Timestamp.now(),
      lastAttemptAt: Timestamp.now(),
      failedAt: Timestamp.now(),
      retryCount: attemptCount,
    });

    await recordWorkerAuditLog(
      firestore,
      'DISPATCH_EMAIL_FAILED',
      docRef.id,
      `[MailJob: ${docRef.id}] Exceeded max attempts (${maxAttempts}): ${result.message}`
    );

    return { success: false, claimed: true, retrying: false, error: result.message };
  }
}

/** Process Single Batch of Pending Mail & Stale Recovery */
export async function processMailQueueOnce(customMockFetchOrOptions = null) {
  let options = {};
  if (typeof customMockFetchOrOptions === 'function') {
    options = { customMockFetch: customMockFetchOrOptions };
  } else if (customMockFetchOrOptions && typeof customMockFetchOrOptions === 'object') {
    options = customMockFetchOrOptions;
  }

  const firestore = options.customDb || getDb();
  const limit = options.limit || 50;
  let processedCount = 0;
  let successCount = 0;
  let failureCount = 0;
  let skippedCount = 0;
  let reconciledCount = 0;

  // 1. Fetch Gateway Config once for batch
  const gatewayConfig = await getGatewayConfig(firestore);

  // 2. Query Pending Jobs
  const nowMs = Date.now();
  const pendingSnapshot = await firestore
    .collection('mail')
    .where('status', '==', 'PENDING')
    .limit(limit)
    .get();

  for (const docSnap of pendingSnapshot.docs) {
    const data = docSnap.data();
    // Filter out jobs whose retry backoff has not expired yet
    if (data.nextAttemptAt) {
      const nextAtMs = data.nextAttemptAt.toMillis
        ? data.nextAttemptAt.toMillis()
        : new Date(data.nextAttemptAt).getTime();
      if (nextAtMs > nowMs) {
        continue;
      }
    }

    processedCount++;
    const res = await processSingleMailJob(docSnap.ref, {
      ...options,
      gatewayConfig,
    });

    if (res.claimed && res.success) {
      if (res.skipped) {
        skippedCount++;
      } else {
        successCount++;
      }
    } else if (res.claimed && !res.success) {
      failureCount++;
    }
  }

  // 3. Stale PROCESSING Recovery (if requested)
  if (options.recoverStale) {
    const recoverStaleMs = options.staleTimeoutMs || 300000;
    const processingSnapshot = await firestore
      .collection('mail')
      .where('status', '==', 'PROCESSING')
      .limit(limit)
      .get();

    for (const docSnap of processingSnapshot.docs) {
      const data = docSnap.data();
      const claimedAtMs = data.claimedAt?.toMillis?.() || 0;
      if (nowMs - claimedAtMs > recoverStaleMs) {
        const res = await claimMailJob(docSnap.ref, {
          recoverStale: true,
          staleTimeoutMs: recoverStaleMs,
        });
        if (res.reason === 'STALE_LOCK_RECONCILIATION_REQUIRED') {
          reconciledCount++;
        }
      }
    }
  }

  return {
    processedCount,
    successCount,
    failureCount,
    skippedCount,
    reconciledCount,
  };
}
