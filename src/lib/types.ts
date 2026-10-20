import type { Timestamp } from 'firebase/firestore';

export type Role = 'USER' | 'CUSTODIAN' | 'APPROVER' | 'EXECUTIVE';

export interface AppUser {
  email: string; // doc id (lowercase)
  employeeCode: string;
  departmentCode: string;
  name: string;
  position: string;
  division: string;
  mission: string;
  role: Role;
  title?: string;
  active: boolean;
}

export interface Department {
  id: string;
  code: string;
  name: string;
}

export type EquipmentStatus = 'AVAILABLE' | 'BORROWED' | 'MAINTENANCE' | 'LOST' | 'RETIRED';

export interface Equipment {
  id: string;
  assetNumber: string;
  name: string;
  categoryId: string;
  brand?: string;
  model?: string;
  serialNumber?: string;
  accessories: string[];
  location?: string;
  acquiredDate?: string;
  price?: number | null;
  imageUrl?: string;
  note?: string;
  status: EquipmentStatus;
  isDeleted: boolean;
  deletedAt?: Timestamp | null;
  createdBy?: string;
  activeBookings?: EquipmentBooking[];
  lastBookingUpdatedAt?: Timestamp;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface Category {
  id: string;
  name: string;
  isActive: boolean;
}

export type RequestStatus =
  | 'PENDING_REVIEW'
  | 'REVIEW_REJECTED'
  | 'PENDING_APPROVAL'
  | 'REJECTED'
  | 'APPROVED_WAITING_PICKUP'
  | 'CANCELLED'
  | 'IN_USE'
  | 'OVERDUE'
  | 'RETURNED'
  | 'RETURNED_DAMAGED'
  | 'LOST';

export interface TimelineEntry {
  status: RequestStatus;
  at: Timestamp;
  by: string;
  byName: string;
  note?: string;
}

export interface ReviewChecklist {
  equipmentReady: boolean;
  noDateConflict: boolean;
  noOverdueByBorrower: boolean;
  purposeAppropriate: boolean;
}

export type ReturnCondition = 'NORMAL' | 'DAMAGED' | 'LOST';

export type ExtensionStatus = 'PENDING_REVIEW' | 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'CANCELLED';

export interface ExtensionRequest {
  status: ExtensionStatus;
  requestedAt: Timestamp;
  requestedBy: string;
  requestedByName: string;
  currentExpectedReturnDate: string;
  newExpectedReturnDate: string;
  addedDays: number;
  reason: string;
  isOverdueExtension?: boolean;
  review?: {
    reviewerEmail: string;
    reviewerName: string;
    result: 'PASSED' | 'FAILED';
    reason?: string;
    comment?: string;
    reviewedAt: Timestamp;
  } | null;
  approval?: {
    approverEmail: string;
    approverName: string;
    result: 'APPROVED' | 'REJECTED';
    comment?: string;
    approvedAt: Timestamp;
  } | null;
}

export interface ExtensionHistoryEntry {
  extensionNumber: number;
  previousExpectedReturnDate: string;
  newExpectedReturnDate: string;
  addedDays: number;
  reason: string;
  requestedAt: Timestamp;
  requestedBy: string;
  approvedAt?: Timestamp;
  approvedBy?: string;
  approvedByName?: string;
  approverComment?: string;
  reviewerComment?: string;
  status: 'APPROVED' | 'REJECTED' | 'CANCELLED';
}

export interface DamageReport {
  symptom: string;
  damageDetails?: string;
  cause?: string;
  damagedAccessories?: string[];
  photos?: string[];
}

export interface LostReport {
  incidentDate?: string;
  location?: string;
  incidentDetails: string;
  policeReportNo?: string;
  borrowerLiabilityAccepted?: boolean;
  photos?: string[];
}

export interface ReturnInfo {
  actualReturnDate: string;
  receivedByEmail: string;
  receivedByName: string;
  condition: ReturnCondition;
  remarks?: string;
  lateDays: number;
  receivedAt: Timestamp;
  damageReport?: DamageReport;
  lostReport?: LostReport;
}

export interface BorrowRequest {
  id: string; // = requestNo e.g. BR-202610-0001
  status: RequestStatus;
  borrower: {
    email: string;
    name: string;
    employeeCode: string;
    position: string;
    division: string;
    mission: string;
    departmentCode: string;
  };
  equipment: {
    equipmentId: string;
    assetNumber: string;
    name: string;
  };
  purpose: string;
  location: string;
  startDate: string; // YYYY-MM-DD
  expectedReturnDate: string; // YYYY-MM-DD
  originalExpectedReturnDate?: string; // กำหนดคืนครั้งแรก
  deadlineVersion?: number; // ตัวนับเวอร์ชันกำหนดคืน สำหรับกรองการเตือนเก่า
  durationDays: number;
  isException?: boolean; // ยืมเกิน 15 วันตั้งแต่ต้น (ขอยกเว้นกรณีพิเศษ)
  exceptionReason?: string; // เหตุผลความจำเป็นในการขอยกเว้น
  extension?: ExtensionRequest | null; // คำขอต่ออายุที่กำลังดำเนินการ
  extensionHistory?: ExtensionHistoryEntry[]; // ประวัติการขอต่ออายุ
  review?: {
    reviewerEmail: string;
    reviewerName: string;
    result: 'PASSED' | 'FAILED';
    checklist: ReviewChecklist;
    accessoriesToHandover: string[];
    reason?: string;
    comment?: string;
    reviewedAt: Timestamp;
  } | null;
  approval?: {
    approverEmail: string;
    approverName: string;
    result: 'APPROVED' | 'REJECTED';
    comment?: string;
    approvedAt: Timestamp;
  } | null;
  handover?: {
    custodianEmail: string;
    custodianName: string;
    handoverDate: string;
    accessories: string[];
    conditionNote?: string;
    handedAt: Timestamp;
  } | null;
  returnInfo?: ReturnInfo | null;
  survey?: SatisfactionSurvey | null;
  surveyInviteSentAt?: Timestamp | null;
  surveyInviteQueuedAt?: Timestamp | null;
  surveyInviteStatus?: 'QUEUED' | 'SENT' | 'FAILED' | null;
  surveyInviteCount?: number;
  cancel?: {
    reason?: string;
    cancelledAt: Timestamp;
  } | null;
  termsAccepted?: boolean;
  termsAcceptedAt?: Timestamp;
  timeline: TimelineEntry[];
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export type SurveyFollowUpStatus = 'PENDING_REVIEW' | 'IN_PROGRESS' | 'RESOLVED' | 'NO_ACTION_NEEDED';

export interface SatisfactionSurvey {
  rating: number; // 1 to 5
  tags?: string[]; // e.g. ['อุปกรณ์พร้อมใช้งาน', 'บริการรวดเร็ว', 'ระบบใช้งานง่าย', 'คำแนะนำชัดเจน']
  comment?: string;
  submittedAt: Timestamp;
  submittedBy: string;
  submittedByName?: string;
  // ติดตามความคิดเห็นและข้อเสนอแนะคะแนนต่ำ (rating <= 3)
  needsFollowUp?: boolean;
  followUpStatus?: SurveyFollowUpStatus;
  followUpNotes?: string;
  followUpBy?: string;
  followUpByName?: string;
  followUpAt?: Timestamp | null;
}

export const FOLLOW_UP_STATUS_META: Record<
  SurveyFollowUpStatus,
  { label: string; badgeClass: string; desc: string }
> = {
  PENDING_REVIEW: {
    label: 'รอการติดต่อ/ตรวจสอบ',
    badgeClass: 'bg-amber-100 text-amber-900 border-amber-300',
    desc: 'คะแนนต่ำกว่าเกณฑ์ ต้องการการติดต่อสอบถามผู้ยืมหรือตรวจสอบข้อเท็จจริง',
  },
  IN_PROGRESS: {
    label: 'อยู่ระหว่างประสานงาน',
    badgeClass: 'bg-sky-100 text-sky-900 border-sky-300',
    desc: 'เจ้าหน้าที่กำลังดำเนินการแก้ไข ปรับปรุง หรือประสานหน่วยงานที่เกี่ยวข้อง',
  },
  RESOLVED: {
    label: 'ดำเนินการแก้ไขแล้ว',
    badgeClass: 'bg-emerald-100 text-emerald-900 border-emerald-300',
    desc: 'ดำเนินการปรับปรุงแก้ไขและชี้แจงผู้รับบริการเรียบร้อยแล้ว',
  },
  NO_ACTION_NEEDED: {
    label: 'ไม่ต้องดำเนินการ',
    badgeClass: 'bg-slate-100 text-slate-700 border-slate-200',
    desc: 'ผลการประเมินอยู่ในเกณฑ์ดี หรือไม่มีประเด็นที่ต้องติดตามเพิ่มเติม',
  },
};

export interface EquipmentBooking {
  id?: string;
  equipmentId: string;
  startDate: string;
  expectedReturnDate: string;
  requestId: string;
  status: 'ACTIVE' | 'CANCELLED' | 'RETURNED';
  updatedAt?: Timestamp;
}

/* ============================================================
   Repair Requests (ระบบแจ้งซ่อมแซมครุภัณฑ์)
   ============================================================ */

export type RepairStatus =
  | 'DRAFT'            // ร่าง
  | 'PENDING_REVIEW'   // รอตรวจสอบ
  | 'APPROVED'         // อนุมัติ
  | 'IN_REPAIR'        // ส่งซ่อม
  | 'COMPLETED'        // ปิดงาน
  | 'CANCELLED';       // ยกเลิก

export interface RepairItem {
  id: string;
  equipmentId?: string;
  equipmentName: string;
  assetNumber: string;
  symptom: string;
  responsiblePerson: string;
}

export interface RepairRequest {
  id: string; // e.g. RP-202610-0001
  ticketNo: string;
  status: RepairStatus;
  subject: string;
  recipient: string;
  documentDate: string; // YYYY-MM-DD
  docDay?: string;
  docMonth?: string;
  docYear?: string;

  // Requester (ผู้แจ้งซ่อม / ดึงตามโปรไฟล์ผู้ใช้ปัจจุบัน)
  requesterEmail: string;
  requesterName: string;
  requesterPosition: string;
  requesterDivision: string;

  // Approver (ผู้อนุมัติ)
  approverEmail?: string;
  approverName: string;
  approverTitle: string;
  approvedAt?: Timestamp | null;
  approvalComment?: string;

  // Equipment Items (รายการอุปกรณ์ที่แจ้งซ่อม 1 หรือหลายรายการตามแบบฟอร์ม 5 คอลัมน์)
  items: RepairItem[];

  // Related Borrow Request / Loan ID if originated from return
  relatedRequestId?: string;

  // Cost / Vendor / Tracking details (แยก ค่าแรง / ค่าอะไหล่ / ค่าบริการ / ค่าใช้จ่ายอื่นๆ)
  vendorName?: string;
  laborCost?: number | null;     // ค่าแรง
  partsCost?: number | null;     // ค่าอะไหล่
  serviceCost?: number | null;   // ค่าบริการ
  otherCost?: number | null;     // ค่าใช้จ่ายอื่นๆ
  repairCost?: number | null;    // ยอดรวมค่าใช้จ่ายทั้งหมด
  completionDate?: string;
  completionNotes?: string;

  // Timeline / Notes
  notes?: string;
  createdAt: Timestamp;
  createdBy: string;
  createdByName: string;
  updatedAt: Timestamp;
  updatedBy: string;
}

export const REPAIR_STATUS_META: Record<
  RepairStatus,
  { label: string; badgeClass: string; desc: string }
> = {
  DRAFT: {
    label: 'ร่างเอกสาร',
    badgeClass: 'bg-slate-100 text-slate-800 border-slate-300',
    desc: 'อยู่ระหว่างร่างเอกสาร เจ้าหน้าที่สามารถแก้ไขข้อมูลก่อนส่งตรวจ',
  },
  PENDING_REVIEW: {
    label: 'รอตรวจสอบ',
    badgeClass: 'bg-amber-100 text-amber-900 border-amber-300',
    desc: 'ส่งเอกสารแล้ว รอผู้มีอำนาจตรวจสอบและพิจารณาอนุมัติ',
  },
  APPROVED: {
    label: 'อนุมัติแล้ว',
    badgeClass: 'bg-blue-100 text-blue-900 border-blue-300',
    desc: 'ได้รับการอนุมัติแล้ว พร้อมนำส่งร้านซ่อมหรือผู้รับจ้าง',
  },
  IN_REPAIR: {
    label: 'ส่งซ่อม/ดำเนินการ',
    badgeClass: 'bg-indigo-100 text-indigo-900 border-indigo-300',
    desc: 'อยู่ระหว่างส่งซ่อมบำรุงที่ร้านค้าหรือศูนย์บริการ',
  },
  COMPLETED: {
    label: 'ปิดงานสำเร็จ',
    badgeClass: 'bg-emerald-100 text-emerald-900 border-emerald-300',
    desc: 'ซ่อมแซมเสร็จสิ้น ตรวจรับเรียบร้อย ครุภัณฑ์พร้อมให้บริการต่อ',
  },
  CANCELLED: {
    label: 'ยกเลิก',
    badgeClass: 'bg-rose-100 text-rose-900 border-rose-300',
    desc: 'ยกเลิกรายการแจ้งซ่อมนี้',
  },
};

