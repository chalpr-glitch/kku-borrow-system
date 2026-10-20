'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { BarChart3, Star, MessageSquare, AlertCircle, CheckCircle, Clock, Printer, Wrench } from 'lucide-react';
import AppShell from '@/components/AppShell';
import { Alert, Bar, EmptyState, ExceptionBadge, ExtensionBadge, LoadingState, Modal, StatCard } from '@/components/ui';
import { RepairFormModal } from '@/components/RepairFormModal';
import { useAllRequests, useCategories, useEquipments, useUsers } from '@/lib/hooks';
import type { AppUser, BorrowRequest, RequestStatus, SurveyFollowUpStatus } from '@/lib/types';
import { FOLLOW_UP_STATUS_META } from '@/lib/types';
import { useAuth } from '@/lib/auth-context';
import { logAudit } from '@/lib/audit';
import { sendRetroactiveCsatInvite, updateSurveyFollowUp } from '@/lib/requests';
import {
  STATUS_META,
  daysInclusive,
  downloadCsv,
  fmtDate,
  fmtTs,
  sortByCreatedDesc,
  todayStr,
} from '@/lib/utils';

export default function ReportsPage() {
  return (
    <AppShell
      title="รายงานสรุปการยืม-คืนและสถิติ"
      roles={['CUSTODIAN', 'APPROVER', 'EXECUTIVE']}
      actions={
        <button
          onClick={() => window.print()}
          className="btn-outline no-print text-xs"
        >
          🖨️ พิมพ์รายงาน / บันทึก PDF
        </button>
      }
    >
      <Suspense fallback={<LoadingState text="กำลังโหลดรายงานและสถิติ..." />}>
        <ReportsView />
      </Suspense>
    </AppShell>
  );
}

function ReportsView() {
  const searchParams = useSearchParams();
  const urlTab = searchParams.get('tab');
  const [activeTab, setActiveTab] = useState<'overview' | 'csat'>(
    urlTab === 'csat' ? 'csat' : 'overview'
  );

  useEffect(() => {
    if (urlTab === 'csat') setActiveTab('csat');
    else if (urlTab === 'overview' || !urlTab) setActiveTab('overview');
  }, [urlTab]);
  const { profile } = useAuth();
  const { data: requests, loading: reqLoading } = useAllRequests();
  const { data: equipments } = useEquipments();
  const { data: categories } = useCategories();
  const { data: users } = useUsers();
  const [repairModalOpen, setRepairModalOpen] = useState(false);
  const [repairModalEquipments, setRepairModalEquipments] = useState<any[]>([]);

  const today = todayStr();
  const [startDate, setStartDate] = useState(() => {
    const d = new Date();
    d.setMonth(d.getMonth() - 1);
    return d.toISOString().slice(0, 10);
  });
  const [endDate, setEndDate] = useState(today);
  const [selectedDept, setSelectedDept] = useState('');
  const [selectedCat, setSelectedCat] = useState('');

  const catMap = useMemo(
    () => Object.fromEntries(categories.map((c) => [c.id, c.name])),
    [categories]
  );

  const isDateRangeInvalid = Boolean(startDate && endDate && startDate > endDate);

  // กรองข้อมูลตามช่วงวันที่เริ่มต้นยืมและหน่วยงาน
  const filteredRequests = useMemo(() => {
    if (isDateRangeInvalid) return [];
    return requests.filter((r) => {
      if (startDate && r.startDate < startDate) return false;
      if (endDate && r.startDate > endDate) return false;
      if (selectedDept && r.borrower.departmentCode !== selectedDept) return false;
      return true;
    });
  }, [requests, startDate, endDate, selectedDept, isDateRangeInvalid]);

  // สถิติภาพรวม
  const stats = useMemo(() => {
    const total = filteredRequests.length;
    const completed = filteredRequests.filter((r) =>
      ['RETURNED', 'RETURNED_DAMAGED'].includes(r.status)
    ).length;
    const inUse = filteredRequests.filter((r) => r.status === 'IN_USE').length;
    const overdue = filteredRequests.filter((r) => r.status === 'OVERDUE').length;
    const rejected = filteredRequests.filter((r) =>
      ['REVIEW_REJECTED', 'REJECTED'].includes(r.status)
    ).length;
    const damagedOrLost = filteredRequests.filter((r) =>
      ['RETURNED_DAMAGED', 'LOST'].includes(r.status)
    ).length;

    return { total, completed, inUse, overdue, rejected, damagedOrLost };
  }, [filteredRequests]);

  const [invitingId, setInvitingId] = useState<string | null>(null);
  const [sentMap, setSentMap] = useState<Record<string, boolean>>({});
  const [batchSending, setBatchSending] = useState(false);
  const [batchMessage, setBatchMessage] = useState<string | null>(null);
  const [followUpFilter, setFollowUpFilter] = useState<'ALL' | SurveyFollowUpStatus>('ALL');
  const [editingFollowUpRequest, setEditingFollowUpRequest] = useState<BorrowRequest | null>(null);

  // สถิติความพึงพอใจการใช้บริการ (CSAT Analytics)
  const csatStats = useMemo(() => {
    const returnedList = filteredRequests.filter((r) =>
      ['RETURNED', 'RETURNED_DAMAGED', 'LOST'].includes(r.status)
    );
    const surveyedList = returnedList.filter((r) => r.survey && r.survey.rating);
    const totalSurveyed = surveyedList.length;
    const responseRate = returnedList.length > 0 ? Math.round((totalSurveyed / returnedList.length) * 100) : 0;

    const sumRating = surveyedList.reduce((acc, r) => acc + (r.survey?.rating || 0), 0);
    const avgRating = totalSurveyed > 0 ? (sumRating / totalSurveyed).toFixed(1) : '0.0';

    const starCounts: Record<number, number> = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
    const tagCounts: Record<string, number> = {};
    const recentComments: { requestId: string; borrowerName: string; rating: number; tags?: string[]; comment: string; date: string }[] = [];

    surveyedList.forEach((r) => {
      const s = r.survey;
      if (s) {
        starCounts[s.rating] = (starCounts[s.rating] || 0) + 1;
        (s.tags || []).forEach((t) => {
          tagCounts[t] = (tagCounts[t] || 0) + 1;
        });
        if (s.comment) {
          recentComments.push({
            requestId: r.id,
            borrowerName: r.borrower.name,
            rating: s.rating,
            tags: s.tags,
            comment: s.comment,
            date: s.submittedAt ? fmtTs(s.submittedAt) : '',
          });
        }
      }
    });

    const topTags = Object.entries(tagCounts)
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count);

    const pendingSurveys = returnedList.filter((r) => !r.survey);
    const lowRatingSurveys = surveyedList.filter(
      (r) => (r.survey?.rating || 0) <= 3 || Boolean(r.survey?.needsFollowUp)
    );

    return {
      totalReturned: returnedList.length,
      totalSurveyed,
      responseRate,
      avgRating,
      starCounts,
      topTags,
      recentComments,
      pendingSurveys,
      lowRatingSurveys,
    };
  }, [filteredRequests]);

  // สถิติการยืมแยกตามหมวดหมู่
  const categoryStats = useMemo(() => {
    const counts: Record<string, number> = {};
    filteredRequests.forEach((r) => {
      const eq = equipments.find((e) => e.id === r.equipment.equipmentId);
      const catId = eq?.categoryId || 'CAT-OTHER';
      counts[catId] = (counts[catId] || 0) + 1;
    });
    return Object.entries(counts)
      .map(([catId, count]) => ({
        catId,
        name: catMap[catId] || catId,
        count,
      }))
      .sort((a, b) => b.count - a.count);
  }, [filteredRequests, equipments, catMap]);

  // สถิติการยืมแยกตามภารกิจ/หน่วยงาน
  const deptStats = useMemo(() => {
    const counts: Record<string, { count: number; name: string }> = {};
    filteredRequests.forEach((r) => {
      const mission = r.borrower.mission || 'ไม่ระบุ';
      if (!counts[mission]) {
        counts[mission] = { count: 0, name: mission };
      }
      counts[mission].count += 1;
    });
    return Object.values(counts).sort((a, b) => b.count - a.count);
  }, [filteredRequests]);

  // ครุภัณฑ์ที่ถูกยืมบ่อยที่สุด Top 5
  const topEquipments = useMemo(() => {
    const counts: Record<string, { name: string; assetNumber: string; count: number }> = {};
    filteredRequests.forEach((r) => {
      const id = r.equipment.equipmentId;
      if (!counts[id]) {
        counts[id] = {
          name: r.equipment.name,
          assetNumber: r.equipment.assetNumber,
          count: 0,
        };
      }
      counts[id].count += 1;
    });
    return Object.values(counts)
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
  }, [filteredRequests]);

  // สถิติสถานะครุภัณฑ์ทั้งหมด
  const equipmentStatusCounts = useMemo(() => {
    const counts: Record<string, number> = {
      AVAILABLE: 0,
      BORROWED: 0,
      MAINTENANCE: 0,
      LOST: 0,
      RETIRED: 0,
    };
    equipments.filter((e) => !e.isDeleted).forEach((e) => {
      counts[e.status] = (counts[e.status] || 0) + 1;
    });
    return counts;
  }, [equipments]);

  // Export CSV รายงานสรุป
  const handleExportCsv = () => {
    const header = [
      'เลขที่คำขอ',
      'สถานะ',
      'รหัสบุคลากร',
      'ชื่อผู้ยืม',
      'ตำแหน่ง',
      'ภารกิจ/สังกัด',
      'รหัสครุภัณฑ์',
      'ชื่อครุภัณฑ์',
      'วันที่ยืม',
      'กำหนดคืนเดิม',
      'กำหนดคืนล่าสุด',
      'จำนวนวัน',
      'กรณีพิเศษ (>15วัน)',
      'เหตุผลข้อยกเว้น',
      'จำนวนครั้งต่ออายุ',
      'สถานะการต่ออายุ',
      'วันที่คืนจริง',
      'เกินกำหนด(วัน)',
      'ผู้ตรวจสอบ',
      'ผลตรวจสอบ',
      'ผู้อนุมัติ',
      'ผลอนุมัติ',
      'ผู้ส่งมอบ',
      'ผู้รับคืน',
      'สภาพตอนคืน',
      'วัตถุประสงค์',
      'คะแนนประเมิน (CSAT)',
      'จุดเด่นที่ประทับใจ',
      'ความคิดเห็นแบบประเมิน',
    ];

    const rows = filteredRequests.map((r) => [
      r.id,
      STATUS_META[r.status]?.label || r.status,
      r.borrower.employeeCode,
      r.borrower.name,
      r.borrower.position,
      r.borrower.mission,
      r.equipment.assetNumber,
      r.equipment.name,
      r.startDate,
      r.originalExpectedReturnDate || r.expectedReturnDate,
      r.expectedReturnDate,
      r.durationDays,
      r.isException ? 'ใช่' : 'ไม่ใช่',
      r.exceptionReason || '',
      r.extensionHistory?.length || 0,
      r.extension?.status
        ? r.extension.status === 'APPROVED'
          ? 'ต่ออายุแล้ว'
          : r.extension.status === 'PENDING_REVIEW'
          ? 'รอตรวจต่ออายุ'
          : r.extension.status === 'PENDING_APPROVAL'
          ? 'รออนุมัติต่ออายุ'
          : 'ไม่อนุมัติต่ออายุ'
        : '',
      r.returnInfo?.actualReturnDate || '',
      r.returnInfo?.lateDays || (r.status === 'OVERDUE' ? Math.max(0, daysInclusive(r.expectedReturnDate, today) - 1) : 0),
      r.review?.reviewerName || '',
      r.review?.result === 'PASSED' ? 'ยืมได้' : r.review?.result === 'FAILED' ? 'ยืมไม่ได้' : '',
      r.approval?.approverName || '',
      r.approval?.result === 'APPROVED' ? 'อนุมัติ' : r.approval?.result === 'REJECTED' ? 'ไม่อนุมัติ' : '',
      r.handover?.custodianName || '',
      r.returnInfo?.receivedByName || '',
      r.returnInfo?.condition ? { NORMAL: 'สมบูรณ์', DAMAGED: 'ชำรุด', LOST: 'สูญหาย' }[r.returnInfo.condition] : '',
      r.purpose,
      r.survey?.rating ? `${r.survey.rating}/5` : 'ยังไม่ประเมิน',
      (r.survey?.tags || []).join('; '),
      r.survey?.comment || '',
    ]);

    downloadCsv(`รายงานสรุปการยืม-คืน_${startDate}_ถึง_${endDate}.csv`, [header, ...rows]);

    if (profile) {
      logAudit(
        'EXPORT_REPORT',
        `reports_${startDate}_to_${endDate}.csv`,
        `ส่งออกรายงานสรุปการยืม-คืน (${filteredRequests.length} รายการ)`,
        profile
      ).catch((e) => console.warn('Audit export error:', e));
    }
  };

  const maxCatCount = Math.max(...categoryStats.map((c) => c.count), 1);
  const maxDeptCount = Math.max(...deptStats.map((d) => d.count), 1);

  const handleSendSingleInvite = async (r: BorrowRequest) => {
    if (!profile) return;
    const isSent = Boolean(sentMap[r.id] || r.surveyInviteStatus === 'SENT' || r.surveyInviteSentAt);
    let options: { forceResend?: boolean; resendReason?: string } | undefined = undefined;
    if (isSent) {
      const reason = window.prompt(`คำขอ ${r.id} เคยส่งคำเชิญแล้ว ระบุเหตุผลในการส่งคำเชิญซ้ำ:`);
      if (!reason || !reason.trim()) return;
      options = { forceResend: true, resendReason: reason.trim() };
    }
    setInvitingId(r.id);
    try {
      await sendRetroactiveCsatInvite(r, profile, options);
      setSentMap((prev) => ({ ...prev, [r.id]: true }));
    } catch (err: any) {
      alert(`ไม่สามารถส่งคำเชิญได้: ${err.message || 'เกิดข้อผิดพลาด'}`);
    } finally {
      setInvitingId(null);
    }
  };

  const handleSendBatchInvites = async () => {
    if (!profile) return;
    const targets = csatStats.pendingSurveys.filter(
      (r) => !r.surveyInviteSentAt && !r.surveyInviteQueuedAt && !sentMap[r.id]
    );
    if (!targets.length) {
      alert('ไม่มีคำขอที่ยังไม่เคยส่งคำเชิญ');
      return;
    }
    if (!confirm(`ยืนยันการส่งอีเมลเชิญทำแบบประเมินย้อนหลังไปยังผู้ยืมจำนวน ${targets.length} ท่าน?`)) {
      return;
    }
    setBatchSending(true);
    setBatchMessage(null);
    let successCount = 0;
    const newSentMap = { ...sentMap };

    for (const r of targets) {
      try {
        await sendRetroactiveCsatInvite(r, profile);
        newSentMap[r.id] = true;
        successCount++;
      } catch (e) {
        console.warn(`Failed invite for ${r.id}:`, e);
      }
    }

    setSentMap(newSentMap);
    setBatchSending(false);
    setBatchMessage(`ส่งอีเมลเชิญสำเร็จ ${successCount} จากทั้งหมด ${targets.length} รายการ`);
  };

  return (
    <div className="space-y-6 pb-4 sm:pb-8">
      {/* ตัวกรองข้อมูล */}
      <div className="card no-print space-y-3">
        <div className="flex items-center justify-between">
          <div className="font-semibold text-slate-800">🔍 ตัวกรองรายงาน (กรองตามวันที่เริ่มต้นยืม)</div>
          <span className="text-xs text-slate-500 font-medium">พบ {filteredRequests.length} รายการ</span>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label className="label">ตั้งแต่วันที่</label>
            <input
              type="date"
              className={`input ${isDateRangeInvalid ? 'border-rose-500 focus:ring-rose-500' : ''}`}
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </div>
          <div>
            <label className="label">ถึงวันที่</label>
            <input
              type="date"
              className={`input ${isDateRangeInvalid ? 'border-rose-500 focus:ring-rose-500' : ''}`}
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
            />
          </div>
          <div>
            <label className="label">ตัวเลือกการส่งออก</label>
            <button
              onClick={handleExportCsv}
              className="btn-primary w-full"
              disabled={reqLoading || isDateRangeInvalid || !filteredRequests.length}
            >
              📥 ส่งออกรายงาน Excel (.csv)
            </button>
          </div>
        </div>

        {isDateRangeInvalid && (
          <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs font-bold text-rose-800 flex items-center gap-2">
            <span>⚠️ ช่วงวันที่ไม่ถูกต้อง: วันที่เริ่มต้น ({fmtDate(startDate)}) ต้องไม่มากกว่าวันที่สิ้นสุด ({fmtDate(endDate)})</span>
          </div>
        )}
      </div>

      {/* แถบสลับมุมมองรายงาน (Tab Switcher) */}
      <div className="no-print overflow-x-auto max-w-full scrollbar-none pb-1">
        <div className="flex items-center gap-2 p-1 bg-slate-200/80 rounded-2xl w-max" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'overview'}
            className={`min-h-[44px] rounded-xl px-5 py-2 text-base font-bold whitespace-nowrap flex-shrink-0 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#123B68] ${
              activeTab === 'overview'
                ? 'bg-white text-[#123B68] shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
            onClick={() => setActiveTab('overview')}
          >
            <span className="flex items-center gap-2">
              <BarChart3 className="h-4 w-4" />
              <span>รายงานภาพรวมและสถิติการยืม-คืน</span>
            </span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'csat'}
            className={`min-h-[44px] rounded-xl px-5 py-2 text-base font-bold whitespace-nowrap flex-shrink-0 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#123B68] ${
              activeTab === 'csat'
                ? 'bg-white text-[#123B68] shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
            onClick={() => setActiveTab('csat')}
          >
            <span className="flex items-center gap-2">
              <Star className="h-4 w-4 text-amber-500 fill-amber-400" />
              <span>ความพึงพอใจและความคิดเห็น (CSAT)</span>
              {csatStats.lowRatingSurveys.filter(
                (r) => !r.survey?.followUpStatus || r.survey?.followUpStatus === 'PENDING_REVIEW'
              ).length > 0 && (
                <span className="ml-1 rounded-full bg-rose-500 text-white text-xs px-2 py-0.5 font-bold shadow-2xs">
                  ต้องติดตาม {csatStats.lowRatingSurveys.filter(
                    (r) => !r.survey?.followUpStatus || r.survey?.followUpStatus === 'PENDING_REVIEW'
                  ).length}
                </span>
              )}
            </span>
          </button>
        </div>
      </div>

      {/* หัวรายงานสำหรับพิมพ์ */}
      <div className="hidden border-b pb-4 text-center print:block">
        <h1 className="text-xl font-bold">รายงานสรุปการยืม-คืนครุภัณฑ์และสถิติ</h1>
        <p className="text-sm text-slate-600">
          สำนักบริการวิชาการ มหาวิทยาลัยขอนแก่น
        </p>
        <p className="text-xs text-slate-500">
          ข้อมูลระหว่างวันที่ {fmtDate(startDate)} ถึง {fmtDate(endDate)} (พิมพ์เมื่อ: {fmtDate(today)})
        </p>
      </div>

      {/* ========================================================= */}
      {/* 1. แท็บรายงานภาพรวมและสถิติ (Overview Analytics Tab) */}
      {/* ========================================================= */}
      {activeTab === 'overview' && (
        <>
          {/* KPI Cards: ภาพรวมการยืม-คืน */}
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6 sm:gap-4">
            <StatCard label="คำขอทั้งหมด" value={stats.total} tone="brand" />
            <StatCard label="ส่งคืนสำเร็จ" value={stats.completed} tone="green" />
            <StatCard label="กำลังใช้งาน" value={stats.inUse} tone="sky" />
            <StatCard label="เกินกำหนดคืน" value={stats.overdue} tone="red" />
            <StatCard label="ไม่อนุมัติ/ยืมไม่ได้" value={stats.rejected} tone="slate" />
            <StatCard label="ชำรุด / สูญหาย" value={stats.damagedOrLost} tone={stats.damagedOrLost > 0 ? 'red' : 'slate'} />
          </div>

      {/* กราฟและสถิติแจกแจง */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* สถิติตามภารกิจ / สังกัด */}
        <div className="card">
          <h3 className="mb-4 font-semibold text-slate-800">
            🏢 สถิติการยืมตามภารกิจ/หน่วยงาน
          </h3>
          {deptStats.length === 0 ? (
            <div className="text-center text-sm text-slate-500 font-medium py-6">ไม่มีข้อมูล</div>
          ) : (
            <div className="space-y-3">
              {deptStats.map((d) => (
                <Bar
                  key={d.name}
                  label={d.name}
                  value={d.count}
                  max={maxDeptCount}
                  suffix=" ครั้ง"
                />
              ))}
            </div>
          )}
        </div>

        {/* สถิติตามหมวดหมู่ครุภัณฑ์ */}
        <div className="card">
          <h3 className="mb-4 font-semibold text-slate-800">
            🏷️ สถิติการยืมตามประเภทครุภัณฑ์
          </h3>
          {categoryStats.length === 0 ? (
            <div className="text-center text-sm text-slate-500 font-medium py-6">ไม่มีข้อมูล</div>
          ) : (
            <div className="space-y-3">
              {categoryStats.map((c) => (
                <Bar
                  key={c.catId}
                  label={c.name}
                  value={c.count}
                  max={maxCatCount}
                  suffix=" ครั้ง"
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* ครุภัณฑ์ที่มีการยืมสูงสุด Top 5 */}
        <div className="card">
          <h3 className="mb-3 font-semibold text-slate-800">
            🔥 ครุภัณฑ์ที่ถูกยืมบ่อยที่สุด (Top 5)
          </h3>
          {topEquipments.length === 0 ? (
            <div className="text-center text-sm text-slate-500 font-medium py-4">ไม่มีข้อมูล</div>
          ) : (
            <div className="divide-y divide-slate-100">
              {topEquipments.map((item, idx) => (
                <div key={idx} className="flex items-center justify-between py-2 text-sm">
                  <div>
                    <div className="font-medium text-slate-800">
                      {idx + 1}. {item.name}
                    </div>
                    <div className="text-xs text-slate-500 font-mono">
                      {item.assetNumber}
                    </div>
                  </div>
                  <div className="font-semibold text-brand-700">
                    {item.count} ครั้ง
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* สถานะคงคลังครุภัณฑ์ปัจจุบัน */}
        <div className="card">
          <h3 className="mb-3 font-semibold text-slate-800">
            📦 สรุปสถานะครุภัณฑ์ในระบบปัจจุบัน
          </h3>
          <div className="grid grid-cols-2 gap-3 text-center sm:grid-cols-3">
            <div className="rounded-lg bg-emerald-50 p-3">
              <div className="text-xs text-emerald-700">พร้อมใช้งาน</div>
              <div className="text-2xl font-bold text-emerald-800">
                {equipmentStatusCounts.AVAILABLE}
              </div>
            </div>
            <div className="rounded-lg bg-sky-50 p-3">
              <div className="text-xs text-sky-700">อยู่ระหว่างยืม</div>
              <div className="text-2xl font-bold text-sky-800">
                {equipmentStatusCounts.BORROWED}
              </div>
            </div>
            <div className="rounded-lg bg-orange-50 p-3 flex flex-col justify-between">
              <div>
                <div className="text-xs text-orange-700 font-medium">ส่งซ่อมบำรุง</div>
                <div className="text-2xl font-bold text-orange-800">
                  {equipmentStatusCounts.MAINTENANCE}
                </div>
              </div>
              {equipmentStatusCounts.MAINTENANCE > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    const maintenanceItems = equipments.filter(
                      (e) => e.status === 'MAINTENANCE' && !e.isDeleted
                    );
                    setRepairModalEquipments(
                      maintenanceItems.map((eq) => ({
                        equipment: eq,
                        symptom: eq.note || 'ตรวจพบชำรุด / อยู่ระหว่างซ่อมบำรุง',
                        responsiblePerson: profile?.name || '',
                      }))
                    );
                    setRepairModalOpen(true);
                  }}
                  className="mt-2 text-2xs font-bold text-orange-900 bg-orange-200/80 hover:bg-orange-300 py-1 px-2 rounded-md flex items-center justify-center gap-1 transition"
                  title="พิมพ์แบบฟอร์มแจ้งซ่อมแซมสำหรับครุภัณฑ์ที่ส่งซ่อมบำรุงทั้งหมด"
                >
                  <Wrench className="h-3 w-3" /> ออกใบแจ้งซ่อม
                </button>
              )}
            </div>
            <div className="rounded-lg bg-zinc-100 p-3">
              <div className="text-xs text-zinc-600">สูญหาย</div>
              <div className="text-2xl font-bold text-zinc-800">
                {equipmentStatusCounts.LOST}
              </div>
            </div>
            <div className="rounded-lg bg-slate-100 p-3 sm:col-span-2">
              <div className="text-xs text-slate-600">จำหน่าย / เลิกใช้งาน</div>
              <div className="text-2xl font-bold text-slate-700">
                {equipmentStatusCounts.RETIRED}
              </div>
            </div>
          </div>
        </div>
      </div>
      </>
      )}

      {/* ========================================================= */}
      {/* 2. แท็บความพึงพอใจและความคิดเห็น (CSAT & Feedback Tab) */}
      {/* ========================================================= */}
      {activeTab === 'csat' && (
        <div className="space-y-6">
          {/* CSAT KPI Cards */}
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5 sm:gap-4">
            <StatCard label="CSAT คะแนนเฉลี่ย" value={csatStats.totalSurveyed > 0 ? `${csatStats.avgRating} / 5.0` : '-'} tone="brand" />
            <StatCard label="อัตราตอบแบบประเมิน" value={`${csatStats.responseRate}%`} tone="green" />
            <StatCard label="ประเมินแล้วทั้งหมด" value={`${csatStats.totalSurveyed} รายการ`} tone="sky" />
            <StatCard label="รอส่งคำเชิญ/รอตอบ" value={`${csatStats.pendingSurveys.length} รายการ`} tone="slate" />
            <StatCard
              label="ความคิดเห็นที่ต้องติดตาม (≤3 ดาว)"
              value={`${csatStats.lowRatingSurveys.length} รายการ`}
              tone={csatStats.lowRatingSurveys.length > 0 ? 'red' : 'green'}
            />
          </div>

          {/* สรุปความพึงพอใจการใช้บริการ (CSAT Analytics) และ ส่งแบบประเมินย้อนหลัง */}
          <div className="grid gap-6 lg:grid-cols-2">
        {/* การ์ดคะแนนและการกระจายตัว */}
        <div className="card space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-slate-800 flex items-center gap-2">
              <span>🌟</span> สรุปความพึงพอใจการใช้บริการ (CSAT)
            </h3>
            <span className="text-xs font-bold text-brand-700 bg-brand-50 px-2.5 py-1 rounded-full border border-brand-200">
              ตอบแล้ว {csatStats.totalSurveyed} จาก {csatStats.totalReturned} คำขอ ({csatStats.responseRate}%)
            </span>
          </div>

          <div className="flex items-center gap-6 p-4 rounded-xl bg-gradient-to-r from-amber-50/60 to-brand-50/40 border border-amber-200/60">
            <div className="text-center">
              <div className="text-4xl font-extrabold text-amber-500">{csatStats.avgRating}</div>
              <div className="flex items-center justify-center text-amber-400 text-lg">
                {[1, 2, 3, 4, 5].map((star) => (
                  <span key={star}>★</span>
                ))}
              </div>
              <div className="text-[11px] font-medium text-slate-500 mt-0.5">จากเต็ม 5.0 ดาว</div>
            </div>

            <div className="flex-1 space-y-1.5 text-xs">
              {[5, 4, 3, 2, 1].map((s) => {
                const count = csatStats.starCounts[s] || 0;
                const pct = csatStats.totalSurveyed > 0 ? Math.round((count / csatStats.totalSurveyed) * 100) : 0;
                return (
                  <div key={s} className="flex items-center gap-2">
                    <span className="w-12 text-slate-600 font-medium">{s} ดาว</span>
                    <div className="flex-1 h-2 rounded-full bg-slate-200 overflow-hidden">
                      <div
                        className="h-full bg-amber-400 rounded-full transition-all duration-300"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="w-12 text-right text-slate-500 font-mono text-[11px]">{count} ({pct}%)</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* จุดเด่นที่ประทับใจ */}
          {csatStats.topTags.length > 0 && (
            <div>
              <div className="text-xs font-semibold text-slate-700 mb-2">🏷️ จุดเด่นที่ผู้ยืมประทับใจสูงสุด</div>
              <div className="flex flex-wrap gap-1.5">
                {csatStats.topTags.map((t, idx) => (
                  <span key={idx} className="bg-emerald-50 text-emerald-800 border border-emerald-200 text-xs px-2.5 py-1 rounded-lg font-medium flex items-center gap-1">
                    <span>✓</span> {t.tag} <span className="text-emerald-600 font-bold font-mono">({t.count})</span>
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* ข้อเสนอแนะล่าสุด */}
          {csatStats.recentComments.length > 0 && (
            <div>
              <div className="text-xs font-semibold text-slate-700 mb-2">💬 ข้อเสนอแนะล่าสุดจากผู้ยืม</div>
              <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                {csatStats.recentComments.map((c, idx) => (
                  <div key={idx} className="p-2.5 rounded-lg bg-slate-50 border border-slate-100 text-xs space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-slate-800">{c.borrowerName} ({c.requestId})</span>
                      <span className="text-amber-500 font-bold">★ {c.rating}/5</span>
                    </div>
                    <p className="text-slate-600 italic">"{c.comment}"</p>
                    <div className="text-[10px] text-slate-400">{c.date}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* การ์ดส่งแบบประเมินย้อนหลัง (Retroactive Survey Invites) */}
        <div className="card space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-semibold text-slate-800 flex items-center gap-2">
                <span>✉️</span> ส่งแบบประเมินย้อนหลัง (Retroactive CSAT)
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                ส่งคำเชิญตอบแบบสอบถามไปยังผู้ยืมที่ส่งคืนของแล้วแต่ยังไม่ได้ประเมิน
              </p>
            </div>
            {csatStats.pendingSurveys.filter((r) => !r.surveyInviteSentAt && !r.surveyInviteQueuedAt && !sentMap[r.id]).length > 0 && (
              <button
                type="button"
                className="btn-primary text-xs"
                disabled={batchSending}
                onClick={handleSendBatchInvites}
              >
                {batchSending ? 'กำลังส่งแบบกลุ่ม...' : `✉️ ส่งทุกคนที่ยังไม่เคยส่ง (${csatStats.pendingSurveys.filter((r) => !r.surveyInviteSentAt && !r.surveyInviteQueuedAt && !sentMap[r.id]).length})`}
              </button>
            )}
          </div>

          {batchMessage && (
            <div className="p-2.5 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-800 font-medium">
              ✓ {batchMessage}
            </div>
          )}

          {csatStats.pendingSurveys.length === 0 ? (
            <div className="text-center py-10 text-xs text-slate-500 bg-slate-50 rounded-xl">
              🎉 ยอดเยี่ยม! คำขอที่ส่งคืนแล้วทั้งหมดได้รับการประเมินความพึงพอใจครบถ้วน
            </div>
          ) : (
            <div>
              {/* Mobile Card View */}
              <div className="space-y-3 sm:hidden">
                {csatStats.pendingSurveys.slice(0, 30).map((r) => {
                  const isSent = Boolean(sentMap[r.id] || r.surveyInviteStatus === 'SENT' || r.surveyInviteSentAt);
                  const isQueued = Boolean(!isSent && (r.surveyInviteStatus === 'QUEUED' || r.surveyInviteQueuedAt));
                  const isBusy = invitingId === r.id;
                  return (
                    <div key={r.id} className="p-3.5 rounded-xl border border-slate-200 bg-slate-50/60 space-y-2.5">
                      <div className="flex items-center justify-between">
                        <span className="font-mono font-bold text-xs text-brand-700">{r.id}</span>
                        <span className="text-[11px] text-slate-500">
                          คืน: {r.returnInfo?.actualReturnDate ? fmtDate(r.returnInfo.actualReturnDate) : '-'}
                        </span>
                      </div>
                      <div className="text-xs">
                        <div className="font-bold text-slate-900">{r.borrower.name}</div>
                        <div className="text-[11px] text-slate-500 truncate">{r.borrower.email}</div>
                      </div>
                      <div className="text-xs text-slate-700 font-medium">
                        อุปกรณ์: {r.equipment.name}
                      </div>
                      <div className="flex items-center justify-between pt-1 border-t border-slate-200/60">
                        <div>
                          {isSent ? (
                            <span className="inline-flex items-center text-[11px] text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200 font-semibold">
                              ✓ ส่งคำเชิญแล้ว
                            </span>
                          ) : isQueued ? (
                            <span className="inline-flex items-center text-[11px] text-amber-700 bg-amber-50 px-2 py-0.5 rounded-full border border-amber-200 font-semibold">
                              ⏱️ เข้าคิวส่งแล้ว
                            </span>
                          ) : (
                            <span className="inline-flex items-center text-[11px] text-slate-500 bg-slate-200/70 px-2 py-0.5 rounded-full">
                              ยังไม่เคยส่ง
                            </span>
                          )}
                        </div>
                        <button
                          type="button"
                          className="btn-outline text-xs min-h-[40px] px-3 py-1.5 flex items-center justify-center"
                          disabled={isBusy || batchSending || isQueued}
                          onClick={() => handleSendSingleInvite(r)}
                        >
                          {isBusy ? 'กำลังส่ง...' : isSent ? 'ส่งอีกครั้ง' : isQueued ? 'อยู่ในคิว' : '✉️ ส่งคำเชิญ'}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Desktop Table View */}
              <div className="hidden sm:block overflow-x-auto max-h-[380px] overflow-y-auto">
                <table className="min-w-full divide-y divide-slate-200 text-xs">
                  <thead className="bg-slate-50 sticky top-0">
                    <tr>
                      <th className="th">เลขที่คำขอ</th>
                      <th className="th">ผู้ยืม</th>
                      <th className="th">ครุภัณฑ์</th>
                      <th className="th">วันที่คืน</th>
                      <th className="th">สถานะคำเชิญ</th>
                      <th className="th text-right">ดำเนินการ</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {csatStats.pendingSurveys.slice(0, 30).map((r) => {
                      const isSent = Boolean(sentMap[r.id] || r.surveyInviteStatus === 'SENT' || r.surveyInviteSentAt);
                      const isQueued = Boolean(!isSent && (r.surveyInviteStatus === 'QUEUED' || r.surveyInviteQueuedAt));
                      const isBusy = invitingId === r.id;
                      return (
                        <tr key={r.id} className="hover:bg-slate-50">
                          <td className="td font-mono font-medium text-brand-700">{r.id}</td>
                          <td className="td">
                            <div className="font-medium text-slate-800">{r.borrower.name}</div>
                            <div className="text-[11px] text-slate-400">{r.borrower.email}</div>
                          </td>
                          <td className="td text-slate-600">{r.equipment.name}</td>
                          <td className="td whitespace-nowrap text-slate-500">
                            {r.returnInfo?.actualReturnDate ? fmtDate(r.returnInfo.actualReturnDate) : '-'}
                          </td>
                          <td className="td whitespace-nowrap">
                            {isSent ? (
                              <span className="inline-flex items-center text-[11px] text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200">
                                ✓ ส่งคำเชิญแล้ว
                              </span>
                            ) : isQueued ? (
                              <span className="inline-flex items-center text-[11px] text-amber-700 bg-amber-50 px-2 py-0.5 rounded-full border border-amber-200">
                                ⏱️ เข้าคิวส่งแล้ว
                              </span>
                            ) : (
                              <span className="inline-flex items-center text-[11px] text-slate-500 bg-slate-100 px-2 py-0.5 rounded-full">
                                ยังไม่เคยส่ง
                              </span>
                            )}
                          </td>
                          <td className="td text-right whitespace-nowrap">
                            <button
                              type="button"
                              className="btn-outline text-[11px] py-1 px-2.5"
                              disabled={isBusy || batchSending || isQueued}
                              onClick={() => handleSendSingleInvite(r)}
                            >
                              {isBusy ? 'กำลังส่ง...' : isSent ? 'ส่งอีกครั้ง' : isQueued ? 'อยู่ในคิว' : '✉️ ส่งคำเชิญ'}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {csatStats.pendingSurveys.length > 30 && (
                <div className="p-2 text-center text-[11px] text-slate-400">
                  แสดง 30 รายการแรกจากที่รอประเมินทั้งหมด {csatStats.pendingSurveys.length} รายการ
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* แดชบอร์ดติดตามความคิดเห็นคะแนนต่ำ (Low Rating Follow-Up Dashboard) */}
      <div className="card space-y-4 border-amber-300/80 bg-gradient-to-b from-amber-50/30 to-white shadow-xs">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-amber-200/60 pb-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xl">🛠️</span>
              <h3 className="font-bold text-slate-900 text-sm sm:text-base">
                ติดตามความคิดเห็นคะแนนต่ำและข้อเสนอแนะที่ต้องปรับปรุง (คะแนน ≤ 3 ดาว)
              </h3>
            </div>
            <p className="text-xs text-slate-500 mt-0.5">
              ระบบบันทึกและติดตามผลการประสานงานเพื่อปรับปรุงคุณภาพบริการตามข้อเสนอแนะของผู้รับบริการ
            </p>
          </div>

          {/* Status Filters */}
          <div className="flex flex-wrap gap-1 text-xs">
            {(['ALL', 'PENDING_REVIEW', 'IN_PROGRESS', 'RESOLVED'] as const).map((st) => {
              const count =
                st === 'ALL'
                  ? csatStats.lowRatingSurveys.length
                  : csatStats.lowRatingSurveys.filter(
                      (r) => (r.survey?.followUpStatus || 'PENDING_REVIEW') === st
                    ).length;
              const label =
                st === 'ALL'
                  ? 'ทั้งหมด'
                  : st === 'PENDING_REVIEW'
                  ? 'รอตรวจสอบ'
                  : st === 'IN_PROGRESS'
                  ? 'กำลังประสานงาน'
                  : 'แก้ไขแล้ว';
              return (
                <button
                  key={st}
                  type="button"
                  onClick={() => setFollowUpFilter(st)}
                  className={`px-2.5 py-1 rounded-lg font-medium transition ${
                    followUpFilter === st
                      ? 'bg-amber-900 text-white font-bold shadow-xs'
                      : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  {label} ({count})
                </button>
              );
            })}
          </div>
        </div>

        {/* List / Table of Low Rating Surveys */}
        {csatStats.lowRatingSurveys.length === 0 ? (
          <div className="py-8 text-center text-xs text-emerald-800 bg-emerald-50/50 rounded-xl border border-emerald-200">
            ✓ ยอดเยี่ยม! ไม่พบความคิดเห็นที่ได้คะแนนต่ำกว่าเกณฑ์ (≤ 3 ดาว) ในช่วงเวลานี้
          </div>
        ) : (
          (() => {
            const filtered = csatStats.lowRatingSurveys.filter((r) => {
              if (followUpFilter === 'ALL') return true;
              const st = r.survey?.followUpStatus || 'PENDING_REVIEW';
              return st === followUpFilter;
            });

            if (filtered.length === 0) {
              return (
                <div className="py-6 text-center text-xs text-slate-500 bg-slate-50 rounded-xl">
                  ไม่มีรายการในสถานะที่เลือก
                </div>
              );
            }

            return (
              <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
                <table className="min-w-full divide-y divide-slate-100 text-xs">
                  <thead className="bg-slate-50 text-slate-700">
                    <tr>
                      <th className="th py-2.5">เลขที่คำขอ</th>
                      <th className="th py-2.5">ผู้ยืม & สังกัด</th>
                      <th className="th py-2.5">คะแนน & วันที่</th>
                      <th className="th py-2.5">ข้อเสนอแนะของผู้ยืม</th>
                      <th className="th py-2.5">สถานะการติดตาม</th>
                      <th className="th py-2.5">บันทึกของเจ้าหน้าที่</th>
                      <th className="th py-2.5 text-right">ดำเนินการ</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {filtered.map((r) => {
                      const s = r.survey;
                      const st: SurveyFollowUpStatus = s?.followUpStatus || 'PENDING_REVIEW';
                      const meta = FOLLOW_UP_STATUS_META[st];
                      return (
                        <tr key={r.id} className="hover:bg-slate-50/60">
                          <td className="td font-mono font-bold text-brand-700 whitespace-nowrap">
                            <a
                              href={`/request/?id=${r.id}#survey`}
                              className="hover:underline"
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              {r.id}
                            </a>
                          </td>
                          <td className="td">
                            <div className="font-bold text-slate-900">{r.borrower.name}</div>
                            <div className="text-[11px] text-slate-500">{r.borrower.mission}</div>
                          </td>
                          <td className="td whitespace-nowrap">
                            <div className="font-bold text-amber-600">★ {s?.rating}/5</div>
                            <div className="text-[10px] text-slate-400">
                              {s?.submittedAt ? fmtTs(s.submittedAt) : '-'}
                            </div>
                          </td>
                          <td className="td max-w-xs">
                            <p className="text-slate-800 italic line-clamp-2">
                              {s?.comment ? `"${s.comment}"` : '-'}
                            </p>
                            {s?.tags && s.tags.length > 0 && (
                              <div className="flex flex-wrap gap-1 mt-1">
                                {s.tags.map((t, idx) => (
                                  <span
                                    key={idx}
                                    className="text-[10px] bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded"
                                  >
                                    {t}
                                  </span>
                                ))}
                              </div>
                            )}
                          </td>
                          <td className="td whitespace-nowrap">
                            <span
                              className={`inline-flex items-center text-[11px] font-bold px-2 py-0.5 rounded-full border ${meta.badgeClass}`}
                            >
                              {meta.label}
                            </span>
                          </td>
                          <td className="td max-w-xs">
                            {s?.followUpNotes ? (
                              <div>
                                <div className="text-slate-700 line-clamp-2 font-medium">
                                  {s.followUpNotes}
                                </div>
                                <div className="text-[10px] text-slate-400 mt-0.5">
                                  โดย {s.followUpByName || s.followUpBy}
                                </div>
                              </div>
                            ) : (
                              <span className="text-slate-400 italic">ยังไม่มีบันทึก</span>
                            )}
                          </td>
                          <td className="td text-right whitespace-nowrap">
                            <button
                              type="button"
                              onClick={() => setEditingFollowUpRequest(r)}
                              className="btn-outline text-xs px-2.5 py-1 hover:border-amber-400"
                            >
                              ✏️ บันทึกติดตาม
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            );
          })()
        )}
      </div>
      </div>
      )}

      {/* ========================================================= */}
      {/* 3. ตารางรายการคำขอล่าสุดในช่วงเวลา (Overview Tab Content) */}
      {/* ========================================================= */}
      {activeTab === 'overview' && (
      <div className="card">
        <h3 className="mb-3 font-semibold text-slate-800">
          📋 รายละเอียดคำขอยืม-คืนในช่วงเวลา ({filteredRequests.length} รายการ)
        </h3>

        {/* Mobile Card View */}
        <div className="space-y-3 sm:hidden">
          {filteredRequests.slice(0, 50).map((r) => (
            <div key={r.id} className="p-3.5 rounded-xl border border-slate-200 bg-slate-50/60 space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-mono font-bold text-xs text-brand-700">{r.id}</span>
                <div className="flex items-center gap-1">
                  <span
                    className={`inline-block rounded px-2 py-0.5 text-[11px] font-medium ${
                      STATUS_META[r.status]?.cls || 'bg-slate-100'
                    }`}
                  >
                    {STATUS_META[r.status]?.label || r.status}
                  </span>
                  <ExtensionBadge status={r.extension?.status} />
                  <ExceptionBadge isException={r.isException} />
                </div>
              </div>

              <div>
                <div className="text-xs font-bold text-slate-900">{r.borrower.name}</div>
                <div className="text-[11px] text-slate-500">{r.borrower.mission}</div>
              </div>

              <div className="text-xs text-slate-700 font-medium">
                ครุภัณฑ์: {r.equipment.name}
              </div>

              <div className="pt-1.5 border-t border-slate-200/60 flex flex-wrap items-center justify-between gap-1 text-[11px] text-slate-500">
                <div>
                  ยืม: {fmtDate(r.startDate)} - {fmtDate(r.expectedReturnDate)}
                </div>
                {r.returnInfo?.actualReturnDate && (
                  <div className="text-emerald-700 font-medium">
                    คืนจริง: {fmtDate(r.returnInfo.actualReturnDate)}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Desktop Table View */}
        <div className="hidden sm:block overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-xs">
            <thead className="bg-slate-50">
              <tr>
                <th className="th">เลขที่คำขอ</th>
                <th className="th">ผู้ยืม</th>
                <th className="th">สังกัด/ภารกิจ</th>
                <th className="th">ครุภัณฑ์</th>
                <th className="th">วันที่ยืม - คืน</th>
                <th className="th">สถานะ</th>
                <th className="th">วันที่คืนจริง</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredRequests.slice(0, 50).map((r) => (
                <tr key={r.id} className="hover:bg-slate-50">
                  <td className="td font-mono font-medium text-brand-700">{r.id}</td>
                  <td className="td">{r.borrower.name}</td>
                  <td className="td text-slate-500">{r.borrower.mission}</td>
                  <td className="td">{r.equipment.name}</td>
                  <td className="td whitespace-nowrap">
                    <div>{fmtDate(r.startDate)} - {fmtDate(r.expectedReturnDate)}</div>
                    {r.originalExpectedReturnDate && r.originalExpectedReturnDate !== r.expectedReturnDate && (
                      <div className="text-[10px] text-slate-400">
                        (เดิม {fmtDate(r.originalExpectedReturnDate)})
                      </div>
                    )}
                  </td>
                  <td className="td">
                    <div className="flex flex-col gap-1 items-start">
                      <span
                        className={`inline-block rounded px-2 py-0.5 font-medium ${
                          STATUS_META[r.status]?.cls || 'bg-slate-100'
                        }`}
                      >
                        {STATUS_META[r.status]?.label || r.status}
                      </span>
                      <ExtensionBadge status={r.extension?.status} />
                      <ExceptionBadge isException={r.isException} />
                    </div>
                  </td>
                  <td className="td text-slate-500">
                    {r.returnInfo?.actualReturnDate
                      ? fmtDate(r.returnInfo.actualReturnDate)
                      : '-'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {filteredRequests.length > 50 && (
            <div className="p-3 text-center text-xs text-slate-400">
              แสดง 50 รายการแรกจากทั้งหมด {filteredRequests.length} รายการ (ส่งออก CSV เพื่อดูข้อมูลทั้งหมด)
            </div>
          )}
        </div>
      </div>
      )}

      {/* Modal บันทึกผลการติดตามความคิดเห็นคะแนนต่ำ */}
      {editingFollowUpRequest && profile && (
        <FollowUpEditModal
          request={editingFollowUpRequest}
          me={profile}
          onClose={() => setEditingFollowUpRequest(null)}
        />
      )}

      {/* Modal: แบบฟอร์มแจ้งซ่อมแซมอุปกรณ์ */}
      <RepairFormModal
        open={repairModalOpen}
        onClose={() => setRepairModalOpen(false)}
        currentUser={profile}
        initialEquipments={repairModalEquipments}
      />
    </div>
  );
}

function FollowUpEditModal({
  request,
  me,
  onClose,
}: {
  request: BorrowRequest;
  me: AppUser;
  onClose: () => void;
}) {
  const s = request.survey;
  const [status, setStatus] = useState<SurveyFollowUpStatus>(
    s?.followUpStatus && s.followUpStatus !== 'NO_ACTION_NEEDED'
      ? s.followUpStatus
      : 'PENDING_REVIEW'
  );
  const [notes, setNotes] = useState(s?.followUpNotes || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await updateSurveyFollowUp(request.id, { status, notes }, me);
      onClose();
    } catch (e: any) {
      setError(e.message || 'เกิดข้อผิดพลาดในการบันทึก');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={true} title={`บันทึกการติดตาม CSAT — คำขอ ${request.id}`} onClose={onClose}>
      <div className="space-y-4 text-xs">
        {error && <Alert kind="error">{error}</Alert>}
        <div className="p-3 bg-slate-50 rounded-xl space-y-1.5 border border-slate-200">
          <div className="flex items-center justify-between">
            <span className="font-semibold text-slate-700">ผู้ยืม: {request.borrower.name}</span>
            <span className="font-bold text-amber-600">★ {s?.rating}/5 ดาว</span>
          </div>
          {s?.comment && (
            <div className="text-slate-600 italic">"{s.comment}"</div>
          )}
        </div>
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
            className="input min-h-[80px] text-xs"
            placeholder="ระบุรายละเอียดการติดต่อผู้ยืม การแก้ไข หรือแนวทางปรับปรุง..."
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
        <div className="flex justify-end gap-2 pt-2 border-t">
          <button type="button" className="btn-outline text-xs" onClick={onClose} disabled={saving}>
            ยกเลิก
          </button>
          <button type="button" className="btn-primary text-xs" onClick={handleSave} disabled={saving}>
            {saving ? 'กำลังบันทึก...' : 'บันทึกการติดตาม'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
