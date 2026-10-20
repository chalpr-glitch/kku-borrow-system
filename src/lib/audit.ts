import { addDoc, collection, serverTimestamp } from 'firebase/firestore';
import { fb } from './firebase.ts';
import type { AppUser } from './types.ts';

export interface AuditLogEntry {
  action: string;
  target: string;
  details: string;
  actor: string;
  actorName: string;
  actorEmail: string;
  timestamp?: any;
}

let mockAuditHandler: ((entry: any) => Promise<void> | void) | null = null;

export function setMockAuditHandler(handler: ((entry: any) => Promise<void> | void) | null) {
  mockAuditHandler = handler;
}

export async function logAudit(
  action: string,
  target: string,
  details: string,
  actor: AppUser | { email: string; name: string },
  customDb?: any
) {
  if (mockAuditHandler) {
    try {
      await mockAuditHandler({ action, target, details, actor });
    } catch {
      // ignore
    }
    return;
  }
  try {
    const db = customDb || fb().db;
    await addDoc(collection(db, 'audit_logs'), {
      action: action || '',
      target: target || '',
      details: details || '',
      actor: (actor.email || '').toLowerCase(),
      actorName: actor.name || actor.email || '',
      actorEmail: (actor.email || '').toLowerCase(),
      timestamp: serverTimestamp(),
    });
  } catch (err) {
    // Background audit log should not break main flow
  }
}

