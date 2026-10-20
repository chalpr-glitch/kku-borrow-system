'use client';

import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import {
  Clock,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Package,
  Layers,
  Calendar,
  User,
  ArrowRight,
  Loader2,
  ShieldAlert,
  WifiOff,
  RotateCcw,
  Sparkles,
} from 'lucide-react';
import type { BorrowRequest, EquipmentStatus, RequestStatus, TimelineEntry } from '@/lib/types';
import { EQUIPMENT_STATUS_META, STATUS_META, daysUntil, fmtDate, fmtTs } from '@/lib/utils';

/* ============================================================
   1. Status & Equipment Badges (Icon + Text, WCAG 2.2 AA Contrast)
   ============================================================ */
export function StatusBadge({ status }: { status: RequestStatus }) {
  const m = STATUS_META[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1 text-xs sm:text-sm font-bold shadow-2xs border ${m.cls}`}
    >
      <span className="h-2 w-2 rounded-full bg-current opacity-80" aria-hidden="true" />
      <span>{m.label}</span>
    </span>
  );
}

export function EquipmentBadge({ status, deleted }: { status: EquipmentStatus; deleted?: boolean }) {
  if (deleted) {
    return (
      <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-lg bg-slate-100 border border-slate-300 px-2.5 py-1 text-xs font-bold text-slate-600">
        <span className="h-1.5 w-1.5 rounded-full bg-slate-400" aria-hidden="true" />
        <span>ถูกลบ</span>
      </span>
    );
  }
  const m = EQUIPMENT_STATUS_META[status];
  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-lg px-2.5 py-1 text-xs font-bold shadow-2xs border ${m.cls}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current opacity-80" aria-hidden="true" />
      <span>{m.label}</span>
    </span>
  );
}

export function DueHint({ r }: { r: BorrowRequest }) {
  if (!['IN_USE', 'OVERDUE'].includes(r.status)) return null;
  const d = daysUntil(r.expectedReturnDate);
  if (d < 0) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-rose-100 border border-rose-300 px-2.5 py-0.5 text-xs font-bold text-rose-800 shadow-2xs">
        <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" /> เกินกำหนด {-d} วัน
      </span>
    );
  }
  if (d === 0) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 border border-amber-300 px-2.5 py-0.5 text-xs font-bold text-amber-900 shadow-2xs">
        <Clock className="h-3.5 w-3.5" aria-hidden="true" /> ครบกำหนดวันนี้
      </span>
    );
  }
  if (d <= 3) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 border border-amber-200 px-2.5 py-0.5 text-xs font-semibold text-amber-800">
        <Clock className="h-3.5 w-3.5" aria-hidden="true" /> อีก {d} วันครบกำหนด
      </span>
    );
  }
  return <span className="text-xs text-slate-500 font-medium">อีก {d} วัน</span>;
}

export function ExtensionBadge({ status }: { status?: string | null }) {
  if (!status) return null;
  if (status === 'PENDING_REVIEW') {
    return (
      <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-amber-100 border border-amber-300 px-2.5 py-0.5 text-xs font-bold text-amber-900 shadow-2xs">
        <Clock className="h-3 w-3" /> รอตรวจต่ออายุ
      </span>
    );
  }
  if (status === 'PENDING_APPROVAL') {
    return (
      <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-sky-100 border border-sky-300 px-2.5 py-0.5 text-xs font-bold text-sky-900 shadow-2xs">
        <Clock className="h-3 w-3" /> รออนุมัติต่ออายุ
      </span>
    );
  }
  if (status === 'APPROVED') {
    return (
      <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-emerald-100 border border-emerald-300 px-2.5 py-0.5 text-xs font-bold text-emerald-900 shadow-2xs">
        <CheckCircle2 className="h-3 w-3" /> ต่ออายุแล้ว
      </span>
    );
  }
  if (status === 'REJECTED') {
    return (
      <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-rose-100 border border-rose-300 px-2.5 py-0.5 text-xs font-bold text-rose-900 shadow-2xs">
        <XCircle className="h-3 w-3" /> ไม่อนุมัติต่ออายุ
      </span>
    );
  }
  return null;
}

export function ExceptionBadge({ isException }: { isException?: boolean }) {
  if (!isException) return null;
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-purple-100 border border-purple-300 px-2.5 py-0.5 text-xs font-bold text-purple-900 shadow-2xs">
      <Sparkles className="h-3 w-3" /> กรณีพิเศษ &gt;15 วัน
    </span>
  );
}

/* ============================================================
   2. System States (Loading, Empty, Error, Unauthorized, Offline)
   ============================================================ */

/** 1. Loading State */
export function LoadingState({
  text = 'กำลังโหลดข้อมูล...',
  className = 'py-16',
}: {
  text?: string;
  className?: string;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex flex-col items-center justify-center gap-3 text-center ${className}`}
    >
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-600 border border-emerald-100 shadow-xs">
        <Loader2 className="h-6 w-6 animate-spin" aria-hidden="true" />
      </div>
      <span className="text-base font-semibold text-slate-700">{text}</span>
    </div>
  );
}

/** Skeleton Card Grid for Catalog and Equipment */
export function SkeletonGrid({ count = 6 }: { count?: number }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 animate-pulse" aria-hidden="true">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="card p-5 space-y-4 border-slate-200 bg-white">
          <div className="flex items-center justify-between">
            <div className="h-5 w-24 bg-slate-200 rounded-lg" />
            <div className="h-5 w-16 bg-slate-200 rounded-full" />
          </div>
          <div className="space-y-2">
            <div className="h-6 w-3/4 bg-slate-200 rounded-md" />
            <div className="h-4 w-1/2 bg-slate-100 rounded-md" />
          </div>
          <div className="pt-2 border-t border-slate-100 flex items-center justify-between">
            <div className="h-4 w-20 bg-slate-100 rounded" />
            <div className="h-8 w-24 bg-slate-200 rounded-xl" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Skeleton Table for Review, Approve, and Requests */
export function TableSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="card p-0 overflow-hidden border border-slate-200 bg-white animate-pulse" aria-hidden="true">
      <div className="border-b border-slate-200 bg-slate-50/80 px-4 py-3 flex gap-4">
        <div className="h-4 w-24 bg-slate-200 rounded" />
        <div className="h-4 w-32 bg-slate-200 rounded hidden sm:block" />
        <div className="h-4 w-40 bg-slate-200 rounded hidden md:block" />
        <div className="h-4 w-20 bg-slate-200 rounded ml-auto" />
      </div>
      <div className="divide-y divide-slate-100">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="px-4 py-3.5 flex items-center gap-4">
            <div className="h-4 w-28 bg-slate-200 rounded" />
            <div className="h-4 w-36 bg-slate-100 rounded hidden sm:block" />
            <div className="h-4 w-48 bg-slate-100 rounded hidden md:block" />
            <div className="h-6 w-20 bg-slate-200 rounded-full ml-auto" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** 2. Empty State */
export function EmptyState({
  title = 'ไม่พบข้อมูล',
  description,
  icon: Icon = Package,
  action,
}: {
  title?: string;
  description?: string;
  icon?: React.ComponentType<{ className?: string }>;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-3xl border border-dashed border-slate-200 bg-white/80 p-10 text-center shadow-xs backdrop-blur-xs">
      <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-3xl bg-emerald-50 text-emerald-600 border border-emerald-100 shadow-xs">
        <Icon className="h-8 w-8" aria-hidden="true" />
      </div>
      <h3 className="font-heading text-lg sm:text-xl font-bold text-slate-800">{title}</h3>
      {description && (
        <p className="mt-1.5 text-sm sm:text-base text-slate-500 max-w-md mx-auto leading-relaxed font-medium">
          {description}
        </p>
      )}
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}

export function Empty({ text }: { text: string }) {
  return <EmptyState title={text} />;
}

/** 3. Error State */
export function ErrorState({
  title = 'เกิดข้อผิดพลาดในการโหลดข้อมูล',
  message,
  onRetry,
}: {
  title?: string;
  message?: string;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="rounded-3xl border border-rose-200 bg-rose-50/90 p-8 text-center shadow-xs"
    >
      <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-rose-100 text-rose-600 border border-rose-200">
        <XCircle className="h-7 w-7" aria-hidden="true" />
      </div>
      <h3 className="font-heading text-lg font-bold text-rose-900">{title}</h3>
      {message && <p className="mt-1 text-sm text-rose-700">{message}</p>}
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="btn-danger mt-4 text-sm min-h-[40px] px-4 py-2"
        >
          <RotateCcw className="h-4 w-4" /> ลองใหม่อีกครั้ง
        </button>
      )}
    </div>
  );
}

/** 4. Unauthorized State */
export function UnauthorizedState({
  title = 'ไม่มีสิทธิ์เข้าถึงหน้านี้',
  description = 'หน้านี้สงวนไว้เฉพาะสำหรับเจ้าหน้าที่หรือผู้บริหารที่ได้รับมอบหมาย',
}: {
  title?: string;
  description?: string;
}) {
  return (
    <div className="card text-center py-16 space-y-4 max-w-lg mx-auto my-8">
      <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-3xl bg-amber-50 text-amber-600 border border-amber-200">
        <ShieldAlert className="h-8 w-8" aria-hidden="true" />
      </div>
      <h2 className="font-heading text-xl font-bold text-slate-900">{title}</h2>
      <p className="text-base text-slate-600 leading-relaxed">{description}</p>
      <div className="pt-2 flex justify-center gap-3">
        <Link href="/" className="btn-primary">
          ← กลับหน้าหลัก
        </Link>
      </div>
    </div>
  );
}

/** 5. Offline Banner (Realtime network listener) */
export function OfflineBanner() {
  const [isOffline, setIsOffline] = useState(false);

  useEffect(() => {
    const handleOnline = () => setIsOffline(false);
    const handleOffline = () => setIsOffline(true);

    if (typeof window !== 'undefined') {
      setIsOffline(!navigator.onLine);
      window.addEventListener('online', handleOnline);
      window.addEventListener('offline', handleOffline);
    }
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  if (!isOffline) return null;

  return (
    <div
      role="alert"
      className="sticky top-0 z-50 flex items-center justify-center gap-2 bg-rose-600 px-4 py-2.5 text-center text-sm font-bold text-white shadow-md"
    >
      <WifiOff className="h-4 w-4" aria-hidden="true" />
      <span>คุณกำลังออฟไลน์ โปรดตรวจสอบการเชื่อมต่ออินเทอร์เน็ต</span>
    </div>
  );
}

/** 6. Confirm Dialog */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'ยืนยัน',
  cancelLabel = 'ยกเลิก',
  danger = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-xs p-4"
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-md rounded-3xl bg-white p-6 sm:p-8 shadow-2xl border border-slate-100 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3.5">
          <div
            className={`flex h-12 w-12 items-center justify-center rounded-2xl ${
              danger ? 'bg-rose-100 text-rose-600' : 'bg-emerald-100 text-emerald-700'
            }`}
          >
            {danger ? <AlertTriangle className="h-6 w-6" /> : <CheckCircle2 className="h-6 w-6" />}
          </div>
          <h3 className="font-heading text-lg sm:text-xl font-bold text-slate-900">{title}</h3>
        </div>
        <p className="text-base text-slate-600 leading-relaxed font-medium">{message}</p>
        <div className="flex justify-end gap-3 pt-3">
          <button type="button" className="btn-outline" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={danger ? 'btn-danger' : 'btn-primary'}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   3. Cards, Modals, Tables, Alerts
   ============================================================ */

export function Alert({
  kind = 'error',
  children,
}: {
  kind?: 'error' | 'success' | 'info' | 'warn';
  children: ReactNode;
}) {
  const meta = {
    error: {
      cls: 'border-rose-200 bg-rose-50 text-rose-900',
      icon: XCircle,
      iconCls: 'text-rose-600',
    },
    success: {
      cls: 'border-emerald-200 bg-emerald-50 text-emerald-900',
      icon: CheckCircle2,
      iconCls: 'text-emerald-600',
    },
    info: {
      cls: 'border-sky-200 bg-sky-50 text-sky-900',
      icon: Layers,
      iconCls: 'text-sky-600',
    },
    warn: {
      cls: 'border-amber-200 bg-amber-50 text-amber-950',
      icon: AlertTriangle,
      iconCls: 'text-amber-600',
    },
  }[kind];

  const Icon = meta.icon;

  return (
    <div
      role="alert"
      className={`flex items-start gap-3 rounded-2xl border p-4 text-base font-medium leading-relaxed shadow-2xs ${meta.cls}`}
    >
      <Icon className={`h-5 w-5 flex-shrink-0 mt-0.5 ${meta.iconCls}`} aria-hidden="true" />
      <div className="flex-1">{children}</div>
    </div>
  );
}

export function StatCard({
  label,
  value,
  hint,
  tone = 'emerald',
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: string;
}) {
  const tones: Record<string, { text: string; bg: string; iconBg: string; border: string }> = {
    emerald: {
      text: 'text-emerald-900',
      bg: 'bg-emerald-50/60',
      iconBg: 'bg-emerald-100 text-emerald-700',
      border: 'border-emerald-200/80 hover:border-emerald-400',
    },
    brand: {
      text: 'text-emerald-900',
      bg: 'bg-emerald-50/60',
      iconBg: 'bg-emerald-100 text-emerald-700',
      border: 'border-emerald-200/80 hover:border-emerald-400',
    },
    slate: {
      text: 'text-slate-900',
      bg: 'bg-slate-50/80',
      iconBg: 'bg-slate-100 text-slate-700',
      border: 'border-slate-200 hover:border-slate-300',
    },
    sky: {
      text: 'text-sky-950',
      bg: 'bg-sky-50/60',
      iconBg: 'bg-sky-100 text-sky-700',
      border: 'border-sky-200/80 hover:border-sky-400',
    },
    amber: {
      text: 'text-amber-950',
      bg: 'bg-amber-50/60',
      iconBg: 'bg-amber-100 text-amber-700',
      border: 'border-amber-200/80 hover:border-amber-400',
    },
    purple: {
      text: 'text-purple-950',
      bg: 'bg-purple-50/60',
      iconBg: 'bg-purple-100 text-purple-700',
      border: 'border-purple-200/80 hover:border-purple-400',
    },
    red: {
      text: 'text-rose-950',
      bg: 'bg-rose-50/60',
      iconBg: 'bg-rose-100 text-rose-700',
      border: 'border-rose-200/80 hover:border-rose-400',
    },
  };

  const t = tones[tone] ?? tones.emerald;

  return (
    <div
      className={`rounded-2xl border p-3 sm:p-5 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-xs ${t.bg} ${t.border}`}
    >
      <div className="text-[11px] sm:text-xs font-semibold uppercase tracking-wider text-slate-500 truncate" title={label}>
        {label}
      </div>
      <div className={`mt-1 font-heading text-xl sm:text-3xl font-black tracking-tight ${t.text}`}>
        {value}
      </div>
      {hint && <div className="mt-0.5 text-[11px] sm:text-xs text-slate-600 font-medium truncate">{hint}</div>}
    </div>
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      document.body.style.overflow = originalOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/60 backdrop-blur-xs p-4 md:p-10 transition-opacity"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-2xl rounded-3xl bg-white shadow-2xl border border-slate-100 overflow-hidden my-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-100 px-6 py-4.5 bg-emerald-50/40">
          <h2 className="font-heading text-lg font-bold text-slate-900">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="flex h-9 w-9 items-center justify-center rounded-xl text-slate-500 hover:bg-emerald-100/60 hover:text-emerald-900 transition focus-visible:ring-2 focus-visible:ring-emerald-500"
            aria-label="ปิดหน้าต่าง"
          >
            ✕
          </button>
        </div>
        <div className="p-6">{children}</div>
      </div>
    </div>
  );
}

export function RequestTable({
  requests,
  showBorrower = true,
  empty = 'ไม่มีรายการคำขอ',
}: {
  requests: BorrowRequest[];
  showBorrower?: boolean;
  empty?: string;
}) {
  if (!requests.length) return <EmptyState title={empty} />;
  return (
    <div>
      {/* 1. Mobile Card List (sm:hidden) — สะดวกสำหรับหน้าจอมือถือ ไม่ต้องเลื่อนแนวนอน */}
      <div className="space-y-3 sm:hidden">
        {requests.map((r) => (
          <div
            key={r.id}
            className="rounded-2xl border border-slate-200/90 bg-white p-4 shadow-xs space-y-3"
          >
            <div className="flex items-start justify-between gap-2 border-b border-slate-100 pb-2.5">
              <div>
                <span className="text-[11px] text-slate-500 font-medium">เลขที่คำขอ</span>
                <Link
                  href={`/request/?id=${r.id}`}
                  className="font-mono font-bold text-emerald-800 text-sm block hover:underline"
                >
                  {r.id}
                </Link>
              </div>
              <div className="flex flex-col gap-1 items-end">
                <StatusBadge status={r.status} />
                <ExtensionBadge status={r.extension?.status} />
                <ExceptionBadge isException={r.isException} />
                {['RETURNED', 'RETURNED_DAMAGED', 'LOST'].includes(r.status) && (
                  r.survey ? (
                    <span className="inline-flex items-center text-[10px] font-bold text-amber-700 bg-amber-50 px-2 py-0.5 rounded-full border border-amber-200">
                      ⭐ {r.survey.rating}/5 ประเมินแล้ว
                    </span>
                  ) : (
                    <span className="inline-flex items-center text-[10px] font-bold text-rose-700 bg-rose-50 px-2 py-0.5 rounded-full border border-rose-200">
                      🌟 ยังไม่ได้ประเมิน
                    </span>
                  )
                )}
              </div>
            </div>

            <div className="space-y-1.5 text-xs">
              {showBorrower && (
                <div className="flex items-center justify-between text-slate-700">
                  <span className="text-slate-500">ผู้ยืม:</span>
                  <span className="font-semibold">{r.borrower.name}</span>
                </div>
              )}
              <div className="flex items-start justify-between gap-2">
                <span className="text-slate-500 shrink-0">ครุภัณฑ์:</span>
                <div className="text-right">
                  <div className="font-semibold text-slate-900">{r.equipment.name}</div>
                  <div className="font-mono text-[11px] text-slate-500">{r.equipment.assetNumber}</div>
                </div>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-500">ช่วงวันที่ยืม:</span>
                <div className="text-right font-medium text-slate-800">
                  {fmtDate(r.startDate)} – {fmtDate(r.expectedReturnDate)}
                  <span className="text-slate-500 ml-1">({r.durationDays} วัน)</span>
                </div>
              </div>
              <div className="flex justify-end">
                <DueHint r={r} />
              </div>
            </div>

            <div className="pt-2 border-t border-slate-100 flex flex-col gap-2">
              {['RETURNED', 'RETURNED_DAMAGED', 'LOST'].includes(r.status) && !r.survey && (
                <Link
                  href={`/request/?id=${r.id}&survey=1#survey`}
                  className="btn-primary min-h-[44px] h-11 w-full text-xs font-bold flex items-center justify-center gap-1.5 rounded-xl shadow-xs"
                >
                  <span>⭐ ทำแบบประเมินความพึงพอใจ</span>
                </Link>
              )}
              <Link
                href={`/request/?id=${r.id}`}
                className="btn-outline min-h-[44px] h-11 w-full text-xs font-bold flex items-center justify-center gap-1.5 rounded-xl hover:border-emerald-400"
              >
                <span>ดูรายละเอียดคำขอ</span>
                <ArrowRight className="h-4 w-4 text-emerald-700" />
              </Link>
            </div>
          </div>
        ))}
      </div>

      {/* 2. Desktop & Tablet Table (hidden sm:block) */}
      <div className="hidden sm:block overflow-x-auto rounded-3xl border border-slate-200/80 bg-white shadow-xs">
        <table className="min-w-full divide-y divide-slate-200 text-base">
          <thead>
            <tr>
              <th className="th">เลขที่คำขอ</th>
              {showBorrower && <th className="th">ผู้ยื่นคำขอ</th>}
              <th className="th">ครุภัณฑ์</th>
              <th className="th">ช่วงวันที่ยืม</th>
              <th className="th">สถานะ</th>
              <th className="th text-right">ดำเนินการ</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {requests.map((r) => (
              <tr key={r.id} className="transition hover:bg-emerald-50/30">
                <td className="td font-mono font-bold text-emerald-800">
                  <Link
                    href={`/request/?id=${r.id}`}
                    className="hover:underline focus-visible:ring-2 focus-visible:ring-emerald-500 rounded"
                  >
                    {r.id}
                  </Link>
                </td>
                {showBorrower && (
                  <td className="td">
                    <div className="font-semibold text-slate-900">{r.borrower.name}</div>
                    <div className="text-sm text-slate-500">{r.borrower.mission}</div>
                  </td>
                )}
                <td className="td">
                  <div className="font-semibold text-slate-900">{r.equipment.name}</div>
                  <div className="font-mono text-sm text-slate-500">{r.equipment.assetNumber}</div>
                </td>
                <td className="td whitespace-nowrap">
                  <div className="font-medium text-slate-800">
                    {fmtDate(r.startDate)} – {fmtDate(r.expectedReturnDate)}
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-sm text-slate-500">
                    <span>{r.durationDays} วัน</span>
                    <DueHint r={r} />
                  </div>
                </td>
                <td className="td">
                  <div className="flex flex-col gap-1 items-start">
                    <StatusBadge status={r.status} />
                    <ExtensionBadge status={r.extension?.status} />
                    <ExceptionBadge isException={r.isException} />
                    {['RETURNED', 'RETURNED_DAMAGED', 'LOST'].includes(r.status) && (
                      r.survey ? (
                        <span className="inline-flex items-center text-[11px] font-bold text-amber-700 bg-amber-50 px-2 py-0.5 rounded-full border border-amber-200">
                          ⭐ {r.survey.rating}/5 ประเมินแล้ว
                        </span>
                      ) : (
                        <span className="inline-flex items-center text-[11px] font-bold text-rose-700 bg-rose-50 px-2.5 py-0.5 rounded-full border border-rose-200">
                          🌟 ยังไม่ได้ประเมิน
                        </span>
                      )
                    )}
                  </div>
                </td>
                <td className="td text-right whitespace-nowrap">
                  <div className="flex items-center justify-end gap-2">
                    {['RETURNED', 'RETURNED_DAMAGED', 'LOST'].includes(r.status) && !r.survey && (
                      <Link
                        href={`/request/?id=${r.id}&survey=1#survey`}
                        className="btn-primary text-xs min-h-[38px] px-3.5 py-1.5 rounded-xl font-bold flex items-center gap-1 shadow-xs"
                      >
                        ⭐ ประเมินความพึงพอใจ
                      </Link>
                    )}
                    <Link
                      href={`/request/?id=${r.id}`}
                      className="btn-outline text-xs min-h-[38px] px-3 py-1.5 rounded-xl hover:border-emerald-400 flex items-center gap-1"
                    >
                      รายละเอียด <ArrowRight className="h-3.5 w-3.5 text-emerald-700" />
                    </Link>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function Timeline({ items }: { items: TimelineEntry[] }) {
  return (
    <ol className="relative ml-3 border-l-2 border-emerald-100">
      {items.map((t, i) => {
        const isLatest = i === items.length - 1;
        return (
          <li key={i} className="mb-6 ml-6">
            <span
              className={`absolute -left-[9px] mt-1.5 h-4 w-4 rounded-full border-2 border-white shadow-xs ${
                isLatest ? 'bg-emerald-600 ring-4 ring-emerald-100' : 'bg-slate-400'
              }`}
              aria-hidden="true"
            />
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={t.status} />
              <span className="text-sm font-medium text-slate-500">{fmtTs(t.at)}</span>
            </div>
            <div className="mt-1 text-base text-slate-800">
              โดย <span className="font-semibold text-slate-900">{t.byName}</span>
            </div>
            {t.note && (
              <div className="mt-1.5 rounded-2xl bg-slate-50 p-3 text-sm text-slate-700 border border-slate-200">
                {t.note}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

export function Bar({
  label,
  value,
  max,
  suffix = '',
}: {
  label: string;
  value: number;
  max: number;
  suffix?: string;
}) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="mb-3">
      <div className="flex justify-between text-base">
        <span className="truncate pr-2 font-medium text-slate-700">{label}</span>
        <span className="font-heading font-bold text-slate-900">
          {value}
          {suffix}
        </span>
      </div>
      <div className="mt-1.5 h-3 rounded-full bg-slate-100 overflow-hidden">
        <div
          className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-teal-500 transition-all duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
