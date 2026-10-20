import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
} from 'firebase/firestore';
import { fb } from './firebase.ts';
import type { AppUser, RepairItem, RepairRequest, RepairStatus } from './types.ts';
import { todayStr } from './utils.ts';
import { logAudit } from './audit.ts';
import {
  notifyRepairPendingReview,
  notifyRepairApproved,
  notifyRepairCompleted,
} from './notifications.ts';

const THAI_MONTHS = [
  'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'
];

/** สร้างเลขที่ใบแจ้งซ่อมรันนิ่งตามเดือน เช่น RP-202610-0001 */
export async function generateRepairTicketNo(customDb?: any): Promise<string> {
  const db = customDb || fb().db;
  const today = new Date();
  const ym = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}`;

  try {
    const counterRef = doc(db, 'counters', 'repair_requests');
    return await runTransaction(db, async (tx) => {
      const snap = await tx.get(counterRef);
      const currentSeq = (snap.exists() ? (snap.data()[ym] as number) : 0) || 0;
      const nextSeq = currentSeq + 1;
      tx.set(counterRef, { [ym]: nextSeq }, { merge: true });
      return `RP-${ym}-${String(nextSeq).padStart(4, '0')}`;
    });
  } catch (err) {
    console.warn('Counter transaction fallback for repair ticket:', err);
    // Fallback ID when offline or counter not accessible
    const rand = Math.floor(1000 + Math.random() * 9000);
    return `RP-${ym}-${rand}`;
  }
}

/** ดึงข้อมูลวันที่ภาษาไทย วัน เดือน พ.ศ. */
export function getThaiDateParts(dateStr?: string) {
  const d = dateStr ? new Date(dateStr) : new Date();
  return {
    day: String(d.getDate()),
    month: THAI_MONTHS[d.getMonth()],
    year: String(d.getFullYear() + 543),
  };
}

export interface CreateRepairInput {
  subject?: string;
  recipient?: string;
  documentDate?: string;
  items: RepairItem[];
  approverEmail?: string;
  approverName?: string;
  approverTitle?: string;
  relatedRequestId?: string;
  notes?: string;
  initialStatus?: RepairStatus; // default 'DRAFT'
}

/** สร้างใบแจ้งซ่อมใหม่ (บันทึกเข้าระบบ พร้อมเปลี่ยนสถานะครุภัณฑ์เป็น MAINTENANCE) */
export async function createRepairRequest(
  input: CreateRepairInput,
  me: AppUser,
  customDb?: any
): Promise<string> {
  if (me.role !== 'CUSTODIAN' && me.role !== 'APPROVER' && me.role !== 'EXECUTIVE') {
    throw new Error('เฉพาะเจ้าหน้าที่พัสดุ ผู้อนุมัติ หรือผู้บริหารเท่านั้นที่สามารถสร้างใบแจ้งซ่อมได้');
  }

  if (!input.items || input.items.length === 0) {
    throw new Error('กรุณาระบุรายการครุภัณฑ์ที่ต้องการแจ้งซ่อมอย่างน้อย 1 รายการ');
  }

  for (let i = 0; i < input.items.length; i++) {
    const it = input.items[i];
    if (!it.equipmentName.trim()) throw new Error(`รายการที่ ${i + 1}: กรุณาระบุชื่อครุภัณฑ์`);
    if (!it.symptom.trim()) throw new Error(`รายการที่ ${i + 1}: กรุณาระบุอาการเสีย/ความเสียหาย`);
  }

  const db = customDb || fb().db;
  const ticketNo = await generateRepairTicketNo(db);
  const docDate = input.documentDate || todayStr();
  const dateParts = getThaiDateParts(docDate);
  const status: RepairStatus = input.initialStatus || 'DRAFT';

  const newTicket: Record<string, unknown> = {
    id: ticketNo,
    ticketNo,
    status,
    subject: input.subject?.trim() || 'ขอแจ้งซ่อมอุปกรณ์ทางด้านคอมพิวเตอร์และอุปกรณ์สำนักงาน',
    recipient: input.recipient?.trim() || 'ผู้อำนวยการกองบริหารงานสำนักบริการวิชาการ',
    documentDate: docDate,
    docDay: dateParts.day,
    docMonth: dateParts.month,
    docYear: dateParts.year,

    // Requester info: dynamic from logged-in staff profile
    requesterEmail: me.email || '',
    requesterName: me.name || '',
    requesterPosition: me.position || '',
    requesterDivision: me.division || 'สำนักบริการวิชาการ',

    // Approver info: dynamic from input or role-based default
    approverEmail: input.approverEmail || '',
    approverName: input.approverName || '',
    approverTitle: input.approverTitle || '',

    // Items list
    items: input.items.map((it, idx) => ({
      id: it.id || String(idx + 1),
      equipmentId: it.equipmentId || '',
      equipmentName: it.equipmentName.trim(),
      assetNumber: it.assetNumber.trim(),
      symptom: it.symptom.trim(),
      responsiblePerson: it.responsiblePerson?.trim() || me.name,
    })),

    notes: input.notes?.trim() || '',
    createdAt: serverTimestamp(),
    createdBy: me.email,
    createdByName: me.name,
    updatedAt: serverTimestamp(),
    updatedBy: me.email,
  };

  if (input.relatedRequestId) {
    newTicket.relatedRequestId = input.relatedRequestId;
  }

  // 1. บันทึกลง collection repair_requests
  await setDoc(doc(db, 'repair_requests', ticketNo), newTicket);

  // 2. ปรับสถานะครุภัณฑ์ในรายการเป็น MAINTENANCE (ซ่อมบำรุง) ทันที
  for (const it of input.items) {
    if (it.equipmentId) {
      try {
        await updateDoc(doc(db, 'equipments', it.equipmentId), {
          status: 'MAINTENANCE',
          updatedAt: serverTimestamp(),
        });
      } catch (eqErr) {
        console.warn(`Could not update equipment ${it.equipmentId} status:`, eqErr);
      }
    }
  }

  // 3. บันทึก Audit Trail
  logAudit(
    'CREATE_REPAIR_REQUEST',
    ticketNo,
    `สร้างใบแจ้งซ่อมเลขที่ ${ticketNo} สถานะ: ${status} จำนวน ${input.items.length} รายการ`,
    me,
    customDb
  ).catch((e) => console.warn('Audit error:', e));

  // 4. ส่ง Email แจ้งเตือนเมื่อสร้างและส่งตรวจทันที (PENDING_REVIEW)
  if (status === 'PENDING_REVIEW') {
    notifyRepairPendingReview(newTicket as unknown as RepairRequest, customDb).catch((e) =>
      console.warn('Repair pending review notification error:', e)
    );
  }

  return ticketNo;
}

/** แก้ไขร่างใบแจ้งซ่อม (เฉพาะสถานะ DRAFT หรือ PENDING_REVIEW ก่อนอนุมัติ) */
export async function updateRepairDraft(
  ticketNo: string,
  patch: Partial<CreateRepairInput>,
  me: AppUser,
  customDb?: any
): Promise<void> {
  if (me.role !== 'CUSTODIAN' && me.role !== 'APPROVER' && me.role !== 'EXECUTIVE') {
    throw new Error('ไม่มีสิทธิ์แก้ไขใบแจ้งซ่อม');
  }

  const db = customDb || fb().db;
  const ref = doc(db, 'repair_requests', ticketNo);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error(`ไม่พบใบแจ้งซ่อมเลขที่ ${ticketNo}`);

  const current = snap.data() as RepairRequest;
  // ป้องกันการแก้ข้อมูลเดิมหลังอนุมัติอย่างเด็ดขาด
  if (current.status !== 'DRAFT' && current.status !== 'PENDING_REVIEW') {
    throw new Error(
      `ไม่สามารถแก้ไขข้อมูลเดิมได้เนื่องจากใบแจ้งซ่อมได้รับการอนุมัติแล้ว (สถานะปัจจุบัน: ${current.status})`
    );
  }

  const updatePayload: Record<string, unknown> = {
    updatedAt: serverTimestamp(),
    updatedBy: me.email,
  };

  if (patch.subject !== undefined) updatePayload.subject = patch.subject.trim();
  if (patch.recipient !== undefined) updatePayload.recipient = patch.recipient.trim();
  if (patch.documentDate !== undefined) {
    updatePayload.documentDate = patch.documentDate;
    const parts = getThaiDateParts(patch.documentDate);
    updatePayload.docDay = parts.day;
    updatePayload.docMonth = parts.month;
    updatePayload.docYear = parts.year;
  }
  if (patch.approverEmail !== undefined) updatePayload.approverEmail = patch.approverEmail;
  if (patch.approverName !== undefined) updatePayload.approverName = patch.approverName.trim();
  if (patch.approverTitle !== undefined) updatePayload.approverTitle = patch.approverTitle.trim();
  if (patch.notes !== undefined) updatePayload.notes = patch.notes.trim();

  if (patch.items) {
    if (patch.items.length === 0) throw new Error('ต้องมีรายการครุภัณฑ์อย่างน้อย 1 รายการ');
    updatePayload.items = patch.items.map((it, idx) => ({
      id: it.id || String(idx + 1),
      equipmentId: it.equipmentId || '',
      equipmentName: it.equipmentName.trim(),
      assetNumber: it.assetNumber.trim(),
      symptom: it.symptom.trim(),
      responsiblePerson: it.responsiblePerson?.trim() || me.name,
    }));

    // Ensure equipments are in MAINTENANCE
    for (const it of patch.items) {
      if (it.equipmentId) {
        try {
          await updateDoc(doc(db, 'equipments', it.equipmentId), {
            status: 'MAINTENANCE',
            updatedAt: serverTimestamp(),
          });
        } catch (e) {
          console.warn('Update eq error:', e);
        }
      }
    }
  }

  await updateDoc(ref, updatePayload);

  logAudit(
    'UPDATE_REPAIR_DRAFT',
    ticketNo,
    `แก้ไขรายละเอียดใบแจ้งซ่อม ${ticketNo}`,
    me,
    customDb
  ).catch((e) => console.warn('Audit error:', e));
}

export interface TransitionRepairOptions {
  comment?: string;
  vendorName?: string;
  laborCost?: number | null;     // ค่าแรง
  partsCost?: number | null;     // ค่าอะไหล่
  serviceCost?: number | null;   // ค่าบริการ
  otherCost?: number | null;     // ค่าใช้จ่ายอื่นๆ
  repairCost?: number | null;    // รวมทั้งสิ้น
  completionDate?: string;
  completionNotes?: string;
  customDb?: any;
}

/** เปลี่ยนสถานะใบแจ้งซ่อมตาม Workflow (ร่าง -> รอตรวจสอบ -> อนุมัติ -> ส่งซ่อม -> ปิดงาน) */
export async function transitionRepairStatus(
  ticketNo: string,
  newStatus: RepairStatus,
  me: AppUser,
  options?: TransitionRepairOptions
): Promise<void> {
  const db = options?.customDb || fb().db;
  const ref = doc(db, 'repair_requests', ticketNo);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error(`ไม่พบใบแจ้งซ่อมเลขที่ ${ticketNo}`);

  const current = snap.data() as RepairRequest;
  const prevStatus = current.status;

  // ป้องกันการแก้ข้อมูลหรือย้อนสถานะหลังอนุมัติ
  if (newStatus === 'DRAFT' || newStatus === 'PENDING_REVIEW') {
    if (prevStatus === 'APPROVED' || prevStatus === 'IN_REPAIR' || prevStatus === 'COMPLETED') {
      throw new Error(`ไม่สามารถย้อนสถานะกลับเป็น ${newStatus} ได้เนื่องจากใบแจ้งซ่อมได้รับการอนุมัติแล้ว`);
    }
  }

  // Authorization and State Machine Validations
  if (newStatus === 'APPROVED') {
    if (me.role !== 'APPROVER' && me.role !== 'EXECUTIVE') {
      throw new Error('เฉพาะผู้อนุมัติ (APPROVER) หรือผู้บริหาร (EXECUTIVE) เท่านั้นที่มีสิทธิ์อนุมัติใบแจ้งซ่อม');
    }
    if (prevStatus !== 'PENDING_REVIEW' && prevStatus !== 'DRAFT') {
      throw new Error(`ไม่สามารถอนุมัติได้จากสถานะ ${prevStatus}`);
    }
  }

  if (newStatus === 'IN_REPAIR') {
    if (me.role !== 'CUSTODIAN' && me.role !== 'APPROVER' && me.role !== 'EXECUTIVE') {
      throw new Error('ไม่มีสิทธิ์ปรับสถานะเป็นส่งซ่อม');
    }
    if (prevStatus !== 'APPROVED' && prevStatus !== 'PENDING_REVIEW') {
      throw new Error(`ไม่สามารถส่งซ่อมได้ ต้องได้รับอนุมัติก่อน (สถานะปัจจุบัน: ${prevStatus})`);
    }
  }

  if (newStatus === 'COMPLETED') {
    if (me.role !== 'CUSTODIAN' && me.role !== 'APPROVER' && me.role !== 'EXECUTIVE') {
      throw new Error('ไม่มีสิทธิ์ปิดงานซ่อม');
    }
    if (prevStatus !== 'IN_REPAIR' && prevStatus !== 'APPROVED') {
      throw new Error(`ไม่สามารถปิดงานได้จากสถานะ ${prevStatus}`);
    }
  }

  const updatePayload: Record<string, unknown> = {
    status: newStatus,
    updatedAt: serverTimestamp(),
    updatedBy: me.email,
  };

  if (newStatus === 'APPROVED') {
    updatePayload.approvedAt = serverTimestamp();
    updatePayload.approverEmail = me.email;
    updatePayload.approverName = me.name;
    updatePayload.approverTitle = me.position || 'ผู้อนุมัติ';
    if (options?.comment) updatePayload.approvalComment = options.comment;
  }

  if (newStatus === 'IN_REPAIR') {
    if (options?.vendorName) updatePayload.vendorName = options.vendorName.trim();
  }

  if (newStatus === 'COMPLETED') {
    updatePayload.completionDate = options?.completionDate || todayStr();
    if (options?.completionNotes) updatePayload.completionNotes = options.completionNotes.trim();
    if (options?.vendorName) updatePayload.vendorName = options.vendorName.trim();

    // บันทึกแยก ค่าแรง / ค่าอะไหล่ / ค่าบริการ / ค่าใช้จ่ายอื่นๆ
    const labor = typeof options?.laborCost === 'number' ? options.laborCost : null;
    const parts = typeof options?.partsCost === 'number' ? options.partsCost : null;
    const service = typeof options?.serviceCost === 'number' ? options.serviceCost : null;
    const other = typeof options?.otherCost === 'number' ? options.otherCost : null;

    if (labor !== null) updatePayload.laborCost = labor;
    if (parts !== null) updatePayload.partsCost = parts;
    if (service !== null) updatePayload.serviceCost = service;
    if (other !== null) updatePayload.otherCost = other;

    // คำนวณยอดรวมค่าซ่อมทั้งหมด
    let total = typeof options?.repairCost === 'number' ? options.repairCost : null;
    if (total === null && (labor !== null || parts !== null || service !== null || other !== null)) {
      total = (labor || 0) + (parts || 0) + (service || 0) + (other || 0);
    }
    if (total !== null) updatePayload.repairCost = total;

    // สำคัญ: เมื่อปิดงาน (COMPLETED) ให้ปรับสถานะครุภัณฑ์ทั้งหมดในตั๋วกลับเป็น AVAILABLE (ว่างพร้อมใช้งาน) ทันที
    for (const it of current.items || []) {
      if (it.equipmentId) {
        try {
          await updateDoc(doc(db, 'equipments', it.equipmentId), {
            status: 'AVAILABLE',
            note: `ซ่อมบำรุงเสร็จสิ้นตามใบแจ้งซ่อม ${ticketNo} วันที่ ${options?.completionDate || todayStr()}`,
            updatedAt: serverTimestamp(),
          });
        } catch (e) {
          console.warn(`Failed to update equipment ${it.equipmentId} to AVAILABLE:`, e);
        }
      }
    }
  }

  if (newStatus === 'CANCELLED') {
    // หากยกเลิก ปรับสถานะครุภัณฑ์กลับเป็น AVAILABLE
    for (const it of current.items || []) {
      if (it.equipmentId) {
        try {
          await updateDoc(doc(db, 'equipments', it.equipmentId), {
            status: 'AVAILABLE',
            updatedAt: serverTimestamp(),
          });
        } catch (e) {
          console.warn(`Failed to revert equipment ${it.equipmentId}:`, e);
        }
      }
    }
  }

  await updateDoc(ref, updatePayload);

  logAudit(
    'TRANSITION_REPAIR_STATUS',
    ticketNo,
    `เปลี่ยนสถานะใบแจ้งซ่อม ${ticketNo} จาก ${prevStatus} เป็น ${newStatus} ${options?.comment ? `(หมายเหตุ: ${options.comment})` : ''}`,
    me,
    options?.customDb
  ).catch((e) => console.warn('Audit error:', e));

  // ส่ง Email แจ้งเตือนผ่าน Google Apps Script Webhook เดิม (dispatchMailJobDirect ไม่ส่งจริงในเทสต์)
  const fullTicketData = { ...current, ...updatePayload } as RepairRequest;
  if (newStatus === 'PENDING_REVIEW') {
    notifyRepairPendingReview(fullTicketData, db).catch((e) =>
      console.warn('Pending review email notice:', e)
    );
  } else if (newStatus === 'APPROVED') {
    notifyRepairApproved(fullTicketData, me.name, db).catch((e) =>
      console.warn('Approved email notice:', e)
    );
  } else if (newStatus === 'COMPLETED') {
    notifyRepairCompleted(fullTicketData, db).catch((e) =>
      console.warn('Completed email notice:', e)
    );
  }
}
