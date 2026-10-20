import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  updateDoc,
  where,
  limit,
  runTransaction,
  Timestamp,
  type DocumentReference,
  type Firestore,
} from 'firebase/firestore';
import { fb } from './firebase.ts';
import type { AppUser, BorrowRequest, RequestStatus, ReturnCondition, RepairRequest } from './types.ts';
import { escapeHtml, fmtDate, fmtTs, todayStr } from './utils.ts';

export type NotificationType =
  | 'NEW_REQUEST'
  | 'REQUEST_CONFIRMATION'
  | 'REVIEW_PASSED'
  | 'REVIEW_REJECTED'
  | 'APPROVED'
  | 'REJECTED'
  | 'CANCELLED'
  | 'HANDED_OVER'
  | 'REMINDER_DUE_SOON'
  | 'REMINDER_DUE_1D'
  | 'REMINDER_DUE_TODAY'
  | 'REMINDER_OVERDUE'
  | 'REMINDER_STALE_PENDING'
  | 'RETURNED'
  | 'RETURNED_ISSUE'
  | 'RETURNED_WITH_CSAT'
  | 'RETROACTIVE_CSAT_INVITE'
  | 'EXTENSION_REQUESTED'
  | 'EXTENSION_REVIEW_PASSED'
  | 'EXTENSION_REVIEW_REJECTED'
  | 'EXTENSION_APPROVED'
  | 'EXTENSION_REJECTED'
  | 'REPAIR_PENDING_REVIEW'
  | 'REPAIR_APPROVED'
  | 'REPAIR_COMPLETED'
  | 'TEST';

export interface EmailGatewayConfig {
  provider: 'NONE' | 'GOOGLE_APPS_SCRIPT' | 'BREVO' | 'RESEND' | 'MOCK';
  gasWebhookUrl?: string;
  gasSecretToken?: string;
  gasSenderName?: string;
  gasSenderEmail?: string;
  brevoApiKey?: string;
  brevoSenderEmail?: string;
  brevoSenderName?: string;
  resendApiKey?: string;
  resendSender?: string;
}

export type MailJobStatus =
  | 'PENDING'
  | 'PROCESSING'
  | 'SUCCESS'
  | 'FAILED'
  | 'ERROR'
  | 'SKIPPED'
  | 'RECONCILIATION_REQUIRED';

export interface MailJob {
  id?: string;
  to: string[];
  cc?: string[];
  subject?: string;
  text?: string;
  html?: string;
  message: {
    subject: string;
    text: string;
    html: string;
  };
  createdAt: any;
  sentAt?: any;
  status: MailJobStatus;
  errorDetails?: string | null;
  attemptCount?: number;
  maxAttempts?: number;
  nextAttemptAt?: any;
  claimedAt?: any;
  claimedBy?: string;
  requiresReconciliation?: boolean;
  type: NotificationType;
  requestId?: string;
  targetStatus?: RequestStatus | string;
  idempotencyKey?: string;
  senderEmail?: string;
  metadata?: Record<string, any>;
  lastAttemptAt?: any;
  lastErrorAt?: any;
  failedAt?: any;
  messageId?: string;
  retryCount?: number;
  updatedAt?: any;
  retryRequestedAt?: any;
  sweepRequestedAt?: any;
}

/** ตรวจสอบความถูกต้องของ Schema และล้างฟิลด์ undefined ทั้งหมดก่อนบันทึกลง Firestore */
export function validateAndSanitizeMailJob(raw: Partial<MailJob>): MailJob {
  if (!raw.to || !Array.isArray(raw.to) || raw.to.length === 0) {
    throw new Error('Mail job must specify at least one recipient in "to"');
  }
  const cleanTo = raw.to
    .filter((e): e is string => typeof e === 'string' && Boolean(e.trim()))
    .map((e) => e.trim().toLowerCase());
  if (cleanTo.length === 0) {
    throw new Error('No valid recipient email addresses found in "to"');
  }

  if (!raw.message || typeof raw.message.subject !== 'string' || !raw.message.subject.trim()) {
    throw new Error('Mail job must include a non-empty message subject');
  }

  const cleanSubject = raw.message.subject.trim();
  const cleanText = (raw.message.text || '').trim();
  const cleanHtml = (raw.message.html || '').trim();
  const cleanCc = Array.isArray(raw.cc)
    ? raw.cc
        .filter((e): e is string => typeof e === 'string' && Boolean(e.trim()))
        .map((e) => e.trim().toLowerCase())
    : [];

  const cleanJob: MailJob = {
    to: cleanTo,
    cc: cleanCc,
    subject: cleanSubject,
    text: cleanText,
    html: cleanHtml,
    message: {
      subject: cleanSubject,
      text: cleanText,
      html: cleanHtml,
    },
    type: raw.type || 'TEST',
    status: (raw.status as MailJobStatus) || 'PENDING',
    attemptCount: typeof raw.attemptCount === 'number' ? raw.attemptCount : 0,
    maxAttempts: typeof raw.maxAttempts === 'number' ? raw.maxAttempts : 3,
    createdAt: raw.createdAt || serverTimestamp(),
    errorDetails: raw.errorDetails ?? null,
    senderEmail: (raw.senderEmail || '').toLowerCase(),
    idempotencyKey: (raw.idempotencyKey || '').trim(),
  };

  if (raw.requestId) cleanJob.requestId = raw.requestId;
  if (raw.targetStatus) cleanJob.targetStatus = raw.targetStatus;
  if (raw.metadata && typeof raw.metadata === 'object') {
    cleanJob.metadata = Object.fromEntries(
      Object.entries(raw.metadata).filter(([_, v]) => v !== undefined)
    );
  }

  // Ensure absolutely NO key has undefined value
  for (const [k, v] of Object.entries(cleanJob)) {
    if (v === undefined) {
      delete (cleanJob as any)[k];
    }
  }

  return cleanJob;
}

/** คำนวณ Document ID ที่แน่นอนสำหรับ Mail Job ตาม Idempotency Key ป้องกันสร้างงานซ้ำ */
export async function computeMailJobDocId(
  senderEmail: string,
  idempotencyKey: string
): Promise<string> {
  const bytes = new TextEncoder().encode(idempotencyKey);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  return `${senderEmail.toLowerCase()}_${hash}`;
}

/** สร้างงานส่งเพียงครั้งเดียวต่อเหตุการณ์ แม้ผู้ใช้กดซ้ำพร้อมกัน */
export async function createMailJobOnce(
  db: Firestore,
  job: MailJob,
  senderEmail: string
): Promise<{ ref: DocumentReference; created: boolean }> {
  if (!job.idempotencyKey || !senderEmail) {
    return { ref: await addDoc(collection(db, 'mail'), job), created: true };
  }
  const docId = await computeMailJobDocId(senderEmail, job.idempotencyKey);
  const ref = doc(db, 'mail', docId);
  const created = await runTransaction(db, async (tx) => {
    if ((await tx.get(ref)).exists()) return false;
    tx.set(ref, job);
    return true;
  });
  return { ref, created };
}

const APP_URL = 'https://borrowoas.web.app';
const DEFAULT_CUSTODIAN_EMAIL = 'chalpr@kku.ac.th';
const DEFAULT_APPROVER_EMAIL = 'praysu@kku.ac.th';

function baseEmailTemplate(
  title: string,
  badgeText: string,
  contentHtml: string,
  ctaLink?: string,
  ctaText?: string,
  requestId?: string
) {
  if (requestId === 'undefined') {
    throw new Error('baseEmailTemplate: requestId cannot be the string "undefined"');
  }
  const safeTitle = escapeHtml(title);
  const safeBadge = escapeHtml(badgeText);
  const safeReqId = requestId ? escapeHtml(requestId.trim()) : undefined;

  return `
<!DOCTYPE html>
<html lang="th">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${safeTitle}</title>
  <style>
    body { font-family: 'Sarabun', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; margin: 0; padding: 24px; color: #1e293b; }
    .container { max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 16px; overflow: hidden; border: 1px solid #e2e8f0; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05); }
    .header { background: linear-gradient(135deg, #059669 0%, #047857 100%); padding: 28px 32px; color: #ffffff; text-align: left; }
    .header h1 { margin: 0; font-size: 20px; font-weight: 800; letter-spacing: -0.025em; }
    .header p { margin: 6px 0 0; font-size: 13px; color: #a7f3d0; font-weight: 500; }
    .badge { display: inline-block; padding: 4px 12px; border-radius: 9999px; background-color: rgba(255, 255, 255, 0.2); font-size: 11px; font-weight: 700; color: #ffffff; margin-bottom: 12px; text-transform: uppercase; }
    .body { padding: 32px; font-size: 14px; line-height: 1.6; }
    .info-card { background-color: #f8fafc; border-radius: 12px; border: 1px solid #e2e8f0; padding: 20px; margin: 20px 0; }
    .info-row { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px dashed #e2e8f0; font-size: 13px; }
    .info-row:last-child { border-bottom: none; }
    .info-label { color: #64748b; font-weight: 600; }
    .info-value { color: #0f172a; font-weight: 700; text-align: right; }
    .cta-container { text-align: center; margin: 32px 0 16px; }
    .cta-btn { display: inline-block; background-color: #059669; color: #ffffff !important; text-decoration: none; padding: 12px 32px; border-radius: 10px; font-weight: 700; font-size: 14px; box-shadow: 0 2px 4px rgba(5, 150, 105, 0.2); }
    .fallback-link { font-size: 11px; color: #64748b; margin-top: 12px; word-break: break-all; }
    .footer { background-color: #f1f5f9; padding: 20px 32px; font-size: 12px; color: #64748b; text-align: center; border-top: 1px solid #e2e8f0; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="badge">${safeBadge}</div>
      <h1>สำนักบริการวิชาการ มหาวิทยาลัยขอนแก่น</h1>
      <p>ระบบยืม-คืน ครุภัณฑ์และโสตทัศนูปกรณ์ออนไลน์</p>
    </div>
    <div class="body">
      ${contentHtml}
      ${
        ctaLink && ctaText
          ? `
      <div class="cta-container">
        <a href="${ctaLink}" class="cta-btn">${escapeHtml(ctaText)}</a>
        <div class="fallback-link">
          หรือคัดลอกลิงก์นี้เปิดในเบราว์เซอร์: <a href="${ctaLink}" style="color: #059669;">${ctaLink}</a>
        </div>
      </div>
      `
          : ''
      }
    </div>
    <div class="footer">
      ${safeReqId ? `เลขที่คำขออ้างอิง: <b>${safeReqId}</b><br>` : ''}
      อีเมลฉบับนี้เป็นการแจ้งเตือนอัตโนมัติจากระบบ กรุณาอย่าตอบกลับอีเมลนี้<br>
      สำนักบริการวิชาการ มหาวิทยาลัยขอนแก่น (Office of Academic Services, KKU)
    </div>
  </div>
</body>
</html>
`;
}

/** ตรวจสอบและดึง Request ID อย่างปลอดภัย ป้องกัน undefined และค่าว่าง */
export function getRequestId(r: BorrowRequest): string {
  const reqId = r?.id || (r as any)?.requestId;
  if (!reqId || reqId === 'undefined' || typeof reqId !== 'string' || !reqId.trim()) {
    throw new Error('BorrowRequest id is required and cannot be undefined');
  }
  return reqId.trim();
}

/** ส่วนแสดงแบบประเมินความพึงพอใจ 1-Click CSAT ใน Email */
export function csatEmailSection(requestId: string): string {
  if (!requestId || requestId === 'undefined' || typeof requestId !== 'string' || !requestId.trim()) {
    throw new Error('csatEmailSection: requestId is required and cannot be undefined');
  }
  const safeId = escapeHtml(requestId.trim());
  const stars = [
    { star: 1, label: '⭐ 1 ปรับปรุง', bg: '#f8fafc', color: '#475569', border: '#cbd5e1' },
    { star: 2, label: '⭐⭐ 2 พอใช้', bg: '#f8fafc', color: '#475569', border: '#cbd5e1' },
    { star: 3, label: '⭐⭐⭐ 3 ปานกลาง', bg: '#f8fafc', color: '#475569', border: '#cbd5e1' },
    { star: 4, label: '⭐⭐⭐⭐ 4 ดี', bg: '#f0fdf4', color: '#166534', border: '#86efac' },
    { star: 5, label: '⭐⭐⭐⭐⭐ 5 ดีเยี่ยม', bg: '#059669', color: '#ffffff', border: '#047857' },
  ];

  const buttonsHtml = stars
    .map(
      (s) =>
        `<a href="${APP_URL}/request/?id=${safeId}&csat=${s.star}" style="display: inline-block; padding: 10px 14px; margin: 4px; background-color: ${s.bg}; border: 1px solid ${s.border}; border-radius: 8px; text-decoration: none; font-size: 13px; font-weight: 700; color: ${s.color}; box-shadow: 0 1px 2px rgba(0,0,0,0.05);">${s.label}</a>`
    )
    .join('\n');

  return `
    <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 20px; margin: 24px 0; text-align: center;">
      <h3 style="margin: 0 0 6px 0; font-size: 15px; font-weight: 700; color: #0f172a;">🌟 แบบประเมินความพึงพอใจการใช้บริการ (1-Click CSAT)</h3>
      <p style="margin: 0 0 16px 0; font-size: 13px; color: #64748b;">กดเลือกดาวเพื่อส่งคะแนนประเมินได้ทันที:</p>
      <div style="display: inline-block; margin: 0 auto;">
        ${buttonsHtml}
      </div>
      <p style="margin: 14px 0 0; font-size: 11px; color: #94a3b8;">* สามารถให้คะแนนได้เพียง 1 ครั้งเพื่อความถูกต้องของสถิติ</p>
    </div>
  `;
}

export type QueueEmailHandler = (
  job: Omit<MailJob, 'createdAt' | 'status'>,
  customDb?: any
) => Promise<string | null>;

let mockQueueEmailHandler: QueueEmailHandler | null = null;

export function setMockQueueEmailHandler(handler: QueueEmailHandler | null) {
  mockQueueEmailHandler = handler;
}

let mockEmailSettingsHandler: (() => Promise<any>) | null = null;
export function setMockEmailSettingsHandler(handler: (() => Promise<any>) | null) {
  mockEmailSettingsHandler = handler;
}

/** In-memory deduplication cache: prevents duplicate email dispatches within 60s
 *  (Identical architecture to oas-kku-training-system in Desktop/AntiGravity)
 */
const emailDedupMap = new Map<string, number>();
const DEDUP_COOLDOWN_MS = 60 * 1000;

export function clearEmailDedupCache() {
  emailDedupMap.clear();
}

/** ดึงข้อมูลตั้งค่าระบบ Email Policy จาก Firestore (ปลอดภัยสำหรับ Client และรองรับ Spark Free Tier) */
export async function getEmailSettings(customDb?: any): Promise<{
  enabled: boolean;
  gateway: EmailGatewayConfig;
  custodianEmail: string;
  approverEmail: string;
}> {
  if (mockEmailSettingsHandler) {
    return mockEmailSettingsHandler();
  }
  try {
    const db = customDb || fb().db;
    const policySnap = await getDoc(doc(db, 'system_settings', 'policy')).catch(() => null);
    if (policySnap && policySnap.exists()) {
      const pData = policySnap.data();
      return {
        enabled: pData.enableEmailNotifications !== false,
        gateway: {
          provider: pData.emailProvider || 'NONE',
          gasWebhookUrl: pData.gasWebhookUrl || '',
          gasSecretToken: pData.gasSecretToken || '',
          gasSenderName: pData.gasSenderName || 'ระบบยืม-คืน ครุภัณฑ์ สำนักบริการวิชาการ มข.',
          gasSenderEmail: pData.gasSenderEmail || '',
          brevoApiKey: pData.brevoApiKey || '',
          brevoSenderEmail: pData.brevoSenderEmail || 'noreply.oas@kku.ac.th',
          brevoSenderName: pData.brevoSenderName || 'ระบบยืม-คืน ครุภัณฑ์ สำนักบริการวิชาการ มข.',
          resendApiKey: pData.resendApiKey || '',
          resendSender: pData.resendSender || 'ระบบยืม-คืน ครุภัณฑ์ <onboarding@resend.dev>',
        },
        custodianEmail: pData.custodianEmail || DEFAULT_CUSTODIAN_EMAIL,
        approverEmail: pData.approverEmail || DEFAULT_APPROVER_EMAIL,
      };
    }
  } catch (e) {
    console.warn('Failed to read email settings, defaulting to defaults', e);
  }
  return {
    enabled: true,
    gateway: {
      provider: 'NONE',
      gasWebhookUrl: '',
      gasSecretToken: '',
      gasSenderName: 'ระบบยืม-คืน ครุภัณฑ์ สำนักบริการวิชาการ มข.',
      gasSenderEmail: '',
      brevoApiKey: '',
      brevoSenderEmail: 'noreply.oas@kku.ac.th',
      brevoSenderName: 'ระบบยืม-คืน ครุภัณฑ์ สำนักบริการวิชาการ มข.',
      resendApiKey: '',
      resendSender: 'ระบบยืม-คืน ครุภัณฑ์ <onboarding@resend.dev>',
    },
    custodianEmail: DEFAULT_CUSTODIAN_EMAIL,
    approverEmail: DEFAULT_APPROVER_EMAIL,
  };
}

/** ตรวจสอบความถูกต้องของสถานะคำขอก่อนส่ง (Stale Notification Guard) */
export async function validateRequestStatusBeforeSend(
  requestId?: string,
  targetStatus?: string
): Promise<{ valid: boolean; reason?: string }> {
  if (!requestId || !targetStatus) return { valid: true };

  try {
    const { db } = fb();
    const snap = await getDoc(doc(db, 'borrow_requests', requestId));
    if (!snap.exists()) {
      return { valid: false, reason: `ไม่พบคำขอ ${requestId} ในระบบแล้ว` };
    }

    const current = { ...snap.data(), id: snap.id } as BorrowRequest;

    // If targetStatus was specified, ensure it still applies
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
  } catch (err: any) {
    console.warn('Failed to pre-check request status:', err);
  }

  return { valid: true };
}

/** ส่งอีเมลตรงผ่าน Gateway (Direct Client Dispatcher) ไม่ต้องพึ่งพา Cloud Functions / Blaze Plan */
export async function dispatchMailJobDirect(
  docRefOrId: any,
  job: Partial<MailJob>,
  customDb?: any,
  mockFetch?: any
): Promise<{ success: boolean; status: MailJobStatus; message: string; messageId?: string; deduplicated?: boolean }> {
  // 1. Security Check: Header Injection (CRLF) and domain whitelist
  if (/[\r\n]/.test(job.message?.subject || '')) {
    return {
      success: false,
      status: 'FAILED',
      message: 'ตรวจพบอักขระต้องห้าม CRLF (Header Injection) ในหัวข้ออีเมล',
    };
  }

  const cleanSubject = (job.message?.subject || '').trim();
  const validRecipients = (job.to || [])
    .map((e) => (typeof e === 'string' ? e.trim().toLowerCase() : ''))
    .filter((e) => e.includes('@'));

  if (!validRecipients.length) {
    return { success: false, status: 'FAILED', message: 'ไม่มีอีเมลผู้รับที่ถูกต้อง' };
  }

  // 2. Guard: Check in-memory deduplication (60s cooldown)
  const recipientKey = validRecipients.slice().sort().join(',');
  const eventType = job.type || cleanSubject || 'NOTIFICATION';
  const dedupKey = `${job.requestId || 'NO_REQ'}_${eventType}_${recipientKey}`;
  const now = Date.now();
  const lastSentAt = emailDedupMap.get(dedupKey);

  if (lastSentAt && now - lastSentAt < DEDUP_COOLDOWN_MS) {
    const skipMsg = `ตรวจพบอีเมลที่ส่งซ้ำในช่วง 60 วินาที ระบบป้องกันการส่งซ้ำอัตโนมัติ (Deduplicated ด้วย ${dedupKey})`;
    console.log(`[Deduplication Blocked]: ${dedupKey} was sent ${(now - lastSentAt) / 1000}s ago.`);
    if (docRefOrId) {
      try {
        const db = customDb || fb().db;
        const ref = typeof docRefOrId === 'string' ? doc(db, 'mail', docRefOrId) : docRefOrId;
        await updateDoc(ref, {
          status: 'SKIPPED',
          errorDetails: skipMsg,
          updatedAt: serverTimestamp(),
        }).catch(() => {});
      } catch {}
    }
    return {
      success: true,
      status: 'SKIPPED',
      deduplicated: true,
      message: skipMsg,
    };
  }

  // Update in-memory dedup map
  emailDedupMap.set(dedupKey, now);
  if (emailDedupMap.size > 500) {
    emailDedupMap.forEach((timestamp, k) => {
      if (now - timestamp > 3600000) emailDedupMap.delete(k);
    });
  }

  // 3. Get Gateway Settings
  const settings = await getEmailSettings(customDb);
  if (!settings.enabled) {
    if (docRefOrId) {
      try {
        const db = customDb || fb().db;
        const ref = typeof docRefOrId === 'string' ? doc(db, 'mail', docRefOrId) : docRefOrId;
        await updateDoc(ref, {
          status: 'SKIPPED',
          errorDetails: 'ระบบปิดการส่งแจ้งเตือนทางอีเมลไว้',
          updatedAt: serverTimestamp(),
        }).catch(() => {});
      } catch {}
    }
    return { success: true, status: 'SKIPPED', message: 'ระบบปิดการส่งแจ้งเตือนทางอีเมลไว้' };
  }

  // 4. Test Mode & Mock Guard: STRICTLY NO REAL EMAILS SENT DURING TESTING
  const isTestEnv = typeof process !== 'undefined' && (
    process.env.NODE_ENV === 'test' ||
    process.env.ALLOW_MOCK_GATEWAY === 'true' ||
    Boolean(process.env.FIRESTORE_EMULATOR_HOST)
  );
  const isPolicyTestMode = settings.gateway?.provider === 'MOCK' || settings.gateway?.provider === 'NONE';

  const nextAttemptCount = typeof job.attemptCount === 'number' ? job.attemptCount + 1 : 1;

  if (!mockFetch && (isTestEnv || isPolicyTestMode)) {
    const mockId = `mock_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    if (docRefOrId) {
      try {
        const db = customDb || fb().db;
        const ref = typeof docRefOrId === 'string' ? doc(db, 'mail', docRefOrId) : docRefOrId;
        await updateDoc(ref, {
          status: 'SUCCESS',
          sentAt: serverTimestamp(),
          messageId: mockId,
          errorDetails: null,
          attemptCount: nextAttemptCount,
          lastAttemptAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
          metadata: { method: 'MOCK_TEST_DISPATCH', simulated: true },
        }).catch(() => {});
        if (job.type === 'RETROACTIVE_CSAT_INVITE' && job.requestId) {
          await updateDoc(doc(db, 'borrow_requests', job.requestId), {
            surveyInviteStatus: 'SENT',
            surveyInviteSentAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          }).catch(() => {});
        }
      } catch {}
    }
    return {
      success: true,
      status: 'SUCCESS',
      message: 'Processed by Mock/Staging Dispatcher (No actual email sent)',
      messageId: mockId,
    };
  }

  // 5. Google Apps Script Webhook Dispatch
  const provider = settings.gateway?.provider || 'GOOGLE_APPS_SCRIPT';
  const fetchFn = mockFetch || globalThis.fetch;

  if (provider === 'GOOGLE_APPS_SCRIPT') {
    const webhookUrl = settings.gateway?.gasWebhookUrl;
    if (!webhookUrl) {
      const errMsg = 'Google Apps Script Webhook URL ยังไม่ได้ตั้งค่าในระบบ';
      if (docRefOrId) {
        try {
          const db = customDb || fb().db;
          const ref = typeof docRefOrId === 'string' ? doc(db, 'mail', docRefOrId) : docRefOrId;
          await updateDoc(ref, {
            status: 'FAILED',
            errorDetails: errMsg,
            failedAt: serverTimestamp(),
            attemptCount: nextAttemptCount,
            lastAttemptAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          }).catch(() => {});
        } catch {}
      }
      return { success: false, status: 'FAILED', message: errMsg };
    }

    try {
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timeoutId = controller ? setTimeout(() => controller.abort(), 25000) : null;

      const res = await fetchFn(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({
          to: validRecipients,
          cc: job.cc || [],
          subject: cleanSubject,
          html: job.message?.html || '',
          text: job.message?.text || '',
          requestId: job.requestId || '',
          type: job.type || 'NOTIFICATION',
          senderName: settings.gateway?.gasSenderName || 'ระบบยืม-คืน ครุภัณฑ์ สำนักบริการวิชาการ มข.',
          senderEmail: settings.gateway?.gasSenderEmail || '',
          secretToken: settings.gateway?.gasSecretToken || '',
        }),
        signal: controller?.signal,
      }).finally(() => {
        if (timeoutId) clearTimeout(timeoutId);
      });

      if (!res.ok) {
        throw new Error(`HTTP error from GAS: status ${res.status}`);
      }

      const rawText = await res.text();
      let resData: any = {};
      try {
        resData = JSON.parse(rawText);
      } catch {
        resData = { status: 'SUCCESS', message: rawText };
      }

      if (resData && resData.status === 'SUCCESS') {
        const msgId = resData.messageId || `gas_${Date.now()}`;
        if (docRefOrId) {
          try {
            const db = customDb || fb().db;
            const ref = typeof docRefOrId === 'string' ? doc(db, 'mail', docRefOrId) : docRefOrId;
            await updateDoc(ref, {
              status: 'SUCCESS',
              sentAt: serverTimestamp(),
              messageId: msgId,
              errorDetails: null,
              attemptCount: nextAttemptCount,
              lastAttemptAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            }).catch(() => {});
          } catch {}
        }
        if (job.type === 'RETROACTIVE_CSAT_INVITE' && job.requestId) {
          try {
            const db = customDb || fb().db;
            await updateDoc(doc(db, 'borrow_requests', job.requestId), {
              surveyInviteStatus: 'SENT',
              surveyInviteSentAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            }).catch(() => {});
          } catch {}
        }
        return { success: true, status: 'SUCCESS', message: 'Sent successfully via Google Apps Script', messageId: msgId };
      } else {
        const failMsg = resData?.message || 'Gateway returned non-success response';
        if (docRefOrId) {
          try {
            const db = customDb || fb().db;
            const ref = typeof docRefOrId === 'string' ? doc(db, 'mail', docRefOrId) : docRefOrId;
            await updateDoc(ref, {
              status: 'FAILED',
              errorDetails: failMsg,
              failedAt: serverTimestamp(),
              attemptCount: nextAttemptCount,
              lastAttemptAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            }).catch(() => {});
          } catch {}
        }
        return { success: false, status: 'FAILED', message: failMsg };
      }
    } catch (err: any) {
      const errText = `GAS Dispatch Error: ${err.message || 'Network failure'}`;
      if (docRefOrId) {
        try {
          const db = customDb || fb().db;
          const ref = typeof docRefOrId === 'string' ? doc(db, 'mail', docRefOrId) : docRefOrId;
          await updateDoc(ref, {
            status: 'FAILED',
            errorDetails: errText,
            failedAt: serverTimestamp(),
            attemptCount: nextAttemptCount,
            lastAttemptAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          }).catch(() => {});
        } catch {}
      }
      return { success: false, status: 'FAILED', message: errText };
    }
  }

  const unsuppMsg = `Unsupported provider: ${provider}`;
  if (docRefOrId) {
    try {
      const db = customDb || fb().db;
      const ref = typeof docRefOrId === 'string' ? doc(db, 'mail', docRefOrId) : docRefOrId;
      await updateDoc(ref, {
        status: 'FAILED',
        errorDetails: unsuppMsg,
        failedAt: serverTimestamp(),
        attemptCount: nextAttemptCount,
        lastAttemptAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }).catch(() => {});
    } catch {}
  }
  return { success: false, status: 'FAILED', message: unsuppMsg };
}

/** บันทึกคำสั่งส่ง Email เข้า Firestore collection `mail` พร้อม Idempotency และ Direct Dispatch */
export async function queueEmail(
  job: Omit<MailJob, 'createdAt' | 'status'>,
  customDb?: any
): Promise<string | null> {
  if (mockQueueEmailHandler) {
    return mockQueueEmailHandler(job, customDb);
  }
  try {
    const settings = await getEmailSettings(customDb);
    if (!settings.enabled) {
      return null;
    }

    if (job.requestId === 'undefined') {
      throw new Error('queueEmail: job.requestId cannot be the string "undefined"');
    }
    if (job.idempotencyKey?.includes('undefined')) {
      throw new Error(`queueEmail: job.idempotencyKey contains "undefined" (${job.idempotencyKey})`);
    }
    if (job.message?.subject?.includes('undefined')) {
      throw new Error(`queueEmail: job.message.subject contains "undefined" (${job.message.subject})`);
    }

    const db = customDb || fb().db;

    let currentUserEmail = '';
    try {
      currentUserEmail = (fb().auth.currentUser?.email || '').toLowerCase();
    } catch {
      currentUserEmail = '';
    }

    const initialJob: MailJob = validateAndSanitizeMailJob({
      ...job,
      senderEmail: currentUserEmail,
      status: 'PENDING',
      attemptCount: 0,
      maxAttempts: 3,
      createdAt: serverTimestamp(),
      errorDetails: null,
    });

    const { ref: docRef, created } = await createMailJobOnce(db, initialJob, currentUserEmail);

    // If newly created, immediately dispatch via Direct Gateway (No Cloud Functions / Blaze Plan needed)
    if (created) {
      await dispatchMailJobDirect(docRef, initialJob, customDb).catch((e) => {
        console.warn('Background direct dispatch notice:', e);
      });
    }

    return docRef.id;
  } catch (err) {
    console.error('Failed to queue email notification:', err);
    return null;
  }
}

/** ตรวจสอบความพร้อมสำหรับการ Retry งานส่งอีเมล (Guard กันส่งซ้ำ, Backoff, และ Stale Lock) */
export function checkManualRetryEligibility(
  job: Pick<MailJob, 'status' | 'claimedAt' | 'nextAttemptAt' | 'requiresReconciliation' | 'attemptCount' | 'maxAttempts'>,
  nowMs: number = Date.now(),
  allowAdminForce: boolean = false
): { eligible: boolean; reason?: string; message?: string } {
  if (job.status === 'SUCCESS') {
    return { eligible: false, reason: 'ALREADY_SUCCESS', message: 'อีเมลนี้ถูกส่งสำเร็จเรียบร้อยแล้ว' };
  }
  if (job.status === 'PROCESSING') {
    const claimedAtMs = job.claimedAt?.toMillis
      ? job.claimedAt.toMillis()
      : typeof (job.claimedAt as any)?.toDate === 'function'
      ? (job.claimedAt as any).toDate().getTime()
      : typeof job.claimedAt === 'number'
      ? job.claimedAt
      : 0;
    if (nowMs - claimedAtMs < 300000) {
      return {
        eligible: false,
        reason: 'ALREADY_PROCESSING',
        message: 'อีเมลนี้กำลังอยู่ในระหว่างส่งโดยระบบ (PROCESSING) กรุณารอสักครู่',
      };
    }
  }
  if (job.requiresReconciliation || job.status === 'RECONCILIATION_REQUIRED') {
    return {
      eligible: false,
      reason: 'RECONCILIATION_REQUIRED',
      message: 'อีเมลนี้เกิดข้อผิดพลาดไม่แน่ชัด (Indeterminate Error) ต้องตรวจสอบผลการส่งในระบบปลายทางก่อน Retry เพื่อป้องกันส่งซ้ำ',
    };
  }

  // หากเป็นคำขอ retry โดยตรงจาก Admin/Staff ให้ข้ามข้อจำกัด maxAttempts และ backoff timer
  if (allowAdminForce) {
    return { eligible: true };
  }

  const maxAttempts = job.maxAttempts || 3;
  if ((job.attemptCount || 0) >= maxAttempts) {
    return {
      eligible: false,
      reason: 'MAX_ATTEMPTS_EXCEEDED',
      message: `อีเมลนี้พยายามส่งครบกำหนดสูงสุดแล้ว (${maxAttempts} ครั้ง)`,
    };
  }
  if (job.nextAttemptAt) {
    const nextAtMs = job.nextAttemptAt?.toMillis
      ? job.nextAttemptAt.toMillis()
      : typeof (job.nextAttemptAt as any)?.toDate === 'function'
      ? (job.nextAttemptAt as any).toDate().getTime()
      : new Date(job.nextAttemptAt as any).getTime();
    if (nextAtMs > nowMs) {
      return {
        eligible: false,
        reason: 'RETRY_NOT_DUE',
        message: 'คิวส่งยังไม่ถึงกำหนดส่งซ้ำตามช่วงเวลา Backoff',
      };
    }
  }
  return { eligible: true };
}

/** ร้องขอ Retry งานส่งอีเมล โดยส่งผ่าน Direct Webhook Dispatcher ทันที */
export async function retryEmailJob(
  mailDocId: string,
  job: MailJob,
  customDb?: any
): Promise<{ success: boolean; reason?: string; message?: string }> {
  // 1. Pre-check ก่อนดำเนินการ (ใช้ allowAdminForce = true เพื่อให้ retry งาน PENDING / FAILED ได้)
  const preCheck = checkManualRetryEligibility(job, Date.now(), true);
  if (!preCheck.eligible) {
    return {
      success: false,
      reason: preCheck.reason,
      message: preCheck.message,
    };
  }

  const db = customDb || fb().db;
  const mailRef = doc(db, 'mail', mailDocId);

  // 2. เคลียร์ Deduplication Cache เพื่อให้การ Retry ด้วยมือสามารถส่งได้ทันที ไม่ติด 60s cooldown
  clearEmailDedupCache();

  // 3. บันทึก retryRequestedAt เพื่อเป็นสัญญาณ audit trail
  await updateDoc(mailRef, {
    retryRequestedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }).catch(() => {});

  // 4. ส่งผ่าน Direct Dispatcher และรอผลจริง (Client / Webhook Worker Architecture)
  try {
    const res = await dispatchMailJobDirect(mailRef, job, customDb);
    if (res.status === 'SUCCESS') {
      return { success: true, message: 'ส่งอีเมลซ้ำ (Retry) สำเร็จเรียบร้อยแล้ว' };
    } else if (res.status === 'SKIPPED') {
      return { success: true, message: `การส่งซ้ำถูกข้าม: ${res.message}` };
    } else {
      return { success: false, reason: 'DISPATCH_FAILED', message: res.message || 'เกิดข้อผิดพลาดในการส่งซ้ำผ่าน Gateway' };
    }
  } catch (err: any) {
    return { success: false, reason: 'DISPATCH_ERROR', message: err.message || 'เกิดข้อผิดพลาดในการส่งซ้ำ' };
  }
}

/* ------------------------------------------------------------------ */
/* 1) แจ้งเตือนเมื่อมีการยื่นคำขอใหม่                                         */
/* ------------------------------------------------------------------ */
export async function notifyNewBorrowRequest(r: BorrowRequest, customDb?: any) {
  const reqId = getRequestId(r);
  const settings = await getEmailSettings(customDb);
  const custodianEmail = settings.custodianEmail || DEFAULT_CUSTODIAN_EMAIL;

  const link = `${APP_URL}/review/`;
  const html = `
    <h2 style="font-size: 16px; font-weight: 700; color: #0f172a; margin-top: 0;">เรียน ผู้ดูแลพัสดุ/ครุภัณฑ์ (${custodianEmail}),</h2>
    <p>มีคำขอยืมครุภัณฑ์ฉบับใหม่ถูกส่งเข้ามาในระบบ กรุณาตรวจสอบความพร้อมของอุปกรณ์และช่วงวันยืมในระบบ:</p>
    <div class="info-card">
      <div class="info-row"><span class="info-label">เลขที่คำขอ:</span><span class="info-value">${reqId}</span></div>
      <div class="info-row"><span class="info-label">ผู้ขอยืม:</span><span class="info-value">${r.borrower.name} (${r.borrower.position})</span></div>
      <div class="info-row"><span class="info-label">สังกัดกลุ่มงาน:</span><span class="info-value">${r.borrower.mission || r.borrower.division || '-'}</span></div>
      <div class="info-row"><span class="info-label">รายการครุภัณฑ์:</span><span class="info-value">${r.equipment.name}</span></div>
      <div class="info-row"><span class="info-label">รหัสครุภัณฑ์:</span><span class="info-value">${r.equipment.assetNumber || '-'}</span></div>
      <div class="info-row"><span class="info-label">กำหนดวันยืม:</span><span class="info-value">${fmtDate(r.startDate)} ถึง ${fmtDate(r.expectedReturnDate)}${r.durationDays ? ` (${r.durationDays} วัน)` : ''}</span></div>
      <div class="info-row"><span class="info-label">วัตถุประสงค์:</span><span class="info-value">${r.purpose}</span></div>
      <div class="info-row"><span class="info-label">สถานที่นำไปใช้:</span><span class="info-value">${r.location || '-'}</span></div>
    </div>
  `;

  // 1.1 ส่งถึงผู้ดูแลพัสดุ (ผู้ตรวจสอบขั้น 1)
  await queueEmail({
    to: [custodianEmail],
    type: 'NEW_REQUEST',
    requestId: reqId,
    targetStatus: 'PENDING_REVIEW',
    idempotencyKey: `${reqId}_NEW_REQUEST_${custodianEmail}`,
    message: {
      subject: `[รอตรวจสอบ] มีคำขอยืมครุภัณฑ์ใหม่: ${reqId} (${r.equipment.name})`,
      text: `มีคำขอยืมครุภัณฑ์ใหม่ ${reqId} โดย ${r.borrower.name} กรุณาเข้าสู่ระบบเพื่อตรวจสอบ: ${link}`,
      html: baseEmailTemplate(
        `มีคำขอยืมครุภัณฑ์ใหม่ ${reqId}`,
        'รอตรวจสอบ (ขั้นที่ 1)',
        html,
        link,
        'เข้าสู่ระบบเพื่อตรวจสอบคำขอ',
        reqId
      ),
    },
  }, customDb);

  // 1.2 ส่งยืนยันถึงผู้ยื่นคำขอ
  const borrowerLink = `${APP_URL}/request/?id=${reqId}`;
  const borrowerHtml = `
    <h2 style="font-size: 16px; font-weight: 700; color: #0f172a; margin-top: 0;">เรียนคุณ ${r.borrower.name},</h2>
    <p>ระบบได้รับคำขอยืมครุภัณฑ์ของท่านเรียบร้อยแล้ว ขณะนี้คำขอกำลังอยู่ในขั้นตอน <b>รอการตรวจสอบความพร้อมของอุปกรณ์ (ขั้นที่ 1)</b> โดยเจ้าหน้าที่พัสดุ</p>
    <div class="info-card">
      <div class="info-row"><span class="info-label">เลขที่คำขอ:</span><span class="info-value">${reqId}</span></div>
      <div class="info-row"><span class="info-label">รายการครุภัณฑ์:</span><span class="info-value">${r.equipment.name}</span></div>
      <div class="info-row"><span class="info-label">กำหนดวันยืม:</span><span class="info-value">${fmtDate(r.startDate)} ถึง ${fmtDate(r.expectedReturnDate)}</span></div>
      <div class="info-row"><span class="info-label">สถานะปัจจุบัน:</span><span class="info-value" style="color: #d97706;">รอตรวจสอบ (Step 1)</span></div>
    </div>
  `;

  // ผู้ดูแลที่ยืมเองได้รับเมลให้ตรวจแล้ว ไม่ต้องรับสำเนายืนยันอีกฉบับ
  if (custodianEmail.toLowerCase() !== r.borrower.email.toLowerCase()) await queueEmail({
    to: [r.borrower.email],
    type: 'REQUEST_CONFIRMATION',
    requestId: reqId,
    idempotencyKey: `${reqId}_REQUEST_CONFIRMATION_${r.borrower.email}`,
    message: {
      subject: `[รับคำขอแล้ว] ระบบได้รับคำขอยืมครุภัณฑ์ ${reqId} (${r.equipment.name}) เรียบร้อยแล้ว`,
      text: `ระบบได้รับคำขอยืมครุภัณฑ์ ${reqId} ของท่านเรียบร้อยแล้ว ติดตามสถานะได้ที่: ${borrowerLink}`,
      html: baseEmailTemplate(
        `ยืนยันการส่งคำขอยืม ${reqId}`,
        'ได้รับคำขอแล้ว',
        borrowerHtml,
        borrowerLink,
        'ติดตามสถานะคำขอยืม',
        reqId
      ),
    },
  }, customDb);
}

/* ------------------------------------------------------------------ */
/* 2) แจ้งเตือนเมื่อผ่านการตรวจสอบขั้นที่ 1 (ส่งหาผู้อนุมัติ)                   */
/* ------------------------------------------------------------------ */
export async function notifyReviewPassed(r: BorrowRequest, customDb?: any) {
  const reqId = getRequestId(r);
  const settings = await getEmailSettings(customDb);
  const approverEmail = settings.approverEmail || DEFAULT_APPROVER_EMAIL;

  const link = `${APP_URL}/approve/`;
  const html = `
    <h2 style="font-size: 16px; font-weight: 700; color: #0f172a; margin-top: 0;">เรียน ผู้อนุมัติคำขอ (${approverEmail}),</h2>
    <p>มีคำขอยืมครุภัณฑ์ที่ผ่านการตรวจสอบความพร้อมและคิวจองจาก <b>เจ้าหน้าที่พัสดุ</b> แล้ว รอให้ท่านพิจารณาอนุมัติ:</p>
    <div class="info-card">
      <div class="info-row"><span class="info-label">เลขที่คำขอ:</span><span class="info-value">${reqId}</span></div>
      <div class="info-row"><span class="info-label">ผู้ขอยืม:</span><span class="info-value">${r.borrower.name} (${r.borrower.position})</span></div>
      <div class="info-row"><span class="info-label">รายการครุภัณฑ์:</span><span class="info-value">${r.equipment.name}</span></div>
      <div class="info-row"><span class="info-label">กำหนดวันยืม:</span><span class="info-value">${fmtDate(r.startDate)} ถึง ${fmtDate(r.expectedReturnDate)}${r.durationDays ? ` (${r.durationDays} วัน)` : ''}</span></div>
      <div class="info-row"><span class="info-label">วัตถุประสงค์:</span><span class="info-value">${r.purpose}</span></div>
      <div class="info-row"><span class="info-label">ผลการตรวจขั้นที่ 1:</span><span class="info-value" style="color: #16a34a;">ผ่านการตรวจสอบความพร้อม</span></div>
    </div>
  `;

  await queueEmail({
    to: [approverEmail],
    type: 'REVIEW_PASSED',
    requestId: reqId,
    targetStatus: 'PENDING_APPROVAL',
    idempotencyKey: `${reqId}_REVIEW_PASSED_${approverEmail}`,
    message: {
      subject: `[รออนุมัติ] คำขอยืมครุภัณฑ์ผ่านการตรวจสอบแล้ว: ${reqId} (${r.equipment.name})`,
      text: `คำขอยืม ${reqId} ผ่านการตรวจสอบแล้ว รอการพิจารณาอนุมัติ: ${link}`,
      html: baseEmailTemplate(
        `คำขอยืมผ่านการตรวจขั้นที่ 1: ${reqId}`,
        'รออนุมัติ (ขั้นที่ 2)',
        html,
        link,
        'เข้าสู่ระบบเพื่อพิจารณาอนุมัติคำขอ',
        reqId
      ),
    },
  }, customDb);
}

/* ------------------------------------------------------------------ */
/* 3) แจ้งเตือนเมื่อไม่ผ่านการตรวจขั้นที่ 1 (แจ้งผู้ยื่น)                    */
/* ------------------------------------------------------------------ */
export async function notifyReviewRejected(r: BorrowRequest, reason?: string, customDb?: any) {
  const reqId = getRequestId(r);
  const link = `${APP_URL}/request/?id=${reqId}`;
  const html = `
    <h2 style="font-size: 16px; font-weight: 700; color: #0f172a; margin-top: 0;">เรียนคุณ ${r.borrower.name},</h2>
    <p>คำขอยืมครุภัณฑ์เลขที่ <b>${reqId}</b> <b>ไม่ผ่านการตรวจสอบความพร้อม</b> โดยเจ้าหน้าที่พัสดุ</p>
    <div class="info-card">
      <div class="info-row"><span class="info-label">เลขที่คำขอ:</span><span class="info-value">${reqId}</span></div>
      <div class="info-row"><span class="info-label">รายการครุภัณฑ์:</span><span class="info-value">${r.equipment.name}</span></div>
      <div class="info-row"><span class="info-label">เหตุผลประกอบ:</span><span class="info-value" style="color: #dc2626;">${reason || 'อุปกรณ์ไม่พร้อมใช้งาน หรือช่วงเวลาทับซ้อน'}</span></div>
    </div>
  `;

  await queueEmail({
    to: [r.borrower.email],
    type: 'REVIEW_REJECTED',
    requestId: reqId,
    idempotencyKey: `${reqId}_REVIEW_REJECTED_${r.borrower.email}`,
    message: {
      subject: `[แจ้งผล] คำขอยืมครุภัณฑ์ ${reqId} ไม่ผ่านการตรวจสอบ`,
      text: `คำขอยืมครุภัณฑ์ ${reqId} ไม่ผ่านการตรวจสอบ เหตุผล: ${reason || '-'} ดูรายละเอียด: ${link}`,
      html: baseEmailTemplate(
        `ผลการตรวจสอบคำขอยืม ${reqId}`,
        'ไม่ผ่านการตรวจสอบ',
        html,
        link,
        'ดูรายละเอียดคำขอ',
        reqId
      ),
    },
  }, customDb);
}

/* ------------------------------------------------------------------ */
/* 4) แจ้งเตือนผลการอนุมัติขั้นที่ 2 (อนุมัติ / ไม่อนุมัติ)                 */
/* ------------------------------------------------------------------ */
export async function notifyApprovalResult(r: BorrowRequest, approved: boolean, comment?: string, customDb?: any) {
  const reqId = getRequestId(r);
  const link = `${APP_URL}/request/?id=${reqId}`;
  const settings = await getEmailSettings(customDb);
  const custodianEmail = settings.custodianEmail || DEFAULT_CUSTODIAN_EMAIL;

  if (approved) {
    const html = `
      <h2 style="font-size: 16px; font-weight: 700; color: #0f172a; margin-top: 0;">เรียนคุณ ${r.borrower.name},</h2>
      <p>คำขอยืมครุภัณฑ์เลขที่ <b>${reqId}</b> ได้รับการ <b>อนุมัติเรียบร้อยแล้ว</b></p>
      <div class="info-card">
        <div class="info-row"><span class="info-label">เลขที่คำขอ:</span><span class="info-value">${reqId}</span></div>
        <div class="info-row"><span class="info-label">รายการครุภัณฑ์:</span><span class="info-value">${r.equipment.name}</span></div>
        <div class="info-row"><span class="info-label">กำหนดรับอุปกรณ์:</span><span class="info-value">${fmtDate(r.startDate)}</span></div>
        <div class="info-row"><span class="info-label">กำหนดส่งคืน:</span><span class="info-value">${fmtDate(r.expectedReturnDate)}</span></div>
        ${comment ? `<div class="info-row"><span class="info-label">ความเห็นผู้อนุมัติ:</span><span class="info-value">${comment}</span></div>` : ''}
      </div>
      <p style="background-color: #f0fdf4; border: 1px solid #bbf7d0; padding: 12px; border-radius: 8px; font-size: 13px; color: #166534;">
        📌 <b>ขั้นตอนต่อไป:</b> กรุณาติดต่อรับครุภัณฑ์กับ <b>เจ้าหน้าที่พัสดุ</b> ณ สำนักงานกองบริหารงานสำนักบริการวิชาการ ในวันและเวลาที่กำหนด พร้อมแสดงบัตรยืมดิจิทัล (Digital Loan Pass) จากระบบ
      </p>
    `;

    await queueEmail({
      to: [r.borrower.email],
      cc: [custodianEmail],
      type: 'APPROVED',
      requestId: reqId,
      targetStatus: 'APPROVED_WAITING_PICKUP',
      idempotencyKey: `${reqId}_APPROVED_${r.borrower.email}`,
      message: {
        subject: `[อนุมัติแล้ว] คำขอยืมครุภัณฑ์ ${reqId} (${r.equipment.name}) ได้รับการอนุมัติแล้ว`,
        text: `คำขอยืม ${reqId} ได้รับการอนุมัติแล้ว กรุณาติดต่อรับอุปกรณ์ตามกำหนด: ${link}`,
        html: baseEmailTemplate(
          `คำขอยืม ${reqId} ได้รับการอนุมัติแล้ว`,
          'อนุมัติเรียบร้อย',
          html,
          link,
          'ดูใบคำขอและบัตรดิจิทัล',
          reqId
        ),
      },
    }, customDb);
  } else {
    const html = `
      <h2 style="font-size: 16px; font-weight: 700; color: #0f172a; margin-top: 0;">เรียนคุณ ${r.borrower.name},</h2>
      <p>คำขอยืมครุภัณฑ์เลขที่ <b>${reqId}</b> <b>ไม่ได้รับการอนุมัติ</b></p>
      <div class="info-card">
        <div class="info-row"><span class="info-label">เลขที่คำขอ:</span><span class="info-value">${reqId}</span></div>
        <div class="info-row"><span class="info-label">รายการครุภัณฑ์:</span><span class="info-value">${r.equipment.name}</span></div>
        <div class="info-row"><span class="info-label">เหตุผล/ความเห็น:</span><span class="info-value" style="color: #dc2626;">${comment || 'เนื่องจากติดภารกิจสำคัญของสำนักฯ'}</span></div>
      </div>
    `;

    await queueEmail({
      to: [r.borrower.email],
      type: 'REJECTED',
      requestId: reqId,
      idempotencyKey: `${reqId}_REJECTED_${r.borrower.email}`,
      message: {
        subject: `[แจ้งผล] คำขอยืมครุภัณฑ์ ${reqId} ไม่ได้รับการอนุมัติ`,
        text: `คำขอยืม ${reqId} ไม่ได้รับการอนุมัติ ความเห็น: ${comment || '-'} ดูรายละเอียด: ${link}`,
        html: baseEmailTemplate(
          `ผลการพิจารณาคำขอยืม ${reqId}`,
          'ไม่อนุมัติ',
          html,
          link,
          'ดูรายละเอียดคำขอ',
          reqId
        ),
      },
    }, customDb);
  }
}

/* ------------------------------------------------------------------ */
/* 5) แจ้งเตือนเมื่อส่งมอบอุปกรณ์แล้ว (Handed Over)                       */
/* ------------------------------------------------------------------ */
export async function notifyHandedOver(
  r: BorrowRequest,
  accessories: string[],
  conditionNote: string,
  customDb?: any
) {
  const reqId = getRequestId(r);
  const link = `${APP_URL}/request/?id=${reqId}`;
  const accList = Array.isArray(accessories) ? accessories : [];
  const html = `
    <h2 style="font-size: 16px; font-weight: 700; color: #0f172a; margin-top: 0;">เรียนคุณ ${r.borrower.name},</h2>
    <p>ท่านได้รับมอบครุภัณฑ์เลขที่ <b>${reqId}</b> เรียบร้อยแล้ว ขณะนี้สถานะคือ <b>อยู่ระหว่างการใช้งาน (In Use)</b></p>
    <div class="info-card">
      <div class="info-row"><span class="info-label">เลขที่คำขอ:</span><span class="info-value">${reqId}</span></div>
      <div class="info-row"><span class="info-label">รายการครุภัณฑ์:</span><span class="info-value">${r.equipment.name}</span></div>
      <div class="info-row"><span class="info-label">อุปกรณ์เสริมที่ได้รับ:</span><span class="info-value">${accList.length ? accList.join(', ') : 'ไม่มีอุปกรณ์เสริม'}</span></div>
      <div class="info-row"><span class="info-label">สภาพก่อนส่งมอบ:</span><span class="info-value">${conditionNote || 'สภาพสมบูรณ์'}</span></div>
      <div class="info-row"><span class="info-label">กำหนดส่งคืน:</span><span class="info-value" style="color: #b91c1c; font-weight: 800;">${fmtDate(r.expectedReturnDate)}</span></div>
    </div>
    <p style="background-color: #eff6ff; border: 1px solid #bfdbfe; padding: 12px; border-radius: 8px; font-size: 13px; color: #1e40af;">
      📌 <b>คำเตือนและข้อปฏิบัติ:</b> โปรดดูแลรักษาครุภัณฑ์ให้อยู่ในสภาพสมบูรณ์ และส่งคืนตรงตามเวลาที่กำหนด หากต้องการส่งคืนก่อนกำหนดสามารถติดต่อเจ้าหน้าที่พัสดุได้ทันที
    </p>
  `;

  await queueEmail({
    to: [r.borrower.email],
    type: 'HANDED_OVER',
    requestId: reqId,
    targetStatus: 'IN_USE',
    idempotencyKey: `${reqId}_HANDED_OVER_${r.borrower.email}`,
    message: {
      subject: `[รับมอบแล้ว] บันทึกส่งมอบครุภัณฑ์ ${reqId} (${r.equipment.name}) เรียบร้อยแล้ว`,
      text: `ท่านได้รับมอบครุภัณฑ์ ${reqId} เรียบร้อยแล้ว กำหนดส่งคืน ${fmtDate(r.expectedReturnDate)}: ${link}`,
      html: baseEmailTemplate(
        `บันทึกส่งมอบครุภัณฑ์ ${reqId}`,
        'ส่งมอบเรียบร้อย',
        html,
        link,
        'ดูบันทึกและรายละเอียด',
        reqId
      ),
    },
  }, customDb);
}

/* ------------------------------------------------------------------ */
/* 6) แจ้งเตือนเมื่อมีการยกเลิกคำขอ                                        */
/* ------------------------------------------------------------------ */
export async function notifyCancelled(r: BorrowRequest, canceller: AppUser, reason: string, customDb?: any) {
  const reqId = getRequestId(r);
  const link = `${APP_URL}/request/?id=${reqId}`;
  const settings = await getEmailSettings(customDb);
  const custodianEmail = settings.custodianEmail || DEFAULT_CUSTODIAN_EMAIL;

  const html = `
    <h2 style="font-size: 16px; font-weight: 700; color: #0f172a; margin-top: 0;">เรียนผู้เกี่ยวข้อง,</h2>
    <p>คำขอยืมครุภัณฑ์เลขที่ <b>${reqId}</b> ได้รับการ <b>ยกเลิกคำขอ</b> เรียบร้อยแล้ว</p>
    <div class="info-card">
      <div class="info-row"><span class="info-label">เลขที่คำขอ:</span><span class="info-value">${reqId}</span></div>
      <div class="info-row"><span class="info-label">รายการครุภัณฑ์:</span><span class="info-value">${r.equipment.name}</span></div>
      <div class="info-row"><span class="info-label">ผู้ขอยยกเลิก:</span><span class="info-value">${canceller.name} (${canceller.position})</span></div>
      <div class="info-row"><span class="info-label">เหตุผลการยกเลิก:</span><span class="info-value" style="color: #64748b;">${reason || 'ผู้ยืมขอยกเลิกรายการ'}</span></div>
      <div class="info-row"><span class="info-label">เวลาที่ยกเลิก:</span><span class="info-value">${new Date().toLocaleString('th-TH')}</span></div>
    </div>
  `;

  await queueEmail({
    to: [r.borrower.email, custodianEmail],
    type: 'CANCELLED',
    requestId: reqId,
    idempotencyKey: `${reqId}_CANCELLED`,
    message: {
      subject: `[ยกเลิกคำขอ] คำขอยืมครุภัณฑ์ ${reqId} (${r.equipment.name}) ถูกยกเลิกแล้ว`,
      text: `คำขอยืม ${reqId} ได้รับการยกเลิก เหตุผล: ${reason || '-'} ดูรายละเอียด: ${link}`,
      html: baseEmailTemplate(
        `คำขอยืม ${reqId} ถูกยกเลิก`,
        'ยกเลิกคำขอแล้ว',
        html,
        link,
        'ดูรายละเอียดคำขอ',
        reqId
      ),
    },
  }, customDb);
}

/* ------------------------------------------------------------------ */
/* 7) แจ้งเตือนเมื่อตรวจรับคืนครุภัณฑ์เสร็จสิ้น                               */
/* ------------------------------------------------------------------ */
export async function notifyReturned(
  r: BorrowRequest,
  condition: ReturnCondition,
  remarks?: string,
  customDb?: any
) {
  const reqId = getRequestId(r);
  const link = `${APP_URL}/request/?id=${reqId}`;
  const settings = await getEmailSettings(customDb);
  const custodianEmail = settings.custodianEmail || DEFAULT_CUSTODIAN_EMAIL;

  const isIssue = condition !== 'NORMAL';
  const conditionLabel =
    condition === 'NORMAL'
      ? 'สภาพปกติครบถ้วนสมบูรณ์'
      : condition === 'DAMAGED'
      ? 'พบความเสียหาย / ชำรุด'
      : 'สูญหาย';

  const html = `
    <h2 style="font-size: 16px; font-weight: 700; color: #0f172a; margin-top: 0;">เรียนคุณ ${r.borrower.name},</h2>
    <p>ท่านได้ทำการส่งคืนครุภัณฑ์เลขที่ <b>${reqId}</b> เรียบร้อยแล้ว</p>
    <div class="info-card">
      <div class="info-row"><span class="info-label">เลขที่คำขอ:</span><span class="info-value">${reqId}</span></div>
      <div class="info-row"><span class="info-label">รายการครุภัณฑ์:</span><span class="info-value">${r.equipment.name}</span></div>
      <div class="info-row"><span class="info-label">สภาพการตรวจรับ:</span><span class="info-value" style="color: ${isIssue ? '#dc2626' : '#16a34a'}; font-weight: 700;">${conditionLabel}</span></div>
      ${remarks ? `<div class="info-row"><span class="info-label">บันทึกเพิ่มเติม:</span><span class="info-value">${remarks}</span></div>` : ''}
      <div class="info-row"><span class="info-label">วันที่ส่งคืน:</span><span class="info-value">${todayStr()}</span></div>
    </div>
    ${
      isIssue
        ? `
    <p style="background-color: #fef2f2; border: 1px solid #fecaca; padding: 12px; border-radius: 8px; font-size: 13px; color: #991b1b;">
      ⚠️ <b>หมายเหตุความรับผิดชอบ:</b> เนื่องจากครุภัณฑ์ตรวจรับในสภาพ${conditionLabel} เจ้าหน้าที่พัสดุจะดำเนินการประสานงานตามระเบียบกระทรวงการคลังว่าด้วยการบริหารพัสดุภาครัฐ พ.ศ. 2560 ต่อไป
    </p>
    `
        : `
    <p style="color: #166534; font-weight: 600; text-align: center;">ขอขอบคุณที่ใช้บริการและดูแลรักษาครุภัณฑ์ของสำนักบริการวิชาการ</p>
    `
    }
    ${csatEmailSection(reqId)}
  `;

  await queueEmail({
    to: [r.borrower.email],
    cc: isIssue ? [custodianEmail] : undefined,
    type: isIssue ? 'RETURNED_ISSUE' : 'RETURNED_WITH_CSAT',
    requestId: reqId,
    idempotencyKey: `${reqId}_RETURNED_${r.borrower.email}`,
    message: {
      subject: `[ส่งคืนสำเร็จ] ได้รับคืนครุภัณฑ์ ${reqId} (${r.equipment.name}) ${isIssue ? '— มีบันทึกเพิ่มเติม' : 'เรียบร้อยแล้ว'} พร้อมแบบประเมินความพึงพอใจ`,
      text: `ท่านได้ส่งคืนครุภัณฑ์ ${reqId} เรียบร้อยแล้ว สภาพ: ${conditionLabel} ร่วมประเมินความพึงพอใจได้ที่: ${link}`,
      html: baseEmailTemplate(
        `การส่งคืนครุภัณฑ์ ${reqId}`,
        isIssue ? 'ส่งคืน (พบข้อสังเกต)' : 'ส่งคืนเรียบร้อย',
        html,
        link,
        'ดูบันทึกและประเมินบริการ',
        reqId
      ),
    },
  }, customDb);
}

/** ฟังก์ชันส่งเมลรับคืนพร้อมแบบประเมิน CSAT (Alias เพื่อความชัดเจนในโค้ด) */
export async function notifyReturnedWithCsat(
  r: BorrowRequest,
  condition: ReturnCondition,
  remarks?: string,
  customDb?: any
) {
  return notifyReturned(r, condition, remarks, customDb);
}

/**
 * สร้างข้อมูลโครงสร้างอีเมลสำหรับเชิญตอบแบบสอบถาม CSAT ย้อนหลัง
 */
export function buildRetroactiveCsatEmail(
  r: BorrowRequest,
  inviteNumber: number = 1
): Omit<MailJob, 'createdAt' | 'status'> {
  const reqId = getRequestId(r);
  const link = `${APP_URL}/request/?id=${reqId}`;
  const isResend = inviteNumber > 1;
  const equipName = r.equipment?.name || 'ครุภัณฑ์';
  const borrowerName = r.borrower?.name || 'ผู้ยืม';
  const subject = isResend
    ? `[เตือนส่งแบบประเมิน] ความพึงพอใจการยืมครุภัณฑ์ ${reqId} (${equipName})`
    : `[ขอความอนุเคราะห์ประเมิน] ความพึงพอใจการยืมครุภัณฑ์ ${reqId} (${equipName})`;

  const html = `
    <h2 style="font-size: 16px; font-weight: 700; color: #0f172a; margin-top: 0;">เรียนคุณ ${borrowerName},</h2>
    <p>สำนักบริการวิชาการ มหาวิทยาลัยขอนแก่น ขอขอบพระคุณที่ท่านได้ใช้บริการระบบยืม-คืน ครุภัณฑ์และโสตทัศนูปกรณ์ (คำขอเลขที่ <b>${reqId}</b>: ${equipName})</p>
    <p>เพื่อนำความคิดเห็นและข้อเสนอแนะของท่านไปพัฒนาคุณภาพการให้บริการให้ดียิ่งขึ้น ขอความอนุเคราะห์ท่านสละเวลาสั้นๆ เพียง 30 วินาที เพื่อประเมินความพึงพอใจการใช้บริการ</p>

    ${csatEmailSection(reqId)}

    <div class="info-card">
      <div class="info-row"><span class="info-label">เลขที่คำขอ:</span><span class="info-value">${reqId}</span></div>
      <div class="info-row"><span class="info-label">รายการครุภัณฑ์:</span><span class="info-value">${equipName}</span></div>
      <div class="info-row"><span class="info-label">วันที่ส่งคืน:</span><span class="info-value">${r.returnInfo?.actualReturnDate ? fmtDate(r.returnInfo.actualReturnDate) : '-'}</span></div>
    </div>
  `;

  const idempotencyKey =
    inviteNumber <= 1
      ? `${reqId}_RETROACTIVE_CSAT`
      : `${reqId}_RETROACTIVE_CSAT_RESEND_${inviteNumber}`;

  return {
    to: [r.borrower.email],
    cc: [],
    type: 'RETROACTIVE_CSAT_INVITE',
    requestId: reqId,
    idempotencyKey,
    message: {
      subject,
      text: `ขอความอนุเคราะห์ประเมินความพึงพอใจการยืมครุภัณฑ์ ${reqId} (${equipName}) คลิกเพื่อประเมิน: ${link}`,
      html: baseEmailTemplate(
        `ประเมินความพึงพอใจคำขอ ${reqId}`,
        isResend ? 'เตือนแบบประเมินความพึงพอใจ' : 'แบบประเมินความพึงพอใจ',
        html,
        link,
        'เข้าสู่หน้าประเมินความพึงพอใจ',
        reqId
      ),
    },
  };
}

/**
 * ส่งอีเมลเชิญผู้ยืมในอดีต (ที่ส่งคืนแล้วแต่ยังไม่ได้ประเมิน) ตอบแบบประเมินความพึงพอใจย้อนหลัง
 */
export async function notifyRetroactiveCsatInvite(
  r: BorrowRequest,
  customDb?: any,
  inviteNumber: number = 1
): Promise<string | null> {
  const emailJob = buildRetroactiveCsatEmail(r, inviteNumber);
  return queueEmail(emailJob, customDb);
}

/* ------------------------------------------------------------------ */
/* 8) แจ้งเตือนกำหนดคืน (ใกล้ครบ / ครบกำหนดวันนี้ / เกินกำหนด)               */
/* ------------------------------------------------------------------ */
export async function notifyDueReminder(
  r: BorrowRequest,
  reminderType: 'SOON' | 'TODAY' | 'OVERDUE',
  daysDiff: number = 0,
  customDb?: any
) {
  const reqId = getRequestId(r);
  const link = `${APP_URL}/request/?id=${reqId}`;
  const settings = await getEmailSettings(customDb);
  const custodianEmail = settings.custodianEmail || DEFAULT_CUSTODIAN_EMAIL;
  const today = todayStr();

  let subject = '';
  let badge = '';
  let bodyText = '';
  let notifType: NotificationType = 'REMINDER_DUE_SOON';

  if (reminderType === 'SOON') {
    notifType = daysDiff === 1 ? 'REMINDER_DUE_1D' : 'REMINDER_DUE_SOON';
    badge = daysDiff === 1 ? 'ครบกำหนดคืนพรุ่งนี้ (อีก 1 วัน)' : `ใกล้ครบกำหนดคืน (อีก ${daysDiff} วัน)`;
    subject = daysDiff === 1
      ? `[เตือนก่อนครบกำหนด 1 วัน] ครุภัณฑ์ ${reqId} (${r.equipment.name}) ครบกำหนดส่งคืนพรุ่งนี้`
      : `[แจ้งเตือน] ครุภัณฑ์ ${reqId} (${r.equipment.name}) ใกล้ครบกำหนดคืนในอีก ${daysDiff} วัน`;
    bodyText = `
      <h2 style="font-size: 16px; font-weight: 700; color: #0f172a; margin-top: 0;">เรียนคุณ ${r.borrower.name},</h2>
      <p>ขอแจ้งเตือนว่าครุภัณฑ์เลขที่ <b>${reqId}</b> ของท่านกำลังจะครบกำหนดส่งคืนในวันที่ <b>${fmtDate(r.expectedReturnDate)}</b> (${daysDiff === 1 ? 'วันพรุ่งนี้' : `อีก ${daysDiff} วัน`})</p>
      <div class="info-card">
        <div class="info-row"><span class="info-label">เลขที่คำขอ:</span><span class="info-value">${reqId}</span></div>
        <div class="info-row"><span class="info-label">รายการครุภัณฑ์:</span><span class="info-value">${r.equipment.name}</span></div>
        <div class="info-row"><span class="info-label">กำหนดส่งคืน:</span><span class="info-value" style="color: #d97706; font-weight: 700;">${fmtDate(r.expectedReturnDate)} (${daysDiff === 1 ? 'พรุ่งนี้' : `อีก ${daysDiff} วัน`})</span></div>
      </div>
      <p style="font-size: 13px; color: #475569;">กรุณาเตรียมอุปกรณ์และอุปกรณ์เสริมทั้งหมดเพื่อนำมาส่งคืน ณ สำนักงานกองบริหารงานสำนักบริการวิชาการตามกำหนด</p>
    `;
  } else if (reminderType === 'TODAY') {
    notifType = 'REMINDER_DUE_TODAY';
    badge = 'ครบกำหนดคืนวันนี้';
    subject = `[ครบกำหนดวันนี้] ครุภัณฑ์ ${reqId} (${r.equipment.name}) ครบกำหนดส่งคืนวันนี้`;
    bodyText = `
      <h2 style="font-size: 16px; font-weight: 700; color: #0f172a; margin-top: 0;">เรียนคุณ ${r.borrower.name},</h2>
      <p>ครุภัณฑ์เลขที่ <b>${reqId}</b> <b>ครบกำหนดส่งคืนในวันนี้ (${fmtDate(r.expectedReturnDate)})</b></p>
      <div class="info-card">
        <div class="info-row"><span class="info-label">เลขที่คำขอ:</span><span class="info-value">${reqId}</span></div>
        <div class="info-row"><span class="info-label">รายการครุภัณฑ์:</span><span class="info-value">${r.equipment.name}</span></div>
        <div class="info-row"><span class="info-label">กำหนดส่งคืน:</span><span class="info-value" style="color: #ea580c; font-weight: 800;">วันนี้ (${fmtDate(r.expectedReturnDate)})</span></div>
      </div>
      <p style="font-size: 13px; color: #475569;">กรุณานำอุปกรณ์และอุปกรณ์เสริมมาส่งคืนแก่เจ้าหน้าที่พัสดุภายในเวลาทำการ</p>
    `;
  } else {
    notifType = 'REMINDER_OVERDUE';
    badge = `เกินกำหนดคืน ${daysDiff} วัน`;
    subject = `[ด่วน - เกินกำหนดส่งคืน] ครุภัณฑ์ ${reqId} (${r.equipment.name}) เกินกำหนดส่งคืนแล้ว ${daysDiff} วัน`;
    bodyText = `
      <h2 style="font-size: 16px; font-weight: 700; color: #991b1b; margin-top: 0;">เรียนคุณ ${r.borrower.name},</h2>
      <p style="color: #991b1b; font-weight: 600;">ครุภัณฑ์เลขที่ <b>${reqId}</b> เกินกำหนดส่งคืนแล้วเป็นเวลา ${daysDiff} วัน (กำหนดคืนเดิม: ${fmtDate(r.expectedReturnDate)})</p>
      <div class="info-card" style="border-color: #fecaca; background-color: #fef2f2;">
        <div class="info-row"><span class="info-label">เลขที่คำขอ:</span><span class="info-value">${reqId}</span></div>
        <div class="info-row"><span class="info-label">รายการครุภัณฑ์:</span><span class="info-value">${r.equipment.name}</span></div>
        <div class="info-row"><span class="info-label">กำหนดส่งคืนเดิม:</span><span class="info-value" style="color: #dc2626; font-weight: 800;">${fmtDate(r.expectedReturnDate)}</span></div>
        <div class="info-row"><span class="info-label">เกินกำหนด:</span><span class="info-value" style="color: #dc2626; font-weight: 800;">${daysDiff} วัน</span></div>
      </div>
      <p style="font-size: 13px; color: #991b1b;"><b>โปรดดำเนินการนำส่งคืนทันที</b> หากมีเหตุจำเป็นกรุณาติดต่อเจ้าหน้าที่พัสดุ (${custodianEmail}) โดยด่วน</p>
    `;
  }

  await queueEmail({
    to: [r.borrower.email],
    cc: reminderType === 'OVERDUE' ? [custodianEmail] : undefined,
    type: notifType,
    requestId: reqId,
    targetStatus: reminderType === 'OVERDUE' ? 'OVERDUE' : 'IN_USE',
    idempotencyKey: `${reqId}_${notifType}_${today}_${r.borrower.email}`,
    message: {
      subject,
      text: `${subject}: ${link}`,
      html: baseEmailTemplate(subject, badge, bodyText, link, 'ดูรายละเอียดและสถานะคำขอ', reqId),
    },
  }, customDb);
}

/* ------------------------------------------------------------------ */
/* 9) แจ้งเตือนการขอต่ออายุ (Extension Notifications)                      */
/* ------------------------------------------------------------------ */
export async function notifyExtensionRequested(
  r: BorrowRequest,
  newReturnDate: string,
  reason: string,
  customDb?: any
) {
  const reqId = getRequestId(r);
  const link = `${APP_URL}/request/?id=${reqId}`;
  const settings = await getEmailSettings(customDb);
  const custodianEmail = settings.custodianEmail || DEFAULT_CUSTODIAN_EMAIL;

  const html = `
    <h2 style="font-size: 16px; font-weight: 700; color: #0f172a; margin-top: 0;">เรียน เจ้าหน้าที่พัสดุ (${custodianEmail}),</h2>
    <p>ผู้ยืมได้ยื่น <b>คำขอขยายระยะเวลาส่งคืน (ขอต่ออายุ)</b> สำหรับคำขอยืมเลขที่ <b>${reqId}</b>:</p>
    <div class="info-card">
      <div class="info-row"><span class="info-label">เลขที่คำขอ:</span><span class="info-value">${reqId}</span></div>
      <div class="info-row"><span class="info-label">ผู้ขอยืม:</span><span class="info-value">${r.borrower.name} (${r.borrower.position})</span></div>
      <div class="info-row"><span class="info-label">รายการครุภัณฑ์:</span><span class="info-value">${r.equipment.name}</span></div>
      <div class="info-row"><span class="info-label">กำหนดคืนเดิม:</span><span class="info-value">${fmtDate(r.expectedReturnDate)}</span></div>
      <div class="info-row"><span class="info-label">กำหนดคืนใหม่ที่ขอ:</span><span class="info-value" style="color: #2563eb; font-weight: 700;">${fmtDate(newReturnDate)}</span></div>
      <div class="info-row"><span class="info-label">เหตุผลความจำเป็น:</span><span class="info-value">${reason}</span></div>
    </div>
    <p style="font-size: 13px; color: #475569;">กรุณาตรวจสอบความพร้อมและคิวการจองในระบบเพื่อส่งต่อให้ผู้อนุมัติพิจารณาต่อไป</p>
  `;

  await queueEmail({
    to: [custodianEmail],
    type: 'EXTENSION_REQUESTED',
    requestId: reqId,
    idempotencyKey: `${reqId}_EXT_REQ_${newReturnDate}_${custodianEmail}`,
    message: {
      subject: `[ขอต่ออายุ] คำขอยืมครุภัณฑ์ ${reqId} (${r.equipment.name}) มีการขอขยายเวลาคืนถึง ${fmtDate(newReturnDate)}`,
      text: `ผู้ยืมขอขยายกำหนดคืนสำหรับ ${reqId} ถึง ${fmtDate(newReturnDate)} เหตุผล: ${reason} ตรวจสอบ: ${link}`,
      html: baseEmailTemplate(`คำขอต่ออายุครุภัณฑ์ ${reqId}`, 'ขอต่ออายุ', html, link, 'เข้าสู่ระบบเพื่อตรวจสอบคำขอต่ออายุ', reqId),
    },
  }, customDb);

  // ส่งยืนยันผู้ยืม
  const borrowerHtml = `
    <h2 style="font-size: 16px; font-weight: 700; color: #0f172a; margin-top: 0;">เรียนคุณ ${r.borrower.name},</h2>
    <p>ระบบได้รับคำขอต่ออายุการใช้งานครุภัณฑ์เลขที่ <b>${reqId}</b> ของท่านเรียบร้อยแล้ว ขณะนี้กำลังรอการตรวจสอบความพร้อมและพิจารณาอนุมัติ</p>
    <div class="info-card">
      <div class="info-row"><span class="info-label">เลขที่คำขอ:</span><span class="info-value">${reqId}</span></div>
      <div class="info-row"><span class="info-label">กำหนดคืนเดิม:</span><span class="info-value">${fmtDate(r.expectedReturnDate)}</span></div>
      <div class="info-row"><span class="info-label">กำหนดคืนใหม่ที่ขอ:</span><span class="info-value" style="color: #2563eb; font-weight: 700;">${fmtDate(newReturnDate)}</span></div>
      <div class="info-row"><span class="info-label">สถานะการต่ออายุ:</span><span class="info-value" style="color: #d97706;">รอการพิจารณา</span></div>
    </div>
    <p style="font-size: 12px; color: #64748b;">* หมายเหตุ: ในระหว่างรอการอนุมัติ กำหนดส่งคืนเดิมยังคงมีผล</p>
  `;

  // หากผู้ยืมเป็นผู้ดูแล ให้ใช้ฉบับแจ้งตรวจต่ออายุเพียงฉบับเดียว
  if (custodianEmail.toLowerCase() !== r.borrower.email.toLowerCase()) await queueEmail({
    to: [r.borrower.email],
    type: 'EXTENSION_REQUESTED',
    requestId: reqId,
    idempotencyKey: `${reqId}_EXT_REQ_CONFIRM_${newReturnDate}`,
    message: {
      subject: `[รับคำขอต่ออายุ] ระบบได้รับคำขอขยายเวลาส่งคืนสำหรับ ${reqId} เรียบร้อยแล้ว`,
      text: `ระบบได้รับคำขอต่ออายุสำหรับ ${reqId} ถึง ${fmtDate(newReturnDate)} ติดตามสถานะ: ${link}`,
      html: baseEmailTemplate(`ยืนยันคำขอต่ออายุ ${reqId}`, 'ได้รับคำขอต่ออายุ', borrowerHtml, link, 'ติดตามสถานะคำขอ', reqId),
    },
  }, customDb);
}

export async function notifyExtensionReviewPassed(
  r: BorrowRequest,
  newReturnDate: string,
  reason: string,
  customDb?: any
) {
  const reqId = getRequestId(r);
  const link = `${APP_URL}/request/?id=${reqId}`;
  const settings = await getEmailSettings(customDb);
  const approverEmail = settings.approverEmail || DEFAULT_APPROVER_EMAIL;

  const html = `
    <h2 style="font-size: 16px; font-weight: 700; color: #0f172a; margin-top: 0;">เรียน ผู้อนุมัติ (${approverEmail}),</h2>
    <p>คำขอขยายระยะเวลาส่งคืนครุภัณฑ์เลขที่ <b>${reqId}</b> ได้รับการตรวจสอบความพร้อมจาก <b>เจ้าหน้าที่พัสดุ</b> แล้ว รอการพิจารณาอนุมัติจากท่าน:</p>
    <div class="info-card">
      <div class="info-row"><span class="info-label">เลขที่คำขอ:</span><span class="info-value">${reqId}</span></div>
      <div class="info-row"><span class="info-label">ผู้ขอยืม:</span><span class="info-value">${r.borrower.name} (${r.borrower.position})</span></div>
      <div class="info-row"><span class="info-label">รายการครุภัณฑ์:</span><span class="info-value">${r.equipment.name}</span></div>
      <div class="info-row"><span class="info-label">กำหนดคืนเดิม:</span><span class="info-value">${fmtDate(r.expectedReturnDate)}</span></div>
      <div class="info-row"><span class="info-label">ขอขยายถึง:</span><span class="info-value" style="color: #2563eb; font-weight: 700;">${fmtDate(newReturnDate)}</span></div>
      <div class="info-row"><span class="info-label">เหตุผลความจำเป็น:</span><span class="info-value">${reason}</span></div>
      <div class="info-row"><span class="info-label">ผลตรวจเจ้าหน้าที่:</span><span class="info-value" style="color: #16a34a;">ผ่านการตรวจสอบ ไม่ติดคิวจอง</span></div>
    </div>
  `;

  await queueEmail({
    to: [approverEmail],
    type: 'EXTENSION_REVIEW_PASSED',
    requestId: reqId,
    idempotencyKey: `${reqId}_EXT_REV_PASS_${newReturnDate}`,
    message: {
      subject: `[รออนุมัติต่ออายุ] คำขอขยายเวลาส่งคืนครุภัณฑ์ ${reqId} ผ่านการตรวจจากเจ้าหน้าที่แล้ว`,
      text: `คำขอต่ออายุ ${reqId} ถึง ${fmtDate(newReturnDate)} ผ่านการตรวจสอบแล้ว รอการอนุมัติ: ${link}`,
      html: baseEmailTemplate(`รออนุมัติต่ออายุ ${reqId}`, 'รออนุมัติต่ออายุ', html, link, 'เข้าสู่ระบบเพื่อพิจารณาอนุมัติ', reqId),
    },
  }, customDb);
}

export async function notifyExtensionApproved(
  r: BorrowRequest,
  previousDate: string,
  newDate: string,
  comment?: string,
  customDb?: any
) {
  const reqId = getRequestId(r);
  const link = `${APP_URL}/request/?id=${reqId}`;
  const settings = await getEmailSettings(customDb);
  const custodianEmail = settings.custodianEmail || DEFAULT_CUSTODIAN_EMAIL;

  const html = `
    <h2 style="font-size: 16px; font-weight: 700; color: #0f172a; margin-top: 0;">เรียนคุณ ${r.borrower.name},</h2>
    <p>คำขอขยายระยะเวลาส่งคืนครุภัณฑ์เลขที่ <b>${reqId}</b> ได้รับการ <b>อนุมัติเรียบร้อยแล้ว</b></p>
    <div class="info-card">
      <div class="info-row"><span class="info-label">เลขที่คำขอ:</span><span class="info-value">${reqId}</span></div>
      <div class="info-row"><span class="info-label">รายการครุภัณฑ์:</span><span class="info-value">${r.equipment.name}</span></div>
      <div class="info-row"><span class="info-label">กำหนดคืนเดิม:</span><span class="info-value" style="text-decoration: line-through; color: #64748b;">${fmtDate(previousDate)}</span></div>
      <div class="info-row"><span class="info-label">กำหนดคืนใหม่:</span><span class="info-value" style="color: #16a34a; font-weight: 800;">${fmtDate(newDate)}</span></div>
      ${comment ? `<div class="info-row"><span class="info-label">ความเห็นผู้อนุมัติ:</span><span class="info-value">${comment}</span></div>` : ''}
    </div>
    <p style="font-size: 13px; color: #15803d; background-color: #f0fdf4; border: 1px solid #bbf7d0; padding: 12px; border-radius: 8px;">
      ✨ ระบบได้ปรับปรุงกำหนดเวลาส่งคืนใหม่ในฐานข้อมูลและการแจ้งเตือนเรียบร้อยแล้ว โปรดส่งคืนตรงตามกำหนดเวลาใหม่
    </p>
  `;

  await queueEmail({
    to: [r.borrower.email],
    cc: [custodianEmail],
    type: 'EXTENSION_APPROVED',
    requestId: reqId,
    idempotencyKey: `${reqId}_EXT_APPROVED_${newDate}`,
    message: {
      subject: `[อนุมัติต่ออายุแล้ว] คำขอยืมครุภัณฑ์ ${reqId} ได้รับการขยายกำหนดคืนเป็น ${fmtDate(newDate)}`,
      text: `คำขอต่ออายุ ${reqId} ได้รับการอนุมัติแล้ว กำหนดคืนใหม่คือ ${fmtDate(newDate)}: ${link}`,
      html: baseEmailTemplate(`อนุมัติต่ออายุคำขอ ${reqId}`, 'อนุมัติต่ออายุแล้ว', html, link, 'ดูรายละเอียดคำขอ', reqId),
    },
  }, customDb);
}

export async function notifyExtensionRejected(
  r: BorrowRequest,
  comment?: string,
  byRole: 'REVIEW' | 'APPROVAL' = 'APPROVAL',
  customDb?: any
) {
  const reqId = getRequestId(r);
  const link = `${APP_URL}/request/?id=${reqId}`;

  const html = `
    <h2 style="font-size: 16px; font-weight: 700; color: #0f172a; margin-top: 0;">เรียนคุณ ${r.borrower.name},</h2>
    <p>คำขอขยายระยะเวลาส่งคืนครุภัณฑ์เลขที่ <b>${reqId}</b> <b>ไม่ได้รับการอนุมัติ</b></p>
    <div class="info-card">
      <div class="info-row"><span class="info-label">เลขที่คำขอ:</span><span class="info-value">${reqId}</span></div>
      <div class="info-row"><span class="info-label">รายการครุภัณฑ์:</span><span class="info-value">${r.equipment.name}</span></div>
      <div class="info-row"><span class="info-label">กำหนดส่งคืนที่ยังคงมีผล:</span><span class="info-value" style="color: #dc2626; font-weight: 800;">${fmtDate(r.expectedReturnDate)}</span></div>
      <div class="info-row"><span class="info-label">เหตุผล / ความเห็น:</span><span class="info-value">${comment || 'มีคิวจองจากผู้ใช้งานท่านอื่น หรืออุปกรณ์มีความจำเป็นต้องใช้งานในภารกิจเร่งด่วน'}</span></div>
    </div>
    <p style="font-size: 13px; color: #b91c1c; background-color: #fef2f2; border: 1px solid #fecaca; padding: 12px; border-radius: 8px;">
      ⚠️ <b>ข้อปฏิบัติ:</b> กำหนดส่งคืนเดิมของท่าน (วันที่ ${fmtDate(r.expectedReturnDate)}) ยังคงมีผลบังคับใช้ตามปกติ กรุณานำครุภัณฑ์ส่งคืนตรงตามกำหนดเวลาเดิม
    </p>
  `;

  await queueEmail({
    to: [r.borrower.email],
    type: 'EXTENSION_REJECTED',
    requestId: reqId,
    idempotencyKey: `${reqId}_EXT_REJECTED_${r.extension?.requestedAt?.toMillis?.() ?? r.extension?.newExpectedReturnDate ?? 'unknown'}`,
    message: {
      subject: `[แจ้งผลต่ออายุ] คำขอขยายเวลาส่งคืนครุภัณฑ์ ${reqId} ไม่ได้รับการอนุมัติ`,
      text: `คำขอต่ออายุสำหรับ ${reqId} ไม่ได้รับการอนุมัติ กำหนดส่งคืนเดิมยังคงเป็น ${fmtDate(r.expectedReturnDate)}: ${link}`,
      html: baseEmailTemplate(`ผลการพิจารณาต่ออายุ ${reqId}`, 'ไม่อนุมัติต่ออายุ', html, link, 'ดูรายละเอียดคำขอ', reqId),
    },
  }, customDb);
}

/* ------------------------------------------------------------------ */
/* 10) ส่ง Email ทดสอบระบบจากหน้า Settings                                */
/* ------------------------------------------------------------------ */
export async function sendTestEmailNotification(targetEmail: string, senderName: string) {
  const html = `
    <h2 style="font-size: 16px; font-weight: 700; color: #0f172a; margin-top: 0;">เรียน ${senderName},</h2>
    <p>นี่คืออีเมลทดสอบการทำงานของระบบแจ้งเตือนอัตโนมัติ (Email Notification) ของระบบยืม-คืน ครุภัณฑ์ สำนักบริการวิชาการ มหาวิทยาลัยขอนแก่น</p>
    <div class="info-card">
      <div class="info-row"><span class="info-label">สถานะระบบ:</span><span class="info-value" style="color: #16a34a;">พร้อมใช้งานปกติ (Ready)</span></div>
      <div class="info-row"><span class="info-label">อีเมลผู้รับทดสอบ:</span><span class="info-value">${targetEmail}</span></div>
      <div class="info-row"><span class="info-label">เวลาส่งทดสอบ (Bangkok):</span><span class="info-value">${new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' })}</span></div>
    </div>
  `;

  return queueEmail({
    to: [targetEmail],
    type: 'TEST',
    idempotencyKey: `TEST_${Date.now()}_${targetEmail}`,
    message: {
      subject: `[ทดสอบระบบ] ทดสอบการแจ้งเตือนผ่าน Email - สำนักบริการวิชาการ มข.`,
      text: `นี่คืออีเมลทดสอบระบบแจ้งเตือนอัตโนมัติ ส่งเมื่อ: ${new Date().toLocaleString('th-TH')}`,
      html: baseEmailTemplate(
        'ทดสอบระบบแจ้งเตือนผ่าน Email',
        'ทดสอบระบบ',
        html,
        APP_URL,
        'เข้าสู่ระบบยืม-คืน ครุภัณฑ์'
      ),
    },
  });
}

/* ------------------------------------------------------------------ */
/* 11) แจ้งเตือนงานแจ้งซ่อมบำรุงครุภัณฑ์ (Repair Notification Suite)       */
/* ------------------------------------------------------------------ */

/** แจ้งเตือนผู้อนุมัติเมื่อมีใบแจ้งซ่อมใหม่รอตรวจสอบ */
export async function notifyRepairPendingReview(repair: RepairRequest, customDb?: any) {
  const settings = await getEmailSettings(customDb);
  const recipient = repair.approverEmail?.trim() || settings.approverEmail;
  if (!recipient) return null;

  const link = `${APP_URL}/admin/repairs/`;
  const itemsListHtml = (repair.items || [])
    .map(
      (it, idx) =>
        `<tr>
          <td style="padding: 6px 10px; border: 1px solid #e2e8f0; text-align: center;">${idx + 1}</td>
          <td style="padding: 6px 10px; border: 1px solid #e2e8f0;"><b>${escapeHtml(it.equipmentName)}</b></td>
          <td style="padding: 6px 10px; border: 1px solid #e2e8f0; font-family: monospace;">${escapeHtml(it.assetNumber || '-')}</td>
          <td style="padding: 6px 10px; border: 1px solid #e2e8f0; color: #dc2626;">${escapeHtml(it.symptom)}</td>
        </tr>`
    )
    .join('');

  const html = `
    <h2 style="font-size: 16px; font-weight: 700; color: #0f172a; margin-top: 0;">เรียน ${escapeHtml(repair.approverName || 'ผู้อนุมัติ/หัวหน้างาน')},</h2>
    <p>มีใบแจ้งซ่อมอุปกรณ์/ครุภัณฑ์ฉบับใหม่ <b>รอการตรวจสอบและพิจารณาอนุมัติ</b> จากเจ้าหน้าที่ผู้รับผิดชอบ</p>
    <div class="info-card">
      <div class="info-row"><span class="info-label">เลขที่ใบแจ้งซ่อม:</span><span class="info-value" style="font-weight: 800; color: #1e3a8a;">${escapeHtml(repair.ticketNo)}</span></div>
      <div class="info-row"><span class="info-label">ผู้แจ้งซ่อม:</span><span class="info-value">${escapeHtml(repair.requesterName)} (${escapeHtml(repair.requesterPosition || 'เจ้าหน้าที่')} ${escapeHtml(repair.requesterDivision || '')})</span></div>
      <div class="info-row"><span class="info-label">วันที่แจ้ง:</span><span class="info-value">${escapeHtml(repair.documentDate)}</span></div>
      <div class="info-row"><span class="info-label">จำนวนรายการ:</span><span class="info-value">${repair.items?.length || 0} รายการ</span></div>
    </div>
    <table style="width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 13px;">
      <thead>
        <tr style="background-color: #f1f5f9; color: #334155;">
          <th style="padding: 8px; border: 1px solid #cbd5e1; width: 40px;">ลำดับ</th>
          <th style="padding: 8px; border: 1px solid #cbd5e1;">ครุภัณฑ์</th>
          <th style="padding: 8px; border: 1px solid #cbd5e1; width: 140px;">หมายเลขครุภัณฑ์</th>
          <th style="padding: 8px; border: 1px solid #cbd5e1;">อาการชำรุด</th>
        </tr>
      </thead>
      <tbody>${itemsListHtml}</tbody>
    </table>
    <p style="font-size: 13px; color: #475569;">
      ท่านสามารถเข้าสู่ระบบเพื่อตรวจสอบรายละเอียดและลงนามพิจารณาอนุมัติผ่านระบบดิจิทัลได้ทันที
    </p>
  `;

  return queueEmail(
    {
      to: [recipient],
      type: 'REPAIR_PENDING_REVIEW',
      requestId: repair.ticketNo,
      idempotencyKey: `${repair.ticketNo}_PENDING_REVIEW`,
      message: {
        subject: `[แจ้งซ่อมอุปกรณ์] ใบแจ้งซ่อมเลขที่ ${repair.ticketNo} รอการพิจารณาอนุมัติ`,
        text: `มีใบแจ้งซ่อมใหม่เลขที่ ${repair.ticketNo} จากคุณ ${repair.requesterName} รอการอนุมัติ: ${link}`,
        html: baseEmailTemplate(
          `ใบแจ้งซ่อม ${repair.ticketNo} รอการอนุมัติ`,
          'รอการอนุมัติ',
          html,
          link,
          'เข้าสู่หน้าจัดการงานแจ้งซ่อม'
        ),
      },
    },
    customDb
  );
}

/** แจ้งเตือนผู้แจ้งซ่อมและเจ้าหน้าที่เมื่อใบแจ้งซ่อมได้รับการอนุมัติ */
export async function notifyRepairApproved(repair: RepairRequest, approverName: string, customDb?: any) {
  const recipient = repair.requesterEmail?.trim();
  if (!recipient) return null;

  const link = `${APP_URL}/admin/repairs/`;
  const html = `
    <h2 style="font-size: 16px; font-weight: 700; color: #0f172a; margin-top: 0;">เรียนคุณ ${escapeHtml(repair.requesterName)},</h2>
    <p>ใบแจ้งซ่อมแซมอุปกรณ์เลขที่ <b>${escapeHtml(repair.ticketNo)}</b> ได้รับการพิจารณา <b>อนุมัติเรียบร้อยแล้ว</b></p>
    <div class="info-card">
      <div class="info-row"><span class="info-label">เลขที่ใบแจ้งซ่อม:</span><span class="info-value" style="font-weight: 800; color: #166534;">${escapeHtml(repair.ticketNo)}</span></div>
      <div class="info-row"><span class="info-label">ผู้อนุมัติ:</span><span class="info-value">${escapeHtml(approverName || repair.approverName)}</span></div>
      <div class="info-row"><span class="info-label">สถานะปัจจุบัน:</span><span class="info-value" style="color: #1e40af; font-weight: 700;">อนุมัติแล้ว (พร้อมนำส่งซ่อม)</span></div>
      <div class="info-row"><span class="info-label">จำนวนครุภัณฑ์:</span><span class="info-value">${repair.items?.length || 0} รายการ</span></div>
    </div>
    <p style="font-size: 13px; color: #475569;">
      เจ้าหน้าที่พัสดุจะดำเนินการประสานงานช่างหรือศูนย์บริการเพื่อส่งซ่อมบำรุงตามขั้นตอนต่อไป
    </p>
  `;

  return queueEmail(
    {
      to: [recipient],
      type: 'REPAIR_APPROVED',
      requestId: repair.ticketNo,
      idempotencyKey: `${repair.ticketNo}_APPROVED`,
      message: {
        subject: `[อนุมัติแล้ว] ใบแจ้งซ่อมเลขที่ ${repair.ticketNo} ได้รับการอนุมัติเรียบร้อยแล้ว`,
        text: `ใบแจ้งซ่อมเลขที่ ${repair.ticketNo} ได้รับการอนุมัติแล้วโดย ${approverName}: ${link}`,
        html: baseEmailTemplate(
          `ใบแจ้งซ่อม ${repair.ticketNo} ได้รับการอนุมัติแล้ว`,
          'อนุมัติแล้ว',
          html,
          link,
          'ดูสถานะงานแจ้งซ่อม'
        ),
      },
    },
    customDb
  );
}

/** แจ้งเตือนเมื่อปิดงานซ่อมแซมเสร็จสิ้น พร้อมแยก ค่าแรง / ค่าอะไหล่ / ค่าบริการ / ค่าใช้จ่ายอื่นๆ */
export async function notifyRepairCompleted(repair: RepairRequest, customDb?: any) {
  const recipient = repair.requesterEmail?.trim();
  if (!recipient) return null;

  const link = `${APP_URL}/admin/repairs/`;

  const labor = repair.laborCost ?? 0;
  const parts = repair.partsCost ?? 0;
  const service = repair.serviceCost ?? 0;
  const other = repair.otherCost ?? 0;
  const total = repair.repairCost ?? (labor + parts + service + other);

  const html = `
    <h2 style="font-size: 16px; font-weight: 700; color: #0f172a; margin-top: 0;">เรียนคุณ ${escapeHtml(repair.requesterName)},</h2>
    <p>งานซ่อมแซมอุปกรณ์ตามใบแจ้งซ่อมเลขที่ <b>${escapeHtml(repair.ticketNo)}</b> ได้ดำเนินการ <b>เสร็จสิ้นและตรวจรับปิดงานเรียบร้อยแล้ว</b></p>
    <div class="info-card">
      <div class="info-row"><span class="info-label">เลขที่ใบแจ้งซ่อม:</span><span class="info-value" style="font-weight: 800; color: #166534;">${escapeHtml(repair.ticketNo)}</span></div>
      <div class="info-row"><span class="info-label">วันที่ซ่อมเสร็จ:</span><span class="info-value">${escapeHtml(repair.completionDate || todayStr())}</span></div>
      <div class="info-row"><span class="info-label">ร้านค้า/ผู้รับจ้าง:</span><span class="info-value">${escapeHtml(repair.vendorName || '-')}</span></div>
      <div class="info-row"><span class="info-label">ผลการตรวจรับ:</span><span class="info-value">${escapeHtml(repair.completionNotes || 'ซ่อมแซมและตรวจรับสภาพสมบูรณ์')}</span></div>
    </div>

    <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 14px; margin: 16px 0;">
      <div style="font-weight: 700; color: #1e293b; margin-bottom: 8px; font-size: 14px;">สรุปค่าใช้จ่ายในการซ่อมแซม (แยก ค่าแรง / ค่าอะไหล่ / ค่าบริการ / อื่นๆ)</div>
      <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
        <tr><td style="padding: 4px 0; color: #475569;">1. ค่าแรง (Labor):</td><td style="text-align: right; font-weight: 600;">${labor.toLocaleString()} บาท</td></tr>
        <tr><td style="padding: 4px 0; color: #475569;">2. ค่าอะไหล่ (Spare Parts):</td><td style="text-align: right; font-weight: 600;">${parts.toLocaleString()} บาท</td></tr>
        <tr><td style="padding: 4px 0; color: #475569;">3. ค่าบริการ (Service):</td><td style="text-align: right; font-weight: 600;">${service.toLocaleString()} บาท</td></tr>
        <tr><td style="padding: 4px 0; color: #475569;">4. ค่าใช้จ่ายอื่นๆ (Other):</td><td style="text-align: right; font-weight: 600;">${other.toLocaleString()} บาท</td></tr>
        <tr style="border-top: 1px dashed #cbd5e1;">
          <td style="padding: 8px 0 0 0; font-weight: 800; color: #0f172a; font-size: 14px;">ยอดรวมทั้งสิ้น:</td>
          <td style="padding: 8px 0 0 0; text-align: right; font-weight: 800; color: #166534; font-size: 15px;">${total.toLocaleString()} บาท</td>
        </tr>
      </table>
    </div>

    <p style="font-size: 13px; color: #15803d; background-color: #f0fdf4; border: 1px solid #bbf7d0; padding: 12px; border-radius: 8px;">
      ✅ <b>สถานะครุภัณฑ์:</b> ครุภัณฑ์ทั้งหมดในใบแจ้งซ่อมนี้ได้รับการปรับสถานะกลับเป็น <b>"พร้อมใช้งาน" (AVAILABLE)</b> ในระบบเรียบร้อยแล้ว
    </p>
  `;

  return queueEmail(
    {
      to: [recipient],
      type: 'REPAIR_COMPLETED',
      requestId: repair.ticketNo,
      idempotencyKey: `${repair.ticketNo}_COMPLETED`,
      message: {
        subject: `[ปิดงานซ่อม] ใบแจ้งซ่อมเลขที่ ${repair.ticketNo} ดำเนินการซ่อมเสร็จสิ้นแล้ว`,
        text: `ใบแจ้งซ่อมเลขที่ ${repair.ticketNo} ซ่อมแซมเสร็จสิ้น ครุภัณฑ์พร้อมใช้งาน ยอดรวม ${total.toLocaleString()} บาท: ${link}`,
        html: baseEmailTemplate(
          `ใบแจ้งซ่อม ${repair.ticketNo} ซ่อมแซมเสร็จสิ้น`,
          'ปิดงานสำเร็จ',
          html,
          link,
          'ดูรายละเอียดงานซ่อม'
        ),
      },
    },
    customDb
  );
}

/* ------------------------------------------------------------------ */
/* 10) ตรวจสอบและประมวลผลการแจ้งเตือนตามรอบเวลา (Scheduler Evaluation)       */
/* ------------------------------------------------------------------ */
export async function evaluateDailyReminders(): Promise<{
  checked: number;
  remindersQueued: number;
  logs: string[];
}> {
  const { db } = fb();
  const today = todayStr();
  const logs: string[] = [];
  let remindersQueued = 0;

  try {
    // 1. ดึงคำขอที่กำลังใช้งานอยู่ (IN_USE) หรือ เกินกำหนด (OVERDUE)
    const q = query(
      collection(db, 'borrow_requests'),
      where('status', 'in', ['IN_USE', 'OVERDUE', 'APPROVED_WAITING_PICKUP'])
    );
    const snap = await getDocs(q);
    const requests = snap.docs.map((d) => ({ ...d.data(), id: d.id }) as BorrowRequest);

    for (const r of requests) {
      const reqId = getRequestId(r);
      if (r.status === 'IN_USE') {
        const expected = r.expectedReturnDate;
        if (expected === today) {
          // ครบกำหนดวันนี้
          await notifyDueReminder(r, 'TODAY', 0);
          logs.push(`[TODAY] คำขอ ${reqId} ครบกำหนดวันนี้`);
          remindersQueued++;
        } else if (expected > today) {
          // คำนวณวันที่เหลือ
          const diffDays = Math.ceil(
            (new Date(expected).getTime() - new Date(today).getTime()) / (1000 * 3600 * 24)
          );
          if (diffDays === 1 || diffDays === 2) {
            await notifyDueReminder(r, 'SOON', diffDays);
            logs.push(`[SOON] คำขอ ${reqId} ใกล้ครบกำหนดในอีก ${diffDays} วัน`);
            remindersQueued++;
          }
        } else if (expected < today) {
          // เกินกำหนด
          const overdueDays = Math.ceil(
            (new Date(today).getTime() - new Date(expected).getTime()) / (1000 * 3600 * 24)
          );
          // อัปเดตสถานะเป็น OVERDUE
          await updateDoc(doc(db, 'borrow_requests', reqId), {
            status: 'OVERDUE',
            timeline: [
              ...(r.timeline ?? []),
              {
                status: 'OVERDUE',
                at: Timestamp.now(),
                by: 'system',
                byName: 'ระบบแจ้งเตือนอัตโนมัติ',
                note: `เกินกำหนดส่งคืน ${overdueDays} วัน (ปรับสถานะเป็น OVERDUE)`,
              },
            ],
            updatedAt: serverTimestamp(),
          });
          await notifyDueReminder(r, 'OVERDUE', overdueDays);
          logs.push(`[OVERDUE] คำขอ ${reqId} เกินกำหนด ${overdueDays} วัน (อัปเดตเป็น OVERDUE)`);
          remindersQueued++;
        }
      } else if (r.status === 'OVERDUE') {
        const expected = r.expectedReturnDate;
        const overdueDays = Math.max(
          1,
          Math.ceil((new Date(today).getTime() - new Date(expected).getTime()) / (1000 * 3600 * 24))
        );
        await notifyDueReminder(r, 'OVERDUE', overdueDays);
        logs.push(`[OVERDUE] คำขอ ${reqId} เกินกำหนด ${overdueDays} วัน (เตือนซ้ำรายวัน)`);
        remindersQueued++;
      }
    }

    return { checked: requests.length, remindersQueued, logs };
  } catch (err: any) {
    console.error('evaluateDailyReminders error:', err);
    return { checked: 0, remindersQueued: 0, logs: [err.message] };
  }
}

/** ตรวจสอบความพร้อมของคิวอีเมลสำหรับ Client Batch Worker (เคารพ Backoff, MaxAttempts, และ Reconciliation) */
export function isJobEligibleForClientProcess(
  jobData: Pick<MailJob, 'status' | 'nextAttemptAt' | 'requiresReconciliation' | 'attemptCount' | 'maxAttempts'>,
  nowMs: number = Date.now()
): { eligible: boolean; reason?: string } {
  if (jobData.status !== 'PENDING') {
    return { eligible: false, reason: `STATUS_${jobData.status}` };
  }
  if (jobData.requiresReconciliation) {
    return { eligible: false, reason: 'RECONCILIATION_REQUIRED' };
  }
  const maxAttempts = jobData.maxAttempts || 3;
  if ((jobData.attemptCount || 0) >= maxAttempts) {
    return { eligible: false, reason: 'MAX_ATTEMPTS_EXCEEDED' };
  }
  if (jobData.nextAttemptAt) {
    const nextAtMs = jobData.nextAttemptAt.toMillis
      ? jobData.nextAttemptAt.toMillis()
      : typeof (jobData.nextAttemptAt as any)?.toDate === 'function'
      ? (jobData.nextAttemptAt as any).toDate().getTime()
      : new Date(jobData.nextAttemptAt as any).getTime();
    if (nextAtMs > nowMs) {
      return { eligible: false, reason: 'RETRY_NOT_DUE' };
    }
  }
  return { eligible: true };
}

/** สแกนและสะกิดคิว PENDING ให้ Server Worker ประมวลผล (Client Batch Trigger) */
export async function batchProcessPendingQueue(
  maxJobs: number = 25,
  customDb?: any
): Promise<{
  processed: number;
  success: number;
  failed: number;
  skipped: number;
}> {
  const db = customDb || fb().db;
  const settings = await getEmailSettings(customDb);
  let skipped = 0;
  let processed = 0;
  let success = 0;
  let failed = 0;

  if (!settings.enabled) {
    return { processed: 0, success: 0, failed: 0, skipped: 0 };
  }

  // 1. ดึงเฉพาะสถานะ PENDING เท่านั้น (ห้ามแตะ ERROR หรือ RECONCILIATION_REQUIRED)
  const q = query(
    collection(db, 'mail'),
    where('status', '==', 'PENDING'),
    limit(maxJobs)
  );

  const snap = await getDocs(q);
  const nowMs = Date.now();

  for (const docSnap of snap.docs) {
    const jobData = docSnap.data() as MailJob;
    const jobId = docSnap.id;

    // 2. ข้ามงานที่ไม่เข้าเกณฑ์ (เคารพ nextAttemptAt backoff, reconciliation, maxAttempts)
    const eligibility = isJobEligibleForClientProcess(jobData, nowMs);
    if (!eligibility.eligible) {
      skipped++;
      continue;
    }

    // 3. ปรับปรุง updatedAt และประมวลผลทันทีผ่าน Direct Dispatcher (ทำงานได้โดยไม่ต้องใช้ Cloud Functions)
    const mailRef = doc(db, 'mail', jobId);
    await updateDoc(mailRef, {
      updatedAt: serverTimestamp(),
      sweepRequestedAt: serverTimestamp(),
    }).catch(() => {});

    processed++;
    try {
      const res = await dispatchMailJobDirect(mailRef, jobData, customDb);
      if (res.status === 'SUCCESS') {
        success++;
      } else if (res.status === 'SKIPPED') {
        skipped++;
      } else {
        failed++;
      }
    } catch {
      failed++;
    }
  }

  return { processed, success, failed, skipped };
}
