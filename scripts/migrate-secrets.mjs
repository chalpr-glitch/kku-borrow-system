/**
 * KKU OAS Borrowing System - Secrets Migration & Sanitization Tool
 *
 * Operational Safety & Security Invariants:
 *  - Defaults to DRY-RUN mode (read-only inspection).
 *  - STRICT ALLOWLIST ONLY: Never uses object spread ({ ...policyData } or { ...backupData })
 *    when constructing system_settings/policy. Only keys in EXACT_POLICY_ALLOWED_KEYS with
 *    validated primitive types are ever written to system_settings/policy.
 *  - DEFAULT-DENY FOR UNKNOWN & NESTED FIELDS: Any key outside EXACT_POLICY_ALLOWED_KEYS or
 *    any nested object/array/non-primitive value is flagged as dirty and stripped on write.
 *  - IDEMPOTENCE ONLY AFTER CLEAN VERIFICATION: Neither migration nor rollback may early-return
 *    until proving the existing policy document has zero secret, unknown, or nested/invalid fields.
 *  - TRANSACTIONAL CONSISTENCY: Reads both policy, gateway_config, and backup inside
 *    db.runTransaction() to prevent TOCTOU and concurrent write races.
 *  - FAIL-CLOSED ROLLBACK: Rollback restores only validated ALLOWED_POLICY_FIELDS to policy,
 *    never restores secrets to policy, and NEVER automatically overwrites or backfills
 *    gateway_config from backup (manual gateway recovery requires explicit separate invocation).
 *  - ZERO SECRET DISCLOSURE: Never logs or prints secret values (logs only field names and
 *    [PRESENT] / [ABSENT] status).
 *  - CLI EXIT CODE: Exits with non-zero code (1) whenever an operation fails or throws.
 */

import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

export const SECRET_FIELDS = [
  'gasWebhookUrl',
  'brevoApiKey',
  'resendApiKey',
  'brevoSenderEmail',
  'brevoSenderName',
  'resendSender',
];

/**
 * Strict allowlist of business policy fields permitted in system_settings/policy.
 * Synchronized with firestore.rules, src/app/admin/settings/page.tsx, AppShell.tsx, and worker-core.mjs.
 */
export const ALLOWED_POLICY_FIELDS = [
  'maxBorrowDays',
  'advanceReminderDays',
  'enableTwoStepApproval',
  'enableTestMode',
  'enableEmailNotifications',
  'guidelines',
  'custodianEmail',
  'approverEmail',
  'emailProvider',
];

/**
 * Strict allowlist of system metadata fields permitted in system_settings/policy.
 */
export const ALLOWED_POLICY_METADATA_FIELDS = [
  'updatedAt',
  'updatedBy',
  'sanitizedAt',
  'sanitizedBy',
  'rolledBackAt',
  'rolledBackBy',
  'rolledBackFromBackup',
];

export const EXACT_POLICY_ALLOWED_KEYS = [
  ...ALLOWED_POLICY_FIELDS,
  ...ALLOWED_POLICY_METADATA_FIELDS,
];

const VALID_EMAIL_PROVIDERS = ['NONE', 'GOOGLE_APPS_SCRIPT', 'BREVO', 'RESEND', 'MOCK'];

/**
 * Checks whether a value is a Firestore Timestamp-like object (and not a generic nested secret map).
 */
function isFirestoreTimestampLike(val) {
  if (!val || typeof val !== 'object' || Array.isArray(val)) return false;
  if (typeof val.toDate === 'function' || typeof val.toMillis === 'function') return true;
  const keys = Object.keys(val);
  return (
    keys.length === 2 &&
    ((keys.includes('seconds') && keys.includes('nanoseconds')) ||
      (keys.includes('_seconds') && keys.includes('_nanoseconds'))) &&
    typeof (val.seconds ?? val._seconds) === 'number' &&
    typeof (val.nanoseconds ?? val._nanoseconds) === 'number'
  );
}

/**
 * Validates that a key and value strictly conform to the primitive schema enforced by firestore.rules.
 * Rejects any unknown key, nested object/map, array, or out-of-range value.
 */
export function isValidPolicyFieldValue(key, val) {
  if (val === undefined || val === null) return false;
  // Default-deny any non-primitive object/array (except Timestamp on timestamp metadata fields)
  if (typeof val === 'object') {
    if (
      (key === 'updatedAt' || key === 'sanitizedAt' || key === 'rolledBackAt') &&
      isFirestoreTimestampLike(val)
    ) {
      return true;
    }
    return false;
  }

  switch (key) {
    case 'maxBorrowDays':
      return Number.isInteger(val) && val >= 1 && val <= 365;
    case 'advanceReminderDays':
      return Number.isInteger(val) && val >= 0 && val <= 60;
    case 'enableTwoStepApproval':
    case 'enableTestMode':
    case 'enableEmailNotifications':
    case 'rolledBackFromBackup':
      return typeof val === 'boolean';
    case 'guidelines':
      return typeof val === 'string' && val.length <= 5000;
    case 'custodianEmail':
    case 'approverEmail':
    case 'updatedBy':
    case 'sanitizedBy':
    case 'rolledBackBy':
      return typeof val === 'string' && val.length <= 320;
    case 'emailProvider':
      return typeof val === 'string' && VALID_EMAIL_PROVIDERS.includes(val);
    case 'updatedAt':
    case 'sanitizedAt':
    case 'rolledBackAt':
      return typeof val === 'string' && val.length <= 64;
    default:
      return false;
  }
}

/**
 * Deeply inspects a raw policy document against the strict allowlist schema.
 * Never returns or logs secret values—only field names and classification counts.
 */
export function analyzePolicyDocument(rawDoc) {
  const data = rawDoc && typeof rawDoc === 'object' ? rawDoc : {};
  const keys = Object.keys(data);

  const presentSecretFields = [];
  const unknownFields = [];
  const invalidOrNestedFields = [];
  const validAllowedFields = [];

  for (const field of SECRET_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(data, field) && data[field] !== undefined) {
      presentSecretFields.push(field);
    }
  }

  for (const key of keys) {
    if (SECRET_FIELDS.includes(key)) {
      continue;
    }
    if (!EXACT_POLICY_ALLOWED_KEYS.includes(key)) {
      unknownFields.push(key);
      if (data[key] !== null && typeof data[key] === 'object') {
        invalidOrNestedFields.push(key);
      }
      continue;
    }
    if (!isValidPolicyFieldValue(key, data[key])) {
      invalidOrNestedFields.push(key);
    } else {
      validAllowedFields.push(key);
    }
  }

  const hasDirtyFields =
    presentSecretFields.length > 0 ||
    unknownFields.length > 0 ||
    invalidOrNestedFields.length > 0;

  return {
    isClean: !hasDirtyFields,
    hasSecrets: presentSecretFields.length > 0,
    hasDirtyFields,
    presentSecretFields,
    unknownFields,
    invalidOrNestedFields,
    validAllowedFields,
  };
}

/**
 * Constructs a brand-new policy object exclusively from ALLOWED_POLICY_FIELDS and
 * ALLOWED_POLICY_METADATA_FIELDS with strict primitive type validation.
 * NEVER uses object spread on source documents.
 */
export function buildAllowlistedPolicyDocument(
  primarySource = {},
  fallbackSource = {},
  metadataOverrides = {}
) {
  const cleanPolicy = {};

  for (const field of ALLOWED_POLICY_FIELDS) {
    if (isValidPolicyFieldValue(field, primarySource?.[field])) {
      cleanPolicy[field] = primarySource[field];
    } else if (isValidPolicyFieldValue(field, fallbackSource?.[field])) {
      cleanPolicy[field] = fallbackSource[field];
    }
  }

  for (const metaField of ALLOWED_POLICY_METADATA_FIELDS) {
    if (isValidPolicyFieldValue(metaField, metadataOverrides?.[metaField])) {
      cleanPolicy[metaField] = metadataOverrides[metaField];
    } else if (
      !Object.prototype.hasOwnProperty.call(metadataOverrides, metaField) &&
      isValidPolicyFieldValue(metaField, primarySource?.[metaField])
    ) {
      cleanPolicy[metaField] = primarySource[metaField];
    }
  }

  return cleanPolicy;
}

/**
 * Initialize Admin SDK safely without hardcoding localhost emulator into production.
 */
export function getMigrationDb(customDb = null) {
  if (customDb) return customDb;
  if (!getApps().length) {
    const projectId =
      process.env.FIREBASE_PROJECT_ID ||
      process.env.GCLOUD_PROJECT ||
      process.env.GOOGLE_CLOUD_PROJECT ||
      (process.env.FIRESTORE_EMULATOR_HOST ? 'demo-kku-oas-test' : 'borrowoas');
    initializeApp({ projectId });
  }
  return getFirestore();
}

/**
 * Inspects system_settings/policy for known secret fields, unknown fields, and nested/invalid fields
 * without revealing any field values.
 */
export async function inspectPolicySecrets(customDb = null) {
  const db = getMigrationDb(customDb);
  const policyRef = db.collection('system_settings').doc('policy');
  const policyDoc = await policyRef.get();

  if (!policyDoc.exists) {
    return {
      exists: false,
      isClean: true,
      hasSecrets: false,
      hasDirtyFields: false,
      presentFields: [],
      absentFields: [...SECRET_FIELDS],
      unknownFields: [],
      invalidOrNestedFields: [],
    };
  }

  const data = policyDoc.data() || {};
  const analysis = analyzePolicyDocument(data);
  const absentFields = SECRET_FIELDS.filter((f) => !analysis.presentSecretFields.includes(f));

  return {
    exists: true,
    isClean: analysis.isClean,
    hasSecrets: analysis.hasDirtyFields,
    hasDirtyFields: analysis.hasDirtyFields,
    presentFields: analysis.presentSecretFields,
    absentFields,
    unknownFields: analysis.unknownFields,
    invalidOrNestedFields: analysis.invalidOrNestedFields,
    provider:
      typeof data.emailProvider === 'string' && VALID_EMAIL_PROVIDERS.includes(data.emailProvider)
        ? data.emailProvider
        : 'NONE',
  };
}

/**
 * Run Secrets Migration & Strict Allowlist Policy Sanitization
 * @param {Object} options
 * @param {boolean} options.execute - If false, runs dry-run inspection only.
 * @param {any} options.customDb - Optional Firestore instance.
 * @param {string} options.actorEmail - Email of administrator performing migration.
 * @param {Function} options._onBeforeCommit - Optional test hook for simulating concurrent edits inside transaction.
 */
export async function runSecretsMigration(options = {}) {
  const execute = Boolean(options.execute || process.argv.includes('--execute'));
  const db = getMigrationDb(options.customDb);
  const actor = options.actorEmail || 'admin-cli@kku.ac.th';

  console.log('====================================================');
  console.log(`🔒 KKU OAS SECRETS MIGRATION & POLICY SANITIZATION`);
  console.log(`   Mode: ${execute ? 'EXECUTE (Atomic Commit)' : 'DRY-RUN (Read-Only Inspection)'}`);
  console.log('====================================================');

  if (!execute) {
    const inspection = await inspectPolicySecrets(db);

    if (!inspection.exists) {
      console.log('ℹ️  system_settings/policy does not exist. Nothing to migrate.');
      return {
        success: true,
        status: 'NO_POLICY',
        hasSecrets: false,
        executed: false,
        purged: false,
      };
    }

    console.log(`Status of secret fields in system_settings/policy:`);
    for (const field of SECRET_FIELDS) {
      const isPresent = inspection.presentFields.includes(field);
      console.log(`  - ${field.padEnd(20)}: ${isPresent ? '⚠️  [PRESENT]' : '✅ [ABSENT]'}`);
    }
    if (inspection.unknownFields.length > 0) {
      console.log(`  - Unknown fields      : ⚠️  [${inspection.unknownFields.join(', ')}]`);
    }
    if (inspection.invalidOrNestedFields.length > 0) {
      console.log(
        `  - Invalid/Nested types: ⚠️  [${inspection.invalidOrNestedFields.join(', ')}]`
      );
    }

    if (inspection.isClean) {
      console.log('\n✅ system_settings/policy is already sanitized and strictly matches allowlist.');
      return {
        success: true,
        status: 'ALREADY_SANITIZED',
        hasSecrets: false,
        executed: false,
        purged: true,
      };
    }

    console.log('\n[DRY-RUN COMPLETE] Non-compliant or secret fields were detected.');
    console.log('To execute atomic migration, run with --execute.');
    console.log('Notice: Secrets were NOT modified and values were NOT printed.');
    return {
      success: true,
      status: 'DRY_RUN_SECRETS_FOUND',
      hasSecrets: true,
      presentFields: inspection.presentFields,
      unknownFields: inspection.unknownFields,
      invalidOrNestedFields: inspection.invalidOrNestedFields,
      executed: false,
      purged: false,
    };
  }

  // --- ATOMIC EXECUTION VIA TRANSACTION (Reads & Writes Inside Transaction) ---
  console.log('\n⏳ Executing atomic migration transaction...');
  const policyRef = db.collection('system_settings').doc('policy');
  const gatewayRef = db.collection('system_settings').doc('gateway_config');
  const backupRef = db.collection('system_settings').doc('policy_backup_before_migrate');
  const auditRef = db.collection('audit_logs');

  let txOutcome = null;

  await db.runTransaction(async (transaction) => {
    const policySnap = await transaction.get(policyRef);
    if (!policySnap.exists) {
      txOutcome = {
        success: true,
        status: 'NO_POLICY',
        hasSecrets: false,
        executed: false,
        purged: false,
      };
      return;
    }

    const policyData = policySnap.data() || {};
    const gatewaySnap = await transaction.get(gatewayRef);
    const gatewayData = gatewaySnap.exists ? gatewaySnap.data() || {} : {};
    const backupSnap = await transaction.get(backupRef);

    if (typeof options._onBeforeCommit === 'function') {
      await options._onBeforeCommit();
    }

    const analysis = analyzePolicyDocument(policyData);

    // Check idempotence ONLY AFTER verifying the document is 100% clean (no secret, unknown, or nested fields)
    if (analysis.isClean) {
      txOutcome = {
        success: true,
        status: 'ALREADY_SANITIZED',
        hasSecrets: false,
        executed: false,
        purged: true,
      };
      return;
    }

    const nowIso = new Date().toISOString();

    // 1. Create Server-Only Pre-Migration Backup (if backup does not already exist, or preserve initial snapshot)
    if (!backupSnap.exists) {
      transaction.set(backupRef, {
        ...policyData,
        _backupTimestamp: nowIso,
        _backupActor: actor,
        _backupReason: 'PRE_MIGRATION_SANITIZATION_BACKUP',
      });
    }

    // 2. Merge Valid String Credentials from policy into gateway_config without overwriting newer keys unless empty
    const gatewayUpdate = {
      ...gatewayData,
      updatedAt: nowIso,
      updatedBy: actor,
      migratedFromPolicyAt: nowIso,
    };

    if (
      typeof policyData.emailProvider === 'string' &&
      VALID_EMAIL_PROVIDERS.includes(policyData.emailProvider) &&
      policyData.emailProvider !== 'NONE' &&
      (!gatewayUpdate.provider || gatewayUpdate.provider === 'NONE')
    ) {
      gatewayUpdate.provider = policyData.emailProvider;
      gatewayUpdate.emailProvider = policyData.emailProvider;
    }

    for (const secretField of SECRET_FIELDS) {
      const val = policyData[secretField];
      if (typeof val === 'string' && val.trim() !== '') {
        if (!gatewayData[secretField] || String(gatewayData[secretField]).trim() === '') {
          gatewayUpdate[secretField] = val.trim();
        }
      }
    }

    transaction.set(gatewayRef, gatewayUpdate, { merge: true });

    // 3. Construct Sanitized Policy STRICTLY from Allowlist (ZERO Object Spread of policyData!)
    const sanitizedPolicy = buildAllowlistedPolicyDocument(policyData, {}, {
      updatedAt: nowIso,
      sanitizedAt: nowIso,
      sanitizedBy: actor,
    });

    // Full document replacement (no merge: true) wipes all secret, unknown, and nested fields atomically
    transaction.set(policyRef, sanitizedPolicy);

    // 4. Record Audit Log (field names only, never secret values)
    const removedSummary = [
      ...analysis.presentSecretFields,
      ...analysis.unknownFields,
      ...analysis.invalidOrNestedFields,
    ];
    const uniqueRemoved = Array.from(new Set(removedSummary));

    transaction.set(auditRef.doc(), {
      action: 'MIGRATE_SECRETS_PURGE_POLICY',
      targetId: 'system_settings/policy',
      details: `Sanitized policy via strict allowlist. Removed fields: [${uniqueRemoved.join(', ')}]`,
      removedSecretFieldsCount: analysis.presentSecretFields.length,
      removedUnknownFieldsCount: analysis.unknownFields.length,
      removedInvalidOrNestedCount: analysis.invalidOrNestedFields.length,
      actorEmail: actor,
      actorRole: 'SYSTEM_ADMIN_CLI',
      timestamp: nowIso,
    });

    txOutcome = {
      success: true,
      status: 'MIGRATED_AND_PURGED',
      hasSecrets: false,
      migratedFields: analysis.presentSecretFields,
      removedUnknownFields: analysis.unknownFields,
      removedInvalidOrNestedFields: analysis.invalidOrNestedFields,
      executed: true,
      purged: true,
    };
  });

  if (txOutcome.status === 'ALREADY_SANITIZED') {
    console.log('\n✅ system_settings/policy is already sanitized. No changes needed.');
    return txOutcome;
  }
  if (txOutcome.status === 'NO_POLICY') {
    console.log('ℹ️  system_settings/policy does not exist. Nothing to migrate.');
    return txOutcome;
  }

  console.log('✅ Atomic transaction committed successfully:');
  console.log('   1. Pre-migration backup stored at server-only: system_settings/policy_backup_before_migrate');
  console.log('   2. Secrets merged into server-only: system_settings/gateway_config');
  console.log('   3. Policy rebuilt strictly from allowlist: system_settings/policy');
  console.log('   4. Audit event recorded in: audit_logs');
  console.log('\n🔑 [KEY ROTATION ADVISORY]');
  console.log('   Because legacy policy secrets may have previously been readable by staff,');
  console.log('   it is strongly recommended to rotate / regenerate all gateway credentials:');
  console.log('   - Google Apps Script: Redeploy Web App as new version / new URL');
  console.log('   - Brevo: Revoke old API key and generate a fresh key');
  console.log('   - Resend: Revoke old API key and generate a fresh key');

  return txOutcome;
}

/**
 * Emergency Fail-Closed Rollback Function
 *
 * Security Invariants:
 *  - NEVER uses object spread ({ ...policyData } or { ...backupData }).
 *  - NEVER writes SECRET_FIELDS, unknown fields, or nested objects to system_settings/policy.
 *  - Constructs system_settings/policy strictly from ALLOWED_POLICY_FIELDS + clean metadata.
 *  - NEVER automatically restores or copies old credentials from backup into gateway_config
 *    (even if gateway_config is empty). Credential recovery is strictly separated into
 *    manualRecoverGatewayFromBackup() requiring explicit administrative approval.
 *  - Reads both backup and policy INSIDE db.runTransaction() to prevent concurrency race conditions.
 *  - Checks idempotence ONLY AFTER verifying the current policy document is 100% clean
 *    (if rolledBackFromBackup === true and business fields match, but a secret or unknown field
 *    still exists in policy, rollback DOES NOT early-return—it overwrites and purges the dirty field!).
 */
export async function rollbackSecretsMigration(options = {}) {
  const execute = Boolean(options.execute || process.argv.includes('--rollback-execute'));
  const db = getMigrationDb(options.customDb);
  const actor = options.actorEmail || 'admin-cli@kku.ac.th';

  console.log('====================================================');
  console.log(`⚠️  KKU OAS SECRETS MIGRATION FAIL-CLOSED ROLLBACK TOOL`);
  console.log(`   Mode: ${execute ? 'EXECUTE ROLLBACK' : 'DRY-RUN INSPECTION'}`);
  console.log('====================================================');

  const backupRef = db.collection('system_settings').doc('policy_backup_before_migrate');
  const policyRef = db.collection('system_settings').doc('policy');
  const auditRef = db.collection('audit_logs');

  if (!execute) {
    const [backupSnap, policySnap] = await Promise.all([backupRef.get(), policyRef.get()]);

    if (!backupSnap.exists) {
      console.log('❌ No backup document found at system_settings/policy_backup_before_migrate.');
      return { success: false, reason: 'NO_BACKUP', executed: false };
    }

    const backupData = backupSnap.data() || {};
    const backupAnalysis = analyzePolicyDocument(backupData);
    const policyData = policySnap.exists ? policySnap.data() || {} : {};
    const policyAnalysis = analyzePolicyDocument(policyData);

    const nonSecretKeysToRestore = ALLOWED_POLICY_FIELDS.filter((field) =>
      isValidPolicyFieldValue(field, backupData[field])
    );

    console.log(`Backup document inspection:`);
    console.log(
      `  - Valid allowlisted policy fields to restore: [${nonSecretKeysToRestore.join(', ')}]`
    );
    console.log(
      `  - Secret fields blocked from policy         : ${
        backupAnalysis.presentSecretFields.length > 0
          ? `⚠️  [${backupAnalysis.presentSecretFields.join(', ')}]`
          : '✅ None'
      }`
    );
    if (backupAnalysis.unknownFields.length > 0) {
      console.log(
        `  - Unknown fields blocked from policy        : ⚠️  [${backupAnalysis.unknownFields.join(', ')}]`
      );
    }
    if (backupAnalysis.invalidOrNestedFields.length > 0) {
      console.log(
        `  - Nested/invalid fields blocked from policy : ⚠️  [${backupAnalysis.invalidOrNestedFields.join(', ')}]`
      );
    }

    console.log('\n[DRY-RUN COMPLETE] Rollback inspection finished.');
    console.log(
      'Notice: No changes were written. Secrets, unknown fields, and nested objects are NEVER written to policy, and gateway_config is untouched.'
    );
    return {
      success: true,
      dryRun: true,
      executed: false,
      eligibleFields: nonSecretKeysToRestore,
      blockedSecretFields: backupAnalysis.presentSecretFields,
      blockedUnknownFields: backupAnalysis.unknownFields,
      blockedNestedOrInvalidFields: backupAnalysis.invalidOrNestedFields,
      currentPolicyIsClean: policyAnalysis.isClean,
    };
  }

  let txResult = null;

  await db.runTransaction(async (transaction) => {
    // Read BOTH backup and policy inside transaction for full isolation
    const backupSnap = await transaction.get(backupRef);
    if (!backupSnap.exists) {
      txResult = { success: false, reason: 'NO_BACKUP', executed: false };
      return;
    }

    const policySnap = await transaction.get(policyRef);
    const backupData = backupSnap.data() || {};
    const policyData = policySnap.exists ? policySnap.data() || {} : {};

    if (typeof options._onBeforeCommit === 'function') {
      await options._onBeforeCommit();
    }

    const backupAnalysis = analyzePolicyDocument(backupData);
    const policyAnalysis = analyzePolicyDocument(policyData);

    const nonSecretKeysToRestore = ALLOWED_POLICY_FIELDS.filter((field) =>
      isValidPolicyFieldValue(field, backupData[field])
    );

    const nowIso = new Date().toISOString();

    // Build target policy strictly from allowlist (ZERO spread of backupData or policyData)
    const targetCleanPolicy = buildAllowlistedPolicyDocument(backupData, policyData, {
      updatedAt: nowIso,
      rolledBackAt: nowIso,
      rolledBackBy: actor,
      rolledBackFromBackup: true,
    });

    // Check idempotence ONLY AFTER proving current policy document is 100% clean
    // (free of secret, unknown, and nested/invalid fields) AND already marked rolledBackFromBackup
    const allAllowedFieldsMatch = ALLOWED_POLICY_FIELDS.every(
      (k) => policyData[k] === targetCleanPolicy[k]
    );

    if (
      policySnap.exists &&
      policyAnalysis.isClean &&
      policyData.rolledBackFromBackup === true &&
      allAllowedFieldsMatch
    ) {
      txResult = {
        success: true,
        executed: false,
        alreadyRolledBack: true,
        restoredFields: nonSecretKeysToRestore,
        secretsInPolicyCount: 0,
      };
      return;
    }

    // Overwrite system_settings/policy with pure allowlisted object (wipes any dirty/unknown/nested fields)
    transaction.set(policyRef, targetCleanPolicy);

    // NOTE: gateway_config is intentionally NEVER touched or backfilled during rollback.
    // Old backup credentials must not automatically re-enter gateway_config.

    const blockedTotal =
      backupAnalysis.presentSecretFields.length +
      backupAnalysis.unknownFields.length +
      backupAnalysis.invalidOrNestedFields.length;

    const purgedFromCurrentPolicy = [
      ...policyAnalysis.presentSecretFields,
      ...policyAnalysis.unknownFields,
      ...policyAnalysis.invalidOrNestedFields,
    ];

    transaction.set(auditRef.doc(), {
      action: 'FAIL_CLOSED_ROLLBACK_SECRETS_MIGRATION',
      targetId: 'system_settings/policy',
      details: `Restored allowlisted policy fields (${nonSecretKeysToRestore.join(', ')}). Blocked ${blockedTotal} non-allowlisted/secret fields in backup and purged ${purgedFromCurrentPolicy.length} dirty fields from current policy. gateway_config left untouched.`,
      secretsRestoredToPolicyCount: 0,
      gatewayConfigModified: false,
      actorEmail: actor,
      actorRole: 'SYSTEM_ADMIN_CLI',
      timestamp: nowIso,
    });

    txResult = {
      success: true,
      executed: true,
      restoredFields: nonSecretKeysToRestore,
      blockedSecretFields: backupAnalysis.presentSecretFields,
      blockedUnknownFields: backupAnalysis.unknownFields,
      blockedNestedOrInvalidFields: backupAnalysis.invalidOrNestedFields,
      purgedFromPolicyFields: Array.from(new Set(purgedFromCurrentPolicy)),
      secretsInPolicyCount: 0,
      gatewayConfigModified: false,
    };
  });

  if (!txResult || txResult.success === false) {
    console.log(
      `❌ Fail-closed rollback failed: ${txResult?.reason || 'UNKNOWN_ERROR'}`
    );
    return txResult || { success: false, reason: 'UNKNOWN_ERROR', executed: false };
  }

  if (txResult.alreadyRolledBack) {
    console.log(
      'ℹ️  system_settings/policy is already clean and in the restored state. No changes made (idempotent).'
    );
    return txResult;
  }

  console.log('✅ Fail-closed rollback completed:');
  console.log(`   1. Strictly allowlisted policy fields restored to: system_settings/policy`);
  console.log(`   2. Secrets / unknown / nested fields in policy: EXACTLY 0`);
  console.log(`   3. Server-only gateway_config: UNTOUCHED (no automatic credential backfill)`);
  console.log(`   4. Audit event recorded in: audit_logs`);

  return txResult;
}

/**
 * Explicit Manual Gateway Credential Recovery Tool (Separate from Rollback)
 *
 * Requires explicit approval (`approveManualRecovery: true` or `--approve-manual-gateway-recovery`).
 * Never writes to system_settings/policy. Only restores valid string SECRET_FIELDS to
 * system_settings/gateway_config, and refuses to overwrite existing non-empty credentials unless
 * `forceOverwrite: true` is also explicitly specified.
 */
export async function manualRecoverGatewayFromBackup(options = {}) {
  const approved = Boolean(
    options.approveManualRecovery ||
      process.argv.includes('--approve-manual-gateway-recovery')
  );
  const forceOverwrite = Boolean(
    options.forceOverwrite || process.argv.includes('--force-overwrite-gateway')
  );
  const db = getMigrationDb(options.customDb);
  const actor = options.actorEmail || 'admin-cli@kku.ac.th';

  if (!approved) {
    return {
      success: false,
      reason: 'MANUAL_APPROVAL_REQUIRED',
      executed: false,
    };
  }

  const backupRef = db.collection('system_settings').doc('policy_backup_before_migrate');
  const gatewayRef = db.collection('system_settings').doc('gateway_config');
  const auditRef = db.collection('audit_logs');

  let outcome = null;

  await db.runTransaction(async (transaction) => {
    const backupSnap = await transaction.get(backupRef);
    if (!backupSnap.exists) {
      outcome = { success: false, reason: 'NO_BACKUP', executed: false };
      return;
    }

    const gatewaySnap = await transaction.get(gatewayRef);
    const backupData = backupSnap.data() || {};
    const gatewayData = gatewaySnap.exists ? gatewaySnap.data() || {} : {};

    const nowIso = new Date().toISOString();
    const recoveredFields = [];
    const skippedExistingFields = [];
    const gatewayUpdate = {
      ...gatewayData,
      updatedAt: nowIso,
      updatedBy: actor,
      manuallyRecoveredAt: nowIso,
    };

    for (const secretField of SECRET_FIELDS) {
      const backupVal = backupData[secretField];
      if (typeof backupVal === 'string' && backupVal.trim() !== '') {
        const hasExisting =
          typeof gatewayData[secretField] === 'string' &&
          gatewayData[secretField].trim() !== '';
        if (!hasExisting || forceOverwrite) {
          gatewayUpdate[secretField] = backupVal.trim();
          recoveredFields.push(secretField);
        } else {
          skippedExistingFields.push(secretField);
        }
      }
    }

    if (recoveredFields.length === 0) {
      outcome = {
        success: true,
        executed: false,
        recoveredFields: [],
        skippedExistingFields,
      };
      return;
    }

    transaction.set(gatewayRef, gatewayUpdate, { merge: true });
    transaction.set(auditRef.doc(), {
      action: 'MANUAL_RECOVER_GATEWAY_FROM_BACKUP',
      targetId: 'system_settings/gateway_config',
      details: `Manually recovered gateway fields (${recoveredFields.join(', ')}) to server-only gateway_config. Skipped existing: (${skippedExistingFields.join(', ')}).`,
      actorEmail: actor,
      actorRole: 'SYSTEM_ADMIN_CLI',
      timestamp: nowIso,
    });

    outcome = {
      success: true,
      executed: true,
      recoveredFields,
      skippedExistingFields,
    };
  });

  return outcome;
}

// CLI entry point with strict non-zero exit code on any failure
if (process.argv[1] && process.argv[1].endsWith('migrate-secrets.mjs')) {
  const isRollback =
    process.argv.includes('--rollback') || process.argv.includes('--rollback-execute');
  const isManualGatewayRecovery = process.argv.includes('--manual-recover-gateway');
  const runner = isManualGatewayRecovery
    ? manualRecoverGatewayFromBackup
    : isRollback
      ? rollbackSecretsMigration
      : runSecretsMigration;

  runner()
    .then((result) => {
      if (!result || result.success === false) {
        process.exitCode = 1;
      }
    })
    .catch((e) => {
      console.error('Migration/Rollback CLI error:', e?.message || 'Unknown error');
      process.exitCode = 1;
    });
}
