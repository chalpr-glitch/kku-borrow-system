import fs from 'node:fs';
import path from 'node:path';
import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} from '@firebase/rules-unit-testing';
import {
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  addDoc,
  collection,
  query,
  where,
  serverTimestamp,
  writeBatch,
  runTransaction,
  Timestamp,
  deleteField,
} from 'firebase/firestore';
import { dispatchViaGateway, processMailQueueOnce, processSingleMailJob, claimMailJob, initAdmin } from './mail-worker.mjs';
import {
  runSecretsMigration,
  rollbackSecretsMigration,
  manualRecoverGatewayFromBackup,
  SECRET_FIELDS,
  ALLOWED_POLICY_FIELDS,
  EXACT_POLICY_ALLOWED_KEYS,
  analyzePolicyDocument,
} from './migrate-secrets.mjs';
import { findBookingConflicts, daysInclusive, addDays, todayStr } from '../src/lib/utils.ts';
import { createMailJobOnce, setMockQueueEmailHandler, retryEmailJob, batchProcessPendingQueue } from '../src/lib/notifications.ts';
import {
  createBorrowRequest,
  cancelRequest,
  reviewRequest,
  approveRequest,
  handoverRequest,
  returnRequest,
  requestExtension,
  reviewExtension,
  approveExtension,
  cancelExtension,
  sendRetroactiveCsatInvite,
} from '../src/lib/requests.ts';

const PROJECT_ID = 'demo-kku-oas-test';
const RULES_PATH = path.resolve('firestore.rules');

let testEnv;
let passedCount = 0;
let failedCount = 0;

function reportResult(name, passed, err = null) {
  if (passed) {
    console.log(`  ✅ [PASS] ${name}`);
    passedCount++;
  } else {
    console.error(`  ❌ [FAIL] ${name}`);
    if (err) console.error(`     Error: ${err.message || err}`);
    failedCount++;
    process.exitCode = 1;
  }
}

async function runTest(name, fn) {
  try {
    await fn();
    reportResult(name, true);
  } catch (err) {
    reportResult(name, false, err);
  }
}

async function setup() {
  process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
  process.env.GCLOUD_PROJECT = PROJECT_ID;
  process.env.FIREBASE_PROJECT_ID = PROJECT_ID;
  process.env.ALLOW_MOCK_GATEWAY = 'true';
  const { getApps, deleteApp } = await import('firebase-admin/app');
  for (const app of getApps()) {
    await deleteApp(app);
  }
  setMockQueueEmailHandler(async () => 'mock-mail-job-id');
  initAdmin({ projectId: PROJECT_ID });
  const rules = fs.readFileSync(RULES_PATH, 'utf8');
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules,
      host: '127.0.0.1',
      port: 8080,
    },
  });

  await testEnv.clearFirestore();

  // Seed baseline users using Admin context
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const adminDb = context.firestore();
    
    // 1. Borrower 1 (Active)
    await setDoc(doc(adminDb, 'users', 'borrower1@kku.ac.th'), {
      email: 'borrower1@kku.ac.th',
      name: 'สมชาย ผู้ยืม',
      role: 'USER',
      active: true,
      departmentCode: 'DEP-01',
    });

    // 2. Borrower 2 (Active)
    await setDoc(doc(adminDb, 'users', 'borrower2@kku.ac.th'), {
      email: 'borrower2@kku.ac.th',
      name: 'สมหญิง ผู้ยืมสอง',
      role: 'USER',
      active: true,
      departmentCode: 'DEP-02',
    });

    // 3. Custodian (Active Staff)
    await setDoc(doc(adminDb, 'users', 'custodian@kku.ac.th'), {
      email: 'custodian@kku.ac.th',
      name: 'นายพัสดุ ผู้ดูแล',
      role: 'CUSTODIAN',
      active: true,
      departmentCode: 'DEP-OAS',
    });

    // 4. Approver (Active Staff)
    await setDoc(doc(adminDb, 'users', 'approver@kku.ac.th'), {
      email: 'approver@kku.ac.th',
      name: 'ผอ. ผู้อนุมัติ',
      role: 'APPROVER',
      active: true,
      departmentCode: 'DEP-EXEC',
    });

    // 5. Executive (Active Management)
    await setDoc(doc(adminDb, 'users', 'executive@kku.ac.th'), {
      email: 'executive@kku.ac.th',
      name: 'ท่านผู้บริหาร',
      role: 'EXECUTIVE',
      active: true,
      departmentCode: 'DEP-EXEC',
    });

    // 6. Banned / Deactivated Account
    await setDoc(doc(adminDb, 'users', 'banned@kku.ac.th'), {
      email: 'banned@kku.ac.th',
      name: 'ผู้ใช้ถูกระงับสิทธิ์',
      role: 'USER',
      active: false,
      departmentCode: 'DEP-01',
    });

    // 7. Baseline System Settings
    await setDoc(doc(adminDb, 'system_settings', 'policy'), {
      maxBorrowDays: 15,
      advanceReminderDays: 2,
      enableTwoStepApproval: true,
      guidelines: 'นโยบายการยืมคืน',
    });

    await setDoc(doc(adminDb, 'system_settings', 'gateway_config'), {
      provider: 'MOCK',
      gasWebhookUrl: 'https://script.google.com/macros/s/SECRET_WEBHOOK/exec',
      brevoApiKey: 'xkeysib-SECRET-BREVO-KEY',
      resendApiKey: 're_SECRET_RESEND_KEY',
      custodianEmail: 'custodian@kku.ac.th',
      approverEmail: 'approver@kku.ac.th',
    });

    // 8. Baseline Counter
    await setDoc(doc(adminDb, 'counters', 'borrow_requests'), {
      '202610': 100,
    });

    // 9. Baseline Equipment
    await setDoc(doc(adminDb, 'equipments', 'EQ-001'), {
      id: 'EQ-001',
      assetNumber: '7440-001-0001/67',
      name: 'โน้ตบุ๊ก Dell Latitude 5440',
      status: 'AVAILABLE',
      isDeleted: false,
      activeBookings: [],
    });

    await setDoc(doc(adminDb, 'equipments', 'EQ-002'), {
      id: 'EQ-002',
      assetNumber: '7440-002-0002/67',
      name: 'โปรเจกเตอร์ Epson EB-X51',
      status: 'AVAILABLE',
      isDeleted: false,
      activeBookings: [],
    });

    // 10. Baseline Requests for Mail & Notification Tests
    await setDoc(doc(adminDb, 'borrow_requests', 'BR-MAIL-DEDUP'), {
      id: 'BR-MAIL-DEDUP',
      borrower: { email: 'borrower1@kku.ac.th', name: 'สมชาย ผู้ยืม' },
      status: 'PENDING_REVIEW',
    });
    await setDoc(doc(adminDb, 'borrow_requests', 'BR-USER-MAIL-01'), {
      id: 'BR-USER-MAIL-01',
      borrower: { email: 'borrower1@kku.ac.th', name: 'สมชาย ผู้ยืม' },
      status: 'PENDING_REVIEW',
    });
    await setDoc(doc(adminDb, 'borrow_requests', 'BR-OTHER-USER-01'), {
      id: 'BR-OTHER-USER-01',
      borrower: { email: 'borrower2@kku.ac.th', name: 'สมหญิง ผู้ยืมสอง' },
      status: 'PENDING_REVIEW',
    });
    await setDoc(doc(adminDb, 'borrow_requests', 'BR-STALE-CHECK'), {
      id: 'BR-STALE-CHECK',
      borrower: { email: 'borrower1@kku.ac.th', name: 'สมชาย ผู้ยืม' },
      status: 'CANCELLED',
    });
  });
}

async function runAllTests() {
  console.log('\n====================================================');
  console.log('🔒 COMPREHENSIVE FIREBASE EMULATOR & WORKER TEST SUITE');
  console.log('====================================================\n');

  await setup();

  const anonDb = testEnv.unauthenticatedContext().firestore();
  const borrower1Db = testEnv.authenticatedContext('user_b1', { email: 'borrower1@kku.ac.th' }).firestore();
  const borrower2Db = testEnv.authenticatedContext('user_b2', { email: 'borrower2@kku.ac.th' }).firestore();
  const custodianDb = testEnv.authenticatedContext('user_cust', { email: 'custodian@kku.ac.th' }).firestore();
  const approverDb = testEnv.authenticatedContext('user_appr', { email: 'approver@kku.ac.th' }).firestore();
  const executiveDb = testEnv.authenticatedContext('user_exec', { email: 'executive@kku.ac.th' }).firestore();
  const bannedDb = testEnv.authenticatedContext('user_banned', { email: 'banned@kku.ac.th' }).firestore();
  const externalDb = testEnv.authenticatedContext('user_ext', { email: 'attacker@gmail.com' }).firestore();

  const borrower1User = {
    email: 'borrower1@kku.ac.th',
    name: 'สมชาย ผู้ยืม',
    role: 'USER',
    active: true,
    departmentCode: 'DEP-01',
    employeeCode: 'EMP-01',
    position: 'นักวิชาการ',
    division: 'ฝ่ายบริการ',
    mission: 'สนับสนุน',
  };
  const borrower2User = {
    email: 'borrower2@kku.ac.th',
    name: 'สมหญิง ผู้ยืมสอง',
    role: 'USER',
    active: true,
    departmentCode: 'DEP-02',
    employeeCode: 'EMP-02',
    position: 'นักวิชาการ',
    division: 'ฝ่ายบริการ',
    mission: 'สนับสนุน',
  };
  const custodianUser = {
    email: 'custodian@kku.ac.th',
    name: 'นายพัสดุ ผู้ดูแล',
    role: 'CUSTODIAN',
    active: true,
    departmentCode: 'DEP-OAS',
    employeeCode: 'EMP-CUST',
    position: 'เจ้าหน้าที่พัสดุ',
    division: 'งานพัสดุ',
    mission: 'พัสดุ',
  };
  const approverUser = {
    email: 'approver@kku.ac.th',
    name: 'ผอ. ผู้อนุมัติ',
    role: 'APPROVER',
    active: true,
    departmentCode: 'DEP-EXEC',
    employeeCode: 'EMP-APPR',
    position: 'ผู้อำนวยการ',
    division: 'บริหาร',
    mission: 'บริหาร',
  };

  // -------------------------------------------------------------
  // GROUP 1: Authentication & Revocation Boundaries
  // -------------------------------------------------------------
  console.log('--- GROUP 1: Authentication & Revocation Boundaries ---');

  await runTest('Anonymous cannot read equipments', async () => {
    await assertFails(getDoc(doc(anonDb, 'equipments', 'EQ-001')));
  });

  await runTest('External non-KKU email cannot read equipments', async () => {
    await assertFails(getDoc(doc(externalDb, 'equipments', 'EQ-001')));
  });

  await runTest('Deactivated / Banned user cannot read equipments (0-latency revocation check)', async () => {
    await assertFails(getDoc(doc(bannedDb, 'equipments', 'EQ-001')));
  });

  await runTest('Active KKU borrower can read equipments', async () => {
    await assertSucceeds(getDoc(doc(borrower1Db, 'equipments', 'EQ-001')));
  });

  await runTest('Adversarial: Borrower CANNOT modify master data fields on equipments', async () => {
    await assertFails(updateDoc(doc(borrower1Db, 'equipments', 'EQ-001'), {
      name: 'Tampered Name',
      status: 'LOST',
    }));
  });

  await runTest('Adversarial: Approver CANNOT modify master data fields on equipments', async () => {
    await assertFails(updateDoc(doc(approverDb, 'equipments', 'EQ-001'), {
      name: 'Approver Tampered Name',
    }));
  });

  await runTest('Active users CAN update equipments lastBookingUpdatedAt (used as OCC mutex lock)', async () => {
    await assertSucceeds(updateDoc(doc(borrower1Db, 'equipments', 'EQ-001'), {
      lastBookingUpdatedAt: new Date(),
    }));
  });

  await runTest('Custodian can update equipments master document', async () => {
    await assertSucceeds(updateDoc(doc(custodianDb, 'equipments', 'EQ-001'), {
      status: 'AVAILABLE',
      note: 'อัปเดตโดยพัสดุ',
    }));
  });

  // -------------------------------------------------------------
  // GROUP 2: System Settings & Secret Separation
  // -------------------------------------------------------------
  console.log('\n--- GROUP 2: System Settings & Secret Separation ---');

  await runTest('Active borrower can read sanitized general policy document', async () => {
    await assertSucceeds(getDoc(doc(borrower1Db, 'system_settings', 'policy')));
  });

  await runTest('Anonymous user CANNOT read general policy document', async () => {
    const anonDb = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(anonDb, 'system_settings', 'policy')));
  });

  await runTest('Fail-Closed Safeguard: Policy containing legacy secrets is REJECTED for ALL client roles', async () => {
    const anonDb = testEnv.unauthenticatedContext().firestore();
    // Simulate legacy secret present in policy document via rules-disabled admin context
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await updateDoc(doc(context.firestore(), 'system_settings', 'policy'), {
        gasWebhookUrl: 'https://script.google.com/macros/s/SECRET_DIRTY_URL/exec',
      });
    });

    // ALL client roles must be rejected from reading the dirty policy document!
    await assertFails(getDoc(doc(borrower1Db, 'system_settings', 'policy')));
    await assertFails(getDoc(doc(custodianDb, 'system_settings', 'policy')));
    await assertFails(getDoc(doc(approverDb, 'system_settings', 'policy')));
    await assertFails(getDoc(doc(executiveDb, 'system_settings', 'policy')));
    await assertFails(getDoc(doc(anonDb, 'system_settings', 'policy')));

    // Sanitize policy back to clean state
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await updateDoc(doc(context.firestore(), 'system_settings', 'policy'), {
        gasWebhookUrl: deleteField(),
      });
    });

    // Once sanitized, active borrower can read again
    await assertSucceeds(getDoc(doc(borrower1Db, 'system_settings', 'policy')));
  });

  await runTest('NO client role (Borrower, Custodian, Approver, Executive, Anonymous) can read gateway_config secret document', async () => {
    const anonDb = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(borrower1Db, 'system_settings', 'gateway_config')));
    await assertFails(getDoc(doc(custodianDb, 'system_settings', 'gateway_config')));
    await assertFails(getDoc(doc(approverDb, 'system_settings', 'gateway_config')));
    await assertFails(getDoc(doc(executiveDb, 'system_settings', 'gateway_config')));
    await assertFails(getDoc(doc(anonDb, 'system_settings', 'gateway_config')));
  });

  await runTest('NO client role can write to gateway_config directly', async () => {
    const anonDb = testEnv.unauthenticatedContext().firestore();
    await assertFails(setDoc(doc(borrower1Db, 'system_settings', 'gateway_config'), { gasWebhookUrl: 'leak' }, { merge: true }));
    await assertFails(setDoc(doc(custodianDb, 'system_settings', 'gateway_config'), { gasWebhookUrl: 'leak' }, { merge: true }));
    await assertFails(setDoc(doc(approverDb, 'system_settings', 'gateway_config'), { gasWebhookUrl: 'leak' }, { merge: true }));
    await assertFails(setDoc(doc(executiveDb, 'system_settings', 'gateway_config'), { gasWebhookUrl: 'leak' }, { merge: true }));
    await assertFails(setDoc(doc(anonDb, 'system_settings', 'gateway_config'), { gasWebhookUrl: 'leak' }, { merge: true }));
  });

  await runTest('NO client role can read or write mail_queue collection (Server-only)', async () => {
    const anonDb = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(borrower1Db, 'mail_queue', 'job-1')));
    await assertFails(getDoc(doc(custodianDb, 'mail_queue', 'job-1')));
    await assertFails(setDoc(doc(borrower1Db, 'mail_queue', 'job-1'), { status: 'PENDING' }));
    await assertFails(setDoc(doc(custodianDb, 'mail_queue', 'job-1'), { status: 'PENDING' }));
    await assertFails(setDoc(doc(anonDb, 'mail_queue', 'job-1'), { status: 'PENDING' }));
  });

  await runTest('Borrower CANNOT write or modify system policy', async () => {
    await assertFails(setDoc(doc(borrower1Db, 'system_settings', 'policy'), { maxBorrowDays: 99 }, { merge: true }));
  });

  await runTest('Custodian CANNOT inject secret credentials, unknown fields, or nested objects into policy document', async () => {
    await assertFails(updateDoc(doc(custodianDb, 'system_settings', 'policy'), {
      gasWebhookUrl: 'https://evil.com/webhook',
    }));
    await assertFails(updateDoc(doc(custodianDb, 'system_settings', 'policy'), {
      brevoApiKey: 'xkeysib-injected-secret',
    }));
    await assertFails(updateDoc(doc(custodianDb, 'system_settings', 'policy'), {
      resendApiKey: 're_injected_secret',
    }));
    // Unknown field injection attempt
    await assertFails(updateDoc(doc(custodianDb, 'system_settings', 'policy'), {
      unknownSecretField: 'hidden_credential_123',
    }));
    // Nested object injection attempt (top-level unknown map)
    await assertFails(updateDoc(doc(custodianDb, 'system_settings', 'policy'), {
      nestedSecretConfig: { apiKey: 'secret-nested-key' },
    }));
    // Nested object stuffed inside an allowed field
    await assertFails(updateDoc(doc(custodianDb, 'system_settings', 'policy'), {
      guidelines: { hiddenSecret: 'stuffed-in-guidelines' },
    }));
    // Forging server-only sanitization/rollback metadata from client
    await assertFails(updateDoc(doc(custodianDb, 'system_settings', 'policy'), {
      rolledBackFromBackup: true,
    }));
  });

  await runTest('Fail-Closed Safeguard: Policy containing unknownSecretField or nested object is REJECTED on read for ALL client roles', async () => {
    const anonDb = testEnv.unauthenticatedContext().firestore();
    // 1. Inject unknownSecretField via Admin context
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await updateDoc(doc(context.firestore(), 'system_settings', 'policy'), {
        unknownSecretField: 'leaked_unknown_key',
      });
    });

    await assertFails(getDoc(doc(borrower1Db, 'system_settings', 'policy')));
    await assertFails(getDoc(doc(custodianDb, 'system_settings', 'policy')));
    await assertFails(getDoc(doc(approverDb, 'system_settings', 'policy')));
    await assertFails(getDoc(doc(executiveDb, 'system_settings', 'policy')));
    await assertFails(getDoc(doc(anonDb, 'system_settings', 'policy')));

    // 2. Replace with nested object inside policy
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await updateDoc(doc(context.firestore(), 'system_settings', 'policy'), {
        unknownSecretField: deleteField(),
        guidelines: { nestedSecret: 'leaked_nested_map' },
      });
    });

    await assertFails(getDoc(doc(borrower1Db, 'system_settings', 'policy')));
    await assertFails(getDoc(doc(custodianDb, 'system_settings', 'policy')));
    await assertFails(getDoc(doc(approverDb, 'system_settings', 'policy')));
    await assertFails(getDoc(doc(executiveDb, 'system_settings', 'policy')));
    await assertFails(getDoc(doc(anonDb, 'system_settings', 'policy')));

    // Restore clean primitive guidelines
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await updateDoc(doc(context.firestore(), 'system_settings', 'policy'), {
        guidelines: 'นโยบายการยืมคืน',
      });
    });

    await assertSucceeds(getDoc(doc(borrower1Db, 'system_settings', 'policy')));
    await assertSucceeds(getDoc(doc(custodianDb, 'system_settings', 'policy')));
    await assertSucceeds(getDoc(doc(approverDb, 'system_settings', 'policy')));
    await assertSucceeds(getDoc(doc(executiveDb, 'system_settings', 'policy')));
  });

  await runTest('Custodian CAN update all allowlisted non-secret fields in system policy', async () => {
    await assertSucceeds(updateDoc(doc(custodianDb, 'system_settings', 'policy'), {
      maxBorrowDays: 15,
      advanceReminderDays: 2,
      enableTwoStepApproval: true,
      enableTestMode: false,
      enableEmailNotifications: true,
      guidelines: 'นโยบายการยืมคืนมาตรฐาน',
      custodianEmail: 'custodian@kku.ac.th',
      approverEmail: 'approver@kku.ac.th',
      emailProvider: 'MOCK',
      updatedAt: new Date().toISOString(),
      updatedBy: 'custodian@kku.ac.th',
    }));
  });

  // -------------------------------------------------------------
  // GROUP 3: Users Collection & Self-Registration Prevention
  // -------------------------------------------------------------
  console.log('\n--- GROUP 3: Users Collection & Self-Registration Prevention ---');

  await runTest('Borrower CANNOT self-create new user account with active: true', async () => {
    const unregDb = testEnv.authenticatedContext('new_user', { email: 'newperson@kku.ac.th' }).firestore();
    await assertFails(setDoc(doc(unregDb, 'users', 'newperson@kku.ac.th'), {
      email: 'newperson@kku.ac.th',
      name: 'Unregistered Staff',
      role: 'USER',
      active: true,
    }));
  });

  await runTest('Borrower CANNOT elevate role or change active status', async () => {
    await assertFails(updateDoc(doc(borrower1Db, 'users', 'borrower1@kku.ac.th'), { role: 'APPROVER' }));
  });

  await runTest('Custodian can manage user accounts', async () => {
    await assertSucceeds(updateDoc(doc(custodianDb, 'users', 'borrower1@kku.ac.th'), { name: 'สมชาย แก้ไขชื่อ' }));
  });

  // -------------------------------------------------------------
  // GROUP 4: Borrow Request Creation & Atomic Booking Sync Protection
  // -------------------------------------------------------------
  console.log('\n--- GROUP 4: Borrow Request Creation & Atomic Booking Protection ---');

  await runTest('Active borrower can create valid request + booking atomically via batch', async () => {
    const batch = writeBatch(borrower1Db);
    batch.set(doc(borrower1Db, 'borrow_requests', 'BR-202610-0001'), {
      id: 'BR-202610-0001',
      status: 'PENDING_REVIEW',
      borrower: { email: 'borrower1@kku.ac.th', name: 'สมชาย ผู้ยืม' },
      equipment: { equipmentId: 'EQ-001', name: 'Dell Latitude 5440' },
      purpose: 'ใช้จัดฝึกอบรม',
      startDate: '2026-10-10',
      expectedReturnDate: '2026-10-15', // 6 days inclusive (10 to 15)
      durationDays: 6,
      timeline: [{ status: 'PENDING_REVIEW', by: 'borrower1@kku.ac.th' }],
    });
    batch.set(doc(borrower1Db, 'equipment_bookings', 'BR-202610-0001'), {
      equipmentId: 'EQ-001',
      startDate: '2026-10-10',
      expectedReturnDate: '2026-10-15',
      requestId: 'BR-202610-0001',
      status: 'ACTIVE',
      updatedAt: new Date(),
    });
    batch.update(doc(borrower1Db, 'equipments', 'EQ-001'), {
      lastBookingUpdatedAt: new Date(),
    });
    await assertSucceeds(batch.commit());
  });

  await runTest('Adversarial: Creating borrow_request WITHOUT syncing equipment_bookings is REJECTED', async () => {
    await assertFails(setDoc(doc(borrower1Db, 'borrow_requests', 'BR-202610-0099'), {
      id: 'BR-202610-0099',
      status: 'PENDING_REVIEW',
      borrower: { email: 'borrower1@kku.ac.th', name: 'สมชาย' },
      equipment: { equipmentId: 'EQ-001', name: 'Dell Latitude 5440' },
      purpose: 'ทดสอบ',
      startDate: '2026-10-10',
      expectedReturnDate: '2026-10-15',
      durationDays: 5,
      timeline: [{ status: 'PENDING_REVIEW', by: 'borrower1@kku.ac.th' }],
    }));
  });

  await runTest('Adversarial: Creating equipment_booking WITHOUT matching borrow_request is REJECTED', async () => {
    await assertFails(setDoc(doc(borrower1Db, 'equipment_bookings', 'FAKE-REQ-001'), {
      equipmentId: 'EQ-001',
      startDate: '2026-10-10',
      expectedReturnDate: '2026-10-15',
      requestId: 'FAKE-REQ-001',
      status: 'ACTIVE',
      updatedAt: new Date(),
    }));
  });

  await runTest('Adversarial: Injecting PII or extra fields into equipment_bookings is REJECTED', async () => {
    const batch = writeBatch(borrower1Db);
    batch.set(doc(borrower1Db, 'borrow_requests', 'BR-202610-0002'), {
      id: 'BR-202610-0002',
      status: 'PENDING_REVIEW',
      borrower: { email: 'borrower1@kku.ac.th', name: 'สมชาย' },
      equipment: { equipmentId: 'EQ-001', name: 'Dell Latitude 5440' },
      purpose: 'ทดสอบ',
      startDate: '2026-10-16',
      expectedReturnDate: '2026-10-20',
      durationDays: 4,
      timeline: [{ status: 'PENDING_REVIEW', by: 'borrower1@kku.ac.th' }],
    });
    batch.set(doc(borrower1Db, 'equipment_bookings', 'BR-202610-0002'), {
      equipmentId: 'EQ-001',
      startDate: '2026-10-16',
      expectedReturnDate: '2026-10-20',
      requestId: 'BR-202610-0002',
      status: 'ACTIVE',
      updatedAt: new Date(),
      borrowerEmail: 'borrower1@kku.ac.th', // PII field violation!
    });
    await assertFails(batch.commit());
  });

  await runTest('Borrower CANNOT create request for another user email', async () => {
    const batch = writeBatch(borrower1Db);
    batch.set(doc(borrower1Db, 'borrow_requests', 'BR-202610-0003'), {
      id: 'BR-202610-0003',
      status: 'PENDING_REVIEW',
      borrower: { email: 'borrower2@kku.ac.th', name: 'สมหญิง' },
      equipment: { equipmentId: 'EQ-001' },
      startDate: '2026-10-10',
      expectedReturnDate: '2026-10-15',
      durationDays: 5,
      timeline: [{ status: 'PENDING_REVIEW', by: 'borrower1@kku.ac.th' }],
    });
    batch.set(doc(borrower1Db, 'equipment_bookings', 'BR-202610-0003'), {
      equipmentId: 'EQ-001',
      startDate: '2026-10-10',
      expectedReturnDate: '2026-10-15',
      requestId: 'BR-202610-0003',
      status: 'ACTIVE',
      updatedAt: new Date(),
    });
    await assertFails(batch.commit());
  });

  await runTest('Borrower CANNOT inject approval object during creation', async () => {
    const batch = writeBatch(borrower1Db);
    batch.set(doc(borrower1Db, 'borrow_requests', 'BR-202610-0004'), {
      id: 'BR-202610-0004',
      status: 'PENDING_REVIEW',
      borrower: { email: 'borrower1@kku.ac.th', name: 'สมชาย' },
      equipment: { equipmentId: 'EQ-001' },
      startDate: '2026-10-10',
      expectedReturnDate: '2026-10-15',
      durationDays: 5,
      approval: { result: 'APPROVED', approverEmail: 'fake@kku.ac.th' },
      timeline: [{ status: 'PENDING_REVIEW', by: 'borrower1@kku.ac.th' }],
    });
    batch.set(doc(borrower1Db, 'equipment_bookings', 'BR-202610-0004'), {
      equipmentId: 'EQ-001',
      startDate: '2026-10-10',
      expectedReturnDate: '2026-10-15',
      requestId: 'BR-202610-0004',
      status: 'ACTIVE',
      updatedAt: new Date(),
    });
    await assertFails(batch.commit());
  });

  await runTest('Adversarial: Borrower 2 CANNOT alter Borrower 1 equipment_booking directly', async () => {
    await assertFails(updateDoc(doc(borrower2Db, 'equipment_bookings', 'BR-202610-0001'), {
      status: 'CANCELLED',
      updatedAt: new Date(),
    }));
  });

  await runTest('Adversarial: Updating equipment_booking without matching borrow_request status is REJECTED', async () => {
    await assertFails(updateDoc(doc(borrower1Db, 'equipment_bookings', 'BR-202610-0001'), {
      status: 'CANCELLED',
      updatedAt: new Date(),
    }));
  });

  // -------------------------------------------------------------
  // GROUP 5: Request Read & Query Isolation
  // -------------------------------------------------------------
  console.log('\n--- GROUP 5: Request Read & Query Isolation ---');

  await runTest('Borrower 1 can read own request BR-202610-0001', async () => {
    await assertSucceeds(getDoc(doc(borrower1Db, 'borrow_requests', 'BR-202610-0001')));
  });

  await runTest('Borrower 2 CANNOT read Borrower 1 request', async () => {
    await assertFails(getDoc(doc(borrower2Db, 'borrow_requests', 'BR-202610-0001')));
  });

  await runTest('Borrower 1 can query filtered list of own requests', async () => {
    const q = query(collection(borrower1Db, 'borrow_requests'), where('borrower.email', '==', 'borrower1@kku.ac.th'));
    await assertSucceeds(getDocs(q));
  });

  await runTest('Borrower 1 CANNOT query all borrow requests without filter', async () => {
    await assertFails(getDocs(collection(borrower1Db, 'borrow_requests')));
  });

  await runTest('Custodian can query all borrow requests', async () => {
    await assertSucceeds(getDocs(collection(custodianDb, 'borrow_requests')));
  });

  // -------------------------------------------------------------
  // GROUP 6: Request Transitions & Extension State Machine
  // -------------------------------------------------------------
  console.log('\n--- GROUP 6: Request Transitions & Extension State Machine ---');

  await runTest('Negative Test: Truncating timeline history array is rejected', async () => {
    await assertFails(updateDoc(doc(borrower1Db, 'borrow_requests', 'BR-202610-0001'), {
      timeline: [],
      updatedAt: new Date(),
    }));
  });

  await runTest('Negative Test: Replacing existing timeline history entries is rejected', async () => {
    await assertFails(updateDoc(doc(borrower1Db, 'borrow_requests', 'BR-202610-0001'), {
      timeline: [
        { status: 'CANCELLED', by: 'attacker@kku.ac.th', note: 'Tampered initial log' },
        { status: 'CANCELLED', by: 'borrower1@kku.ac.th' }
      ],
      updatedAt: new Date(),
    }));
  });

  await runTest('Borrower CAN cancel own request with booking synced to CANCELLED', async () => {
    const batch = writeBatch(borrower1Db);
    batch.update(doc(borrower1Db, 'borrow_requests', 'BR-202610-0001'), {
      status: 'CANCELLED',
      cancel: { reason: 'ขอยกเลิก', cancelledAt: new Date() },
      timeline: [
        { status: 'PENDING_REVIEW', by: 'borrower1@kku.ac.th' },
        { status: 'CANCELLED', by: 'borrower1@kku.ac.th' }
      ],
      updatedAt: new Date(),
    });
    batch.update(doc(borrower1Db, 'equipment_bookings', 'BR-202610-0001'), {
      status: 'CANCELLED',
      updatedAt: new Date(),
    });
    await assertSucceeds(batch.commit());
  });

  // Prepare BR-202610-0010 for full workflow progression
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), 'borrow_requests', 'BR-202610-0010'), {
      id: 'BR-202610-0010',
      status: 'PENDING_REVIEW',
      borrower: { email: 'borrower1@kku.ac.th', name: 'สมชาย ผู้ยืม' },
      equipment: { equipmentId: 'EQ-001', name: 'Dell Latitude 5440' },
      startDate: '2026-10-10',
      expectedReturnDate: '2026-10-15',
      durationDays: 5,
      timeline: [{ status: 'PENDING_REVIEW', by: 'borrower1@kku.ac.th' }],
    });
    await setDoc(doc(context.firestore(), 'equipment_bookings', 'BR-202610-0010'), {
      equipmentId: 'EQ-001',
      startDate: '2026-10-10',
      expectedReturnDate: '2026-10-15',
      requestId: 'BR-202610-0010',
      status: 'ACTIVE',
      updatedAt: new Date(),
    });
  });

  await runTest('Custodian can review request and move to PENDING_APPROVAL', async () => {
    await assertSucceeds(updateDoc(doc(custodianDb, 'borrow_requests', 'BR-202610-0010'), {
      status: 'PENDING_APPROVAL',
      review: { reviewerEmail: 'custodian@kku.ac.th', result: 'PASSED' },
      timeline: [
        { status: 'PENDING_REVIEW', by: 'borrower1@kku.ac.th' },
        { status: 'PENDING_APPROVAL', by: 'custodian@kku.ac.th' }
      ],
      updatedAt: new Date(),
    }));
  });

  await runTest('Approver can approve request and move to APPROVED_WAITING_PICKUP', async () => {
    await assertSucceeds(updateDoc(doc(approverDb, 'borrow_requests', 'BR-202610-0010'), {
      status: 'APPROVED_WAITING_PICKUP',
      approval: { approverEmail: 'approver@kku.ac.th', result: 'APPROVED' },
      timeline: [
        { status: 'PENDING_REVIEW', by: 'borrower1@kku.ac.th' },
        { status: 'PENDING_APPROVAL', by: 'custodian@kku.ac.th' },
        { status: 'APPROVED_WAITING_PICKUP', by: 'approver@kku.ac.th' }
      ],
      updatedAt: new Date(),
    }));
  });

  await runTest('Custodian can perform Handover and move to IN_USE', async () => {
    await assertSucceeds(updateDoc(doc(custodianDb, 'borrow_requests', 'BR-202610-0010'), {
      status: 'IN_USE',
      handover: { custodianEmail: 'custodian@kku.ac.th', handoverDate: '2026-10-10' },
      timeline: [
        { status: 'PENDING_REVIEW', by: 'borrower1@kku.ac.th' },
        { status: 'PENDING_APPROVAL', by: 'custodian@kku.ac.th' },
        { status: 'APPROVED_WAITING_PICKUP', by: 'approver@kku.ac.th' },
        { status: 'IN_USE', by: 'custodian@kku.ac.th' }
      ],
      updatedAt: new Date(),
    }));
  });

  await runTest('Borrower can submit 1st extension request (PENDING_REVIEW)', async () => {
    await assertSucceeds(updateDoc(doc(borrower1Db, 'borrow_requests', 'BR-202610-0010'), {
      extension: {
        status: 'PENDING_REVIEW',
        requestedBy: 'borrower1@kku.ac.th',
        newExpectedReturnDate: '2026-10-20',
        reason: 'งานยังไม่เสร็จ',
        addedDays: 5,
      },
      timeline: [
        { status: 'PENDING_REVIEW', by: 'borrower1@kku.ac.th' },
        { status: 'PENDING_APPROVAL', by: 'custodian@kku.ac.th' },
        { status: 'APPROVED_WAITING_PICKUP', by: 'approver@kku.ac.th' },
        { status: 'IN_USE', by: 'custodian@kku.ac.th' },
        { status: 'IN_USE', note: 'ขอต่ออายุครั้งที่ 1', by: 'borrower1@kku.ac.th' }
      ],
      updatedAt: new Date(),
    }));
  });

  await runTest('Negative Test: Approver CANNOT bypass custodian review on 1st extension', async () => {
    await assertFails(updateDoc(doc(approverDb, 'borrow_requests', 'BR-202610-0010'), {
      expectedReturnDate: '2026-10-20',
      deadlineVersion: 2,
      extension: { status: 'APPROVED', approval: { approverEmail: 'approver@kku.ac.th' } },
      extensionHistory: [{ extensionNumber: 1, newExpectedReturnDate: '2026-10-20', status: 'APPROVED' }],
    }));
  });

  await runTest('Custodian reviews 1st extension (freezes requested details, moves to PENDING_APPROVAL)', async () => {
    await assertSucceeds(updateDoc(doc(custodianDb, 'borrow_requests', 'BR-202610-0010'), {
      extension: {
        status: 'PENDING_APPROVAL',
        requestedBy: 'borrower1@kku.ac.th',
        newExpectedReturnDate: '2026-10-20',
        reason: 'งานยังไม่เสร็จ',
        addedDays: 5,
        review: { reviewerEmail: 'custodian@kku.ac.th', result: 'PASSED' },
      },
      timeline: [
        { status: 'PENDING_REVIEW', by: 'borrower1@kku.ac.th' },
        { status: 'PENDING_APPROVAL', by: 'custodian@kku.ac.th' },
        { status: 'APPROVED_WAITING_PICKUP', by: 'approver@kku.ac.th' },
        { status: 'IN_USE', by: 'custodian@kku.ac.th' },
        { status: 'IN_USE', note: 'ขอต่ออายุครั้งที่ 1', by: 'borrower1@kku.ac.th' },
        { status: 'IN_USE', note: 'ผู้ดูแลตรวจผ่าน', by: 'custodian@kku.ac.th' }
      ],
      updatedAt: new Date(),
    }));
  });

  await runTest('Approver approves 1st extension (syncs return date, deadlineVersion, durationDays & booking)', async () => {
    const batch = writeBatch(approverDb);
    batch.update(doc(approverDb, 'borrow_requests', 'BR-202610-0010'), {
      expectedReturnDate: '2026-10-20',
      durationDays: 11,
      deadlineVersion: 2,
      extension: {
        status: 'APPROVED',
        requestedBy: 'borrower1@kku.ac.th',
        newExpectedReturnDate: '2026-10-20',
        reason: 'งานยังไม่เสร็จ',
        addedDays: 5,
        review: { reviewerEmail: 'custodian@kku.ac.th', result: 'PASSED' },
        approval: { approverEmail: 'approver@kku.ac.th', result: 'APPROVED' }
      },
      extensionHistory: [{ extensionNumber: 1, newExpectedReturnDate: '2026-10-20', status: 'APPROVED' }],
      timeline: [
        { status: 'PENDING_REVIEW', by: 'borrower1@kku.ac.th' },
        { status: 'PENDING_APPROVAL', by: 'custodian@kku.ac.th' },
        { status: 'APPROVED_WAITING_PICKUP', by: 'approver@kku.ac.th' },
        { status: 'IN_USE', by: 'custodian@kku.ac.th' },
        { status: 'IN_USE', note: 'ขอต่ออายุครั้งที่ 1', by: 'borrower1@kku.ac.th' },
        { status: 'IN_USE', note: 'ผู้ดูแลตรวจผ่าน', by: 'custodian@kku.ac.th' },
        { status: 'IN_USE', note: 'อนุมัติต่ออายุครั้งที่ 1', by: 'approver@kku.ac.th' }
      ],
      updatedAt: new Date(),
    });
    batch.update(doc(approverDb, 'equipment_bookings', 'BR-202610-0010'), {
      expectedReturnDate: '2026-10-20',
      updatedAt: new Date(),
    });
    batch.update(doc(approverDb, 'equipments', 'EQ-001'), {
      lastBookingUpdatedAt: new Date(),
    });
    await assertSucceeds(batch.commit());
  });

  await runTest('Borrower can submit 2nd extension after 1st was APPROVED', async () => {
    await assertSucceeds(updateDoc(doc(borrower1Db, 'borrow_requests', 'BR-202610-0010'), {
      extension: {
        status: 'PENDING_REVIEW',
        requestedBy: 'borrower1@kku.ac.th',
        newExpectedReturnDate: '2026-10-25',
        reason: 'ขอต่อรอบสอง',
        addedDays: 5,
      },
      timeline: [
        { status: 'PENDING_REVIEW', by: 'borrower1@kku.ac.th' },
        { status: 'PENDING_APPROVAL', by: 'custodian@kku.ac.th' },
        { status: 'APPROVED_WAITING_PICKUP', by: 'approver@kku.ac.th' },
        { status: 'IN_USE', by: 'custodian@kku.ac.th' },
        { status: 'IN_USE', note: 'ขอต่ออายุครั้งที่ 1', by: 'borrower1@kku.ac.th' },
        { status: 'IN_USE', note: 'ผู้ดูแลตรวจผ่าน', by: 'custodian@kku.ac.th' },
        { status: 'IN_USE', note: 'อนุมัติต่ออายุครั้งที่ 1', by: 'approver@kku.ac.th' },
        { status: 'IN_USE', note: 'ขอต่ออายุครั้งที่ 2', by: 'borrower1@kku.ac.th' }
      ],
      updatedAt: new Date(),
    }));
  });

  await runTest('Borrower can cancel own extension when PENDING_REVIEW', async () => {
    await assertSucceeds(updateDoc(doc(borrower1Db, 'borrow_requests', 'BR-202610-0010'), {
      extension: {
        status: 'CANCELLED',
        requestedBy: 'borrower1@kku.ac.th',
        newExpectedReturnDate: '2026-10-25',
        reason: 'ขอต่อรอบสอง',
        addedDays: 5,
      },
      timeline: [
        { status: 'PENDING_REVIEW', by: 'borrower1@kku.ac.th' },
        { status: 'PENDING_APPROVAL', by: 'custodian@kku.ac.th' },
        { status: 'APPROVED_WAITING_PICKUP', by: 'approver@kku.ac.th' },
        { status: 'IN_USE', by: 'custodian@kku.ac.th' },
        { status: 'IN_USE', note: 'ขอต่ออายุครั้งที่ 1', by: 'borrower1@kku.ac.th' },
        { status: 'IN_USE', note: 'ผู้ดูแลตรวจผ่าน', by: 'custodian@kku.ac.th' },
        { status: 'IN_USE', note: 'อนุมัติต่ออายุครั้งที่ 1', by: 'approver@kku.ac.th' },
        { status: 'IN_USE', note: 'ขอต่ออายุครั้งที่ 2', by: 'borrower1@kku.ac.th' },
        { status: 'IN_USE', note: 'ผู้ยืมยกเลิกคำขอต่ออายุ', by: 'borrower1@kku.ac.th' }
      ],
      updatedAt: new Date(),
    }));
  });

  await runTest('Custodian returns equipment and auto-closes pending extension, preserving original fields', async () => {
    // Borrower requests extension 3
    await updateDoc(doc(borrower1Db, 'borrow_requests', 'BR-202610-0010'), {
      extension: {
        status: 'PENDING_REVIEW',
        requestedBy: 'borrower1@kku.ac.th',
        newExpectedReturnDate: '2026-10-30',
        reason: 'ขอต่อรอบสุดท้าย',
        addedDays: 5,
      },
      timeline: [
        { status: 'PENDING_REVIEW', by: 'borrower1@kku.ac.th' },
        { status: 'PENDING_APPROVAL', by: 'custodian@kku.ac.th' },
        { status: 'APPROVED_WAITING_PICKUP', by: 'approver@kku.ac.th' },
        { status: 'IN_USE', by: 'custodian@kku.ac.th' },
        { status: 'IN_USE', note: 'ขอต่ออายุครั้งที่ 1', by: 'borrower1@kku.ac.th' },
        { status: 'IN_USE', note: 'ผู้ดูแลตรวจผ่าน', by: 'custodian@kku.ac.th' },
        { status: 'IN_USE', note: 'อนุมัติต่ออายุครั้งที่ 1', by: 'approver@kku.ac.th' },
        { status: 'IN_USE', note: 'ขอต่ออายุครั้งที่ 2', by: 'borrower1@kku.ac.th' },
        { status: 'IN_USE', note: 'ผู้ยืมยกเลิกคำขอต่ออายุ', by: 'borrower1@kku.ac.th' },
        { status: 'IN_USE', note: 'ขอต่อรอบสุดท้าย', by: 'borrower1@kku.ac.th' }
      ],
      updatedAt: new Date(),
    });

    const batch = writeBatch(custodianDb);
    batch.update(doc(custodianDb, 'borrow_requests', 'BR-202610-0010'), {
      status: 'RETURNED',
      returnInfo: {
        actualReturnDate: '2026-10-20',
        receivedByEmail: 'custodian@kku.ac.th',
        condition: 'NORMAL',
        remarks: 'ส่งคืนครบถ้วน',
      },
      extension: {
        status: 'CANCELLED',
        requestedBy: 'borrower1@kku.ac.th',
        newExpectedReturnDate: '2026-10-30',
        reason: 'ขอต่อรอบสุดท้าย',
        addedDays: 5,
      },
      timeline: [
        { status: 'PENDING_REVIEW', by: 'borrower1@kku.ac.th' },
        { status: 'PENDING_APPROVAL', by: 'custodian@kku.ac.th' },
        { status: 'APPROVED_WAITING_PICKUP', by: 'approver@kku.ac.th' },
        { status: 'IN_USE', by: 'custodian@kku.ac.th' },
        { status: 'IN_USE', note: 'ขอต่ออายุครั้งที่ 1', by: 'borrower1@kku.ac.th' },
        { status: 'IN_USE', note: 'ผู้ดูแลตรวจผ่าน', by: 'custodian@kku.ac.th' },
        { status: 'IN_USE', note: 'อนุมัติต่ออายุครั้งที่ 1', by: 'approver@kku.ac.th' },
        { status: 'IN_USE', note: 'ขอต่ออายุครั้งที่ 2', by: 'borrower1@kku.ac.th' },
        { status: 'IN_USE', note: 'ผู้ยืมยกเลิกคำขอต่ออายุ', by: 'borrower1@kku.ac.th' },
        { status: 'IN_USE', note: 'ขอต่อรอบสุดท้าย', by: 'borrower1@kku.ac.th' },
        { status: 'RETURNED', note: 'รับคืนเรียบร้อย', by: 'custodian@kku.ac.th' }
      ],
      updatedAt: new Date(),
    });
    batch.update(doc(custodianDb, 'equipment_bookings', 'BR-202610-0010'), {
      status: 'RETURNED',
      updatedAt: new Date(),
    });
    await assertSucceeds(batch.commit());
  });

  // -------------------------------------------------------------
  // GROUP 7: Staff as Borrower Workflow Isolation
  // -------------------------------------------------------------
  console.log('\n--- GROUP 7: Staff as Borrower Workflow Isolation ---');

  // Seed BR-202610-0077 where borrower is Custodian
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), 'borrow_requests', 'BR-202610-0077'), {
      id: 'BR-202610-0077',
      status: 'IN_USE',
      borrower: { email: 'custodian@kku.ac.th', name: 'นายพัสดุ ผู้ดูแล' },
      equipment: { equipmentId: 'EQ-002', name: 'Epson EB-X51' },
      startDate: '2026-10-10',
      expectedReturnDate: '2026-10-15',
      durationDays: 5,
      timeline: [
        { status: 'PENDING_REVIEW', by: 'custodian@kku.ac.th' },
        { status: 'IN_USE', by: 'custodian@kku.ac.th' }
      ],
    });
    await setDoc(doc(context.firestore(), 'equipment_bookings', 'BR-202610-0077'), {
      equipmentId: 'EQ-002',
      startDate: '2026-10-10',
      expectedReturnDate: '2026-10-15',
      requestId: 'BR-202610-0077',
      status: 'ACTIVE',
      updatedAt: new Date(),
    });
  });

  await runTest('Active CUSTODIAN role can submit extension for own borrow request', async () => {
    await assertSucceeds(updateDoc(doc(custodianDb, 'borrow_requests', 'BR-202610-0077'), {
      extension: {
        status: 'PENDING_REVIEW',
        requestedBy: 'custodian@kku.ac.th',
        newExpectedReturnDate: '2026-10-20',
        reason: 'ขอใช้ต่อในงานสัมมนา',
        addedDays: 5,
      },
      timeline: [
        { status: 'PENDING_REVIEW', by: 'custodian@kku.ac.th' },
        { status: 'IN_USE', by: 'custodian@kku.ac.th' },
        { status: 'IN_USE', note: 'ขอต่ออายุ', by: 'custodian@kku.ac.th' }
      ],
      updatedAt: new Date(),
    }));
  });

  await runTest('Active CUSTODIAN role can cancel own extension', async () => {
    await assertSucceeds(updateDoc(doc(custodianDb, 'borrow_requests', 'BR-202610-0077'), {
      extension: {
        status: 'CANCELLED',
        requestedBy: 'custodian@kku.ac.th',
        newExpectedReturnDate: '2026-10-20',
        reason: 'ขอใช้ต่อในงานสัมมนา',
        addedDays: 5,
      },
      timeline: [
        { status: 'PENDING_REVIEW', by: 'custodian@kku.ac.th' },
        { status: 'IN_USE', by: 'custodian@kku.ac.th' },
        { status: 'IN_USE', note: 'ขอต่ออายุ', by: 'custodian@kku.ac.th' },
        { status: 'IN_USE', note: 'ยกเลิกต่ออายุ', by: 'custodian@kku.ac.th' }
      ],
      updatedAt: new Date(),
    }));
  });

  // -------------------------------------------------------------
  // GROUP 8: Gateway Response Strict Handling Unit Tests
  // -------------------------------------------------------------
  console.log('\n--- GROUP 8: Gateway Response Schema Strict Handling ---');

  await runTest('Rejects non-JSON HTML page response without marking SUCCESS', async () => {
    const mockHtmlFetch = async () => ({
      ok: true,
      status: 200,
      text: async () => '<html><body>Error: Login Required</body></html>',
    });
    const res = await dispatchViaGateway(
      { to: ['user@kku.ac.th'], message: { subject: 'test', html: 'test' } },
      { provider: 'GOOGLE_APPS_SCRIPT', gasWebhookUrl: 'https://mock.gas' },
      mockHtmlFetch
    );
    if (res.success || res.status === 'SUCCESS') throw new Error('HTML response must not succeed');
  });

  await runTest('Rejects empty body response from Gateway', async () => {
    const mockEmptyFetch = async () => ({
      ok: true,
      status: 200,
      text: async () => '',
    });
    const res = await dispatchViaGateway(
      { to: ['user@kku.ac.th'], message: { subject: 'test', html: 'test' } },
      { provider: 'GOOGLE_APPS_SCRIPT', gasWebhookUrl: 'https://mock.gas' },
      mockEmptyFetch
    );
    if (res.success || res.status === 'SUCCESS') throw new Error('Empty response must not succeed');
  });

  await runTest('Accepts valid JSON response schema { status: SUCCESS, messageId }', async () => {
    const mockValidFetch = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ status: 'SUCCESS', messageId: 'msg_12345' }),
    });
    const res = await dispatchViaGateway(
      { to: ['user@kku.ac.th'], message: { subject: 'test', html: 'test' } },
      { provider: 'GOOGLE_APPS_SCRIPT', gasWebhookUrl: 'https://mock.gas' },
      mockValidFetch
    );
    if (!res.success || res.messageId !== 'msg_12345') throw new Error('Valid JSON must succeed');
  });

  // -------------------------------------------------------------
  // GROUP 9: End-to-End Background Worker Processing
  // -------------------------------------------------------------
  console.log('\n--- GROUP 9: End-to-End Background Worker Processing ---');

  let workerTestMailId;
  await runTest('USER queues mail with browser closed (Worker executes independently)', async () => {
    const docRef = await addDoc(collection(borrower1Db, 'mail'), {
      to: ['custodian@kku.ac.th'],
      senderEmail: 'borrower1@kku.ac.th',
      type: 'NEW_REQUEST',
      requestId: 'BR-USER-MAIL-01',
      status: 'PENDING',
      message: { subject: 'คำขอใหม่', text: 'รายละเอียด', html: '<p>รายละเอียด</p>' },
      createdAt: new Date(),
    });
    workerTestMailId = docRef.id;
  });

  await runTest('Background Worker sweeps pending job and dispatches via Mock Gateway', async () => {
    const res = await processMailQueueOnce();
    if (res.successCount < 1) throw new Error('Background worker did not process pending mail job');
  });

  // -------------------------------------------------------------
  // GROUP 10: Secrets Migration & Policy Sanitization (Strict Allowlist & Adversarial Suite)
  // -------------------------------------------------------------
  console.log('\n--- GROUP 10: Secrets Migration & Policy Sanitization ---');

  await runTest('Secrets Migration: Dry-run detects secrets, unknown fields, and nested objects without modifying database', async () => {
    const anonDb = testEnv.unauthenticatedContext().firestore();
    // 1. Inject legacy secrets, unknownSecretField, and nested map into policy
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await updateDoc(doc(context.firestore(), 'system_settings', 'policy'), {
        gasWebhookUrl: 'https://script.google.com/macros/s/LEGACY_GAS_SECRET/exec',
        brevoApiKey: 'xkeysib-LEGACY_BREVO_SECRET',
        resendApiKey: 're_LEGACY_RESEND_SECRET',
        unknownSecretField: 'unknown_secret_token_999',
        nestedSecretMap: { innerKey: 'inner_secret_value' },
      });
    });

    // 2. Rules fail-closed safeguard: NO client role can read dirty policy
    await assertFails(getDoc(doc(borrower1Db, 'system_settings', 'policy')));
    await assertFails(getDoc(doc(custodianDb, 'system_settings', 'policy')));
    await assertFails(getDoc(doc(approverDb, 'system_settings', 'policy')));
    await assertFails(getDoc(doc(executiveDb, 'system_settings', 'policy')));
    await assertFails(getDoc(doc(anonDb, 'system_settings', 'policy')));

    // 3. Dry-run migration
    const adminFirestore = initAdmin().db;
    const dryRunRes = await runSecretsMigration({ customDb: adminFirestore, execute: false });
    if (dryRunRes.status !== 'DRY_RUN_SECRETS_FOUND') {
      throw new Error(`Expected status DRY_RUN_SECRETS_FOUND but got ${dryRunRes.status}`);
    }
    if (dryRunRes.executed !== false || dryRunRes.purged !== false) {
      throw new Error('Dry-run must not execute or purge anything');
    }
    if (!dryRunRes.unknownFields.includes('unknownSecretField') || !dryRunRes.unknownFields.includes('nestedSecretMap')) {
      throw new Error('Dry-run must detect unknownSecretField and nestedSecretMap');
    }

    // 4. Verify policy was NOT purged in Firestore and borrower STILL cannot read
    await assertFails(getDoc(doc(borrower1Db, 'system_settings', 'policy')));
  });

  await runTest('Secrets Migration: Execute mode atomically rebuilds policy strictly from allowlist (stripping secrets, unknownSecretField, and nested maps)', async () => {
    const adminFirestore = initAdmin().db;
    const execRes = await runSecretsMigration({
      customDb: adminFirestore,
      execute: true,
      actorEmail: 'admin-migrator@kku.ac.th',
    });

    if (execRes.status !== 'MIGRATED_AND_PURGED') {
      throw new Error(`Expected status MIGRATED_AND_PURGED but got ${execRes.status}`);
    }
    if (!execRes.purged || !execRes.executed) {
      throw new Error('Migration did not mark purged and executed');
    }

    // 1. Verify policy is sanitized, readable by active users across roles, and has ONLY allowlisted keys
    const policySnap = await assertSucceeds(getDoc(doc(borrower1Db, 'system_settings', 'policy')));
    await assertSucceeds(getDoc(doc(custodianDb, 'system_settings', 'policy')));
    await assertSucceeds(getDoc(doc(approverDb, 'system_settings', 'policy')));
    await assertSucceeds(getDoc(doc(executiveDb, 'system_settings', 'policy')));

    const pData = policySnap.data();
    const actualKeys = Object.keys(pData);
    for (const k of actualKeys) {
      if (!EXACT_POLICY_ALLOWED_KEYS.includes(k)) {
        throw new Error(`Unauthorized key '${k}' remained in policy after migration!`);
      }
      if (pData[k] !== null && typeof pData[k] === 'object') {
        throw new Error(`Non-primitive/nested value remained in policy key '${k}'!`);
      }
    }
    if (pData.gasWebhookUrl || pData.brevoApiKey || pData.resendApiKey || pData.unknownSecretField || pData.nestedSecretMap) {
      throw new Error('Secret or unknown keys remain in policy document after migration!');
    }

    // 2. Verify server-only backup exists and clients cannot read it
    const anonDb = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(borrower1Db, 'system_settings', 'policy_backup_before_migrate')));
    await assertFails(getDoc(doc(custodianDb, 'system_settings', 'policy_backup_before_migrate')));
    await assertFails(getDoc(doc(anonDb, 'system_settings', 'policy_backup_before_migrate')));

    // 3. Verify gateway_config is server-only and unreadable by any client
    await assertFails(getDoc(doc(borrower1Db, 'system_settings', 'gateway_config')));
    await assertFails(getDoc(doc(custodianDb, 'system_settings', 'gateway_config')));

    // 4. Verify audit log was recorded
    const auditSnap = await adminFirestore.collection('audit_logs')
      .where('action', '==', 'MIGRATE_SECRETS_PURGE_POLICY')
      .limit(1)
      .get();
    if (auditSnap.empty) {
      throw new Error('Audit log MIGRATE_SECRETS_PURGE_POLICY was not recorded');
    }
  });

  await runTest('Secrets Migration: Idempotent re-run on clean allowlisted policy returns ALREADY_SANITIZED', async () => {
    const adminFirestore = initAdmin().db;
    const reRunRes = await runSecretsMigration({ customDb: adminFirestore, execute: true });
    if (reRunRes.status !== 'ALREADY_SANITIZED') {
      throw new Error(`Expected ALREADY_SANITIZED but got ${reRunRes.status}`);
    }
    if (reRunRes.hasSecrets !== false) {
      throw new Error('Expected hasSecrets to be false');
    }
  });

  await runTest('Fail-Closed Rollback: Dry-run inspects backup (with secrets, unknownSecretField, and nested map) without writing changes', async () => {
    const adminFirestore = initAdmin().db;
    await adminFirestore.collection('system_settings').doc('policy_backup_before_migrate').set({
      maxBorrowDays: 14,
      advanceReminderDays: 3,
      enableTwoStepApproval: true,
      guidelines: 'นโยบายก่อนย้าย',
      gasWebhookUrl: 'https://script.google.com/macros/s/DUMMY_BACKUP_SECRET/exec',
      brevoApiKey: 'xkeysib-DUMMY_BACKUP_SECRET',
      unknownSecretField: 'backup_unknown_secret_value',
      nestedSecretInBackup: { token: 'nested_secret_123' },
      _backupTimestamp: new Date().toISOString(),
      _backupActor: 'tester@kku.ac.th',
    });

    const dryRollback = await rollbackSecretsMigration({ customDb: adminFirestore, execute: false });
    if (!dryRollback.success || !dryRollback.dryRun || dryRollback.executed !== false) {
      throw new Error('Dry run rollback must not execute writes');
    }
    if (
      !dryRollback.blockedSecretFields.includes('gasWebhookUrl') ||
      !dryRollback.blockedSecretFields.includes('brevoApiKey') ||
      !dryRollback.blockedUnknownFields.includes('unknownSecretField') ||
      !dryRollback.blockedUnknownFields.includes('nestedSecretInBackup')
    ) {
      throw new Error('Dry run must detect and block secret, unknown, and nested fields in backup');
    }
  });

  await runTest('Fail-Closed Rollback: Strips unknownSecretField and nested secrets from BOTH policy and backup, building policy strictly from allowlist', async () => {
    const adminFirestore = initAdmin().db;

    // Contaminate current policy with unknownSecretField, nested object, and an invalid nested guidelines map
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'system_settings', 'policy'), {
        maxBorrowDays: 99,
        advanceReminderDays: 5,
        guidelines: { stuffedSecret: 'hidden_in_guidelines' },
        unknownSecretField: 'dirty_policy_unknown_secret',
        nestedPolicySecret: { deepKey: 'deep_secret_value' },
        brevoApiKey: 'xkeysib-DIRTY-POLICY-KEY',
      });
    });

    // Confirm dirty policy is blocked from reading before rollback
    await assertFails(getDoc(doc(borrower1Db, 'system_settings', 'policy')));
    await assertFails(getDoc(doc(custodianDb, 'system_settings', 'policy')));

    const execRollback = await rollbackSecretsMigration({
      customDb: adminFirestore,
      execute: true,
      actorEmail: 'admin-rollback@kku.ac.th',
    });

    if (!execRollback.success || !execRollback.executed) {
      throw new Error('Execute rollback did not succeed');
    }
    if (execRollback.secretsInPolicyCount !== 0) {
      throw new Error('Rollback must never leave secrets in policy');
    }

    // 1. Policy MUST now be readable by all active roles (Borrower, Custodian, Approver, Executive)
    const policySnap = await assertSucceeds(getDoc(doc(borrower1Db, 'system_settings', 'policy')));
    await assertSucceeds(getDoc(doc(custodianDb, 'system_settings', 'policy')));
    await assertSucceeds(getDoc(doc(approverDb, 'system_settings', 'policy')));
    await assertSucceeds(getDoc(doc(executiveDb, 'system_settings', 'policy')));
    const pData = policySnap.data();

    // 2. Verify non-secret business fields restored from backup
    if (pData.maxBorrowDays !== 14 || pData.advanceReminderDays !== 3 || pData.guidelines !== 'นโยบายก่อนย้าย') {
      throw new Error('Non-secret policy fields were not properly restored from backup');
    }

    // 3. HARD ASSERTION: Resulting policy has ONLY EXACT_POLICY_ALLOWED_KEYS and zero objects/secrets
    const postRollbackAnalysis = analyzePolicyDocument(pData);
    if (!postRollbackAnalysis.isClean) {
      throw new Error(`Policy is not clean after rollback: ${JSON.stringify(postRollbackAnalysis)}`);
    }
    for (const key of Object.keys(pData)) {
      if (!EXACT_POLICY_ALLOWED_KEYS.includes(key)) {
        throw new Error(`CRITICAL: Non-allowlisted key '${key}' survived rollback!`);
      }
    }
    for (const secretField of SECRET_FIELDS) {
      if (pData[secretField] !== undefined) {
        throw new Error(`CRITICAL: Secret field '${secretField}' survived rollback!`);
      }
    }
    if (pData.unknownSecretField !== undefined || pData.nestedPolicySecret !== undefined || pData.nestedSecretInBackup !== undefined) {
      throw new Error('CRITICAL: Unknown or nested secret field survived rollback!');
    }
  });

  await runTest('Adversarial Rollback Bypass Prevention: Policy with rolledBackFromBackup=true and matching business fields BUT still containing a secret MUST NOT early-return', async () => {
    const adminFirestore = initAdmin().db;

    // Current policy already has rolledBackFromBackup: true and matching maxBorrowDays=14, advanceReminderDays=3, guidelines='นโยบายก่อนย้าย'.
    // Now inject a secret and an unknownSecretField while keeping rolledBackFromBackup: true and business fields identical!
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await updateDoc(doc(context.firestore(), 'system_settings', 'policy'), {
        rolledBackFromBackup: true,
        gasWebhookUrl: 'https://script.google.com/macros/s/SNEAKY_SECRET_WHILE_ROLLED_BACK/exec',
        unknownSecretField: 'sneaky_unknown_while_rolled_back',
      });
    });

    // Confirm client read fails because secret is present
    await assertFails(getDoc(doc(borrower1Db, 'system_settings', 'policy')));

    // Run rollback: It MUST NOT early-return with alreadyRolledBack: true! It MUST execute and sanitize!
    const res = await rollbackSecretsMigration({
      customDb: adminFirestore,
      execute: true,
      actorEmail: 'admin-security-fix@kku.ac.th',
    });

    if (!res.success || res.alreadyRolledBack === true || res.executed !== true) {
      throw new Error('Rollback early-returned on rolledBackFromBackup=true despite dirty secret fields in policy!');
    }

    // Verify policy is clean and readable again
    const cleanSnap = await assertSucceeds(getDoc(doc(borrower1Db, 'system_settings', 'policy')));
    const cleanData = cleanSnap.data();
    if (cleanData.gasWebhookUrl !== undefined || cleanData.unknownSecretField !== undefined) {
      throw new Error('Secret or unknown field was not purged when rolledBackFromBackup was true!');
    }
  });

  await runTest('Fail-Closed Rollback Gateway Isolation: When gateway_config is EMPTY, rollback does NOT auto-copy old backup secrets into gateway_config or policy', async () => {
    const adminFirestore = initAdmin().db;

    // 1. Delete gateway_config so it is completely empty, while backup has secrets
    await adminFirestore.collection('system_settings').doc('gateway_config').delete();
    // Touch policy so rollback executes a write
    await adminFirestore.collection('system_settings').doc('policy').update({ maxBorrowDays: 10 });

    const res = await rollbackSecretsMigration({
      customDb: adminFirestore,
      execute: true,
      actorEmail: 'admin-empty-gw@kku.ac.th',
    });

    if (!res.success || !res.executed) {
      throw new Error('Rollback failed when gateway_config was empty');
    }

    // 2. Verify gateway_config was NOT recreated or populated with old backup secrets
    const gwSnap = await adminFirestore.collection('system_settings').doc('gateway_config').get();
    if (gwSnap.exists) {
      throw new Error('Rollback must NOT automatically copy old backup credentials into empty gateway_config!');
    }

    // 3. Verify policy also has zero secrets
    const policySnap = await assertSucceeds(getDoc(doc(borrower1Db, 'system_settings', 'policy')));
    const pData = policySnap.data();
    for (const secretField of SECRET_FIELDS) {
      if (pData[secretField] !== undefined) {
        throw new Error(`Secret ${secretField} leaked into policy!`);
      }
    }
  });

  await runTest('Fail-Closed Rollback Gateway Isolation: When gateway_config has NEWER rotated keys, rollback preserves newer keys without overwriting', async () => {
    const adminFirestore = initAdmin().db;

    // 1. Seed gateway_config with rotated newer credentials
    await adminFirestore.collection('system_settings').doc('gateway_config').set({
      provider: 'MOCK',
      gasWebhookUrl: 'https://script.google.com/macros/s/NEW_ROTATED_WEBHOOK_2026/exec',
      brevoApiKey: 'xkeysib-NEW-ROTATED-KEY-2026',
      resendApiKey: 're_NEW_ROTATED_KEY_2026',
      custodianEmail: 'custodian@kku.ac.th',
      approverEmail: 'approver@kku.ac.th',
    });

    // Touch policy so rollback executes
    await adminFirestore.collection('system_settings').doc('policy').update({ maxBorrowDays: 12 });

    const res = await rollbackSecretsMigration({
      customDb: adminFirestore,
      execute: true,
      actorEmail: 'admin-preserve-gw@kku.ac.th',
    });

    if (!res.success || !res.executed) {
      throw new Error('Rollback failed');
    }

    // 2. Verify gateway_config still holds the newer rotated keys and NOT the old backup keys
    const gwSnap = await adminFirestore.collection('system_settings').doc('gateway_config').get();
    const gwData = gwSnap.data();
    if (
      gwData.gasWebhookUrl !== 'https://script.google.com/macros/s/NEW_ROTATED_WEBHOOK_2026/exec' ||
      gwData.brevoApiKey !== 'xkeysib-NEW-ROTATED-KEY-2026' ||
      gwData.resendApiKey !== 're_NEW_ROTATED_KEY_2026'
    ) {
      throw new Error('Rollback overwrote or corrupted newer rotated credentials in gateway_config!');
    }
  });

  await runTest('Concurrency Safety: Concurrent edit injecting a secret into policy during rollback is caught and sanitized cleanly', async () => {
    const adminFirestore = initAdmin().db;
    let hookFired = false;

    const res = await rollbackSecretsMigration({
      customDb: adminFirestore,
      execute: true,
      actorEmail: 'admin-concurrent@kku.ac.th',
      _onBeforeCommit: async () => {
        if (!hookFired) {
          hookFired = true;
          // Simulate concurrent write modifying policy before transaction commits
          await adminFirestore.collection('system_settings').doc('policy').set(
            {
              maxBorrowDays: 25,
              unknownConcurrentSecret: 'injected_concurrently',
            },
            { merge: true }
          );
        }
      },
    });

    if (!res.success) {
      throw new Error('Concurrent rollback transaction did not succeed');
    }

    const policySnap = await assertSucceeds(getDoc(doc(borrower1Db, 'system_settings', 'policy')));
    const pData = policySnap.data();
    if (pData.unknownConcurrentSecret !== undefined || pData.maxBorrowDays !== 14) {
      throw new Error('Concurrent secret injection was not overwritten by transaction retry!');
    }
  });

  await runTest('Fail-Closed Rollback: Idempotent re-run on clean restored policy returns alreadyRolledBack', async () => {
    const adminFirestore = initAdmin().db;
    const repeated = await rollbackSecretsMigration({ customDb: adminFirestore, execute: true });
    if (!repeated.success || repeated.alreadyRolledBack !== true || repeated.executed !== false) {
      throw new Error('Repeated rollback on clean policy must be idempotent and report alreadyRolledBack: true');
    }
  });

  await runTest('Fail-Closed Rollback: Error path returns success: false when backup document does not exist', async () => {
    const adminFirestore = initAdmin().db;
    await adminFirestore.collection('system_settings').doc('policy_backup_before_migrate').delete();

    const noBackupRes = await rollbackSecretsMigration({ customDb: adminFirestore, execute: true });
    if (noBackupRes.success !== false || noBackupRes.reason !== 'NO_BACKUP') {
      throw new Error('Rollback without backup document must fail with reason NO_BACKUP');
    }
  });

  // Restore baseline maxBorrowDays: 15 on policy for subsequent test groups
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await updateDoc(doc(context.firestore(), 'system_settings', 'policy'), {
      maxBorrowDays: 15,
      advanceReminderDays: 2,
      enableTwoStepApproval: true,
      guidelines: 'นโยบายการยืมคืน',
    });
  });

  // -------------------------------------------------------------
  // -------------------------------------------------------------
  // GROUP 11: Policy Verification Suite (Duration Limits & Approver Workflows)
  // -------------------------------------------------------------
  console.log('\n--- GROUP 11: Policy Verification Suite (Duration Limits & Approver Workflows) ---');

  await runTest('Duration Policy: Standard borrow <= 15 days WITHOUT exception reason SUCCEEDS', async () => {
    const batch = writeBatch(borrower1Db);
    batch.set(doc(borrower1Db, 'borrow_requests', 'BR-DUR-15'), {
      id: 'BR-DUR-15',
      status: 'PENDING_REVIEW',
      borrower: { email: 'borrower1@kku.ac.th', name: 'สมชาย' },
      equipment: { equipmentId: 'EQ-001', name: 'Dell Latitude 5440' },
      purpose: 'ใช้งาน 15 วัน',
      startDate: '2026-11-01',
      expectedReturnDate: '2026-11-15', // 15 days inclusive
      durationDays: 15,
      timeline: [{ status: 'PENDING_REVIEW', by: 'borrower1@kku.ac.th' }],
    });
    batch.set(doc(borrower1Db, 'equipment_bookings', 'BR-DUR-15'), {
      equipmentId: 'EQ-001',
      startDate: '2026-11-01',
      expectedReturnDate: '2026-11-15',
      requestId: 'BR-DUR-15',
      status: 'ACTIVE',
      updatedAt: new Date(),
    });
    batch.update(doc(borrower1Db, 'equipments', 'EQ-001'), {
      lastBookingUpdatedAt: new Date(),
    });
    await assertSucceeds(batch.commit());
  });

  await runTest('Duration Policy: Borrow 16-30 days WITHOUT exception reason is REJECTED', async () => {
    const batch = writeBatch(borrower1Db);
    batch.set(doc(borrower1Db, 'borrow_requests', 'BR-DUR-16-NOEX'), {
      id: 'BR-DUR-16-NOEX',
      status: 'PENDING_REVIEW',
      borrower: { email: 'borrower1@kku.ac.th', name: 'สมชาย' },
      equipment: { equipmentId: 'EQ-001', name: 'Dell Latitude 5440' },
      purpose: 'ใช้งาน 16 วัน ไม่มีเหตุผลพิเศษ',
      startDate: '2026-11-01',
      expectedReturnDate: '2026-11-16', // 16 days inclusive
      durationDays: 16,
      timeline: [{ status: 'PENDING_REVIEW', by: 'borrower1@kku.ac.th' }],
    });
    batch.set(doc(borrower1Db, 'equipment_bookings', 'BR-DUR-16-NOEX'), {
      equipmentId: 'EQ-001',
      startDate: '2026-11-01',
      expectedReturnDate: '2026-11-16',
      requestId: 'BR-DUR-16-NOEX',
      status: 'ACTIVE',
      updatedAt: new Date(),
    });
    batch.update(doc(borrower1Db, 'equipments', 'EQ-001'), {
      lastBookingUpdatedAt: new Date(),
    });
    await assertFails(batch.commit());
  });

  await runTest('Duration Policy: Borrow 16-30 days WITH exception reason SUCCEEDS', async () => {
    const batch = writeBatch(borrower1Db);
    batch.set(doc(borrower1Db, 'borrow_requests', 'BR-DUR-20-EX'), {
      id: 'BR-DUR-20-EX',
      status: 'PENDING_REVIEW',
      borrower: { email: 'borrower1@kku.ac.th', name: 'สมชาย' },
      equipment: { equipmentId: 'EQ-001', name: 'Dell Latitude 5440' },
      purpose: 'งานวิจัยภาคสนามต่อเนื่อง',
      startDate: '2026-11-01',
      expectedReturnDate: '2026-11-20', // 20 days inclusive
      durationDays: 20,
      isException: true,
      exceptionReason: 'จำเป็นต้องลงพื้นที่เก็บข้อมูลภาคสนามต่อเนื่อง 20 วัน',
      timeline: [{ status: 'PENDING_REVIEW', by: 'borrower1@kku.ac.th' }],
    });
    batch.set(doc(borrower1Db, 'equipment_bookings', 'BR-DUR-20-EX'), {
      equipmentId: 'EQ-001',
      startDate: '2026-11-01',
      expectedReturnDate: '2026-11-20',
      requestId: 'BR-DUR-20-EX',
      status: 'ACTIVE',
      updatedAt: new Date(),
    });
    batch.update(doc(borrower1Db, 'equipments', 'EQ-001'), {
      lastBookingUpdatedAt: new Date(),
    });
    await assertSucceeds(batch.commit());
  });

  await runTest('Duration Policy: Borrow 30 days WITH exception reason SUCCEEDS (Boundary)', async () => {
    const batch = writeBatch(borrower1Db);
    batch.set(doc(borrower1Db, 'borrow_requests', 'BR-DUR-30-EX'), {
      id: 'BR-DUR-30-EX',
      status: 'PENDING_REVIEW',
      borrower: { email: 'borrower1@kku.ac.th', name: 'สมชาย' },
      equipment: { equipmentId: 'EQ-001', name: 'Dell Latitude 5440' },
      purpose: 'โครงการวิจัย 30 วัน',
      startDate: '2026-11-01',
      expectedReturnDate: '2026-11-30', // 30 days inclusive
      durationDays: 30,
      isException: true,
      exceptionReason: 'โครงการวิจัยระยะยาว 1 เดือนเต็ม',
      timeline: [{ status: 'PENDING_REVIEW', by: 'borrower1@kku.ac.th' }],
    });
    batch.set(doc(borrower1Db, 'equipment_bookings', 'BR-DUR-30-EX'), {
      equipmentId: 'EQ-001',
      startDate: '2026-11-01',
      expectedReturnDate: '2026-11-30',
      requestId: 'BR-DUR-30-EX',
      status: 'ACTIVE',
      updatedAt: new Date(),
    });
    batch.update(doc(borrower1Db, 'equipments', 'EQ-001'), {
      lastBookingUpdatedAt: new Date(),
    });
    await assertSucceeds(batch.commit());
  });

  await runTest('Duration Policy: Borrow > 30 days (31 days) is REJECTED even with exception reason', async () => {
    const batch = writeBatch(borrower1Db);
    batch.set(doc(borrower1Db, 'borrow_requests', 'BR-DUR-31-EX'), {
      id: 'BR-DUR-31-EX',
      status: 'PENDING_REVIEW',
      borrower: { email: 'borrower1@kku.ac.th', name: 'สมชาย' },
      equipment: { equipmentId: 'EQ-001', name: 'Dell Latitude 5440' },
      purpose: 'โครงการเกิน 30 วัน',
      startDate: '2026-11-01',
      expectedReturnDate: '2026-12-01', // 31 days inclusive
      durationDays: 31,
      isException: true,
      exceptionReason: 'ขอเกิน 30 วัน',
      timeline: [{ status: 'PENDING_REVIEW', by: 'borrower1@kku.ac.th' }],
    });
    batch.set(doc(borrower1Db, 'equipment_bookings', 'BR-DUR-31-EX'), {
      equipmentId: 'EQ-001',
      startDate: '2026-11-01',
      expectedReturnDate: '2026-12-01',
      requestId: 'BR-DUR-31-EX',
      status: 'ACTIVE',
      updatedAt: new Date(),
    });
    batch.update(doc(borrower1Db, 'equipments', 'EQ-001'), {
      lastBookingUpdatedAt: new Date(),
    });
    await assertFails(batch.commit());
  });

  await runTest('Duration Policy: Extension exceeding 30-day cap counted from startDate is REJECTED (Service + Rules)', async () => {
    const origReq = {
      id: 'BR-EXT-CAP',
      status: 'IN_USE',
      borrower: { email: 'borrower1@kku.ac.th', name: 'สมชาย' },
      equipment: { equipmentId: 'EQ-001', name: 'Dell Latitude 5440' },
      startDate: '2026-11-01',
      expectedReturnDate: '2026-11-25',
      durationDays: 25,
      isException: true,
      exceptionReason: 'งานวิจัย 25 วัน',
    };

    // Service check: requestExtension blocks > 30 days
    let threw = false;
    try {
      await requestExtension(
        origReq,
        borrower1User,
        { newExpectedReturnDate: '2026-12-02', reason: 'ขอเพิ่มเกิน 30 วัน' },
        borrower1Db
      );
    } catch (err) {
      threw = true;
      if (!err.message.includes('เพดานสูงสุด 30 วัน')) {
        throw err;
      }
    }
    if (!threw) throw new Error('Service should have blocked extension > 30 days');

    // Rules check: Approver approving extension resulting in durationDays > 30 is rejected
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'borrow_requests', 'BR-EXT-CAP-RULES'), {
        id: 'BR-EXT-CAP-RULES',
        status: 'IN_USE',
        borrower: { email: 'borrower1@kku.ac.th', name: 'สมชาย' },
        equipment: { equipmentId: 'EQ-001', name: 'Dell Latitude 5440' },
        startDate: '2026-11-01',
        expectedReturnDate: '2026-11-25',
        durationDays: 25,
        deadlineVersion: 1,
        extension: {
          status: 'PENDING_APPROVAL',
          requestedBy: 'borrower1@kku.ac.th',
          newExpectedReturnDate: '2026-12-02',
          addedDays: 7,
          reason: 'ขอเกิน 30 วัน',
          review: { reviewerEmail: 'custodian@kku.ac.th', result: 'PASSED' },
        },
        timeline: [{ status: 'IN_USE', by: 'custodian@kku.ac.th' }],
      });
    });

    // Approver approving with durationDays 32 -> REJECTED by Rules (durationDays <= 30 requirement)
    await assertFails(updateDoc(doc(approverDb, 'borrow_requests', 'BR-EXT-CAP-RULES'), {
      expectedReturnDate: '2026-12-02',
      durationDays: 32,
      deadlineVersion: 2,
      extension: {
        status: 'APPROVED',
        requestedBy: 'borrower1@kku.ac.th',
        newExpectedReturnDate: '2026-12-02',
        addedDays: 7,
        reason: 'ขอเกิน 30 วัน',
        review: { reviewerEmail: 'custodian@kku.ac.th', result: 'PASSED' },
        approval: { approverEmail: 'approver@kku.ac.th', result: 'APPROVED' },
      },
      updatedAt: new Date(),
    }));
  });

  await runTest('Duration Policy: Forging startDate during extension approval is REJECTED (Immutability)', async () => {
    // Seed request at PENDING_APPROVAL for extension
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'borrow_requests', 'BR-EXT-FORGE-START'), {
        id: 'BR-EXT-FORGE-START',
        status: 'IN_USE',
        borrower: { email: 'borrower1@kku.ac.th', name: 'สมชาย' },
        equipment: { equipmentId: 'EQ-001', name: 'Dell Latitude 5440' },
        startDate: '2026-11-01',
        expectedReturnDate: '2026-11-15',
        durationDays: 15,
        deadlineVersion: 1,
        extension: {
          status: 'PENDING_APPROVAL',
          requestedBy: 'borrower1@kku.ac.th',
          newExpectedReturnDate: '2026-11-20',
          addedDays: 5,
          reason: 'ขอต่ออายุ',
          review: { reviewerEmail: 'custodian@kku.ac.th', result: 'PASSED' },
        },
        timeline: [{ status: 'IN_USE', by: 'custodian@kku.ac.th' }],
      });
    });

    // Approver attempts to shift startDate to 2026-11-10 -> REJECTED
    await assertFails(updateDoc(doc(approverDb, 'borrow_requests', 'BR-EXT-FORGE-START'), {
      startDate: '2026-11-10', // Forgery attempt!
      expectedReturnDate: '2026-11-20',
      durationDays: 11,
      deadlineVersion: 2,
      extension: {
        status: 'APPROVED',
        requestedBy: 'borrower1@kku.ac.th',
        newExpectedReturnDate: '2026-11-20',
        addedDays: 5,
        reason: 'ขอต่ออายุ',
        review: { reviewerEmail: 'custodian@kku.ac.th', result: 'PASSED' },
        approval: { approverEmail: 'approver@kku.ac.th', result: 'APPROVED' },
      },
      updatedAt: new Date(),
    }));
  });

  // -------------------------------------------------------------
  // GROUP 12: Approver Self-Borrow & Role Integrity Suite
  // -------------------------------------------------------------
  console.log('\n--- GROUP 12: Approver Self-Borrow & Role Integrity Suite ---');

  await runTest('Approver Self-Borrow: Approver CAN create borrow request for themselves', async () => {
    // Use fresh dates and equipment to isolate cleanly
    const batch = writeBatch(approverDb);
    batch.set(doc(approverDb, 'borrow_requests', 'BR-APPR-SELF-01'), {
      id: 'BR-APPR-SELF-01',
      status: 'PENDING_REVIEW',
      borrower: { email: 'approver@kku.ac.th', name: 'ผอ. ผู้อนุมัติ' },
      equipment: { equipmentId: 'EQ-001', name: 'Dell Latitude 5440' },
      purpose: 'ใช้ประชุมผู้บริหาร',
      startDate: '2026-12-15',
      expectedReturnDate: '2026-12-20',
      durationDays: 6,
      timeline: [{ status: 'PENDING_REVIEW', by: 'approver@kku.ac.th' }],
    });
    batch.set(doc(approverDb, 'equipment_bookings', 'BR-APPR-SELF-01'), {
      equipmentId: 'EQ-001',
      startDate: '2026-12-15',
      expectedReturnDate: '2026-12-20',
      requestId: 'BR-APPR-SELF-01',
      status: 'ACTIVE',
      updatedAt: new Date(),
    });
    batch.update(doc(approverDb, 'equipments', 'EQ-001'), {
      lastBookingUpdatedAt: new Date(),
    });
    await assertSucceeds(batch.commit());
  });

  await runTest('Approver Self-Borrow: Approver CANNOT approve own request BEFORE Custodian review (Rules + Service block)', async () => {
    const selfReq = {
      id: 'BR-APPR-SELF-01',
      status: 'PENDING_REVIEW',
      borrower: { email: 'approver@kku.ac.th', name: 'ผอ. ผู้อนุมัติ' },
      equipment: { equipmentId: 'EQ-001', name: 'Dell Latitude 5440' },
      startDate: '2026-12-15',
      expectedReturnDate: '2026-12-20',
      durationDays: 6,
    };

    // Service block check
    let threw = false;
    try {
      await approveRequest(selfReq, approverUser, true, 'อนุมัติตัวเองก่อนตรวจ', approverDb);
    } catch (err) {
      threw = true;
      if (!err.message.includes('ต้องผ่านการตรวจก่อนอนุมัติ')) {
        throw err;
      }
    }
    if (!threw) throw new Error('Service should have blocked self-approval before Custodian review');

    // Direct Rules write check
    await assertFails(updateDoc(doc(approverDb, 'borrow_requests', 'BR-APPR-SELF-01'), {
      status: 'APPROVED_WAITING_PICKUP',
      approval: { approverEmail: 'approver@kku.ac.th', result: 'APPROVED' },
      timeline: [
        { status: 'PENDING_REVIEW', by: 'approver@kku.ac.th' },
        { status: 'APPROVED_WAITING_PICKUP', by: 'approver@kku.ac.th' }
      ],
      updatedAt: new Date(),
    }));
  });

  await runTest('Approver Self-Borrow: Custodian reviews and passes Approver request', async () => {
    await assertSucceeds(updateDoc(doc(custodianDb, 'borrow_requests', 'BR-APPR-SELF-01'), {
      status: 'PENDING_APPROVAL',
      review: {
        reviewerEmail: 'custodian@kku.ac.th',
        result: 'PASSED',
        accessoriesToHandover: ['ตัวเครื่อง', 'สายชาร์จ'],
      },
      timeline: [
        { status: 'PENDING_REVIEW', by: 'approver@kku.ac.th' },
        { status: 'PENDING_APPROVAL', by: 'custodian@kku.ac.th' }
      ],
      updatedAt: new Date(),
    }));
  });

  await runTest('Approver Self-Borrow: Approver CAN approve own request AFTER Custodian review passed (Rules + Service allow)', async () => {
    const selfReq = {
      id: 'BR-APPR-SELF-01',
      status: 'PENDING_APPROVAL',
      borrower: { email: 'approver@kku.ac.th', name: 'ผอ. ผู้อนุมัติ' },
      equipment: { equipmentId: 'EQ-001', name: 'Dell Latitude 5440' },
      startDate: '2026-12-15',
      expectedReturnDate: '2026-12-20',
      durationDays: 6,
      review: { reviewerEmail: 'custodian@kku.ac.th', result: 'PASSED' },
      timeline: [
        { status: 'PENDING_REVIEW', by: 'approver@kku.ac.th' },
        { status: 'PENDING_APPROVAL', by: 'custodian@kku.ac.th' }
      ],
    };

    // Service call succeeds
    await approveRequest(selfReq, approverUser, true, 'อนุมัติการยืมตนเองหลังผู้ดูแลตรวจผ่าน', approverDb);

    const docSnap = await getDoc(doc(approverDb, 'borrow_requests', 'BR-APPR-SELF-01'));
    if (docSnap.data().status !== 'APPROVED_WAITING_PICKUP') {
      throw new Error(`Expected APPROVED_WAITING_PICKUP but got ${docSnap.data().status}`);
    }
  });

  await runTest('Role Integrity: Normal USER role CANNOT approve any request (PERMISSION_DENIED)', async () => {
    // Seed request ready for approval
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'borrow_requests', 'BR-USER-FORGE-APPROVE'), {
        id: 'BR-USER-FORGE-APPROVE',
        status: 'PENDING_APPROVAL',
        borrower: { email: 'borrower2@kku.ac.th', name: 'สมหญิง' },
        equipment: { equipmentId: 'EQ-001', name: 'Dell Latitude 5440' },
        startDate: '2026-12-25',
        expectedReturnDate: '2026-12-28',
        durationDays: 4,
        review: { reviewerEmail: 'custodian@kku.ac.th', result: 'PASSED' },
        timeline: [{ status: 'PENDING_REVIEW', by: 'borrower2@kku.ac.th' }],
      });
    });

    // Borrower 1 (role USER) attempts to approve -> REJECTED
    await assertFails(updateDoc(doc(borrower1Db, 'borrow_requests', 'BR-USER-FORGE-APPROVE'), {
      status: 'APPROVED_WAITING_PICKUP',
      approval: { approverEmail: 'borrower1@kku.ac.th', result: 'APPROVED' },
      timeline: [
        { status: 'PENDING_REVIEW', by: 'borrower2@kku.ac.th' },
        { status: 'APPROVED_WAITING_PICKUP', by: 'borrower1@kku.ac.th' }
      ],
      updatedAt: new Date(),
    }));
  });

  // -------------------------------------------------------------
  // GROUP 13: Concurrency & Serializability Suite
  // -------------------------------------------------------------
  console.log('\n--- GROUP 13: Concurrency & Serializability Suite ---');

  await runTest('Adversarial: Forging invalid negative durationDays is REJECTED', async () => {
    const batch = writeBatch(borrower1Db);
    batch.set(doc(borrower1Db, 'borrow_requests', 'BR-FORGE-DAYS'), {
      id: 'BR-FORGE-DAYS',
      status: 'PENDING_REVIEW',
      borrower: { email: 'borrower1@kku.ac.th', name: 'สมชาย' },
      equipment: { equipmentId: 'EQ-001', name: 'Dell Latitude' },
      startDate: '2026-11-01',
      expectedReturnDate: '2026-11-05',
      durationDays: -5,
      timeline: [{ status: 'PENDING_REVIEW', by: 'borrower1@kku.ac.th' }],
    });
    batch.set(doc(borrower1Db, 'equipment_bookings', 'BR-FORGE-DAYS'), {
      equipmentId: 'EQ-001',
      startDate: '2026-11-01',
      expectedReturnDate: '2026-11-05',
      requestId: 'BR-FORGE-DAYS',
      status: 'ACTIVE',
      updatedAt: new Date(),
    });
    await assertFails(batch.commit());
  });

  await runTest('Pre-race verification: Individual isolated actions execute successfully on clean fixtures', async () => {
    const reqIdIso = await createBorrowRequest(
      {
        equipment: { id: 'EQ-002', name: 'Epson EB-X51', assetNumber: '7440-002-0002/67', isDeleted: false, status: 'AVAILABLE' },
        startDate: '2026-11-20',
        expectedReturnDate: '2026-11-25',
        purpose: 'ทดสอบเดี่ยว',
        location: 'ห้องประชุม',
      },
      borrower1User,
      borrower1Db
    );
    if (!reqIdIso) throw new Error('Isolated create failed');
  });

  await runTest('True Concurrency 1: Concurrently approving request while another user books overlapping dates on EQ-002', async () => {
    // Seed clean EQ-002 and pending request BR-CONC-01
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, 'equipments', 'EQ-002'), {
        id: 'EQ-002',
        assetNumber: '7440-002-0002/67',
        name: 'โปรเจกเตอร์ Epson EB-X51',
        status: 'AVAILABLE',
        isDeleted: false,
        activeBookings: [],
        lastBookingUpdatedAt: new Date(),
      });

      await setDoc(doc(db, 'borrow_requests', 'BR-CONC-01'), {
        id: 'BR-CONC-01',
        status: 'PENDING_APPROVAL',
        borrower: { email: 'borrower1@kku.ac.th', name: 'สมชาย' },
        equipment: { equipmentId: 'EQ-002', name: 'โปรเจกเตอร์ Epson EB-X51' },
        startDate: '2026-11-10',
        expectedReturnDate: '2026-11-15',
        durationDays: 6,
        review: { reviewerEmail: 'custodian@kku.ac.th', result: 'PASSED' },
        timeline: [{ status: 'PENDING_REVIEW', by: 'borrower1@kku.ac.th' }],
      });
      await setDoc(doc(db, 'equipment_bookings', 'BR-CONC-01'), {
        equipmentId: 'EQ-002',
        startDate: '2026-11-10',
        expectedReturnDate: '2026-11-15',
        requestId: 'BR-CONC-01',
        status: 'ACTIVE',
        updatedAt: new Date(),
      });
    });

    const req1 = {
      id: 'BR-CONC-01',
      status: 'PENDING_APPROVAL',
      borrower: { email: 'borrower1@kku.ac.th', name: 'สมชาย' },
      equipment: { equipmentId: 'EQ-002', name: 'โปรเจกเตอร์ Epson EB-X51' },
      startDate: '2026-11-10',
      expectedReturnDate: '2026-11-15',
      durationDays: 6,
      review: { reviewerEmail: 'custodian@kku.ac.th', result: 'PASSED' },
    };

    // Action A: Approver approves BR-CONC-01 (Nov 10 - Nov 15)
    const approveAction = async () => {
      return approveRequest(req1, approverUser, true, 'อนุมัติ', approverDb);
    };

    // Action B: Borrower 2 concurrently tries to create overlapping booking (Nov 12 - Nov 18)
    const createAction = async () => {
      return createBorrowRequest(
        {
          equipment: { id: 'EQ-002', name: 'โปรเจกเตอร์ Epson EB-X51', assetNumber: '7440-002-0002/67', isDeleted: false, status: 'AVAILABLE' },
          startDate: '2026-11-12', // Overlaps with 2026-11-10 to 2026-11-15
          expectedReturnDate: '2026-11-18',
          purpose: 'ผู้ยืม 2 จองชน',
          location: 'ห้อง 2',
        },
        borrower2User,
        borrower2Db
      );
    };

    // Execute concurrently using Promise.allSettled
    const results = await Promise.allSettled([approveAction(), createAction()]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    if (fulfilled.length !== 1 || rejected.length !== 1) {
      throw new Error(`Exactly 1 action must succeed and 1 must be blocked, but got fulfilled: ${fulfilled.length}, rejected: ${rejected.length}`);
    }

    // The rejected action must be due to CONCURRENCY_CONFLICT
    const rejErr = rejected[0].reason?.message || '';
    if (!rejErr.includes('CONCURRENCY_CONFLICT')) {
      throw new Error(`Expected CONCURRENCY_CONFLICT error, but got: ${rejErr}`);
    }
  });

  await runTest('True Concurrency 2: Creating new booking concurrently with extension approval on same equipment', async () => {
    // Seed request BR-EXT-01 (currently IN_USE on EQ-001 until 2026-12-05)
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, 'equipments', 'EQ-001'), {
        id: 'EQ-001',
        name: 'Dell Latitude 5440',
        status: 'BORROWED',
        lastBookingUpdatedAt: new Date(),
      });

      await setDoc(doc(db, 'borrow_requests', 'BR-EXT-01'), {
        id: 'BR-EXT-01',
        status: 'IN_USE',
        borrower: { email: 'borrower1@kku.ac.th', name: 'สมชาย' },
        equipment: { equipmentId: 'EQ-001', name: 'Dell Latitude' },
        startDate: '2026-12-01',
        expectedReturnDate: '2026-12-05',
        durationDays: 5,
        deadlineVersion: 1,
        extension: {
          status: 'PENDING_APPROVAL',
          requestedBy: 'borrower1@kku.ac.th',
          newExpectedReturnDate: '2026-12-10', // Wants extension to Dec 10
          addedDays: 5,
          reason: 'งานยืดเยื้อ',
          review: { reviewerEmail: 'custodian@kku.ac.th', result: 'PASSED' },
        },
        timeline: [{ status: 'IN_USE', by: 'custodian@kku.ac.th' }],
      });
      await setDoc(doc(db, 'equipment_bookings', 'BR-EXT-01'), {
        equipmentId: 'EQ-001',
        startDate: '2026-12-01',
        expectedReturnDate: '2026-12-05',
        requestId: 'BR-EXT-01',
        status: 'ACTIVE',
        updatedAt: new Date(),
      });
    });

    const extReq = {
      id: 'BR-EXT-01',
      status: 'IN_USE',
      borrower: { email: 'borrower1@kku.ac.th', name: 'สมชาย' },
      equipment: { equipmentId: 'EQ-001', name: 'Dell Latitude' },
      startDate: '2026-12-01',
      expectedReturnDate: '2026-12-05',
      durationDays: 5,
      deadlineVersion: 1,
      extension: {
        status: 'PENDING_APPROVAL',
        requestedBy: 'borrower1@kku.ac.th',
        newExpectedReturnDate: '2026-12-10',
        addedDays: 5,
        reason: 'งานยืดเยื้อ',
        review: { reviewerEmail: 'custodian@kku.ac.th', result: 'PASSED' },
      },
    };

    const approveExtAction = async () => {
      return approveExtension(extReq, approverUser, true, 'อนุมัติต่ออายุ', approverDb);
    };

    const createNewAction = async () => {
      return createBorrowRequest(
        {
          equipment: { id: 'EQ-001', name: 'Dell Latitude', assetNumber: '7440-001-0001/67', isDeleted: false, status: 'AVAILABLE' },
          startDate: '2026-12-06',
          expectedReturnDate: '2026-12-09',
          purpose: 'ใช้งานช่วงชนกับต่ออายุ',
          location: 'ห้องประชุม',
        },
        borrower2User,
        borrower2Db
      );
    };

    const results = await Promise.allSettled([approveExtAction(), createNewAction()]);
    // Both actions serialize via OCC lock without permission errors
    for (const r of results) {
      if (r.status === 'rejected') {
        if (r.reason.message && r.reason.message.includes('PERMISSION_DENIED')) {
          throw new Error('Failure must NOT be due to PERMISSION_DENIED: ' + r.reason.message);
        }
      }
    }
  });

  await runTest('True Concurrency 3: Approving extension concurrently with Custodian returning equipment preserves state machine integrity', async () => {
    // Seed request BR-RACE-01
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, 'equipments', 'EQ-002'), {
        id: 'EQ-002',
        name: 'Epson EB-X51',
        status: 'BORROWED',
        lastBookingUpdatedAt: new Date(),
      });
      await setDoc(doc(db, 'borrow_requests', 'BR-RACE-01'), {
        id: 'BR-RACE-01',
        status: 'IN_USE',
        borrower: { email: 'borrower1@kku.ac.th', name: 'สมชาย' },
        equipment: { equipmentId: 'EQ-002', name: 'Epson EB-X51' },
        startDate: '2026-12-10',
        expectedReturnDate: '2026-12-15',
        durationDays: 5,
        deadlineVersion: 1,
        extension: {
          status: 'PENDING_APPROVAL',
          requestedBy: 'borrower1@kku.ac.th',
          newExpectedReturnDate: '2026-12-20',
          addedDays: 5,
          reason: 'ขอต่อรอบสุดท้าย',
          review: { reviewerEmail: 'custodian@kku.ac.th', result: 'PASSED' },
        },
        timeline: [{ status: 'IN_USE', by: 'custodian@kku.ac.th' }],
      });
      await setDoc(doc(db, 'equipment_bookings', 'BR-RACE-01'), {
        equipmentId: 'EQ-002',
        startDate: '2026-12-10',
        expectedReturnDate: '2026-12-15',
        requestId: 'BR-RACE-01',
        status: 'ACTIVE',
        updatedAt: new Date(),
      });
    });

    const raceReq = {
      id: 'BR-RACE-01',
      status: 'IN_USE',
      borrower: { email: 'borrower1@kku.ac.th', name: 'สมชาย' },
      equipment: { equipmentId: 'EQ-002', name: 'Epson EB-X51' },
      startDate: '2026-12-10',
      expectedReturnDate: '2026-12-15',
      durationDays: 5,
      deadlineVersion: 1,
      extension: {
        status: 'PENDING_APPROVAL',
        requestedBy: 'borrower1@kku.ac.th',
        newExpectedReturnDate: '2026-12-20',
        addedDays: 5,
        reason: 'ขอต่อรอบสุดท้าย',
        review: { reviewerEmail: 'custodian@kku.ac.th', result: 'PASSED' },
      },
    };

    const approveAction = async () => {
      return approveExtension(raceReq, approverUser, true, 'อนุมัติต่ออายุ', approverDb);
    };

    const returnAction = async () => {
      return returnRequest(
        raceReq,
        custodianUser,
        {
          receivedByEmail: 'custodian@kku.ac.th',
          receivedByName: 'นายพัสดุ ผู้ดูแล',
          condition: 'NORMAL',
          conditionNotes: 'สภาพเรียบร้อย',
          equipmentStatus: 'AVAILABLE',
        },
        custodianDb
      );
    };

    const results = await Promise.allSettled([approveAction(), returnAction()]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    if (fulfilled.length < 1) {
      throw new Error(`At least 1 action must succeed in concurrency race, but got ${fulfilled.length}`);
    }

    const finalDoc = await getDoc(doc(custodianDb, 'borrow_requests', 'BR-RACE-01'));
    const finalBooking = await getDoc(doc(custodianDb, 'equipment_bookings', 'BR-RACE-01'));

    if (!['IN_USE', 'RETURNED'].includes(finalDoc.data().status)) {
      throw new Error(`Invalid final request status: ${finalDoc.data().status}`);
    }
    if (!['ACTIVE', 'RETURNED'].includes(finalBooking.data().status)) {
      throw new Error(`Invalid final booking status: ${finalBooking.data().status}`);
    }
  });

  // -------------------------------------------------------------
  // GROUP 14: Vulnerability 1 - Duration Spoofing & Date Disconnection Tests
  // -------------------------------------------------------------
  console.log('\n--- GROUP 14: Vulnerability 1 - Duration Spoofing & Date Disconnection Tests ---');

  await runTest('Adversarial (V1): Client creates request with 40-day span (2026-11-01 to 2026-12-10) spoofing durationDays=20 is REJECTED', async () => {
    // 40 calendar days inclusive
    const batch = writeBatch(borrower1Db);
    batch.set(doc(borrower1Db, 'borrow_requests', 'BR-SPOOF-40-20'), {
      id: 'BR-SPOOF-40-20',
      status: 'PENDING_REVIEW',
      borrower: { email: 'borrower1@kku.ac.th', name: 'สมชาย' },
      equipment: { equipmentId: 'EQ-001', name: 'Dell Latitude 5440' },
      purpose: 'พยายามปลอมจำนวนวัน',
      startDate: '2026-11-01',
      expectedReturnDate: '2026-12-10', // 40 days
      durationDays: 20, // Spoofed durationDays!
      isException: true,
      exceptionReason: 'ขอยกเว้นแต่แอบใส่ 40 วันจริง',
      timeline: [{ status: 'PENDING_REVIEW', by: 'borrower1@kku.ac.th' }],
    });
    batch.set(doc(borrower1Db, 'equipment_bookings', 'BR-SPOOF-40-20'), {
      equipmentId: 'EQ-001',
      startDate: '2026-11-01',
      expectedReturnDate: '2026-12-10',
      requestId: 'BR-SPOOF-40-20',
      status: 'ACTIVE',
      updatedAt: new Date(),
    });
    batch.update(doc(borrower1Db, 'equipments', 'EQ-001'), {
      lastBookingUpdatedAt: new Date(),
    });
    await assertFails(batch.commit());
  });

  await runTest('Adversarial (V1): Client creates request with 20-day span without exception spoofing durationDays=10 is REJECTED', async () => {
    // 20 calendar days inclusive
    const batch = writeBatch(borrower1Db);
    batch.set(doc(borrower1Db, 'borrow_requests', 'BR-SPOOF-20-10'), {
      id: 'BR-SPOOF-20-10',
      status: 'PENDING_REVIEW',
      borrower: { email: 'borrower1@kku.ac.th', name: 'สมชาย' },
      equipment: { equipmentId: 'EQ-001', name: 'Dell Latitude 5440' },
      purpose: 'พยายามปลอมวันให้ไม่เกิน 15 วัน',
      startDate: '2026-11-01',
      expectedReturnDate: '2026-11-20', // 20 days
      durationDays: 10, // Spoofed to bypass 15-day rule!
      timeline: [{ status: 'PENDING_REVIEW', by: 'borrower1@kku.ac.th' }],
    });
    batch.set(doc(borrower1Db, 'equipment_bookings', 'BR-SPOOF-20-10'), {
      equipmentId: 'EQ-001',
      startDate: '2026-11-01',
      expectedReturnDate: '2026-11-20',
      requestId: 'BR-SPOOF-20-10',
      status: 'ACTIVE',
      updatedAt: new Date(),
    });
    batch.update(doc(borrower1Db, 'equipments', 'EQ-001'), {
      lastBookingUpdatedAt: new Date(),
    });
    await assertFails(batch.commit());
  });

  await runTest('Adversarial (V1): Extension approval with actual 40 days from startDate spoofing durationDays=25 is REJECTED', async () => {
    // Seed request
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'borrow_requests', 'BR-SPOOF-EXT-40'), {
        id: 'BR-SPOOF-EXT-40',
        status: 'IN_USE',
        borrower: { email: 'borrower1@kku.ac.th', name: 'สมชาย' },
        equipment: { equipmentId: 'EQ-001', name: 'Dell Latitude 5440' },
        startDate: '2026-11-01',
        expectedReturnDate: '2026-11-15',
        durationDays: 15,
        deadlineVersion: 1,
        extension: {
          status: 'PENDING_APPROVAL',
          requestedBy: 'borrower1@kku.ac.th',
          newExpectedReturnDate: '2026-12-10', // 40 days total from startDate!
          addedDays: 25,
          reason: 'งานยืดเยื้อ',
          review: { reviewerEmail: 'custodian@kku.ac.th', result: 'PASSED' },
        },
        timeline: [{ status: 'IN_USE', by: 'custodian@kku.ac.th' }],
      });
      await setDoc(doc(context.firestore(), 'equipment_bookings', 'BR-SPOOF-EXT-40'), {
        equipmentId: 'EQ-001',
        startDate: '2026-11-01',
        expectedReturnDate: '2026-11-15',
        requestId: 'BR-SPOOF-EXT-40',
        status: 'ACTIVE',
        updatedAt: new Date(),
      });
    });

    // Approver tries to approve and set durationDays to 25 (hiding the fact that date is Dec 10) -> REJECTED
    const batch = writeBatch(approverDb);
    batch.update(doc(approverDb, 'borrow_requests', 'BR-SPOOF-EXT-40'), {
      expectedReturnDate: '2026-12-10',
      durationDays: 25, // Spoofed durationDays!
      deadlineVersion: 2,
      extension: {
        status: 'APPROVED',
        requestedBy: 'borrower1@kku.ac.th',
        newExpectedReturnDate: '2026-12-10',
        addedDays: 25,
        reason: 'งานยืดเยื้อ',
        review: { reviewerEmail: 'custodian@kku.ac.th', result: 'PASSED' },
        approval: { approverEmail: 'approver@kku.ac.th', result: 'APPROVED' },
      },
      timeline: [
        { status: 'IN_USE', by: 'custodian@kku.ac.th' },
        { status: 'IN_USE', note: 'อนุมัติ', by: 'approver@kku.ac.th' }
      ],
      updatedAt: new Date(),
    });
    batch.update(doc(approverDb, 'equipment_bookings', 'BR-SPOOF-EXT-40'), {
      expectedReturnDate: '2026-12-10',
      status: 'ACTIVE',
      updatedAt: new Date(),
    });
    await assertFails(batch.commit());
  });

  // -------------------------------------------------------------
  // GROUP 15: Vulnerability 2 - Lock Evasion & Mutex Synchronization Tests
  // -------------------------------------------------------------
  console.log('\n--- GROUP 15: Vulnerability 2 - Lock Evasion & Mutex Synchronization Tests ---');

  await runTest('Adversarial (V2): Direct Firestore batch write WITHOUT updating equipments.lastBookingUpdatedAt is REJECTED', async () => {
    // Attempt to create borrow request + equipment booking directly without modifying OCC lock
    const batch = writeBatch(borrower1Db);
    batch.set(doc(borrower1Db, 'borrow_requests', 'BR-LOCK-BYPASS-01'), {
      id: 'BR-LOCK-BYPASS-01',
      status: 'PENDING_REVIEW',
      borrower: { email: 'borrower1@kku.ac.th', name: 'สมชาย' },
      equipment: { equipmentId: 'EQ-001', name: 'Dell Latitude 5440' },
      purpose: 'พยายามข้ามตัวล็อก',
      startDate: '2026-12-20',
      expectedReturnDate: '2026-12-25',
      durationDays: 6,
      timeline: [{ status: 'PENDING_REVIEW', by: 'borrower1@kku.ac.th' }],
    });
    batch.set(doc(borrower1Db, 'equipment_bookings', 'BR-LOCK-BYPASS-01'), {
      equipmentId: 'EQ-001',
      startDate: '2026-12-20',
      expectedReturnDate: '2026-12-25',
      requestId: 'BR-LOCK-BYPASS-01',
      status: 'ACTIVE',
      updatedAt: new Date(),
    });
    // Deliberately omit batch.update(doc(borrower1Db, 'equipments', 'EQ-001'), ...) -> Lock evasion!
    await assertFails(batch.commit());
  });

  await runTest('Legitimate (V2): Service createBorrowRequest updates lock and booking atomically', async () => {
    const reqId = await createBorrowRequest(
      {
        equipment: { id: 'EQ-001', name: 'Dell Latitude 5440', assetNumber: '7440-001-0001/67', isDeleted: false, status: 'AVAILABLE' },
        startDate: '2027-02-01',
        expectedReturnDate: '2027-02-05',
        purpose: 'สร้างคำขอผ่าน Transaction service อย่างถูกต้อง',
        location: 'สำนักงาน',
      },
      borrower1User,
      borrower1Db
    );
    if (!reqId) throw new Error('createBorrowRequest failed');

    const eqSnap = await getDoc(doc(borrower1Db, 'equipments', 'EQ-001'));
    if (!eqSnap.data().lastBookingUpdatedAt) {
      throw new Error('Lock timestamp was not updated on equipment');
    }
  });

  // -------------------------------------------------------------
  // GROUP 16: Vulnerability 3 - Field Stripping & Deletion Prevention Tests
  // -------------------------------------------------------------
  console.log('\n--- GROUP 16: Vulnerability 3 - Field Stripping & Deletion Prevention Tests ---');

  await runTest('Adversarial (V3): Cancelling extension with stripped requestedAt is REJECTED', async () => {
    // Seed request with extension having requestedAt
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'borrow_requests', 'BR-STRIP-EXT-01'), {
        id: 'BR-STRIP-EXT-01',
        status: 'IN_USE',
        borrower: { email: 'borrower1@kku.ac.th', name: 'สมชาย' },
        equipment: { equipmentId: 'EQ-001', name: 'Dell Latitude 5440' },
        startDate: '2026-12-20',
        expectedReturnDate: '2026-12-25',
        durationDays: 6,
        extension: {
          status: 'PENDING_REVIEW',
          requestedBy: 'borrower1@kku.ac.th',
          requestedAt: new Date(),
          newExpectedReturnDate: '2026-12-28',
          addedDays: 3,
          reason: 'ขอต่อ',
        },
        timeline: [{ status: 'IN_USE', by: 'custodian@kku.ac.th' }],
      });
    });

    // Borrower attempts to cancel extension but omits requestedAt -> REJECTED
    await assertFails(updateDoc(doc(borrower1Db, 'borrow_requests', 'BR-STRIP-EXT-01'), {
      extension: {
        status: 'CANCELLED',
        requestedBy: 'borrower1@kku.ac.th',
        // requestedAt is deleted / stripped!
        newExpectedReturnDate: '2026-12-28',
        addedDays: 3,
        reason: 'ขอต่อ',
      },
      timeline: [
        { status: 'IN_USE', by: 'custodian@kku.ac.th' },
        { status: 'IN_USE', note: 'ยกเลิก', by: 'borrower1@kku.ac.th' }
      ],
      updatedAt: new Date(),
    }));
  });

  await runTest('Adversarial (V3): Custodian reviewing extension with stripped requestedAt is REJECTED', async () => {
    // Seed request
    const requestedAtDate = new Date();
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'borrow_requests', 'BR-STRIP-EXT-02'), {
        id: 'BR-STRIP-EXT-02',
        status: 'IN_USE',
        borrower: { email: 'borrower1@kku.ac.th', name: 'สมชาย' },
        equipment: { equipmentId: 'EQ-001', name: 'Dell Latitude 5440' },
        startDate: '2026-12-20',
        expectedReturnDate: '2026-12-25',
        durationDays: 6,
        extension: {
          status: 'PENDING_REVIEW',
          requestedBy: 'borrower1@kku.ac.th',
          requestedAt: requestedAtDate,
          newExpectedReturnDate: '2026-12-28',
          addedDays: 3,
          reason: 'ขอต่อ',
        },
        timeline: [{ status: 'IN_USE', by: 'custodian@kku.ac.th' }],
      });
    });

    // Custodian attempts to review but strips requestedAt -> REJECTED
    await assertFails(updateDoc(doc(custodianDb, 'borrow_requests', 'BR-STRIP-EXT-02'), {
      extension: {
        status: 'PENDING_APPROVAL',
        requestedBy: 'borrower1@kku.ac.th',
        // requestedAt is stripped!
        newExpectedReturnDate: '2026-12-28',
        addedDays: 3,
        reason: 'ขอต่อ',
        review: { reviewerEmail: 'custodian@kku.ac.th', result: 'PASSED' },
      },
      timeline: [
        { status: 'IN_USE', by: 'custodian@kku.ac.th' },
        { status: 'IN_USE', note: 'ตรวจผ่าน', by: 'custodian@kku.ac.th' }
      ],
      updatedAt: new Date(),
    }));
  });

  await runTest('Adversarial (V3): Approver approving extension with stripped review is REJECTED', async () => {
    const requestedAtDate = new Date();
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'borrow_requests', 'BR-STRIP-EXT-03'), {
        id: 'BR-STRIP-EXT-03',
        status: 'IN_USE',
        borrower: { email: 'borrower1@kku.ac.th', name: 'สมชาย' },
        equipment: { equipmentId: 'EQ-001', name: 'Dell Latitude 5440' },
        startDate: '2026-12-20',
        expectedReturnDate: '2026-12-25',
        durationDays: 6,
        deadlineVersion: 1,
        extension: {
          status: 'PENDING_APPROVAL',
          requestedBy: 'borrower1@kku.ac.th',
          requestedAt: requestedAtDate,
          newExpectedReturnDate: '2026-12-28',
          addedDays: 3,
          reason: 'ขอต่อ',
          review: { reviewerEmail: 'custodian@kku.ac.th', result: 'PASSED' },
        },
        timeline: [{ status: 'IN_USE', by: 'custodian@kku.ac.th' }],
      });
      await setDoc(doc(context.firestore(), 'equipment_bookings', 'BR-STRIP-EXT-03'), {
        equipmentId: 'EQ-001',
        startDate: '2026-12-20',
        expectedReturnDate: '2026-12-25',
        requestId: 'BR-STRIP-EXT-03',
        status: 'ACTIVE',
        updatedAt: new Date(),
      });
    });

    // Approver approves but deletes / strips review object from extension -> REJECTED
    const batch = writeBatch(approverDb);
    batch.update(doc(approverDb, 'borrow_requests', 'BR-STRIP-EXT-03'), {
      expectedReturnDate: '2026-12-28',
      durationDays: 9,
      deadlineVersion: 2,
      extension: {
        status: 'APPROVED',
        requestedBy: 'borrower1@kku.ac.th',
        requestedAt: requestedAtDate,
        newExpectedReturnDate: '2026-12-28',
        addedDays: 3,
        reason: 'ขอต่อ',
        // review object is deleted / stripped!
        approval: { approverEmail: 'approver@kku.ac.th', result: 'APPROVED' },
      },
      timeline: [
        { status: 'IN_USE', by: 'custodian@kku.ac.th' },
        { status: 'IN_USE', note: 'อนุมัติ', by: 'approver@kku.ac.th' }
      ],
      updatedAt: new Date(),
    });
    batch.update(doc(approverDb, 'equipment_bookings', 'BR-STRIP-EXT-03'), {
      expectedReturnDate: '2026-12-28',
      status: 'ACTIVE',
      updatedAt: new Date(),
    });
    await assertFails(batch.commit());
  });

  await runTest('Adversarial (V3): Returning equipment with stripped review & approval on request is REJECTED', async () => {
    // Seed request in IN_USE state with full review & approval records
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'borrow_requests', 'BR-STRIP-RET-01'), {
        id: 'BR-STRIP-RET-01',
        status: 'IN_USE',
        borrower: { email: 'borrower1@kku.ac.th', name: 'สมชาย' },
        equipment: { equipmentId: 'EQ-001', name: 'Dell Latitude 5440' },
        startDate: '2026-12-20',
        expectedReturnDate: '2026-12-25',
        durationDays: 6,
        review: { reviewerEmail: 'custodian@kku.ac.th', result: 'PASSED' },
        approval: { approverEmail: 'approver@kku.ac.th', result: 'APPROVED' },
        handover: { handedOverByEmail: 'custodian@kku.ac.th' },
        timeline: [{ status: 'IN_USE', by: 'custodian@kku.ac.th' }],
      });
      await setDoc(doc(context.firestore(), 'equipment_bookings', 'BR-STRIP-RET-01'), {
        equipmentId: 'EQ-001',
        startDate: '2026-12-20',
        expectedReturnDate: '2026-12-25',
        requestId: 'BR-STRIP-RET-01',
        status: 'ACTIVE',
        updatedAt: new Date(),
      });
    });

    // Custodian returns equipment but attempts to delete review and approval -> REJECTED
    const batch = writeBatch(custodianDb);
    batch.update(doc(custodianDb, 'borrow_requests', 'BR-STRIP-RET-01'), {
      status: 'RETURNED',
      returnInfo: {
        actualReturnDate: '2026-12-25',
        receivedByEmail: 'custodian@kku.ac.th',
        condition: 'NORMAL',
        remarks: 'รับคืน',
      },
      review: deleteField(),
      approval: deleteField(),
      timeline: [
        { status: 'IN_USE', by: 'custodian@kku.ac.th' },
        { status: 'RETURNED', by: 'custodian@kku.ac.th' }
      ],
      updatedAt: new Date(),
    });
    batch.update(doc(custodianDb, 'equipment_bookings', 'BR-STRIP-RET-01'), {
      status: 'RETURNED',
      updatedAt: new Date(),
    });
    await assertFails(batch.commit());
  });

  // -------------------------------------------------------------
  // GROUP 17: Explicit Repro & Vulnerability Defense Verification
  // -------------------------------------------------------------
  console.log('\n--- Group 17: Explicit Repro & Vulnerability Defense Verification ---');

  await runTest('Repro 1: Direct batch write creating borrow_requests + equipment_bookings with colliding dates is REJECTED even with lock update', async () => {
    // Seed EQ-REPRO-1 with an active booking from 2026-11-10 to 2026-11-15
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const adminDb = context.firestore();
      await setDoc(doc(adminDb, 'equipments', 'EQ-REPRO-1'), {
        id: 'EQ-REPRO-1',
        assetNumber: '7440-REPRO-1/67',
        name: 'Repro 1 Laptop',
        status: 'AVAILABLE',
        isDeleted: false,
        activeBookings: [
          {
            requestId: 'BR-EXIST-01',
            startDate: '2026-11-10',
            expectedReturnDate: '2026-11-15',
            status: 'ACTIVE',
          },
        ],
      });
      await setDoc(doc(adminDb, 'equipment_bookings', 'BR-EXIST-01'), {
        equipmentId: 'EQ-REPRO-1',
        startDate: '2026-11-10',
        expectedReturnDate: '2026-11-15',
        requestId: 'BR-EXIST-01',
        status: 'ACTIVE',
        updatedAt: new Date(),
      });
    });

    // Adversary attempts direct batch write with overlapping dates 2026-11-12 to 2026-11-14
    const batch = writeBatch(borrower1Db);
    batch.set(doc(borrower1Db, 'borrow_requests', 'BR-COLLIDE-01'), {
      id: 'BR-COLLIDE-01',
      status: 'PENDING_REVIEW',
      borrower: { email: 'borrower1@kku.ac.th', name: 'สมชาย ผู้ยืม' },
      equipment: { equipmentId: 'EQ-REPRO-1', name: 'Repro 1 Laptop' },
      purpose: 'Collision attempt',
      startDate: '2026-11-12',
      expectedReturnDate: '2026-11-14',
      durationDays: 3,
      timeline: [{ status: 'PENDING_REVIEW', by: 'borrower1@kku.ac.th' }],
    });
    batch.set(doc(borrower1Db, 'equipment_bookings', 'BR-COLLIDE-01'), {
      equipmentId: 'EQ-REPRO-1',
      startDate: '2026-11-12',
      expectedReturnDate: '2026-11-14',
      requestId: 'BR-COLLIDE-01',
      status: 'ACTIVE',
      updatedAt: new Date(),
    });
    batch.update(doc(borrower1Db, 'equipments', 'EQ-REPRO-1'), {
      lastBookingUpdatedAt: new Date(),
    });

    await assertFails(batch.commit());
  });

  await runTest('Repro 2: Direct batch write approving extension colliding with another booking or omitting lock is REJECTED', async () => {
    // Seed EQ-REPRO-2 with two bookings: BR-EXT-01 (target) 2026-11-01 to 2026-11-05 and BR-OTHER-01 2026-11-08 to 2026-11-12
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const adminDb = context.firestore();
      await setDoc(doc(adminDb, 'equipments', 'EQ-REPRO-2'), {
        id: 'EQ-REPRO-2',
        assetNumber: '7440-REPRO-2/67',
        name: 'Repro 2 Projector',
        status: 'AVAILABLE',
        isDeleted: false,
        activeBookings: [
          {
            requestId: 'BR-EXT-01',
            startDate: '2026-11-01',
            expectedReturnDate: '2026-11-05',
            status: 'ACTIVE',
          },
          {
            requestId: 'BR-OTHER-01',
            startDate: '2026-11-08',
            expectedReturnDate: '2026-11-12',
            status: 'ACTIVE',
          },
        ],
      });
      await setDoc(doc(adminDb, 'borrow_requests', 'BR-EXT-01'), {
        id: 'BR-EXT-01',
        status: 'IN_USE',
        borrower: { email: 'borrower1@kku.ac.th', name: 'สมชาย ผู้ยืม' },
        equipment: { equipmentId: 'EQ-REPRO-2', name: 'Repro 2 Projector' },
        startDate: '2026-11-01',
        expectedReturnDate: '2026-11-05',
        durationDays: 5,
        deadlineVersion: 1,
        extensionHistory: [],
        extension: {
          status: 'PENDING_APPROVAL',
          newExpectedReturnDate: '2026-11-10', // Collides with BR-OTHER-01 (starts 2026-11-08)
          addedDays: 5,
          reason: 'Exam preparation',
          requestedBy: 'borrower1@kku.ac.th',
          requestedAt: Timestamp.now(),
          review: { reviewerEmail: 'custodian@kku.ac.th', result: 'PASSED' },
        },
        timeline: [{ status: 'IN_USE', by: 'custodian@kku.ac.th' }],
      });
      await setDoc(doc(adminDb, 'equipment_bookings', 'BR-EXT-01'), {
        equipmentId: 'EQ-REPRO-2',
        startDate: '2026-11-01',
        expectedReturnDate: '2026-11-05',
        requestId: 'BR-EXT-01',
        status: 'ACTIVE',
        updatedAt: new Date(),
      });
    });

    // 2a: Approving extension colliding with BR-OTHER-01 -> REJECTED
    const batchCollide = writeBatch(approverDb);
    batchCollide.update(doc(approverDb, 'borrow_requests', 'BR-EXT-01'), {
      expectedReturnDate: '2026-11-10',
      durationDays: 10,
      deadlineVersion: 2,
      extension: {
        status: 'APPROVED',
        newExpectedReturnDate: '2026-11-10',
        addedDays: 5,
        reason: 'Exam preparation',
        requestedBy: 'borrower1@kku.ac.th',
        requestedAt: Timestamp.now(),
        review: { reviewerEmail: 'custodian@kku.ac.th', result: 'PASSED' },
        approval: { approverEmail: 'approver@kku.ac.th', result: 'APPROVED' },
      },
      extensionHistory: [
        {
          extensionNumber: 1,
          previousExpectedReturnDate: '2026-11-05',
          newExpectedReturnDate: '2026-11-10',
          addedDays: 5,
          reason: 'Exam preparation',
          requestedBy: 'borrower1@kku.ac.th',
          status: 'APPROVED',
        },
      ],
      timeline: [
        { status: 'IN_USE', by: 'custodian@kku.ac.th' },
        { status: 'IN_USE', note: 'อนุมัติต่ออายุ', by: 'approver@kku.ac.th' },
      ],
      updatedAt: new Date(),
    });
    batchCollide.update(doc(approverDb, 'equipment_bookings', 'BR-EXT-01'), {
      expectedReturnDate: '2026-11-10',
      status: 'ACTIVE',
      updatedAt: new Date(),
    });
    batchCollide.update(doc(approverDb, 'equipments', 'EQ-REPRO-2'), {
      lastBookingUpdatedAt: new Date(),
    });
    await assertFails(batchCollide.commit());

    // 2b: Approving non-colliding extension (to 2026-11-07) but omitting equipment lock -> REJECTED
    const batchOmitLock = writeBatch(approverDb);
    batchOmitLock.update(doc(approverDb, 'borrow_requests', 'BR-EXT-01'), {
      expectedReturnDate: '2026-11-07',
      durationDays: 7,
      deadlineVersion: 2,
      extension: {
        status: 'APPROVED',
        newExpectedReturnDate: '2026-11-07',
        addedDays: 2,
        reason: 'Exam preparation',
        requestedBy: 'borrower1@kku.ac.th',
        requestedAt: Timestamp.now(),
        review: { reviewerEmail: 'custodian@kku.ac.th', result: 'PASSED' },
        approval: { approverEmail: 'approver@kku.ac.th', result: 'APPROVED' },
      },
      extensionHistory: [
        {
          extensionNumber: 1,
          previousExpectedReturnDate: '2026-11-05',
          newExpectedReturnDate: '2026-11-07',
          addedDays: 2,
          reason: 'Exam preparation',
          requestedBy: 'borrower1@kku.ac.th',
          status: 'APPROVED',
        },
      ],
      timeline: [
        { status: 'IN_USE', by: 'custodian@kku.ac.th' },
        { status: 'IN_USE', note: 'อนุมัติต่ออายุ', by: 'approver@kku.ac.th' },
      ],
      updatedAt: new Date(),
    });
    batchOmitLock.update(doc(approverDb, 'equipment_bookings', 'BR-EXT-01'), {
      expectedReturnDate: '2026-11-07',
      status: 'ACTIVE',
      updatedAt: new Date(),
    });
    // Deliberately omit batchOmitLock.update(equipments...) -> MUST FAIL
    await assertFails(batchOmitLock.commit());
  });

  await runTest('Repro 3: Tampering with reason, requestedBy, or dates during review, approval, or cancel is REJECTED', async () => {
    // Seed request in PENDING_REVIEW extension state
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const adminDb = context.firestore();
      await setDoc(doc(adminDb, 'borrow_requests', 'BR-TAMP-01'), {
        id: 'BR-TAMP-01',
        status: 'IN_USE',
        borrower: { email: 'borrower1@kku.ac.th', name: 'สมชาย ผู้ยืม' },
        equipment: { equipmentId: 'EQ-001', name: 'Dell Latitude 5440' },
        startDate: '2026-11-01',
        expectedReturnDate: '2026-11-05',
        durationDays: 5,
        deadlineVersion: 1,
        extensionHistory: [],
        extension: {
          status: 'PENDING_REVIEW',
          newExpectedReturnDate: '2026-11-08',
          addedDays: 3,
          reason: 'Original reason by borrower',
          requestedBy: 'borrower1@kku.ac.th',
          requestedAt: Timestamp.now(),
        },
        timeline: [{ status: 'IN_USE', by: 'borrower1@kku.ac.th' }],
      });
    });

    // 3a: Custodian review alters reason -> REJECTED
    await assertFails(updateDoc(doc(custodianDb, 'borrow_requests', 'BR-TAMP-01'), {
      extension: {
        status: 'PENDING_APPROVAL',
        newExpectedReturnDate: '2026-11-08',
        addedDays: 3,
        reason: 'Forged reason by custodian',
        requestedBy: 'borrower1@kku.ac.th',
        requestedAt: Timestamp.now(),
        review: { reviewerEmail: 'custodian@kku.ac.th', result: 'PASSED' },
      },
      timeline: [
        { status: 'IN_USE', by: 'borrower1@kku.ac.th' },
        { status: 'IN_USE', note: 'ตรวจผ่าน', by: 'custodian@kku.ac.th' },
      ],
      updatedAt: new Date(),
    }));

    // 3b: Custodian review alters newExpectedReturnDate -> REJECTED
    await assertFails(updateDoc(doc(custodianDb, 'borrow_requests', 'BR-TAMP-01'), {
      extension: {
        status: 'PENDING_APPROVAL',
        newExpectedReturnDate: '2026-11-10',
        addedDays: 5,
        reason: 'Original reason by borrower',
        requestedBy: 'borrower1@kku.ac.th',
        requestedAt: Timestamp.now(),
        review: { reviewerEmail: 'custodian@kku.ac.th', result: 'PASSED' },
      },
      timeline: [
        { status: 'IN_USE', by: 'borrower1@kku.ac.th' },
        { status: 'IN_USE', note: 'ตรวจผ่าน', by: 'custodian@kku.ac.th' },
      ],
      updatedAt: new Date(),
    }));
  });

  await runTest('Repro 4: Forging deadlineVersion (skipping or decrementing) or truncating extensionHistory is REJECTED', async () => {
    // Seed request in PENDING_APPROVAL state with deadlineVersion 1 and empty history
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const adminDb = context.firestore();
      await setDoc(doc(adminDb, 'borrow_requests', 'BR-VER-01'), {
        id: 'BR-VER-01',
        status: 'IN_USE',
        borrower: { email: 'borrower1@kku.ac.th', name: 'สมชาย ผู้ยืม' },
        equipment: { equipmentId: 'EQ-002', name: 'โปรเจกเตอร์ Epson EB-X51' },
        startDate: '2026-11-01',
        expectedReturnDate: '2026-11-05',
        durationDays: 5,
        deadlineVersion: 1,
        extensionHistory: [],
        extension: {
          status: 'PENDING_APPROVAL',
          newExpectedReturnDate: '2026-11-08',
          addedDays: 3,
          reason: 'Need project presentation',
          requestedBy: 'borrower1@kku.ac.th',
          requestedAt: Timestamp.now(),
          review: { reviewerEmail: 'custodian@kku.ac.th', result: 'PASSED' },
        },
        timeline: [{ status: 'IN_USE', by: 'custodian@kku.ac.th' }],
      });
      await setDoc(doc(adminDb, 'equipment_bookings', 'BR-VER-01'), {
        equipmentId: 'EQ-002',
        startDate: '2026-11-01',
        expectedReturnDate: '2026-11-05',
        requestId: 'BR-VER-01',
        status: 'ACTIVE',
        updatedAt: new Date(),
      });
    });

    // 4a: Approver attempts deadlineVersion = 5 instead of 2 -> REJECTED
    const batchSkip = writeBatch(approverDb);
    batchSkip.update(doc(approverDb, 'borrow_requests', 'BR-VER-01'), {
      expectedReturnDate: '2026-11-08',
      durationDays: 8,
      deadlineVersion: 5, // Forged skip!
      extension: {
        status: 'APPROVED',
        newExpectedReturnDate: '2026-11-08',
        addedDays: 3,
        reason: 'Need project presentation',
        requestedBy: 'borrower1@kku.ac.th',
        requestedAt: Timestamp.now(),
        review: { reviewerEmail: 'custodian@kku.ac.th', result: 'PASSED' },
        approval: { approverEmail: 'approver@kku.ac.th', result: 'APPROVED' },
      },
      extensionHistory: [
        {
          extensionNumber: 1,
          previousExpectedReturnDate: '2026-11-05',
          newExpectedReturnDate: '2026-11-08',
          addedDays: 3,
          reason: 'Need project presentation',
          requestedBy: 'borrower1@kku.ac.th',
          status: 'APPROVED',
        },
      ],
      timeline: [
        { status: 'IN_USE', by: 'custodian@kku.ac.th' },
        { status: 'IN_USE', note: 'อนุมัติ', by: 'approver@kku.ac.th' },
      ],
      updatedAt: new Date(),
    });
    batchSkip.update(doc(approverDb, 'equipment_bookings', 'BR-VER-01'), {
      expectedReturnDate: '2026-11-08',
      status: 'ACTIVE',
      updatedAt: new Date(),
    });
    batchSkip.update(doc(approverDb, 'equipments', 'EQ-002'), {
      lastBookingUpdatedAt: new Date(),
    });
    await assertFails(batchSkip.commit());

    // 4b: Approver attempts empty/truncated extensionHistory -> REJECTED
    const batchTrunc = writeBatch(approverDb);
    batchTrunc.update(doc(approverDb, 'borrow_requests', 'BR-VER-01'), {
      expectedReturnDate: '2026-11-08',
      durationDays: 8,
      deadlineVersion: 2,
      extension: {
        status: 'APPROVED',
        newExpectedReturnDate: '2026-11-08',
        addedDays: 3,
        reason: 'Need project presentation',
        requestedBy: 'borrower1@kku.ac.th',
        requestedAt: Timestamp.now(),
        review: { reviewerEmail: 'custodian@kku.ac.th', result: 'PASSED' },
        approval: { approverEmail: 'approver@kku.ac.th', result: 'APPROVED' },
      },
      extensionHistory: [], // Truncated/omitted!
      timeline: [
        { status: 'IN_USE', by: 'custodian@kku.ac.th' },
        { status: 'IN_USE', note: 'อนุมัติ', by: 'approver@kku.ac.th' },
      ],
      updatedAt: new Date(),
    });
    batchTrunc.update(doc(approverDb, 'equipment_bookings', 'BR-VER-01'), {
      expectedReturnDate: '2026-11-08',
      status: 'ACTIVE',
      updatedAt: new Date(),
    });
    batchTrunc.update(doc(approverDb, 'equipments', 'EQ-002'), {
      lastBookingUpdatedAt: new Date(),
    });
    await assertFails(batchTrunc.commit());
  });

  await runTest('Repro 5: USER overwriting counters with backward/decrementing number or arbitrary fields is REJECTED', async () => {
    // Seed counter sequence 202611 = 100
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'counters', 'borrow_requests'), {
        '202611': 100,
      });
    });

    // 5a: Backward/decrementing update (100 -> 50) -> REJECTED
    await assertFails(updateDoc(doc(borrower1Db, 'counters', 'borrow_requests'), {
      '202611': 50,
    }));

    // 5b: Skipping forward (+10 instead of +1) -> REJECTED
    await assertFails(updateDoc(doc(borrower1Db, 'counters', 'borrow_requests'), {
      '202611': 110,
    }));

    // 5c: Arbitrary field injection -> REJECTED
    await assertFails(updateDoc(doc(borrower1Db, 'counters', 'borrow_requests'), {
      malicious_field: 999,
    }));

    // 5d: Legitimate atomic increment (+1) -> SUCCEEDS
    await assertSucceeds(updateDoc(doc(borrower1Db, 'counters', 'borrow_requests'), {
      '202611': 101,
    }));
  });

  await runTest('Repro 6: Extending an OVERDUE request whose new return date >= today transitions to IN_USE and SUCCEEDS', async () => {
    // Seed OVERDUE request with overdue date in the past
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const adminDb = context.firestore();
      await setDoc(doc(adminDb, 'equipments', 'EQ-OVD-01'), {
        id: 'EQ-OVD-01',
        assetNumber: '7440-OVD-01/67',
        name: 'Overdue Laptop',
        status: 'BORROWED',
        isDeleted: false,
        activeBookings: [
          {
            requestId: 'BR-OVD-TEST',
            startDate: '2026-10-01',
            expectedReturnDate: '2026-10-08',
            status: 'ACTIVE',
          },
        ],
      });
      await setDoc(doc(adminDb, 'borrow_requests', 'BR-OVD-TEST'), {
        id: 'BR-OVD-TEST',
        status: 'OVERDUE',
        borrower: { email: 'borrower1@kku.ac.th', name: 'สมชาย ผู้ยืม' },
        equipment: { equipmentId: 'EQ-OVD-01', name: 'Overdue Laptop' },
        startDate: '2026-10-01',
        expectedReturnDate: '2026-10-08',
        durationDays: 8,
        deadlineVersion: 1,
        extensionHistory: [],
        timeline: [{ status: 'OVERDUE', by: 'custodian@kku.ac.th' }],
      });
      await setDoc(doc(adminDb, 'equipment_bookings', 'BR-OVD-TEST'), {
        equipmentId: 'EQ-OVD-01',
        startDate: '2026-10-01',
        expectedReturnDate: '2026-10-08',
        requestId: 'BR-OVD-TEST',
        status: 'ACTIVE',
        updatedAt: new Date(),
      });
    });

    // 1. Borrower requests extension to 2026-10-25 (total 25 days <= 30)
    const ovdSnap = await getDoc(doc(custodianDb, 'borrow_requests', 'BR-OVD-TEST'));
    const ovdReq = { id: ovdSnap.id, ...ovdSnap.data() };
    await requestExtension(ovdReq, borrower1User, {
      newExpectedReturnDate: '2026-10-25',
      reason: 'Need extra days for research completion',
    }, borrower1Db);

    // 2. Custodian reviews and passes
    const revSnap = await getDoc(doc(custodianDb, 'borrow_requests', 'BR-OVD-TEST'));
    const revReq = { id: revSnap.id, ...revSnap.data() };
    await reviewExtension(revReq, custodianUser, {
      passed: true,
      comment: 'อนุมัติให้ต่ออายุได้',
    }, custodianDb);

    // 3. Approver approves extension
    const appSnap = await getDoc(doc(approverDb, 'borrow_requests', 'BR-OVD-TEST'));
    const appReq = { id: appSnap.id, ...appSnap.data() };
    await approveExtension(appReq, approverUser, true, 'อนุมัติต่ออายุ', approverDb);

    // 4. Verify request transitioned from OVERDUE to IN_USE and date extended
    const finalSnap = await getDoc(doc(borrower1Db, 'borrow_requests', 'BR-OVD-TEST'));
    const finalData = finalSnap.data();
    if (finalData.status !== 'IN_USE') {
      throw new Error(`Expected status 'IN_USE' but got '${finalData.status}'`);
    }
    if (finalData.expectedReturnDate !== '2026-10-25') {
      throw new Error(`Expected expectedReturnDate '2026-10-25' but got '${finalData.expectedReturnDate}'`);
    }
    if (finalData.deadlineVersion !== 2) {
      throw new Error(`Expected deadlineVersion 2 but got ${finalData.deadlineVersion}`);
    }
    if (!finalData.extensionHistory || finalData.extensionHistory.length !== 1) {
      throw new Error(`Expected extensionHistory length 1`);
    }
  });

  // -------------------------------------------------------------
  // Pending extensions must not be replaced, including via stale clients.
  for (const oldStatus of [null, 'CANCELLED', 'REJECTED', 'APPROVED', 'PENDING_REVIEW', 'PENDING_APPROVAL']) {
    await runTest(`Extension resubmission: ${oldStatus || 'NONE'} has correct service and Rules outcome`, async () => {
      const pending = ['PENDING_REVIEW', 'PENDING_APPROVAL'].includes(oldStatus);
      const id = `BR-DUP-${oldStatus || 'NONE'}`;
      const email = 'borrower1@kku.ac.th';
      const curReturn = addDays(todayStr(), 2);
      const newReturn = addDays(todayStr(), 5);
      const ext = {
        status: 'PENDING_REVIEW', requestedAt: Timestamp.now(), requestedBy: email,
        requestedByName: 'Test borrower', currentExpectedReturnDate: curReturn,
        newExpectedReturnDate: newReturn, addedDays: 3, reason: 'Valid extension',
        isOverdueExtension: false, review: null, approval: null,
      };
      const original = {
        id, status: 'IN_USE', borrower: { email, name: 'Test borrower' },
        equipment: { equipmentId: 'EQ-DUP', name: 'Test equipment' },
        startDate: todayStr(), expectedReturnDate: curReturn, durationDays: 3,
        deadlineVersion: 1, extensionHistory: [],
        timeline: [{ status: 'IN_USE', by: email }],
        ...(oldStatus ? { extension: { ...ext, status: oldStatus, reason: 'Original request' } } : {}),
      };
      await testEnv.withSecurityRulesDisabled(async context => {
        await setDoc(doc(context.firestore(), 'borrow_requests', id), original);
      });
      const ref = doc(borrower1Db, 'borrow_requests', id);
      const before = (await getDoc(ref)).data();
      if (pending) {
        for (const inputRequest of [original, { ...original, extension: undefined }]) {
          let blocked = false;
          try {
            await requestExtension(inputRequest, { email, name: 'Test borrower', role: 'USER' },
              { newExpectedReturnDate: newReturn, reason: 'Valid extension' }, borrower1Db);
          } catch (err) {
            if (!err.message.includes('อยู่ระหว่างการพิจารณา')) throw err;
            blocked = true;
          }
          if (!blocked) throw new Error('Service accepted a pending duplicate extension');
        }
      }
      // Identical valid payload for positive and negative controls; only prior state differs.
      const write = updateDoc(ref, {
        extension: ext,
        timeline: [...original.timeline, { status: 'IN_USE', by: email, note: 'Extension request' }],
        updatedAt: serverTimestamp(),
      });
      if (pending) {
        await assertFails(write);
        if (JSON.stringify((await getDoc(ref)).data()) !== JSON.stringify(before)) {
          throw new Error('Rejected duplicate changed the stored request');
        }
      } else {
        await assertSucceeds(write);
        if ((await getDoc(ref)).data().extension.status !== 'PENDING_REVIEW') {
          throw new Error('Valid extension was not persisted');
        }
      }
    });
  }

  for (const pendingStatus of ['PENDING_REVIEW', 'PENDING_APPROVAL', 'LEGACY_CANCELLED']) {
    await runTest(`Real returnRequest: APPROVER returns custodian loan with ${pendingStatus} extension`, async () => {
      const id = `BR-RETURN-${pendingStatus}`;
      const eqId = `EQ-RETURN-${pendingStatus}`;
      const request = {
        id, status: 'IN_USE', borrower: { email: custodianUser.email, name: custodianUser.name },
        equipment: { equipmentId: eqId, name: 'Return test', assetNumber: eqId },
        startDate: '2026-10-11', expectedReturnDate: '2026-10-12', durationDays: 2,
        timeline: [{ status: 'IN_USE', by: custodianUser.email }],
        extension: { status: pendingStatus, requestedBy: custodianUser.email,
          requestedAt: Timestamp.now(), newExpectedReturnDate: '2026-10-15',
          currentExpectedReturnDate: '2026-10-12', addedDays: 3, reason: 'Test',
          review: { result: 'PASSED', reviewerEmail: custodianUser.email } },
      };
      if (pendingStatus === 'LEGACY_CANCELLED') request.extension.status = 'CANCELLED';
      await testEnv.withSecurityRulesDisabled(async context => {
        const db = context.firestore();
        const storedRequest = { ...request };
        if (pendingStatus === 'LEGACY_CANCELLED') delete storedRequest.id;
        await setDoc(doc(db, 'borrow_requests', id), storedRequest);
        await setDoc(doc(db, 'equipments', eqId), { id: eqId, name: 'Return test', status: 'BORROWED', activeBookings: [{ requestId: id }] });
        if (pendingStatus !== 'LEGACY_CANCELLED') await setDoc(doc(db, 'equipment_bookings', id), {
          requestId: id, equipmentId: eqId, status: 'ACTIVE',
          startDate: request.startDate, expectedReturnDate: request.expectedReturnDate,
        });
      });
      if (pendingStatus === 'LEGACY_CANCELLED') {
        const closedBooking = { requestId: id, equipmentId: eqId, status: 'RETURNED',
          startDate: request.startDate, expectedReturnDate: request.expectedReturnDate, updatedAt: serverTimestamp() };
        await assertFails(setDoc(doc(approverDb, 'equipment_bookings', id), closedBooking));
        await assertFails(setDoc(doc(borrower1Db, 'equipment_bookings', id), closedBooking));
      }
      await returnRequest(request, approverUser, { condition: 'NORMAL', remarks: 'Received by approver' }, approverDb);
      const final = (await getDoc(doc(approverDb, 'borrow_requests', id))).data();
      const equipment = (await getDoc(doc(approverDb, 'equipments', eqId))).data();
      const booking = (await getDoc(doc(approverDb, 'equipment_bookings', id))).data();
      if (final.status !== 'RETURNED' || final.extension.status !== 'CANCELLED' ||
          final.returnInfo.receivedByEmail !== approverUser.email || equipment.status !== 'AVAILABLE' ||
          equipment.activeBookings.length !== 0 || booking.status !== 'RETURNED') {
        throw new Error('Return state, actor, equipment or booking is inconsistent');
      }
    });
  }

  await runTest('Mail queue: two simultaneous clicks create one pending job', async () => {
    const job = {
      to: ['custodian@kku.ac.th'], senderEmail: 'borrower1@kku.ac.th',
      type: 'NEW_REQUEST', requestId: 'BR-MAIL-DEDUP',
      idempotencyKey: 'BR-MAIL-DEDUP_NEW_REQUEST_custodian@kku.ac.th',
      status: 'PENDING', attemptCount: 0, createdAt: new Date(),
      message: { subject: 'ทดสอบคิว', text: 'ทดสอบ', html: '<p>ทดสอบ</p>' },
    };
    const results = await Promise.all([
      createMailJobOnce(borrower1Db, job, 'borrower1@kku.ac.th'),
      createMailJobOnce(borrower1Db, job, 'borrower1@kku.ac.th'),
    ]);
    if (results[0].ref.id !== results[1].ref.id ||
        results.filter(result => result.created).length !== 1) {
      throw new Error('Concurrent calls created more than one mail job');
    }
    const saved = await getDoc(results[0].ref);
    if (!saved.exists() || saved.data().status !== 'PENDING') {
      throw new Error('Pending job was overwritten');
    }
  });

  await runTest('Regression: USER creates mail job, borrower CANNOT forge SUCCESS, worker sends once', async () => {
    const job = {
      to: ['custodian@kku.ac.th'],
      senderEmail: 'borrower1@kku.ac.th',
      type: 'NEW_REQUEST',
      requestId: 'BR-USER-MAIL-01',
      idempotencyKey: 'BR-USER-MAIL-01_NEW_REQUEST_custodian@kku.ac.th',
      status: 'PENDING',
      attemptCount: 0,
      maxAttempts: 3,
      createdAt: new Date(),
      message: { subject: 'คำขอยืมใหม่', text: 'ทดสอบ', html: '<p>ทดสอบ</p>' },
    };
    const { ref: mailRef } = await createMailJobOnce(borrower1Db, job, 'borrower1@kku.ac.th');

    // Borrower must NOT be able to update status or forge SUCCESS (Rules verification)
    await assertFails(updateDoc(doc(borrower1Db, 'mail', mailRef.id), { status: 'SUCCESS' }));

    // Server-side Worker sweeps the queue
    let dispatchCount = 0;
    const mockFetch = async () => {
      dispatchCount++;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ status: 'SUCCESS', messageId: 'msg_worker_sweep_01' }),
      };
    };

    const sweepRes = await processSingleMailJob(mailRef.id, { customMockFetch: mockFetch });
    if (!sweepRes.success) {
      throw new Error(`Worker failed to process user pending job: ${JSON.stringify(sweepRes)}`);
    }

    let finalDoc;
    await testEnv.withSecurityRulesDisabled(async (context) => {
      finalDoc = (await getDoc(doc(context.firestore(), 'mail', mailRef.id))).data();
    });
    if (finalDoc.status !== 'SUCCESS' || finalDoc.messageId !== 'msg_worker_sweep_01') {
      throw new Error(`Job document not updated to SUCCESS: ${JSON.stringify(finalDoc)}`);
    }
    if (dispatchCount !== 1) {
      throw new Error(`Expected exactly 1 dispatch, got ${dispatchCount}`);
    }
  });

  await runTest('Regression: Two workers race against each other (atomically claimed once)', async () => {
    const job = {
      to: ['borrower1@kku.ac.th'],
      senderEmail: 'custodian@kku.ac.th',
      type: 'REQUEST_CONFIRMATION',
      requestId: 'BR-RACE-01',
      idempotencyKey: 'BR-RACE-01_CONFIRM',
      status: 'PENDING',
      attemptCount: 0,
      maxAttempts: 3,
      createdAt: new Date(),
      message: { subject: 'คำขอยืนยัน', text: 'ทดสอบ', html: '<p>ทดสอบ</p>' },
    };
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'mail', 'race_job_001'), job);
    });

    let callCount = 0;
    const mockFetch = async () => {
      callCount++;
      await new Promise((r) => setTimeout(r, 20));
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ status: 'SUCCESS', messageId: 'msg_race_winner' }),
      };
    };

    // Two concurrent workers attempt to claim and process the EXACT SAME document
    const [worker1Result, worker2Result] = await Promise.all([
      processSingleMailJob('race_job_001', { customMockFetch: mockFetch }),
      processSingleMailJob('race_job_001', { customMockFetch: mockFetch }),
    ]);

    const winners = [worker1Result, worker2Result].filter((r) => r.claimed && r.success);
    const losers = [worker1Result, worker2Result].filter((r) => !r.claimed);

    if (winners.length !== 1 || losers.length !== 1) {
      throw new Error(
        `Race condition violation: Expected 1 winner and 1 loser, got ${winners.length} winners and ${losers.length} losers: ${JSON.stringify({ worker1Result, worker2Result })}`
      );
    }

    if (callCount !== 1) {
      throw new Error(`Expected gateway to be invoked exactly once, but invoked ${callCount} times`);
    }

    let finalDoc;
    await testEnv.withSecurityRulesDisabled(async (context) => {
      finalDoc = (await getDoc(doc(context.firestore(), 'mail', 'race_job_001'))).data();
    });
    if (finalDoc.status !== 'SUCCESS') {
      throw new Error(`Document status is not SUCCESS: ${JSON.stringify(finalDoc)}`);
    }
  });

  await runTest('Regression: Worker retry on failure and mark ERROR after maxAttempts', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'mail', 'retry_job_001'), {
        to: ['user@kku.ac.th'],
        senderEmail: 'system@kku.ac.th',
        type: 'TEST',
        status: 'PENDING',
        attemptCount: 0,
        maxAttempts: 2,
        createdAt: new Date(),
        message: { subject: 'Retry Test', text: 'Retry', html: '<p>Retry</p>' },
      });
    });

    const failingFetch = async () => ({
      ok: false,
      status: 503,
      text: async () => 'Service Unavailable',
    });

    // Attempt 1: Should fail and re-queue to PENDING for retry
    const res1 = await processSingleMailJob('retry_job_001', { customMockFetch: failingFetch });
    if (res1.success || !res1.retrying) {
      throw new Error(`Expected attempt 1 to fail with retrying=true, got ${JSON.stringify(res1)}`);
    }
    let docSnap;
    await testEnv.withSecurityRulesDisabled(async (context) => {
      docSnap = (await getDoc(doc(context.firestore(), 'mail', 'retry_job_001'))).data();
    });
    if (docSnap.status !== 'PENDING' || docSnap.attemptCount !== 1) {
      throw new Error(`Expected attempt 1 to be PENDING with attemptCount 1: ${JSON.stringify(docSnap)}`);
    }

    // Fast-forward nextAttemptAt so Attempt 2 is due (Blocker 4 validation)
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await updateDoc(doc(context.firestore(), 'mail', 'retry_job_001'), {
        nextAttemptAt: Timestamp.fromMillis(Date.now() - 1000),
      });
    });

    // Attempt 2: Reached maxAttempts (2) -> Should mark status ERROR
    const res2 = await processSingleMailJob('retry_job_001', { customMockFetch: failingFetch });
    if (res2.success || res2.retrying) {
      throw new Error(`Expected attempt 2 to fail with retrying=false, got ${JSON.stringify(res2)}`);
    }
    await testEnv.withSecurityRulesDisabled(async (context) => {
      docSnap = (await getDoc(doc(context.firestore(), 'mail', 'retry_job_001'))).data();
    });
    if (docSnap.status !== 'ERROR' || docSnap.attemptCount !== 2) {
      throw new Error(`Expected attempt 2 to be ERROR with attemptCount 2: ${JSON.stringify(docSnap)}`);
    }
  });

  await runTest('Regression: Adversarial borrower attempting open relay / phishing to external recipient is REJECTED by Rules', async () => {
    const maliciousJob = {
      to: ['victim@external.com'],
      senderEmail: 'borrower1@kku.ac.th',
      type: 'NEW_REQUEST',
      requestId: 'BR-USER-MAIL-01',
      idempotencyKey: 'BR-USER-MAIL-01_SPAM_VICTIM',
      status: 'PENDING',
      attemptCount: 0,
      maxAttempts: 3,
      createdAt: new Date(),
      message: { subject: 'Spam Phishing', text: 'Click here', html: '<p>Click here</p>' },
    };
    await assertFails(createMailJobOnce(borrower1Db, maliciousJob, 'borrower1@kku.ac.th'));
  });

  await runTest('Regression: Adversarial borrower attempting to create mail for someone else\'s request is REJECTED by Rules', async () => {
    const spoofedRequestJob = {
      to: ['custodian@kku.ac.th'],
      senderEmail: 'borrower1@kku.ac.th',
      type: 'NEW_REQUEST',
      requestId: 'BR-OTHER-USER-01', // Owned by borrower2
      idempotencyKey: 'BR-OTHER-USER-01_SPOOF',
      status: 'PENDING',
      attemptCount: 0,
      maxAttempts: 3,
      createdAt: new Date(),
      message: { subject: 'Spoofed Request', text: 'Spoof', html: '<p>Spoof</p>' },
    };
    await assertFails(createMailJobOnce(borrower1Db, spoofedRequestJob, 'borrower1@kku.ac.th'));
  });

  await runTest('Regression: Adversarial borrower attempting to fake senderEmail or pre-forge SUCCESS is REJECTED by Rules', async () => {
    const forgedSuccessJob = {
      to: ['custodian@kku.ac.th'],
      senderEmail: 'borrower1@kku.ac.th',
      type: 'NEW_REQUEST',
      requestId: 'BR-USER-MAIL-01',
      idempotencyKey: 'BR-USER-MAIL-01_FORGE_SUCCESS',
      status: 'SUCCESS', // Forged status
      attemptCount: 1,
      createdAt: new Date(),
      sentAt: new Date(),
      message: { subject: 'Forged', text: 'Forged', html: '<p>Forged</p>' },
    };
    await assertFails(createMailJobOnce(borrower1Db, forgedSuccessJob, 'borrower1@kku.ac.th'));
  });

  await runTest('Regression: recoverStale transitions stuck PROCESSING job to RECONCILIATION_REQUIRED without auto-resend', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'mail', 'stale_proc_job_001'), {
        to: ['user@kku.ac.th'],
        senderEmail: 'custodian@kku.ac.th',
        type: 'NOTIFICATION',
        status: 'PROCESSING',
        attemptCount: 1,
        claimedAt: Timestamp.fromMillis(Date.now() - 400000), // > 6 minutes ago
        createdAt: new Date(),
        message: { subject: 'Stale Test', text: 'Stale', html: '<p>Stale</p>' },
      });
    });

    let dispatchCalled = false;
    const mockFetch = async (url, init) => {
      try {
        const body = JSON.parse(init?.body || '{}');
        if (body.subject === 'Stale Test') {
          dispatchCalled = true;
        }
      } catch {
        dispatchCalled = true;
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'SUCCESS' }) };
    };

    const sweepResult = await processMailQueueOnce({
      customMockFetch: mockFetch,
      recoverStale: true,
      staleTimeoutMs: 300000,
    });

    if (dispatchCalled) {
      throw new Error('Dangerous: Gateway was invoked during stale recovery (potential duplicate email)!');
    }

    let finalDoc;
    await testEnv.withSecurityRulesDisabled(async (context) => {
      finalDoc = (await getDoc(doc(context.firestore(), 'mail', 'stale_proc_job_001'))).data();
    });

    if (finalDoc.status !== 'RECONCILIATION_REQUIRED') {
      throw new Error(`Expected status RECONCILIATION_REQUIRED, got: ${finalDoc.status}`);
    }
    if (!finalDoc.requiresReconciliation) {
      throw new Error('Expected requiresReconciliation flag on document');
    }
  });

  await runTest('Regression: Server worker detects stale request status before dispatch and marks SKIPPED', async () => {
    // Request BR-STALE-CHECK has status: 'CANCELLED' in Firestore
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'mail', 'stale_check_job_001'), {
        to: ['borrower1@kku.ac.th'],
        senderEmail: 'custodian@kku.ac.th',
        type: 'REMINDER_DUE_SOON',
        requestId: 'BR-STALE-CHECK',
        targetStatus: 'IN_USE', // Target expects IN_USE, but request is CANCELLED!
        status: 'PENDING',
        attemptCount: 0,
        maxAttempts: 3,
        createdAt: new Date(),
        message: { subject: 'Stale Reminder', text: 'Text', html: '<p>Html</p>' },
      });
    });

    let gatewayDispatched = false;
    const mockFetch = async () => {
      gatewayDispatched = true;
      return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'SUCCESS' }) };
    };

    const res = await processSingleMailJob('stale_check_job_001', { customMockFetch: mockFetch });
    if (!res.skipped || !res.success) {
      throw new Error(`Expected worker to mark job as skipped, got: ${JSON.stringify(res)}`);
    }
    if (gatewayDispatched) {
      throw new Error('Gateway was called for stale request notification!');
    }

    let finalDoc;
    await testEnv.withSecurityRulesDisabled(async (context) => {
      finalDoc = (await getDoc(doc(context.firestore(), 'mail', 'stale_check_job_001'))).data();
    });
    if (finalDoc.status !== 'SKIPPED') {
      throw new Error(`Expected document status SKIPPED, got: ${finalDoc.status}`);
    }
  });

  await runTest('CSAT Rules: Borrower can submit satisfaction survey once on RETURNED request', async () => {
    const reqId = 'BR-CSAT-TEST-01';
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'borrow_requests', reqId), {
        id: reqId,
        status: 'RETURNED',
        borrower: { email: 'borrower1@kku.ac.th', name: 'Borrower 1' },
        equipment: { equipmentId: 'EQ-001', assetNumber: 'KKU-001', name: 'Notebook' },
        timeline: [{ status: 'RETURNED', at: new Date(), by: 'custodian@kku.ac.th' }],
      });
    });

    const borrowerContext = testEnv.authenticatedContext('borrower1', { email: 'borrower1@kku.ac.th' });
    const borrowerDb = borrowerContext.firestore();

    // 1. Borrower submits valid survey
    await assertSucceeds(
      updateDoc(doc(borrowerDb, 'borrow_requests', reqId), {
        survey: {
          rating: 5,
          tags: ['อุปกรณ์พร้อมใช้งาน', 'บริการรวดเร็ว'],
          comment: 'บริการดีมาก',
          submittedAt: new Date(),
          submittedBy: 'borrower1@kku.ac.th',
          submittedByName: 'Borrower 1',
        },
        updatedAt: serverTimestamp(),
      })
    );

    // 2. Borrower attempts to submit survey again -> MUST FAIL (once-only invariant)
    await assertFails(
      updateDoc(doc(borrowerDb, 'borrow_requests', reqId), {
        survey: {
          rating: 1,
          submittedAt: new Date(),
          submittedBy: 'borrower1@kku.ac.th',
        },
        updatedAt: serverTimestamp(),
      })
    );

    // 3. Other user attempts to submit survey on borrower's request -> MUST FAIL
    const hackerContext = testEnv.authenticatedContext('hacker', { email: 'hacker@kku.ac.th' });
    const hackerDb = hackerContext.firestore();
    await assertFails(
      updateDoc(doc(hackerDb, 'borrow_requests', reqId), {
        survey: {
          rating: 5,
          submittedAt: new Date(),
          submittedBy: 'hacker@kku.ac.th',
        },
        updatedAt: serverTimestamp(),
      })
    );
  });

  await runTest('CSAT Rules: Staff can update surveyInviteQueuedAt and surveyInviteSentAt for tracking', async () => {
    const reqId = 'BR-CSAT-INVITE-01';
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'borrow_requests', reqId), {
        id: reqId,
        status: 'RETURNED',
        borrower: { email: 'borrower1@kku.ac.th', name: 'Borrower 1' },
        equipment: { equipmentId: 'EQ-001', assetNumber: 'KKU-001', name: 'Notebook' },
        timeline: [{ status: 'RETURNED', at: new Date(), by: 'custodian@kku.ac.th' }],
      });
    });

    const staffContext = testEnv.authenticatedContext('custodian', { email: 'custodian@kku.ac.th' });
    const staffDb = staffContext.firestore();

    // Staff records survey invite queued status
    await assertSucceeds(
      updateDoc(doc(staffDb, 'borrow_requests', reqId), {
        surveyInviteQueuedAt: serverTimestamp(),
        surveyInviteStatus: 'QUEUED',
        updatedAt: serverTimestamp(),
      })
    );

    // Staff client attempts to record survey invite SENT status -> MUST FAIL (Only trusted Server Worker / Admin SDK can set SENT)
    await assertFails(
      updateDoc(doc(staffDb, 'borrow_requests', reqId), {
        surveyInviteSentAt: serverTimestamp(),
        surveyInviteStatus: 'SENT',
        updatedAt: serverTimestamp(),
      })
    );

    // Normal user attempts to update surveyInviteStatus -> MUST FAIL
    const borrowerContext = testEnv.authenticatedContext('borrower1', { email: 'borrower1@kku.ac.th' });
    const borrowerDb = borrowerContext.firestore();
    await assertFails(
      updateDoc(doc(borrowerDb, 'borrow_requests', reqId), {
        surveyInviteStatus: 'QUEUED',
        updatedAt: serverTimestamp(),
      })
    );
  });

  await runTest('CSAT Service: sendRetroactiveCsatInvite atomically creates mail doc and records QUEUED status', async () => {
    const reqId = 'BR-CSAT-SERVICE-01';
    const fakeRequest = {
      id: reqId,
      status: 'RETURNED',
      borrower: { email: 'borrower1@kku.ac.th', name: 'Borrower 1' },
      equipment: { equipmentId: 'EQ-001', assetNumber: 'KKU-001', name: 'Notebook' },
      startDate: '2026-10-01',
      expectedReturnDate: '2026-10-05',
      actualReturnDate: '2026-10-05',
      timeline: [{ status: 'RETURNED', at: new Date(), by: 'custodian@kku.ac.th' }],
    };

    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'borrow_requests', reqId), fakeRequest);
    });

    const res = await sendRetroactiveCsatInvite(fakeRequest, custodianUser, custodianDb);
    if (!res.success || !res.mailJobId) throw new Error('sendRetroactiveCsatInvite failed');

    // Verify request doc updated to QUEUED atomically with count 1
    const reqSnap = await getDoc(doc(custodianDb, 'borrow_requests', reqId));
    const reqData = reqSnap.data();
    if (reqData.surveyInviteStatus !== 'QUEUED') {
      throw new Error(`Expected surveyInviteStatus to be QUEUED, got: ${reqData.surveyInviteStatus}`);
    }
    if (!reqData.surveyInviteQueuedAt) {
      throw new Error('Expected surveyInviteQueuedAt timestamp to be present');
    }
    if (reqData.surveyInviteCount !== 1) {
      throw new Error(`Expected surveyInviteCount to be 1, got: ${reqData.surveyInviteCount}`);
    }

    // Verify mail doc created in PENDING status
    const mailSnap = await getDoc(doc(custodianDb, 'mail', res.mailJobId));
    if (!mailSnap.exists()) {
      throw new Error('Expected mail document to be created in Firestore');
    }
    const mailData = mailSnap.data();
    if (mailData.status !== 'PENDING') {
      throw new Error(`Expected mail status to be PENDING, got: ${mailData.status}`);
    }
    if (mailData.idempotencyKey !== `${reqId}_RETROACTIVE_CSAT`) {
      throw new Error(`Expected stable idempotencyKey ${reqId}_RETROACTIVE_CSAT, got: ${mailData.idempotencyKey}`);
    }

    // Simulate worker delivering the email and updating status to SENT (Server Admin context)
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await updateDoc(doc(context.firestore(), 'borrow_requests', reqId), {
        surveyInviteSentAt: serverTimestamp(),
        surveyInviteStatus: 'SENT',
        updatedAt: serverTimestamp(),
      });
      await updateDoc(doc(context.firestore(), 'mail', res.mailJobId), {
        status: 'SUCCESS',
        sentAt: serverTimestamp(),
      });
    });

    // Calling sendRetroactiveCsatInvite again without forceResend must fail
    let duplicateRejected = false;
    try {
      await sendRetroactiveCsatInvite(fakeRequest, custodianUser, custodianDb);
    } catch (dupErr) {
      duplicateRejected = true;
    }
    if (!duplicateRejected) {
      throw new Error('Expected duplicate send without forceResend to be rejected');
    }

    // Calling sendRetroactiveCsatInvite with forceResend succeeds and increments count
    const resendRes = await sendRetroactiveCsatInvite(
      fakeRequest,
      custodianUser,
      { forceResend: true, resendReason: 'Follow-up survey requested' },
      custodianDb
    );
    if (!resendRes.success || resendRes.inviteNumber !== 2) {
      throw new Error(`Expected inviteNumber 2 on forceResend, got: ${resendRes.inviteNumber}`);
    }
    const afterResendSnap = await getDoc(doc(custodianDb, 'borrow_requests', reqId));
    if (afterResendSnap.data().surveyInviteCount !== 2) {
      throw new Error(`Expected surveyInviteCount to be 2, got: ${afterResendSnap.data().surveyInviteCount}`);
    }
  });

  await runTest('CSAT Service: Atomic transaction rollback prevents orphaned mail jobs', async () => {
    const reqId = 'BR-CSAT-NOT-RETURNED';
    const activeRequest = {
      id: reqId,
      status: 'IN_USE',
      borrower: { email: 'borrower1@kku.ac.th', name: 'Borrower 1' },
      equipment: { equipmentId: 'EQ-001', assetNumber: 'KKU-001', name: 'Notebook' },
      startDate: '2026-10-01',
      expectedReturnDate: '2026-10-15',
    };

    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'borrow_requests', reqId), activeRequest);
    });

    let rejected = false;
    try {
      await sendRetroactiveCsatInvite(activeRequest, custodianUser, custodianDb);
    } catch {
      rejected = true;
    }
    if (!rejected) {
      throw new Error('Expected invite on IN_USE request to be rejected');
    }

    // Verify no mail jobs created for this request
    const mailQuery = query(collection(custodianDb, 'mail'), where('requestId', '==', reqId));
    const mailSnap = await getDocs(mailQuery);
    if (!mailSnap.empty) {
      throw new Error('Atomic rollback failed: orphaned mail job was created');
    }
  });

  // =============================================================
  // MAIL COLLECTION SECURITY RULES & SERVER WORKER RETRY TESTS
  // =============================================================

  await runTest('Security Rules: Staff client CANNOT forge status (SUCCESS or PENDING) on mail collection', async () => {
    const mailId = 'mail_security_tamper_status';
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'mail', mailId), {
        id: mailId,
        status: 'ERROR',
        to: ['borrower1@kku.ac.th'],
        message: { subject: 'Test' },
        type: 'TEST',
        senderEmail: 'custodian@kku.ac.th',
        attemptCount: 1,
        maxAttempts: 3,
        createdAt: serverTimestamp(),
      });
    });

    // 1. Staff client forging SUCCESS directly must FAIL
    await assertFails(updateDoc(doc(custodianDb, 'mail', mailId), {
      status: 'SUCCESS',
      sentAt: serverTimestamp(),
    }));

    // 2. Staff client forging PENDING directly must FAIL
    await assertFails(updateDoc(doc(custodianDb, 'mail', mailId), {
      status: 'PENDING',
    }));
  });

  await runTest('Security Rules: Staff client CANNOT modify recipients (to) or payload (message, type, requestId)', async () => {
    const mailId = 'mail_security_tamper_payload';
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'mail', mailId), {
        id: mailId,
        status: 'ERROR',
        to: ['borrower1@kku.ac.th'],
        message: { subject: 'Original Subject', text: 'Original' },
        type: 'TEST',
        senderEmail: 'custodian@kku.ac.th',
        attemptCount: 1,
        maxAttempts: 3,
        createdAt: serverTimestamp(),
      });
    });

    // Phishing / recipient hijack: change 'to' along with retry signal -> MUST FAIL
    await assertFails(updateDoc(doc(custodianDb, 'mail', mailId), {
      to: ['attacker@evil.com'],
      retryRequestedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }));

    // Payload tampering: change 'message' along with retry signal -> MUST FAIL
    await assertFails(updateDoc(doc(custodianDb, 'mail', mailId), {
      message: { subject: 'Forged Subject', text: 'Malicious Content' },
      retryRequestedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }));

    // Type tampering -> MUST FAIL
    await assertFails(updateDoc(doc(custodianDb, 'mail', mailId), {
      type: 'FORGED_TYPE',
      retryRequestedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }));
  });

  await runTest('Security Rules: Staff client CANNOT tamper with attemptCount, locks (claimedAt/claimedBy), or nextAttemptAt', async () => {
    const mailId = 'mail_security_tamper_locks';
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'mail', mailId), {
        id: mailId,
        status: 'ERROR',
        to: ['borrower1@kku.ac.th'],
        message: { subject: 'Test' },
        type: 'TEST',
        attemptCount: 3,
        maxAttempts: 3,
        claimedAt: serverTimestamp(),
        claimedBy: 'SERVER_WORKER',
        nextAttemptAt: Timestamp.fromMillis(Date.now() + 60000),
        createdAt: serverTimestamp(),
      });
    });

    // Resetting attemptCount to 0 -> MUST FAIL
    await assertFails(updateDoc(doc(custodianDb, 'mail', mailId), {
      attemptCount: 0,
      retryRequestedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }));

    // Clearing claimedAt or claimedBy -> MUST FAIL
    await assertFails(updateDoc(doc(custodianDb, 'mail', mailId), {
      claimedAt: null,
      claimedBy: null,
      retryRequestedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }));

    // Clearing nextAttemptAt -> MUST FAIL
    await assertFails(updateDoc(doc(custodianDb, 'mail', mailId), {
      nextAttemptAt: null,
      retryRequestedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }));
  });

  await runTest('Security Rules: Non-staff (borrower or unauthenticated) CANNOT update or forge mail', async () => {
    const mailId = 'mail_security_nonstaff_update';
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'mail', mailId), {
        id: mailId,
        status: 'ERROR',
        to: ['borrower1@kku.ac.th'],
        message: { subject: 'Test' },
        type: 'TEST',
        attemptCount: 1,
        maxAttempts: 3,
        createdAt: serverTimestamp(),
      });
    });

    // Borrower updating retryRequestedAt -> MUST FAIL
    await assertFails(updateDoc(doc(borrower1Db, 'mail', mailId), {
      retryRequestedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }));

    // Anonymous updating retryRequestedAt -> MUST FAIL
    await assertFails(updateDoc(doc(anonDb, 'mail', mailId), {
      retryRequestedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }));

    // Anonymous creating mail job -> MUST FAIL
    await assertFails(addDoc(collection(anonDb, 'mail'), {
      status: 'PENDING',
      to: ['borrower1@kku.ac.th'],
      message: { subject: 'Anon test' },
      type: 'TEST',
    }));
  });

  await runTest('Security Rules: Staff retry guards reject SUCCESS, active PROCESSING, RECONCILIATION_REQUIRED, MAX_ATTEMPTS_EXCEEDED, and RETRY_NOT_DUE', async () => {
    const succId = 'mail_guard_success';
    const procId = 'mail_guard_processing';
    const reconId = 'mail_guard_reconcile';
    const maxAttId = 'mail_guard_max_attempts';
    const futureId = 'mail_guard_future_backoff';

    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, 'mail', succId), {
        id: succId,
        status: 'SUCCESS',
        to: ['borrower1@kku.ac.th'],
        message: { subject: 'Delivered' },
        type: 'TEST',
        attemptCount: 1,
        maxAttempts: 3,
        createdAt: serverTimestamp(),
        sentAt: serverTimestamp(),
      });
      await setDoc(doc(db, 'mail', procId), {
        id: procId,
        status: 'PROCESSING',
        to: ['borrower1@kku.ac.th'],
        message: { subject: 'In flight' },
        type: 'TEST',
        attemptCount: 1,
        maxAttempts: 3,
        claimedAt: serverTimestamp(),
        claimedBy: 'ANOTHER_WORKER',
        createdAt: serverTimestamp(),
      });
      await setDoc(doc(db, 'mail', reconId), {
        id: reconId,
        status: 'RECONCILIATION_REQUIRED',
        requiresReconciliation: true,
        to: ['borrower1@kku.ac.th'],
        message: { subject: 'Stale / Indeterminate' },
        type: 'TEST',
        attemptCount: 1,
        maxAttempts: 3,
        createdAt: serverTimestamp(),
      });
      await setDoc(doc(db, 'mail', maxAttId), {
        id: maxAttId,
        status: 'ERROR',
        to: ['borrower1@kku.ac.th'],
        message: { subject: 'Exceeded' },
        type: 'TEST',
        attemptCount: 3,
        maxAttempts: 3,
        createdAt: serverTimestamp(),
      });
      await setDoc(doc(db, 'mail', futureId), {
        id: futureId,
        status: 'ERROR',
        to: ['borrower1@kku.ac.th'],
        message: { subject: 'Backoff not due' },
        type: 'TEST',
        attemptCount: 1,
        maxAttempts: 3,
        nextAttemptAt: Timestamp.fromMillis(Date.now() + 120000), // +2 min
        createdAt: serverTimestamp(),
      });
    });

    // 1. SUCCESS: retry rejected by Rules
    await assertFails(updateDoc(doc(custodianDb, 'mail', succId), {
      retryRequestedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }));

    // 2. Active PROCESSING: retry rejected by Rules
    await assertFails(updateDoc(doc(custodianDb, 'mail', procId), {
      retryRequestedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }));

    // 3. RECONCILIATION_REQUIRED: retry rejected by Rules
    await assertFails(updateDoc(doc(custodianDb, 'mail', reconId), {
      retryRequestedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }));

    // 4. MAX_ATTEMPTS_EXCEEDED: retry rejected by Rules
    await assertFails(updateDoc(doc(custodianDb, 'mail', maxAttId), {
      retryRequestedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }));

    // 5. Future backoff (nextAttemptAt > now): retry rejected by Rules
    await assertFails(updateDoc(doc(custodianDb, 'mail', futureId), {
      retryRequestedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }));
  });

  await runTest('Client Retry & Server Worker: retryEmailJob records signal safely; Worker atomically claims, executes, and delivers', async () => {
    const mailId = 'mail_retry_valid_execution';
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'mail', mailId), {
        id: mailId,
        status: 'ERROR',
        to: ['borrower1@kku.ac.th'],
        message: { subject: 'Valid Retry Test', text: 'Body' },
        type: 'TEST',
        attemptCount: 1,
        maxAttempts: 3,
        createdAt: serverTimestamp(),
      });
    });

    // 1. Staff calls client retryEmailJob
    const snap = await getDoc(doc(custodianDb, 'mail', mailId));
    const retryRes = await retryEmailJob(mailId, snap.data(), custodianDb);
    if (!retryRes.success) {
      throw new Error(`retryEmailJob failed: ${JSON.stringify(retryRes)}`);
    }

    // 2. Verify in Firestore: status was NOT forged (remains ERROR), retryRequestedAt is set
    const afterSnap = await getDoc(doc(custodianDb, 'mail', mailId));
    const data = afterSnap.data();
    if (data.status !== 'ERROR') {
      throw new Error(`Client should NOT change status, expected ERROR but got ${data.status}`);
    }
    if (!data.retryRequestedAt) {
      throw new Error('retryRequestedAt was not set');
    }

    // 3. Server Worker processes the retried job
    let dispatchCount = 0;
    const mockFetch = async () => {
      dispatchCount++;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ status: 'SUCCESS', messageId: 'msg_retried_001' }),
      };
    };

    const workerRes = await processSingleMailJob(mailId, {
      allowRetry: true,
      customMockFetch: mockFetch,
    });

    if (!workerRes.success || !workerRes.claimed) {
      throw new Error(`Worker failed to claim and process retried job: ${JSON.stringify(workerRes)}`);
    }
    if (dispatchCount !== 1) {
      throw new Error(`Expected exactly 1 email dispatch, got ${dispatchCount}`);
    }

    // 4. Verify terminal status in Firestore is SUCCESS with incremented attemptCount (2)
    let finalDoc;
    await testEnv.withSecurityRulesDisabled(async (context) => {
      finalDoc = (await getDoc(doc(context.firestore(), 'mail', mailId))).data();
    });
    if (finalDoc.status !== 'SUCCESS' || finalDoc.attemptCount !== 2 || finalDoc.messageId !== 'msg_retried_001') {
      throw new Error(`Expected SUCCESS with attemptCount 2, got: ${JSON.stringify(finalDoc)}`);
    }
  });

  await runTest('Client Sweep & Server Worker: batchProcessPendingQueue signals sweep; Worker claims and processes PENDING job', async () => {
    const mailId = 'mail_sweep_valid_job';
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'mail', mailId), {
        id: mailId,
        status: 'PENDING',
        to: ['borrower1@kku.ac.th'],
        message: { subject: 'Sweep Test', text: 'Body' },
        type: 'TEST',
        attemptCount: 0,
        maxAttempts: 3,
        createdAt: serverTimestamp(),
      });
    });

    // 1. Staff calls client batchProcessPendingQueue
    const sweepRes = await batchProcessPendingQueue(10, custodianDb);
    if (sweepRes.processed < 1) {
      throw new Error(`batchProcessPendingQueue expected >= 1 processed, got ${JSON.stringify(sweepRes)}`);
    }

    // 2. Verify sweepRequestedAt set on document
    const docSnap = await getDoc(doc(custodianDb, 'mail', mailId));
    if (!docSnap.data().sweepRequestedAt) {
      throw new Error('sweepRequestedAt was not set by batchProcessPendingQueue');
    }

    // 3. Worker sweeps queue and dispatches
    let sentCount = 0;
    const mockFetch = async () => {
      sentCount++;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ status: 'SUCCESS', messageId: 'msg_sweep_001' }),
      };
    };

    const runRes = await processMailQueueOnce({ customMockFetch: mockFetch });
    if (runRes.successCount < 1) {
      throw new Error(`processMailQueueOnce expected >= 1 success, got ${JSON.stringify(runRes)}`);
    }

    let finalDoc;
    await testEnv.withSecurityRulesDisabled(async (context) => {
      finalDoc = (await getDoc(doc(context.firestore(), 'mail', mailId))).data();
    });
    if (finalDoc.status !== 'SUCCESS') {
      throw new Error(`Expected SUCCESS after worker sweep, got: ${finalDoc.status}`);
    }
  });

  await runTest('Worker & Concurrency: Race condition between manual retry trigger and scheduled sweep (atomically claimed once)', async () => {
    const raceJobId = 'mail_race_retry_sweep';
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'mail', raceJobId), {
        id: raceJobId,
        status: 'ERROR',
        to: ['borrower1@kku.ac.th'],
        message: { subject: 'Race test' },
        type: 'TEST',
        attemptCount: 1,
        maxAttempts: 3,
        retryRequestedAt: serverTimestamp(),
        createdAt: serverTimestamp(),
      });
    });

    let dispatchCount = 0;
    const mockFetch = async () => {
      dispatchCount++;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ status: 'SUCCESS', messageId: 'msg_race_won' }),
      };
    };

    // Both attempt to process the exact same job concurrently
    const [res1, res2] = await Promise.all([
      processSingleMailJob(raceJobId, { allowRetry: true, customMockFetch: mockFetch }),
      processSingleMailJob(raceJobId, { allowRetry: true, customMockFetch: mockFetch }),
    ]);

    const claimedCount = (res1.claimed ? 1 : 0) + (res2.claimed ? 1 : 0);
    if (claimedCount !== 1) {
      throw new Error(`Expected exactly 1 claim, got ${claimedCount} (res1: ${JSON.stringify(res1)}, res2: ${JSON.stringify(res2)})`);
    }
    if (dispatchCount !== 1) {
      throw new Error(`Expected exactly 1 dispatch, got ${dispatchCount}`);
    }
  });

  // -------------------------------------------------------------
  // GROUP 34: Strict Equipment Availability Rules & Concurrency (MAINTENANCE, BORROWED, LOST)
  // -------------------------------------------------------------
  console.log('\n--- GROUP 34: Strict Equipment Availability Rules (MAINTENANCE, BORROWED, LOST) ---');

  await runTest('Layer 4 Rules: Client write creating borrow_request referencing MAINTENANCE equipment is DENIED', async () => {
    // Seed equipment as MAINTENANCE
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'equipments', 'EQ-MAINT-TEST-01'), {
        id: 'EQ-MAINT-TEST-01',
        name: 'Projector In Repair',
        assetNumber: '7440-099-0001/67',
        status: 'MAINTENANCE',
        isDeleted: false,
        activeBookings: [],
      });
    });

    const batch = writeBatch(borrower1Db);
    const reqRef = doc(borrower1Db, 'borrow_requests', 'BR-EVIL-MAINT-01');
    const bookRef = doc(borrower1Db, 'equipment_bookings', 'BR-EVIL-MAINT-01');
    const eqRef = doc(borrower1Db, 'equipments', 'EQ-MAINT-TEST-01');

    batch.set(reqRef, {
      id: 'BR-EVIL-MAINT-01',
      status: 'PENDING_REVIEW',
      borrower: { email: 'borrower1@kku.ac.th', name: 'สมชาย' },
      equipment: { equipmentId: 'EQ-MAINT-TEST-01', name: 'Projector In Repair' },
      startDate: '2027-03-01',
      expectedReturnDate: '2027-03-05',
      durationDays: 5,
      timeline: [{ status: 'PENDING_REVIEW', actorEmail: 'borrower1@kku.ac.th', timestamp: new Date() }],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    batch.set(bookRef, {
      equipmentId: 'EQ-MAINT-TEST-01',
      startDate: '2027-03-01',
      expectedReturnDate: '2027-03-05',
      requestId: 'BR-EVIL-MAINT-01',
      status: 'ACTIVE',
      updatedAt: new Date(),
    });
    batch.update(eqRef, {
      lastBookingUpdatedAt: new Date(),
      activeBookings: [{ equipmentId: 'EQ-MAINT-TEST-01', startDate: '2027-03-01', expectedReturnDate: '2027-03-05', requestId: 'BR-EVIL-MAINT-01', status: 'ACTIVE' }],
    });

    // Must fail because EQ-MAINT-TEST-01 status is MAINTENANCE
    await assertFails(batch.commit());
  });

  await runTest('Layer 4 Rules: Client write creating borrow_request referencing BORROWED equipment is DENIED', async () => {
    // Seed equipment as BORROWED
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'equipments', 'EQ-BORROWED-TEST-01'), {
        id: 'EQ-BORROWED-TEST-01',
        name: 'Laptop Borrowed',
        assetNumber: '7440-099-0002/67',
        status: 'BORROWED',
        isDeleted: false,
        activeBookings: [],
      });
    });

    const batch = writeBatch(borrower1Db);
    const reqRef = doc(borrower1Db, 'borrow_requests', 'BR-EVIL-BORROW-01');
    const bookRef = doc(borrower1Db, 'equipment_bookings', 'BR-EVIL-BORROW-01');
    const eqRef = doc(borrower1Db, 'equipments', 'EQ-BORROWED-TEST-01');

    batch.set(reqRef, {
      id: 'BR-EVIL-BORROW-01',
      status: 'PENDING_REVIEW',
      borrower: { email: 'borrower1@kku.ac.th', name: 'สมชาย' },
      equipment: { equipmentId: 'EQ-BORROWED-TEST-01', name: 'Laptop Borrowed' },
      startDate: '2027-04-01',
      expectedReturnDate: '2027-04-05',
      durationDays: 5,
      timeline: [{ status: 'PENDING_REVIEW', actorEmail: 'borrower1@kku.ac.th', timestamp: new Date() }],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    batch.set(bookRef, {
      equipmentId: 'EQ-BORROWED-TEST-01',
      startDate: '2027-04-01',
      expectedReturnDate: '2027-04-05',
      requestId: 'BR-EVIL-BORROW-01',
      status: 'ACTIVE',
      updatedAt: new Date(),
    });
    batch.update(eqRef, {
      lastBookingUpdatedAt: new Date(),
      activeBookings: [{ equipmentId: 'EQ-BORROWED-TEST-01', startDate: '2027-04-01', expectedReturnDate: '2027-04-05', requestId: 'BR-EVIL-BORROW-01', status: 'ACTIVE' }],
    });

    // Must fail because EQ-BORROWED-TEST-01 status is BORROWED
    await assertFails(batch.commit());
  });

  await runTest('Layer 4 Rules: Handover of equipment in MAINTENANCE state is DENIED by security rules', async () => {
    // Seed request approved waiting pickup, but equipment was marked MAINTENANCE
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'equipments', 'EQ-HANDOVER-BROKEN-01'), {
        id: 'EQ-HANDOVER-BROKEN-01',
        name: 'Damaged Cam',
        status: 'MAINTENANCE',
        isDeleted: false,
      });
      await setDoc(doc(context.firestore(), 'borrow_requests', 'BR-HANDOVER-BROKEN-01'), {
        id: 'BR-HANDOVER-BROKEN-01',
        status: 'APPROVED_WAITING_PICKUP',
        borrower: { email: 'borrower1@kku.ac.th', name: 'สมชาย' },
        equipment: { equipmentId: 'EQ-HANDOVER-BROKEN-01', name: 'Damaged Cam' },
        startDate: '2027-05-01',
        expectedReturnDate: '2027-05-05',
        timeline: [{ status: 'APPROVED_WAITING_PICKUP', actorEmail: 'approver@kku.ac.th', timestamp: new Date() }],
      });
    });

    // Custodian attempts handover
    await assertFails(
      updateDoc(doc(custodianDb, 'borrow_requests', 'BR-HANDOVER-BROKEN-01'), {
        status: 'IN_USE',
        handover: {
          custodianEmail: 'chalpr@kku.ac.th',
          custodianName: 'นายชาลี',
          handoverDate: '2027-05-01',
          accessories: [],
          conditionNote: 'ตรวจพบชำรุด',
          handedAt: new Date(),
        },
        timeline: [
          { status: 'APPROVED_WAITING_PICKUP', actorEmail: 'approver@kku.ac.th', timestamp: new Date() },
          { status: 'IN_USE', actorEmail: 'chalpr@kku.ac.th', timestamp: new Date() },
        ],
        updatedAt: new Date(),
      })
    );
  });

  // Clean up
  // -------------------------------------------------------------
  await testEnv.cleanup();

  console.log('\n====================================================');
  console.log(`EMULATOR & WORKER TEST RESULTS: ${passedCount} passed, ${failedCount} failed`);
  console.log('====================================================\n');

  if (failedCount > 0) {
    process.exit(1);
  }
}

runAllTests().catch((err) => {
  console.error('Fatal test execution error:', err);
  process.exit(1);
});

