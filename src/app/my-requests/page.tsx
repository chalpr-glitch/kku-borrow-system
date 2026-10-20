'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Package, ClipboardList, History, Plus } from 'lucide-react';
import AppShell from '@/components/AppShell';
import { EmptyState, LoadingState, RequestTable } from '@/components/ui';
import { useAuth } from '@/lib/auth-context';
import { useMyRequests } from '@/lib/hooks';
import { ACTIVE_STATUSES, sortByCreatedDesc } from '@/lib/utils';

export default function MyRequestsPage() {
  return (
    <AppShell title="คำขอของฉัน (My Requests)">
      <Suspense fallback={<LoadingState text="กำลังโหลดรายการคำขอ..." />}>
        <MyRequestsContent />
      </Suspense>
    </AppShell>
  );
}

function MyRequestsContent() {
  const searchParams = useSearchParams();
  const urlTab = searchParams.get('tab');
  const { profile, loading: authLoading } = useAuth();
  const { data, loading } = useMyRequests(profile?.email);

  const [tab, setTab] = useState<'active' | 'history'>(
    urlTab === 'history' ? 'history' : 'active'
  );

  useEffect(() => {
    if (urlTab === 'history') setTab('history');
    else if (urlTab === 'active') setTab('active');
  }, [urlTab]);

  if (authLoading || !profile) {
    return <LoadingState text="กำลังโหลดรายการคำขอ..." />;
  }

  const sorted = sortByCreatedDesc(data);
  const active = sorted.filter((r) => ACTIVE_STATUSES.includes(r.status));
  const history = sorted.filter((r) => !ACTIVE_STATUSES.includes(r.status));
  const pendingSurveys = history.filter(
    (r) => ['RETURNED', 'RETURNED_DAMAGED', 'LOST'].includes(r.status) && !r.survey
  );

  return (
    <div className="space-y-6 pb-4 sm:pb-8">
      {/* Header & Tabs */}
      <div className="flex flex-col-reverse sm:flex-row sm:items-center justify-between gap-3 sm:gap-4">
        <div className="overflow-x-auto max-w-full scrollbar-none pb-1">
          <div className="flex items-center gap-2 p-1 bg-slate-200/80 rounded-2xl w-max" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'active'}
              className={`min-h-[44px] rounded-xl px-5 py-2 text-base font-bold whitespace-nowrap flex-shrink-0 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#123B68] ${
                tab === 'active'
                  ? 'bg-white text-[#123B68] shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
              onClick={() => setTab('active')}
            >
              <span className="flex items-center gap-2">
                <ClipboardList className="h-4 w-4" aria-hidden="true" />
                <span>กำลังดำเนินการ ({active.length})</span>
              </span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'history'}
              className={`min-h-[44px] rounded-xl px-5 py-2 text-base font-bold whitespace-nowrap flex-shrink-0 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#123B68] ${
                tab === 'history'
                  ? 'bg-white text-[#123B68] shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
              onClick={() => setTab('history')}
            >
              <span className="flex items-center gap-2">
                <History className="h-4 w-4" aria-hidden="true" />
                <span>ประวัติการยืม-คืน ({history.length})</span>
                {pendingSurveys.length > 0 && (
                  <span className="ml-1 rounded-full bg-rose-500 text-white text-[11px] px-2 py-0.5 font-bold shadow-2xs">
                    รอประเมิน {pendingSurveys.length}
                  </span>
                )}
              </span>
            </button>
          </div>
        </div>

        <Link
          href="/equipment/"
          className="btn-cta text-sm min-h-[44px] px-5 py-2.5 w-full sm:w-auto text-center flex items-center justify-center gap-1.5 shadow-xs"
        >
          <Plus className="h-4 w-4" /> ยื่นคำขอยืมใหม่
        </Link>
      </div>

      {/* Banner เตือนแบบประเมินความพึงพอใจสำหรับคำขอที่ส่งคืนแล้ว */}
      {tab === 'history' && pendingSurveys.length > 0 && (
        <div className="rounded-2xl border border-amber-300 bg-gradient-to-r from-amber-50 to-orange-50/50 p-4 shadow-xs flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-start gap-3">
            <span className="text-2xl">🌟</span>
            <div>
              <div className="text-sm font-bold text-amber-950">
                ท่านมี {pendingSurveys.length} รายการที่ส่งคืนแล้วและยังไม่ได้ทำแบบประเมินความพึงพอใจ
              </div>
              <p className="text-xs text-amber-800 mt-0.5">
                ความคิดเห็นและข้อเสนอแนะของท่านมีคุณค่าอย่างยิ่งในการพัฒนาคุณภาพการให้บริการยืม-คืนครุภัณฑ์
              </p>
            </div>
          </div>
          {pendingSurveys[0] && (
            <Link
              href={`/request/?id=${pendingSurveys[0].id}&survey=1#survey`}
              className="btn-primary text-xs min-h-[40px] px-4 py-2 shrink-0 font-bold shadow-xs text-center"
            >
              ⭐ ประเมินรายการล่าสุด ({pendingSurveys[0].id})
            </Link>
          )}
        </div>
      )}

      {/* Table / Empty State */}
      {loading ? (
        <LoadingState text="กำลังโหลดรายการคำขอ..." />
      ) : tab === 'active' ? (
        active.length > 0 ? (
          <RequestTable requests={active} showBorrower={false} />
        ) : (
          <EmptyState
            title="ไม่มีรายการคำขอที่อยู่ระหว่างดำเนินการ"
            description="คุณไม่มีคำขอยืมที่รอการตรวจสอบ หรืออุปกรณ์ที่กำลังถือครองอยู่ในขณะนี้"
            action={
              <Link href="/equipment/" className="btn-cta">
                <Package className="h-4 w-4" /> เลือกครุภัณฑ์เพื่อขอยืม
              </Link>
            }
          />
        )
      ) : history.length > 0 ? (
        <RequestTable requests={history} showBorrower={false} />
      ) : (
        <EmptyState
          title="ยังไม่มีประวัติการยืม-คืนที่เสร็จสิ้น"
          description="เมื่อรายการยืมของคุณได้รับการส่งคืน หรือเสร็จสิ้นกระบวนการ จะแสดงประวัติที่นี่"
        />
      )}
    </div>
  );
}
