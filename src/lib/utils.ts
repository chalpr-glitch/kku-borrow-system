import type { Timestamp } from 'firebase/firestore';
import type { BorrowRequest, Equipment, EquipmentBooking, EquipmentStatus, RequestStatus, Role } from './types';

/** ยืมได้สูงสุดครั้งละกี่วัน (นับรวมวันยืมและวันคืน) ตามระเบียบปกติ */
export const MAX_BORROW_DAYS = 15;

/** เพดานเด็ดขาดสูงสุดรวมทุกกรณีและรวมการต่ออายุทั้งหมด (นับจากวันเริ่มยืมเดิม) */
export const MAX_TOTAL_DAYS = 30;

/** สถานะที่ถือว่า "ยังถือครอง/จองครุภัณฑ์อยู่" ใช้ตรวจช่วงวันชนกัน */
export const ACTIVE_STATUSES: RequestStatus[] = [
  'PENDING_REVIEW',
  'PENDING_APPROVAL',
  'APPROVED_WAITING_PICKUP',
  'IN_USE',
  'OVERDUE',
];

export const CANCELLABLE_STATUSES: RequestStatus[] = [
  'PENDING_REVIEW',
  'PENDING_APPROVAL',
  'APPROVED_WAITING_PICKUP',
];

export const STATUS_META: Record<RequestStatus, { label: string; cls: string }> = {
  PENDING_REVIEW: { label: 'รอตรวจสอบ', cls: 'bg-amber-50 text-amber-900 border-amber-200' },
  REVIEW_REJECTED: { label: 'ตรวจสอบแล้ว: ยืมไม่ได้', cls: 'bg-rose-50 text-rose-900 border-rose-200' },
  PENDING_APPROVAL: { label: 'รออนุมัติ', cls: 'bg-sky-50 text-sky-900 border-sky-200' },
  REJECTED: { label: 'ไม่อนุมัติ', cls: 'bg-rose-50 text-rose-900 border-rose-200' },
  APPROVED_WAITING_PICKUP: { label: 'อนุมัติแล้ว รอรับของ', cls: 'bg-indigo-50 text-indigo-900 border-indigo-200' },
  CANCELLED: { label: 'ยกเลิก', cls: 'bg-slate-100 text-slate-700 border-slate-200' },
  IN_USE: { label: 'กำลังใช้งาน', cls: 'bg-emerald-50 text-emerald-900 border-emerald-200' },
  OVERDUE: { label: 'เกินกำหนดคืน', cls: 'bg-rose-600 text-white border-rose-700 shadow-xs' },
  RETURNED: { label: 'คืนแล้ว', cls: 'bg-slate-50 text-slate-700 border-slate-200' },
  RETURNED_DAMAGED: { label: 'คืนแล้ว (ชำรุด)', cls: 'bg-orange-50 text-orange-900 border-orange-200' },
  LOST: { label: 'สูญหาย', cls: 'bg-slate-800 text-white border-slate-900 shadow-xs' },
};

export const EQUIPMENT_STATUS_META: Record<EquipmentStatus, { label: string; cls: string }> = {
  AVAILABLE: { label: 'พร้อมใช้งาน', cls: 'bg-[#155E53] text-white border-[#155E53]' },
  BORROWED: { label: 'ถูกยืม', cls: 'bg-slate-100 text-slate-800 border-slate-200' },
  MAINTENANCE: { label: 'อยู่ระหว่างซ่อมบำรุง', cls: 'bg-amber-100 text-amber-900 border-amber-200' },
  LOST: { label: 'สูญหาย', cls: 'bg-slate-900 text-white border-slate-900 shadow-xs' },
  RETIRED: { label: 'จำหน่าย/เลิกใช้', cls: 'bg-slate-100 text-slate-500 border-slate-200' },
};

export const ROLE_LABEL: Record<Role, string> = {
  USER: 'บุคลากร',
  CUSTODIAN: 'ผู้ดูแลอุปกรณ์',
  APPROVER: 'ผู้อนุมัติ',
  EXECUTIVE: 'ผู้บริหาร',
};

export const DEFAULT_CATEGORIES = [
  { id: 'CAT-COMPUTER', name: 'คอมพิวเตอร์และโน้ตบุ๊ก' },
  { id: 'CAT-PROJECTOR', name: 'เครื่องฉายภาพและจอโปรเจกเตอร์' },
  { id: 'CAT-CAMERA', name: 'กล้องถ่ายภาพและวิดีโอ' },
  { id: 'CAT-AUDIO', name: 'อุปกรณ์ระบบเสียงและไมโครโฟน' },
  { id: 'CAT-ACCESSORY', name: 'อุปกรณ์เสริมและสายสัญญาณ' },
  { id: 'CAT-OTHER', name: 'ครุภัณฑ์อื่นๆ' },
] as const;

/** วันที่วันนี้ตามเวลาประเทศไทย รูปแบบ YYYY-MM-DD */
export function todayStr(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date());
}

export function addDays(s: string, n: number): string {
  const d = new Date(`${s}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** ตรวจสอบว่าเป็นวันหยุดเสาร์-อาทิตย์ หรือไม่ */
export function isWeekend(s: string): boolean {
  const d = new Date(`${s}T00:00:00Z`);
  const day = d.getUTCDay(); // 0 = Sun, 6 = Sat
  return day === 0 || day === 6;
}

/** เพิ่มจำนวนวันทำการ (ข้ามวันเสาร์-อาทิตย์ โดยนับ startStr เป็นวันทำการที่ 1 หากไม่ใช่วันหยุด) */
export function addBusinessDays(startStr: string, businessDaysCount: number): string {
  if (businessDaysCount <= 1) return startStr;
  let current = startStr;
  let added = isWeekend(current) ? 0 : 1;

  while (added < businessDaysCount) {
    current = addDays(current, 1);
    if (!isWeekend(current)) {
      added++;
    }
  }
  return current;
}

/** จำนวนวันนับรวมทั้งวันเริ่มและวันสิ้นสุด */
export function daysInclusive(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000) + 1;
}

/** อีกกี่วันจะถึงวันที่ s (ติดลบ = เลยมาแล้ว) */
export function daysUntil(s: string): number {
  return daysInclusive(todayStr(), s) - 1;
}

export function overlaps(a1: string, a2: string, b1: string, b2: string): boolean {
  return a1 <= b2 && b1 <= a2;
}

export function fmtDate(s?: string | null): string {
  if (!s) return '-';
  const parts = s.trim().split('-');
  if (parts.length === 3) {
    const y = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10) - 1;
    const d = parseInt(parts[2], 10);
    if (!isNaN(y) && !isNaN(m) && !isNaN(d)) {
      const date = new Date(y, m, d);
      return date.toLocaleDateString('th-TH', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      });
    }
  }
  return s;
}

export function fmtTs(ts?: Timestamp | null): string {
  if (!ts || typeof (ts as Timestamp).toDate !== 'function') return '-';
  return ts.toDate().toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' });
}

export function tsMillis(ts?: Timestamp | null): number {
  if (!ts || typeof (ts as Timestamp).toMillis !== 'function') return Date.now();
  return ts.toMillis();
}

export function sortByCreatedDesc<T extends { createdAt?: Timestamp }>(list: T[]): T[] {
  return [...list].sort((a, b) => tsMillis(b.createdAt) - tsMillis(a.createdAt));
}

/** คำขออื่นที่ยัง active และช่วงวันซ้อนกับช่วงที่ระบุ */
export function findConflicts(
  all: BorrowRequest[],
  equipmentId: string,
  start: string,
  end: string,
  excludeId?: string,
): BorrowRequest[] {
  return all.filter(
    (r) =>
      r.id !== excludeId &&
      r.equipment.equipmentId === equipmentId &&
      ACTIVE_STATUSES.includes(r.status) &&
      overlaps(start, end, r.startDate, r.expectedReturnDate),
  );
}

/** ตรวจสอบตารางการจองจาก collection equipment_bookings ที่ไม่มี PII */
export function findBookingConflicts(
  bookings: EquipmentBooking[],
  equipmentId: string,
  start: string,
  end: string,
  excludeRequestId?: string,
): EquipmentBooking[] {
  return bookings.filter(
    (b) =>
      b.requestId !== excludeRequestId &&
      b.equipmentId === equipmentId &&
      b.status === 'ACTIVE' &&
      overlaps(start, end, b.startDate, b.expectedReturnDate),
  );
}

/** ตรวจสอบว่าครุภัณฑ์พร้อมให้ยืมหรือจองหรือไม่ (ต้องเป็นสถานะ AVAILABLE เท่านั้น) */
export function isEquipmentAvailable(
  eq: { status?: EquipmentStatus | string; isDeleted?: boolean } | null | undefined
): boolean {
  if (!eq || eq.isDeleted) return false;
  return eq.status === 'AVAILABLE';
}

/** ตรวจสอบความพร้อมของครุภัณฑ์อย่างละเอียด พร้อมเหตุผลปฏิเสธการยืม/จอง */
export function validateEquipmentAvailability(
  eq: { status?: EquipmentStatus | string; isDeleted?: boolean; name?: string } | null | undefined
): { available: boolean; reason?: string; status: EquipmentStatus | 'DELETED' | 'UNKNOWN' } {
  if (!eq || eq.isDeleted) {
    return { available: false, reason: 'ไม่พบข้อมูลครุภัณฑ์หรือครุภัณฑ์ถูกลบออกจากระบบแล้ว', status: 'DELETED' };
  }
  if (eq.status !== 'AVAILABLE') {
    let reason = 'ครุภัณฑ์ไม่พร้อมให้ยืม';
    if (eq.status === 'MAINTENANCE') {
      reason = 'ครุภัณฑ์อยู่ระหว่างซ่อมบำรุง ไม่สามารถยืมหรือจองล่วงหน้าได้';
    } else if (eq.status === 'BORROWED') {
      reason = 'ครุภัณฑ์ถูกยืมใช้งานอยู่ ไม่สามารถยืมหรือจองล่วงหน้าได้จนกว่าจะส่งคืน';
    } else if (eq.status === 'LOST') {
      reason = 'ครุภัณฑ์สูญหาย ไม่สามารถทำรายการได้';
    } else if (eq.status === 'RETIRED') {
      reason = 'ครุภัณฑ์จำหน่ายแล้ว ไม่สามารถทำรายการได้';
    }
    return { available: false, reason, status: (eq.status as EquipmentStatus) || 'UNKNOWN' };
  }
  return { available: true, status: 'AVAILABLE' };
}

export interface ActiveBorrowInfo {
  isBorrowed: boolean;
  startDate?: string;
  expectedReturnDate?: string;
  daysRemaining?: number;
  isOverdue?: boolean;
  requestId?: string;
}

/** ดึงข้อมูลช่วงเวลาการถูกยืมของอุปกรณ์ (สำหรับอุปกรณ์ที่มีสถานะถูกยืม หรือมี active bookings) */
export function getActiveBorrowInfo(
  equipment: Equipment,
  requests?: BorrowRequest[],
  today: string = todayStr(),
): ActiveBorrowInfo {
  const isStatusBorrowed = equipment.status === 'BORROWED';

  // 1. ตรวจสอบจาก requests หากมีส่งเข้ามา
  if (requests && requests.length > 0) {
    const activeReq = requests.find(
      (r) =>
        (r.equipment?.equipmentId === equipment.id || (r.equipment as any)?.id === equipment.id) &&
        ['IN_USE', 'OVERDUE'].includes(r.status),
    );
    if (activeReq) {
      const d = daysUntil(activeReq.expectedReturnDate);
      return {
        isBorrowed: true,
        startDate: activeReq.startDate,
        expectedReturnDate: activeReq.expectedReturnDate,
        daysRemaining: d,
        isOverdue: d < 0,
        requestId: activeReq.id,
      };
    }
  }

  // 2. ตรวจสอบจาก activeBookings บนอุปกรณ์
  const activeBookings = (equipment.activeBookings || []).filter((b) => b.status === 'ACTIVE');
  if (activeBookings.length > 0) {
    const current =
      activeBookings.find((b) => b.startDate <= today && b.expectedReturnDate >= today) ||
      activeBookings.find((b) => b.startDate <= today) ||
      (isStatusBorrowed ? activeBookings[0] : undefined);

    if (current) {
      const d = daysUntil(current.expectedReturnDate);
      return {
        isBorrowed: true,
        startDate: current.startDate,
        expectedReturnDate: current.expectedReturnDate,
        daysRemaining: d,
        isOverdue: d < 0,
        requestId: current.requestId,
      };
    }
  }

  return {
    isBorrowed: isStatusBorrowed,
  };
}

type Cell = string | number | null | undefined;

/** ป้องกัน CSV Formula Injection และแปลงค่าให้ปลอดภัย */
export function sanitizeCsvCell(v: Cell): string {
  if (v == null) return '';
  let s = String(v);
  // ป้องกัน CSV Injection (สูตรเริ่มต้นด้วย =, +, -, @, \t, \r)
  if (/^[=+\-@\t\r]/.test(s)) {
    s = `'${s}`;
  }
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function downloadCsv(filename: string, rows: Cell[][]) {
  // BOM \uFEFF ทำให้โปรแกรม Excel อ่านภาษาไทยได้อย่างถูกต้อง
  const csv = '\uFEFF' + rows.map((r) => r.map(sanitizeCsvCell).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** CSV parser แบบรองรับเครื่องหมายคำพูด */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let inQ = false;
  const src = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQ) {
      if (c === '"' && src[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') inQ = false;
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') {
      row.push(cur);
      cur = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cur);
      rows.push(row);
      row = [];
      cur = '';
    } else cur += c;
  }
  if (cur !== '' || row.length) {
    row.push(cur);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

export function errMsg(e: unknown): string {
  if (e instanceof Error) {
    if (e.message.includes('permission')) return 'ไม่มีสิทธิ์ดำเนินการ (permission denied)';
    return e.message;
  }
  return String(e);
}

/** ทำความสะอาดข้อความเพื่อป้องกัน XSS ใน HTML Email หรือการ Render ข้อมูลผู้ใช้ */
export function escapeHtml(str: unknown): string {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/** ตรวจสอบ URL เพื่อป้องกัน Open Redirect */
export function validateReturnUrl(target?: string | null): string {
  if (!target || target === '/' || target.startsWith('/login')) return '/';
  try {
    const decoded = decodeURIComponent(target);
    if (
      !decoded.startsWith('/') ||
      decoded.startsWith('//') ||
      decoded.startsWith('/\\') ||
      decoded.includes('://') ||
      decoded.startsWith('/login')
    ) {
      return '/';
    }
    const [path, queryStr] = decoded.split('?');
    const normalizedPath = path.endsWith('/') ? path : `${path}/`;
    return queryStr ? `${normalizedPath}?${queryStr}` : normalizedPath;
  } catch {
    return '/';
  }
}
