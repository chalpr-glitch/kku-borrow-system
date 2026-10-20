'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useMemo, useState, useEffect } from 'react';
import {
  Search,
  Package,
  Calendar,
  MapPin,
  Tag,
  ArrowRight,
  CheckCircle2,
  Clock,
  RotateCcw,
  X,
  Filter,
  SlidersHorizontal,
  RefreshCw,
  Wrench,
  AlertTriangle,
} from 'lucide-react';
import AppShell from '@/components/AppShell';
import { EmptyState, EquipmentBadge, ErrorState, LoadingState, SkeletonGrid } from '@/components/ui';
import { useAllRequests, useCategories, useEquipments } from '@/lib/hooks';
import { ACTIVE_STATUSES, DEFAULT_CATEGORIES, getActiveBorrowInfo, fmtDate, todayStr, isEquipmentAvailable } from '@/lib/utils';
import type { EquipmentStatus } from '@/lib/types';

export default function EquipmentBrowsePage() {
  return (
    <AppShell title="ค้นหาและเลือกอุปกรณ์ (Equipment Catalog)">
      <Suspense fallback={<LoadingState text="กำลังโหลดหน้ารายการครุภัณฑ์..." />}>
        <BrowseContent />
      </Suspense>
    </AppShell>
  );
}

function BrowseContent() {
  const searchParams = useSearchParams();
  const urlQuery = searchParams.get('q') || '';
  const urlItem = searchParams.get('item') || '';

  const { data: equipments, loading: eqLoading, error: eqError } = useEquipments();
  const { data: categories, loading: catLoading } = useCategories();
  const { data: requests } = useAllRequests();

  const [q, setQ] = useState(urlQuery);
  const [selectedCat, setSelectedCat] = useState('');
  const [selectedStatus, setSelectedStatus] = useState<string>('ALL');
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    if (urlQuery) setQ(urlQuery);
  }, [urlQuery]);

  // Timeout guard (10 seconds)
  useEffect(() => {
    if (eqLoading) {
      const timer = setTimeout(() => {
        if (eqLoading) setTimedOut(true);
      }, 10000);
      return () => clearTimeout(timer);
    } else {
      setTimedOut(false);
    }
  }, [eqLoading]);

  const mergedCategories = useMemo(() => {
    const list = [...categories];
    for (const def of DEFAULT_CATEGORIES) {
      if (!list.some((c) => c.id === def.id)) {
        list.push({ id: def.id, name: def.name, isActive: true });
      }
    }
    // กำหนดให้หมวดหมู่คอมพิวเตอร์และโน้ตบุ๊ก (CAT-COMPUTER) แสดงเป็นลำดับแรก
    list.sort((a, b) => {
      if (a.id === 'CAT-COMPUTER') return -1;
      if (b.id === 'CAT-COMPUTER') return 1;
      return a.name.localeCompare(b.name, 'th');
    });
    return list;
  }, [categories]);

  const catName = useMemo(
    () => Object.fromEntries(mergedCategories.map((c) => [c.id, c.name])),
    [mergedCategories]
  );
  const today = todayStr();

  const bookings = useMemo(() => {
    const m: Record<string, { start: string; end: string }[]> = {};
    for (const r of requests) {
      if (!ACTIVE_STATUSES.includes(r.status) || r.expectedReturnDate < today) continue;
      (m[r.equipment.equipmentId] ??= []).push({ start: r.startDate, end: r.expectedReturnDate });
    }
    Object.values(m).forEach((l) => l.sort((a, b) => a.start.localeCompare(b.start)));
    return m;
  }, [requests, today]);

  // Filtering & Sorting
  const list = useMemo(() => {
    if (eqLoading) return [];
    return equipments
      .filter((e) => !e.isDeleted && e.status !== 'RETIRED')
      .filter((e) => {
        // Direct ID search if URL has item param
        if (urlItem && e.id === urlItem) return true;
        // Category filter
        if (selectedCat && e.categoryId !== selectedCat) return false;
        // Status filter
        if (selectedStatus === 'AVAILABLE' && e.status !== 'AVAILABLE') return false;
        if (selectedStatus === 'IN_USE' && !['IN_USE', 'RESERVED'].includes(e.status)) return false;
        if (selectedStatus === 'MAINTENANCE' && e.status !== 'MAINTENANCE') return false;

        // Search text
        const s = q.trim().toLowerCase();
        if (!s) return true;
        return [e.name, e.assetNumber, e.brand, e.model, e.serialNumber, e.location].some((x) =>
          x?.toLowerCase().includes(s)
        );
      })
      .sort((a, b) => {
        // เอาคอมพิวเตอร์และโน้ตบุ๊กขึ้นก่อน
        if (a.categoryId === 'CAT-COMPUTER' && b.categoryId !== 'CAT-COMPUTER') return -1;
        if (a.categoryId !== 'CAT-COMPUTER' && b.categoryId === 'CAT-COMPUTER') return 1;
        // เอาของว่างขึ้นก่อน
        if (a.status === 'AVAILABLE' && b.status !== 'AVAILABLE') return -1;
        if (a.status !== 'AVAILABLE' && b.status === 'AVAILABLE') return 1;
        return a.name.localeCompare(b.name, 'th');
      });
  }, [equipments, eqLoading, q, selectedCat, selectedStatus, urlItem]);

  const resetFilters = () => {
    setQ('');
    setSelectedCat('');
    setSelectedStatus('ALL');
  };

  const isFiltered = !!q || !!selectedCat || selectedStatus !== 'ALL';
  const totalActiveEquipments = equipments.filter((e) => !e.isDeleted && e.status !== 'RETIRED').length;

  return (
    <div className="space-y-6 pb-4 sm:pb-8">
      {/* 1. Search Bar & Status Filters */}
      <div className="card space-y-4">
        <div className="flex flex-col md:flex-row gap-3">
          {/* Keyword Search Input */}
          <div className="relative flex-1">
            <Search
              className="absolute left-4 top-3.5 h-5 w-5 text-emerald-600"
              aria-hidden="true"
            />
            <input
              type="text"
              className="input pl-12 pr-10 text-base"
              placeholder="ค้นหาตามชื่ออุปกรณ์, เลขครุภัณฑ์, ยี่ห้อ, หรือสถานที่เก็บ..."
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setQ('');
              }}
              aria-label="ช่องค้นหาอุปกรณ์"
            />
            {q && (
              <button
                type="button"
                onClick={() => setQ('')}
                className="absolute right-3.5 top-3 text-slate-400 hover:text-slate-600 p-1"
                aria-label="ล้างคำค้นหา"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>

          {/* Status Filter Dropdown */}
          <div className="w-full md:w-56">
            <select
              className="input text-base font-semibold text-slate-800 min-h-[44px]"
              value={selectedStatus}
              onChange={(e) => setSelectedStatus(e.target.value)}
              aria-label="กรองตามสถานะ"
            >
              <option value="ALL">สถานะทั้งหมด</option>
              <option value="AVAILABLE">✓ พร้อมให้ยืม</option>
              <option value="IN_USE">🔄 ถูกยืมอยู่</option>
              <option value="MAINTENANCE">🔧 รอซ่อมบำรุง / ไม่พร้อมใช้</option>
            </select>
          </div>
        </div>

        {/* Category Pills Filter */}
        <div className="flex items-center gap-2 overflow-x-auto pb-1 pt-1 no-scrollbar" role="tablist">
          <button
            type="button"
            onClick={() => setSelectedCat('')}
            className={`min-h-[44px] rounded-xl px-4 py-2 text-xs font-semibold whitespace-nowrap transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900/30 ${
              !selectedCat
                ? 'bg-slate-900 text-white shadow-xs font-bold'
                : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
            }`}
          >
            ทั้งหมด ({eqLoading ? '...' : totalActiveEquipments})
          </button>
          {mergedCategories.map((c) => {
            const count = equipments.filter(
              (e) => !e.isDeleted && e.status !== 'RETIRED' && e.categoryId === c.id
            ).length;
            const active = selectedCat === c.id;
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => setSelectedCat(active ? '' : c.id)}
                className={`min-h-[44px] rounded-xl px-3.5 py-2 text-xs font-semibold whitespace-nowrap transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900/30 ${
                  active
                    ? 'bg-slate-900 text-white shadow-xs font-bold'
                    : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                }`}
              >
                {c.name} ({eqLoading ? '...' : count})
              </button>
            );
          })}
        </div>

        {/* Results Count & Reset Filter */}
        <div className="flex items-center justify-between border-t border-slate-100 pt-3 text-sm text-slate-600 font-medium">
          <div>
            {eqLoading ? (
              <span className="inline-flex items-center gap-2 text-slate-400 font-medium animate-pulse">
                <RefreshCw className="h-3.5 w-3.5 animate-spin text-emerald-600" /> กำลังตรวจสอบข้อมูลในระบบ...
              </span>
            ) : eqError || timedOut ? (
              <span className="text-rose-600 font-bold">เกิดข้อผิดพลาดในการโหลด</span>
            ) : (
              <>
                พบอุปกรณ์ <span className="font-heading font-bold text-slate-900">{list.length}</span> รายการ
                {selectedCat && (
                  <span className="ml-1 text-slate-500">ในหมวด &ldquo;{catName[selectedCat]}&rdquo;</span>
                )}
              </>
            )}
          </div>
          {isFiltered && !eqLoading && (
            <button
              type="button"
              onClick={resetFilters}
              className="inline-flex items-center gap-1 text-sm font-bold text-emerald-700 hover:underline"
            >
              <RotateCcw className="h-3.5 w-3.5" /> ล้างตัวกรองทั้งหมด
            </button>
          )}
        </div>
      </div>

      {/* 2. Equipment Grid Results with Explicit States */}
      {eqLoading && !timedOut ? (
        <div className="space-y-6">
          <LoadingState text="กำลังโหลดรายการครุภัณฑ์จากฐานข้อมูล..." />
          <SkeletonGrid count={6} />
        </div>
      ) : eqError || timedOut ? (
        <ErrorState
          title="ไม่สามารถโหลดข้อมูลครุภัณฑ์ได้"
          message={eqError || 'การเชื่อมต่อใช้เวลานานเกินกำหนด โปรดตรวจสอบการเชื่อมต่ออินเทอร์เน็ต'}
          onRetry={() => window.location.reload()}
        />
      ) : !list.length ? (
        <EmptyState
          title="ไม่พบอุปกรณ์ที่ตรงกับเงื่อนไขการค้นหา"
          description={
            isFiltered
              ? 'ลองปรับคำค้นหา หรือกดปุ่มด้านล่างเพื่อล้างตัวกรองทั้งหมด'
              : 'ยังไม่มีข้อมูลครุภัณฑ์ในระบบ หรือครุภัณฑ์ทั้งหมดถูกจำหน่ายแล้ว'
          }
          action={
            isFiltered ? (
              <button type="button" onClick={resetFilters} className="btn-primary">
                <RotateCcw className="h-4 w-4" /> ล้างคำค้นหาและตัวกรอง
              </button>
            ) : undefined
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
          {list.map((e) => {
            const isAvailable = e.status === 'AVAILABLE';
            const eqBookings = bookings[e.id] || [];

            return (
              <div
                key={e.id}
                className="card-hover flex flex-col justify-between overflow-hidden p-3 border border-slate-200/70 rounded-2xl bg-white shadow-xs"
              >
                <div>
                  {/* Equipment Photo */}
                  <div className="relative flex h-36 sm:h-44 w-full items-center justify-center bg-slate-100 rounded-xl overflow-hidden border border-slate-100">
                    {e.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={e.imageUrl}
                        alt={e.name}
                        className="h-full w-full object-cover transition-transform duration-300 hover:scale-105"
                      />
                    ) : (
                      <Package className="h-10 w-10 text-slate-300" aria-hidden="true" />
                    )}
                    <div className="absolute top-2 right-2">
                      <EquipmentBadge status={e.status} />
                    </div>
                  </div>

                  {/* Details */}
                  <div className="mt-2.5 space-y-1.5">
                    <div>
                      <h3 className="font-heading font-semibold text-slate-900 text-sm leading-snug line-clamp-2">
                        {e.name}
                      </h3>
                      <div className="font-mono text-[11px] text-slate-600 font-bold bg-slate-100 px-2 py-0.5 rounded-md inline-block mt-1">
                        {e.assetNumber}
                      </div>
                    </div>

                    <div className="text-xs text-slate-500 font-normal truncate">
                      {[e.brand, e.model, e.serialNumber && `S/N: ${e.serialNumber}`]
                        .filter(Boolean)
                        .join(' · ')}
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500 font-medium">
                      <span className="flex items-center gap-1">
                        <Tag className="h-3 w-3 text-slate-500" />
                        {catName[e.categoryId] ?? e.categoryId}
                      </span>
                      {e.location && (
                        <span className="flex items-center gap-1">
                          <MapPin className="h-3 w-3 text-slate-500" />
                          {e.location}
                        </span>
                      )}
                    </div>

                    {/* รายละเอียดช่วงเวลาการถูกยืม สำหรับอุปกรณ์ที่มีสถานะถูกยืม */}
                    {(() => {
                      const borrowInfo = getActiveBorrowInfo(e, requests, today);
                      if (!borrowInfo.isBorrowed) return null;
                      return (
                        <div className="rounded-xl bg-slate-50 border border-slate-200/90 p-2 space-y-1 text-xs text-slate-800">
                          <div className="flex items-center justify-between font-bold">
                            <span className="flex items-center gap-1 text-slate-700 text-[11px]">
                              <Clock className="h-3 w-3 text-slate-500" />
                              <span>ช่วงเวลายืม:</span>
                            </span>
                            {borrowInfo.isOverdue ? (
                              <span className="inline-flex items-center gap-1 text-[10px] font-bold text-rose-700 bg-rose-100 px-1.5 py-0.5 rounded-md">
                                เกิน {Math.abs(borrowInfo.daysRemaining ?? 0)} วัน
                              </span>
                            ) : borrowInfo.daysRemaining === 0 ? (
                              <span className="inline-flex items-center gap-1 text-[10px] font-bold text-amber-800 bg-amber-100 px-1.5 py-0.5 rounded-md">
                                คืนวันนี้
                              </span>
                            ) : borrowInfo.daysRemaining != null ? (
                              <span className="text-[10px] font-semibold text-slate-700 bg-slate-200/80 px-1.5 py-0.5 rounded-md">
                                เหลือ {borrowInfo.daysRemaining} วัน
                              </span>
                            ) : null}
                          </div>
                          <div className="font-semibold text-slate-900 text-xs">
                            {borrowInfo.startDate && borrowInfo.expectedReturnDate
                              ? `${fmtDate(borrowInfo.startDate)} – ${fmtDate(borrowInfo.expectedReturnDate)}`
                              : 'อยู่ระหว่างนำไปใช้งาน'}
                          </div>
                        </div>
                      );
                    })()}

                    {/* Booking Schedule Alert if already booked in future */}
                    {eqBookings.length > 0 && (
                      <div className="rounded-xl bg-amber-50 p-2 border border-amber-200/80 text-[11px] text-amber-900 space-y-0.5">
                        <div className="font-bold flex items-center gap-1">
                          <Calendar className="h-3 w-3 text-amber-700" /> จองล่วงหน้า:
                        </div>
                        {eqBookings.slice(0, 2).map((b, idx) => (
                          <div key={idx} className="font-medium text-amber-800 truncate">
                            • {fmtDate(b.start)} – {fmtDate(b.end)}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {/* Card Action (Button Height 48px / h-11 to h-12, Rounded-xl) */}
                <div className="mt-3 pt-2.5 border-t border-slate-100">
                  {isAvailable ? (
                    <Link
                      href={`/borrow/?eq=${e.id}`}
                      className="btn-primary min-h-[44px] sm:min-h-[48px] h-11 sm:h-12 w-full text-xs sm:text-sm font-semibold text-center shadow-xs flex items-center justify-center gap-1.5 rounded-xl"
                    >
                      <span>ยื่นคำขอยืม</span>
                      <ArrowRight className="h-4 w-4" />
                    </Link>
                  ) : e.status === 'MAINTENANCE' ? (
                    <button
                      type="button"
                      disabled
                      aria-disabled="true"
                      className="min-h-[44px] sm:min-h-[48px] h-11 sm:h-12 w-full text-xs sm:text-sm font-semibold text-center flex items-center justify-center gap-1.5 rounded-xl bg-amber-50 text-amber-900 border border-amber-200/80 cursor-not-allowed opacity-90"
                    >
                      <Wrench className="h-4 w-4 text-amber-700" />
                      <span>อยู่ระหว่างซ่อมบำรุง</span>
                    </button>
                  ) : e.status === 'BORROWED' ? (
                    <button
                      type="button"
                      disabled
                      aria-disabled="true"
                      className="min-h-[44px] sm:min-h-[48px] h-11 sm:h-12 w-full text-xs sm:text-sm font-semibold text-center flex items-center justify-center gap-1.5 rounded-xl bg-slate-100 text-slate-700 border border-slate-200 cursor-not-allowed opacity-90"
                    >
                      <Clock className="h-4 w-4 text-slate-500" />
                      <span>ถูกยืมใช้งานอยู่</span>
                    </button>
                  ) : e.status === 'LOST' ? (
                    <button
                      type="button"
                      disabled
                      aria-disabled="true"
                      className="min-h-[44px] sm:min-h-[48px] h-11 sm:h-12 w-full text-xs sm:text-sm font-semibold text-center flex items-center justify-center gap-1.5 rounded-xl bg-slate-100 text-slate-500 border border-slate-200 cursor-not-allowed opacity-80"
                    >
                      <AlertTriangle className="h-4 w-4 text-slate-400" />
                      <span>สูญหาย (งดให้บริการ)</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled
                      aria-disabled="true"
                      className="min-h-[44px] sm:min-h-[48px] h-11 sm:h-12 w-full text-xs sm:text-sm font-semibold text-center flex items-center justify-center gap-1.5 rounded-xl bg-slate-100 text-slate-400 border border-slate-200 cursor-not-allowed opacity-70"
                    >
                      <span>จำหน่ายแล้ว</span>
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
