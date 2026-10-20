'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Search, CheckCircle2, Clock, RefreshCw } from 'lucide-react';
import AppShell from '@/components/AppShell';
import { Alert, EmptyState, LoadingState, RequestTable, TableSkeleton } from '@/components/ui';
import { useRequestsByStatus } from '@/lib/hooks';
import { sortByCreatedDesc } from '@/lib/utils';

export default function ReviewQueuePage() {
  return (
    <AppShell title="ตรวจสอบคำขอ (ขั้นที่ 1 - ผู้ดูแลพัสดุ)" roles={['CUSTODIAN', 'EXECUTIVE']}>
      <Queue />
    </AppShell>
  );
}

function Queue() {
  const [tab, setTab] = useState<'new' | 'extension'>('new');
  const { data, loading } = useRequestsByStatus(['PENDING_REVIEW', 'IN_USE', 'OVERDUE']);

  const newRequests = sortByCreatedDesc(data.filter((r) => r.status === 'PENDING_REVIEW')).reverse();
  const extensionRequests = sortByCreatedDesc(
    data.filter(
      (r) => (r.status === 'IN_USE' || r.status === 'OVERDUE') && r.extension?.status === 'PENDING_REVIEW'
    )
  );

  return (
    <div className="space-y-6 pb-4 sm:pb-8">
      {/* Information Banner */}
      <div className="rounded-2xl border border-sky-200 bg-sky-50/80 p-5 shadow-2xs text-slate-800">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-sky-200 text-sky-900 flex-shrink-0">
            <Search className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="space-y-1">
            <h2 className="font-heading text-base font-bold text-sky-950">
              หน้าที่ของผู้ดูแลพัสดุ (ขั้นที่ 1):
            </h2>
            <p className="text-sm text-sky-900 leading-relaxed">
              ตรวจสอบความพร้อมของอุปกรณ์ ตารางการใช้งาน และอุปกรณ์เสริม ทั้งคำขอยืมใหม่และคำขอต่ออายุการใช้งาน หากตรวจสอบผ่าน ระบบจะส่งต่อคำขอไปยัง <b>ผู้อนุมัติ (ขั้นที่ 2)</b> พร้อมแจ้งเตือนทางอีเมลอัตโนมัติ
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
          <Search className="h-4 w-4" />
          <span>คำขอยืมใหม่</span>
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
              ? 'border-amber-600 text-amber-900 bg-amber-50/50 rounded-t-xl'
              : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          <RefreshCw className="h-4 w-4" />
          <span>คำขอต่ออายุ (ขอยืมต่อ)</span>
          {extensionRequests.length > 0 && (
            <span className="inline-flex items-center justify-center rounded-full bg-amber-500 px-2 py-0.5 text-xs font-bold text-white shadow-2xs">
              {extensionRequests.length}
            </span>
          )}
        </button>
      </div>

      {loading ? (
        <div className="space-y-4">
          <LoadingState text="กำลังโหลดรายการคำขอที่รอตรวจสอบ..." />
          <TableSkeleton rows={4} />
        </div>
      ) : tab === 'new' ? (
        !newRequests.length ? (
          <EmptyState
            title="ไม่มีคำขอยืมใหม่ที่รอการตรวจสอบในขณะนี้ 🎉"
            description="เมื่อมีบุคลากรยื่นคำขอยืมครุภัณฑ์ รายการจะปรากฏที่นี่เพื่อให้ท่านตรวจสอบความพร้อมของอุปกรณ์"
            icon={CheckCircle2}
          />
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between text-sm font-semibold text-slate-700">
              <span>คำขอยืมใหม่รอตรวจสอบ: {newRequests.length} รายการ</span>
            </div>
            <RequestTable requests={newRequests} showBorrower={true} />
          </div>
        )
      ) : (
        !extensionRequests.length ? (
          <EmptyState
            title="ไม่มีคำขอต่ออายุที่รอการตรวจสอบในขณะนี้ 🎉"
            description="เมื่อผู้ยืมที่กำลังใช้งานอุปกรณ์ยื่นขอต่ออายุ รายการจะปรากฏที่นี่เพื่อให้ท่านตรวจสอบตารางการจอง"
            icon={CheckCircle2}
          />
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between text-sm font-semibold text-slate-700">
              <span>คำขอต่ออายุรอตรวจสอบ: {extensionRequests.length} รายการ</span>
            </div>
            <RequestTable requests={extensionRequests} showBorrower={true} />
          </div>
        )
      )}
    </div>
  );
}
