'use client';

import Link from 'next/link';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { doc, onSnapshot } from 'firebase/firestore';
import AppShell from '@/components/AppShell';
import { Alert, DueHint, ExceptionBadge, ExtensionBadge, LoadingState, StatusBadge, Timeline } from '@/components/ui';
import { QRCodeCanvas } from '@/components/QrCode';
import { QrCode, Clock, Calendar, AlertTriangle, CheckCircle2, RefreshCw, FileText, ArrowRight, ShieldAlert, Sparkles, Wrench } from 'lucide-react';
import { RepairFormModal } from '@/components/RepairFormModal';
import { useAuth } from '@/lib/auth-context';
import { fb } from '@/lib/firebase';
import { useAllRequests, useEquipments } from '@/lib/hooks';
import {
  approveExtension,
  approveRequest,
  cancelExtension,
  cancelRequest,
  handoverRequest,
  requestExtension,
  returnRequest,
  reviewExtension,
  reviewRequest,
  sendRetroactiveCsatInvite,
  submitSatisfactionSurvey,
  updateSurveyFollowUp,
  validateDates,
} from '@/lib/requests';
import type {
  AppUser,
  BorrowRequest,
  Equipment,
  ExtensionStatus,
  ReturnCondition,
  ReviewChecklist,
  SatisfactionSurvey,
  SurveyFollowUpStatus,
} from '@/lib/types';
import {
  CANCELLABLE_STATUSES,
  EQUIPMENT_STATUS_META,
  MAX_BORROW_DAYS,
  addDays,
  daysInclusive,
  errMsg,
  findConflicts,
  fmtDate,
  fmtTs,
  todayStr,
} from '@/lib/utils';

export default function RequestDetailPage() {
  return (
    <AppShell title="รายละเอียดคำขอ">
      <Suspense>
        <Detail />
      </Suspense>
    </AppShell>
  );
}

function Detail() {
  const searchParams = useSearchParams();
  const id = (searchParams.get('id') ?? '').trim();
  const csatParam = searchParams.get('csat');
  const { profile, loading } = useAuth();
  const [r, setR] = useState<BorrowRequest | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [fetching, setFetching] = useState(true);
  const [repairModalOpen, setRepairModalOpen] = useState(false);
  const [repairModalEquipments, setRepairModalEquipments] = useState<any[]>([]);

  useEffect(() => {
    if (!id) {
      setFetching(false);
      return;
    }
    setFetching(true);
    const unsub = onSnapshot(
      doc(fb().db, 'borrow_requests', id),
      (s) => {
        setFetching(false);
        if (s.exists()) {
          setR({ ...s.data(), id: s.id } as BorrowRequest);
          setNotFound(false);
        } else {
          setNotFound(true);
        }
      },
      (err) => {
        console.warn('Request snapshot error:', err);
        setFetching(false);
        setNotFound(true);
      },
    );
    return () => unsub();
  }, [id]);

  useEffect(() => {
    if (r && (csatParam || searchParams.get('survey') === '1' || (typeof window !== 'undefined' && window.location.hash === '#survey'))) {
      const timer = setTimeout(() => {
        const el = document.getElementById('survey');
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      }, 400);
      return () => clearTimeout(timer);
    }
  }, [r, csatParam, searchParams]);

  if (loading || (!profile && fetching)) {
    return <LoadingState text="กำลังโหลดข้อมูลคำขอ..." />;
  }

  if (!id) return <Alert kind="info">กรุณาระบุเลขที่คำขอ หรือสแกน QR Code จากบัตรรับของ</Alert>;
  if (notFound && !fetching) {
    return (
      <div className="card text-center py-10 space-y-4">
        <Alert kind="warn">ไม่พบคำขอยืมเลขที่ <b>{id}</b> ในระบบ</Alert>
        <p className="text-xs text-slate-500">
          คำขอนี้อาจยังไม่ถูกสร้าง หรือถูกยกเลิกแล้ว
        </p>
        <Link href="/my-requests/" className="btn-primary text-xs inline-block">
          ไปยังหน้ารายการยืมของฉัน
        </Link>
      </div>
    );
  }
  if (!profile || !r) return <LoadingState text="กำลังโหลดข้อมูลคำขอ..." />;

  const me = profile;
  const isBorrower = r.borrower.email === me.email;
  const isCustodian = me.role === 'CUSTODIAN' || me.role === 'EXECUTIVE';
  const isApprover = me.role === 'APPROVER' || me.role === 'EXECUTIVE';
  const isCanHandoverOrReturn = me.role === 'CUSTODIAN' || me.role === 'APPROVER' || me.role === 'EXECUTIVE';

  return (
    <div className="grid gap-6 lg:grid-cols-3 pb-4 sm:pb-8">
      <div className="space-y-6 lg:col-span-2">
        {/* Header */}
        <div className="card space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-sm text-slate-500">เลขที่คำขอ</div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-2xl font-bold text-brand-700">{r.id}</span>
                <ExceptionBadge isException={r.isException} />
              </div>
            </div>
            <div className="text-right space-y-1">
              <div className="flex items-center justify-end gap-1.5 flex-wrap">
                <StatusBadge status={r.status} />
                <ExtensionBadge status={r.extension?.status} />
              </div>
              <div className="mt-1"><DueHint r={r} /></div>
            </div>
          </div>
          <Steps r={r} />
          <NextStepCallout r={r} isBorrower={isBorrower} />
        </div>

        {/* Action panels */}
        {isCustodian && r.status === 'PENDING_REVIEW' && <ReviewPanel r={r} me={me} />}
        {isApprover && r.status === 'PENDING_APPROVAL' && <ApprovePanel r={r} me={me} />}
        {isCanHandoverOrReturn && r.status === 'APPROVED_WAITING_PICKUP' && <HandoverPanel r={r} me={me} />}

        {/* Extension Flow Panels */}
        {isCustodian && ['IN_USE', 'OVERDUE'].includes(r.status) && r.extension?.status === 'PENDING_REVIEW' && (
          <ExtensionReviewPanel r={r} me={me} />
        )}
        {isApprover && ['IN_USE', 'OVERDUE'].includes(r.status) && r.extension?.status === 'PENDING_APPROVAL' && (
          <ExtensionApprovePanel r={r} me={me} />
        )}
        {isBorrower && ['IN_USE', 'OVERDUE'].includes(r.status) && (
          <BorrowerExtensionPanel r={r} me={me} />
        )}

        {isCanHandoverOrReturn && ['IN_USE', 'OVERDUE'].includes(r.status) && <ReturnPanel r={r} me={me} />}
        {isBorrower && CANCELLABLE_STATUSES.includes(r.status) && <CancelPanel r={r} me={me} />}

        {/* Info */}
        <div className="card grid gap-4 sm:grid-cols-2">
          <Info label="ผู้ยืม" value={r.borrower.name} sub={`${r.borrower.position} · ${r.borrower.mission}`} />
          <Info label="ครุภัณฑ์" value={r.equipment.name} sub={r.equipment.assetNumber} />
          <Info
            label="ช่วงวันที่ยืม"
            value={`${fmtDate(r.startDate)} – ${fmtDate(r.expectedReturnDate)}`}
            sub={`${r.durationDays} วัน${
              r.originalExpectedReturnDate && r.originalExpectedReturnDate !== r.expectedReturnDate
                ? ` (เดิมกำหนดส่ง ${fmtDate(r.originalExpectedReturnDate)})`
                : ''
            }`}
          />
          <Info label="สถานที่นำไปใช้" value={r.location || '-'} />
          <div className="sm:col-span-2"><Info label="วัตถุประสงค์" value={r.purpose} /></div>
          {r.isException && (
            <div className="sm:col-span-2 rounded-xl bg-purple-50 p-3.5 border border-purple-200 text-xs text-purple-900 space-y-1">
              <div className="font-bold flex items-center gap-1.5">
                <Sparkles className="h-4 w-4 text-purple-700" />
                คำขออนุมัติเป็นกรณีพิเศษ (&gt; 15 วัน)
              </div>
              <div><b>เหตุผลและความจำเป็น:</b> {r.exceptionReason || '-'}</div>
            </div>
          )}
          <div className="sm:col-span-2 pt-2 border-t border-slate-100 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600">
            <span className="font-semibold text-slate-700">ข้อตกลงและคำรับรองความรับผิดชอบ:</span>
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-800 px-2.5 py-0.5 font-bold">
              ✓ ยินยอมตามระเบียบพัสดุ พ.ศ. 2560 {r.termsAcceptedAt ? `(${fmtTs(r.termsAcceptedAt)})` : ''}
            </span>
          </div>
        </div>

        {/* Extension History Card */}
        <ExtensionHistoryCard r={r} />

        {r.review && (
          <div className="card">
            <h3 className="mb-2 font-semibold">ผลการตรวจสอบ (ผู้ดูแลอุปกรณ์)</h3>
            <div className="text-sm">
              <div>
                {r.review.result === 'PASSED' ? '✅ ยืมได้' : '❌ ยืมไม่ได้'} · โดย {r.review.reviewerName} · {fmtTs(r.review.reviewedAt)}
              </div>
              {r.review.reason && <div>เหตุผล: {r.review.reason}</div>}
              {r.review.comment && <div>หมายเหตุ: {r.review.comment}</div>}
              {r.review.accessoriesToHandover?.length > 0 && <div>อุปกรณ์เสริม: {r.review.accessoriesToHandover.join(', ')}</div>}
            </div>
          </div>
        )}
        {r.approval && (
          <div className="card">
            <h3 className="mb-2 font-semibold">ผลการพิจารณาอนุมัติ</h3>
            <div className="text-sm">
              {r.approval.result === 'APPROVED' ? '✅ อนุมัติ' : '❌ ไม่อนุมัติ'} · โดย {r.approval.approverName} · {fmtTs(r.approval.approvedAt)}
              {r.approval.comment && <div>ความเห็น: {r.approval.comment}</div>}
            </div>
          </div>
        )}
        {r.handover && (
          <div className="card text-sm">
            <h3 className="mb-2 font-semibold">การส่งมอบ</h3>
            <div>วันที่ส่งมอบ: {fmtDate(r.handover.handoverDate)} · โดย {r.handover.custodianName}</div>
            {r.handover.accessories?.length > 0 && <div>อุปกรณ์เสริมที่ส่งมอบ: {r.handover.accessories.join(', ')}</div>}
            {r.handover.conditionNote && <div>สภาพ: {r.handover.conditionNote}</div>}
          </div>
        )}
        {r.returnInfo && (
          <div className="card text-sm space-y-3">
            <div className="flex items-center justify-between border-b border-slate-100 pb-2">
              <h3 className="font-semibold text-base">การรับคืนครุภัณฑ์</h3>
              <StatusBadge status={r.status} />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs text-slate-700">
              <div>
                วันที่คืน: <b className="text-slate-900">{fmtDate(r.returnInfo.actualReturnDate)}</b>
                {r.returnInfo.lateDays > 0 && (
                  <span className="ml-2 font-bold text-red-600 bg-red-50 px-2 py-0.5 rounded border border-red-200">
                    ช้า {r.returnInfo.lateDays} วัน
                  </span>
                )}
              </div>
              <div>
                ผู้รับคืน: <b className="text-slate-900">{r.returnInfo.receivedByName}</b>
              </div>
              <div className="sm:col-span-2">
                สภาพที่ตรวจรับ:{' '}
                <span className="font-bold">
                  {r.returnInfo.condition === 'NORMAL' && '🟢 สมบูรณ์เรียบร้อย'}
                  {r.returnInfo.condition === 'DAMAGED' && '🟠 ชำรุด/มีปัญหา'}
                  {r.returnInfo.condition === 'LOST' && '🔴 สูญหาย'}
                </span>
              </div>
              {r.returnInfo.remarks && (
                <div className="sm:col-span-2 text-slate-600">
                  หมายเหตุ: {r.returnInfo.remarks}
                </div>
              )}
            </div>

            {/* แสดงรายงานชำรุด */}
            {r.returnInfo.damageReport && (
              <div className="rounded-xl border border-amber-300 bg-amber-50/60 p-3 space-y-2 text-xs">
                <div className="flex items-center justify-between font-bold text-amber-900">
                  <span className="flex items-center gap-1.5">
                    <Wrench className="h-4 w-4 text-amber-600" />
                    ข้อมูลการแจ้งซ่อมแซมครุภัณฑ์
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setRepairModalEquipments([
                        {
                          equipment: r.equipment,
                          symptom: r.returnInfo?.damageReport?.symptom || 'ชำรุดจากการยืมใช้งาน',
                          responsiblePerson: r.borrower.name,
                        },
                      ]);
                      setRepairModalOpen(true);
                    }}
                    className="btn-outline text-[11px] py-1 px-2.5 bg-white border-amber-300 text-amber-900 hover:bg-amber-100 flex items-center gap-1 shadow-2xs font-semibold"
                  >
                    <FileText className="h-3.5 w-3.5 text-amber-600" /> พิมพ์ใบแจ้งซ่อม (A4)
                  </button>
                </div>
                <div>
                  อาการเสีย: <b className="text-slate-900">{r.returnInfo.damageReport.symptom}</b>
                </div>
                {r.returnInfo.damageReport.damageDetails && (
                  <div>
                    รายละเอียดความเสียหาย: <span className="text-slate-800">{r.returnInfo.damageReport.damageDetails}</span>
                  </div>
                )}
                {r.returnInfo.damageReport.cause && (
                  <div>
                    สาเหตุ: <span className="text-slate-800">{r.returnInfo.damageReport.cause}</span>
                  </div>
                )}
                {r.returnInfo.damageReport.damagedAccessories && r.returnInfo.damageReport.damagedAccessories.length > 0 && (
                  <div>
                    อุปกรณ์เสริมที่ชำรุด/ขาดหาย: <b className="text-red-700">{r.returnInfo.damageReport.damagedAccessories.join(', ')}</b>
                  </div>
                )}
                {r.returnInfo.damageReport.photos && r.returnInfo.damageReport.photos.length > 0 && (
                  <div className="pt-2">
                    <div className="font-semibold text-slate-700 mb-1.5">ภาพถ่ายความเสียหาย:</div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                      {r.returnInfo.damageReport.photos.map((p, idx) => (
                        <a key={idx} href={p} target="_blank" rel="noreferrer" className="block rounded-lg overflow-hidden border border-amber-200 aspect-video bg-white hover:opacity-90 transition">
                          <img src={p} alt={`ภาพความเสียหาย ${idx + 1}`} className="w-full h-full object-cover" />
                        </a>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* แสดงรายงานสูญหาย */}
            {r.returnInfo.lostReport && (
              <div className="rounded-xl border border-red-300 bg-red-50/60 p-3 space-y-2 text-xs">
                <div className="font-bold text-red-950 flex items-center gap-1.5">
                  <AlertTriangle className="h-4 w-4 text-red-600" />
                  รายงานเหตุการณ์ครุภัณฑ์สูญหาย
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-slate-800">
                  {r.returnInfo.lostReport.incidentDate && (
                    <div>วันที่เกิดเหตุ: <b>{fmtDate(r.returnInfo.lostReport.incidentDate)}</b></div>
                  )}
                  {r.returnInfo.lostReport.location && (
                    <div>สถานที่เกิดเหตุ: <b>{r.returnInfo.lostReport.location}</b></div>
                  )}
                </div>
                <div>
                  รายละเอียด: <span className="text-slate-800">{r.returnInfo.lostReport.incidentDetails}</span>
                </div>
                {r.returnInfo.lostReport.policeReportNo && (
                  <div>
                    เลขที่บันทึกประจำวัน / แจ้งความ: <b className="text-slate-900">{r.returnInfo.lostReport.policeReportNo}</b>
                  </div>
                )}
                {typeof r.returnInfo.lostReport.borrowerLiabilityAccepted === 'boolean' && (
                  <div className="p-2 rounded-lg bg-white border border-red-200 text-red-900 font-medium">
                    {r.returnInfo.lostReport.borrowerLiabilityAccepted
                      ? '✓ ผู้ยืมยินยอมรับผิดชอบชดใช้ค่าเสียหายตามระเบียบพัสดุ มหาวิทยาลัยขอนแก่น'
                      : '⚠️ ยังไม่ได้รับการยินยอมชดใช้ค่าเสียหาย'}
                  </div>
                )}
                {r.returnInfo.lostReport.photos && r.returnInfo.lostReport.photos.length > 0 && (
                  <div className="pt-2">
                    <div className="font-semibold text-slate-700 mb-1.5">ภาพถ่ายเอกสาร / หลักฐานประกอบ:</div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                      {r.returnInfo.lostReport.photos.map((p, idx) => (
                        <a key={idx} href={p} target="_blank" rel="noreferrer" className="block rounded-lg overflow-hidden border border-red-200 aspect-video bg-white hover:opacity-90 transition">
                          <img src={p} alt={`หลักฐานสูญหาย ${idx + 1}`} className="w-full h-full object-cover" />
                        </a>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* แบบประเมินความพึงพอใจการใช้บริการ (CSAT) */}
        {['RETURNED', 'RETURNED_DAMAGED', 'LOST'].includes(r.status) && (
          <div id="survey" className="scroll-mt-24">
            <SatisfactionSurveyCard
              r={r}
              me={profile}
              initialRating={csatParam ? parseInt(csatParam, 10) : undefined}
            />
          </div>
        )}
      </div>

      <div className="space-y-6">
        {/* Digital Loan Pass QR Code Card */}
        <div id="digital-loan-pass" className="card text-center space-y-3 bg-gradient-to-b from-white to-slate-50/70 border-slate-200 scroll-mt-20">
          <div className="flex items-center justify-center gap-1.5 text-xs font-bold text-brand-700 uppercase tracking-wider">
            <QrCode className="h-4 w-4 text-brand-600" />
            บัตรยืมดิจิทัล (Digital Loan Pass)
          </div>
          <div className="flex justify-center p-2 bg-white rounded-2xl border border-slate-200/80 shadow-xs max-w-fit mx-auto">
            <QRCodeCanvas value={r.id} size={170} />
          </div>
          <div className="space-y-1">
            <div className="font-mono font-bold text-sm text-slate-900">{r.id}</div>
            <div className="text-xs text-slate-500 font-medium">
              แสดง QR Code นี้แก่เจ้าหน้าที่ตอนรับและส่งคืนอุปกรณ์
            </div>
          </div>
        </div>

        {/* Timeline Card */}
        <div className="card h-fit">
          <h3 className="mb-4 font-semibold text-slate-900">ประวัติสถานะ (Timeline)</h3>
          <Timeline items={r.timeline ?? []} />
        </div>
      </div>

      {/* แบบฟอร์มแจ้งซ่อมแซมอุปกรณ์ */}
      <RepairFormModal
        open={repairModalOpen}
        onClose={() => setRepairModalOpen(false)}
        currentUser={profile}
        initialEquipments={repairModalEquipments}
      />
    </div>
  );
}

function Info({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <div className="text-xs text-slate-500">{label}</div>
      <div className="font-medium">{value}</div>
      {sub && <div className="text-xs text-slate-500">{sub}</div>}
    </div>
  );
}

/** แถบขั้นตอน: ยื่น → ตรวจสอบ → อนุมัติ → รับของ → คืน */
function Steps({ r }: { r: BorrowRequest }) {
  const order = ['PENDING_REVIEW', 'PENDING_APPROVAL', 'APPROVED_WAITING_PICKUP', 'IN_USE', 'RETURNED'];
  const labels = ['ยื่นคำขอ', 'ผู้ดูแลตรวจสอบ', 'ผู้อนุมัติพิจารณา', 'รับครุภัณฑ์', 'คืนครุภัณฑ์'];
  const map: Record<string, number> = {
    PENDING_REVIEW: 1, REVIEW_REJECTED: 1, PENDING_APPROVAL: 2, REJECTED: 2,
    APPROVED_WAITING_PICKUP: 3, IN_USE: 4, OVERDUE: 4, RETURNED: 5, RETURNED_DAMAGED: 5, LOST: 5, CANCELLED: -1,
  };
  const cur = map[r.status];
  const failed = ['REVIEW_REJECTED', 'REJECTED'].includes(r.status);
  if (cur === -1) return <div className="mt-4 text-sm text-slate-500">คำขอนี้ถูกยกเลิก</div>;
  return (
    <div className="mt-5 flex items-center">
      {order.map((_, i) => {
        const done = i < cur || (i === cur && cur === 5);
        const here = i === cur && cur !== 5;
        const color = here && failed ? 'bg-rose-500 text-white' : done ? 'bg-brand-600 text-white' : here ? 'bg-amber-400 text-white' : 'bg-slate-200 text-slate-500';
        return (
          <div key={i} className="flex flex-1 flex-col items-center text-center">
            <div className={`flex h-8 w-8 items-center justify-center rounded-full text-sm font-semibold ${color}`}>
              {here && failed ? '✕' : done ? '✓' : i + 1}
            </div>
            <div className="mt-1 text-[11px] leading-tight text-slate-600">{labels[i]}</div>
          </div>
        );
      })}
    </div>
  );
}

/** กล่องคำแนะนำขั้นตอนถัดไปสำหรับผู้ยืม (ลดความสับสนว่าต้องทำอะไรต่อ) */
function NextStepCallout({ r, isBorrower }: { r: BorrowRequest; isBorrower: boolean }) {
  const showQrShortcut = ['APPROVED_WAITING_PICKUP', 'IN_USE', 'OVERDUE'].includes(r.status);

  let title = '';
  let desc = '';
  let tone = 'bg-slate-50 border-slate-200 text-slate-800';

  if (r.status === 'PENDING_REVIEW') {
    title = 'ขั้นตอนปัจจุบัน: รอผู้ดูแลพัสดุตรวจสอบความพร้อม (ขั้นที่ 1)';
    desc = 'คำขอของท่านถูกส่งเข้าระบบเรียบร้อยแล้ว เจ้าหน้าที่พัสดุจะตรวจสอบความพร้อมของอุปกรณ์และส่งต่อผู้อนุมัติ ระบบจะแจ้งผลทางอีเมล';
    tone = 'bg-amber-50/80 border-amber-200 text-amber-950';
  } else if (r.status === 'PENDING_APPROVAL') {
    title = 'ขั้นตอนปัจจุบัน: ผ่านการตรวจแล้ว รอผู้อนุมัติพิจารณา (ขั้นที่ 2)';
    desc = 'อุปกรณ์พร้อมให้ยืม อยู่ระหว่างรอผู้อนุมัติลงนามอนุมัติคำขอ เมื่ออนุมัติแล้วท่านจะได้รับอีเมลแจ้งให้มารับอุปกรณ์';
    tone = 'bg-sky-50/80 border-sky-200 text-sky-950';
  } else if (r.status === 'APPROVED_WAITING_PICKUP') {
    title = '✅ อนุมัติแล้ว — พร้อมติดต่อรับครุภัณฑ์ได้เลย';
    desc = 'กรุณาแสดงบัตรยืมดิจิทัล (QR Code) แก่เจ้าหน้าที่พัสดุในวันรับอุปกรณ์';
    tone = 'bg-emerald-50/90 border-emerald-300 text-emerald-950';
  } else if (r.status === 'IN_USE') {
    title = `กำลังใช้งานครุภัณฑ์ (กำหนดส่งคืน: ${fmtDate(r.expectedReturnDate)})`;
    desc = isBorrower
      ? 'เมื่อใช้งานเสร็จสิ้น กรุณานำครุภัณฑ์พร้อมอุปกรณ์เสริมมาส่งคืน และแสดง QR Code แก่เจ้าหน้าที่ (หากต้องการใช้นานขึ้น กดปุ่ม "+ ยื่นเรื่องขอยืมต่อ" ด้านล่าง)'
      : 'ผู้ยืมกำลังนำครุภัณฑ์ไปใช้งาน สามารถบันทึกตรวจรับคืนได้เมื่อผู้ยืมนำของมาส่ง';
    tone = 'bg-blue-50/80 border-blue-200 text-blue-950';
  } else if (r.status === 'OVERDUE') {
    title = `⚠️ เกินกำหนดส่งคืน (กำหนดเดิม: ${fmtDate(r.expectedReturnDate)})`;
    desc = 'กรุณานำครุภัณฑ์มาส่งคืนที่งานพัสดุ สำนักบริการวิชาการโดยเร็วที่สุด หรือยื่นเรื่องขอต่ออายุหากมีความจำเป็นต่อเนื่อง';
    tone = 'bg-rose-50 border-rose-300 text-rose-950';
  } else if (['RETURNED', 'RETURNED_DAMAGED', 'LOST'].includes(r.status)) {
    title = 'ดำเนินการส่งคืนครุภัณฑ์เสร็จสมบูรณ์';
    desc = isBorrower && !r.survey
      ? 'ขอบคุณที่ใช้บริการ! ท่านสามารถร่วมทำแบบประเมินความพึงพอใจด้านล่างเพื่อช่วยให้เราพัฒนาบริการให้ดียิ่งขึ้น'
      : 'รายการยืม-คืนนี้เสร็จสิ้นกระบวนการเรียบร้อยแล้ว';
    tone = 'bg-slate-50 border-slate-200 text-slate-800';
  } else if (['REVIEW_REJECTED', 'REJECTED'].includes(r.status)) {
    title = 'คำขอนี้ไม่ได้รับการอนุมัติ';
    desc = 'สามารถดูเหตุผลประกอบการพิจารณาได้จากการ์ดผลการตรวจสอบ/อนุมัติด้านล่าง';
    tone = 'bg-rose-50/80 border-rose-200 text-rose-950';
  }

  if (!title) return null;

  return (
    <div className={`rounded-2xl border p-3.5 text-xs sm:text-sm flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${tone}`}>
      <div className="space-y-0.5">
        <div className="font-bold">{title}</div>
        <div className="opacity-90 leading-relaxed">{desc}</div>
      </div>
      {showQrShortcut && (
        <a
          href="#digital-loan-pass"
          className="lg:hidden inline-flex items-center justify-center gap-1.5 rounded-xl bg-slate-900 text-white px-3.5 py-2 text-xs font-bold whitespace-nowrap shadow-xs self-start sm:self-center"
        >
          <QrCode className="h-4 w-4" /> แสดง QR Code รับ/คืนของ
        </a>
      )}
    </div>
  );
}

function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

const REVIEW_REASONS = [
  'อุปกรณ์อยู่ระหว่างซ่อมบำรุง',
  'มีผู้จองช่วงเวลาเดียวกัน',
  'ผู้ยืมมีรายการค้างคืน',
  'วัตถุประสงค์ไม่เหมาะสมกับประเภทอุปกรณ์',
  'อื่น ๆ',
];

/* ขั้นที่ 1: นายชาลีตรวจสอบ */
function ReviewPanel({ r, me }: { r: BorrowRequest; me: AppUser }) {
  const { data: equipments } = useEquipments();
  const { data: all } = useAllRequests();
  const eq: Equipment | undefined = equipments.find((e) => e.id === r.equipment.equipmentId);
  const conflicts = useMemo(() => findConflicts(all, r.equipment.equipmentId, r.startDate, r.expectedReturnDate, r.id)
    .filter((c) => c.status !== 'PENDING_REVIEW'), [all, r]);
  const borrowerOverdue = all.filter((x) => x.borrower.email === r.borrower.email && x.status === 'OVERDUE');

  const auto: ReviewChecklist = {
    equipmentReady: !!eq && !eq.isDeleted && ['AVAILABLE', 'BORROWED'].includes(eq.status),
    noDateConflict: conflicts.length === 0,
    noOverdueByBorrower: borrowerOverdue.length === 0,
    purposeAppropriate: true,
  };
  const [check, setCheck] = useState<ReviewChecklist | null>(null);
  const c = check ?? auto;
  const [accessories, setAccessories] = useState<string | null>(null);
  const acc = accessories ?? (eq?.accessories ?? []).join(', ');
  const [reason, setReason] = useState(REVIEW_REASONS[0]);
  const [comment, setComment] = useState('');
  const { busy, error, run } = useAction();
  const allOk = Object.values(c).every(Boolean);

  const items: [keyof ReviewChecklist, string, string][] = [
    ['equipmentReady', 'อุปกรณ์พร้อมใช้งาน ไม่อยู่ระหว่างซ่อม', eq ? `สถานะปัจจุบัน: ${EQUIPMENT_STATUS_META[eq.status].label}` : 'ไม่พบข้อมูลครุภัณฑ์'],
    ['noDateConflict', 'ช่วงวันที่ไม่ชนกับคำขออื่นที่ผ่านการตรวจแล้ว', conflicts.length ? `ชนกับ ${conflicts.map((x) => x.id).join(', ')}` : 'ไม่พบการชน'],
    ['noOverdueByBorrower', 'ผู้ยืมไม่มีรายการค้างคืน', borrowerOverdue.length ? `ค้างคืน ${borrowerOverdue.length} รายการ` : 'ไม่มีรายการค้าง'],
    ['purposeAppropriate', 'วัตถุประสงค์เหมาะสมกับประเภทอุปกรณ์', 'ผู้ตรวจพิจารณา'],
  ];

  const submit = (passed: boolean) =>
    run(() =>
      reviewRequest(r, me, {
        passed,
        checklist: c,
        accessories: acc.split(',').map((s) => s.trim()).filter(Boolean),
        reason: passed ? '' : reason,
        comment,
      }),
    );

  return (
    <div className="card border-amber-300 bg-amber-50/40">
      <h3 className="mb-1 font-semibold">🔍 ตรวจสอบคำขอ (ขั้นที่ 1)</h3>
      <p className="mb-4 text-sm text-slate-600">ระบบตรวจเบื้องต้นให้แล้ว กรุณายืนยันก่อนส่งต่อให้ผู้อนุมัติ</p>
      {error && <div className="mb-3"><Alert>{error}</Alert></div>}
      {r.isException && (
        <div className="mb-4 rounded-xl border border-purple-300 bg-purple-50 p-3.5 text-xs text-purple-950 space-y-1">
          <div className="font-bold flex items-center gap-1.5 text-purple-900">
            <Sparkles className="h-4 w-4 text-purple-700" /> คำขอนี้เป็นกรณีพิเศษ (ขอยืม {r.durationDays} วัน · เกินปกติ {r.durationDays - MAX_BORROW_DAYS} วัน)
          </div>
          <p><b>เหตุผลและความจำเป็น:</b> {r.exceptionReason}</p>
        </div>
      )}
      <div className="space-y-2">
        {items.map(([k, label, hint]) => (
          <label key={k} className="flex items-start gap-3 rounded-lg bg-white p-3">
            <input type="checkbox" className="mt-1 h-4 w-4 accent-brand-600" checked={c[k]} onChange={(e) => setCheck({ ...c, [k]: e.target.checked })} />
            <span>
              <span className="block text-sm font-medium">{label}</span>
              <span className={`text-xs ${auto[k] ? 'text-emerald-700' : 'text-rose-600'}`}>{hint}</span>
            </span>
          </label>
        ))}
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label className="label">อุปกรณ์เสริมที่จะส่งมอบ (คั่นด้วย ,)</label>
          <input className="input" value={acc} onChange={(e) => setAccessories(e.target.value)} />
        </div>
        <div>
          <label className="label">เหตุผล (กรณียืมไม่ได้)</label>
          <select className="input" value={reason} onChange={(e) => setReason(e.target.value)}>
            {REVIEW_REASONS.map((x) => <option key={x}>{x}</option>)}
          </select>
        </div>
        <div>
          <label className="label">หมายเหตุ</label>
          <input className="input" value={comment} onChange={(e) => setComment(e.target.value)} />
        </div>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <button className="btn-success" disabled={busy || !allOk} onClick={() => submit(true)}>
          ✓ ยืมได้ — ส่งต่อผู้อนุมัติ
        </button>
        <button className="btn-danger" disabled={busy} onClick={() => submit(false)}>
          ✕ ยืมไม่ได้
        </button>
      </div>
      {!allOk && <p className="mt-2 text-xs text-slate-500">ต้องผ่านทุกข้อจึงจะส่งต่อผู้อนุมัติได้</p>}
    </div>
  );
}

/* ขั้นที่ 2: นายประหยัดอนุมัติ */
function ApprovePanel({ r, me }: { r: BorrowRequest; me: AppUser }) {
  const [comment, setComment] = useState('');
  const { busy, error, run } = useAction();
  return (
    <div className="card border-sky-300 bg-sky-50/40">
      <h3 className="mb-1 font-semibold">✅ พิจารณาอนุมัติ (ขั้นที่ 2)</h3>
      <p className="mb-3 text-sm text-slate-600">
        ผ่านการตรวจสอบจาก {r.review?.reviewerName} แล้ว {r.review?.comment ? `(“${r.review.comment}”)` : ''}
      </p>
      {error && <div className="mb-3"><Alert>{error}</Alert></div>}
      {r.isException && (
        <div className="mb-4 rounded-xl border border-purple-300 bg-purple-50 p-3.5 text-xs text-purple-950 space-y-1">
          <div className="font-bold flex items-center gap-1.5 text-purple-900">
            <Sparkles className="h-4 w-4 text-purple-700" /> คำขอนี้เป็นกรณีพิเศษ (ขอยืม {r.durationDays} วัน · เกินปกติ {r.durationDays - MAX_BORROW_DAYS} วัน)
          </div>
          <p><b>เหตุผลและความจำเป็น:</b> {r.exceptionReason}</p>
        </div>
      )}
      <label className="label">ความเห็น (จำเป็นกรณีไม่อนุมัติ)</label>
      <textarea className="input min-h-20" value={comment} onChange={(e) => setComment(e.target.value)} />
      <div className="mt-4 flex gap-2">
        <button className="btn-success" disabled={busy} onClick={() => run(() => approveRequest(r, me, true, comment))}>อนุมัติ</button>
        <button
          className="btn-danger"
          disabled={busy || !comment.trim()}
          onClick={() => run(() => approveRequest(r, me, false, comment))}
        >
          ไม่อนุมัติ
        </button>
      </div>
    </div>
  );
}

/* นายชาลีส่งมอบ */
function HandoverPanel({ r, me }: { r: BorrowRequest; me: AppUser }) {
  const [acc, setAcc] = useState((r.review?.accessoriesToHandover ?? []).join(', '));
  const [note, setNote] = useState('สภาพสมบูรณ์');
  const { busy, error, run } = useAction();
  return (
    <div className="card border-indigo-300 bg-indigo-50/40">
      <h3 className="mb-3 font-semibold">📤 บันทึกส่งมอบครุภัณฑ์</h3>
      {error && <div className="mb-3"><Alert>{error}</Alert></div>}
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label">อุปกรณ์เสริมที่ส่งมอบ</label>
          <input className="input" value={acc} onChange={(e) => setAcc(e.target.value)} />
        </div>
        <div>
          <label className="label">สภาพก่อนส่งมอบ</label>
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
      </div>
      <button
        className="btn-primary mt-4"
        disabled={busy}
        onClick={() => run(() => handoverRequest(r, me, { accessories: acc.split(',').map((s) => s.trim()).filter(Boolean), conditionNote: note }))}
      >
        ยืนยันส่งมอบ
      </button>
    </div>
  );
}

/* นายชาลีตรวจรับคืน */
function ReturnPanel({ r, me }: { r: BorrowRequest; me: AppUser }) {
  const [condition, setCondition] = useState<ReturnCondition>('NORMAL');
  const [remarks, setRemarks] = useState('');
  // Damaged fields
  const [symptom, setSymptom] = useState('');
  const [damageDetails, setDamageDetails] = useState('');
  const [cause, setCause] = useState('');
  // Lost fields
  const [incidentDate, setIncidentDate] = useState(todayStr());
  const [location, setLocation] = useState('');
  const [lostDetails, setLostDetails] = useState('');
  const [policeReportNo, setPoliceReportNo] = useState('');
  const [liabilityAccepted, setLiabilityAccepted] = useState(false);

  const { busy, error, run } = useAction();

  const handleReturn = async () => {
    if (condition === 'DAMAGED') {
      if (!symptom.trim()) throw new Error('กรุณาระบุอาการเสีย / ความเสียหายของครุภัณฑ์');
      await returnRequest(r, me, {
        condition: 'DAMAGED',
        remarks: remarks.trim() || symptom.trim(),
        damageReport: {
          symptom: symptom.trim(),
          damageDetails: damageDetails.trim() || undefined,
          cause: cause.trim() || undefined,
        },
      });
    } else if (condition === 'LOST') {
      if (!lostDetails.trim()) throw new Error('กรุณาระบุรายละเอียดเหตุการณ์สูญหาย');
      await returnRequest(r, me, {
        condition: 'LOST',
        remarks: remarks.trim() || `สูญหาย: ${lostDetails.trim()}`,
        lostReport: {
          incidentDate: incidentDate || todayStr(),
          location: location.trim() || undefined,
          incidentDetails: lostDetails.trim(),
          policeReportNo: policeReportNo.trim() || undefined,
          borrowerLiabilityAccepted: liabilityAccepted,
        },
      });
    } else {
      await returnRequest(r, me, { condition: 'NORMAL', remarks: remarks.trim() });
    }
  };

  return (
    <div className="card border-emerald-300 bg-emerald-50/40 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-emerald-950 flex items-center gap-1.5">
          <span>📥 ตรวจรับคืนครุภัณฑ์</span>
        </h3>
        <Link
          href="/handover"
          className="text-xs font-semibold text-brand-700 hover:underline"
        >
          เปิดหน้าตรวจรับคืนแบบเต็ม &rarr;
        </Link>
      </div>

      {error && <Alert kind="error">{error}</Alert>}

      {r.handover?.accessories?.length ? (
        <p className="text-xs text-slate-600">
          อุปกรณ์เสริมที่ส่งมอบ: <b>{r.handover.accessories.join(', ')}</b>
        </p>
      ) : null}

      <div className="flex flex-wrap gap-4 text-xs">
        {([['NORMAL', '🟢 สมบูรณ์'], ['DAMAGED', '🟠 ชำรุด'], ['LOST', '🔴 สูญหาย']] as const).map(([v, l]) => (
          <label key={v} className="flex items-center gap-2 cursor-pointer font-medium">
            <input
              type="radio"
              className="accent-brand-600"
              checked={condition === v}
              onChange={() => setCondition(v)}
            />
            {l}
          </label>
        ))}
      </div>

      {condition === 'NORMAL' && (
        <div>
          <label className="label text-xs">หมายเหตุเพิ่มเติม (ถ้ามี)</label>
          <textarea
            className="input min-h-16 text-xs"
            placeholder="ระบุสภาพของ รายละเอียดอุปกรณ์ หรือหมายเหตุเพิ่มเติม..."
            value={remarks}
            onChange={(e) => setRemarks(e.target.value)}
          />
        </div>
      )}

      {condition === 'DAMAGED' && (
        <div className="space-y-2 rounded-xl bg-amber-50 border border-amber-200 p-3 text-xs">
          <div className="font-bold text-amber-950 flex items-center gap-1">
            <Wrench className="h-3.5 w-3.5 text-amber-600" />
            ข้อมูลการแจ้งซ่อมแซมครุภัณฑ์
          </div>
          <div>
            <label className="label text-amber-950">อาการเสีย / ความเสียหาย * <span className="text-red-600">(จำเป็น)</span></label>
            <input
              className="input text-xs"
              placeholder="เช่น เปิดไม่ติด, จอแตก, ขาตั้งหัก"
              value={symptom}
              onChange={(e) => setSymptom(e.target.value)}
            />
          </div>
          <div>
            <label className="label text-amber-950">รายละเอียดความเสียหาย</label>
            <textarea
              className="input min-h-14 text-xs"
              placeholder="ระบุรอยแตกหักหรือชิ้นส่วนที่ชำรุดเพิ่มเติม..."
              value={damageDetails}
              onChange={(e) => setDamageDetails(e.target.value)}
            />
          </div>
          <div>
            <label className="label text-amber-950">สาเหตุหรือหมายเหตุ</label>
            <input
              className="input text-xs"
              placeholder="สาเหตุที่ทราบ..."
              value={cause}
              onChange={(e) => setCause(e.target.value)}
            />
          </div>
        </div>
      )}

      {condition === 'LOST' && (
        <div className="space-y-2 rounded-xl bg-red-50 border border-red-200 p-3 text-xs">
          <div className="font-bold text-red-950 flex items-center gap-1">
            <AlertTriangle className="h-3.5 w-3.5 text-red-600" />
            รายงานเหตุการณ์ครุภัณฑ์สูญหาย
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div>
              <label className="label text-red-950">วันที่เกิดเหตุ</label>
              <input
                type="date"
                className="input text-xs"
                value={incidentDate}
                onChange={(e) => setIncidentDate(e.target.value)}
              />
            </div>
            <div>
              <label className="label text-red-950">สถานที่เกิดเหตุ</label>
              <input
                className="input text-xs"
                placeholder="เช่น ห้องประชุม 1"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
              />
            </div>
          </div>
          <div>
            <label className="label text-red-950">รายละเอียดเหตุการณ์ * <span className="text-red-600">(จำเป็น)</span></label>
            <textarea
              className="input min-h-16 text-xs"
              placeholder="ระบุเหตุการณ์และสถานที่สูญหาย..."
              value={lostDetails}
              onChange={(e) => setLostDetails(e.target.value)}
            />
          </div>
          <div>
            <label className="label text-red-950">เลขที่ประจำวัน / แจ้งความตำรวจ (ถ้ามี)</label>
            <input
              className="input text-xs"
              placeholder="เช่น ปจว. ข้อ 2 สน.ย่อย มข."
              value={policeReportNo}
              onChange={(e) => setPoliceReportNo(e.target.value)}
            />
          </div>
          <label className="flex items-start gap-2 text-[11px] text-red-900 cursor-pointer pt-1">
            <input
              type="checkbox"
              className="accent-red-600 mt-0.5"
              checked={liabilityAccepted}
              onChange={(e) => setLiabilityAccepted(e.target.checked)}
            />
            <span>ผู้ยืมรับทราบและยินยอมชดใช้ค่าเสียหายตามระเบียบพัสดุ มข.</span>
          </label>
        </div>
      )}

      <button
        className={`mt-2 font-bold px-4 py-2 rounded-xl text-white text-xs transition shadow-xs ${
          condition === 'NORMAL'
            ? 'bg-emerald-600 hover:bg-emerald-700'
            : condition === 'DAMAGED'
            ? 'bg-amber-600 hover:bg-amber-700'
            : 'bg-red-600 hover:bg-red-700'
        }`}
        disabled={
          busy ||
          (condition === 'DAMAGED' && !symptom.trim()) ||
          (condition === 'LOST' && !lostDetails.trim())
        }
        onClick={() => run(handleReturn)}
      >
        {busy ? 'กำลังบันทึก...' : 'ยืนยันรับคืนครุภัณฑ์'}
      </button>
    </div>
  );
}

const CSAT_TAG_OPTIONS = [
  'อุปกรณ์พร้อมใช้งานและมีคุณภาพ',
  'บริการสะดวกรวดเร็ว',
  'ระบบยืม-คืนใช้งานง่าย',
  'เจ้าหน้าที่ให้คำแนะนำชัดเจน',
  'การส่งมอบและตรวจรับตรงเวลา',
];

function SatisfactionSurveyCard({
  r,
  me,
  initialRating,
}: {
  r: BorrowRequest;
  me: AppUser | null;
  initialRating?: number;
}) {
  const isBorrower = Boolean(me && me.email.toLowerCase() === r.borrower.email.toLowerCase());
  const isStaffUser = Boolean(me && ['CUSTODIAN', 'APPROVER', 'EXECUTIVE'].includes(me.role));

  const [rating, setRating] = useState<number>(() => {
    if (initialRating && initialRating >= 1 && initialRating <= 5) return initialRating;
    return 5;
  });
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [comment, setComment] = useState('');
  const [inviteSent, setInviteSent] = useState(false);
  const { busy, error, run } = useAction();

  // If already surveyed
  if (r.survey) {
    const s = r.survey;
    const ratingLabels: Record<number, string> = { 1: 'ปรับปรุง', 2: 'พอใช้', 3: 'ปานกลาง', 4: 'ดี', 5: 'ดีเยี่ยม' };
    return (
      <div className="card border-emerald-200 bg-emerald-50/40 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xl">🌟</span>
            <h3 className="font-bold text-emerald-950">ผลการประเมินความพึงพอใจการใช้บริการ</h3>
          </div>
          <span className="text-xs bg-emerald-100 text-emerald-800 font-bold px-2.5 py-1 rounded-full border border-emerald-300">
            บันทึกแล้ว
          </span>
        </div>
        <div className="p-3 bg-white rounded-xl border border-emerald-100 space-y-2 text-xs">
          <div className="flex items-center gap-2">
            <span className="text-slate-500">คะแนนความพึงพอใจ:</span>
            <div className="flex items-center text-amber-500 font-bold text-sm">
              {[1, 2, 3, 4, 5].map((star) => (
                <span key={star} className={star <= s.rating ? 'text-amber-400' : 'text-slate-200'}>
                  ★
                </span>
              ))}
              <span className="ml-1.5 text-slate-800">
                ({s.rating}/5 - {ratingLabels[s.rating] || ''})
              </span>
            </div>
          </div>
          {s.tags && s.tags.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 pt-1">
              <span className="text-slate-500">จุดเด่นที่ประทับใจ:</span>
              {s.tags.map((t, idx) => (
                <span key={idx} className="bg-emerald-50 text-emerald-700 px-2 py-0.5 rounded-md border border-emerald-200 text-[11px] font-medium">
                  ✓ {t}
                </span>
              ))}
            </div>
          )}
          {s.comment && (
            <div className="pt-1 text-slate-700">
              <span className="text-slate-500">ข้อเสนอแนะ:</span> {s.comment}
            </div>
          )}
          <div className="pt-1 text-[11px] text-slate-400">
            ประเมินเมื่อ: {fmtTs(s.submittedAt)} โดย {s.submittedByName || s.submittedBy}
          </div>

          {/* สถานะติดตามความคิดเห็นคะแนนต่ำ */}
          {s.rating <= 3 && (
            <div className="mt-2.5 p-3 rounded-xl border border-amber-200 bg-amber-50/50 space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-bold text-amber-950 flex items-center gap-1.5">
                  <span>🛠️</span> การติดตามข้อเสนอแนะและผลการประเมิน
                </span>
                <span
                  className={`text-[11px] font-bold px-2 py-0.5 rounded-full border ${
                    s.followUpStatus === 'RESOLVED'
                      ? 'bg-emerald-100 text-emerald-800 border-emerald-300'
                      : s.followUpStatus === 'IN_PROGRESS'
                      ? 'bg-sky-100 text-sky-800 border-sky-300'
                      : 'bg-amber-100 text-amber-900 border-amber-300'
                  }`}
                >
                  {s.followUpStatus === 'RESOLVED'
                    ? '✓ ดำเนินการแก้ไขแล้ว'
                    : s.followUpStatus === 'IN_PROGRESS'
                    ? '⏱️ อยู่ระหว่างประสานงาน'
                    : '⚠️ รอการตรวจสอบ/ติดต่อ'}
                </span>
              </div>

              {s.followUpNotes && (
                <div className="text-xs text-amber-900 bg-white/90 p-2 rounded-lg border border-amber-200/60 space-y-1">
                  <div>
                    <span className="font-semibold text-slate-700">บันทึกของเจ้าหน้าที่:</span> {s.followUpNotes}
                  </div>
                  {s.followUpByName && (
                    <div className="text-[10px] text-slate-500">
                      โดย {s.followUpByName} {s.followUpAt ? `(${fmtTs(s.followUpAt)})` : ''}
                    </div>
                  )}
                </div>
              )}

              {/* เจ้าหน้าที่สามารถอัปเดตผลการติดตาม */}
              {isStaffUser && me && (
                <FollowUpActionForm requestId={r.id} currentSurvey={s} me={me} />
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  // If not surveyed yet and user is borrower
  if (isBorrower) {
    const handleTagToggle = (tag: string) => {
      setSelectedTags((prev) =>
        prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]
      );
    };

    const ratingDescriptions: Record<number, string> = {
      1: '1 ปรับปรุง',
      2: '2 พอใช้',
      3: '3 ปานกลาง',
      4: '4 ดี',
      5: '5 ดีเยี่ยม',
    };

    return (
      <div className="card border-brand-200 bg-gradient-to-b from-brand-50/40 to-white space-y-4">
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xl">🌟</span>
              <h3 className="font-bold text-slate-900">แบบประเมินความพึงพอใจการใช้บริการ (CSAT)</h3>
            </div>
            <p className="text-xs text-slate-500 mt-0.5">
              ความคิดเห็นของท่านมีคุณค่าอย่างยิ่งในการพัฒนาคุณภาพการให้บริการยืม-คืนอุปกรณ์
            </p>
          </div>
          <span className="text-xs bg-amber-100 text-amber-800 font-bold px-2 py-0.5 rounded-full border border-amber-200">
            รอประเมิน
          </span>
        </div>

        {error && <Alert kind="error">{error}</Alert>}

        {/* 5 Stars Rating Picker */}
        <div>
          <label className="label mb-1.5 font-bold text-slate-700">ระดับความพึงพอใจโดยรวม *</label>
          <div className="grid grid-cols-5 gap-1.5 sm:flex sm:items-center sm:gap-2">
            {[1, 2, 3, 4, 5].map((star) => (
              <button
                key={star}
                type="button"
                onClick={() => setRating(star)}
                className={`flex flex-col items-center justify-center p-2 rounded-xl border transition-all ${
                  rating >= star
                    ? 'border-amber-400 bg-amber-50 text-amber-600 shadow-xs'
                    : 'border-slate-200 bg-white text-slate-300 hover:border-slate-300'
                }`}
                style={{ minHeight: '48px' }}
              >
                <span className="text-2xl leading-none">★</span>
                <span className="text-[10px] font-bold mt-0.5 text-slate-600 text-center">
                  {ratingDescriptions[star]}
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* Tags Selection */}
        <div>
          <label className="label mb-1.5 text-slate-700 font-medium">จุดเด่นที่ท่านประทับใจ (เลือกได้หลายข้อ)</label>
          <div className="flex flex-wrap gap-1.5">
            {CSAT_TAG_OPTIONS.map((tag) => {
              const active = selectedTags.includes(tag);
              return (
                <button
                  key={tag}
                  type="button"
                  onClick={() => handleTagToggle(tag)}
                  className={`text-xs px-2.5 py-1.5 min-h-[36px] inline-flex items-center rounded-lg border transition-all font-medium ${
                    active
                      ? 'bg-brand-600 text-white border-brand-600 shadow-xs'
                      : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  {active ? '✓ ' : '+ '} {tag}
                </button>
              );
            })}
          </div>
        </div>

        {/* Comment textarea */}
        <div>
          <label className="label mb-1 text-slate-700 font-medium">ข้อเสนอแนะเพิ่มเติมเพื่อการปรับปรุง (ไม่บังคับ)</label>
          <textarea
            className="input min-h-[70px] text-xs"
            placeholder="พิมพ์ความคิดเห็นหรือข้อเสนอแนะเพิ่มเติมที่นี่..."
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-1">
          <span className="text-[11px] text-slate-400">
            * ประเมินได้ครั้งเดียว ข้อมูลจะถูกบันทึกเพื่อสรุปสถิติ
          </span>
          <button
            type="button"
            className="btn-primary text-xs min-h-[44px] px-4 w-full sm:w-auto inline-flex items-center justify-center"
            disabled={busy}
            onClick={() => {
              if (me) {
                run(() =>
                  submitSatisfactionSurvey(
                    r.id,
                    { rating, tags: selectedTags, comment },
                    me
                  )
                );
              }
            }}
          >
            {busy ? 'กำลังบันทึก...' : 'ส่งแบบประเมินความพึงพอใจ'}
          </button>
        </div>
      </div>
    );
  }

  // If not surveyed yet and user is staff
  if (isStaffUser) {
    return (
      <div className="card border-slate-200 bg-slate-50/60 space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-lg">🌟</span>
            <h3 className="font-semibold text-slate-800 text-xs">แบบประเมินความพึงพอใจ (CSAT)</h3>
          </div>
          <span className="text-[11px] text-slate-500 bg-slate-200/70 px-2 py-0.5 rounded-full">
            ผู้ยืมยังไม่ได้ประเมิน
          </span>
        </div>
        <p className="text-xs text-slate-500">
          {r.surveyInviteStatus === 'SENT' || r.surveyInviteSentAt
            ? `ส่งอีเมลเชิญประเมินย้อนหลังสำเร็จแล้วเมื่อ ${fmtTs(r.surveyInviteSentAt || r.surveyInviteQueuedAt)}`
            : r.surveyInviteStatus === 'QUEUED' || r.surveyInviteQueuedAt
            ? `นำเข้าคิวส่งอีเมลเชิญประเมินแล้วเมื่อ ${fmtTs(r.surveyInviteQueuedAt)} (รอระบบประมวลผล)`
            : 'ผู้ยืมยังไม่ได้ทำแบบประเมินความพึงพอใจหลังส่งคืน'}
        </p>
        {error && <Alert kind="error">{error}</Alert>}
        <div className="flex justify-end pt-1">
          <button
            type="button"
            className="btn-outline text-xs"
            disabled={busy || inviteSent || Boolean(r.surveyInviteQueuedAt && !r.surveyInviteSentAt)}
            onClick={() => {
              if (me) {
                const isSent = Boolean(r.surveyInviteSentAt || r.surveyInviteStatus === 'SENT');
                let options: { forceResend?: boolean; resendReason?: string } | undefined = undefined;
                if (isSent) {
                  const reason = window.prompt(`คำขอ ${r.id} เคยส่งคำเชิญแล้ว ระบุเหตุผลในการส่งคำเชิญซ้ำ:`);
                  if (!reason || !reason.trim()) return;
                  options = { forceResend: true, resendReason: reason.trim() };
                }
                run(async () => {
                  await sendRetroactiveCsatInvite(r, me, options);
                  setInviteSent(true);
                });
              }
            }}
          >
            {inviteSent ? '✓ ดำเนินการแล้ว' : r.surveyInviteQueuedAt && !r.surveyInviteSentAt ? '⏱️ อยู่ในคิวส่งแล้ว' : r.surveyInviteSentAt ? '✉️ ส่งคำเชิญอีกครั้ง' : '✉️ ส่งอีเมลเชิญตอบแบบประเมินย้อนหลัง'}
          </button>
        </div>
      </div>
    );
  }

  return null;
}

function FollowUpActionForm({
  requestId,
  currentSurvey,
  me,
}: {
  requestId: string;
  currentSurvey: SatisfactionSurvey;
  me: AppUser;
}) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<SurveyFollowUpStatus>(
    currentSurvey.followUpStatus && currentSurvey.followUpStatus !== 'NO_ACTION_NEEDED'
      ? currentSurvey.followUpStatus
      : 'PENDING_REVIEW'
  );
  const [notes, setNotes] = useState(currentSurvey.followUpNotes || '');
  const { busy, error, run } = useAction();

  if (!open) {
    return (
      <div className="pt-1 flex justify-end">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="btn-outline text-xs min-h-[36px] px-3 py-1 bg-white hover:bg-amber-100/50"
        >
          ✏️ บันทึก / ปรับปรุงผลการติดตาม
        </button>
      </div>
    );
  }

  return (
    <div className="p-3 bg-white rounded-xl border border-amber-300 space-y-3 text-xs">
      <div className="font-bold text-slate-800">บันทึกผลการติดตาม / การปรับปรุงบริการ</div>
      {error && <Alert kind="error">{error}</Alert>}
      <div>
        <label className="label mb-1 font-semibold text-slate-700">สถานะการติดตาม</label>
        <select
          className="input text-xs"
          value={status}
          onChange={(e) => setStatus(e.target.value as SurveyFollowUpStatus)}
        >
          <option value="PENDING_REVIEW">⚠️ รอการติดต่อ/ตรวจสอบ (PENDING_REVIEW)</option>
          <option value="IN_PROGRESS">⏱️ อยู่ระหว่างประสานงาน (IN_PROGRESS)</option>
          <option value="RESOLVED">✓ ดำเนินการแก้ไขและชี้แจงแล้ว (RESOLVED)</option>
          <option value="NO_ACTION_NEEDED">ไม่ต้องดำเนินการ (NO_ACTION_NEEDED)</option>
        </select>
      </div>
      <div>
        <label className="label mb-1 font-semibold text-slate-700">บันทึกข้อความสรุปการติดตาม / แนวทางแก้ไข</label>
        <textarea
          className="input text-xs min-h-[60px]"
          placeholder="เช่น ติดต่อผู้ยืมเพื่อขอข้อมูลเพิ่มเติม พบว่าสาย HDMI หลวม ได้เปลี่ยนสายเส้นใหม่ให้แล้ว..."
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </div>
      <div className="flex items-center justify-end gap-2 pt-1">
        <button
          type="button"
          className="btn-outline text-xs min-h-[36px]"
          onClick={() => setOpen(false)}
          disabled={busy}
        >
          ยกเลิก
        </button>
        <button
          type="button"
          className="btn-primary text-xs min-h-[36px] px-4"
          disabled={busy}
          onClick={() => {
            run(async () => {
              await updateSurveyFollowUp(requestId, { status, notes }, me);
              setOpen(false);
            });
          }}
        >
          {busy ? 'กำลังบันทึก...' : 'บันทึกการติดตาม'}
        </button>
      </div>
    </div>
  );
}

function CancelPanel({ r, me }: { r: BorrowRequest; me: AppUser }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const { busy, error, run } = useAction();
  if (!open)
    return (
      <div className="flex justify-end">
        <button className="btn-outline text-rose-600" onClick={() => setOpen(true)}>ยกเลิกคำขอนี้</button>
      </div>
    );
  return (
    <div className="card">
      {error && <div className="mb-3"><Alert>{error}</Alert></div>}
      <label className="label">เหตุผลที่ยกเลิก</label>
      <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} />
      <div className="mt-3 flex gap-2">
        <button className="btn-danger" disabled={busy} onClick={() => run(() => cancelRequest(r, me, reason))}>ยืนยันยกเลิก</button>
        <button className="btn-outline" onClick={() => setOpen(false)}>ปิด</button>
      </div>
      <p className="mt-2 text-xs text-slate-500">
        <Link href="/my-requests/" className="underline">กลับไปหน้าคำขอของฉัน</Link>
      </p>
    </div>
  );
}

/* ผู้ยืมขอยืมต่อ (ขอต่ออายุ) */
function BorrowerExtensionPanel({ r, me }: { r: BorrowRequest; me: AppUser }) {
  const [open, setOpen] = useState(false);
  const minDate = addDays(r.expectedReturnDate, 1);
  const [newDate, setNewDate] = useState(addDays(r.expectedReturnDate, 3));
  const [reason, setReason] = useState('');
  const { data: all } = useAllRequests();
  const conflicts = useMemo(
    () => (newDate ? findConflicts(all, r.equipment.equipmentId, r.expectedReturnDate, newDate, r.id) : []),
    [all, r, newDate]
  );
  const { busy, error, run } = useAction();

  // If there's an active pending extension
  if (r.extension && ['PENDING_REVIEW', 'PENDING_APPROVAL'].includes(r.extension.status)) {
    return (
      <div className="card border-amber-300 bg-amber-50/50 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <RefreshCw className="h-5 w-5 text-amber-600 animate-spin" />
            <h3 className="font-bold text-amber-950">
              {r.extension.status === 'PENDING_REVIEW'
                ? 'คำขอขอยืมต่อ (ต่ออายุ) อยู่ระหว่างผู้ดูแลอุปกรณ์ตรวจสอบ'
                : 'คำขอขอยืมต่อ (ต่ออายุ) ผ่านการตรวจแล้ว อยู่ระหว่างผู้อนุมัติพิจารณา'}
            </h3>
          </div>
          <ExtensionBadge status={r.extension.status} />
        </div>
        <div className="rounded-xl bg-white p-3.5 border border-amber-200 text-xs text-slate-800 space-y-1.5">
          <div className="flex justify-between">
            <span className="text-slate-500">ขอยืดกำหนดส่งคืนถึง:</span>
            <span className="font-bold text-slate-900">
              {fmtDate(r.extension.newExpectedReturnDate)} (เพิ่ม {daysInclusive(r.expectedReturnDate, r.extension.newExpectedReturnDate) - 1} วัน)
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-500">เหตุผลความจำเป็น:</span>
            <span className="font-medium text-slate-800">{r.extension.reason}</span>
          </div>
          <div className="flex justify-between text-slate-500 font-medium">
            <span>ยื่นคำขอเมื่อ:</span>
            <span>{fmtTs(r.extension.requestedAt)}</span>
          </div>
        </div>
        {error && <Alert kind="error">{error}</Alert>}
        <div className="flex justify-end pt-1">
          <button
            type="button"
            className="btn-outline text-xs text-rose-600 hover:bg-rose-50 border-rose-200"
            disabled={busy}
            onClick={() => run(() => cancelExtension(r, me))}
          >
            ยกเลิกคำขอต่ออายุนี้
          </button>
        </div>
      </div>
    );
  }

  if (!open) {
    return (
      <div className="card bg-gradient-to-r from-blue-50/60 to-indigo-50/60 border-blue-200 flex flex-col sm:flex-row items-center justify-between gap-4">
        <div className="space-y-1 text-center sm:text-left">
          <h3 className="font-heading font-bold text-slate-900 flex items-center gap-2 justify-center sm:justify-start">
            <RefreshCw className="h-4 w-4 text-brand-600" /> ขอยืมต่อ (ขอต่ออายุการใช้งาน)
          </h3>
          <p className="text-xs text-slate-600">
            หากมีภารกิจจำเป็นต้องใช้อุปกรณ์ต่อเนื่อง ท่านสามารถยื่นขอต่ออายุได้ (ผ่านการตรวจและอนุมัติ 2 ขั้นตอน)
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="btn-primary flex-shrink-0 text-sm shadow-xs"
        >
          + ยื่นเรื่องขอยืมต่อ
        </button>
      </div>
    );
  }

  return (
    <div className="card border-2 border-brand-300 bg-brand-50/30 space-y-4">
      <div className="flex items-center justify-between border-b border-brand-100 pb-2">
        <div className="flex items-center gap-2">
          <RefreshCw className="h-5 w-5 text-brand-700" />
          <h3 className="font-heading font-bold text-slate-900">ยื่นคำขอต่ออายุการยืม (ขอยืมต่อ)</h3>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-xs text-slate-500 hover:text-slate-800"
        >
          ✕ ปิด
        </button>
      </div>

      {error && <Alert kind="error">{error}</Alert>}

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label">กำหนดคืนเดิม</label>
          <input className="input bg-slate-100 font-bold" value={fmtDate(r.expectedReturnDate)} readOnly />
        </div>
        <div>
          <label className="label">
            ต้องการขอยืดกำหนดส่งคืนถึง <span className="text-rose-600">*</span>
          </label>
          <input
            type="date"
            className="input font-bold"
            min={minDate}
            value={newDate}
            onChange={(e) => setNewDate(e.target.value)}
            required
          />
        </div>
      </div>

      <div>
        <label className="label">
          เหตุผลและความจำเป็นในการขอยืมต่อ <span className="text-rose-600">*</span>
        </label>
        <textarea
          className="input min-h-[80px]"
          placeholder="ระบุเหตุผล เช่น กิจกรรมอบรมขยายเวลาเพิ่มอีก 2 วัน..."
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          required
        />
      </div>

      {conflicts.length > 0 && (
        <div className="rounded-xl bg-rose-50 p-3 border border-rose-200 text-xs text-rose-800 space-y-1">
          <div className="font-bold flex items-center gap-1">
            <AlertTriangle className="h-4 w-4 text-rose-600" /> ช่วงเวลาที่ขอต่ออายุมีผู้จองแล้ว:
          </div>
          <p>คำขอ {conflicts.map((c) => c.id).join(', ')} ได้จองอุปกรณ์นี้ไว้แล้ว</p>
        </div>
      )}

      <div className="flex items-center justify-end gap-3 pt-2 border-t border-brand-100">
        <button
          type="button"
          className="btn-outline text-xs"
          disabled={busy}
          onClick={() => setOpen(false)}
        >
          ยกเลิก
        </button>
        <button
          type="button"
          className="btn-cta text-xs px-5"
          disabled={busy || !reason.trim() || !newDate || newDate <= r.expectedReturnDate || conflicts.length > 0}
          onClick={() =>
            run(async () => {
              await requestExtension(r, me, {
                newExpectedReturnDate: newDate,
                reason: reason.trim(),
              });
              setOpen(false);
            })
          }
        >
          {busy ? 'กำลังส่งคำขอ...' : '✓ ส่งคำขอต่ออายุ'}
        </button>
      </div>
    </div>
  );
}

/* ขั้นที่ 1: นายชาลีตรวจคำขอต่ออายุ */
function ExtensionReviewPanel({ r, me }: { r: BorrowRequest; me: AppUser }) {
  const ext = r.extension;
  const [comment, setComment] = useState('');
  const { data: all } = useAllRequests();
  const conflicts = useMemo(
    () => (ext ? findConflicts(all, r.equipment.equipmentId, r.expectedReturnDate, ext.newExpectedReturnDate, r.id) : []),
    [all, r, ext]
  );
  const { busy, error, run } = useAction();

  if (!ext || ext.status !== 'PENDING_REVIEW') return null;

  return (
    <div className="card border-amber-300 bg-amber-50/50 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <RefreshCw className="h-5 w-5 text-amber-700" />
          <h3 className="font-bold text-amber-950">🔍 ตรวจสอบคำขอต่ออายุการยืม (ผู้ดูแลอุปกรณ์)</h3>
        </div>
        <span className="text-xs bg-amber-200 text-amber-900 px-2.5 py-0.5 rounded-full font-bold">
          รอตรวจสอบ
        </span>
      </div>

      {error && <Alert kind="error">{error}</Alert>}

      <div className="rounded-xl bg-white p-4 border border-amber-200 text-sm space-y-2">
        <div className="flex justify-between">
          <span className="text-slate-500">กำหนดส่งคืนเดิม:</span>
          <span className="font-semibold text-slate-800">{fmtDate(r.expectedReturnDate)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-slate-500">กำหนดส่งคืนใหม่ที่ขอ:</span>
          <span className="font-bold text-amber-700">{fmtDate(ext.newExpectedReturnDate)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-slate-500">เหตุผลจากผู้ยืม:</span>
          <span className="font-medium text-slate-900">{ext.reason}</span>
        </div>
      </div>

      {conflicts.length > 0 ? (
        <div className="rounded-xl bg-rose-50 p-3 border border-rose-200 text-xs text-rose-800 space-y-1">
          <div className="font-bold flex items-center gap-1">
            <AlertTriangle className="h-4 w-4 text-rose-600" /> ตรวจพบการจองซ้อนในช่วงต่ออายุ:
          </div>
          <p>
            มีคำขอ {conflicts.map((c) => `${c.id} (${fmtDate(c.startDate)}–${fmtDate(c.expectedReturnDate)})`).join(', ')} จองอุปกรณ์นี้ไว้แล้ว
          </p>
        </div>
      ) : (
        <div className="rounded-xl bg-emerald-50 p-2.5 border border-emerald-200 text-xs text-emerald-800 flex items-center gap-1.5 font-medium">
          <CheckCircle2 className="h-4 w-4 text-emerald-600" /> ไม่พบการจองซ้อน สามารถส่งต่อผู้อนุมัติได้
        </div>
      )}

      <div>
        <label className="label">ความเห็น/หมายเหตุผู้ดูแล</label>
        <input
          className="input bg-white"
          placeholder="ระบุความเห็นเพิ่มเติม (ถ้ามี)"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
      </div>

      <div className="flex flex-wrap gap-2 pt-1">
        <button
          className="btn-success text-xs"
          disabled={busy || conflicts.length > 0}
          onClick={() => run(() => reviewExtension(r, me, { passed: true, comment }))}
        >
          ✓ ตรวจสอบผ่าน — ส่งต่อผู้อนุมัติ
        </button>
        <button
          className="btn-danger text-xs"
          disabled={busy}
          onClick={() =>
            run(() =>
              reviewExtension(r, me, {
                passed: false,
                reason: comment || 'ไม่สามารถให้ยืมต่อได้',
                comment,
              })
            )
          }
        >
          ✕ ไม่อนุญาตให้ยืมต่อ
        </button>
      </div>
    </div>
  );
}

/* ขั้นที่ 2: นายประหยัดอนุมัติต่ออายุ */
function ExtensionApprovePanel({ r, me }: { r: BorrowRequest; me: AppUser }) {
  const ext = r.extension;
  const [comment, setComment] = useState('');
  const { busy, error, run } = useAction();

  if (!ext || ext.status !== 'PENDING_APPROVAL') return null;

  return (
    <div className="card border-sky-300 bg-sky-50/50 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <RefreshCw className="h-5 w-5 text-sky-700" />
          <h3 className="font-bold text-sky-950">✅ พิจารณาอนุมัติต่ออายุการยืม (ผู้อนุมัติ)</h3>
        </div>
        <span className="text-xs bg-sky-200 text-sky-900 px-2.5 py-0.5 rounded-full font-bold">
          รออนุมัติ
        </span>
      </div>

      {error && <Alert kind="error">{error}</Alert>}

      <div className="rounded-xl bg-white p-4 border border-sky-200 text-sm space-y-2">
        <div className="flex justify-between">
          <span className="text-slate-500">กำหนดส่งคืนเดิม:</span>
          <span className="font-semibold text-slate-800">{fmtDate(r.expectedReturnDate)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-slate-500">กำหนดส่งคืนใหม่ที่ขอ:</span>
          <span className="font-bold text-sky-700">{fmtDate(ext.newExpectedReturnDate)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-slate-500">เหตุผลจากผู้ยืม:</span>
          <span className="font-medium text-slate-900">{ext.reason}</span>
        </div>
        {ext.review && (
          <div className="flex justify-between border-t border-slate-100 pt-2 text-xs">
            <span className="text-slate-500">ผลการตรวจจากผู้ดูแล:</span>
            <span className="font-medium text-emerald-800">
              {ext.review.reviewerName} (ผ่าน) {ext.review.comment ? `· “${ext.review.comment}”` : ''}
            </span>
          </div>
        )}
      </div>

      <div>
        <label className="label">ความเห็นผู้อนุมัติ (จำเป็นกรณีไม่อนุมัติ)</label>
        <textarea
          className="input min-h-[70px] bg-white"
          placeholder="ระบุความเห็น..."
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
      </div>

      <div className="flex gap-2 pt-1">
        <button
          className="btn-success text-xs"
          disabled={busy}
          onClick={() => run(() => approveExtension(r, me, true, comment))}
        >
          ✓ อนุมัติต่ออายุ
        </button>
        <button
          className="btn-danger text-xs"
          disabled={busy || !comment.trim()}
          onClick={() => run(() => approveExtension(r, me, false, comment))}
        >
          ✕ ไม่อนุมัติต่ออายุ
        </button>
      </div>
    </div>
  );
}

/* การแสดงประวัติการขอต่ออายุ */
function ExtensionHistoryCard({ r }: { r: BorrowRequest }) {
  if (!r.extensionHistory || r.extensionHistory.length === 0) return null;

  return (
    <div className="card space-y-3">
      <div className="flex items-center gap-2 border-b border-slate-100 pb-2">
        <RefreshCw className="h-4 w-4 text-brand-600" />
        <h3 className="font-bold text-slate-900 text-sm">ประวัติการขอต่ออายุ (Extension History)</h3>
      </div>
      <div className="space-y-2.5">
        {r.extensionHistory.map((hist, i) => (
          <div key={i} className="rounded-xl bg-slate-50 p-3 border border-slate-200 text-xs space-y-1">
            <div className="flex items-center justify-between font-bold">
              <span className="text-slate-800">
                ครั้งที่ {i + 1}: ขยายเป็น {fmtDate(hist.newExpectedReturnDate)}
              </span>
              <ExtensionBadge status={hist.status} />
            </div>
            <div className="text-slate-600">
              <b>เหตุผล:</b> {hist.reason}
            </div>
            {hist.approverComment && (
              <div className="text-slate-500">
                <b>ความเห็นผู้อนุมัติ:</b> {hist.approverComment} ({hist.approvedByName})
              </div>
            )}
            <div className="text-[11px] text-slate-400">
              ยื่นเมื่อ {fmtTs(hist.requestedAt)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
