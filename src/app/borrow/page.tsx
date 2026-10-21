'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import {
  User,
  Package,
  Calendar,
  MapPin,
  Clock,
  ArrowLeft,
  CheckCircle2,
  AlertTriangle,
  Send,
  Building,
  Mail,
  ShieldCheck,
  FileText,
  HelpCircle,
  Wrench,
} from 'lucide-react';
import AppShell from '@/components/AppShell';
import { Alert, ConfirmDialog, EquipmentBadge, LoadingState } from '@/components/ui';
import { useAuth } from '@/lib/auth-context';
import { useAllRequests, useEquipments } from '@/lib/hooks';
import { createBorrowRequest, validateDates } from '@/lib/requests';
import {
  MAX_BORROW_DAYS,
  getActiveBorrowInfo,
  addBusinessDays,
  addDays,
  daysInclusive,
  errMsg,
  findConflicts,
  fmtDate,
  todayStr,
  isEquipmentAvailable,
  validateEquipmentAvailability,
} from '@/lib/utils';

export default function BorrowPage() {
  return (
    <AppShell title="แบบฟอร์มยื่นคำขอยืมครุภัณฑ์">
      <Suspense fallback={<LoadingState text="กำลังโหลดแบบฟอร์ม..." />}>
        <BorrowForm />
      </Suspense>
    </AppShell>
  );
}

function BorrowForm() {
  const { profile, loading } = useAuth();
  const router = useRouter();
  const eqId = useSearchParams().get('eq') ?? '';
  const { data: equipments, loading: eqLoading } = useEquipments();
  const { data: requests } = useAllRequests();
  const eq = equipments.find((e) => e.id === eqId || e.assetNumber === eqId);

  const today = todayStr();
  const [start, setStart] = useState(today);
  const [end, setEnd] = useState(addDays(today, 3));
  const [purpose, setPurpose] = useState('');
  const [location, setLocation] = useState('');
  const [exceptionReason, setExceptionReason] = useState('');
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [confirmModalOpen, setConfirmModalOpen] = useState(false);

  useEffect(() => {
    if (!confirmModalOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setConfirmModalOpen(false);
    };
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [confirmModalOpen]);

  // Calculate raw duration
  const rawDuration = start && end && start <= end ? daysInclusive(start, end) : 0;
  const isException = rawDuration > MAX_BORROW_DAYS;

  // Date validation & conflict check
  const dateError = validateDates(start, end, {
    isException,
    exceptionReason,
  });
  const duration = start && end && start <= end ? rawDuration : 0;
  const conflicts = useMemo(
    () => (eq && start && end && start <= end ? findConflicts(requests, eq.id, start, end) : []),
    [eq, requests, start, end]
  );
  const borrowInfo = useMemo(() => (eq ? getActiveBorrowInfo(eq, requests, today) : null), [eq, requests, today]);
  const availability = useMemo(() => validateEquipmentAvailability(eq), [eq]);

  // Keep every Hook above loading and missing-equipment returns.
  if (loading || !profile) {
    return <LoadingState text="กำลังโหลดแบบฟอร์ม..." />;
  }

  const me = profile;

  // Quick Date Presets
  const setQuickDates = (type: 'same_day' | 'business_3' | 'week_1' | 'max_15') => {
    setStart(today);
    if (type === 'same_day') {
      setEnd(today);
    } else if (type === 'business_3') {
      setEnd(addBusinessDays(today, 3));
    } else if (type === 'week_1') {
      setEnd(addDays(today, 6));
    } else if (type === 'max_15') {
      setEnd(addDays(today, MAX_BORROW_DAYS - 1));
    }
  };

  if (eqLoading) {
    return <LoadingState text="กำลังโหลดข้อมูลครุภัณฑ์..." />;
  }

  if (!eq || eq.isDeleted) {
    return (
      <div className="card text-center py-16 space-y-4 max-w-lg mx-auto">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-amber-50 text-amber-600 border border-amber-200">
          <AlertTriangle className="h-8 w-8" aria-hidden="true" />
        </div>
        <h2 className="font-heading text-xl font-bold text-slate-900">ไม่พบครุภัณฑ์ที่เลือก</h2>
        <p className="text-base text-slate-600">
          กรุณากลับไปเลือกครุภัณฑ์ใหม่อีกครั้งจากหน้าค้นหาและแค็ตตาล็อก
        </p>
        <div className="pt-2">
          <Link href="/equipment/" className="btn-primary">
            ← กลับไปหน้าเลือกครุภัณฑ์
          </Link>
        </div>
      </div>
    );
  }

  const handlePreSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!availability.available) {
      setError(availability.reason || 'ครุภัณฑ์ไม่พร้อมให้ยืมหรือจอง');
      return;
    }

    const errors: Record<string, string> = {};

    if (dateError) {
      errors.dates = dateError;
    }
    if (conflicts.length > 0) {
      errors.conflicts = 'ช่วงวันดังกล่าวมีผู้ยื่นขอยืมหรือใช้งานอุปกรณ์ชิ้นนี้แล้ว';
    }
    if (isException && !exceptionReason.trim()) {
      errors.exceptionReason = 'กรุณาระบุเหตุผลและความจำเป็นในการขออนุมัติเป็นกรณีพิเศษ (> 15 วัน)';
    }
    if (!purpose.trim()) {
      errors.purpose = 'กรุณาระบุวัตถุประสงค์ในการยืมใช้งาน';
    }
    if (!location.trim()) {
      errors.location = 'กรุณาระบุสถานที่นำไปใช้งาน';
    }
    if (!termsAccepted) {
      errors.terms = 'กรุณากดรับทราบและยินยอมตามข้อตกลงความรับผิดชอบในการยืมครุภัณฑ์';
    }

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      setError('กรุณาตรวจสอบและกรอกข้อมูลในช่องที่จำเป็นให้ครบถ้วน');
      // เลื่อนหน้าจอไปยังช่องแรกที่พบข้อผิดพลาด
      const firstErrorId = errors.dates
        ? 'startDate'
        : errors.exceptionReason
        ? 'exceptionReason'
        : errors.purpose
        ? 'purpose'
        : errors.location
        ? 'location'
        : errors.terms
        ? 'terms-accepted-checkbox'
        : undefined;
      if (firstErrorId && typeof document !== 'undefined') {
        const el = document.getElementById(firstErrorId);
        el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el?.focus();
      }
      return;
    }

    setFieldErrors({});
    setError(null);
    setConfirmModalOpen(true);
  };

  const handleFinalSubmit = async () => {
    if (busy) return; // Prevent double submit
    if (!availability.available) {
      setError(availability.reason || 'ครุภัณฑ์ไม่พร้อมให้ยืมหรือจอง');
      setBusy(false);
      setConfirmModalOpen(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const id = await createBorrowRequest(
        {
          equipment: eq,
          startDate: start,
          expectedReturnDate: end,
          purpose: purpose.trim(),
          location: location.trim(),
          isException,
          exceptionReason: isException ? exceptionReason.trim() : undefined,
        },
        me
      );
      router.push(`/request/?id=${id}`);
    } catch (err) {
      setError(errMsg(err));
      setBusy(false);
      setConfirmModalOpen(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6 sm:space-y-8 pb-4 sm:pb-8">
      {/* Header Breadcrumb & 3-Step Visual Progress */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-2xl bg-white p-4 border border-slate-200/80 shadow-2xs">
        <Link
          href="/equipment/"
          className="inline-flex items-center gap-2 text-sm font-bold text-[#123B68] hover:underline"
        >
          <ArrowLeft className="h-4 w-4" /> เปลี่ยนครุภัณฑ์ / กลับหน้ารายการ
        </Link>
        <div className="flex flex-wrap items-center gap-2 text-xs font-bold">
          <span className="inline-flex items-center gap-1 text-emerald-700">
            <CheckCircle2 className="h-4 w-4" /> 1. เลือกอุปกรณ์
          </span>
          <span className="text-slate-300">→</span>
          <span className="inline-flex items-center gap-1 rounded-full bg-[#123B68] text-white px-3 py-1 shadow-2xs">
            2. กรอกข้อมูลการยืม
          </span>
          <span className="text-slate-300">→</span>
          <span className="text-slate-400">3. ยืนยันคำขอ</span>
        </div>
      </div>

      {error && (
        <Alert kind="error">
          <div className="font-bold text-sm">ข้อผิดพลาด: {error}</div>
        </Alert>
      )}

      {!availability.available && (
        <div className="rounded-2xl p-4 sm:p-5 border bg-amber-50 border-amber-200 text-amber-950 flex flex-col sm:flex-row sm:items-center justify-between gap-3 shadow-xs">
          <div className="flex items-start gap-3">
            {eq.status === 'MAINTENANCE' ? (
              <Wrench className="h-5 w-5 text-amber-700 mt-0.5 shrink-0" />
            ) : (
              <AlertTriangle className="h-5 w-5 text-amber-700 mt-0.5 shrink-0" />
            )}
            <div>
              <div className="font-heading font-bold text-sm sm:text-base">
                {eq.status === 'MAINTENANCE'
                  ? 'อุปกรณ์อยู่ระหว่างซ่อมบำรุง'
                  : eq.status === 'BORROWED'
                  ? 'อุปกรณ์ถูกยืมใช้งานอยู่'
                  : 'อุปกรณ์ไม่พร้อมให้บริการ'}
              </div>
              <p className="text-xs sm:text-sm text-amber-800 mt-0.5">
                {availability.reason} (ระบบไม่อนุญาตให้ยืมหรือจองล่วงหน้าจนกว่าจะส่งคืนหรือซ่อมเสร็จและเปลี่ยนสถานะเป็นพร้อมใช้งาน)
              </p>
            </div>
          </div>
          <Link
            href="/equipment/"
            className="btn-secondary text-xs sm:text-sm shrink-0 whitespace-nowrap self-start sm:self-center"
          >
            ← เลือกครุภัณฑ์อื่น
          </Link>
        </div>
      )}

      {/* 1. Selected Equipment Card */}
      <div className="card bg-[#F5F8FC] border-slate-300/80 p-6">
        <div className="flex flex-col sm:flex-row gap-5 items-start">
          <div className="flex h-24 w-24 flex-shrink-0 items-center justify-center rounded-2xl bg-white border border-slate-200 overflow-hidden shadow-2xs">
            {eq.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={eq.imageUrl} alt={eq.name} className="h-full w-full object-cover" />
            ) : (
              <Package className="h-10 w-10 text-slate-300" aria-hidden="true" />
            )}
          </div>
          <div className="flex-1 space-y-1.5 min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs font-bold text-[#123B68] bg-[#123B68]/10 px-2.5 py-0.5 rounded-md">
                {eq.assetNumber}
              </span>
              <EquipmentBadge status={eq.status} />
            </div>
            <h2 className="font-heading text-xl font-bold text-slate-900 leading-tight">
              {eq.name}
            </h2>
            <p className="text-sm text-slate-600 font-medium">
              {[eq.brand, eq.model, eq.serialNumber && `S/N: ${eq.serialNumber}`]
                .filter(Boolean)
                .join(' · ')}
            </p>
            {eq.accessories && eq.accessories.length > 0 && (
              <p className="text-xs text-slate-500 font-medium">
                อุปกรณ์เสริมที่มาพร้อมกัน: <b>{eq.accessories.join(', ')}</b>
              </p>
            )}

            {borrowInfo?.isBorrowed && (
              <div className="mt-3 rounded-2xl bg-sky-50 border border-sky-200 p-4 space-y-2 text-xs sm:text-sm text-sky-950">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-bold flex items-center gap-1.5 text-sky-900">
                    <Clock className="h-4 w-4 text-sky-700" />
                    <span>ขณะนี้อุปกรณ์นี้มีสถานะ: ถูกยืมใช้งานอยู่</span>
                  </span>
                  {borrowInfo.isOverdue ? (
                    <span className="inline-flex items-center gap-1 text-xs font-bold text-rose-700 bg-rose-100 border border-rose-300 px-2.5 py-0.5 rounded-full">
                      <AlertTriangle className="h-3.5 w-3.5" /> เกินกำหนด {Math.abs(borrowInfo.daysRemaining ?? 0)} วัน
                    </span>
                  ) : borrowInfo.daysRemaining === 0 ? (
                    <span className="inline-flex items-center gap-1 text-xs font-bold text-amber-800 bg-amber-100 border border-amber-300 px-2.5 py-0.5 rounded-full">
                      <Clock className="h-3.5 w-3.5" /> ครบกำหนดส่งคืนวันนี้
                    </span>
                  ) : borrowInfo.daysRemaining != null ? (
                    <span className="text-xs font-semibold text-sky-800 bg-sky-100 border border-sky-200 px-2.5 py-0.5 rounded-full">
                      เหลืออีก {borrowInfo.daysRemaining} วัน
                    </span>
                  ) : null}
                </div>

                <div className="text-xs sm:text-sm text-slate-700 font-medium">
                  • ช่วงเวลาการถูกยืมปัจจุบัน:{' '}
                  <b>
                    {borrowInfo.startDate && borrowInfo.expectedReturnDate
                      ? `${fmtDate(borrowInfo.startDate)} – ${fmtDate(borrowInfo.expectedReturnDate)}`
                      : 'อยู่ระหว่างการยืมใช้งาน'}
                  </b>
                  {borrowInfo.expectedReturnDate && (
                    <span className="text-slate-600"> (กำหนดส่งคืน: <b>{fmtDate(borrowInfo.expectedReturnDate)}</b>)</span>
                  )}
                </div>

                <p className="text-xs text-slate-600 font-normal">
                  💡 คำแนะนำ: หากท่านต้องการใช้งาน ท่านสามารถยื่นคำขอยืมล่วงหน้าได้ โดยระบุวันเริ่มยืมหลังจากวันที่ส่งคืนข้างต้น
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      <form onSubmit={handlePreSubmit} className="space-y-8">
        {/* 2. User Info Card (Auto-filled from Login Profile) */}
        <div className="card space-y-4">
          <div className="flex items-center gap-2 border-b border-slate-100 pb-3">
            <User className="h-5 w-5 text-[#123B68]" aria-hidden="true" />
            <h3 className="font-heading text-lg font-bold text-slate-900">
              1. ข้อมูลผู้ยื่นคำขอยืม (ดึงจากระบบอัตโนมัติ)
            </h3>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 text-base">
            <div className="rounded-xl bg-slate-50 p-3.5 border border-slate-200/80">
              <span className="text-xs text-slate-500 font-semibold uppercase block mb-1">
                ชื่อ-นามสกุล ผู้ยืม
              </span>
              <span className="font-heading font-bold text-slate-900">{me.name}</span>
            </div>

            <div className="rounded-xl bg-slate-50 p-3.5 border border-slate-200/80">
              <span className="text-xs text-slate-500 font-semibold uppercase block mb-1">
                สังกัด / กลุ่มงาน
              </span>
              <span className="font-medium text-slate-900">{me.mission || '-'}</span>
            </div>

            <div className="rounded-xl bg-slate-50 p-3.5 border border-slate-200/80">
              <span className="text-xs text-slate-500 font-semibold uppercase block mb-1">
                อีเมลติดต่อ
              </span>
              <span className="font-mono font-medium text-slate-900">{me.email}</span>
            </div>

            <div className="rounded-xl bg-slate-50 p-3.5 border border-slate-200/80">
              <span className="text-xs text-slate-500 font-semibold uppercase block mb-1">
                รหัสบุคลากร / ตำแหน่ง
              </span>
              <span className="font-mono font-medium text-slate-900">
                {me.employeeCode} · {me.position}
              </span>
            </div>
          </div>
        </div>

        {/* 3. Borrow Duration & Schedule */}
        <div className="card space-y-5">
          <div className="flex items-center justify-between border-b border-slate-100 pb-3">
            <div className="flex items-center gap-2">
              <Calendar className="h-5 w-5 text-[#123B68]" aria-hidden="true" />
              <h3 className="font-heading text-lg font-bold text-slate-900">
                2. กำหนดช่วงเวลาการยืมและคืน
              </h3>
            </div>
            {duration > 0 && (
              <span className="rounded-full bg-[#123B68]/10 px-3 py-1 font-heading text-sm font-bold text-[#123B68]">
                รวม {duration} วัน
              </span>
            )}
          </div>

          {/* Quick Date Presets */}
          <div>
            <span className="label">ปุ่มลัดเลือกช่วงเวลา:</span>
            <div className="flex flex-wrap gap-2 pt-1">
              <button
                type="button"
                onClick={() => setQuickDates('same_day')}
                className="btn-outline min-h-[38px] text-sm px-3.5 py-1.5 font-medium hover:bg-slate-100"
              >
                1 วัน (ส่งคืนวันเดียวกัน)
              </button>
              <button
                type="button"
                onClick={() => setQuickDates('business_3')}
                className="btn-outline min-h-[38px] text-sm px-3.5 py-1.5 font-medium hover:bg-slate-100"
                title="ข้ามวันหยุดเสาร์-อาทิตย์"
              >
                3 วันทำการ (ไม่รวมวันหยุด)
              </button>
              <button
                type="button"
                onClick={() => setQuickDates('week_1')}
                className="btn-outline min-h-[38px] text-sm px-3.5 py-1.5 font-medium hover:bg-slate-100"
              >
                7 วัน (1 สัปดาห์)
              </button>
              <button
                type="button"
                onClick={() => setQuickDates('max_15')}
                className="btn-outline min-h-[38px] text-sm px-3.5 py-1.5 font-medium hover:bg-slate-100 text-brand-700"
              >
                15 วัน (สูงสุดตามระเบียบ)
              </button>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="startDate" className="label">
                วันที่ต้องการเริ่มยืม <span className="text-rose-600">*</span>
              </label>
              <input
                id="startDate"
                type="date"
                className={`input ${fieldErrors.dates ? 'border-rose-400 ring-2 ring-rose-200' : ''}`}
                min={today}
                value={start}
                onChange={(e) => {
                  setStart(e.target.value);
                  if (fieldErrors.dates) setFieldErrors((prev) => ({ ...prev, dates: '' }));
                }}
                required
              />
            </div>

            <div>
              <label htmlFor="endDate" className="label">
                กำหนดส่งคืน {isException ? <span className="text-amber-700 font-bold">(ขอเกิน 15 วันเป็นกรณีพิเศษ)</span> : `(ไม่เกิน ${MAX_BORROW_DAYS} วัน)`} <span className="text-rose-600">*</span>
              </label>
              <input
                id="endDate"
                type="date"
                className={`input ${fieldErrors.dates ? 'border-rose-400 ring-2 ring-rose-200' : ''}`}
                min={start || today}
                value={end}
                onChange={(e) => {
                  setEnd(e.target.value);
                  if (fieldErrors.dates) setFieldErrors((prev) => ({ ...prev, dates: '' }));
                }}
                required
              />
            </div>
          </div>
          {fieldErrors.dates && (
            <p className="text-xs font-semibold text-rose-600 mt-1">⚠️ {fieldErrors.dates}</p>
          )}

          {isException && (
            <div className="rounded-2xl border-2 border-amber-300 bg-amber-50/80 p-4 sm:p-5 space-y-3">
              <div className="flex items-start gap-2.5">
                <AlertTriangle className="h-5 w-5 text-amber-600 mt-0.5 flex-shrink-0" />
                <div className="space-y-1">
                  <div className="font-heading font-bold text-amber-950 text-sm sm:text-base">
                    ขออนุมัติยืมเกินกำหนดปกติเป็นกรณีพิเศษ ({duration} วัน · เกินระเบียบปกติ {duration - MAX_BORROW_DAYS} วัน)
                  </div>
                  <p className="text-xs text-amber-900 leading-relaxed font-medium">
                    ระเบียบการยืมปกติกำหนดไว้ไม่เกิน 15 วัน การขอยืมเกิน 15 วันจะต้องระบุเหตุผลความจำเป็นเพื่อให้ผู้ดูแลครุภัณฑ์และผู้อนุมัติตรวจสอบและพิจารณาเป็นกรณีพิเศษ
                  </p>
                </div>
              </div>

              <div>
                <label htmlFor="exceptionReason" className="label text-amber-950 font-bold">
                  เหตุผลและความจำเป็นในการขอยืมเกิน 15 วัน <span className="text-rose-600">*</span>
                </label>
                <textarea
                  id="exceptionReason"
                  className={`input min-h-[80px] py-2.5 bg-white border-amber-300 focus:border-amber-500 focus:ring-amber-500/20 text-sm ${
                    fieldErrors.exceptionReason ? 'border-rose-400 ring-2 ring-rose-200' : ''
                  }`}
                  placeholder="เช่น โครงการบริการวิชาการต่อเนื่องในพื้นที่ต่างจังหวัดตลอด 1 เดือนเต็ม จำเป็นต้องใช้อุปกรณ์ต่อเนื่อง..."
                  value={exceptionReason}
                  onChange={(e) => {
                    setExceptionReason(e.target.value);
                    if (fieldErrors.exceptionReason) setFieldErrors((prev) => ({ ...prev, exceptionReason: '' }));
                  }}
                  required={isException}
                />
                {fieldErrors.exceptionReason && (
                  <p className="text-xs font-semibold text-rose-600 mt-1">⚠️ {fieldErrors.exceptionReason}</p>
                )}
              </div>
            </div>
          )}

          {conflicts.length > 0 && (
            <div className="rounded-2xl border border-rose-300 bg-rose-50 p-4 text-sm text-rose-900 space-y-1">
              <div className="font-bold flex items-center gap-1.5">
                <AlertTriangle className="h-4 w-4 text-rose-600" /> ช่วงเวลาที่เลือกมีการจองซ้อน:
              </div>
              <ul className="list-disc pl-5 text-xs text-rose-800 space-y-0.5">
                {conflicts.map((c, i) => (
                  <li key={i}>
                    คำขอ {c.id} ({fmtDate(c.startDate)} – {fmtDate(c.expectedReturnDate)})
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {/* 4. Purpose & Location */}
        <div className="card space-y-4">
          <div className="flex items-center gap-2 border-b border-slate-100 pb-3">
            <FileText className="h-5 w-5 text-emerald-700" aria-hidden="true" />
            <h3 className="font-heading text-lg font-bold text-slate-900">
              3. วัตถุประสงค์และสถานที่ใช้งาน
            </h3>
          </div>

          <div>
            <label htmlFor="purpose" className="label">
              วัตถุประสงค์ในการยืมใช้งาน <span className="text-rose-600">*</span>
            </label>
            <textarea
              id="purpose"
              className={`input min-h-[90px] py-3 text-base resize-y ${
                fieldErrors.purpose ? 'border-rose-400 ring-2 ring-rose-200' : ''
              }`}
              placeholder="ระบุภารกิจหรือรายละเอียดงาน เช่น ใช้ในการบันทึกเทปอบรมหลักสูตร..."
              value={purpose}
              onChange={(e) => {
                setPurpose(e.target.value);
                if (fieldErrors.purpose) setFieldErrors((prev) => ({ ...prev, purpose: '' }));
              }}
              required
            />
            {fieldErrors.purpose && (
              <p className="text-xs font-semibold text-rose-600 mt-1">⚠️ {fieldErrors.purpose}</p>
            )}
          </div>

          <div>
            <label htmlFor="location" className="label">
              สถานที่นำไปใช้งาน <span className="text-rose-600">*</span>
            </label>
            <input
              id="location"
              type="text"
              className={`input ${fieldErrors.location ? 'border-rose-400 ring-2 ring-rose-200' : ''}`}
              placeholder="เช่น ห้องประชุม 1 ชั้น 2 สำนักบริการวิชาการ หรือ อาคารพิมล กลกิจ"
              value={location}
              onChange={(e) => {
                setLocation(e.target.value);
                if (fieldErrors.location) setFieldErrors((prev) => ({ ...prev, location: '' }));
              }}
              required
            />
            {fieldErrors.location && (
              <p className="text-xs font-semibold text-rose-600 mt-1">⚠️ {fieldErrors.location}</p>
            )}
          </div>
        </div>

        {/* 5. Terms of Responsibility Agreement Card (ระเบียบพัสดุ พ.ศ. 2560) */}
        <div className="card space-y-4 border-2 border-emerald-200 bg-emerald-50/40">
          <div className="flex items-center gap-2.5 border-b border-emerald-100 pb-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-600 text-white shadow-xs">
              <ShieldCheck className="h-5 w-5" aria-hidden="true" />
            </div>
            <div>
              <h3 className="font-heading text-lg font-bold text-emerald-950">
                4. ข้อตกลงและคำรับรองความรับผิดชอบในการยืมพัสดุ/ครุภัณฑ์
              </h3>
              <p className="text-xs text-emerald-800 font-medium">
                ตามระเบียบกระทรวงการคลังว่าด้วยการจัดซื้อจัดจ้างและการบริหารพัสดุภาครัฐ พ.ศ. 2560
              </p>
            </div>
          </div>

          <div className="rounded-2xl bg-white/90 p-5 border border-emerald-100 text-sm text-slate-800 space-y-3 leading-relaxed shadow-2xs font-medium">
            <p className="font-semibold text-slate-900">
              ข้าพเจ้าขอให้คำรับรองและยินยอมปฏิบัติตามเงื่อนไขการยืมพัสดุ/ครุภัณฑ์ ตามระเบียบกระทรวงการคลังว่าด้วยการจัดซื้อจัดจ้างและการบริหารพัสดุภาครัฐ พ.ศ. 2560 ดังต่อไปนี้
            </p>

            <ol className="space-y-2.5 pl-1">
              <li className="flex items-start gap-2">
                <span className="font-bold text-emerald-800 flex-shrink-0">1.</span>
                <span>
                  <b>การดูแลรักษา:</b> ข้าพเจ้าจะดูแลรักษาครุภัณฑ์ที่ยืมไปเสมือนเป็นทรัพย์สินของตนเอง และจะนำไปใช้ตามวัตถุประสงค์ที่ระบุไว้ในการขอยืมเท่านั้น
                </span>
              </li>
              <li className="flex items-start gap-2">
                <span className="font-bold text-emerald-800 flex-shrink-0">2.</span>
                <span>
                  <b>การส่งคืน:</b> ข้าพเจ้าจะส่งคืนครุภัณฑ์ดังกล่าวในสภาพที่ใช้งานได้ดีเรียบร้อย ภายในวันที่ <b>{fmtDate(end)}</b> หรือเมื่อเสร็จสิ้นภารกิจ หรือเมื่อหน่วยงานต้นสังกัดเรียกคืน
                </span>
              </li>
              <li className="flex items-start gap-2">
                <span className="font-bold text-emerald-800 flex-shrink-0">3.</span>
                <span>
                  <b>ความรับผิดชอบกรณีชำรุดเสียหายหรือสูญหาย:</b> หากครุภัณฑ์เกิดความชำรุดเสียหาย (นอกเหนือจากการเสื่อมสภาพตามปกติ) หรือสูญหายไปด้วยประการใดๆ ในระหว่างที่อยู่ในความครอบครองของข้าพเจ้า ข้าพเจ้ายินยอมที่จะดำเนินการซ่อมแซมให้อยู่ในสภาพเดิมด้วยค่าใช้จ่ายของตนเอง หรือชดเชยเป็นครุภัณฑ์ประเภทและที่มีคุณภาพเทียบเท่า หรือชดใช้เป็นเงินตามราคาประเมินของทางราชการ โดยไม่มีเงื่อนไขใดๆ ทั้งสิ้น
                </span>
              </li>
              <li className="flex items-start gap-2">
                <span className="font-bold text-emerald-800 flex-shrink-0">4.</span>
                <span>
                  <b>การตรวจสอบ:</b> ข้าพเจ้ายินยอมให้เจ้าหน้าที่ผู้รับผิดชอบพัสดุเข้าตรวจสอบสภาพครุภัณฑ์ที่ยืมไปได้ตลอดเวลาในระหว่างระยะเวลาการยืม
                </span>
              </li>
            </ol>

            <div className="pt-2 border-t border-slate-100 text-xs text-slate-500 font-semibold italic text-right">
              เพื่อเป็นหลักฐานในการแสดงความยินยอม
            </div>
          </div>

          {/* Interactive Checkbox */}
          <div>
            <label
              className={`flex items-start gap-3.5 p-4 rounded-2xl bg-white border-2 cursor-pointer transition shadow-xs ${
                fieldErrors.terms
                  ? 'border-rose-400 bg-rose-50/30 ring-2 ring-rose-200'
                  : 'border-emerald-400 hover:border-emerald-600'
              }`}
            >
              <input
                type="checkbox"
                id="terms-accepted-checkbox"
                checked={termsAccepted}
                onChange={(e) => {
                  setTermsAccepted(e.target.checked);
                  if (fieldErrors.terms) setFieldErrors((prev) => ({ ...prev, terms: '' }));
                }}
                className="mt-0.5 h-5 w-5 rounded-lg border-slate-300 text-emerald-600 focus:ring-emerald-500 cursor-pointer flex-shrink-0"
                required
              />
              <span className="text-sm sm:text-base font-bold text-slate-900 leading-snug select-none">
                ข้าพเจ้าได้อ่าน เข้าใจ และยินยอมปฏิบัติตามคำรับรองและเงื่อนไขความรับผิดชอบข้างต้นทุกประการ <span className="text-rose-600">*</span>
              </span>
            </label>
            {fieldErrors.terms && (
              <p className="text-xs font-semibold text-rose-600 mt-1.5 ml-1">⚠️ {fieldErrors.terms}</p>
            )}
          </div>
        </div>

        {/* 6. Submit Action Card */}
        <div className="flex flex-col-reverse sm:flex-row items-center justify-between gap-3 pt-2">
          <Link href="/equipment/" className="btn-outline w-full sm:w-auto text-center justify-center">
            ← ยกเลิกและกลับ
          </Link>
          <button
            type="submit"
            disabled={busy || !availability.available || !!dateError || conflicts.length > 0 || !termsAccepted}
            className="btn-cta w-full sm:w-auto px-8 py-3 text-base shadow-md disabled:opacity-50 justify-center"
          >
            {eq.status === 'MAINTENANCE' ? (
              <>
                <Wrench className="h-5 w-5" aria-hidden="true" />
                <span>อยู่ระหว่างซ่อมบำรุง (ไม่อนุญาตให้ยืมหรือจอง)</span>
              </>
            ) : !availability.available ? (
              <>
                <AlertTriangle className="h-5 w-5" aria-hidden="true" />
                <span>
                  {eq.status === 'BORROWED'
                    ? 'ถูกยืมใช้งานอยู่ (ไม่อนุญาตให้จองล่วงหน้า)'
                    : 'อุปกรณ์ไม่พร้อมให้บริการ'}
                </span>
              </>
            ) : (
              <>
                <Send className="h-5 w-5" aria-hidden="true" />
                <span>ตรวจสอบและยืนยันการขอยืม</span>
              </>
            )}
          </button>
        </div>
      </form>

      {/* Step Summary / Confirmation Modal */}
      {confirmModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-xs p-4"
          role="dialog"
          aria-modal="true"
          onClick={() => setConfirmModalOpen(false)}
        >
          <div
            className="w-full max-w-lg rounded-3xl bg-white p-6 sm:p-8 shadow-2xl border border-slate-100 space-y-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 border-b border-slate-100 pb-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[#123B68]/10 text-[#123B68]">
                <ShieldCheck className="h-6 w-6" />
              </div>
              <div>
                <h3 className="font-heading text-lg font-bold text-slate-900">
                  สรุปข้อมูลคำขอยืมครุภัณฑ์
                </h3>
                <p className="text-xs text-slate-500 font-medium">
                  โปรดตรวจสอบข้อมูลให้ถูกต้องก่อนส่งคำขอ
                </p>
              </div>
            </div>

            <div className="space-y-3 text-sm">
              <div className="rounded-2xl bg-[#F5F8FC] p-4 border border-slate-200/80 space-y-2">
                <div className="flex justify-between">
                  <span className="text-slate-500">ครุภัณฑ์:</span>
                  <span className="font-bold text-slate-900">{eq.name}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">เลขครุภัณฑ์:</span>
                  <span className="font-mono font-bold text-[#123B68]">{eq.assetNumber}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">ช่วงวันที่ยืม:</span>
                  <span className="font-bold text-slate-900">
                    {fmtDate(start)} – {fmtDate(end)} ({duration} วัน)
                  </span>
                </div>
                {isException && (
                  <div className="rounded-xl bg-amber-50 p-3 border border-amber-200 text-xs space-y-1">
                    <div className="flex items-center gap-1.5 font-bold text-amber-900">
                      <AlertTriangle className="h-4 w-4 text-amber-600" /> ขออนุมัติเป็นกรณีพิเศษ (&gt; 15 วัน):
                    </div>
                    <p className="text-amber-800">
                      <b>เหตุผล:</b> {exceptionReason}
                    </p>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-slate-500">สถานที่ใช้งาน:</span>
                  <span className="font-semibold text-slate-800">{location}</span>
                </div>
                <div className="flex items-center justify-between pt-2 border-t border-slate-200/60">
                  <span className="text-slate-500 text-xs">คำรับรองและข้อตกลง:</span>
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 text-emerald-800 px-2.5 py-0.5 text-xs font-bold">
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" /> ยินยอมตามระเบียบพัสดุ พ.ศ. 2560
                  </span>
                </div>
              </div>

              <div className="p-3.5 bg-emerald-50/60 rounded-2xl border border-emerald-100 text-xs text-slate-700 leading-relaxed font-medium">
                ℹ️ <b>ขั้นตอนต่อไป:</b> เมื่อส่งคำขอแล้ว ระบบจะส่งอีเมลแจ้งเตือนไปยังเจ้าหน้าที่พัสดุและผู้อนุมัติ ท่านสามารถติดตามสถานะและรับ QR Code บัตรรับของได้ทันที
              </div>
            </div>

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                className="btn-outline"
                disabled={busy}
                onClick={() => setConfirmModalOpen(false)}
              >
                ย้อนกลับไปแก้ไข
              </button>
              <button
                type="button"
                className="btn-cta px-6 shadow-sm"
                disabled={busy || !availability.available}
                onClick={handleFinalSubmit}
              >
                {busy ? (
                  <span className="inline-flex items-center gap-2">
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                    กำลังบันทึก...
                  </span>
                ) : (
                  '✓ ยืนยันการส่งคำขอยืม'
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
