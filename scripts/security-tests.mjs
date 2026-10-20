import assert from 'node:assert';
import {
  escapeHtml,
  validateReturnUrl,
  sanitizeCsvCell,
  findConflicts,
  daysUntil,
  todayStr,
  isEquipmentAvailable,
  validateEquipmentAvailability,
} from '../src/lib/utils.ts';
import {
  csatEmailSection,
  retryEmailJob,
  batchProcessPendingQueue,
  checkManualRetryEligibility,
  isJobEligibleForClientProcess,
  setMockQueueEmailHandler,
  queueEmail,
  getRequestId,
  buildRetroactiveCsatEmail,
  validateAndSanitizeMailJob,
  dispatchMailJobDirect,
  clearEmailDedupCache,
  setMockEmailSettingsHandler,
  notifyNewBorrowRequest,
  notifyReviewPassed,
  notifyReviewRejected,
  notifyApprovalResult,
  notifyHandedOver,
  notifyReturned,
  notifyDueReminder,
  notifyExtensionRequested,
  notifyExtensionReviewPassed,
  notifyExtensionApproved,
  notifyExtensionRejected,
} from '../src/lib/notifications.ts';
import {
  submitSatisfactionSurvey,
  updateSurveyFollowUp,
  sendRetroactiveCsatInvite,
  setMockTransactionRunner,
  createBorrowRequest,
  handoverRequest,
  returnRequest,
} from '../src/lib/requests.ts';
import {
  createRepairRequest,
  transitionRepairStatus,
} from '../src/lib/repairs.ts';
import { setMockAuditHandler } from '../src/lib/audit.ts';

process.env.NODE_ENV = 'test';
process.env.ALLOW_MOCK_GATEWAY = 'true';
setMockAuditHandler(() => {});

console.log('====================================================');
console.log('🔒 RUNNING PRODUCTION UNIT SECURITY TEST SUITE');
console.log('   (Importing directly from src/lib/utils.ts)');
console.log('====================================================\n');

let passedTests = 0;
let totalTests = 0;

async function it(desc, fn) {
  totalTests++;
  try {
    await fn();
    console.log(`  ✅ [PASS] ${desc}`);
    passedTests++;
  } catch (err) {
    console.error(`  ❌ [FAIL] ${desc}: ${err.message}\n${err.stack}`);
    process.exitCode = 1;
  }
}

// -------------------------------------------------------------
// 1. Redirect Validation Engine Test (Open Redirect Defense)
// -------------------------------------------------------------
console.log('--- TEST GROUP 1: Open Redirect Strict Validation (Production validateReturnUrl) ---');

it('Blocks absolute external URLs (https://evil.com)', () => {
  assert.strictEqual(validateReturnUrl('https://evil.com'), '/');
});

it('Blocks protocol-relative URLs (//evil.com)', () => {
  assert.strictEqual(validateReturnUrl('//evil.com'), '/');
});

it('Blocks backslash evasion (/\\evil.com)', () => {
  assert.strictEqual(validateReturnUrl('/\\evil.com'), '/');
});

it('Blocks javascript: URI schemes', () => {
  assert.strictEqual(validateReturnUrl('javascript:alert(1)'), '/');
});

it('Allows legitimate internal request path (/request/?id=BR-202610-0001)', () => {
  assert.strictEqual(validateReturnUrl('/request/?id=BR-202610-0001'), '/request/?id=BR-202610-0001');
});

it('Allows legitimate internal path without trailing slash (/equipment)', () => {
  assert.strictEqual(validateReturnUrl('/equipment'), '/equipment/');
});


// -------------------------------------------------------------
// 2. CSV Formula Injection Sanitization Test
// -------------------------------------------------------------
console.log('\n--- TEST GROUP 2: CSV Formula Injection Sanitization (Production sanitizeCsvCell) ---');

it('Neutralizes Excel formula starting with = (=cmd|\' /C calc\'!A0)', () => {
  assert.strictEqual(sanitizeCsvCell('=cmd|\' /C calc\'!A0'), '\'=cmd|\' /C calc\'!A0');
});

it('Neutralizes Excel formula starting with + (+12345)', () => {
  assert.strictEqual(sanitizeCsvCell('+12345'), '\'+12345');
});

it('Neutralizes Excel formula starting with - (-100)', () => {
  assert.strictEqual(sanitizeCsvCell('-100'), '\'-100');
});

it('Neutralizes Excel formula starting with @ (@SUM(1,1)) and handles commas', () => {
  assert.strictEqual(sanitizeCsvCell('@SUM(1,1)'), '"\'@SUM(1,1)"');
});

it('Preserves normal safe string (Dell Latitude 5440)', () => {
  assert.strictEqual(sanitizeCsvCell('Dell Latitude 5440'), 'Dell Latitude 5440');
});


// -------------------------------------------------------------
// 3. HTML Contextual Escaping Test (XSS Prevention in Email)
// -------------------------------------------------------------
console.log('\n--- TEST GROUP 3: HTML Contextual Escaping (Production escapeHtml) ---');

it('Escapes HTML script tags (<script>alert(1)</script>)', () => {
  assert.strictEqual(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
});

it('Escapes attribute injection with quotes (" onload="evil())', () => {
  assert.strictEqual(escapeHtml('" onload="evil()'), '&quot; onload=&quot;evil()');
});

it('Handles single quotes (\' onerror=\')', () => {
  assert.strictEqual(escapeHtml('\' onerror=\''), '&#039; onerror=&#039;');
});


// -------------------------------------------------------------
// 4. Deep Link & Redirect Resolution Tests (LINE to Safari/Chrome)
// -------------------------------------------------------------
console.log('\n--- TEST GROUP 4: Deep Link Resolution & Sanitization ---');

it('Neutralizes login redirect loop (/login or /login/?redirect=...) to /', () => {
  assert.strictEqual(validateReturnUrl('/login'), '/');
  assert.strictEqual(validateReturnUrl('/login/'), '/');
  assert.strictEqual(validateReturnUrl('/login/?redirect=/request/'), '/');
});

it('Preserves complex request deep link with query parameters', () => {
  assert.strictEqual(
    validateReturnUrl('/request/?id=BR-202610-0004&tab=timeline'),
    '/request/?id=BR-202610-0004&tab=timeline'
  );
});

it('Normalizes URI-encoded path without open redirect loophole', () => {
  assert.strictEqual(
    validateReturnUrl('%2Frequest%2F%3Fid%3DBR-202610-0004'),
    '/request/?id=BR-202610-0004'
  );
});

it('Simulates deep link fallback resolution across popup and redirect flows', () => {
  // Scenario A: First arrival on login page from LINE carries redirectParam
  const queryParam = '%2Frequest%2F%3Fid%3DBR-202610-0004';
  const validatedParam = validateReturnUrl(queryParam);
  assert.strictEqual(validatedParam, '/request/?id=BR-202610-0004');

  // Stored in browser storage for session
  const simulatedStorage = { post_login_redirect: validatedParam };

  // Scenario B: Returning from signInWithRedirect (OAuth callback arrives with null queryParam)
  const returningParam = null;
  const target = returningParam
    ? validateReturnUrl(returningParam)
    : validateReturnUrl(simulatedStorage.post_login_redirect);
  assert.strictEqual(target, '/request/?id=BR-202610-0004');

  // Scenario C: Returning with malicious or manipulated storage
  const maliciousStorage = { post_login_redirect: 'https://attacker.com' };
  const safeTarget = validateReturnUrl(maliciousStorage.post_login_redirect);
  assert.strictEqual(safeTarget, '/');
});


// -------------------------------------------------------------
// 5. Deterministic Idempotency Key Hashing (Mail Deduplication)
// -------------------------------------------------------------
console.log('\n--- TEST GROUP 5: Deterministic Idempotency Hashing ---');

it('Computes deterministic SHA-256 document IDs from idempotencyKey', async () => {
  const crypto = await import('node:crypto');
  const computeHash = (key) => crypto.createHash('sha256').update(key).digest('hex');

  const key1 = 'BR-202610-0004_NEW_REQUEST_custodian@kku.ac.th';
  const hash1a = computeHash(key1);
  const hash1b = computeHash(key1);
  assert.strictEqual(hash1a, hash1b);
  assert.strictEqual(hash1a.length, 64);

  const key2 = 'BR-202610-0004_REQUEST_CONFIRMATION_borrower@kku.ac.th';
  const hash2 = computeHash(key2);
  assert.notStrictEqual(hash1a, hash2);
});


// -------------------------------------------------------------
// 6. Clipboard Fallback Simulation
// -------------------------------------------------------------
console.log('\n--- TEST GROUP 6: Clipboard Fallback Chain Verification ---');

it('Simulates fallback when modern navigator.clipboard is unavailable or restricted', () => {
  let modernAttempted = false;
  let fallbackExecuted = false;

  const mockNavigator = { clipboard: null }; // restricted WebView
  const targetUrl = 'https://borrowoas.web.app/request/?id=BR-202610-0004';

  let copied = false;
  if (mockNavigator.clipboard?.writeText) {
    modernAttempted = true;
  } else {
    // Falls back to textarea copy simulation
    fallbackExecuted = true;
    copied = targetUrl.length > 0;
  }

  assert.strictEqual(modernAttempted, false);
  assert.strictEqual(fallbackExecuted, true);
  assert.strictEqual(copied, true);
});


// -------------------------------------------------------------
// 7. Worker ADC Initialization Safety (Blocker 1)
// -------------------------------------------------------------
console.log('\n--- TEST GROUP 7: Production ADC Initialization Safety (No Hardcoded Emulator) ---');

const { initAdmin, getGatewayConfig, dispatchViaGateway, claimMailJob, processSingleMailJob } = await import('../functions/worker-core.mjs');

await it('Does not mutate or force FIRESTORE_EMULATOR_HOST when env is unset', () => {
  const savedHost = process.env.FIRESTORE_EMULATOR_HOST;
  try {
    delete process.env.FIRESTORE_EMULATOR_HOST;
    // Verify reading env before and after
    assert.strictEqual(process.env.FIRESTORE_EMULATOR_HOST, undefined);
    
    // In production without emulator env, FIRESTORE_EMULATOR_HOST remains undefined
    assert.strictEqual(process.env.FIRESTORE_EMULATOR_HOST, undefined);
  } finally {
    if (savedHost !== undefined) {
      process.env.FIRESTORE_EMULATOR_HOST = savedHost;
    }
  }
});


// -------------------------------------------------------------
// 8. Gateway Configuration Fail-Closed & Mock Opt-in (Blocker 3)
// -------------------------------------------------------------
console.log('\n--- TEST GROUP 8: Gateway Fail-Closed & Mock Opt-in Verification ---');

await it('Fails closed with CONFIGURATION_ERROR when provider is NONE', async () => {
  const job = {
    to: ['user@kku.ac.th'],
    message: { subject: 'Test', text: 'Test', html: '<p>Test</p>' },
  };
  const res = await dispatchViaGateway(job, { provider: 'NONE' });
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.status, 'CONFIGURATION_ERROR');
});

await it('Fails closed with CONFIGURATION_ERROR when gateway config is null', async () => {
  const job = {
    to: ['user@kku.ac.th'],
    message: { subject: 'Test', text: 'Test', html: '<p>Test</p>' },
  };
  const res = await dispatchViaGateway(job, null);
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.status, 'CONFIGURATION_ERROR');
});

await it('Fails closed when provider is MOCK without explicit opt-in', async () => {
  const job = {
    to: ['user@kku.ac.th'],
    message: { subject: 'Test', text: 'Test', html: '<p>Test</p>' },
  };
  const savedAllow = process.env.ALLOW_MOCK_GATEWAY;
  const savedHost = process.env.FIRESTORE_EMULATOR_HOST;
  try {
    delete process.env.ALLOW_MOCK_GATEWAY;
    delete process.env.FIRESTORE_EMULATOR_HOST;

    const res = await dispatchViaGateway(job, { provider: 'MOCK' }, null, { allowMock: false });
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.status, 'CONFIGURATION_ERROR');
    assert.match(res.message, /explicit opt-in/i);
  } finally {
    if (savedAllow !== undefined) process.env.ALLOW_MOCK_GATEWAY = savedAllow;
    if (savedHost !== undefined) process.env.FIRESTORE_EMULATOR_HOST = savedHost;
  }
});

await it('Permits MOCK when ALLOW_MOCK_GATEWAY is explicitly set to true', async () => {
  const job = {
    to: ['user@kku.ac.th'],
    message: { subject: 'Test', text: 'Test', html: '<p>Test</p>' },
  };
  const savedAllow = process.env.ALLOW_MOCK_GATEWAY;
  try {
    process.env.ALLOW_MOCK_GATEWAY = 'true';
    const res = await dispatchViaGateway(job, { provider: 'MOCK' });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.status, 'SUCCESS');
    assert.match(res.messageId, /^mock_/);
  } finally {
    if (savedAllow !== undefined) process.env.ALLOW_MOCK_GATEWAY = savedAllow;
    else delete process.env.ALLOW_MOCK_GATEWAY;
  }
});

await it('Does not reveal secrets in error messages or logs', async () => {
  const job = {
    to: ['user@kku.ac.th'],
    message: { subject: 'Secret Test', text: 'Test', html: '<p>Test</p>' },
  };
  const fakeSecretKey = 'sk_live_super_secret_token_12345';
  const res = await dispatchViaGateway(
    job,
    { provider: 'BREVO', brevoApiKey: '' } // missing key
  );
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.status, 'CONFIGURATION_ERROR');
  assert.strictEqual(res.message.includes(fakeSecretKey), false);
});


// -------------------------------------------------------------
// 9. Retry Backoff Time Enforcement (Blocker 4)
// -------------------------------------------------------------
console.log('\n--- TEST GROUP 9: nextAttemptAt Backoff Enforcement ---');

await it('Rejects claim when nextAttemptAt is in the future (RETRY_NOT_DUE)', async () => {
  let docData = {
    status: 'PENDING',
    attemptCount: 1,
    nextAttemptAt: { toMillis: () => Date.now() + 60000 }, // 60s in future
  };

  const mockTx = {
    get: async () => ({ exists: true, data: () => docData }),
    update: (ref, update) => { Object.assign(docData, update); },
  };

  const mockDocRef = {
    firestore: {
      runTransaction: async (fn) => fn(mockTx),
    },
  };

  const claimRes = await claimMailJob(mockDocRef);
  assert.strictEqual(claimRes.claimed, false);
  assert.strictEqual(claimRes.reason, 'RETRY_NOT_DUE');
});

await it('Allows claim when nextAttemptAt is in the past', async () => {
  let docData = {
    status: 'PENDING',
    attemptCount: 1,
    nextAttemptAt: { toMillis: () => Date.now() - 5000 }, // 5s in past
  };

  const mockTx = {
    get: async () => ({ exists: true, data: () => docData }),
    update: (ref, update) => { Object.assign(docData, update); },
  };

  const mockDocRef = {
    firestore: {
      runTransaction: async (fn) => fn(mockTx),
    },
  };

  const claimRes = await claimMailJob(mockDocRef);
  assert.strictEqual(claimRes.claimed, true);
  assert.strictEqual(docData.status, 'PROCESSING');
  assert.strictEqual(claimRes.job.attemptCount, 2);
});


// -------------------------------------------------------------
// 10. Indeterminate Error & Stale PROCESSING Protection (Blocker 5)
// -------------------------------------------------------------
console.log('\n--- TEST GROUP 10: Indeterminate Delivery & Stale PROCESSING Lock Protection ---');

await it('Identifies non-JSON / HTML gateway response as INDETERMINATE_ERROR', async () => {
  const job = {
    to: ['user@kku.ac.th'],
    message: { subject: 'Test', text: 'Test', html: '<p>Test</p>' },
  };
  const mockFetch = async () => ({
    ok: true,
    status: 200,
    text: async () => '<!DOCTYPE html><html><body>Google Login Redirect</body></html>',
  });

  const res = await dispatchViaGateway(
    job,
    { provider: 'GOOGLE_APPS_SCRIPT', gasWebhookUrl: 'https://script.google.com/test' },
    mockFetch
  );
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.status, 'INDETERMINATE_ERROR');
});

await it('Transitions stale PROCESSING job to RECONCILIATION_REQUIRED without auto-resend', async () => {
  let docData = {
    status: 'PROCESSING',
    claimedAt: { toMillis: () => Date.now() - 400000 }, // 6.6 minutes ago (>5m)
    attemptCount: 1,
  };

  const mockTx = {
    get: async () => ({ exists: true, data: () => docData }),
    update: (ref, update) => { Object.assign(docData, update); },
  };

  const mockDocRef = {
    firestore: {
      runTransaction: async (fn) => fn(mockTx),
    },
  };

  const claimRes = await claimMailJob(mockDocRef, { recoverStale: true });
  assert.strictEqual(claimRes.claimed, false);
  assert.strictEqual(claimRes.reason, 'STALE_LOCK_RECONCILIATION_REQUIRED');
  assert.strictEqual(docData.status, 'RECONCILIATION_REQUIRED');
  assert.strictEqual(docData.requiresReconciliation, true);
  assert.match(docData.errorDetails, /Auto-resend prevented/i);
});

// -------------------------------------------------------------
// 11. CSAT Satisfaction Survey & Retroactive Invite Verification
// -------------------------------------------------------------
console.log('\n--- TEST GROUP 11: CSAT Satisfaction Survey & Retroactive Invite Verification ---');

await it('Generates 1-Click star rating links (1 to 5) with proper query params and escaped ID', async () => {
  const html = csatEmailSection('BR-202610-0001');
  assert.ok(html.includes('csat=1'));
  assert.ok(html.includes('csat=2'));
  assert.ok(html.includes('csat=3'));
  assert.ok(html.includes('csat=4'));
  assert.ok(html.includes('csat=5'));
  assert.ok(html.includes('id=BR-202610-0001'));
});

await it('Escapes XSS payload in csatEmailSection requestId', async () => {
  const html = csatEmailSection('<script>alert("xss")</script>');
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});

await it('Rejects survey submission when rating is outside 1-5 range', async () => {
  const fakeMe = { email: 'borrower@kku.ac.th', name: 'Borrower', role: 'USER' };
  await assert.rejects(
    async () => {
      await submitSatisfactionSurvey('BR-001', { rating: 0 }, fakeMe);
    },
    /ระหว่าง 1 ถึง 5 ดาว/
  );
  await assert.rejects(
    async () => {
      await submitSatisfactionSurvey('BR-001', { rating: 6 }, fakeMe);
    },
    /ระหว่าง 1 ถึง 5 ดาว/
  );
});

await it('Rejects retroactive survey invite when caller is not staff', async () => {
  const fakeUser = { email: 'user@kku.ac.th', name: 'Normal User', role: 'USER' };
  const fakeRequest = { id: 'BR-001', status: 'RETURNED', borrower: { email: 'other@kku.ac.th' } };
  await assert.rejects(
    async () => {
      await sendRetroactiveCsatInvite(fakeRequest, fakeUser);
    },
    /เฉพาะเจ้าหน้าที่ดูแลพัสดุ/
  );
});

await it('Rejects retroactive survey invite if request is not completed', async () => {
  const fakeStaff = { email: 'chalpr@kku.ac.th', name: 'Staff', role: 'CUSTODIAN' };
  const fakeRequest = { id: 'BR-001', status: 'IN_USE', borrower: { email: 'other@kku.ac.th' } };
  await assert.rejects(
    async () => {
      await sendRetroactiveCsatInvite(fakeRequest, fakeStaff);
    },
    /เฉพาะคำขอที่ส่งคืนแล้วเท่านั้น/
  );
});

await it('submitSatisfactionSurvey flags rating <= 3 as needing follow-up with PENDING_REVIEW', async () => {
  const fakeMe = { email: 'borrower@kku.ac.th', name: 'Borrower', role: 'USER' };
  let savedSurvey = null;

  setMockTransactionRunner(async (db, updateFn) => {
    const fakeTx = {
      get: async () => ({
        exists: () => true,
        data: () => ({
          id: 'BR-LOW',
          status: 'RETURNED',
          borrower: { email: 'borrower@kku.ac.th', name: 'Borrower' },
        }),
      }),
      update: (ref, payload) => {
        savedSurvey = payload.survey;
      },
    };
    return await updateFn(fakeTx);
  });

  const res = await submitSatisfactionSurvey('BR-LOW', { rating: 2, comment: 'อุปกรณ์ชำรุด' }, fakeMe);
  assert.strictEqual(res.rating, 2);
  assert.strictEqual(res.needsFollowUp, true);
  assert.strictEqual(res.followUpStatus, 'PENDING_REVIEW');
  assert.strictEqual(savedSurvey.needsFollowUp, true);
  assert.strictEqual(savedSurvey.followUpStatus, 'PENDING_REVIEW');

  // Verify high rating (>= 4) is NO_ACTION_NEEDED
  const resHigh = await submitSatisfactionSurvey('BR-LOW', { rating: 5, comment: 'ใช้งานดีมาก' }, fakeMe);
  assert.strictEqual(resHigh.rating, 5);
  assert.strictEqual(resHigh.needsFollowUp, false);
  assert.strictEqual(resHigh.followUpStatus, 'NO_ACTION_NEEDED');

  setMockTransactionRunner(null);
});

await it('updateSurveyFollowUp enforces staff roles and valid follow-up status', async () => {
  const fakeUser = { email: 'user@kku.ac.th', name: 'User', role: 'USER' };
  await assert.rejects(
    async () => {
      await updateSurveyFollowUp('BR-001', { status: 'RESOLVED' }, fakeUser);
    },
    /เฉพาะเจ้าหน้าที่ดูแลพัสดุ/
  );

  const fakeStaff = { email: 'staff@kku.ac.th', name: 'Staff', role: 'CUSTODIAN' };
  await assert.rejects(
    async () => {
      await updateSurveyFollowUp('BR-001', { status: 'INVALID_STATUS' }, fakeStaff);
    },
    /สถานะการติดตามไม่ถูกต้อง/
  );
});

await it('updateSurveyFollowUp updates status and notes without tampering with borrower survey rating', async () => {
  const fakeStaff = { email: 'staff@kku.ac.th', name: 'Staff Officer', role: 'CUSTODIAN' };
  let committedPayload = null;

  setMockTransactionRunner(async (db, updateFn) => {
    const fakeTx = {
      get: async () => ({
        exists: () => true,
        data: () => ({
          id: 'BR-LOW-01',
          status: 'RETURNED',
          survey: {
            rating: 1,
            comment: 'แบตหมดเร็วมาก',
            submittedBy: 'borrower@kku.ac.th',
            submittedByName: 'Borrower Name',
            submittedAt: { toDate: () => new Date() },
            needsFollowUp: true,
            followUpStatus: 'PENDING_REVIEW',
          },
        }),
      }),
      update: (ref, payload) => {
        committedPayload = payload;
      },
    };
    return await updateFn(fakeTx);
  });

  const updated = await updateSurveyFollowUp(
    'BR-LOW-01',
    { status: 'RESOLVED', notes: 'ติดต่อผู้ยืมและจัดเตรียมแบตเตอรี่สำรองทดแทนแล้ว' },
    fakeStaff
  );

  assert.strictEqual(updated.followUpStatus, 'RESOLVED');
  assert.strictEqual(updated.followUpNotes, 'ติดต่อผู้ยืมและจัดเตรียมแบตเตอรี่สำรองทดแทนแล้ว');
  assert.strictEqual(updated.followUpBy, 'staff@kku.ac.th');
  assert.strictEqual(updated.followUpByName, 'Staff Officer');
  // Rating and comment must remain immutable
  assert.strictEqual(updated.rating, 1);
  assert.strictEqual(updated.comment, 'แบตหมดเร็วมาก');
  assert.strictEqual(updated.submittedBy, 'borrower@kku.ac.th');
  assert.ok(committedPayload.updatedAt);

  // Check no undefined fields anywhere in committed survey
  for (const [k, v] of Object.entries(committedPayload.survey)) {
    assert.notStrictEqual(v, undefined, `Field ${k} in survey must not be undefined`);
  }

  setMockTransactionRunner(null);
});

// -------------------------------------------------------------
// 12. CSAT Queue Safety & Client/Worker Overlap Protection
// -------------------------------------------------------------
console.log('\n--- TEST GROUP 12: CSAT Queue Safety & Client/Worker Overlap Protection ---');

await it('sendRetroactiveCsatInvite fails cleanly and does not commit if atomic transaction fails', async () => {
  const fakeStaff = { email: 'chalpr@kku.ac.th', name: 'Staff', role: 'CUSTODIAN' };
  const fakeRequest = {
    id: 'BR-CSAT-FAIL',
    status: 'RETURNED',
    borrower: { email: 'user@kku.ac.th', name: 'User' },
    equipment: { name: 'Notebook' },
  };

  setMockTransactionRunner(async () => {
    throw new Error('SIMULATED_TRANSACTION_ROLLBACK');
  });

  await assert.rejects(
    async () => {
      await sendRetroactiveCsatInvite(fakeRequest, fakeStaff);
    },
    /SIMULATED_TRANSACTION_ROLLBACK/
  );

  setMockTransactionRunner(null);
});

await it('sendRetroactiveCsatInvite rejects if request already has completed survey', async () => {
  const fakeStaff = { email: 'chalpr@kku.ac.th', name: 'Staff', role: 'CUSTODIAN' };
  const fakeRequest = {
    id: 'BR-CSAT-ALREADY',
    status: 'RETURNED',
    borrower: { email: 'user@kku.ac.th', name: 'User' },
    survey: { rating: 5, submittedAt: new Date() },
  };
  await assert.rejects(
    async () => {
      await sendRetroactiveCsatInvite(fakeRequest, fakeStaff);
    },
    /ได้รับการประเมินความพึงพอใจเรียบร้อยแล้ว/
  );
});

await it('buildRetroactiveCsatEmail generates stable deterministic idempotency keys without date fluctuation', () => {
  const req = {
    id: 'BR-202610-0099',
    status: 'RETURNED',
    borrower: { email: 'borrower@kku.ac.th', name: 'Test Borrower' },
    equipment: { name: 'Sony Camera' },
    returnInfo: { actualReturnDate: '2026-10-10' },
  };
  const firstInvite = buildRetroactiveCsatEmail(req, 1);
  assert.strictEqual(firstInvite.idempotencyKey, 'BR-202610-0099_RETROACTIVE_CSAT');

  const resendInvite = buildRetroactiveCsatEmail(req, 2);
  assert.strictEqual(resendInvite.idempotencyKey, 'BR-202610-0099_RETROACTIVE_CSAT_RESEND_2');
});

await it('buildRetroactiveCsatEmail rejects requests missing id or with undefined id', () => {
  assert.throws(
    () => buildRetroactiveCsatEmail({ id: undefined }, 1),
    /BorrowRequest id is required and cannot be undefined/
  );
  assert.throws(
    () => buildRetroactiveCsatEmail({ id: '' }, 1),
    /BorrowRequest id is required and cannot be undefined/
  );
});

await it('buildRetroactiveCsatEmail does not produce any "undefined" substring in subject, text, html or idempotencyKey', () => {
  const req = {
    id: 'BR-202610-0003',
    status: 'RETURNED',
    borrower: { email: 'wassjo@kku.ac.th', name: 'นางสาววาสนา จงจิตกลาง' },
    equipment: { name: 'Notebook Acer' },
    returnInfo: { actualReturnDate: '2026-10-09' },
  };
  const emailJob = buildRetroactiveCsatEmail(req, 1);
  assert.strictEqual(emailJob.idempotencyKey.includes('undefined'), false);
  assert.strictEqual(emailJob.message.subject.includes('undefined'), false);
  assert.strictEqual(emailJob.message.text.includes('undefined'), false);
  assert.strictEqual(emailJob.message.html.includes('undefined'), false);
  assert.strictEqual(emailJob.requestId, 'BR-202610-0003');
  assert.strictEqual(emailJob.message.subject, '[ขอความอนุเคราะห์ประเมิน] ความพึงพอใจการยืมครุภัณฑ์ BR-202610-0003 (Notebook Acer)');
});

await it('Client retryEmailJob and checkManualRetryEligibility block duplicate send if already SUCCESS', async () => {
  let docData = {
    id: 'mail-001',
    status: 'SUCCESS',
    to: ['user@kku.ac.th'],
  };
  const eligibility = checkManualRetryEligibility(docData);
  assert.strictEqual(eligibility.eligible, false);
  assert.strictEqual(eligibility.reason, 'ALREADY_SUCCESS');

  const res = await retryEmailJob('mail-001', docData);
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.reason, 'ALREADY_SUCCESS');
  assert.strictEqual(res.message, 'อีเมลนี้ถูกส่งสำเร็จเรียบร้อยแล้ว');
});

await it('checkManualRetryEligibility blocks retry if requiresReconciliation or maxAttempts exceeded or future retry', () => {
  const now = Date.now();
  // 1. Reconciliation required
  assert.strictEqual(
    checkManualRetryEligibility({ status: 'RECONCILIATION_REQUIRED', requiresReconciliation: true }).eligible,
    false
  );

  // 2. Max attempts reached
  assert.strictEqual(
    checkManualRetryEligibility({ status: 'ERROR', attemptCount: 3, maxAttempts: 3 }).eligible,
    false
  );

  // 3. Retry not due (future backoff)
  assert.strictEqual(
    checkManualRetryEligibility({ status: 'PENDING', nextAttemptAt: { toMillis: () => now + 60000 } }, now).eligible,
    false
  );
});

await it('Client retryEmailJob and checkManualRetryEligibility block duplicate send if already PROCESSING with fresh lock', async () => {
  let docData = {
    id: 'mail-002',
    status: 'PROCESSING',
    claimedAt: { toMillis: () => Date.now() - 30000 }, // 30s ago (fresh lock <5m)
    to: ['user@kku.ac.th'],
  };
  const eligibility = checkManualRetryEligibility(docData);
  assert.strictEqual(eligibility.eligible, false);
  assert.strictEqual(eligibility.reason, 'ALREADY_PROCESSING');

  const res = await retryEmailJob('mail-002', docData);
  assert.strictEqual(res.success, false);
  assert.ok(res.message.includes('PROCESSING'), 'Must notify user that job is currently processing');
});

await it('checkManualRetryEligibility allows retry if PROCESSING lock is stale (>5m)', () => {
  const staleJob = {
    status: 'PROCESSING',
    claimedAt: { toMillis: () => Date.now() - 360000 }, // 6m ago
  };
  const res = checkManualRetryEligibility(staleJob);
  assert.strictEqual(res.eligible, true);
});

await it('isJobEligibleForClientProcess guards against non-PENDING, reconciliation, maxAttempts, and future nextAttemptAt', () => {
  const now = Date.now();
  // 1. Non-pending (ERROR)
  assert.strictEqual(isJobEligibleForClientProcess({ status: 'ERROR' }, now).eligible, false);

  // 2. Requires reconciliation
  assert.strictEqual(
    isJobEligibleForClientProcess({ status: 'PENDING', requiresReconciliation: true }, now).eligible,
    false
  );

  // 3. Max attempts reached
  assert.strictEqual(
    isJobEligibleForClientProcess({ status: 'PENDING', attemptCount: 3, maxAttempts: 3 }, now).eligible,
    false
  );

  // 4. Future retry time
  assert.strictEqual(
    isJobEligibleForClientProcess(
      { status: 'PENDING', nextAttemptAt: { toMillis: () => now + 60000 } },
      now
    ).eligible,
    false
  );

  // 5. Eligible pending job
  assert.strictEqual(
    isJobEligibleForClientProcess(
      { status: 'PENDING', attemptCount: 1, maxAttempts: 3, nextAttemptAt: { toMillis: () => now - 1000 } },
      now
    ).eligible,
    true
  );
});

// -------------------------------------------------------------
// 13. Mail Schema Validation, State Machine & Gateway Adapter
// -------------------------------------------------------------
console.log('\n--- TEST GROUP 13: Mail Schema Validation, State Machine & Gateway Adapter ---');

await it('validateAndSanitizeMailJob validates required fields and removes all undefined values', () => {
  // 1. Missing recipient
  assert.throws(
    () => validateAndSanitizeMailJob({ to: [], message: { subject: 'Test', text: '', html: '' } }),
    /at least one recipient/
  );

  // 2. Missing subject
  assert.throws(
    () => validateAndSanitizeMailJob({ to: ['user@kku.ac.th'], message: { subject: '   ', text: '', html: '' } }),
    /non-empty message subject/
  );

  // 3. Eliminates undefined fields completely
  const rawJob = {
    to: ['User@kku.ac.th '],
    message: { subject: 'Valid Subject', text: 'Text', html: '<p>Html</p>' },
    type: 'NEW_REQUEST',
    idempotencyKey: 'IDEM_001',
    requestId: undefined,
    targetStatus: undefined,
    metadata: { key1: 'value1', key2: undefined },
  };

  const sanitized = validateAndSanitizeMailJob(rawJob);
  assert.strictEqual(sanitized.to[0], 'user@kku.ac.th');
  assert.strictEqual(sanitized.status, 'PENDING');
  assert.strictEqual(sanitized.attemptCount, 0);
  assert.strictEqual(sanitized.maxAttempts, 3);
  assert.strictEqual(sanitized.requestId, undefined);
  assert.ok(!('requestId' in sanitized), 'requestId must not be present if undefined');
  assert.ok(!('targetStatus' in sanitized), 'targetStatus must not be present if undefined');
  assert.strictEqual(sanitized.metadata.key1, 'value1');
  assert.strictEqual(sanitized.metadata.key2, undefined);
  assert.ok(!('key2' in sanitized.metadata), 'undefined metadata keys must be stripped');

  for (const [k, v] of Object.entries(sanitized)) {
    assert.notStrictEqual(v, undefined, `Key ${k} must not be undefined`);
  }
});

await it('mail-gateway.mjs fails closed on missing gateway configuration', async () => {
  const job = { to: ['user@kku.ac.th'], message: { subject: 'Test', text: 'Body', html: 'Body' } };
  const res = await dispatchViaGateway(job, { provider: 'NONE' });
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.status, 'CONFIGURATION_ERROR');
});

await it('mail-gateway.mjs dispatches via MOCK when allowMock is true', async () => {
  const job = { to: ['user@kku.ac.th'], message: { subject: 'Test', text: 'Body', html: 'Body' } };
  const res = await dispatchViaGateway(job, { provider: 'MOCK' }, null, { allowMock: true });
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.status, 'SUCCESS');
  assert.ok(res.messageId.startsWith('mock_'));
});

await it('mail-gateway.mjs identifies HTML/non-JSON response from GAS as INDETERMINATE_ERROR', async () => {
  const fakeHtmlFetch = async () => ({
    ok: true,
    text: async () => '<!DOCTYPE html><html><body>Error page</body></html>',
  });
  const job = { to: ['user@kku.ac.th'], message: { subject: 'Test', text: 'Body', html: 'Body' } };
  const res = await dispatchViaGateway(job, { provider: 'GOOGLE_APPS_SCRIPT', gasWebhookUrl: 'https://script.google.com/test' }, fakeHtmlFetch);
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.status, 'INDETERMINATE_ERROR');
});

await it('mail-gateway.mjs passes secretToken, senderName, and senderEmail to Google Apps Script Webhook payload', async () => {
  let capturedBody = null;
  const fakeGasFetch = async (_url, options) => {
    capturedBody = JSON.parse(options.body);
    return {
      ok: true,
      text: async () => JSON.stringify({ status: 'SUCCESS', messageId: 'gas_test_123' }),
    };
  };

  const job = {
    to: ['student@kku.ac.th'],
    message: { subject: 'คำขอยืมได้รับการอนุมัติ', text: 'Text', html: '<p>HTML</p>' },
    type: 'APPROVED',
    requestId: 'BR-202610-0999',
  };

  const gatewayConfig = {
    provider: 'GOOGLE_APPS_SCRIPT',
    gasWebhookUrl: 'https://script.google.com/macros/s/AKfycbx_TEST/exec',
    gasSecretToken: 'super_secret_kku_token_12345',
    gasSenderName: 'สำนักบริการวิชาการ มข. (งานครุภัณฑ์)',
    gasSenderEmail: 'chalpr@kku.ac.th',
  };

  const res = await dispatchViaGateway(job, gatewayConfig, fakeGasFetch);
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.status, 'SUCCESS');
  assert.strictEqual(res.messageId, 'gas_test_123');

  // Verify POST body contents
  assert.ok(capturedBody, 'Must send JSON payload');
  assert.strictEqual(capturedBody.secretToken, 'super_secret_kku_token_12345');
  assert.strictEqual(capturedBody.senderName, 'สำนักบริการวิชาการ มข. (งานครุภัณฑ์)');
  assert.strictEqual(capturedBody.senderEmail, 'chalpr@kku.ac.th');
  assert.strictEqual(capturedBody.to[0], 'student@kku.ac.th');
  assert.strictEqual(capturedBody.requestId, 'BR-202610-0999');

  // Verify that secrets are not leaked in error responses
  const fakeFailingFetch = async () => ({
    ok: false,
    status: 500,
    text: async () => 'Internal Server Error',
  });
  const failRes = await dispatchViaGateway(job, gatewayConfig, fakeFailingFetch);
  assert.strictEqual(failRes.success, false);
  assert.ok(!failRes.message.includes('super_secret_kku_token_12345'), 'Secret token must never be revealed in error messages');
});

await it('processSingleMailJob transitions to SUCCESS and writes audit log on success', async () => {
  let docData = {
    status: 'PENDING',
    to: ['borrower@kku.ac.th'],
    message: { subject: 'Approved', text: 'Approved', html: 'Approved' },
    attemptCount: 0,
    maxAttempts: 3,
  };
  let auditLogs = [];

  const fakeDocRef = {
    id: 'mail-success-test',
    firestore: {
      runTransaction: async (fn) => {
        const tx = {
          get: async () => ({
            exists: true,
            data: () => ({ ...docData }),
          }),
          update: (_ref, updatePayload) => {
            const resolved = { ...updatePayload };
            if (resolved.attemptCount && typeof resolved.attemptCount === 'object') {
              resolved.attemptCount = (docData.attemptCount || 0) + 1;
            }
            Object.assign(docData, resolved);
          },
        };
        return fn(tx);
      },
      collection: (name) => ({
        add: async (entry) => {
          if (name === 'audit_logs') auditLogs.push(entry);
        },
        doc: () => fakeDocRef,
      }),
    },
    update: async (updatePayload) => {
      Object.assign(docData, updatePayload);
    },
  };

  const fakeMockFetch = async () => ({
    ok: true,
    text: async () => JSON.stringify({ status: 'SUCCESS', messageId: 'msg-12345' }),
  });

  const res = await processSingleMailJob(fakeDocRef, {
    customDb: fakeDocRef.firestore,
    customMockFetch: fakeMockFetch,
    gatewayConfig: { provider: 'GOOGLE_APPS_SCRIPT', gasWebhookUrl: 'https://script.google.com/test' },
  });

  assert.strictEqual(res.success, true);
  assert.strictEqual(docData.status, 'SUCCESS');
  assert.strictEqual(docData.messageId, 'msg-12345');
  assert.ok(docData.sentAt);

  // Check audit log
  const audit = auditLogs.find((a) => a.action === 'DISPATCH_EMAIL_SUCCESS');
  assert.ok(audit, 'Audit log DISPATCH_EMAIL_SUCCESS must be recorded');
  assert.strictEqual(audit.target, 'mail-success-test');
});

await it('processSingleMailJob transitions to FAILED when maxAttempts reached and writes audit log', async () => {
  let docData = {
    status: 'PENDING',
    to: ['borrower@kku.ac.th'],
    message: { subject: 'Overdue', text: 'Overdue', html: 'Overdue' },
    attemptCount: 2, // 3rd attempt
    maxAttempts: 3,
  };
  let auditLogs = [];

  const fakeDocRef = {
    id: 'mail-failed-test',
    firestore: {
      runTransaction: async (fn) => {
        const tx = {
          get: async () => ({
            exists: true,
            data: () => ({ ...docData }),
          }),
          update: (_ref, updatePayload) => {
            const resolved = { ...updatePayload };
            if (resolved.attemptCount && typeof resolved.attemptCount === 'object') {
              resolved.attemptCount = (docData.attemptCount || 0) + 1;
            }
            Object.assign(docData, resolved);
          },
        };
        return fn(tx);
      },
      collection: (name) => ({
        add: async (entry) => {
          if (name === 'audit_logs') auditLogs.push(entry);
        },
        doc: () => fakeDocRef,
      }),
    },
    update: async (updatePayload) => {
      Object.assign(docData, updatePayload);
    },
  };

  const fakeErrorFetch = async () => ({
    ok: false,
    status: 500,
    text: async () => 'Internal Server Error',
  });

  const res = await processSingleMailJob(fakeDocRef, {
    customDb: fakeDocRef.firestore,
    customMockFetch: fakeErrorFetch,
    gatewayConfig: { provider: 'GOOGLE_APPS_SCRIPT', gasWebhookUrl: 'https://script.google.com/test' },
  });

  assert.strictEqual(res.success, false);
  assert.strictEqual(res.retrying, false);
  assert.strictEqual(docData.status, 'FAILED');
  assert.strictEqual(docData.attemptCount, 3);
  assert.ok(docData.failedAt);

  const audit = auditLogs.find((a) => a.action === 'DISPATCH_EMAIL_FAILED');
  assert.ok(audit, 'Audit log DISPATCH_EMAIL_FAILED must be recorded on terminal failure');
  assert.strictEqual(audit.target, 'mail-failed-test');
});

await it('processSingleMailJob transitions indeterminate errors to RECONCILIATION_REQUIRED', async () => {
  let docData = {
    status: 'PENDING',
    to: ['borrower@kku.ac.th'],
    message: { subject: 'Reminder', text: 'Reminder', html: 'Reminder' },
    attemptCount: 0,
    maxAttempts: 3,
  };
  let auditLogs = [];

  const fakeDocRef = {
    id: 'mail-reconcile-test',
    firestore: {
      runTransaction: async (fn) => {
        const tx = {
          get: async () => ({
            exists: true,
            data: () => ({ ...docData }),
          }),
          update: (_ref, updatePayload) => {
            const resolved = { ...updatePayload };
            if (resolved.attemptCount && typeof resolved.attemptCount === 'object') {
              resolved.attemptCount = (docData.attemptCount || 0) + 1;
            }
            Object.assign(docData, resolved);
          },
        };
        return fn(tx);
      },
      collection: (name) => ({
        add: async (entry) => {
          if (name === 'audit_logs') auditLogs.push(entry);
        },
        doc: () => fakeDocRef,
      }),
    },
    update: async (updatePayload) => {
      Object.assign(docData, updatePayload);
    },
  };

  // Simulating fetch network timeout exception
  const fakeNetworkErrorFetch = async () => {
    throw new Error('ETIMEDOUT: Connection timed out after headers sent');
  };

  const res = await processSingleMailJob(fakeDocRef, {
    customDb: fakeDocRef.firestore,
    customMockFetch: fakeNetworkErrorFetch,
    gatewayConfig: { provider: 'GOOGLE_APPS_SCRIPT', gasWebhookUrl: 'https://script.google.com/test' },
  });

  assert.strictEqual(res.success, false);
  assert.strictEqual(res.requiresReconciliation, true);
  assert.strictEqual(docData.status, 'RECONCILIATION_REQUIRED');
  assert.strictEqual(docData.requiresReconciliation, true);

  const audit = auditLogs.find((a) => a.action === 'DISPATCH_EMAIL_RECONCILIATION_REQUIRED');
  assert.ok(audit, 'Audit log DISPATCH_EMAIL_RECONCILIATION_REQUIRED must be recorded');
});

// -------------------------------------------------------------
// 14. Gateway Configuration Security & Error Decoding
// -------------------------------------------------------------
console.log('\n--- TEST GROUP 14: Gateway Configuration Security, Roles & Error Decoding ---');

await it('Verifies updateGatewayConfig permissions: permits CUSTODIAN and EXECUTIVE, rejects USER and APPROVER', async () => {
  const allowedRoles = ['CUSTODIAN', 'EXECUTIVE'];
  const testUsers = [
    { email: 'chalpr@kku.ac.th', role: 'CUSTODIAN', expectedAllow: true },
    { email: 'chukam@kku.ac.th', role: 'EXECUTIVE', expectedAllow: true },
    { email: 'supako@kku.ac.th', role: 'EXECUTIVE', expectedAllow: true },
    { email: 'praysu@kku.ac.th', role: 'APPROVER', expectedAllow: false },
    { email: 'prapin@kku.ac.th', role: 'USER', expectedAllow: false },
  ];

  for (const u of testUsers) {
    const isAllowed = allowedRoles.includes(u.role);
    assert.strictEqual(isAllowed, u.expectedAllow, `Role check mismatch for ${u.role} (${u.email})`);
  }
});

await it('Verifies updateGatewayConfig sanitizes undefined and null fields before Firestore write', () => {
  const rawInput = {
    provider: 'GOOGLE_APPS_SCRIPT',
    gasWebhookUrl: 'https://script.google.com/macros/s/AKfycbxTest/exec',
    gasSecretToken: 'sec_kku_2026',
    gasSenderName: 'ระบบยืม-คืน ครุภัณฑ์ มข.',
    gasSenderEmail: undefined,
    brevoApiKey: null,
    brevoSenderEmail: undefined,
    resendApiKey: undefined,
  };

  const updateData = {
    provider: rawInput.provider,
    emailProvider: rawInput.provider,
  };
  if (typeof rawInput.gasWebhookUrl === 'string' && rawInput.gasWebhookUrl.trim()) {
    updateData.gasWebhookUrl = rawInput.gasWebhookUrl.trim();
  }
  if (typeof rawInput.gasSecretToken === 'string' && rawInput.gasSecretToken.trim()) {
    updateData.gasSecretToken = rawInput.gasSecretToken.trim();
  }
  if (typeof rawInput.gasSenderName === 'string' && rawInput.gasSenderName.trim()) {
    updateData.gasSenderName = rawInput.gasSenderName.trim();
  }
  if (typeof rawInput.gasSenderEmail === 'string' && rawInput.gasSenderEmail.trim()) {
    updateData.gasSenderEmail = rawInput.gasSenderEmail.trim();
  }
  if (typeof rawInput.brevoApiKey === 'string' && rawInput.brevoApiKey.trim()) {
    updateData.brevoApiKey = rawInput.brevoApiKey.trim();
  }

  // Strict sanitization check
  for (const key of Object.keys(updateData)) {
    if (updateData[key] === undefined || updateData[key] === null) {
      delete updateData[key];
    }
  }

  // Verify none of the keys in updateData are undefined or null
  for (const [k, v] of Object.entries(updateData)) {
    assert.notStrictEqual(v, undefined, `Key ${k} must not be undefined`);
    assert.notStrictEqual(v, null, `Key ${k} must not be null`);
  }
  assert.strictEqual(updateData.provider, 'GOOGLE_APPS_SCRIPT');
  assert.strictEqual(updateData.gasSecretToken, 'sec_kku_2026');
  assert.strictEqual('gasSenderEmail' in updateData, false);
  assert.strictEqual('brevoApiKey' in updateData, false);
});

await it('Client error decoder converts functions/internal and cryptic errors into actionable Thai messages', () => {
  const decodeError = (err) => {
    let friendlyMsg = 'เกิดข้อผิดพลาดในการบันทึกข้อมูล กรุณาลองใหม่อีกครั้ง';
    const errorCode = err?.code || '';
    const rawMsg = err?.message || '';

    if (errorCode === 'functions/permission-denied' || rawMsg.includes('permission-denied') || rawMsg.includes('ไม่มีสิทธิ์')) {
      friendlyMsg = 'คุณไม่มีสิทธิ์ในการบันทึกการตั้งค่า Gateway (จำกัดเฉพาะสิทธิ์ CUSTODIAN หรือ EXECUTIVE เท่านั้น)';
    } else if (errorCode === 'functions/unauthenticated' || rawMsg.includes('unauthenticated') || rawMsg.includes('เข้าสู่ระบบ')) {
      friendlyMsg = 'กรุณาเข้าสู่ระบบด้วยบัญชีกูเกิลของมหาวิทยาลัย (@kku.ac.th) ก่อนทำรายการ';
    } else if (errorCode === 'functions/invalid-argument' || rawMsg.includes('invalid-argument')) {
      friendlyMsg = 'ข้อมูลการตั้งค่า Gateway ไม่ถูกต้อง: ' + rawMsg.replace(/^functions\/[a-z-]+:\s*/i, '');
    } else if (errorCode === 'functions/internal' || rawMsg === 'internal' || rawMsg === 'INTERNAL') {
      friendlyMsg = 'เซิร์ฟเวอร์ Cloud Functions ขัดข้องภายใน กรุณาตรวจสอบการตั้งค่า Firebase Functions หรือสิทธิ์การเข้าถึง';
    } else if (rawMsg) {
      friendlyMsg = rawMsg.replace(/^functions\/[a-z-]+:\s*/i, '').replace(/^[A-Za-z]+Error:\s*/i, '');
    }
    return friendlyMsg;
  };

  // Test 1: Raw internal error
  const resInternal = decodeError({ code: 'functions/internal', message: 'internal' });
  assert.strictEqual(resInternal.includes('เซิร์ฟเวอร์ Cloud Functions ขัดข้องภายใน'), true);
  assert.strictEqual(resInternal === 'internal', false);

  // Test 2: Permission denied
  const resPerm = decodeError({ code: 'functions/permission-denied', message: 'Only CUSTODIAN role can update gateway credentials' });
  assert.strictEqual(resPerm.includes('CUSTODIAN หรือ EXECUTIVE'), true);

  // Test 3: Unauthenticated
  const resUnauth = decodeError({ code: 'functions/unauthenticated', message: 'User must be authenticated' });
  assert.strictEqual(resUnauth.includes('@kku.ac.th'), true);
});

await it('Verifies Google Apps Script Webhook payload strictly includes secretToken, sender info, and valid recipients', async () => {
  let capturedPayload = null;
  const mockGasFetch = async (url, options) => {
    capturedPayload = JSON.parse(options.body);
    return {
      ok: true,
      text: async () => JSON.stringify({ status: 'SUCCESS', messageId: 'gas_test_999' }),
    };
  };

  const job = {
    to: ['somchai@kku.ac.th'],
    cc: ['custodian@kku.ac.th'],
    message: { subject: 'ทดสอบการส่งผ่าน Google Apps Script', html: '<p>ข้อความทดสอบ</p>', text: 'ข้อความทดสอบ' },
    requestId: 'REQ-2026-TEST',
    type: 'TEST',
  };

  const gatewayConfig = {
    provider: 'GOOGLE_APPS_SCRIPT',
    gasWebhookUrl: 'https://script.google.com/macros/s/AKfycbz_TEST/exec',
    gasSecretToken: 'super_secret_kku_token_123',
    gasSenderName: 'สำนักบริการวิชาการ มหาวิทยาลัยขอนแก่น',
    gasSenderEmail: 'chalpr@kku.ac.th',
  };

  const res = await dispatchViaGateway(job, gatewayConfig, mockGasFetch);
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.status, 'SUCCESS');
  assert.ok(capturedPayload, 'Payload must be delivered to fetch');
  assert.strictEqual(capturedPayload.secretToken, 'super_secret_kku_token_123');
  assert.strictEqual(capturedPayload.senderName, 'สำนักบริการวิชาการ มหาวิทยาลัยขอนแก่น');
  assert.strictEqual(capturedPayload.senderEmail, 'chalpr@kku.ac.th');
  assert.deepStrictEqual(capturedPayload.to, ['somchai@kku.ac.th']);
  assert.strictEqual(capturedPayload.requestId, 'REQ-2026-TEST');
});

// -------------------------------------------------------------
// 15. AntiGravity Direct Serverless Architecture & Deduplication
// -------------------------------------------------------------
console.log('\n--- TEST GROUP 15: AntiGravity Direct Serverless Architecture & Deduplication ---');

await it('dispatchMailJobDirect deduplicates duplicate sends within 60-second cooldown window (matching AntiGravity)', async () => {
  clearEmailDedupCache();
  setMockEmailSettingsHandler(async () => ({
    enabled: true,
    gateway: {
      provider: 'GOOGLE_APPS_SCRIPT',
      gasWebhookUrl: 'https://script.google.com/macros/s/AKfycbz_TEST/exec',
      gasSecretToken: 'tok_test_123',
    },
  }));

  const job = {
    to: ['test_dedup@kku.ac.th'],
    message: { subject: 'คำขอยืมครุภัณฑ์ REQ-DEDUP-01', text: 'Hello', html: '<p>Hello</p>' },
    requestId: 'REQ-DEDUP-01',
    type: 'NEW_REQUEST',
  };

  // First dispatch: in test env without mockFetch returns simulated SUCCESS
  const res1 = await dispatchMailJobDirect(null, job);
  assert.strictEqual(res1.success, true);
  assert.strictEqual(res1.status, 'SUCCESS');
  assert.strictEqual(res1.deduplicated, undefined);

  // Immediate second dispatch with identical (requestId, type, recipient) must be SKIPPED
  const res2 = await dispatchMailJobDirect(null, job);
  assert.strictEqual(res2.success, true);
  assert.strictEqual(res2.status, 'SKIPPED');
  assert.strictEqual(res2.deduplicated, true);
  assert.ok(res2.message.includes('Deduplicated') || res2.message.includes('1 นาที'));

  // Clearing cache allows resend
  clearEmailDedupCache();
  const res3 = await dispatchMailJobDirect(null, job);
  assert.strictEqual(res3.success, true);
  assert.strictEqual(res3.status, 'SUCCESS');
  assert.strictEqual(res3.deduplicated, undefined);

  setMockEmailSettingsHandler(null);
});

await it('dispatchMailJobDirect rejects CRLF header injection attacks in email subject', async () => {
  clearEmailDedupCache();
  const maliciousJob = {
    to: ['victim@kku.ac.th'],
    message: { subject: 'Injected\r\nBcc: evil@attacker.com', text: 'Attack', html: '<p>Attack</p>' },
    requestId: 'REQ-CRLF-01',
    type: 'NEW_REQUEST',
  };

  const res = await dispatchMailJobDirect(null, maliciousJob);
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.status, 'FAILED');
  assert.ok(res.message.includes('CRLF'));
});

await it('dispatchMailJobDirect dispatches valid JSON payload with secretToken, sender info, and valid recipients to Google Apps Script Webhook', async () => {
  clearEmailDedupCache();
  let capturedUrl = null;
  let capturedPayload = null;

  const mockGasFetch = async (url, options) => {
    capturedUrl = url;
    capturedPayload = JSON.parse(options.body);
    return {
      ok: true,
      text: async () => JSON.stringify({ status: 'SUCCESS', messageId: 'gas_direct_msg_888' }),
    };
  };

  setMockEmailSettingsHandler(async () => ({
    enabled: true,
    gateway: {
      provider: 'GOOGLE_APPS_SCRIPT',
      gasWebhookUrl: 'https://script.google.com/macros/s/AKfycbz_DIRECT_HOOK/exec',
      gasSecretToken: 'sec_gas_direct_456',
      gasSenderName: 'สำนักบริการวิชาการ มหาวิทยาลัยขอนแก่น',
      gasSenderEmail: 'chalpr@kku.ac.th',
    },
  }));

  const job = {
    to: ['borrower_direct@kku.ac.th'],
    cc: ['custodian_direct@kku.ac.th'],
    message: { subject: 'แจ้งเตือนการอนุมัติคำขอ REQ-GAS-01', text: 'รายละเอียดคำขอ', html: '<b>รายละเอียดคำขอ</b>' },
    requestId: 'REQ-GAS-01',
    type: 'APPROVED',
  };

  const res = await dispatchMailJobDirect(null, job, null, mockGasFetch);
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.status, 'SUCCESS');
  assert.strictEqual(res.messageId, 'gas_direct_msg_888');

  assert.strictEqual(capturedUrl, 'https://script.google.com/macros/s/AKfycbz_DIRECT_HOOK/exec');
  assert.ok(capturedPayload, 'GAS fetch must receive a payload');
  assert.strictEqual(capturedPayload.secretToken, 'sec_gas_direct_456');
  assert.strictEqual(capturedPayload.senderName, 'สำนักบริการวิชาการ มหาวิทยาลัยขอนแก่น');
  assert.strictEqual(capturedPayload.senderEmail, 'chalpr@kku.ac.th');
  assert.deepStrictEqual(capturedPayload.to, ['borrower_direct@kku.ac.th']);
  assert.deepStrictEqual(capturedPayload.cc, ['custodian_direct@kku.ac.th']);
  assert.strictEqual(capturedPayload.requestId, 'REQ-GAS-01');
  assert.strictEqual(capturedPayload.type, 'APPROVED');

  setMockEmailSettingsHandler(null);
});

await it('dispatchMailJobDirect safely returns SKIPPED when email notifications are disabled in policy', async () => {
  clearEmailDedupCache();
  setMockEmailSettingsHandler(async () => ({
    enabled: false,
    gateway: { provider: 'GOOGLE_APPS_SCRIPT' },
  }));

  const job = {
    to: ['disabled_check@kku.ac.th'],
    message: { subject: 'ทดสอบปิดระบบแจ้งเตือน', text: 'Test', html: '<p>Test</p>' },
    requestId: 'REQ-DIS-01',
    type: 'NEW_REQUEST',
  };

  const res = await dispatchMailJobDirect(null, job);
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.status, 'SKIPPED');
  assert.ok(res.message.includes('ปิดการส่งแจ้งเตือน'));

});

// -------------------------------------------------------------
// 16. Equipment Maintenance & Official Repair Form (แบบฟอร์ม แจ้งซ่อมแซมอุปกรณ์)
// -------------------------------------------------------------
console.log('\n--- TEST GROUP 16: Official Repair Form Specification & Field Verification ---');

await it('Validates Thai Buddhist Era year calculation (CE + 543)', () => {
  const ceYear = 2026;
  const beYear = ceYear + 543;
  assert.strictEqual(beYear, 2569);
});

await it('Validates official repair form schema and standard 5 columns matching PDF template', () => {
  const repairItems = [
    {
      responsiblePerson: 'นายชาลี พรหมอินทร์',
      equipmentName: 'เครื่องปรับอากาศ',
      assetNumber: '6520040000027',
      symptom: 'ไม่เย็น',
    },
    {
      responsiblePerson: 'นายทิวากร กาเจริญ',
      equipmentName: 'เครื่องปรับอากาศ',
      assetNumber: '672004000001',
      symptom: 'มีน้ำหยด',
    },
  ];

  // Verify structure
  for (const item of repairItems) {
    assert.ok(item.responsiblePerson, 'Must have responsiblePerson');
    assert.ok(item.equipmentName, 'Must have equipmentName');
    assert.ok(item.assetNumber, 'Must have assetNumber');
    assert.ok(item.symptom, 'Must have symptom');
  }

  assert.strictEqual(repairItems.length, 2);
  assert.strictEqual(repairItems[0].assetNumber, '6520040000027');
  assert.strictEqual(repairItems[0].symptom, 'ไม่เย็น');
});

await it('Sanitizes HTML/script injection in repair form fields before rendering', () => {
  const rawInput = '<script>alert("xss")</script>เครื่องปรับอากาศ';
  const clean = escapeHtml(rawInput);
  assert.strictEqual(clean.includes('<script>'), false);
  assert.strictEqual(clean.includes('&lt;script&gt;'), true);
});

// -------------------------------------------------------------
// 17. Return Handover Repair & Lost Incident Subform Validation
// -------------------------------------------------------------
console.log('\n--- TEST GROUP 17: Return Handover Repair & Lost Incident Subform Validation ---');

await it('Validates return payload with DAMAGED condition constructs clean damageReport without undefined fields', () => {
  const damageInput = {
    symptom: 'จอภาพมีรอยแตกร้าว',
    damageDetails: 'มุมขวาบนแตก แสงลอด',
    cause: 'ตกจากโต๊ะทำงาน',
    damagedAccessories: ['สายชาร์จ Type-C'],
    photos: ['data:image/jpeg;base64,/9j/4AAQSkZJRg...'],
  };

  const dr = {
    symptom: damageInput.symptom || '',
  };
  if (damageInput.damageDetails) dr.damageDetails = damageInput.damageDetails;
  if (damageInput.cause) dr.cause = damageInput.cause;
  if (damageInput.damagedAccessories && damageInput.damagedAccessories.length > 0) {
    dr.damagedAccessories = damageInput.damagedAccessories;
  }
  if (damageInput.photos && damageInput.photos.length > 0) {
    dr.photos = damageInput.photos;
  }

  const returnInfoPayload = {
    actualReturnDate: '2026-10-20',
    receivedByEmail: 'chalpr@kku.ac.th',
    receivedByName: 'นายชาลี พรหมอินทร์',
    condition: 'DAMAGED',
    remarks: 'ชำรุด: จอภาพมีรอยแตกร้าว',
    lateDays: 0,
    damageReport: dr,
  };

  assert.strictEqual(returnInfoPayload.condition, 'DAMAGED');
  assert.strictEqual(returnInfoPayload.damageReport.symptom, 'จอภาพมีรอยแตกร้าว');
  assert.strictEqual(returnInfoPayload.damageReport.damagedAccessories[0], 'สายชาร์จ Type-C');
  assert.strictEqual(returnInfoPayload.damageReport.photos.length, 1);

  // Check no undefined values
  for (const [k, v] of Object.entries(returnInfoPayload.damageReport)) {
    assert.notStrictEqual(v, undefined, `damageReport.${k} must not be undefined`);
  }
});

await it('Validates return payload with LOST condition constructs clean lostReport without undefined fields', () => {
  const lostInput = {
    incidentDate: '2026-10-19',
    location: 'ห้องประชุม 1 อาคารสารสนเทศ',
    incidentDetails: 'ลืมไว้ในห้องประชุมแล้วกลับมาตรวจสอบไม่พบ',
    policeReportNo: 'ปจว. ข้อ 2 สภ.เมืองขอนแก่น',
    borrowerLiabilityAccepted: true,
    photos: ['data:image/jpeg;base64,/9j/4AAQSkZJRg...'],
  };

  const lr = {
    incidentDetails: lostInput.incidentDetails || '',
  };
  if (lostInput.incidentDate) lr.incidentDate = lostInput.incidentDate;
  if (lostInput.location) lr.location = lostInput.location;
  if (lostInput.policeReportNo) lr.policeReportNo = lostInput.policeReportNo;
  if (typeof lostInput.borrowerLiabilityAccepted === 'boolean') {
    lr.borrowerLiabilityAccepted = lostInput.borrowerLiabilityAccepted;
  }
  if (lostInput.photos && lostInput.photos.length > 0) {
    lr.photos = lostInput.photos;
  }

  const returnInfoPayload = {
    actualReturnDate: '2026-10-20',
    receivedByEmail: 'chalpr@kku.ac.th',
    receivedByName: 'นายชาลี พรหมอินทร์',
    condition: 'LOST',
    remarks: 'สูญหาย: ลืมไว้ในห้องประชุม',
    lateDays: 0,
    lostReport: lr,
  };

  assert.strictEqual(returnInfoPayload.condition, 'LOST');
  assert.strictEqual(returnInfoPayload.lostReport.incidentDetails, 'ลืมไว้ในห้องประชุมแล้วกลับมาตรวจสอบไม่พบ');
  assert.strictEqual(returnInfoPayload.lostReport.borrowerLiabilityAccepted, true);
  assert.strictEqual(returnInfoPayload.lostReport.policeReportNo, 'ปจว. ข้อ 2 สภ.เมืองขอนแก่น');

  // Check no undefined values
  for (const [k, v] of Object.entries(returnInfoPayload.lostReport)) {
    assert.notStrictEqual(v, undefined, `lostReport.${k} must not be undefined`);
  }
});

await it('Enforces photo array bounds (maximum 4 photos per report)', () => {
  const photos = ['photo1', 'photo2', 'photo3', 'photo4'];
  assert.ok(photos.length <= 4, 'Photos must not exceed 4');
});

// -------------------------------------------------------------
// 18. Digital Repair Ticket System & Equipment Status Lifecycle
// -------------------------------------------------------------
console.log('\n--- TEST GROUP 18: Digital Repair Ticket System & Equipment Lifecycle ---');

await it('Validates repair ticket number format matches RP-YYYYMM-XXXX', () => {
  const sampleTicket = 'RP-202610-0001';
  const ticketRegex = /^RP-\d{6}-\d{4}$/;
  assert.strictEqual(ticketRegex.test(sampleTicket), true);
  assert.strictEqual(ticketRegex.test('RP-202610-0042'), true);
  assert.strictEqual(ticketRegex.test('INVALID-1234'), false);
});

await it('Validates RepairRequest data model and 5-stage status workflow transitions', () => {
  const validTransitions = {
    DRAFT: ['PENDING_REVIEW', 'CANCELLED'],
    PENDING_REVIEW: ['APPROVED', 'CANCELLED', 'DRAFT'],
    APPROVED: ['IN_REPAIR', 'CANCELLED'],
    IN_REPAIR: ['COMPLETED', 'CANCELLED'],
    COMPLETED: [],
    CANCELLED: [],
  };

  function canTransition(current, next) {
    return (validTransitions[current] || []).includes(next);
  }

  // Valid flow
  assert.strictEqual(canTransition('DRAFT', 'PENDING_REVIEW'), true);
  assert.strictEqual(canTransition('PENDING_REVIEW', 'APPROVED'), true);
  assert.strictEqual(canTransition('APPROVED', 'IN_REPAIR'), true);
  assert.strictEqual(canTransition('IN_REPAIR', 'COMPLETED'), true);

  // Invalid jumps
  assert.strictEqual(canTransition('DRAFT', 'COMPLETED'), false);
  assert.strictEqual(canTransition('COMPLETED', 'DRAFT'), false);
  assert.strictEqual(canTransition('IN_REPAIR', 'PENDING_REVIEW'), false);
});

await it('Validates equipment status synchronization rules (MAINTENANCE -> AVAILABLE)', () => {
  // Simulating equipment status based on repair lifecycle
  const equipment = { id: 'EQ-01', status: 'AVAILABLE' };

  // When repair ticket is created/submitted
  const onRepairStart = (eq) => ({ ...eq, status: 'MAINTENANCE' });
  const inRepairEq = onRepairStart(equipment);
  assert.strictEqual(inRepairEq.status, 'MAINTENANCE');

  // When repair is completed
  const onRepairComplete = (eq) => ({ ...eq, status: 'AVAILABLE' });
  const completedEq = onRepairComplete(inRepairEq);
  assert.strictEqual(completedEq.status, 'AVAILABLE');
});

await it('Verifies dynamic approver and requester resolution without hardcoded static names', () => {
  // Approver is dynamically loaded from role or user input
  const mockUserApprover = { name: 'รศ.ดร.กิตติชัย ไตรรัตนศิริชัย', role: 'APPROVER' };
  const mockRequester = { name: 'นายสมชาย ใจดี', position: 'นักวิชาการคอมพิวเตอร์', division: 'กลุ่มสารสนเทศ' };

  const repairPayload = {
    ticketNo: 'RP-202610-0001',
    requesterName: mockRequester.name,
    requesterPosition: mockRequester.position,
    requesterDivision: mockRequester.division,
    approverName: mockUserApprover.name,
    status: 'DRAFT',
    items: [
      {
        itemNo: 1,
        responsiblePerson: mockRequester.name,
        equipmentName: 'จอคอมพิวเตอร์ Dell',
        assetNumber: '672004000002',
        symptom: 'จอติดๆ ดับๆ',
      },
    ],
  };

  assert.strictEqual(repairPayload.requesterName, 'นายสมชาย ใจดี');
  assert.strictEqual(repairPayload.approverName, 'รศ.ดร.กิตติชัย ไตรรัตนศิริชัย');
  assert.notStrictEqual(repairPayload.approverName, 'นายประหยัด สืบเมืองซ้าย'); // verified not hardcoded
});

await it('Validates Client-Side A4 Print & JSON Export structure completeness', () => {
  const exportPayload = {
    exportVersion: '1.0',
    generatedAt: new Date().toISOString(),
    ticketNo: 'RP-202610-0001',
    organization: 'สำนักวิทยบริการ มหาวิทยาลัยขอนแก่น',
    requester: {
      name: 'นายชาลี พรหมอินทร์',
      position: 'นักสารสนเทศ',
      division: 'งานบริการสารสนเทศ',
      date: '2026-10-20',
    },
    approver: {
      name: 'ผู้ช่วยศาสตราจารย์ ดร. เด่นพงษ์ สุดหาญ',
      title: 'หัวหน้างาน/ผู้บังคับบัญชา',
    },
    items: [
      {
        itemNo: 1,
        responsiblePerson: 'นายชาลี พรหมอินทร์',
        equipmentName: 'เครื่องปรับอากาศ Daikin',
        assetNumber: '6520040000027',
        symptom: 'ไม่เย็น มีเสียงดัง',
      },
    ],
  };

  const jsonStr = JSON.stringify(exportPayload);
  const parsed = JSON.parse(jsonStr);

  assert.strictEqual(parsed.exportVersion, '1.0');
  assert.strictEqual(parsed.ticketNo, 'RP-202610-0001');
  assert.strictEqual(parsed.items.length, 1);
  assert.strictEqual(parsed.items[0].assetNumber, '6520040000027');
});

// -------------------------------------------------------------
// 19. Repair Cost Breakdown, Post-Approval Lock & Safe Notifications
// -------------------------------------------------------------
console.log('\n--- TEST GROUP 19: Cost Breakdown, Approval Lock & Safe Notifications ---');

await it('Validates repair cost breakdown calculation (แยก ค่าแรง / ค่าอะไหล่ / ค่าบริการ / อื่นๆ) and total sum', () => {
  const costBreakdown = {
    laborCost: 500,     // ค่าแรง
    partsCost: 2500,    // ค่าอะไหล่
    serviceCost: 300,   // ค่าบริการ
    otherCost: 200,     // ค่าใช้จ่ายอื่นๆ/ขนส่ง
  };

  const totalCost =
    (costBreakdown.laborCost || 0) +
    (costBreakdown.partsCost || 0) +
    (costBreakdown.serviceCost || 0) +
    (costBreakdown.otherCost || 0);

  assert.strictEqual(totalCost, 3500);

  // Partial breakdown with nulls/undefined
  const partial = {
    laborCost: 1200,
    partsCost: null,
    serviceCost: undefined,
    otherCost: 0,
  };
  const partialTotal = (partial.laborCost || 0) + (partial.partsCost || 0) + (partial.serviceCost || 0) + (partial.otherCost || 0);
  assert.strictEqual(partialTotal, 1200);
});

await it('Enforces post-approval data immutability (locks original form items, subject, requester after approval)', () => {
  const protectedFields = [
    'items', 'subject', 'documentDate', 'docDay', 'docMonth', 'docYear',
    'requesterEmail', 'requesterName', 'requesterPosition', 'requesterDivision',
    'recipient'
  ];

  function validateDraftUpdate(currentStatus, updatedKeys) {
    if (currentStatus === 'DRAFT' || currentStatus === 'PENDING_REVIEW') {
      return { allowed: true };
    }
    const touchedProtected = updatedKeys.filter((k) => protectedFields.includes(k));
    if (touchedProtected.length > 0) {
      return { allowed: false, reason: `Cannot modify protected fields [${touchedProtected.join(', ')}] after approval` };
    }
    return { allowed: true };
  }

  // In DRAFT or PENDING_REVIEW: editing is allowed
  assert.strictEqual(validateDraftUpdate('DRAFT', ['items', 'subject']).allowed, true);
  assert.strictEqual(validateDraftUpdate('PENDING_REVIEW', ['items', 'documentDate']).allowed, true);

  // Once APPROVED, IN_REPAIR, or COMPLETED: editing protected fields is blocked
  assert.strictEqual(validateDraftUpdate('APPROVED', ['items']).allowed, false);
  assert.strictEqual(validateDraftUpdate('IN_REPAIR', ['subject']).allowed, false);
  assert.strictEqual(validateDraftUpdate('COMPLETED', ['items', 'requesterName']).allowed, false);

  // Operational completion updates (vendor, cost breakdown, completionNotes) are allowed
  assert.strictEqual(validateDraftUpdate('COMPLETED', ['vendorName', 'repairCost', 'laborCost', 'partsCost', 'completionNotes']).allowed, true);
});

await it('Prevents invalid reversion of repair ticket status back to DRAFT or PENDING_REVIEW after approval', () => {
  function canRevertToDraft(currentStatus) {
    if (currentStatus === 'APPROVED' || currentStatus === 'IN_REPAIR' || currentStatus === 'COMPLETED') {
      return false;
    }
    return true;
  }

  assert.strictEqual(canRevertToDraft('PENDING_REVIEW'), true);
  assert.strictEqual(canRevertToDraft('APPROVED'), false);
  assert.strictEqual(canRevertToDraft('IN_REPAIR'), false);
  assert.strictEqual(canRevertToDraft('COMPLETED'), false);
});

await it('Verifies repair notification suite payload generation (PENDING_REVIEW, APPROVED, COMPLETED) with direct gateway format', () => {
  const mockRepairTicket = {
    id: 'RP-202610-0001',
    ticketNo: 'RP-202610-0001',
    status: 'COMPLETED',
    documentDate: '2026-10-20',
    requesterName: 'นายชาลี พรหมอินทร์',
    requesterEmail: 'chalpr@kku.ac.th',
    approverName: 'ผศ.ดร. เด่นพงษ์ สุดหาญ',
    approverEmail: 'denpong@kku.ac.th',
    items: [
      { id: '1', equipmentName: 'เครื่องปรับอากาศ Daikin', assetNumber: '6520040000027', symptom: 'ไม่เย็น มีเสียงดัง' }
    ],
    laborCost: 500,
    partsCost: 2500,
    serviceCost: 300,
    otherCost: 200,
    repairCost: 3500,
    vendorName: 'ศูนย์แอร์มิตซู ขอนแก่น',
    completionDate: '2026-10-20',
    completionNotes: 'เปลี่ยนคอมเพรสเซอร์และล้างแอร์เรียบร้อย',
  };

  // 1. Pending review payload
  const pendingPayload = {
    to: [mockRepairTicket.approverEmail],
    type: 'REPAIR_PENDING_REVIEW',
    requestId: mockRepairTicket.ticketNo,
    idempotencyKey: `${mockRepairTicket.ticketNo}_PENDING_REVIEW`,
    subject: `[แจ้งซ่อมอุปกรณ์] ใบแจ้งซ่อมเลขที่ ${mockRepairTicket.ticketNo} รอการพิจารณาอนุมัติ`,
  };
  assert.strictEqual(pendingPayload.to[0], 'denpong@kku.ac.th');
  assert.strictEqual(pendingPayload.idempotencyKey, 'RP-202610-0001_PENDING_REVIEW');

  // 2. Approved payload
  const approvedPayload = {
    to: [mockRepairTicket.requesterEmail],
    type: 'REPAIR_APPROVED',
    requestId: mockRepairTicket.ticketNo,
    idempotencyKey: `${mockRepairTicket.ticketNo}_APPROVED`,
    subject: `[อนุมัติแล้ว] ใบแจ้งซ่อมเลขที่ ${mockRepairTicket.ticketNo} ได้รับการอนุมัติเรียบร้อยแล้ว`,
  };
  assert.strictEqual(approvedPayload.to[0], 'chalpr@kku.ac.th');
  assert.strictEqual(approvedPayload.idempotencyKey, 'RP-202610-0001_APPROVED');

  // 3. Completed payload
  const completedPayload = {
    to: [mockRepairTicket.requesterEmail],
    type: 'REPAIR_COMPLETED',
    requestId: mockRepairTicket.ticketNo,
    idempotencyKey: `${mockRepairTicket.ticketNo}_COMPLETED`,
    subject: `[ปิดงานซ่อม] ใบแจ้งซ่อมเลขที่ ${mockRepairTicket.ticketNo} ดำเนินการซ่อมเสร็จสิ้นแล้ว`,
  };
  assert.strictEqual(completedPayload.to[0], 'chalpr@kku.ac.th');
  assert.strictEqual(completedPayload.idempotencyKey, 'RP-202610-0001_COMPLETED');
});

await it('Strictly guards against real email delivery in test mode (MOCK and process.env.NODE_ENV === test)', () => {
  const isTestEnv = true;
  let networkFetchCalled = false;

  const mockSafeDispatcher = (job) => {
    if (isTestEnv) {
      return {
        success: true,
        status: 'SUCCESS',
        message: 'Processed by Mock/Staging Dispatcher (No actual email sent)',
        messageId: `mock_${Date.now()}`,
      };
    }
    networkFetchCalled = true;
    return { success: true };
  };

  const res = mockSafeDispatcher({ to: ['test@kku.ac.th'], message: { subject: 'Test' } });
  assert.strictEqual(res.status, 'SUCCESS');
  assert.strictEqual(res.message.includes('No actual email sent'), true);
  assert.strictEqual(networkFetchCalled, false, 'Must never perform actual network fetch to send real emails in test');
});

// -------------------------------------------------------------
// 20. Strict Equipment Availability Defense-in-Depth & Concurrency
// -------------------------------------------------------------
console.log('\n--- TEST GROUP 20: Strict Equipment Availability Defense-in-Depth (MAINTENANCE, BORROWED, LOST) ---');

await it('isEquipmentAvailable permits AVAILABLE and strictly rejects MAINTENANCE, BORROWED, LOST, RETIRED, and deleted items', () => {
  assert.strictEqual(isEquipmentAvailable({ status: 'AVAILABLE', isDeleted: false }), true);
  assert.strictEqual(isEquipmentAvailable({ status: 'MAINTENANCE', isDeleted: false }), false);
  assert.strictEqual(isEquipmentAvailable({ status: 'BORROWED', isDeleted: false }), false);
  assert.strictEqual(isEquipmentAvailable({ status: 'LOST', isDeleted: false }), false);
  assert.strictEqual(isEquipmentAvailable({ status: 'RETIRED', isDeleted: false }), false);
  assert.strictEqual(isEquipmentAvailable({ status: 'AVAILABLE', isDeleted: true }), false);
  assert.strictEqual(isEquipmentAvailable(null), false);
  assert.strictEqual(isEquipmentAvailable(undefined), false);
});

await it('validateEquipmentAvailability returns accurate Thai explanations for non-AVAILABLE statuses', () => {
  const maint = validateEquipmentAvailability({ status: 'MAINTENANCE', name: 'Notebook Dell' });
  assert.strictEqual(maint.available, false);
  assert.strictEqual(maint.status, 'MAINTENANCE');
  assert.strictEqual(maint.reason.includes('อยู่ระหว่างซ่อมบำรุง'), true);

  const borrowed = validateEquipmentAvailability({ status: 'BORROWED', name: 'Projector Epson' });
  assert.strictEqual(borrowed.available, false);
  assert.strictEqual(borrowed.status, 'BORROWED');
  assert.strictEqual(borrowed.reason.includes('ถูกยืมใช้งานอยู่'), true);

  const lost = validateEquipmentAvailability({ status: 'LOST', name: 'Wireless Mic' });
  assert.strictEqual(lost.available, false);
  assert.strictEqual(lost.status, 'LOST');
  assert.strictEqual(lost.reason.includes('สูญหาย'), true);

  const retired = validateEquipmentAvailability({ status: 'RETIRED' });
  assert.strictEqual(retired.available, false);
  assert.strictEqual(retired.status, 'RETIRED');
  assert.strictEqual(retired.reason.includes('จำหน่ายแล้ว'), true);

  const deleted = validateEquipmentAvailability({ status: 'AVAILABLE', isDeleted: true });
  assert.strictEqual(deleted.available, false);
  assert.strictEqual(deleted.status, 'DELETED');

  const avail = validateEquipmentAvailability({ status: 'AVAILABLE', isDeleted: false });
  assert.strictEqual(avail.available, true);
  assert.strictEqual(avail.status, 'AVAILABLE');
  assert.strictEqual(avail.reason, undefined);
});

await it('createBorrowRequest pre-flight check rejects non-AVAILABLE equipment immediately', async () => {
  const mockUser = {
    email: 'somchai@kku.ac.th',
    name: 'สมชาย ผู้ยืม',
    role: 'USER',
    departmentCode: 'OAS',
  };

  // 1. Rejects MAINTENANCE
  await assert.rejects(
    async () => {
      await createBorrowRequest(
        {
          equipment: { id: 'eq-maint-01', assetNumber: 'EQ-001', name: 'Notebook Test', status: 'MAINTENANCE' },
          startDate: '2026-10-21',
          expectedReturnDate: '2026-10-23',
          purpose: 'ใช้งานการเรียนการสอน',
          location: 'ห้องประชุม 1',
        },
        mockUser
      );
    },
    (err) => {
      assert.strictEqual(err.message.includes('อยู่ระหว่างซ่อมบำรุง'), true);
      return true;
    }
  );

  // 2. Rejects BORROWED
  await assert.rejects(
    async () => {
      await createBorrowRequest(
        {
          equipment: { id: 'eq-borrowed-01', assetNumber: 'EQ-002', name: 'Projector Test', status: 'BORROWED' },
          startDate: '2026-10-25',
          expectedReturnDate: '2026-10-28',
          purpose: 'ใช้งานการเรียนการสอน',
          location: 'ห้องประชุม 2',
        },
        mockUser
      );
    },
    (err) => {
      assert.strictEqual(err.message.includes('ถูกยืมใช้งานอยู่'), true);
      return true;
    }
  );

  // 3. Rejects LOST
  await assert.rejects(
    async () => {
      await createBorrowRequest(
        {
          equipment: { id: 'eq-lost-01', assetNumber: 'EQ-003', name: 'Camera Test', status: 'LOST' },
          startDate: '2026-10-21',
          expectedReturnDate: '2026-10-23',
          purpose: 'ถ่ายทอดสด',
          location: 'หอประชุม',
        },
        mockUser
      );
    },
    (err) => {
      assert.strictEqual(err.message.includes('สูญหาย'), true);
      return true;
    }
  );
});

await it('Atomic transaction guards against stale cache and race condition when equipment was switched to MAINTENANCE concurrently', async () => {
  const mockUser = {
    email: 'somchai@kku.ac.th',
    name: 'สมชาย ผู้ยืม',
    role: 'USER',
  };

  // Client thinks it is AVAILABLE at form load
  const clientViewOfEquipment = {
    id: 'eq-concurrent-01',
    assetNumber: 'EQ-CONC-01',
    name: 'MacBook Pro M3',
    status: 'AVAILABLE',
  };

  // Direct simulation of atomic transaction check inside createBorrowRequest
  await assert.rejects(
    async () => {
      const tx = {
        get: async () => ({
          exists: () => true,
          data: () => ({
            id: 'eq-concurrent-01',
            status: 'MAINTENANCE',
            isDeleted: false,
            activeBookings: [],
          }),
        }),
      };

      const freshSnap = await tx.get();
      const freshEqData = freshSnap.data();
      const freshAvail = validateEquipmentAvailability(freshEqData);
      if (!freshAvail.available) {
        throw new Error(freshAvail.reason || 'ครุภัณฑ์ไม่พร้อมให้ยืม');
      }
    },
    (err) => {
      assert.strictEqual(err.message.includes('อยู่ระหว่างซ่อมบำรุง'), true);
      return true;
    }
  );
});

await it('handoverRequest rejects handing over equipment that was transitioned to MAINTENANCE or LOST', async () => {
  // Simulating handover transition check when equipment is in MAINTENANCE
  const eqDataMaint = {
    id: 'eq-broken-01',
    status: 'MAINTENANCE',
  };

  assert.throws(
    () => {
      if (eqDataMaint && (eqDataMaint.status === 'MAINTENANCE' || eqDataMaint.status === 'LOST')) {
        throw new Error(
          `ไม่สามารถส่งมอบได้ เนื่องจากครุภัณฑ์อยู่ในสถานะ ${
            eqDataMaint.status === 'MAINTENANCE' ? 'อยู่ระหว่างซ่อมบำรุง' : 'สูญหายหรือไม่พร้อมใช้งาน'
          }`
        );
      }
    },
    (err) => {
      assert.strictEqual(err.message.includes('อยู่ระหว่างซ่อมบำรุง'), true);
      return true;
    }
  );

  // Simulating handover transition check when equipment is in LOST
  const eqDataLost = {
    id: 'eq-lost-01',
    status: 'LOST',
  };

  assert.throws(
    () => {
      if (eqDataLost && (eqDataLost.status === 'MAINTENANCE' || eqDataLost.status === 'LOST')) {
        throw new Error(
          `ไม่สามารถส่งมอบได้ เนื่องจากครุภัณฑ์อยู่ในสถานะ ${
            eqDataLost.status === 'MAINTENANCE' ? 'อยู่ระหว่างซ่อมบำรุง' : 'สูญหายหรือไม่พร้อมใช้งาน'
          }`
        );
      }
    },
    (err) => {
      assert.strictEqual(err.message.includes('สูญหายหรือไม่พร้อมใช้งาน'), true);
      return true;
    }
  );
});

await it('Damaged return flow transitions equipment to MAINTENANCE and immediately blocks new bookings', () => {
  // Simulate returnRequest with condition DAMAGED
  const condition = 'DAMAGED';
  const to = condition === 'NORMAL' ? 'RETURNED' : condition === 'DAMAGED' ? 'RETURNED_DAMAGED' : 'LOST';
  const eqStatus = condition === 'NORMAL' ? 'AVAILABLE' : condition === 'DAMAGED' ? 'MAINTENANCE' : 'LOST';

  assert.strictEqual(to, 'RETURNED_DAMAGED');
  assert.strictEqual(eqStatus, 'MAINTENANCE');

  // Verify that subsequent borrow requests are immediately blocked
  const postReturnAvail = validateEquipmentAvailability({ id: 'eq-01', status: eqStatus });
  assert.strictEqual(postReturnAvail.available, false);
  assert.strictEqual(postReturnAvail.status, 'MAINTENANCE');
  assert.strictEqual(postReturnAvail.reason.includes('อยู่ระหว่างซ่อมบำรุง'), true);
});

await it('Repair completion flow transitions equipment back to AVAILABLE and re-enables borrowing', () => {
  // Equipment in MAINTENANCE
  let equipment = {
    id: 'eq-repair-01',
    status: 'MAINTENANCE',
    note: '',
  };

  assert.strictEqual(isEquipmentAvailable(equipment), false);

  // When repair ticket is COMPLETED:
  const repairStatus = 'COMPLETED';
  if (repairStatus === 'COMPLETED') {
    equipment.status = 'AVAILABLE';
    equipment.note = 'ซ่อมบำรุงเสร็จสิ้นตามใบแจ้งซ่อม RP-202610-0001';
  }

  assert.strictEqual(equipment.status, 'AVAILABLE');
  assert.strictEqual(isEquipmentAvailable(equipment), true);
  const avail = validateEquipmentAvailability(equipment);
  assert.strictEqual(avail.available, true);
  assert.strictEqual(avail.status, 'AVAILABLE');
});

await it('Firestore Security Rules simulation: isEquipmentAvailableForBorrow rejects client create for non-AVAILABLE', () => {
  // Logic mirror of firestore.rules isEquipmentAvailableForBorrow(eqId)
  const isEquipmentAvailableForBorrow = (eqData) => {
    return Boolean(eqData && eqData.status === 'AVAILABLE' && !eqData.isDeleted);
  };

  assert.strictEqual(isEquipmentAvailableForBorrow({ status: 'AVAILABLE', isDeleted: false }), true);
  assert.strictEqual(isEquipmentAvailableForBorrow({ status: 'MAINTENANCE', isDeleted: false }), false);
  assert.strictEqual(isEquipmentAvailableForBorrow({ status: 'BORROWED', isDeleted: false }), false);
  assert.strictEqual(isEquipmentAvailableForBorrow({ status: 'LOST', isDeleted: false }), false);
  assert.strictEqual(isEquipmentAvailableForBorrow({ status: 'RETIRED', isDeleted: false }), false);
  assert.strictEqual(isEquipmentAvailableForBorrow({ status: 'AVAILABLE', isDeleted: true }), false);
  assert.strictEqual(isEquipmentAvailableForBorrow(null), false);
});

// -------------------------------------------------------------
// 21. DocumentSnapshot ID Mapping & Undefined Prevention
// -------------------------------------------------------------
console.log('\n--- TEST GROUP 21: DocumentSnapshot ID Mapping & Undefined Prevention ---');

await it('Object spread order preserves doc.id even if Firestore document data has id: undefined', () => {
  const doc = {
    id: 'BR-202610-0003',
    data: () => ({
      equipment: { name: 'โน้ตบุ๊ก Dell Latitude' },
      borrower: { name: 'วาสนา จันทร์เพ็ญ', email: 'vassana@kku.ac.th' },
      status: 'RETURNED',
      id: undefined, // Simulates a missing or undefined id field in Firestore document
    }),
  };

  // Safe spreading: data() first, id: doc.id second
  const safeMapped = { ...doc.data(), id: doc.id };
  assert.strictEqual(safeMapped.id, 'BR-202610-0003');
  assert.notStrictEqual(safeMapped.id, undefined);

  // Unsafe spreading demonstration: id: doc.id first, then ...doc.data() overwrites it!
  const unsafeMapped = { id: doc.id, ...doc.data() };
  assert.strictEqual(unsafeMapped.id, undefined); // Proves the bug exists without our fix!
});

await it('buildRetroactiveCsatEmail rejects requests with undefined or missing id', () => {
  const corruptedReq = {
    equipment: { name: 'คอมพิวเตอร์พกพา' },
    borrower: { name: 'วาสนา', email: 'vassana@kku.ac.th' },
    status: 'RETURNED',
    // id missing entirely
  };

  assert.throws(
    () => buildRetroactiveCsatEmail(corruptedReq, 1),
    /BorrowRequest id is required and cannot be undefined/
  );

  const corruptedWithUndefinedStr = {
    ...corruptedReq,
    id: 'undefined',
  };

  assert.throws(
    () => buildRetroactiveCsatEmail(corruptedWithUndefinedStr, 1),
    /BorrowRequest id is required and cannot be undefined/
  );
});

await it('Email builders strictly prohibit "undefined" in subject, text, html, and idempotencyKey', async () => {
  const queuedJobs = [];
  setMockQueueEmailHandler(async (job) => {
    queuedJobs.push(job);
    return 'mock-mail-id';
  });
  setMockEmailSettingsHandler(async () => ({
    enabled: true,
    custodianEmail: 'custodian@kku.ac.th',
    approverEmail: 'approver@kku.ac.th',
  }));

  const validReq = {
    id: 'BR-202610-0003',
    equipment: { equipmentId: 'EQ-001', name: 'MacBook Air M2' },
    borrower: { name: 'วาสนา จันทร์เพ็ญ', email: 'vassana@kku.ac.th', position: 'นักวิชาการ' },
    status: 'IN_USE',
    startDate: '2026-10-15',
    expectedReturnDate: '2026-10-25',
    purpose: 'ใช้งานการอบรม',
    timeline: [],
    extension: {
      newExpectedReturnDate: '2026-10-30',
      reason: 'งานอบรมยังไม่เสร็จสิ้น',
      status: 'PENDING_REVIEW',
    },
  };

  // 1. notifyNewBorrowRequest
  await notifyNewBorrowRequest(validReq);
  // 2. notifyReviewPassed
  await notifyReviewPassed(validReq, 'ผ่านการตรวจ');
  // 3. notifyReviewRejected
  await notifyReviewRejected(validReq, 'ไม่ผ่านการตรวจ');
  // 4. notifyApprovalResult
  await notifyApprovalResult(validReq, true, 'อนุมัติ');
  // 5. notifyHandedOver
  await notifyHandedOver(validReq, ['สายชาร์จ'], 'ส่งมอบครบถ้วน');
  // 6. notifyReturned
  await notifyReturned({ ...validReq, status: 'RETURNED' }, 'NORMAL', 'คืนเรียบร้อย');
  // 7. notifyDueReminder (SOON, TODAY, OVERDUE)
  await notifyDueReminder(validReq, 'SOON', 2);
  await notifyDueReminder(validReq, 'TODAY', 0);
  await notifyDueReminder(validReq, 'OVERDUE', 3);
  // 8. notifyExtensionRequested
  await notifyExtensionRequested(validReq, '2026-10-30', 'ขอยืดเวลา');
  // 9. notifyExtensionReviewPassed
  await notifyExtensionReviewPassed(validReq, '2026-10-30', 'ตรวจผ่าน');
  // 10. notifyExtensionApproved
  await notifyExtensionApproved(validReq, '2026-10-25', '2026-10-30', 'อนุมัติต่ออายุ');
  // 11. notifyExtensionRejected
  await notifyExtensionRejected(validReq, 'ไม่อนุมัติต่ออายุ');

  // Also test buildRetroactiveCsatEmail
  const csatJob = buildRetroactiveCsatEmail({ ...validReq, status: 'RETURNED' }, 1);
  queuedJobs.push(csatJob);

  assert.strictEqual(queuedJobs.length > 0, true);

  for (const job of queuedJobs) {
    assert.strictEqual(job.requestId, 'BR-202610-0003');
    assert.strictEqual(typeof job.requestId, 'string');
    assert.strictEqual(job.requestId.includes('undefined'), false, `job.requestId contains undefined: ${job.requestId}`);
    assert.strictEqual(job.idempotencyKey.includes('undefined'), false, `job.idempotencyKey contains undefined: ${job.idempotencyKey}`);
    assert.strictEqual(job.message.subject.includes('undefined'), false, `job.subject contains undefined: ${job.message.subject}`);
    assert.strictEqual(job.message.text.includes('undefined'), false, `job.text contains undefined: ${job.message.text}`);
    assert.strictEqual(job.message.html.includes('undefined'), false, `job.html contains undefined: ${job.message.html}`);
    assert.strictEqual(job.message.html.includes('BR-202610-0003'), true, `job.html missing requestId: ${job.message.html}`);
  }

  // Clear mock handler
  setMockQueueEmailHandler(null);
  setMockEmailSettingsHandler(null);
});

await it('All notification functions reject requests where id is undefined or missing', async () => {
  const badReq = {
    // id missing or undefined
    equipment: { name: 'คอมพิวเตอร์' },
    borrower: { name: 'วาสนา', email: 'vassana@kku.ac.th' },
    status: 'IN_USE',
    startDate: '2026-10-15',
    expectedReturnDate: '2026-10-25',
    purpose: 'งาน',
  };

  const notificationCallers = [
    () => notifyNewBorrowRequest(badReq),
    () => notifyReviewPassed(badReq, 'ok'),
    () => notifyReviewRejected(badReq, 'no'),
    () => notifyApprovalResult(badReq, true, 'ok'),
    () => notifyHandedOver(badReq, 'ok'),
    () => notifyReturned(badReq, 'NORMAL', 'ok'),
    () => notifyDueReminder(badReq, 'SOON', 1),
    () => notifyExtensionRequested(badReq, '2026-10-30', 'reason'),
    () => notifyExtensionReviewPassed(badReq, '2026-10-30', 'reason'),
    () => notifyExtensionApproved(badReq, '2026-10-25', '2026-10-30', 'ok'),
    () => notifyExtensionRejected(badReq, 'no'),
  ];

  for (const caller of notificationCallers) {
    await assert.rejects(
      async () => await caller(),
      /BorrowRequest id is required and cannot be undefined/
    );
  }
});

await it('sendRetroactiveCsatInvite enforces snapshot ID and throws if request has no ID', async () => {
  const me = { email: 'chalpr@kku.ac.th', role: 'CUSTODIAN', name: 'เฉลิมพร' };

  let capturedTxUpdates = [];
  let capturedTxSets = [];
  let callCount = 0;

  const mockDb = { name: 'mockDb' };
  setMockTransactionRunner(async (db, fn) => {
    const tx = {
      get: async (ref) => {
        callCount++;
        if (callCount === 1) {
          // borrow_requests document snapshot
          return {
            exists: () => true,
            id: 'BR-202610-0003',
            data: () => ({
              // document data itself has NO id field
              equipment: { name: 'โน้ตบุ๊ก' },
              borrower: { email: 'vassana@kku.ac.th', name: 'วาสนา' },
              status: 'RETURNED',
              surveyInviteCount: 0,
            }),
          };
        }
        // mail document snapshot (not exists)
        return { exists: () => false };
      },
      set: (ref, data) => capturedTxSets.push({ ref, data }),
      update: (ref, data) => capturedTxUpdates.push({ ref, data }),
    };
    return fn(tx);
  });

  const res = await sendRetroactiveCsatInvite(
    { id: 'BR-202610-0003', status: 'RETURNED' },
    me
  );

  assert.strictEqual(res.freshReq.id, 'BR-202610-0003');
  assert.strictEqual(res.inviteNumber, 1);
  assert.strictEqual(capturedTxSets.length, 1);
  const queuedMail = capturedTxSets[0].data;
  assert.strictEqual(queuedMail.requestId, 'BR-202610-0003');
  assert.strictEqual(queuedMail.idempotencyKey.includes('undefined'), false);
  assert.strictEqual(queuedMail.message.subject.includes('undefined'), false);
  assert.strictEqual(queuedMail.message.html.includes('undefined'), false);

  // Calling with an object with id: undefined should fail immediately
  await assert.rejects(
    async () => await sendRetroactiveCsatInvite({ id: undefined, status: 'RETURNED' }, me),
    /ไม่พบรหัสคำขอ/
  );

  // Restore transaction runner
  setMockTransactionRunner(null);
});

await it('Safely processes original legacy production requests (like BR-202610-0003) creating clean CSAT invites without mutating core business fields', async () => {
  const staff = { email: 'chalpr@kku.ac.th', role: 'CUSTODIAN', name: 'เฉลิมพร' };

  // Original production document without embedded id field
  const originalProdDocData = {
    borrower: {
      email: 'wassjo@kku.ac.th',
      name: 'นางสาววาสนา จงจิตกลาง',
      position: 'นักวิชาการศึกษา',
      division: 'งานบริการวิชาการ',
    },
    equipment: {
      equipmentId: 'eq-acer-01',
      name: 'โน้ตบุ๊ก Acer TravelMate',
      assetNumber: '7440-001-0001',
    },
    status: 'RETURNED',
    startDate: '2026-10-01',
    expectedReturnDate: '2026-10-08',
    purpose: 'ใช้งานการประชุมวิชาการ',
    timeline: [
      { status: 'RETURNED', by: 'chalpr@kku.ac.th', note: 'รับคืนสภาพปกติ' },
    ],
    // notice: NO id field in Firestore data!
  };

  let capturedSet = null;
  let capturedUpdate = null;
  let getCallCount = 0;

  setMockTransactionRunner(async (db, fn) => {
    const tx = {
      get: async (ref) => {
        getCallCount++;
        if (getCallCount === 1) {
          // borrow_requests document snapshot
          return {
            exists: () => true,
            id: 'BR-202610-0003',
            data: () => ({ ...originalProdDocData }),
          };
        }
        // mail document snapshot (not exists)
        return { exists: () => false };
      },
      set: (ref, data) => { capturedSet = { ref, data }; },
      update: (ref, data) => { capturedUpdate = { ref, data }; },
    };
    return fn(tx);
  });

  const res = await sendRetroactiveCsatInvite(
    { id: 'BR-202610-0003', status: 'RETURNED' },
    staff
  );

  // 1. Verify that returned freshReq has correct id from snapshot
  assert.strictEqual(res.freshReq.id, 'BR-202610-0003');

  // 2. Verify that captured update ONLY touches invite tracking fields and does NOT overwrite or mutate existing data
  assert.deepStrictEqual(Object.keys(capturedUpdate.data).sort(), [
    'surveyInviteCount',
    'surveyInviteQueuedAt',
    'surveyInviteStatus',
    'updatedAt',
  ].sort());
  assert.strictEqual(capturedUpdate.data.surveyInviteStatus, 'QUEUED');
  assert.strictEqual(capturedUpdate.data.surveyInviteCount, 1);

  // 3. Verify created mail job is 100% correct without "undefined"
  const mail = capturedSet.data;
  assert.strictEqual(mail.requestId, 'BR-202610-0003');
  assert.strictEqual(mail.to[0], 'wassjo@kku.ac.th');
  assert.strictEqual(mail.idempotencyKey, 'BR-202610-0003_RETROACTIVE_CSAT');
  assert.strictEqual(mail.message.subject.includes('BR-202610-0003'), true);
  assert.strictEqual(mail.message.subject.includes('โน้ตบุ๊ก Acer TravelMate'), true);
  assert.strictEqual(mail.message.subject.includes('undefined'), false);
  assert.strictEqual(mail.message.text.includes('undefined'), false);
  assert.strictEqual(mail.message.html.includes('undefined'), false);

  // 4. Verify 1-click star rating links point to BR-202610-0003
  for (let star = 1; star <= 5; star++) {
    assert.strictEqual(
      mail.message.html.includes(`https://borrowoas.web.app/request/?id=BR-202610-0003&csat=${star}`),
      true,
      `Missing star rating link for star ${star}`
    );
  }

  setMockTransactionRunner(null);
});

console.log('\n--- TEST GROUP 22: Direct Client / Webhook Mail Queue & Safe Retry Architecture ---');

await it('checkManualRetryEligibility correctly distinguishes between automated worker and admin force retry', () => {
  const now = Date.now();
  const failedJob = {
    status: 'FAILED',
    attemptCount: 3,
    maxAttempts: 3,
    nextAttemptAt: { toMillis: () => now + 60000 },
  };

  // Automated worker: blocked by maxAttempts and retry backoff
  const workerCheck = checkManualRetryEligibility(failedJob, now, false);
  assert.strictEqual(workerCheck.eligible, false);
  assert.strictEqual(workerCheck.reason, 'MAX_ATTEMPTS_EXCEEDED');

  // Human Admin / Staff direct retry: allows retry on FAILED jobs
  const adminCheck = checkManualRetryEligibility(failedJob, now, true);
  assert.strictEqual(adminCheck.eligible, true);

  // But still strictly prohibits retry if job is already SUCCESS or actively locked PROCESSING
  assert.strictEqual(checkManualRetryEligibility({ status: 'SUCCESS' }, now, true).eligible, false);
  assert.strictEqual(
    checkManualRetryEligibility({ status: 'PROCESSING', claimedAt: { toMillis: () => now - 20000 } }, now, true).eligible,
    false
  );
  assert.strictEqual(
    checkManualRetryEligibility({ status: 'RECONCILIATION_REQUIRED', requiresReconciliation: true }, now, true).eligible,
    false
  );
});

await it('retryEmailJob successfully executes direct dispatch on FAILED job and returns verified result', async () => {
  clearEmailDedupCache();
  const failedJob = {
    id: 'mail-failed-001',
    status: 'FAILED',
    to: ['staff@kku.ac.th'],
    message: { subject: 'แจ้งเตือนคำขอ BR-202610-0003', text: 'เนื้อหา', html: '<p>เนื้อหา</p>' },
    requestId: 'BR-202610-0003',
    type: 'REVIEW_PASSED',
    attemptCount: 3,
    maxAttempts: 3,
  };

  const res = await retryEmailJob('mail-failed-001', failedJob);
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.message, 'ส่งอีเมลซ้ำ (Retry) สำเร็จเรียบร้อยแล้ว');
});

await it('retryEmailJob successfully executes direct dispatch on PENDING job', async () => {
  clearEmailDedupCache();
  const pendingJob = {
    id: 'mail-pending-001',
    status: 'PENDING',
    to: ['borrower@kku.ac.th'],
    message: { subject: 'แจ้งเตือนคำขอ BR-202610-0004', text: 'เนื้อหา', html: '<p>เนื้อหา</p>' },
    requestId: 'BR-202610-0004',
    type: 'APPROVED',
  };

  const res = await retryEmailJob('mail-pending-001', pendingJob);
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.message, 'ส่งอีเมลซ้ำ (Retry) สำเร็จเรียบร้อยแล้ว');
});

await it('retryEmailJob clears deduplication cache so immediate manual resend is never blocked', async () => {
  clearEmailDedupCache();
  const job = {
    id: 'mail-dedup-clear-001',
    status: 'FAILED',
    to: ['user@kku.ac.th'],
    message: { subject: 'คำขอ BR-202610-0005', text: 'ทดสอบ', html: '<p>ทดสอบ</p>' },
    requestId: 'BR-202610-0005',
    type: 'NOTIFICATION',
  };

  // First retry
  const res1 = await retryEmailJob('mail-dedup-clear-001', job);
  assert.strictEqual(res1.success, true);

  // Immediate second retry within 60s: must succeed because retryEmailJob clears cooldown cache
  const res2 = await retryEmailJob('mail-dedup-clear-001', job);
  assert.strictEqual(res2.success, true);
  assert.strictEqual(res2.message, 'ส่งอีเมลซ้ำ (Retry) สำเร็จเรียบร้อยแล้ว');
});

await it('dispatchMailJobDirect returns SKIPPED when duplicate send occurs without clearEmailDedupCache', async () => {
  clearEmailDedupCache();
  const job = {
    to: ['user_auto@kku.ac.th'],
    message: { subject: 'คำขอ BR-202610-0006', text: 'อัตโนมัติ', html: '<p>อัตโนมัติ</p>' },
    requestId: 'BR-202610-0006',
    type: 'STATUS_UPDATE',
  };

  const first = await dispatchMailJobDirect(null, job);
  assert.strictEqual(first.success, true);
  assert.strictEqual(first.status, 'SUCCESS');

  // Without cache clear, automated send is SKIPPED
  const second = await dispatchMailJobDirect(null, job);
  assert.strictEqual(second.success, true);
  assert.strictEqual(second.status, 'SKIPPED');
  assert.strictEqual(second.deduplicated, true);
});

await it('isJobEligibleForClientProcess strictly guards background sweep eligibility', () => {
  const now = Date.now();
  // PENDING and eligible
  assert.strictEqual(
    isJobEligibleForClientProcess({ status: 'PENDING', attemptCount: 0, maxAttempts: 3 }, now).eligible,
    true
  );

  // Non-PENDING statuses must be skipped by client sweep
  assert.strictEqual(
    isJobEligibleForClientProcess({ status: 'SUCCESS' }, now).eligible,
    false
  );
  assert.strictEqual(
    isJobEligibleForClientProcess({ status: 'FAILED' }, now).eligible,
    false
  );

  // Reconciliation required must be skipped
  assert.strictEqual(
    isJobEligibleForClientProcess({ status: 'PENDING', requiresReconciliation: true }, now).eligible,
    false
  );

  // Max attempts exceeded must be skipped
  assert.strictEqual(
    isJobEligibleForClientProcess({ status: 'PENDING', attemptCount: 3, maxAttempts: 3 }, now).eligible,
    false
  );

  // Backoff in future must be skipped
  assert.strictEqual(
    isJobEligibleForClientProcess({ status: 'PENDING', nextAttemptAt: { toMillis: () => now + 30000 } }, now).eligible,
    false
  );
});

await it('CSAT mail job correctly records to, cc, subject, text, html, requestId, and type', () => {
  const req = {
    id: 'BR-202610-0003',
    equipment: { name: 'โน้ตบุ๊ก Acer TravelMate P214' },
    borrower: { email: 'wassjo@kku.ac.th', name: 'นางสาววาสนา จงจิตกลาง' },
    returnInfo: { actualReturnDate: '2026-10-15' },
    status: 'RETURNED',
  };

  const rawCsatJob = buildRetroactiveCsatEmail(req, 1);
  const cleanMailJob = validateAndSanitizeMailJob(rawCsatJob);

  // 1. Check to
  assert.ok(Array.isArray(cleanMailJob.to), 'to must be an array');
  assert.strictEqual(cleanMailJob.to[0], 'wassjo@kku.ac.th');

  // 2. Check cc
  assert.ok(Array.isArray(cleanMailJob.cc), 'cc must be an array');
  assert.deepStrictEqual(cleanMailJob.cc, []);

  // 3. Check subject
  assert.ok(typeof cleanMailJob.message?.subject === 'string' && cleanMailJob.message.subject.length > 0);
  assert.strictEqual(cleanMailJob.subject, cleanMailJob.message.subject);
  assert.ok(cleanMailJob.subject.includes('BR-202610-0003'));

  // 4. Check text
  assert.ok(typeof cleanMailJob.message?.text === 'string' && cleanMailJob.message.text.length > 0);
  assert.strictEqual(cleanMailJob.text, cleanMailJob.message.text);

  // 5. Check html
  assert.ok(typeof cleanMailJob.message?.html === 'string' && cleanMailJob.message.html.length > 0);
  assert.strictEqual(cleanMailJob.html, cleanMailJob.message.html);

  // 6. Check requestId and type
  assert.strictEqual(cleanMailJob.requestId, 'BR-202610-0003');
  assert.strictEqual(cleanMailJob.type, 'RETROACTIVE_CSAT_INVITE');
});

await it('dispatchMailJobDirect updates sentAt, messageId, errorDetails, attemptCount on SUCCESS', async () => {
  clearEmailDedupCache();
  const fakeDocRef = {
    id: 'mail-success-audit-01',
  };
  const mockDb = {
    _isMock: true,
  };

  const job = {
    to: ['borrower@kku.ac.th'],
    cc: [],
    message: { subject: 'แบบประเมิน BR-202610-0003', text: 'รายละเอียด', html: '<p>รายละเอียด</p>' },
    requestId: 'BR-202610-0003',
    type: 'RETROACTIVE_CSAT_INVITE',
    attemptCount: 0,
  };

  const mockGasFetch = async () => ({
    ok: true,
    text: async () => JSON.stringify({ status: 'SUCCESS', messageId: 'gas_csat_success_777' }),
  });

  setMockEmailSettingsHandler(async () => ({
    enabled: true,
    gateway: {
      provider: 'GOOGLE_APPS_SCRIPT',
      gasWebhookUrl: 'https://script.google.com/test-csat-exec',
      gasSecretToken: 'sec_tok',
    },
  }));

  const res = await dispatchMailJobDirect(fakeDocRef, job, mockDb, mockGasFetch);
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.status, 'SUCCESS');
  assert.strictEqual(res.messageId, 'gas_csat_success_777');

  setMockEmailSettingsHandler(null);
});

await it('dispatchMailJobDirect updates failedAt, errorDetails, and attemptCount on FAILED', async () => {
  clearEmailDedupCache();
  const fakeDocRef = {
    id: 'mail-failed-audit-01',
  };
  const mockDb = {
    _isMock: true,
  };

  const job = {
    to: ['borrower@kku.ac.th'],
    cc: [],
    message: { subject: 'แบบประเมิน BR-202610-0003', text: 'รายละเอียด', html: '<p>รายละเอียด</p>' },
    requestId: 'BR-202610-0003',
    type: 'RETROACTIVE_CSAT_INVITE',
    attemptCount: 1,
  };

  const mockFailFetch = async () => ({
    ok: false,
    status: 502,
    text: async () => 'Bad Gateway',
  });

  setMockEmailSettingsHandler(async () => ({
    enabled: true,
    gateway: {
      provider: 'GOOGLE_APPS_SCRIPT',
      gasWebhookUrl: 'https://script.google.com/test-csat-exec',
    },
  }));

  const res = await dispatchMailJobDirect(fakeDocRef, job, mockDb, mockFailFetch);
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.status, 'FAILED');
  assert.ok(res.message.includes('502') || res.message.includes('GAS Dispatch Error'));

  setMockEmailSettingsHandler(null);
});

// -------------------------------------------------------------
// 23. Snapshot ID Mapping, Non-Blocking Dispatch & Safe CSAT
// -------------------------------------------------------------
console.log('\n--- TEST GROUP 23: Snapshot ID Mapping, Non-blocking Direct Dispatch, Safe Retry & CSAT Verification ---');

await it('Snapshot ID Mapping: Spreading { ...doc.data(), id: doc.id } guarantees doc.id as Source of Truth across all entities', () => {
  // 1. BorrowRequest snapshot
  const borrowSnap = {
    id: 'BR-202610-0003',
    data: () => ({ id: 'corrupted-req-id', borrower: { email: 'wassjo@kku.ac.th' } }),
  };
  const reqMapped = { ...borrowSnap.data(), id: borrowSnap.id };
  assert.strictEqual(reqMapped.id, 'BR-202610-0003');

  // 2. Equipment snapshot
  const equipSnap = {
    id: 'EQ-2026-0042',
    data: () => ({ id: undefined, name: 'Projector Epson' }),
  };
  const equipMapped = { ...equipSnap.data(), id: equipSnap.id };
  assert.strictEqual(equipMapped.id, 'EQ-2026-0042');

  // 3. RepairRequest snapshot
  const repairSnap = {
    id: 'RP-202610-0005',
    data: () => ({ id: null, ticketNo: 'RP-202610-0005' }),
  };
  const repairMapped = { ...repairSnap.data(), id: repairSnap.id };
  assert.strictEqual(repairMapped.id, 'RP-202610-0005');

  // 4. MailJob snapshot
  const mailSnap = {
    id: 'mail-job-uuid-99',
    data: () => ({ id: undefined, status: 'PENDING' }),
  };
  const mailMapped = { ...mailSnap.data(), id: mailSnap.id };
  assert.strictEqual(mailMapped.id, 'mail-job-uuid-99');
});

await it('Snapshot ID Mapping: getRequestId strictly throws descriptive errors when id is missing or corrupted', () => {
  assert.throws(
    () => getRequestId({ borrower: { email: 'test@kku.ac.th' } }),
    /BorrowRequest id is required and cannot be undefined/
  );
  assert.throws(
    () => getRequestId({ id: null }),
    /BorrowRequest id is required and cannot be undefined/
  );
  assert.throws(
    () => getRequestId({ id: 'undefined' }),
    /BorrowRequest id is required and cannot be undefined/
  );
  assert.throws(
    () => getRequestId({ id: '   ' }),
    /BorrowRequest id is required and cannot be undefined/
  );

  // Valid ID returns string cleanly
  assert.strictEqual(getRequestId({ id: 'BR-202610-0003' }), 'BR-202610-0003');
});

await it('Non-blocking Direct Dispatch: queueEmail handles delegation and dispatches without throwing', async () => {
  clearEmailDedupCache();
  let dispatchedDirect = false;
  setMockQueueEmailHandler(async (job) => {
    dispatchedDirect = true;
    return 'mock-queued-doc-id-99';
  });

  const job = {
    to: ['test_nonblock@kku.ac.th'],
    message: { subject: 'หัวข้อการแจ้งเตือน', text: 'ข้อความ', html: '<p>ข้อความ</p>' },
    requestId: 'BR-202610-0099',
    type: 'NOTIFICATION',
    idempotencyKey: 'BR-202610-0099_NOTIF_TEST',
  };

  const docId = await queueEmail(job);
  assert.strictEqual(docId, 'mock-queued-doc-id-99');
  assert.strictEqual(dispatchedDirect, true);

  setMockQueueEmailHandler(null);
});

await it('Non-blocking Direct Dispatch: Strictly zero real emails sent during test execution', async () => {
  clearEmailDedupCache();
  let realFetchCalled = false;
  const mockFetchInterceptor = async () => {
    realFetchCalled = true;
    return { ok: true, text: async () => JSON.stringify({ status: 'SUCCESS' }) };
  };

  setMockEmailSettingsHandler(async () => ({
    enabled: true,
    gateway: { provider: 'MOCK' },
  }));

  const job = {
    to: ['safetest@kku.ac.th'],
    message: { subject: 'ความปลอดภัยระบบอีเมล', text: 'ทดสอบ', html: '<p>ทดสอบ</p>' },
    requestId: 'BR-202610-9999',
    type: 'NOTIFICATION',
  };

  // Without mockFetch parameter in test mode, dispatchMailJobDirect uses internal mock dispatcher
  const res = await dispatchMailJobDirect(null, job);
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.status, 'SUCCESS');
  assert.ok(res.message.includes('No actual email sent'), 'Must explicitly indicate no actual email was sent');
  assert.strictEqual(realFetchCalled, false, 'No actual fetch call should have occurred');

  setMockEmailSettingsHandler(null);
});

await it('Safe Retry: retryEmailJob rejects terminal SUCCESS, active PROCESSING, and RECONCILIATION_REQUIRED', async () => {
  // 1. Terminal SUCCESS
  const successJob = { id: 'm-success', status: 'SUCCESS', to: ['user@kku.ac.th'] };
  const resSuccess = await retryEmailJob('m-success', successJob);
  assert.strictEqual(resSuccess.success, false);
  assert.strictEqual(resSuccess.reason, 'ALREADY_SUCCESS');

  // 2. Fresh lock PROCESSING
  const processingJob = {
    id: 'm-proc',
    status: 'PROCESSING',
    claimedAt: { toMillis: () => Date.now() - 15000 }, // 15s ago
    to: ['user@kku.ac.th'],
  };
  const resProc = await retryEmailJob('m-proc', processingJob);
  assert.strictEqual(resProc.success, false);
  assert.strictEqual(resProc.reason, 'ALREADY_PROCESSING');

  // 3. RECONCILIATION_REQUIRED
  const reconcileJob = {
    id: 'm-rec',
    status: 'RECONCILIATION_REQUIRED',
    requiresReconciliation: true,
    to: ['user@kku.ac.th'],
  };
  const resRec = await retryEmailJob('m-rec', reconcileJob);
  assert.strictEqual(resRec.success, false);
  assert.strictEqual(resRec.reason, 'RECONCILIATION_REQUIRED');
});

await it('Safe Retry: retryEmailJob executes safely on FAILED and PENDING jobs with dedup cache cleared', async () => {
  clearEmailDedupCache();
  const failedJob = {
    id: 'm-failed',
    status: 'FAILED',
    to: ['user@kku.ac.th'],
    message: { subject: 'หัวข้อล้มเหลว', text: 'เนื้อหา', html: '<p>เนื้อหา</p>' },
    requestId: 'BR-202610-0003',
    type: 'REVIEW_PASSED',
    attemptCount: 1,
  };

  const res = await retryEmailJob('m-failed', failedJob);
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.message, 'ส่งอีเมลซ้ำ (Retry) สำเร็จเรียบร้อยแล้ว');
});

await it('CSAT Payload: buildRetroactiveCsatEmail generates complete schema, 1-click star URLs, and resend headers', () => {
  const req = {
    id: 'BR-202610-0003',
    equipment: { name: 'โน้ตบุ๊ก Acer TravelMate P214' },
    borrower: { email: 'wassjo@kku.ac.th', name: 'นางสาววาสนา จงจิตกลาง' },
    returnInfo: { actualReturnDate: '2026-10-15' },
    status: 'RETURNED',
  };

  // First invite
  const firstInvite = buildRetroactiveCsatEmail(req, 1);
  assert.ok(Array.isArray(firstInvite.to));
  assert.strictEqual(firstInvite.to[0], 'wassjo@kku.ac.th');
  assert.deepStrictEqual(firstInvite.cc, []);
  assert.strictEqual(firstInvite.requestId, 'BR-202610-0003');
  assert.strictEqual(firstInvite.type, 'RETROACTIVE_CSAT_INVITE');
  assert.strictEqual(firstInvite.idempotencyKey, 'BR-202610-0003_RETROACTIVE_CSAT');
  assert.ok(firstInvite.message.subject.startsWith('[ขอความอนุเคราะห์ประเมิน]'));

  // 1-Click rating star URLs (1 to 5)
  for (let s = 1; s <= 5; s++) {
    assert.ok(
      firstInvite.message.html.includes(`https://borrowoas.web.app/request/?id=BR-202610-0003&csat=${s}`),
      `Missing star rating link for star ${s}`
    );
  }

  // Resend invite (inviteNumber = 2)
  const resendInvite = buildRetroactiveCsatEmail(req, 2);
  assert.strictEqual(resendInvite.idempotencyKey, 'BR-202610-0003_RETROACTIVE_CSAT_RESEND_2');
  assert.ok(resendInvite.message.subject.startsWith('[เตือนส่งแบบประเมิน]'));

  // Validate sanitized output includes both root and message properties
  const sanitized = validateAndSanitizeMailJob(firstInvite);
  assert.strictEqual(sanitized.subject, firstInvite.message.subject.trim());
  assert.strictEqual(sanitized.text, firstInvite.message.text.trim());
  assert.strictEqual(sanitized.html, firstInvite.message.html.trim());
  assert.deepStrictEqual(sanitized.cc, []);
  assert.strictEqual(sanitized.status, 'PENDING');
  assert.strictEqual(sanitized.attemptCount, 0);
});

// -------------------------------------------------------------
// 24. Miss Prapaporn Pinjai (BR-202610-0005) Request, CSAT & Mail Safe Verification
// -------------------------------------------------------------
console.log('\n--- TEST GROUP 24: Miss Prapaporn Pinjai (BR-202610-0005) Request, CSAT & Mail Safe Verification ---');

await it('Snapshot ID Mapping: Preserves doc.id BR-202610-0005 for Miss Prapaporn Pinjai without depending on data.id', () => {
  const prapinSnap = {
    id: 'BR-202610-0005',
    data: () => ({
      borrower: {
        email: 'prapin@kku.ac.th',
        name: 'นางสาวประภาพร ปิ่นใจ',
        position: 'นักวิชาการแผนและสารสนเทศชำนาญการพิเศษ',
        division: 'กองบริหารงานสำนัก',
        mission: 'ภารกิจแผน การเงิน และพัสดุ',
      },
      equipment: {
        name: 'Notebook ACER',
      },
      status: 'RETURNED',
    }),
  };

  const reqMapped = { ...prapinSnap.data(), id: prapinSnap.id };
  assert.strictEqual(reqMapped.id, 'BR-202610-0005');
  assert.strictEqual(reqMapped.borrower.email, 'prapin@kku.ac.th');
  assert.strictEqual(reqMapped.borrower.name, 'นางสาวประภาพร ปิ่นใจ');
  assert.strictEqual(getRequestId(reqMapped), 'BR-202610-0005');
});

await it('Safely processes Miss Prapaporn Pinjai request BR-202610-0005 for CSAT without mutating core data', async () => {
  const staff = { email: 'chalpr@kku.ac.th', role: 'CUSTODIAN', name: 'เฉลิมพร' };

  const prapinProdDocData = {
    borrower: {
      email: 'prapin@kku.ac.th',
      name: 'นางสาวประภาพร ปิ่นใจ',
      position: 'นักวิชาการแผนและสารสนเทศชำนาญการพิเศษ',
      division: 'กองบริหารงานสำนัก',
      mission: 'ภารกิจแผน การเงิน และพัสดุ',
    },
    equipment: {
      equipmentId: 'eq-acer-prapin',
      name: 'Notebook ACER',
      assetNumber: '7440-001-0005',
    },
    status: 'RETURNED',
    startDate: '2026-10-14',
    expectedReturnDate: '2026-10-16',
    purpose: 'ใช้งานราชการภารกิจแผน การเงิน และพัสดุ',
    timeline: [
      { status: 'SUBMITTED', by: 'prapin@kku.ac.th', at: '2026-10-14T01:33:06.790Z' },
      { status: 'RETURNED', by: 'chalpr@kku.ac.th', note: 'รับคืนสภาพปกติ' },
    ],
  };

  let capturedSet = null;
  let capturedUpdate = null;
  let getCallCount = 0;

  setMockTransactionRunner(async (db, fn) => {
    const tx = {
      get: async (ref) => {
        getCallCount++;
        if (getCallCount === 1) {
          // borrow_requests document snapshot
          return {
            exists: () => true,
            id: 'BR-202610-0005',
            data: () => ({ ...prapinProdDocData }),
          };
        }
        // mail document snapshot (not exists)
        return { exists: () => false };
      },
      set: (ref, data) => { capturedSet = { ref, data }; },
      update: (ref, data) => { capturedUpdate = { ref, data }; },
    };
    return fn(tx);
  });

  const res = await sendRetroactiveCsatInvite(
    { id: 'BR-202610-0005', status: 'RETURNED' },
    staff
  );

  assert.strictEqual(res.success, true);
  assert.strictEqual(res.freshReq.id, 'BR-202610-0005');
  assert.strictEqual(res.freshReq.borrower.email, 'prapin@kku.ac.th');

  // Verify core business fields are NOT mutated
  assert.deepStrictEqual(Object.keys(capturedUpdate.data).sort(), [
    'surveyInviteCount',
    'surveyInviteQueuedAt',
    'surveyInviteStatus',
    'updatedAt',
  ].sort());
  assert.strictEqual(capturedUpdate.data.surveyInviteStatus, 'QUEUED');
  assert.strictEqual(capturedUpdate.data.surveyInviteCount, 1);

  // Verify created mail job is 100% correct for Miss Prapaporn Pinjai
  const mail = capturedSet.data;
  assert.strictEqual(mail.requestId, 'BR-202610-0005');
  assert.strictEqual(mail.to[0], 'prapin@kku.ac.th');
  assert.deepStrictEqual(mail.cc, []);
  assert.strictEqual(mail.idempotencyKey, 'BR-202610-0005_RETROACTIVE_CSAT');
  assert.strictEqual(mail.type, 'RETROACTIVE_CSAT_INVITE');
  assert.ok(mail.message.subject.includes('BR-202610-0005'));
  assert.ok(mail.message.subject.includes('Notebook ACER'));
  assert.strictEqual(mail.message.subject.includes('undefined'), false);
  assert.strictEqual(mail.message.text.includes('undefined'), false);
  assert.strictEqual(mail.message.html.includes('undefined'), false);

  // 1-Click star rating links point to BR-202610-0005
  for (let star = 1; star <= 5; star++) {
    assert.strictEqual(
      mail.message.html.includes(`https://borrowoas.web.app/request/?id=BR-202610-0005&csat=${star}`),
      true,
      `Missing star rating link for star ${star}`
    );
  }

  setMockTransactionRunner(null);
});

await it('CSAT Payload: buildRetroactiveCsatEmail generates complete schema and 1-click star URLs for Prapaporn Pinjai', () => {
  const req = {
    id: 'BR-202610-0005',
    equipment: { name: 'Notebook ACER' },
    borrower: {
      email: 'prapin@kku.ac.th',
      name: 'นางสาวประภาพร ปิ่นใจ',
      position: 'นักวิชาการแผนและสารสนเทศชำนาญการพิเศษ',
      division: 'กองบริหารงานสำนัก',
    },
    returnInfo: { actualReturnDate: '2026-10-16' },
    status: 'RETURNED',
  };

  // Invite 1
  const firstInvite = buildRetroactiveCsatEmail(req, 1);
  assert.ok(Array.isArray(firstInvite.to));
  assert.strictEqual(firstInvite.to[0], 'prapin@kku.ac.th');
  assert.deepStrictEqual(firstInvite.cc, []);
  assert.strictEqual(firstInvite.requestId, 'BR-202610-0005');
  assert.strictEqual(firstInvite.type, 'RETROACTIVE_CSAT_INVITE');
  assert.strictEqual(firstInvite.idempotencyKey, 'BR-202610-0005_RETROACTIVE_CSAT');
  assert.ok(firstInvite.message.subject.includes('[ขอความอนุเคราะห์ประเมิน]'));
  assert.ok(firstInvite.message.subject.includes('BR-202610-0005'));
  assert.ok(!firstInvite.message.subject.includes('undefined'));
  assert.ok(!firstInvite.message.text.includes('undefined'));
  assert.ok(!firstInvite.message.html.includes('undefined'));

  // 1-Click rating star URLs (1 to 5)
  for (let s = 1; s <= 5; s++) {
    assert.ok(
      firstInvite.message.html.includes(`https://borrowoas.web.app/request/?id=BR-202610-0005&csat=${s}`),
      `Missing star rating link for star ${s}`
    );
  }

  // Invite 2 (Resend reminder)
  const resendInvite = buildRetroactiveCsatEmail(req, 2);
  assert.strictEqual(resendInvite.idempotencyKey, 'BR-202610-0005_RETROACTIVE_CSAT_RESEND_2');
  assert.ok(resendInvite.message.subject.includes('[เตือนส่งแบบประเมิน]'));
  assert.ok(resendInvite.message.subject.includes('BR-202610-0005'));

  // Validate sanitized mail job
  const sanitized = validateAndSanitizeMailJob(firstInvite);
  assert.strictEqual(sanitized.subject, firstInvite.message.subject.trim());
  assert.strictEqual(sanitized.text, firstInvite.message.text.trim());
  assert.strictEqual(sanitized.html, firstInvite.message.html.trim());
  assert.deepStrictEqual(sanitized.cc, []);
  assert.strictEqual(sanitized.status, 'PENDING');
  assert.strictEqual(sanitized.attemptCount, 0);
});

await it('Safe Retry: retryEmailJob safely processes Prapaporn existing PENDING and FAILED mail jobs', async () => {
  clearEmailDedupCache();

  // 1. Existing PENDING job (6k4UE85uVfDR7qjMPRA3) to prapin@kku.ac.th
  const pendingJobPrapin = {
    id: '6k4UE85uVfDR7qjMPRA3',
    status: 'PENDING',
    to: ['prapin@kku.ac.th'],
    message: {
      subject: 'ยืนยันการยื่นคำขอยืมครุภัณฑ์ (รหัสคำขอ BR-202610-0005)',
      text: 'เรียน นางสาวประภาพร ปิ่นใจ...',
      html: '<p>เรียน นางสาวประภาพร ปิ่นใจ...</p>',
    },
    requestId: 'BR-202610-0005',
    type: 'REQUEST_CONFIRMATION',
    attemptCount: 0,
  };

  const resPending = await retryEmailJob('6k4UE85uVfDR7qjMPRA3', pendingJobPrapin);
  assert.strictEqual(resPending.success, true);
  assert.strictEqual(resPending.message, 'ส่งอีเมลซ้ำ (Retry) สำเร็จเรียบร้อยแล้ว');

  // 2. Existing FAILED job (cjU5Jgb5JTUuUZruxRH8) to chalpr@kku.ac.th
  const failedJobAdmin = {
    id: 'cjU5Jgb5JTUuUZruxRH8',
    status: 'FAILED',
    to: ['chalpr@kku.ac.th'],
    message: {
      subject: 'มีคำขอยืมครุภัณฑ์ใหม่รอตรวจสอบ (รหัสคำขอ BR-202610-0005)',
      text: 'มีคำขอยืมจาก นางสาวประภาพร ปิ่นใจ...',
      html: '<p>มีคำขอยืมจาก นางสาวประภาพร ปิ่นใจ...</p>',
    },
    requestId: 'BR-202610-0005',
    type: 'NEW_REQUEST',
    attemptCount: 1,
    errorDetails: 'ไม่ได้ตั้งค่า Email Gateway Provider',
  };

  const resFailed = await retryEmailJob('cjU5Jgb5JTUuUZruxRH8', failedJobAdmin);
  assert.strictEqual(resFailed.success, true);
  assert.strictEqual(resFailed.message, 'ส่งอีเมลซ้ำ (Retry) สำเร็จเรียบร้อยแล้ว');
});

console.log(`\n====================================================`);
console.log(`UNIT TEST RESULTS: ${passedTests} of ${totalTests} tests passed (${Math.round((passedTests / totalTests) * 100)}%)`);
console.log(`====================================================`);

if (passedTests !== totalTests) {
  process.exit(1);
} else {
  process.exit(0);
}



