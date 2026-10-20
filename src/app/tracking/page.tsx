'use client';

import { useMemo, useState } from 'react';
import { Search, Activity, RotateCcw } from 'lucide-react';
import AppShell from '@/components/AppShell';
import { EmptyState, LoadingState, RequestTable } from '@/components/ui';
import { useAuth } from '@/lib/auth-context';
import { useAllRequests, useMyRequests } from '@/lib/hooks';
import type { RequestStatus } from '@/lib/types';
import { STATUS_META, sortByCreatedDesc } from '@/lib/utils';

export default function TrackingPage() {
  return (
    <AppShell title="ติดตามสถานะคำขอยืม-คืน">
      <Tracking />
    </AppShell>
  );
}

function Tracking() {
  const { profile, loading: authLoading } = useAuth();
  const isStaffOrAdmin =
    profile?.role === 'CUSTODIAN' || profile?.role === 'APPROVER' || profile?.role === 'EXECUTIVE';

  const { data: allData, loading: allLoading } = useAllRequests(isStaffOrAdmin);
  const { data: myData, loading: myLoading } = useMyRequests(isStaffOrAdmin ? undefined : profile?.email);

  const data = isStaffOrAdmin ? allData : myData;
  const loading = isStaffOrAdmin ? allLoading : myLoading;

  const [status, setStatus] = useState<RequestStatus | ''>('');
  const [q, setQ] = useState('');

  if (authLoading || !profile) {
    return <LoadingState text="กำลังโหลดข้อมูล..." />;
  }

  const me = profile;

  const counts = useMemo(() => {
    const c: Partial<Record<RequestStatus, number>> = {};
    data.forEach((r) => (c[r.status] = (c[r.status] ?? 0) + 1));
    return c;
  }, [data]);

  const list = useMemo(() => {
    return sortByCreatedDesc(data)
      .filter((r) => !status || r.status === status)
      .filter((r) => {
        const s = q.trim().toLowerCase();
        return (
          !s ||
          [r.id, r.borrower.name, r.equipment.name, r.equipment.assetNumber].some((x) =>
            x?.toLowerCase().includes(s)
          )
        );
      });
  }, [data, status, q]);

  return (
    <div className="space-y-6 pb-4 sm:pb-8">
      {/* Header Info Banner */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#123B68]/10 text-[#123B68]">
            <Activity className="h-5 w-5" />
          </div>
          <div>
            <h2 className="font-heading text-base font-bold text-slate-900">
              {isStaffOrAdmin
                ? 'ภาพรวมและติดตามสถานะคำขอทั้งหมดในระบบ'
                : 'ติดตามสถานะคำขอยืมของคุณ'}
            </h2>
            <p className="text-xs text-slate-500 font-medium">
              {isStaffOrAdmin
                ? 'เลือกกรองตามสถานะ หรือค้นหาเลขที่คำขอเพื่อติดตามขั้นตอนการดำเนินงาน'
                : 'ตรวจสอบว่าคำขอยืมของคุณอยู่ที่ขั้นตอนใด และดำเนินการเสร็จสิ้นหรือยัง'}
            </p>
          </div>
        </div>

        <div className="text-sm font-bold text-[#123B68] bg-[#123B68]/5 px-3 py-1.5 rounded-xl border border-[#123B68]/15 text-center">
          รวมทั้งหมด {data.length} รายการ
        </div>
      </div>

      {/* Filter & Search Bar */}
      <div className="card space-y-4">
        <div className="relative">
          <Search className="absolute left-4 top-3.5 h-5 w-5 text-slate-400" />
          <input
            className="input pl-12 pr-4 text-base"
            placeholder="ค้นหาตามเลขที่คำขอ (BR-...), ชื่อผู้ยืม, หรือชื่อครุภัณฑ์..."
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>

        {/* Status Pills */}
        <div className="flex items-center gap-2 overflow-x-auto pb-1 pt-1 no-scrollbar">
          <button
            type="button"
            className={`min-h-[44px] rounded-xl px-4 py-2 text-sm font-bold whitespace-nowrap transition ${
              !status
                ? 'bg-[#123B68] text-white shadow-xs'
                : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
            }`}
            onClick={() => setStatus('')}
          >
            ทั้งหมด ({data.length})
          </button>
          {(Object.keys(STATUS_META) as RequestStatus[]).map((s) => {
            const count = counts[s] ?? 0;
            if (count === 0 && status !== s) return null; // Hide empty pills for cleaner UI
            const active = status === s;
            return (
              <button
                key={s}
                type="button"
                onClick={() => setStatus(active ? '' : s)}
                className={`min-h-[44px] rounded-xl px-4 py-2 text-sm font-bold whitespace-nowrap transition ${
                  active
                    ? 'bg-[#123B68] text-white shadow-xs'
                    : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                }`}
              >
                {STATUS_META[s].label} ({count})
              </button>
            );
          })}
        </div>
      </div>

      {/* Results Table */}
      {loading ? (
        <LoadingState text="กำลังโหลดข้อมูลสถานะคำขอ..." />
      ) : !list.length ? (
        <EmptyState
          title="ไม่พบรายการคำขอตามเงื่อนไขที่เลือก"
          description="ลองตรวจสอบคำค้นหา หรือกดปุ่มล้างตัวกรองเพื่อดูรายการทั้งหมด"
          action={
            (status || q) ? (
              <button
                type="button"
                onClick={() => {
                  setStatus('');
                  setQ('');
                }}
                className="btn-primary"
              >
                <RotateCcw className="h-4 w-4" /> ล้างตัวกรองและคำค้นหา
              </button>
            ) : undefined
          }
        />
      ) : (
        <RequestTable requests={list} showBorrower={isStaffOrAdmin} />
      )}
    </div>
  );
}
