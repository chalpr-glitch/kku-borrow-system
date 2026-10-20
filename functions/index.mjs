/**
 * KKU OAS Equipment Borrowing System - Cloud Functions Triggers
 * 
 * Triggers:
 *  1. onMailCreated: Firestore Trigger on /mail/{mailId}
 *     Instantly processes new mail jobs created by USER or Staff.
 *  2. onMailSchedule: Scheduled Cloud Function (Cron)
 *     Runs every 5 minutes to sweep any pending retries or stale jobs.
 */

import { onDocumentCreated, onDocumentUpdated } from 'firebase-functions/v2/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { processSingleMailJob, processMailQueueOnce, initAdmin, getDb } from './worker-core.mjs';

// Safe initialization (ADC in prod, emulator only if set)
initAdmin();

/**
 * 1. Instant Trigger on Mail Document Creation
 * Guarantees zero-lag email dispatch even when initiated by non-staff borrowers
 */
export const onMailCreated = onDocumentCreated(
  {
    document: 'mail/{mailId}',
    region: 'asia-southeast1',
    memory: '256MiB',
    timeoutSeconds: 60,
    maxInstances: 10,
  },
  async (event) => {
    const snap = event.data;
    if (!snap) return null;

    const data = snap.data();
    if (data.status !== 'PENDING') {
      return null;
    }

    console.log(`[onMailCreated] Triggered for mail doc: ${snap.id}`);
    const result = await processSingleMailJob(snap.ref);
    console.log(`[onMailCreated] Completed mail doc: ${snap.id}`, result);
    return result;
  }
);

/**
 * 2. Instant Trigger on Mail Document Update (Retry or Reset to PENDING)
 */
export const onMailUpdated = onDocumentUpdated(
  {
    document: 'mail/{mailId}',
    region: 'asia-southeast1',
    memory: '256MiB',
    timeoutSeconds: 60,
    maxInstances: 10,
  },
  async (event) => {
    const after = event.data?.after;
    if (!after || !after.exists) return null;
    const afterData = after.data();

    // Guard: Ignore jobs that already succeeded or require manual reconciliation
    if (afterData.status === 'SUCCESS' || afterData.status === 'RECONCILIATION_REQUIRED' || afterData.requiresReconciliation) {
      return null;
    }

    const before = event.data?.before;
    const beforeData = before?.exists ? before.data() : null;

    const retryRequested = Boolean(
      afterData.retryRequestedAt &&
      (!beforeData?.retryRequestedAt ||
        (afterData.retryRequestedAt?.toMillis && beforeData.retryRequestedAt?.toMillis &&
         afterData.retryRequestedAt.toMillis() !== beforeData.retryRequestedAt.toMillis()))
    );

    const sweepRequested = Boolean(
      (afterData.sweepRequestedAt || afterData.serverSweepTriggeredAt) &&
      (!beforeData?.sweepRequestedAt && !beforeData?.serverSweepTriggeredAt ||
        ((afterData.sweepRequestedAt?.toMillis?.() || afterData.serverSweepTriggeredAt?.toMillis?.()) !==
         (beforeData?.sweepRequestedAt?.toMillis?.() || beforeData?.serverSweepTriggeredAt?.toMillis?.())))
    );

    const statusResetToPending = afterData.status === 'PENDING' && beforeData?.status !== 'PENDING';

    // Only process if retry, sweep, or pending transition was signaled
    if (!retryRequested && !sweepRequested && !statusResetToPending) {
      return null;
    }

    console.log(`[onMailUpdated] Triggered for mail doc: ${after.id} (retry: ${retryRequested}, sweep: ${sweepRequested})`);
    const result = await processSingleMailJob(after.ref, { allowRetry: retryRequested });
    console.log(`[onMailUpdated] Completed mail doc: ${after.id}`, result);
    return result;
  }
);

/**
 * 2. Scheduled Sweep for Pending & Retry Jobs
 * Runs every 5 minutes to sweep any transient failures
 */
export const onMailSchedule = onSchedule(
  {
    schedule: 'every 5 minutes',
    timeZone: 'Asia/Bangkok',
    region: 'asia-southeast1',
    memory: '256MiB',
    timeoutSeconds: 120,
    maxInstances: 1,
  },
  async (event) => {
    console.log('[onMailSchedule] Starting periodic mail queue sweep...');
    const result = await processMailQueueOnce({ limit: 50, recoverStale: true });
    console.log('[onMailSchedule] Mail sweep completed:', result);
    return result;
  }
);

/**
 * 4. Secure Server Endpoint for Gateway Config Status (Read-Only Safe Masked Status)
 * Allows staff to know if gateway credentials are set without exposing secrets
 */
export const getGatewayConfigStatus = onCall(
  {
    region: 'asia-southeast1',
    maxInstances: 5,
  },
  async (request) => {
    try {
      if (!request.auth || !request.auth.token || !request.auth.token.email) {
        throw new HttpsError('unauthenticated', 'กรุณาเข้าสู่ระบบก่อนตรวจสอบสถานะ Gateway');
      }
      const callerEmail = request.auth.token.email.toLowerCase();
      const db = getDb();

      let userRole = null;
      const userSnap = await db.collection('users').doc(callerEmail).get();
      if (userSnap.exists) {
        userRole = userSnap.data()?.role;
      } else {
        const knownStaff = {
          'chalpr@kku.ac.th': 'CUSTODIAN',
          'chukam@kku.ac.th': 'EXECUTIVE',
          'supako@kku.ac.th': 'EXECUTIVE',
          'nsurap@kku.ac.th': 'EXECUTIVE',
          'praysu@kku.ac.th': 'APPROVER',
        };
        userRole = knownStaff[callerEmail] || null;
      }

      if (!userRole || !['CUSTODIAN', 'APPROVER', 'EXECUTIVE'].includes(userRole)) {
        throw new HttpsError('permission-denied', 'เฉพาะเจ้าหน้าที่ (Staff) เท่านั้นที่สามารถตรวจสอบสถานะ Gateway ได้');
      }

      const docSnap = await db.collection('system_settings').doc('gateway_config').get();
      if (!docSnap.exists) {
        return { configured: false, provider: 'NONE' };
      }
      const d = docSnap.data() || {};
      return {
        configured: Boolean(d.gasWebhookUrl || d.brevoApiKey || d.resendApiKey),
        provider: d.provider || d.emailProvider || 'NONE',
        hasGasWebhookUrl: Boolean(d.gasWebhookUrl),
        hasGasSecretToken: Boolean(d.gasSecretToken),
        gasSenderName: d.gasSenderName || '',
        gasSenderEmail: d.gasSenderEmail || '',
        hasBrevoApiKey: Boolean(d.brevoApiKey),
        brevoSenderEmail: d.brevoSenderEmail || '',
        brevoSenderName: d.brevoSenderName || '',
        hasResendApiKey: Boolean(d.resendApiKey),
        resendSender: d.resendSender || '',
        updatedAt: d.updatedAt ? (d.updatedAt.toDate ? d.updatedAt.toDate().toISOString() : d.updatedAt) : null,
        updatedBy: d.updatedBy || null,
      };
    } catch (err) {
      if (err instanceof HttpsError) {
        throw err;
      }
      console.error('[getGatewayConfigStatus] Unexpected error:', err);
      throw new HttpsError('internal', `เกิดข้อผิดพลาดในการตรวจสอบสถานะ Gateway: ${err.message || 'ระบบขัดข้อง'}`);
    }
  }
);

/**
 * 5. Secure Server Endpoint for Gateway Config Updates (Server-Only Trusted Mutator)
 * Strictly verifies CUSTODIAN or EXECUTIVE role, validates inputs, logs audit, and writes via Admin SDK
 */
export const updateGatewayConfig = onCall(
  {
    region: 'asia-southeast1',
    maxInstances: 5,
  },
  async (request) => {
    try {
      if (!request.auth || !request.auth.token || !request.auth.token.email) {
        throw new HttpsError('unauthenticated', 'กรุณาเข้าสู่ระบบก่อนทำการตั้งค่า Gateway');
      }
      const callerEmail = request.auth.token.email.toLowerCase();
      const db = getDb();

      let userRole = null;
      let userName = null;
      const userSnap = await db.collection('users').doc(callerEmail).get();
      if (userSnap.exists) {
        userRole = userSnap.data()?.role;
        userName = userSnap.data()?.name;
      } else {
        const knownStaff = {
          'chalpr@kku.ac.th': { role: 'CUSTODIAN', name: 'นายชาลี พรหมอินทร์' },
          'chukam@kku.ac.th': { role: 'EXECUTIVE', name: 'รศ.น.สพ.ดร.ชูชาติ กมลเลิศ' },
          'supako@kku.ac.th': { role: 'EXECUTIVE', name: 'รศ.ดร.ศุภสิทธิ์ คนใหญ่' },
          'nsurap@kku.ac.th': { role: 'EXECUTIVE', name: 'ผศ.ดร.สุรพล เนสุสินธุ์' },
          'praysu@kku.ac.th': { role: 'APPROVER', name: 'นายประหยัด สืบเมืองซ้าย' },
        };
        if (knownStaff[callerEmail]) {
          userRole = knownStaff[callerEmail].role;
          userName = knownStaff[callerEmail].name;
        }
      }

      const allowedRoles = ['CUSTODIAN', 'EXECUTIVE'];
      if (!userRole || !allowedRoles.includes(userRole)) {
        throw new HttpsError(
          'permission-denied',
          `คุณไม่มีสิทธิ์แก้ไขการตั้งค่า Gateway (สิทธิ์ปัจจุบัน: ${userRole || 'ไม่พบในระบบ'}, ต้องเป็น CUSTODIAN หรือ EXECUTIVE)`
        );
      }

      const data = request.data || {};
      const updateData = {
        updatedBy: callerEmail,
        updatedAt: FieldValue.serverTimestamp(),
      };

      const provider = data.provider || data.emailProvider;
      if (provider && typeof provider === 'string') {
        updateData.provider = provider.trim();
        updateData.emailProvider = provider.trim();
      }
      if (typeof data.gasWebhookUrl === 'string' && data.gasWebhookUrl.trim() !== '') {
        updateData.gasWebhookUrl = data.gasWebhookUrl.trim();
      }
      if (typeof data.gasSecretToken === 'string' && data.gasSecretToken.trim() !== '') {
        updateData.gasSecretToken = data.gasSecretToken.trim();
      }
      if (typeof data.gasSenderName === 'string' && data.gasSenderName.trim() !== '') {
        updateData.gasSenderName = data.gasSenderName.trim();
      }
      if (typeof data.gasSenderEmail === 'string' && data.gasSenderEmail.trim() !== '') {
        updateData.gasSenderEmail = data.gasSenderEmail.trim();
      }
      if (typeof data.brevoApiKey === 'string' && data.brevoApiKey.trim() !== '') {
        updateData.brevoApiKey = data.brevoApiKey.trim();
      }
      if (typeof data.brevoSenderEmail === 'string' && data.brevoSenderEmail.trim() !== '') {
        updateData.brevoSenderEmail = data.brevoSenderEmail.trim();
      }
      if (typeof data.brevoSenderName === 'string' && data.brevoSenderName.trim() !== '') {
        updateData.brevoSenderName = data.brevoSenderName.trim();
      }
      if (typeof data.resendApiKey === 'string' && data.resendApiKey.trim() !== '') {
        updateData.resendApiKey = data.resendApiKey.trim();
      }
      if (typeof data.resendSender === 'string' && data.resendSender.trim() !== '') {
        updateData.resendSender = data.resendSender.trim();
      }

      // STRICT SANITIZATION: Delete any keys whose value is undefined or null to prevent Firestore crash
      for (const key of Object.keys(updateData)) {
        if (updateData[key] === undefined || updateData[key] === null) {
          delete updateData[key];
        }
      }

      await db.collection('system_settings').doc('gateway_config').set(updateData, { merge: true });

      // Record audit trail
      await db.collection('audit_logs').add({
        action: 'UPDATE_GATEWAY_CONFIG',
        targetId: 'gateway_config',
        details: `Updated gateway configuration (provider: ${provider || 'UNCHANGED'}) via secure server endpoint`,
        actorEmail: callerEmail,
        actorName: userName || callerEmail,
        actorRole: userRole || 'CUSTODIAN',
        timestamp: FieldValue.serverTimestamp(),
      });

      return { success: true };
    } catch (err) {
      if (err instanceof HttpsError) {
        throw err;
      }
      console.error('[updateGatewayConfig] Server error:', err);
      throw new HttpsError(
        'internal',
        `ไม่สามารถบันทึกการตั้งค่า Gateway ได้: ${err.message || 'ระบบขัดข้อง'}`
      );
    }
  }
);

