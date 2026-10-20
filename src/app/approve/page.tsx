'use client';

import { useState } from 'react';
import { CheckCircle2, ShieldCheck, RefreshCw } from 'lucide-react';
import AppShell from '@/components/AppShell';
import { EmptyState, LoadingState, RequestTable, TableSkeleton } from '@/components/ui';
import { useRequestsByStatus } from '@/lib/hooks';
import { sortByCreatedDesc } from '@/lib/utils';

export default function ApproveQueuePage() {
  return (
    <AppShell title="อนุมัติคำขอ (ขั้นที่ 2 - ผู้อนุมัติ)" roles={['APPROVER', 'EXECUTIVE']}>
      <Queue />
    </AppShell>
  );
}

function Queue() {
  const [tab, setTab] = useState<'new' | 'extension'>('new');
  const { data, loading } = useRequestsByStatus(['PENDING_APPROVAL', 'IN_USE', 'OVERDUE']);

  const newRequests = sortByCreatedDesc(data.filter((r) => r.status === 'PENDING_APPROVAL')).reverse();
  const extensionRequests = sortByCreatedDesc(
    data.filter(
      (r) => (r.status === 'IN_USE' || r.status === 'OVERDUE') && r.extension?.status === 'PENDING_APPROVAL'
    )
  );

  return (
    <div className="space-y-6 pb-4 sm:pb-8">
      {/* Information Banner */}
      <div className="rounded-2xl border border-sky-200 bg-sky-50/80 p-5 shadow-2xs text-slate-800">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-sky-200 text-sky-900 flex-shrink-0">
            <CheckCircle2 className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="space-y-1">
            <h2 className="font-heading text-base font-bold text-sky-950">
              หน้าที่ของผู้อนุมัติ (ขั้นที่ 2):
            </h2>
            <p className="text-sm text-sky-900 leading-relaxed">
              คำขอในรายการนี้ผ่านการตรวจสอบความพร้อมของอุปกรณ์จาก <b>ผู้ดูแลพัสดุ (ขั้นที่ 1)</b> เรียบร้อยแล้ว เมื่อท่านอนุมัติ ระบบจะส่งอีเมลแจ้งผู้ยื่นคำขอเพื่อดำเนินการต่อไป
            </p>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-slate-200 gap-2 overflow-x-auto max-w-full scrollbar-none pb-0">
        <button
          type="button"
          onClick={() => setTab('new')}
          className={`min-h-[44px] flex items-center gap-2 px-4 py-2.5 font-heading text-sm font-bold border-b-2 whitespace-nowrap flex-shrink-0 transition -mb-px ${
            tab === 'new'
              ? 'border-emerald-600 text-emerald-800 bg-emerald-50/50 rounded-t-xl'
              : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          <CheckCircle2 className="h-4 w-4" />
          <span>คำขอยืมรออนุมัติ</span>
          {newRequests.length > 0 && (
            <span className="inline-flex items-center justify-center rounded-full bg-emerald-600 px-2 py-0.5 text-xs font-bold text-white shadow-2xs">
              {newRequests.length}
            </span>
          )}
        </button>

        <button
          type="button"
          onClick={() => setTab('extension')}
          className={`min-h-[44px] flex items-center gap-2 px-4 py-2.5 font-heading text-sm font-bold border-b-2 whitespace-nowrap flex-shrink-0 transition -mb-px ${
            tab === 'extension'
              ? 'border-sky-600 text-sky-900 bg-sky-50/50 rounded-t-xl'
              : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          <RefreshCw className="h-4 w-4" />
          <span>คำขอต่ออายุ (ขอยืมต่อ)</span>
          {extensionRequests.length > 0 && (
            <span className="inline-flex items-center justify-center rounded-full bg-sky-600 px-2 py-0.5 text-xs font-bold text-white shadow-2xs">
              {extensionRequests.length}
            </span>
          )}
        </button>
      </div>

      {loading ? (
        <div className="space-y-4">
          <LoadingState text="กำลังโหลดรายการคำขอที่รออนุมัติ..." />
          <TableSkeleton rows={4} />
        </div>
      ) : tab === 'new' ? (
        !newRequests.length ? (
          <EmptyState
            title="ไม่มีคำขอยืมที่รอการอนุมัติในขณะนี้ 🎉"
            description="เมื่อคำขอผ่านการตรวจสอบจากผู้ดูแลพัสดุ จะแสดงที่นี่เพื่อให้ท่านพิจารณาอนุมัติ"
            icon={CheckCircle2}
          />
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between text-sm font-semibold text-slate-700">
              <span>คำขอยืมรออนุมัติ: {newRequests.length} รายการ</span>
            </div>
            <RequestTable requests={newRequests} showBorrower={true} />
          </div>
        )
      ) : (
        !extensionRequests.length ? (
          <EmptyState
            title="ไม่มีคำขอต่ออายุที่รอการอนุมัติในขณะนี้ 🎉"
            description="เมื่อคำขอต่ออายุผ่านการตรวจสอบจากผู้ดูแลพัสดุ จะแสดงที่นี่เพื่อให้ท่านพิจารณาอนุมัติ"
            icon={CheckCircle2}
          />
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between text-sm font-semibold text-slate-700">
              <span>คำขอต่ออายุรออนุมัติ: {extensionRequests.length} รายการ</span>
            </div>
            <RequestTable requests={extensionRequests} showBorrower={true} />
          </div>
        )
      )}
    </div>
  );
}
