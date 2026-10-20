import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  runTransaction,
  serverTimestamp,
  Timestamp,
  updateDoc,
  where,
  type Transaction,
} from 'firebase/firestore';
import { fb } from './firebase.ts';
import type {
  AppUser,
  BorrowRequest,
  DamageReport,
  Equipment,
  EquipmentBooking,
  ExtensionHistoryEntry,
  ExtensionRequest,
  LostReport,
  RequestStatus,
  ReturnCondition,
  ReviewChecklist,
  SatisfactionSurvey,
  SurveyFollowUpStatus,
  TimelineEntry,
} from './types.ts';
import {
  CANCELLABLE_STATUSES,
  MAX_BORROW_DAYS,
  MAX_TOTAL_DAYS,
  STATUS_META,
  daysInclusive,
  findConflicts,
  findBookingConflicts,
  fmtDate,
  todayStr,
  isEquipmentAvailable,
  validateEquipmentAvailability,
} from './utils.ts';
import {
  notifyNewBorrowRequest,
  notifyReviewPassed,
  notifyReviewRejected,
  notifyApprovalResult,
  notifyHandedOver,
  notifyCancelled,
  notifyReturned,
  notifyReturnedWithCsat,
  notifyRetroactiveCsatInvite,
  notifyExtensionRequested,
  notifyExtensionReviewPassed,
  notifyExtensionApproved,
  notifyExtensionRejected,
  computeMailJobDocId,
  buildRetroactiveCsatEmail,
  validateAndSanitizeMailJob,
  dispatchMailJobDirect,
  type MailJob,
} from './notifications.ts';
import { logAudit } from './audit.ts';

function entry(status: RequestStatus, me: AppUser, note?: string): TimelineEntry {
  const e: TimelineEntry = { status, at: Timestamp.now(), by: me.email, byName: me.name };
  if (note) e.note = note;
  return e;
}

/* ------------------------------------------------------------------ */
/* 1) ผู้ยืมยื่นคำขอ                                                     */
/* ------------------------------------------------------------------ */
export interface NewRequestInput {
  equipment: Equipment;
  startDate: string;
  expectedReturnDate: string;
  purpose: string;
  location: string;
  isException?: boolean;
  exceptionReason?: string;
}

export function validateDates(
  start: string,
  end: string,
  options?: { isException?: boolean; exceptionReason?: string; maxExceptionDays?: number }
): string | null {
  if (!start || !end) return 'กรุณาระบุวันที่ยืมและวันที่คืน';
  if (start < todayStr()) return 'ไม่สามารถเลือกวันที่ย้อนหลังได้';
  if (end < start) return 'วันที่คืนต้องไม่ก่อนวันที่ยืม';
  const d = daysInclusive(start, end);
  const maxLimit = options?.maxExceptionDays || MAX_TOTAL_DAYS;
  if (d > maxLimit) {
    return `ระยะเวลาการยืมรวมต้องไม่เกินเพดานสูงสุด ${maxLimit} วัน (ที่เลือก ${d} วัน)`;
  }
  if (d > MAX_BORROW_DAYS) {
    if (!options?.isException) {
      return `ระยะเวลาการยืมตามระเบียบปกติไม่เกิน ${MAX_BORROW_DAYS} วัน (ที่เลือก ${d} วัน) กรุณาเลือกขออนุมัติข้อยกเว้นเป็นกรณีพิเศษ`;
    }
    if (!options.exceptionReason?.trim()) {
      return 'กรุณาระบุเหตุผลและความจำเป็นในการขอยืมเกินระยะเวลาปกติ (15 วัน)';
    }
  }
  return null;
}

export async function createBorrowRequest(input: NewRequestInput, me: AppUser, customDb?: any): Promise<string> {
  const db = customDb || fb().db;
  const { equipment: eq, startDate, expectedReturnDate, isException, exceptionReason } = input;
  const invalid = validateDates(startDate, expectedReturnDate, {
    isException,
    exceptionReason,
  });
  const availability = validateEquipmentAvailability(eq);
  if (!availability.available) {
    throw new Error(availability.reason || 'ครุภัณฑ์ไม่พร้อมให้ยืม');
  }
  if (!input.purpose.trim()) throw new Error('กรุณาระบุวัตถุประสงค์');

  const totalDays = daysInclusive(startDate, expectedReturnDate);
  if (totalDays > MAX_TOTAL_DAYS) {
    throw new Error(`ระยะเวลาการยืมรวมต้องไม่เกินเพดานสูงสุด ${MAX_TOTAL_DAYS} วัน (ที่เลือก ${totalDays} วัน)`);
  }

  const ym = todayStr().slice(0, 7).replace('-', '');
  let newReqObject: BorrowRequest | null = null;

  const id = await runTransaction(db, async (tx) => {
    const eqRef = doc(db, 'equipments', eq.id);
    const eqSnap = await tx.get(eqRef);
    if (!eqSnap.exists()) throw new Error('ไม่พบข้อมูลครุภัณฑ์ในระบบ');
    const eqData = eqSnap.data() as Equipment;
    const freshAvailability = validateEquipmentAvailability(eqData);
    if (!freshAvailability.available) {
      throw new Error(freshAvailability.reason || 'ครุภัณฑ์ไม่พร้อมให้ยืม');
    }

    // ตรวจสอบคิวจองสดใหม่เสมอในทุก Transaction attempt / retry
    const snap = await getDocs(
      query(
        collection(db, 'equipment_bookings'),
        where('equipmentId', '==', eq.id),
        where('status', '==', 'ACTIVE')
      )
    );
    const bookings = snap.docs.map((d) => d.data() as EquipmentBooking);
    const conflicts = findBookingConflicts(bookings, eq.id, startDate, expectedReturnDate);
    if (conflicts.length > 0) {
      const c = conflicts[0];
      throw new Error(`CONCURRENCY_CONFLICT: ช่วงวันที่เลือก (${fmtDate(startDate)} ถึง ${fmtDate(expectedReturnDate)}) ซ้อนทับกับรายการจองที่มีอยู่แล้วของอุปกรณ์นี้ (${fmtDate(c.startDate)} ถึง ${fmtDate(c.expectedReturnDate)})`);
    }

    const counterRef = doc(db, 'counters', 'borrow_requests');
    const counter = await tx.get(counterRef);
    const seq = ((counter.exists() ? (counter.data()[ym] as number) : 0) ?? 0) + 1;
    const reqId = `BR-${ym}-${String(seq).padStart(4, '0')}`;
    tx.set(counterRef, { [ym]: seq }, { merge: true });

    const reqData = {
      id: reqId,
      status: 'PENDING_REVIEW' as RequestStatus,
      borrower: {
        email: me.email || '',
        name: me.name || '',
        employeeCode: me.employeeCode || '',
        position: me.position || '',
        division: me.division || '',
        mission: me.mission || '',
        departmentCode: me.departmentCode || '',
      },
      equipment: { equipmentId: eq.id, assetNumber: eq.assetNumber, name: eq.name },
      purpose: input.purpose.trim(),
      location: input.location.trim(),
      startDate,
      expectedReturnDate,
      originalExpectedReturnDate: expectedReturnDate,
      deadlineVersion: 1,
      durationDays: totalDays,
      isException: Boolean(isException),
      exceptionReason: exceptionReason?.trim() || null,
      extension: null,
      extensionHistory: [],
      review: null,
      approval: null,
      handover: null,
      returnInfo: null,
      cancel: null,
      termsAccepted: true,
      termsAcceptedAt: serverTimestamp(),
      timeline: [
        entry(
          'PENDING_REVIEW',
          me,
          isException
            ? `ยื่นคำขอยืม (ขอยกเว้นกรณีพิเศษ ${totalDays} วัน: ${exceptionReason})`
            : 'ยื่นคำขอยืม (ยอมรับเงื่อนไขความรับผิดชอบตามระเบียบพัสดุ พ.ศ. 2560)'
        ),
      ],
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };

    tx.set(doc(db, 'borrow_requests', reqId), reqData);

    const newBooking: EquipmentBooking = {
      equipmentId: eq.id,
      startDate,
      expectedReturnDate,
      requestId: reqId,
      status: 'ACTIVE',
    };
    tx.set(doc(db, 'equipment_bookings', reqId), {
      ...newBooking,
      updatedAt: serverTimestamp(),
    });

    const currentBookings: EquipmentBooking[] = ((eqData.activeBookings || []) as EquipmentBooking[]).filter(
      (b) => b.status === 'ACTIVE'
    );
    const nextBookings = [...currentBookings, newBooking];
    tx.update(eqRef, {
      activeBookings: nextBookings,
      lastBookingUpdatedAt: serverTimestamp(),
    });

    newReqObject = reqData as unknown as BorrowRequest;
    return reqId;
  });

  // บันทึก Audit Log และส่ง Email แจ้งเตือน (นายชาลี & ผู้ยืม)
  logAudit('CREATE_REQUEST', id, `ยื่นคำขอยืมครุภัณฑ์ ${eq.name} (${startDate} ถึง ${expectedReturnDate})`, me).catch(
    (e) => console.warn('Audit error:', e)
  );

  if (newReqObject) {
    notifyNewBorrowRequest(newReqObject, customDb).catch((e) => console.error('Email notify error:', e));
  }

  return id;
}

/* ------------------------------------------------------------------ */
/* Generic state transition (ตรวจสถานะปัจจุบันใน transaction)            */
/* ------------------------------------------------------------------ */
async function transition(
  id: string,
  from: RequestStatus[],
  to: RequestStatus,
  me: AppUser,
  patch: Record<string, unknown>,
  note?: string,
  extra?: (tx: Transaction, current: BorrowRequest, eqData?: Equipment) => void,
  customDb?: any,
) {
  const db = customDb || fb().db;
  const ref = doc(db, 'borrow_requests', id);
  await runTransaction(db, async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists()) throw new Error('ไม่พบคำขอ');
    const cur = { ...s.data(), id: s.id } as BorrowRequest;
    if (!from.includes(cur.status)) {
      throw new Error(`สถานะคำขอเปลี่ยนไปแล้ว (ปัจจุบัน: ${STATUS_META[cur.status].label})`);
    }

    const eqRef = doc(db, 'equipments', cur.equipment.equipmentId);
    const eqSnap = await tx.get(eqRef);
    const eqData = eqSnap.exists() ? (eqSnap.data() as Equipment) : undefined;

    extra?.(tx, cur, eqData);
    tx.update(ref, {
      ...patch,
      status: to,
      timeline: [...(cur.timeline ?? []), entry(to, me, note)],
      updatedAt: serverTimestamp(),
    });

    // อัปเดตสถานะในตารางการจอง equipment_bookings แบบ Atomic
    if (to === 'CANCELLED' || to === 'REVIEW_REJECTED') {
      tx.set(
        doc(db, 'equipment_bookings', id),
        { status: 'CANCELLED', updatedAt: serverTimestamp() },
        { merge: true }
      );
    } else if (['RETURNED', 'RETURNED_DAMAGED', 'LOST'].includes(to)) {
      tx.set(
        doc(db, 'equipment_bookings', id),
        { requestId: id, equipmentId: cur.equipment.equipmentId,
          startDate: cur.startDate, expectedReturnDate: cur.expectedReturnDate,
          status: 'RETURNED', updatedAt: serverTimestamp() },
        { merge: true }
      );
    }

    if (eqSnap.exists()) {
      if (to === 'CANCELLED' || to === 'REVIEW_REJECTED' || ['RETURNED', 'RETURNED_DAMAGED', 'LOST'].includes(to)) {
        const curBookings: EquipmentBooking[] = (eqSnap.data().activeBookings || []) as EquipmentBooking[];
        const nextBookings = curBookings.filter((b) => b.requestId !== id);
        tx.update(eqRef, {
          activeBookings: nextBookings,
          lastBookingUpdatedAt: serverTimestamp(),
        });
      } else {
        tx.update(eqRef, { lastBookingUpdatedAt: serverTimestamp() });
      }
    }
  });
}

/* 2) ผู้ยืมยกเลิก ------------------------------------------------------ */
export async function cancelRequest(r: BorrowRequest, me: AppUser, reason: string, customDb?: any) {
  if (r.borrower.email.toLowerCase() !== me.email.toLowerCase() && me.role !== 'CUSTODIAN') {
    throw new Error('ท่านไม่มีสิทธิ์ยกเลิกคำขอนี้ (เฉพาะผู้ยื่นคำขอหรือเจ้าหน้าที่ดูแลพัสดุ)');
  }
  await transition(
    r.id,
    CANCELLABLE_STATUSES,
    'CANCELLED',
    me,
    { cancel: { reason: reason || 'ผู้ยืมยกเลิกคำขอ', cancelledAt: serverTimestamp() } },
    reason || 'ผู้ยืมยกเลิกคำขอ',
    undefined,
    customDb
  );

  logAudit('CANCEL_REQUEST', r.id, `ยกเลิกคำขอ: ${reason || 'ผู้ยืมยกเลิก'}`, me).catch((e) =>
    console.warn('Audit error:', e)
  );
  notifyCancelled(r, me, reason, customDb).catch((e) => console.error('Email notify error:', e));
}

/* 3) นายชาลีตรวจสอบ (ขั้นที่ 1) ---------------------------------------- */
export interface ReviewInput {
  passed: boolean;
  checklist: ReviewChecklist;
  accessories: string[];
  reason?: string;
  comment?: string;
}

export async function reviewRequest(r: BorrowRequest, me: AppUser, input: ReviewInput, customDb?: any) {
  if (me.role !== 'CUSTODIAN' && me.role !== 'EXECUTIVE') {
    throw new Error('เฉพาะเจ้าหน้าที่ดูแลพัสดุ (CUSTODIAN) หรือผู้บริหาร เท่านั้นที่มีสิทธิ์ตรวจสอบคำขอในขั้นตอนนี้');
  }
  await transition(
    r.id,
    ['PENDING_REVIEW'],
    input.passed ? 'PENDING_APPROVAL' : 'REVIEW_REJECTED',
    me,
    {
      review: {
        reviewerEmail: me.email || '',
        reviewerName: me.name || me.email || '',
        result: input.passed ? 'PASSED' : 'FAILED',
        checklist: input.checklist,
        accessoriesToHandover: Array.isArray(input.accessories) ? input.accessories : [],
        reason: input.reason ?? '',
        comment: input.comment ?? '',
        reviewedAt: serverTimestamp(),
      },
    },
    input.passed
      ? `ตรวจสอบแล้ว ยืมได้ ส่งต่อผู้อนุมัติ${input.comment ? ` - ${input.comment}` : ''}`
      : `ยืมไม่ได้: ${input.reason ?? ''}${input.comment ? ` - ${input.comment}` : ''}`,
    undefined,
    customDb
  );

  logAudit(
    'REVIEW_REQUEST',
    r.id,
    input.passed ? 'ตรวจสอบผ่าน (ยืมได้)' : `ตรวจสอบไม่ผ่าน: ${input.reason || '-'}`,
    me
  ).catch((e) => console.warn('Audit error:', e));

  // ส่ง Email แจ้งเตือน (นายประหยัด หรือ ผู้ยื่น)
  if (input.passed) {
    notifyReviewPassed(r, customDb).catch((e) => console.error('Email notify error:', e));
  } else {
    notifyReviewRejected(r, input.reason, customDb).catch((e) => console.error('Email notify error:', e));
  }
}

/* 4) นายประหยัดอนุมัติ (ขั้นที่ 2) -------------------------------------- */
export async function approveRequest(r: BorrowRequest, me: AppUser, approved: boolean, comment: string, customDb?: any) {
  if (me.role !== 'APPROVER' && me.role !== 'EXECUTIVE') {
    throw new Error('เฉพาะผู้อนุมัติ (APPROVER) หรือผู้บริหาร เท่านั้นที่มีสิทธิ์พิจารณาอนุมัติคำขอในขั้นตอนนี้');
  }

  const db = customDb || fb().db;
  const ref = doc(db, 'borrow_requests', r.id);
  const eqRef = doc(db, 'equipments', r.equipment.equipmentId);
  const bookRef = doc(db, 'equipment_bookings', r.id);

  await runTransaction(db, async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists()) throw new Error('ไม่พบคำขอ');
    const cur = { ...s.data(), id: s.id } as BorrowRequest;
    
    // ผู้อนุมัติยืมเองได้และอนุมัติคำขอตนเองได้ แต่ต้องผ่านผู้ดูแลตรวจผ่านก่อนตามขั้นตอนปกติ (PENDING_APPROVAL และ review.result == 'PASSED')
    if (cur.status !== 'PENDING_APPROVAL' || !cur.review || cur.review.result !== 'PASSED') {
      throw new Error('คำขอนี้ยังไม่ผ่านการตรวจสอบจากเจ้าหน้าที่ดูแลพัสดุ (ต้องผ่านการตรวจก่อนอนุมัติ)');
    }

    const eqSnap = await tx.get(eqRef);
    if (!eqSnap.exists()) throw new Error('ไม่พบข้อมูลครุภัณฑ์');

    const totalDays = daysInclusive(cur.startDate, cur.expectedReturnDate);
    if (totalDays > MAX_TOTAL_DAYS) {
      throw new Error(`ระยะเวลาการยืมรวมต้องไม่เกินเพดานสูงสุด ${MAX_TOTAL_DAYS} วัน (ที่เลือก ${totalDays} วัน)`);
    }

    if (approved) {
      // ตรวจสอบคิวจองสดใหม่เสมอใน Transaction
      const snap = await getDocs(
        query(
          collection(db, 'equipment_bookings'),
          where('equipmentId', '==', cur.equipment.equipmentId),
          where('status', '==', 'ACTIVE')
        )
      );
      const bookings = snap.docs.map((d) => d.data() as EquipmentBooking);
      const conflicts = findBookingConflicts(bookings, cur.equipment.equipmentId, cur.startDate, cur.expectedReturnDate, cur.id);
      if (conflicts.length > 0) {
        throw new Error(`CONCURRENCY_CONFLICT: ช่วงวันคำขอ (${fmtDate(cur.startDate)} ถึง ${fmtDate(cur.expectedReturnDate)}) ชนกับรายการจองอื่น`);
      }
    }

    tx.update(ref, {
      status: approved ? 'APPROVED_WAITING_PICKUP' : 'REJECTED',
      approval: {
        approverEmail: me.email || '',
        approverName: me.name || me.email || '',
        result: approved ? 'APPROVED' : 'REJECTED',
        comment: comment || '',
        approvedAt: serverTimestamp(),
      },
      timeline: [
        ...(cur.timeline ?? []),
        entry(
          approved ? 'APPROVED_WAITING_PICKUP' : 'REJECTED',
          me,
          approved ? `อนุมัติ${comment ? ` - ${comment}` : ''}` : `ไม่อนุมัติ: ${comment || '-'}`
        ),
      ],
      updatedAt: serverTimestamp(),
    });

    if (!approved) {
      tx.set(
        bookRef,
        { status: 'CANCELLED', updatedAt: serverTimestamp() },
        { merge: true }
      );
      const curBookings: EquipmentBooking[] = (eqSnap.data().activeBookings || []) as EquipmentBooking[];
      const nextBookings = curBookings.filter((b) => b.requestId !== cur.id);
      tx.update(eqRef, {
        activeBookings: nextBookings,
        lastBookingUpdatedAt: serverTimestamp(),
      });
    } else {
      tx.update(eqRef, { lastBookingUpdatedAt: serverTimestamp() });
    }
  });

  logAudit(
    'APPROVE_REQUEST',
    r.id,
    approved ? `อนุมัติคำขอ${comment ? `: ${comment}` : ''}` : `ไม่อนุมัติคำขอ: ${comment || '-'}`,
    me
  ).catch((e) => console.warn('Audit error:', e));

  // ส่ง Email แจ้งผลการอนุมัติแก่ผู้ยื่นคำขอ
  notifyApprovalResult(r, approved, comment, customDb).catch((e) => console.error('Email notify error:', e));
}

/* 5) นายชาลีส่งมอบ ------------------------------------------------------ */
export async function handoverRequest(
  r: BorrowRequest,
  me: AppUser,
  input: { accessories: string[]; conditionNote: string },
  customDb?: any
) {
  if (me.role !== 'CUSTODIAN' && me.role !== 'APPROVER' && me.role !== 'EXECUTIVE') {
    throw new Error('เฉพาะเจ้าหน้าที่ดูแลพัสดุ (CUSTODIAN), ผู้อนุมัติ (APPROVER) หรือผู้บริหาร เท่านั้นที่มีสิทธิ์บันทึกส่งมอบครุภัณฑ์');
  }
  const db = customDb || fb().db;
  await transition(
    r.id,
    ['APPROVED_WAITING_PICKUP'],
    'IN_USE',
    me,
    {
      handover: {
        custodianEmail: me.email || '',
        custodianName: me.name || me.email || '',
        handoverDate: todayStr(),
        accessories: Array.isArray(input.accessories) ? input.accessories : [],
        conditionNote: input.conditionNote || '',
        handedAt: serverTimestamp(),
      },
    },
    'ส่งมอบครุภัณฑ์แล้ว',
    (tx, cur, eqData) => {
      if (eqData && (eqData.status === 'MAINTENANCE' || eqData.status === 'LOST' || eqData.isDeleted)) {
        throw new Error(
          `ไม่สามารถส่งมอบได้ เนื่องจากครุภัณฑ์อยู่ในสถานะ ${
            eqData.status === 'MAINTENANCE' ? 'อยู่ระหว่างซ่อมบำรุง' : 'สูญหายหรือไม่พร้อมใช้งาน'
          }`
        );
      }
      tx.update(doc(db, 'equipments', cur.equipment.equipmentId), {
        status: 'BORROWED',
        updatedAt: serverTimestamp(),
      });
    },
    customDb
  );

  logAudit(
    'HANDOVER_EQUIPMENT',
    r.id,
    `ส่งมอบครุภัณฑ์ ${r.equipment.name} แล้ว (อุปกรณ์เสริม: ${input.accessories.join(', ') || 'ไม่มี'})`,
    me
  ).catch((e) => console.warn('Audit error:', e));

  // หมายเหตุ: ตัดอีเมล HANDED_OVER ตามนโยบายลดอีเมลซ้ำซ้อน เนื่องจากผู้ยืมมารับมอบอุปกรณ์ ณ เคาน์เตอร์โดยตรง
  // บันทึกสถานะ In-App และไทม์ไลน์เป็นหลัก
}

/* 6) นายชาลีตรวจรับคืน -------------------------------------------------- */
export async function returnRequest(
  r: BorrowRequest,
  me: AppUser,
  input: {
    condition: ReturnCondition;
    remarks: string;
    damageReport?: DamageReport;
    lostReport?: LostReport;
  },
  customDb?: any
) {
  if (me.role !== 'CUSTODIAN' && me.role !== 'APPROVER' && me.role !== 'EXECUTIVE') {
    throw new Error('เฉพาะเจ้าหน้าที่ดูแลพัสดุ (CUSTODIAN), ผู้อนุมัติ (APPROVER) หรือผู้บริหาร เท่านั้นที่มีสิทธิ์บันทึกรับคืนครุภัณฑ์');
  }
  const db = customDb || fb().db;
  const today = todayStr();
  const lateDays = Math.max(0, daysInclusive(r.expectedReturnDate, today) - 1);
  const to: RequestStatus =
    input.condition === 'NORMAL' ? 'RETURNED' : input.condition === 'DAMAGED' ? 'RETURNED_DAMAGED' : 'LOST';
  const eqStatus = input.condition === 'NORMAL' ? 'AVAILABLE' : input.condition === 'DAMAGED' ? 'MAINTENANCE' : 'LOST';

  const returnInfoPayload: Record<string, unknown> = {
    actualReturnDate: today,
    receivedByEmail: me.email || '',
    receivedByName: me.name || me.email || '',
    condition: input.condition,
    remarks: input.remarks || '',
    lateDays,
    receivedAt: serverTimestamp(),
  };

  if (input.condition === 'DAMAGED' && input.damageReport) {
    const dr: Record<string, unknown> = {
      symptom: input.damageReport.symptom || '',
    };
    if (input.damageReport.damageDetails) dr.damageDetails = input.damageReport.damageDetails;
    if (input.damageReport.cause) dr.cause = input.damageReport.cause;
    if (input.damageReport.damagedAccessories && input.damageReport.damagedAccessories.length > 0) {
      dr.damagedAccessories = input.damageReport.damagedAccessories;
    }
    if (input.damageReport.photos && input.damageReport.photos.length > 0) {
      dr.photos = input.damageReport.photos;
    }
    returnInfoPayload.damageReport = dr;
  }

  if (input.condition === 'LOST' && input.lostReport) {
    const lr: Record<string, unknown> = {
      incidentDetails: input.lostReport.incidentDetails || '',
    };
    if (input.lostReport.incidentDate) lr.incidentDate = input.lostReport.incidentDate;
    if (input.lostReport.location) lr.location = input.lostReport.location;
    if (input.lostReport.policeReportNo) lr.policeReportNo = input.lostReport.policeReportNo;
    if (typeof input.lostReport.borrowerLiabilityAccepted === 'boolean') {
      lr.borrowerLiabilityAccepted = input.lostReport.borrowerLiabilityAccepted;
    }
    if (input.lostReport.photos && input.lostReport.photos.length > 0) {
      lr.photos = input.lostReport.photos;
    }
    returnInfoPayload.lostReport = lr;
  }

  const patch: Record<string, unknown> = {
    returnInfo: returnInfoPayload,
  };

  // ปิดคำขอต่ออายุที่ค้างอยู่โดยอัตโนมัติเมื่อมีการคืนของ (เฉพาะที่ยังรอพิจารณา PENDING_REVIEW หรือ PENDING_APPROVAL)
  if (r.extension && ['PENDING_REVIEW', 'PENDING_APPROVAL'].includes(r.extension.status)) {
    patch.extension = {
      ...r.extension,
      status: 'CANCELLED',
    };
  }

  await transition(
    r.id,
    ['IN_USE', 'OVERDUE'],
    to,
    me,
    patch,
    `${STATUS_META[to].label}${lateDays ? ` (ช้า ${lateDays} วัน)` : ''}${input.remarks ? ` - ${input.remarks}` : ''}`,
    (tx, cur) => {
      tx.update(doc(db, 'equipments', cur.equipment.equipmentId), {
        status: eqStatus,
        updatedAt: serverTimestamp(),
      });
    },
    customDb
  );

  logAudit(
    'RETURN_EQUIPMENT',
    r.id,
    `รับคืนครุภัณฑ์ ผลตรวจสภาพ: ${input.condition} ${lateDays ? `(ส่งช้า ${lateDays} วัน)` : ''} ${input.remarks ? `บันทึก: ${input.remarks}` : ''}`,
    me, customDb
  ).catch((e) => console.warn('Audit error:', e));

  // ส่ง Email ยืนยันการส่งคืนแก่ผู้ยืม พร้อม 1-Click แบบประเมินความพึงพอใจ (CSAT) รวมในฉบับเดียว
  notifyReturnedWithCsat(r, input.condition, input.remarks, customDb).catch((e) => console.error('Email notify error:', e));
}

/* ------------------------------------------------------------------ */
/* 7) ขอต่ออายุ (Extension Flow)                                       */
/* ------------------------------------------------------------------ */

export interface ExtensionInput {
  newExpectedReturnDate: string;
  reason: string;
}

/** ผู้ยืมยื่นคำขอต่ออายุหลังรับมอบอุปกรณ์แล้ว */
export async function requestExtension(r: BorrowRequest, me: AppUser, input: ExtensionInput, customDb?: any) {
  if (r.borrower.email.toLowerCase() !== me.email.toLowerCase() && me.role !== 'CUSTODIAN') {
    throw new Error('เฉพาะผู้ยืมเจ้าของคำขอหรือเจ้าหน้าที่พัสดุเท่านั้นที่สามารถยื่นขอต่ออายุได้');
  }
  if (r.status !== 'IN_USE' && r.status !== 'OVERDUE') {
    throw new Error('สามารถขอต่ออายุได้เฉพาะรายการที่กำลังใช้งานหรือเกินกำหนดส่งคืนเท่านั้น');
  }
  if (r.extension && ['PENDING_REVIEW', 'PENDING_APPROVAL'].includes(r.extension.status)) {
    throw new Error('คำขอนี้มีคำขอต่ออายุที่อยู่ระหว่างการพิจารณาอยู่แล้ว 1 รายการ');
  }

  const { newExpectedReturnDate, reason } = input;
  if (!newExpectedReturnDate) throw new Error('กรุณาระบุกำหนดวันส่งคืนใหม่');
  if (newExpectedReturnDate <= r.expectedReturnDate) {
    throw new Error(`กำหนดส่งคืนใหม่ (${fmtDate(newExpectedReturnDate)}) ต้องอยู่หลังจากกำหนดส่งคืนปัจจุบัน (${fmtDate(r.expectedReturnDate)})`);
  }
  if (newExpectedReturnDate < todayStr()) {
    throw new Error('กำหนดส่งคืนใหม่ต้องไม่เป็นวันที่ผ่านมาแล้ว');
  }
  if (!reason.trim()) {
    throw new Error('กรุณาระบุเหตุผลและความจำเป็นในการขอต่ออายุ');
  }

  const totalDays = daysInclusive(r.startDate, newExpectedReturnDate);
  if (totalDays > MAX_TOTAL_DAYS) {
    throw new Error(`ระยะเวลาการยืมรวมทุกครั้งที่ขอต่ออายุต้องไม่เกินเพดานสูงสุด ${MAX_TOTAL_DAYS} วันนับจากวันเริ่มยืมเดิม (${fmtDate(r.startDate)}) (ที่เลือก ${totalDays} วัน)`);
  }

  const addedDays = daysInclusive(r.expectedReturnDate, newExpectedReturnDate) - 1;
  const isOverdue = r.status === 'OVERDUE';

  const extData: ExtensionRequest = {
    status: 'PENDING_REVIEW',
    requestedAt: Timestamp.now(),
    requestedBy: me.email || '',
    requestedByName: me.name || me.email || '',
    currentExpectedReturnDate: r.expectedReturnDate,
    newExpectedReturnDate,
    addedDays,
    reason: reason.trim(),
    isOverdueExtension: isOverdue,
    review: null,
    approval: null,
  };

  const db = customDb || fb().db;
  const ref = doc(db, 'borrow_requests', r.id);
  const eqRef = doc(db, 'equipments', r.equipment.equipmentId);

  await runTransaction(db, async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists()) throw new Error('ไม่พบคำขอ');
    const cur = { ...s.data(), id: s.id } as BorrowRequest;
    if (cur.status !== 'IN_USE' && cur.status !== 'OVERDUE') {
      throw new Error('สถานะของคำขอไม่อยู่ในสถานะที่อนุญาตให้ต่ออายุได้');
    }
    if (cur.extension && ['PENDING_REVIEW', 'PENDING_APPROVAL'].includes(cur.extension.status)) {
      throw new Error('คำขอนี้มีคำขอต่ออายุที่อยู่ระหว่างการพิจารณาอยู่แล้ว');
    }

    const curTotalDays = daysInclusive(cur.startDate, newExpectedReturnDate);
    if (curTotalDays > MAX_TOTAL_DAYS) {
      throw new Error(`ระยะเวลาการยืมรวมต้องไม่เกินเพดานสูงสุด ${MAX_TOTAL_DAYS} วัน`);
    }

    // ตรวจคิวจองสดใหม่เสมอในทุก Transaction
    const snap = await getDocs(
      query(
        collection(db, 'equipment_bookings'),
        where('equipmentId', '==', cur.equipment.equipmentId),
        where('status', '==', 'ACTIVE')
      )
    );
    const bookings = snap.docs.map((d) => d.data() as EquipmentBooking);
    const conflicts = findBookingConflicts(bookings, cur.equipment.equipmentId, cur.expectedReturnDate, newExpectedReturnDate, cur.id);
    if (conflicts.length > 0) {
      const c = conflicts[0];
      throw new Error(`CONCURRENCY_CONFLICT: ช่วงเวลาที่ขอต่ออายุ (${fmtDate(cur.expectedReturnDate)} ถึง ${fmtDate(newExpectedReturnDate)}) ซ้อนทับกับรายการจองคำขออื่น (${fmtDate(c.startDate)} ถึง ${fmtDate(c.expectedReturnDate)})`);
    }

    const eqSnap = await tx.get(eqRef);

    tx.update(ref, {
      extension: extData,
      timeline: [
        ...(cur.timeline ?? []),
        entry(
          cur.status,
          me,
          `ยื่นขอต่ออายุถึง ${fmtDate(newExpectedReturnDate)} (+${addedDays} วัน): ${reason}`
        ),
      ],
      updatedAt: serverTimestamp(),
    });

    if (eqSnap.exists()) {
      tx.update(eqRef, { lastBookingUpdatedAt: serverTimestamp() });
    }
  });

  logAudit(
    'REQUEST_EXTENSION',
    r.id,
    `ยื่นขอต่ออายุถึง ${fmtDate(newExpectedReturnDate)} (+${addedDays} วัน) เหตุผล: ${reason}`,
    me
  ).catch((e) => console.warn('Audit error:', e));

  notifyExtensionRequested(r, newExpectedReturnDate, reason, customDb).catch((e) =>
    console.error('Email notify error:', e)
  );
}

/** เจ้าหน้าที่พัสดุตรวจสอบคำขอต่ออายุ (ขั้นที่ 1) */
export async function reviewExtension(
  r: BorrowRequest,
  me: AppUser,
  input: { passed: boolean; reason?: string; comment?: string },
  customDb?: any
) {
  if (me.role !== 'CUSTODIAN' && me.role !== 'EXECUTIVE') {
    throw new Error('เฉพาะเจ้าหน้าที่ดูแลพัสดุ (CUSTODIAN) หรือผู้บริหาร เท่านั้นที่มีสิทธิ์ตรวจสอบคำขอต่ออายุ');
  }
  if (!r.extension || r.extension.status !== 'PENDING_REVIEW') {
    throw new Error('ไม่มีคำขอต่ออายุที่รอการตรวจสอบ');
  }

  const db = customDb || fb().db;
  const ref = doc(db, 'borrow_requests', r.id);
  const eqRef = doc(db, 'equipments', r.equipment.equipmentId);

  await runTransaction(db, async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists()) throw new Error('ไม่พบคำขอ');
    const cur = { ...s.data(), id: s.id } as BorrowRequest;
    if (!cur.extension || cur.extension.status !== 'PENDING_REVIEW') {
      throw new Error('สถานะคำขอต่ออายุเปลี่ยนไปแล้ว');
    }

    const eqSnap = await tx.get(eqRef);

    const updatedExt: ExtensionRequest = {
      ...cur.extension,
      status: input.passed ? 'PENDING_APPROVAL' : 'REJECTED',
      review: {
        reviewerEmail: me.email || '',
        reviewerName: me.name || me.email || '',
        result: input.passed ? 'PASSED' : 'FAILED',
        reason: input.reason || '',
        comment: input.comment || '',
        reviewedAt: Timestamp.now(),
      },
    };

    tx.update(ref, {
      extension: updatedExt,
      timeline: [
        ...(cur.timeline ?? []),
        entry(
          cur.status,
          me,
          input.passed
            ? `ตรวจสอบคำขอต่ออายุแล้ว (ผ่าน) ส่งต่อผู้อนุมัติ${input.comment ? ` - ${input.comment}` : ''}`
            : `ตรวจสอบคำขอต่ออายุ: ไม่ผ่าน (${input.reason || input.comment || '-'})`
        ),
      ],
      updatedAt: serverTimestamp(),
    });

    if (eqSnap.exists()) {
      tx.update(eqRef, { lastBookingUpdatedAt: serverTimestamp() });
    }
  });

  logAudit(
    'REVIEW_EXTENSION',
    r.id,
    input.passed ? 'ตรวจสอบคำขอต่ออายุผ่าน' : `ตรวจสอบคำขอต่ออายุไม่ผ่าน: ${input.reason || '-'}`,
    me
  ).catch((e) => console.warn('Audit error:', e));

  if (input.passed) {
    notifyExtensionReviewPassed(r, r.extension.newExpectedReturnDate, r.extension.reason, customDb).catch((e) =>
      console.error('Email notify error:', e)
    );
  } else {
    notifyExtensionRejected(r, input.reason || input.comment, 'REVIEW', customDb).catch((e) =>
      console.error('Email notify error:', e)
    );
  }
}

/** ผู้อนุมัติพิจารณาอนุมัติคำขอต่ออายุ (ขั้นที่ 2) */
export async function approveExtension(
  r: BorrowRequest,
  me: AppUser,
  approved: boolean,
  comment?: string,
  customDb?: any
) {
  if (me.role !== 'APPROVER' && me.role !== 'EXECUTIVE') {
    throw new Error('เฉพาะผู้อนุมัติ (APPROVER) หรือผู้บริหาร เท่านั้นที่มีสิทธิ์พิจารณาอนุมัติคำขอต่ออายุ');
  }
  if (!r.extension || r.extension.status !== 'PENDING_APPROVAL') {
    throw new Error('ไม่มีคำขอต่ออายุที่รอการอนุมัติ');
  }

  const db = customDb || fb().db;
  const ref = doc(db, 'borrow_requests', r.id);
  const eqRef = doc(db, 'equipments', r.equipment.equipmentId);
  const bookRef = doc(db, 'equipment_bookings', r.id);

  await runTransaction(db, async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists()) throw new Error('ไม่พบคำขอ');
    const cur = { ...s.data(), id: s.id } as BorrowRequest;
    
    // ผู้อนุมัติยืมเองได้และอนุมัติต่ออายุตนเองได้ แต่ต้องผ่านผู้ดูแลตรวจผ่านก่อนตามขั้นตอนปกติ (PENDING_APPROVAL และ review.result == 'PASSED')
    if (!cur.extension || cur.extension.status !== 'PENDING_APPROVAL' || !cur.extension.review || cur.extension.review.result !== 'PASSED') {
      throw new Error('คำขอต่ออายุนี้ยังไม่ผ่านการตรวจสอบจากเจ้าหน้าที่ดูแลพัสดุ (ต้องผ่านการตรวจก่อนอนุมัติ)');
    }
    if (cur.status !== 'IN_USE' && cur.status !== 'OVERDUE') {
      throw new Error('คำขอนี้ไม่อยู่ในสถานะที่อนุญาตให้อนุมัติต่ออายุได้');
    }

    const ext = cur.extension; // fresh snapshot from transaction!
    const eqSnap = await tx.get(eqRef);

    const newDurationDays = daysInclusive(cur.startDate, ext.newExpectedReturnDate);
    if (newDurationDays > MAX_TOTAL_DAYS) {
      throw new Error(`ระยะเวลาการยืมรวมทุกครั้งที่ขอต่ออายุต้องไม่เกินเพดานสูงสุด ${MAX_TOTAL_DAYS} วันนับจากวันเริ่มยืมเดิม (${fmtDate(cur.startDate)})`);
    }

    if (approved) {
      // ตรวจสอบคิวจองสดใหม่เสมอใน Transaction
      const snap = await getDocs(
        query(
          collection(db, 'equipment_bookings'),
          where('equipmentId', '==', cur.equipment.equipmentId),
          where('status', '==', 'ACTIVE')
        )
      );
      const bookings = snap.docs.map((d) => d.data() as EquipmentBooking);
      const conflicts = findBookingConflicts(bookings, cur.equipment.equipmentId, cur.startDate, ext.newExpectedReturnDate, cur.id);
      if (conflicts.length > 0) {
        throw new Error(`CONCURRENCY_CONFLICT: ช่วงเวลาที่ขยาย (${fmtDate(cur.expectedReturnDate)} ถึง ${fmtDate(ext.newExpectedReturnDate)}) ซ้อนทับกับรายการจองคำขออื่น`);
      }
    }

    const newDeadlineVersion = (cur.deadlineVersion || 1) + 1;

    const historyEntry: ExtensionHistoryEntry = {
      extensionNumber: (cur.extensionHistory?.length || 0) + 1,
      previousExpectedReturnDate: cur.expectedReturnDate,
      newExpectedReturnDate: ext.newExpectedReturnDate,
      addedDays: ext.addedDays,
      reason: ext.reason || '',
      requestedAt: ext.requestedAt,
      requestedBy: ext.requestedBy || '',
      approvedAt: Timestamp.now(),
      approvedBy: me.email || '',
      approvedByName: me.name || me.email || '',
      approverComment: comment || '',
      reviewerComment: ext.review?.comment || '',
      status: approved ? 'APPROVED' : 'REJECTED',
    };

    const updatedExt: ExtensionRequest = {
      ...ext,
      status: approved ? 'APPROVED' : 'REJECTED',
      approval: {
        approverEmail: me.email || '',
        approverName: me.name || me.email || '',
        result: approved ? 'APPROVED' : 'REJECTED',
        comment: comment || '',
        approvedAt: Timestamp.now(),
      },
    };

    const patch: Record<string, unknown> = {
      extension: updatedExt,
      extensionHistory: [...(cur.extensionHistory || []), historyEntry],
      updatedAt: serverTimestamp(),
      timeline: [
        ...(cur.timeline ?? []),
        entry(
          cur.status,
          me,
          approved
            ? `อนุมัติต่ออายุถึง ${fmtDate(ext.newExpectedReturnDate)} (+${ext.addedDays} วัน)${comment ? ` - ${comment}` : ''}`
            : `ไม่อนุมัติต่ออายุ: ${comment || '-'}`
        ),
      ],
    };

    if (approved) {
      patch.expectedReturnDate = ext.newExpectedReturnDate;
      patch.durationDays = newDurationDays;
      patch.deadlineVersion = newDeadlineVersion;
      // หากเคยเป็น OVERDUE แต่ต่ออายุเกินวันปัจจุบัน สามารถปรับเป็น IN_USE
      if (cur.status === 'OVERDUE' && ext.newExpectedReturnDate >= todayStr()) {
        patch.status = 'IN_USE';
      }
      tx.set(
        bookRef,
        {
          expectedReturnDate: ext.newExpectedReturnDate,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
    }

    if (eqSnap.exists()) {
      if (approved) {
        const curBookings: EquipmentBooking[] = (eqSnap.data().activeBookings || []) as EquipmentBooking[];
        const nextBookings = curBookings.map((b) =>
          b.requestId === cur.id ? { ...b, expectedReturnDate: ext.newExpectedReturnDate } : b
        );
        tx.update(eqRef, {
          activeBookings: nextBookings,
          lastBookingUpdatedAt: serverTimestamp(),
        });
      } else {
        tx.update(eqRef, { lastBookingUpdatedAt: serverTimestamp() });
      }
    }

    tx.update(ref, patch);
  });

  logAudit(
    'APPROVE_EXTENSION',
    r.id,
    approved
      ? `อนุมัติต่ออายุถึง ${fmtDate(r.extension?.newExpectedReturnDate || '')}${comment ? `: ${comment}` : ''}`
      : `ไม่อนุมัติต่ออายุ: ${comment || '-'}`,
    me
  ).catch((e) => console.warn('Audit error:', e));

  if (approved) {
    notifyExtensionApproved(
      r,
      r.extension?.currentExpectedReturnDate || r.expectedReturnDate,
      r.extension?.newExpectedReturnDate || '',
      comment,
      customDb
    ).catch((e) => console.error('Email notify error:', e));
  } else {
    notifyExtensionRejected(r, comment, 'APPROVAL', customDb).catch((e) =>
      console.error('Email notify error:', e)
    );
  }
}

/** ผู้ยืมยกเลิกคำขอต่ออายุ (เฉพาะผู้ยืมเจ้าของคำขอเท่านั้น) */
export async function cancelExtension(r: BorrowRequest, me: AppUser, customDb?: any) {
  if (r.borrower.email.toLowerCase() !== me.email.toLowerCase()) {
    throw new Error('เฉพาะผู้ยืมเจ้าของคำขอเท่านั้นที่สามารถยกเลิกคำขอต่ออายุได้');
  }
  if (!r.extension || !['PENDING_REVIEW', 'PENDING_APPROVAL'].includes(r.extension.status)) {
    throw new Error('ไม่มีคำขอต่ออายุที่สามารถยกเลิกได้');
  }

  const db = customDb || fb().db;
  const ref = doc(db, 'borrow_requests', r.id);
  const eqRef = doc(db, 'equipments', r.equipment.equipmentId);

  await runTransaction(db, async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists()) throw new Error('ไม่พบคำขอ');
    const cur = { ...s.data(), id: s.id } as BorrowRequest;
    if (cur.borrower.email.toLowerCase() !== me.email.toLowerCase()) {
      throw new Error('เฉพาะผู้ยืมเจ้าของคำขอเท่านั้นที่สามารถยกเลิกคำขอต่ออายุได้');
    }
    if (cur.status !== 'IN_USE' && cur.status !== 'OVERDUE') {
      throw new Error('สถานะคำขอไม่อยู่ในสถานะที่สามารถยกเลิกการต่ออายุได้');
    }
    if (!cur.extension || !['PENDING_REVIEW', 'PENDING_APPROVAL'].includes(cur.extension.status)) {
      throw new Error('สถานะคำขอต่ออายุเปลี่ยนไปแล้ว ไม่สามารถยกเลิกได้');
    }

    const eqSnap = await tx.get(eqRef);

    tx.update(ref, {
      extension: {
        ...cur.extension,
        status: 'CANCELLED',
      },
      timeline: [...(cur.timeline ?? []), entry(cur.status, me, 'ผู้ยืมยกเลิกคำขอต่ออายุ')],
      updatedAt: serverTimestamp(),
    });

    if (eqSnap.exists()) {
      tx.update(eqRef, { lastBookingUpdatedAt: serverTimestamp() });
    }
  });

  logAudit('CANCEL_EXTENSION', r.id, 'ผู้ยืมยกเลิกคำขอต่ออายุ', me).catch((e) =>
    console.warn('Audit error:', e)
  );
}

/* ------------------------------------------------------------------ */
/* 8) แบบประเมินความพึงพอใจหลังส่งคืน (CSAT Satisfaction Survey)           */
/* ------------------------------------------------------------------ */

export interface SubmitSurveyInput {
  rating: number; // 1 to 5
  tags?: string[];
  comment?: string;
}

/**
 * ผู้ยืมส่งแบบประเมินความพึงพอใจสำหรับคำขอที่ส่งคืนแล้ว
 * สิทธิ์: เฉพาะผู้ยืมเจ้าของคำขอเท่านั้น (ตรวจเช็คตาม Security Rules)
 * เงื่อนไข: ให้คะแนนได้ครั้งเดียวเท่านั้น (1-5 ดาว)
 */
export async function submitSatisfactionSurvey(
  requestId: string,
  input: SubmitSurveyInput,
  me: AppUser,
  customDb?: any
) {
  if (!requestId) throw new Error('ไม่พบรหัสคำขอ');
  if (!input || typeof input.rating !== 'number' || input.rating < 1 || input.rating > 5) {
    throw new Error('กรุณาระบุคะแนนความพึงพอใจระหว่าง 1 ถึง 5 ดาว');
  }

  const db = customDb || fb().db;
  const ref = doc(db, 'borrow_requests', requestId);
  const txRunner = mockTxRunner || runTransaction;
  const surveyData = await txRunner(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) {
      throw new Error(`ไม่พบคำขอยืมเลขที่ ${requestId} ในระบบ`);
    }

    const r = { ...snap.data(), id: snap.id } as BorrowRequest;
    if (r.borrower.email.toLowerCase() !== me.email.toLowerCase()) {
      throw new Error('เฉพาะผู้ยืมเจ้าของคำขอเท่านั้นที่มีสิทธิ์ตอบแบบประเมินความพึงพอใจ');
    }

    if (!['RETURNED', 'RETURNED_DAMAGED', 'LOST'].includes(r.status)) {
      throw new Error('สามารถส่งแบบประเมินได้เฉพาะคำขอที่ส่งคืนหรือสิ้นสุดแล้วเท่านั้น');
    }

    if (r.survey) {
      throw new Error('คำขอนี้ได้รับการประเมินความพึงพอใจไปแล้ว ไม่สามารถแก้ไขหรือส่งซ้ำได้');
    }

    const roundedRating = Math.round(input.rating);
    const needsFollowUp = roundedRating <= 3;
    const data: SatisfactionSurvey = {
      rating: roundedRating,
      tags: Array.isArray(input.tags) ? input.tags.filter((t) => typeof t === 'string' && t.trim()) : [],
      comment: (input.comment || '').trim(),
      submittedAt: Timestamp.now(),
      submittedBy: (me.email || '').toLowerCase(),
      submittedByName: me.name || me.email || '',
      needsFollowUp,
      followUpStatus: needsFollowUp ? 'PENDING_REVIEW' : 'NO_ACTION_NEEDED',
      followUpNotes: '',
      followUpBy: '',
      followUpByName: '',
      followUpAt: null,
    };

    tx.update(ref, {
      survey: data,
      updatedAt: serverTimestamp(),
    });

    return data;
  });

  logAudit(
    'SUBMIT_SURVEY',
    requestId,
    `ผู้ยืม (${me.name || me.email}) ประเมินความพึงพอใจ ${surveyData.rating}/5 ดาว ${surveyData.tags?.length ? `[${surveyData.tags.join(', ')}]` : ''}${surveyData.needsFollowUp ? ' [สถานะ: รอการติดตามความคิดเห็น]' : ''}`,
    me,
    customDb
  ).catch((e) => console.warn('Audit error:', e));

  return surveyData;
}

/**
 * เจ้าหน้าที่ติดตามความคิดเห็นและผลการประเมินคะแนนต่ำ (Low Rating Follow-Up)
 */
export async function updateSurveyFollowUp(
  requestId: string,
  input: {
    status: SurveyFollowUpStatus;
    notes?: string;
  },
  me: AppUser,
  customDb?: any
) {
  if (!requestId) throw new Error('ไม่พบรหัสคำขอ');
  if (!me || !['CUSTODIAN', 'APPROVER', 'EXECUTIVE'].includes(me.role)) {
    throw new Error('เฉพาะเจ้าหน้าที่ดูแลพัสดุ ผู้อนุมัติ หรือผู้บริหารเท่านั้นที่มีสิทธิ์บันทึกการติดตาม');
  }
  const allowedStatuses: SurveyFollowUpStatus[] = ['PENDING_REVIEW', 'IN_PROGRESS', 'RESOLVED', 'NO_ACTION_NEEDED'];
  if (!input || !allowedStatuses.includes(input.status)) {
    throw new Error('สถานะการติดตามไม่ถูกต้อง');
  }

  const db = customDb || fb().db;
  const ref = doc(db, 'borrow_requests', requestId);
  const txRunner = mockTxRunner || runTransaction;

  const updatedSurvey = await txRunner(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) {
      throw new Error(`ไม่พบคำขอยืมเลขที่ ${requestId}`);
    }

    const r = { ...snap.data(), id: snap.id } as BorrowRequest;
    if (!r.survey) {
      throw new Error('คำขอนี้ยังไม่ได้รับการประเมินความพึงพอใจ');
    }

    const currentSurvey = r.survey;
    const notes = (input.notes || '').trim();

    const newSurvey: SatisfactionSurvey = {
      ...currentSurvey,
      followUpStatus: input.status,
      followUpNotes: notes || currentSurvey.followUpNotes || '',
      followUpBy: (me.email || '').toLowerCase(),
      followUpByName: me.name || me.email || '',
      followUpAt: Timestamp.now(),
    };

    tx.update(ref, {
      survey: newSurvey,
      updatedAt: serverTimestamp(),
    });

    return newSurvey;
  });

  logAudit(
    'UPDATE_SURVEY_FOLLOW_UP',
    requestId,
    `เจ้าหน้าที่ (${me.name || me.email}) อัปเดตสถานะติดตาม CSAT เป็น ${input.status} บันทึก: ${input.notes || '-'}`,
    me,
    customDb
  ).catch((e) => console.warn('Audit error:', e));

  return updatedSurvey;
}

export type TransactionRunner = <T>(
  db: any,
  updateFunction: (transaction: any) => Promise<T>
) => Promise<T>;

let mockTxRunner: TransactionRunner | null = null;

export function setMockTransactionRunner(runner: TransactionRunner | null) {
  mockTxRunner = runner;
}

/**
 * เจ้าหน้าที่ส่งอีเมลเชิญตอบแบบประเมินย้อนหลัง (Retroactive CSAT Invite)
 * สำหรับคำขอในอดีตที่ส่งคืนแล้วแต่ผู้ยืมยังไม่ได้ประเมิน
 * ทำงานแบบ Atomic Multi-Document Transaction ร่วมกับคิว mail ป้องกันงานกำพร้าและ Race Condition
 */
export async function sendRetroactiveCsatInvite(
  r: BorrowRequest,
  me: AppUser,
  options?: { forceResend?: boolean; resendReason?: string } | any,
  customDb?: any
): Promise<{ success: boolean; mailJobId: string; inviteNumber: number; freshReq?: BorrowRequest }> {
  if (me.role !== 'CUSTODIAN' && me.role !== 'APPROVER' && me.role !== 'EXECUTIVE') {
    throw new Error('เฉพาะเจ้าหน้าที่ดูแลพัสดุ ผู้อนุมัติ หรือผู้บริหารเท่านั้นที่มีสิทธิ์ส่งคำเชิญประเมินย้อนหลัง');
  }

  if (!['RETURNED', 'RETURNED_DAMAGED', 'LOST'].includes(r.status)) {
    throw new Error('เฉพาะคำขอที่ส่งคืนแล้วเท่านั้นที่สามารถส่งคำเชิญประเมินย้อนหลังได้');
  }

  if (r.survey) {
    throw new Error(`คำขอ ${r.id} ได้รับการประเมินความพึงพอใจเรียบร้อยแล้ว ไม่จำเป็นต้องส่งคำเชิญซ้ำ`);
  }

  let optionsObj: { forceResend?: boolean; resendReason?: string } | undefined = undefined;
  let resolvedDb: any = undefined;
  if (options && typeof options === 'object' && ('forceResend' in options || 'resendReason' in options)) {
    optionsObj = options;
    resolvedDb = customDb;
  } else if (options && typeof options === 'object') {
    resolvedDb = options;
  } else {
    resolvedDb = customDb;
  }

  if (optionsObj?.forceResend && !optionsObj.resendReason?.trim()) {
    throw new Error('กรุณาระบุเหตุผลในการส่งคำเชิญซ้ำ');
  }

  const db = resolvedDb || fb().db;
  const reqId = r.id || (r as any).requestId;
  if (!reqId || reqId === 'undefined') {
    throw new Error('ไม่พบรหัสคำขอ');
  }
  const reqRef = doc(db, 'borrow_requests', reqId);
  const senderEmail = (me.email || '').toLowerCase();

  // ดำเนินการแบบ Atomic Multi-Document Transaction ระหว่าง borrow_requests และ mail
  const txRunner = mockTxRunner || runTransaction;
  const txResult = await txRunner<{
    mailJobId: string;
    inviteNumber: number;
    freshReq: BorrowRequest;
  }>(db, async (tx) => {
    // 1. อ่าน Borrow Request ข้อมูลล่าสุดเสมอใน Transaction
    const reqSnap = await tx.get(reqRef);
    if (!reqSnap.exists()) {
      throw new Error(`ไม่พบคำขอ ${reqId} ในระบบ`);
    }
    const freshReq: BorrowRequest = {
      ...(reqSnap.data() as BorrowRequest),
      id: reqSnap.id,
    };

    if (!['RETURNED', 'RETURNED_DAMAGED', 'LOST'].includes(freshReq.status)) {
      throw new Error('สามารถส่งคำเชิญได้เฉพาะคำขอที่ส่งคืนแล้วเท่านั้น');
    }

    if (freshReq.survey) {
      throw new Error(`คำขอ ${freshReq.id} ได้รับการประเมินความพึงพอใจเรียบร้อยแล้ว ไม่สามารถส่งคำเชิญได้`);
    }

    let inviteNumber = 1;
    if (optionsObj?.forceResend) {
      inviteNumber = (freshReq.surveyInviteCount || (freshReq.surveyInviteStatus ? 1 : 0)) + 1;
    } else {
      const isAlreadySent = Boolean(freshReq.surveyInviteStatus === 'SENT' || freshReq.surveyInviteSentAt);
      const isAlreadyQueued = Boolean(freshReq.surveyInviteStatus === 'QUEUED' || freshReq.surveyInviteQueuedAt);
      if (isAlreadySent || isAlreadyQueued) {
        throw new Error(`คำขอ ${freshReq.id} มีการส่งหรือเข้าคิวคำเชิญแล้ว หากต้องการส่งซ้ำกรุณาระบุเหตุผลเพื่อส่งอีกครั้ง`);
      }
      inviteNumber = 1;
    }

    const idempotencyKey =
      inviteNumber <= 1
        ? `${freshReq.id}_RETROACTIVE_CSAT`
        : `${freshReq.id}_RETROACTIVE_CSAT_RESEND_${inviteNumber}`;

    const mailDocId = await computeMailJobDocId(senderEmail, idempotencyKey);
    const mailRef = doc(db, 'mail', mailDocId);

    // 2. อ่าน Mail Document (All reads before all writes)
    const mailSnap = await tx.get(mailRef);

    // 3. เขียน Mail Document (หากยังไม่มี)
    if (!mailSnap.exists()) {
      const jobData = buildRetroactiveCsatEmail(freshReq, inviteNumber);
      const mailJob: MailJob = {
        ...jobData,
        senderEmail,
        status: 'PENDING',
        attemptCount: 0,
        maxAttempts: 3,
        createdAt: serverTimestamp(),
        errorDetails: null,
      };
      if (optionsObj?.forceResend) {
        mailJob.metadata = { resendReason: (optionsObj.resendReason || '').trim() || '-', inviteNumber };
      }
      const cleanJob = validateAndSanitizeMailJob(mailJob);
      tx.set(mailRef, cleanJob);
    }

    // 4. บันทึกสถานะคำขอเป็น QUEUED (เฉพาะเซิร์ฟเวอร์เท่านั้นที่จะเปลี่ยนเป็น SENT เมื่อส่งผ่าน Gateway สำเร็จ)
    tx.update(reqRef, {
      surveyInviteQueuedAt: serverTimestamp(),
      surveyInviteStatus: 'QUEUED',
      surveyInviteCount: inviteNumber,
      updatedAt: serverTimestamp(),
    });

    return { mailJobId: mailDocId, inviteNumber, freshReq };
  });

  // 5. ส่งผ่าน Direct Gateway ทันที (รองรับ Firebase Spark โดยไม่ต้องใช้ Cloud Functions)
  try {
    const emailJobData = buildRetroactiveCsatEmail(txResult.freshReq, txResult.inviteNumber);
    const mailRef = doc(db, 'mail', txResult.mailJobId);
    await dispatchMailJobDirect(mailRef, { ...emailJobData, requestId: txResult.freshReq.id }, customDb);
  } catch (dispErr) {
    console.warn('Failed to dispatch CSAT direct:', dispErr);
  }

  // บันทึก Audit Log หลัง Transaction Commit สำเร็จ
  if (options?.forceResend) {
    logAudit(
      'RESEND_SURVEY_INVITE',
      txResult.freshReq.id,
      `ส่งคำเชิญประเมินซ้ำ (ครั้งที่ ${txResult.inviteNumber}) เหตุผล: ${options?.resendReason || '-'} [MailJob: ${txResult.mailJobId}]`,
      me,
      customDb
    ).catch((e) => console.warn('Audit error:', e));
  } else {
    logAudit(
      'SEND_SURVEY_INVITE',
      txResult.freshReq.id,
      `ส่งอีเมลเชิญตอบแบบประเมินความพึงพอใจย้อนหลังไปยังผู้ยืม ${txResult.freshReq.borrower.name} (${txResult.freshReq.borrower.email}) [MailJob: ${txResult.mailJobId}]`,
      me,
      customDb
    ).catch((e) => console.warn('Audit error:', e));
  }

  return { success: true, mailJobId: txResult.mailJobId, inviteNumber: txResult.inviteNumber, freshReq: txResult.freshReq };
}
