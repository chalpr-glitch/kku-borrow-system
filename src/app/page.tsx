'use client';

import Link from 'next/link';
import Image from 'next/image';
import { useMemo, useState } from 'react';
import {
  Package,
  RotateCcw,
  ArrowRight,
  Sparkles,
  CheckCircle2,
  MapPin,
  Tag,
  ShieldAlert,
  Settings,
  Users,
  Building2,
  Database,
  BarChart3,
  Search,
  Scan,
  Clock,
  AlertTriangle,
  ClipboardList,
  FileText,
  Calendar,
  Laptop,
  Tv,
  Camera,
  Mic,
  Layers,
  X,
  Filter,
  Wrench,
} from 'lucide-react';
import AppShell from '@/components/AppShell';
import {
  Alert,
  DueHint,
  EmptyState,
  EquipmentBadge,
  LoadingState,
  Modal,
  RequestTable,
  StatCard,
  StatusBadge,
} from '@/components/ui';
import { useAuth } from '@/lib/auth-context';
import { useAllRequests, useCategories, useEquipments, useMyRequests } from '@/lib/hooks';
import {
  DEFAULT_CATEGORIES,
  getActiveBorrowInfo,
  daysUntil,
  fmtDate,
  fmtTs,
  sortByCreatedDesc,
  todayStr,
} from '@/lib/utils';

function getCategoryIcon(id: string) {
  switch (id) {
    case 'CAT-COMPUTER':
      return <Laptop className="h-5 w-5 text-emerald-700" aria-hidden="true" />;
    case 'CAT-PROJECTOR':
      return <Tv className="h-5 w-5 text-emerald-700" aria-hidden="true" />;
    case 'CAT-CAMERA':
      return <Camera className="h-5 w-5 text-emerald-700" aria-hidden="true" />;
    case 'CAT-AUDIO':
      return <Mic className="h-5 w-5 text-emerald-700" aria-hidden="true" />;
    case 'CAT-ACCESSORY':
      return <Layers className="h-5 w-5 text-emerald-700" aria-hidden="true" />;
    default:
      return <Package className="h-5 w-5 text-emerald-700" aria-hidden="true" />;
  }
}

export default function DashboardPage() {
  return (
    <AppShell title="หน้าหลัก (Dashboard)">
      <MainDashboard />
    </AppShell>
  );
}

function MainDashboard() {
  const { profile, loading } = useAuth();
  const isAdmin = profile?.role === 'CUSTODIAN' || profile?.role === 'APPROVER' || profile?.role === 'EXECUTIVE';

  const { data: equipments, loading: eqLoading } = useEquipments();
  const { data: categories } = useCategories();
  const { data: mine, loading: mineLoading } = useMyRequests(profile?.email);
  const { data: all, loading: allLoading } = useAllRequests(isAdmin);

  const [returnModalOpen, setReturnModalOpen] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<string>('ALL');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'AVAILABLE' | 'BORROWED'>('ALL');
  const [searchQuery, setSearchQuery] = useState('');

  const today = todayStr();

  const mergedCategories = useMemo(() => {
    const list = [...categories];
    for (const def of DEFAULT_CATEGORIES) {
      if (!list.some((c) => c.id === def.id)) {
        list.push({ id: def.id, name: def.name, isActive: true });
      }
    }
    // กำหนดให้หมวดหมู่คอมพิวเตอร์และโน้ตบุ๊ก (CAT-COMPUTER) แสดงเป็นลำดับแรกเสมอ
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

  // อุปกรณ์ทั้งหมดที่ยังไม่ถูกลบและไม่ได้จำหน่าย
  const activeEquipments = useMemo(() => {
    return equipments.filter((e) => !e.isDeleted && e.status !== 'RETIRED');
  }, [equipments]);

  // กรองตามหมวดหมู่ สถานะ และคำค้นหา พร้อมเรียงคอมพิวเตอร์และโน้ตบุ๊กขึ้นก่อน
  const filteredEquipments = useMemo(() => {
    return activeEquipments
      .filter((e) => {
        if (selectedCategory !== 'ALL' && e.categoryId !== selectedCategory) return false;
        if (statusFilter === 'AVAILABLE' && e.status !== 'AVAILABLE') return false;
        if (statusFilter === 'BORROWED' && e.status !== 'BORROWED') return false;
        if (searchQuery.trim()) {
          const q = searchQuery.trim().toLowerCase();
          return [e.name, e.assetNumber, e.brand, e.model, e.serialNumber, e.location].some((x) =>
            x?.toLowerCase().includes(q)
          );
        }
        return true;
      })
      .sort((a, b) => {
        if (a.categoryId === 'CAT-COMPUTER' && b.categoryId !== 'CAT-COMPUTER') return -1;
        if (a.categoryId !== 'CAT-COMPUTER' && b.categoryId === 'CAT-COMPUTER') return 1;
        if (a.status === 'AVAILABLE' && b.status !== 'AVAILABLE') return -1;
        if (a.status !== 'AVAILABLE' && b.status === 'AVAILABLE') return 1;
        return a.name.localeCompare(b.name, 'th');
      });
  }, [activeEquipments, selectedCategory, statusFilter, searchQuery]);

  // จัดกลุ่มอุปกรณ์ตามหมวดหมู่เพื่อแสดงผลในหน้าเดียว
  const categorizedGroups = useMemo(() => {
    if (selectedCategory !== 'ALL') {
      const cat = mergedCategories.find((c) => c.id === selectedCategory) || {
        id: selectedCategory,
        name: catName[selectedCategory] || selectedCategory,
        isActive: true,
      };
      return [{ category: cat, items: filteredEquipments }];
    }

    const groups: { category: { id: string; name: string }; items: typeof filteredEquipments }[] = [];
    const usedCatIds = new Set<string>();

    for (const cat of mergedCategories) {
      const items = filteredEquipments.filter((e) => e.categoryId === cat.id);
      if (items.length > 0) {
        groups.push({ category: cat, items });
        usedCatIds.add(cat.id);
      }
    }

    const others = filteredEquipments.filter((e) => !usedCatIds.has(e.categoryId));
    if (others.length > 0) {
      groups.push({ category: { id: 'CAT-OTHER', name: 'ครุภัณฑ์อื่นๆ' }, items: others });
    }

    return groups;
  }, [filteredEquipments, selectedCategory, mergedCategories, catName]);

  if (loading || !profile) {
    return <LoadingState text="กำลังโหลดข้อมูล..." />;
  }

  const me = profile;

  // 1. รายการยืมปัจจุบันที่ถือครองอยู่ (IN_USE / OVERDUE)
  const myHoldingItems = useMemo(() => {
    return mine.filter((r) => ['IN_USE', 'OVERDUE'].includes(r.status));
  }, [mine]);

  // 2. รายการรออนุมัติของผู้ใช้ (PENDING_REVIEW / PENDING_APPROVAL / APPROVED_WAITING_PICKUP)
  const myPendingItems = useMemo(() => {
    return mine.filter((r) =>
      ['PENDING_REVIEW', 'PENDING_APPROVAL', 'APPROVED_WAITING_PICKUP'].includes(r.status)
    );
  }, [mine]);

  // 3. รายการใกล้ครบกำหนดคืน (ภายใน 3 วัน หรือเกินกำหนด)
  const myDueSoonItems = useMemo(() => {
    return myHoldingItems.filter((r) => {
      const d = daysUntil(r.expectedReturnDate);
      return d <= 3;
    });
  }, [myHoldingItems]);

  // 4. ประวัติการยืมล่าสุด (5 รายการล่าสุด)
  const recentHistory = useMemo(() => {
    return sortByCreatedDesc(mine).slice(0, 5);
  }, [mine]);

  // สถิติฝั่ง Admin
  const adminStats = useMemo(() => {
    const totalEquipments = equipments.filter((e) => !e.isDeleted).length;
    const inUseCount = all.filter((r) => r.status === 'IN_USE').length;
    const overdueCount = all.filter((r) => r.status === 'OVERDUE').length;
    const pendingReviewCount = all.filter((r) => r.status === 'PENDING_REVIEW').length;
    const pendingApprovalCount = all.filter((r) => r.status === 'PENDING_APPROVAL').length;

    return {
      totalEquipments,
      inUseCount,
      overdueCount,
      pendingReviewCount,
      pendingApprovalCount,
    };
  }, [equipments, all]);

  const renderEquipmentCard = (e: (typeof equipments)[0]) => {
    const isAvailable = e.status === 'AVAILABLE';
    const isBorrowed = e.status === 'BORROWED';
    const borrowInfo = getActiveBorrowInfo(e, all, today);

    return (
      <div
        key={e.id}
        className="card-hover flex flex-col justify-between overflow-hidden p-3 border border-slate-200/70 rounded-2xl bg-white shadow-xs"
      >
        <div>
          {/* รูปภาพอุปกรณ์ (Rounded container inside 12px card padding) */}
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

          {/* รายละเอียดอุปกรณ์ (Figma Typography: Title 14px, Price/Meta 14px, Caption 12px) */}
          <div className="mt-2.5 space-y-1.5">
            <div>
              <h4 className="font-heading font-semibold text-slate-900 text-sm leading-snug line-clamp-2">
                {e.name}
              </h4>
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
            {borrowInfo.isBorrowed && (
              <div className="rounded-xl bg-slate-50 border border-slate-200/90 p-2 space-y-1 text-xs text-slate-800">
                <div className="flex items-center justify-between font-bold">
                  <span className="flex items-center gap-1 text-slate-700 text-[11px]">
                    <Clock className="h-3 w-3 text-slate-500" />
                    <span>ช่วงเวลายืม:</span>
                  </span>
                  {borrowInfo.isOverdue ? (
                    <span className="inline-flex items-center gap-1 text-[10px] font-bold text-rose-700 bg-rose-100 px-1.5 py-0.5 rounded-md">
                      <AlertTriangle className="h-2.5 w-2.5" /> เกิน {Math.abs(borrowInfo.daysRemaining ?? 0)} วัน
                    </span>
                  ) : borrowInfo.daysRemaining === 0 ? (
                    <span className="inline-flex items-center gap-1 text-[10px] font-bold text-amber-800 bg-amber-100 px-1.5 py-0.5 rounded-md">
                      <Clock className="h-2.5 w-2.5" /> คืนวันนี้
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
            )}
          </div>
        </div>

        {/* ปุ่มทำรายการ (Button Height 48px / h-11 to h-12, Rounded-xl) */}
        <div className="mt-3 pt-2.5 border-t border-slate-100">
          {isAvailable ? (
            <Link
              href={`/borrow/?eq=${e.id}`}
              className="btn-primary min-h-[44px] sm:min-h-[48px] h-11 sm:h-12 w-full text-xs sm:text-sm font-semibold text-center shadow-xs flex items-center justify-center gap-1.5 rounded-xl"
            >
              <span>ยื่นคำขอยืมอุปกรณ์</span>
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
          ) : isBorrowed ? (
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
  };

  return (
    <div className="space-y-5 sm:space-y-8 pb-4 sm:pb-8">
      {/* 1. Welcome Hero Promotional Banner (Compact on mobile) */}
      <div className="relative isolate overflow-hidden flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 sm:gap-6 rounded-2xl sm:rounded-3xl bg-slate-950 p-4 sm:p-6 lg:p-8 text-white border border-slate-700 shadow-sm">
        <Image src="/branding/technology-banner.png" alt="" fill priority sizes="100vw" className="object-cover -z-20" />
        <div aria-hidden="true" className="absolute inset-0 -z-10 bg-gradient-to-r from-slate-950/95 via-slate-950/85 to-slate-950/70" />
        <div className="space-y-1.5 sm:space-y-2">
          <div className="inline-flex items-center gap-1.5 rounded-full bg-white/10 border border-white/15 px-2.5 py-0.5 text-[11px] sm:text-xs font-semibold text-emerald-300">
            <Sparkles className="h-3 w-3 sm:h-3.5 sm:w-3.5 text-emerald-400" aria-hidden="true" />
            <span>ยินดีต้อนรับ, {me.name}</span>
          </div>
          <h1 className="font-heading text-xl sm:text-2xl lg:text-3xl font-black text-white tracking-tight">
            ระบบยืม-คืน ครุภัณฑ์ออนไลน์
          </h1>
          <p className="text-xs sm:text-sm text-slate-300 font-normal leading-relaxed max-w-2xl line-clamp-2 sm:line-clamp-none">
            ตรวจสอบอุปกรณ์ ยื่นคำขอยืม และติดตามสถานะได้ในที่เดียว สำหรับบุคลากรสำนักบริการวิชาการ
          </p>
        </div>

        {/* Main Action Buttons (Compact 2-col grid on mobile) */}
        <div className="grid grid-cols-2 gap-2 w-full sm:w-auto sm:flex sm:items-center sm:gap-3">
          {/* Primary CTA: ค้นหาและยื่นขอยืมอุปกรณ์ */}
          <Link
            href="/equipment/"
            className="inline-flex min-h-[42px] h-10.5 sm:min-h-[48px] sm:h-12 items-center justify-center gap-1.5 sm:gap-2 rounded-xl px-3 sm:px-6 text-xs sm:text-sm font-bold bg-white text-slate-900 shadow-md hover:bg-slate-100 transition active:scale-[0.98]"
          >
            <Search className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-emerald-700" aria-hidden="true" />
            <span>ค้นหา/ขอยืม</span>
          </Link>

          {/* Secondary Action: ดูรายการยืมของฉัน */}
          <Link
            href="/my-requests/"
            className="inline-flex min-h-[42px] h-10.5 sm:min-h-[48px] sm:h-12 items-center justify-center gap-1.5 sm:gap-2 rounded-xl px-2.5 sm:px-4 text-xs sm:text-sm font-semibold border border-white/20 bg-white/10 hover:bg-white/20 text-white transition active:scale-[0.98]"
          >
            <ClipboardList className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-emerald-300" aria-hidden="true" />
            <span>คำขอของฉัน</span>
            {(myHoldingItems.length + myPendingItems.length) > 0 && (
              <span className="rounded-full bg-white text-slate-900 px-1.5 py-0.2 text-[10px] sm:text-xs font-bold">
                {myHoldingItems.length + myPendingItems.length}
              </span>
            )}
          </Link>
        </div>
      </div>

      {/* 2. Overview Stats (Compact 2x2 grid on mobile) */}
      <section className="space-y-3 sm:space-y-4">
        <h2 className="font-heading text-base sm:text-lg font-bold text-slate-900 flex items-center gap-2">
          <Clock className="h-4 w-4 sm:h-5 sm:w-5 text-emerald-700" aria-hidden="true" />
          <span>ข้อมูลและสถานะสำคัญของคุณ</span>
        </h2>

        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-2 lg:grid-cols-4 sm:gap-4">
          <StatCard
            label="อุปกรณ์พร้อมให้ยืม"
            value={eqLoading ? '...' : equipments.filter((e) => !e.isDeleted && e.status === 'AVAILABLE').length}
            hint="พร้อมทำรายการได้ทันที"
            tone="emerald"
          />
          <StatCard
            label="รายการที่คุณถือครองอยู่"
            value={mineLoading ? '...' : myHoldingItems.length}
            hint={myHoldingItems.length > 0 ? 'กำลังนำไปใช้งาน' : 'ไม่มีอุปกรณ์ค้างส่ง'}
            tone="sky"
          />
          <StatCard
            label="รายการของคุณที่รออนุมัติ"
            value={mineLoading ? '...' : myPendingItems.length}
            hint="อยู่ระหว่างการพิจารณา"
            tone="amber"
          />
          <StatCard
            label="ใกล้ครบกำหนด / เกินกำหนด"
            value={mineLoading ? '...' : myDueSoonItems.length}
            hint={myDueSoonItems.length > 0 ? '⚠️ ต้องส่งคืนเร็วๆ นี้' : 'ไม่มีรายการเร่งด่วน'}
            tone={myDueSoonItems.length > 0 ? 'red' : 'slate'}
          />
        </div>
      </section>

      {/* 3. Warning Alert if user has Overdue items */}
      {myDueSoonItems.length > 0 && (
        <div className="rounded-2xl sm:rounded-3xl border border-amber-300 bg-amber-50/90 p-3.5 sm:p-5 shadow-xs">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 sm:gap-4">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 sm:h-11 sm:w-11 items-center justify-center rounded-xl sm:rounded-2xl bg-amber-200 text-amber-900 flex-shrink-0">
                <AlertTriangle className="h-5 w-5 sm:h-6 sm:w-6" aria-hidden="true" />
              </div>
              <div className="space-y-0.5 sm:space-y-1">
                <h3 className="font-heading text-sm sm:text-base font-bold text-amber-950">
                  คุณมีอุปกรณ์ที่ครบกำหนดคืนหรือใกล้ครบกำหนด {myDueSoonItems.length} รายการ
                </h3>
                <p className="text-xs sm:text-sm text-amber-900 leading-relaxed font-medium">
                  กรุณาตรวจสอบวันส่งคืน หรือนำอุปกรณ์มาส่งมอบคืน ณ งานพัสดุ สำนักบริการวิชาการ
                </p>
              </div>
            </div>
            <Link
              href="/my-requests/"
              className="btn-primary min-h-[38px] text-xs sm:text-sm px-3.5 py-1.5 whitespace-nowrap self-start sm:self-auto"
            >
              ดูรายการคืน →
            </Link>
          </div>
        </div>
      )}

      {/* 4. Admin Management Hub (ถ้ามีสิทธิ์) */}
      {isAdmin && (
        <section className="space-y-3 sm:space-y-4 rounded-2xl sm:rounded-3xl bg-emerald-50/40 border border-emerald-100 p-4 sm:p-6 shadow-xs">
          <div className="flex items-center justify-between">
            <h2 className="font-heading text-base sm:text-lg font-bold text-emerald-950 flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 sm:h-5 sm:w-5 text-emerald-700" aria-hidden="true" />
              <span>ศูนย์บริหารจัดการระบบ (Admin Dashboard)</span>
            </h2>
            <Link
              href="/admin/settings/"
              className="text-xs sm:text-sm font-bold text-emerald-800 hover:text-emerald-950 hover:underline flex items-center gap-1.5"
            >
              <Settings className="h-4 w-4" /> ตั้งค่าระบบ <ArrowRight className="h-4 w-4" />
            </Link>
          </div>

          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-2 lg:grid-cols-4 sm:gap-4">
            <StatCard
              label="ครุภัณฑ์ทั้งหมด"
              value={adminStats.totalEquipments}
              hint="ทะเบียนในระบบ"
              tone="slate"
            />
            <StatCard
              label="กำลังถูกยืมใช้งาน"
              value={adminStats.inUseCount}
              hint="อยู่ระหว่างใช้งาน"
              tone="sky"
            />
            <StatCard
              label="คืนช้ากว่ากำหนด (Overdue)"
              value={adminStats.overdueCount}
              hint={adminStats.overdueCount > 0 ? '⚠️ เกินกำหนดส่งคืน' : 'ไม่มีรายการค้าง'}
              tone={adminStats.overdueCount > 0 ? 'red' : 'emerald'}
            />
            {me.role === 'CUSTODIAN' ? (
              <Link href="/review/">
                <StatCard
                  label="รอตรวจสอบ (ขั้น 1)"
                  value={adminStats.pendingReviewCount}
                  hint="คลิกเพื่อพิจารณา"
                  tone="amber"
                />
              </Link>
            ) : me.role === 'APPROVER' ? (
              <Link href="/approve/">
                <StatCard
                  label="รออนุมัติ (ขั้น 2)"
                  value={adminStats.pendingApprovalCount}
                  hint="คลิกเพื่อพิจารณา"
                  tone="amber"
                />
              </Link>
            ) : (
              <StatCard
                label="คำขอในกระบวนการ"
                value={adminStats.pendingReviewCount + adminStats.pendingApprovalCount}
                hint="รอพิจารณา"
                tone="purple"
              />
            )}
          </div>
        </section>
      )}

      {/* 5. อุปกรณ์และครุภัณฑ์แบ่งตามหมวดหมู่ (Equipment Showcase by Category) */}
      <section className="space-y-6">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <h2 className="font-heading text-xl sm:text-2xl font-bold text-slate-900 flex items-center gap-2">
              <Package className="h-6 w-6 text-emerald-600" aria-hidden="true" />
              <span>ครุภัณฑ์และอุปกรณ์สำหรับยืม-คืน</span>
            </h2>
            <p className="text-sm text-slate-600 font-medium mt-0.5">
              แบ่งหมวดหมู่อุปกรณ์ แสดงผลในหน้าเดียว สามารถเลือกดูอุปกรณ์ว่างหรือดูช่วงเวลาการถูกยืมได้ทันที
            </p>
          </div>
          <Link
            href="/equipment/"
            className="text-sm font-bold text-emerald-800 hover:text-emerald-950 flex items-center gap-1 self-start md:self-auto"
          >
            ดูหน้ารายการค้นหาละเอียด ({activeEquipments.length}) <ArrowRight className="h-4 w-4" />
          </Link>
        </div>

        {/* Toolbar: คำค้นหา + ตัวกรองสถานะ + แท็บหมวดหมู่ */}
        <div className="card space-y-4 p-5 bg-white border-slate-200/90 shadow-2xs">
          <div className="flex flex-col sm:flex-row gap-3">
            {/* Search Input */}
            <div className="relative flex-1">
              <Search
                className="absolute left-3.5 top-3 h-4 w-4 text-emerald-600"
                aria-hidden="true"
              />
              <input
                type="text"
                className="input pl-10 pr-9 py-2 text-sm"
                placeholder="ค้นหาชื่ออุปกรณ์, เลขครุภัณฑ์, ยี่ห้อ, สถานที่เก็บ..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="absolute right-3 top-2.5 text-slate-400 hover:text-slate-600 p-1"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>

            {/* Status Filter Toggle */}
            <div className="inline-flex rounded-xl bg-slate-100 p-1 text-xs font-semibold">
              <button
                type="button"
                onClick={() => setStatusFilter('ALL')}
                className={`rounded-lg px-3 py-1.5 transition ${
                  statusFilter === 'ALL'
                    ? 'bg-white text-slate-900 shadow-2xs font-bold'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                ทั้งหมด ({activeEquipments.length})
              </button>
              <button
                type="button"
                onClick={() => setStatusFilter('AVAILABLE')}
                className={`rounded-lg px-3 py-1.5 transition flex items-center gap-1.5 ${
                  statusFilter === 'AVAILABLE'
                    ? 'bg-white text-slate-900 shadow-2xs font-bold'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <span className="h-2 w-2 rounded-full bg-[#155E53]" />
                พร้อมให้ยืม ({activeEquipments.filter((e) => e.status === 'AVAILABLE').length})
              </button>
              <button
                type="button"
                onClick={() => setStatusFilter('BORROWED')}
                className={`rounded-lg px-3 py-1.5 transition flex items-center gap-1.5 ${
                  statusFilter === 'BORROWED'
                    ? 'bg-white text-slate-900 shadow-2xs font-bold'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <span className="h-2 w-2 rounded-full bg-slate-400" />
                ถูกยืมอยู่ ({activeEquipments.filter((e) => e.status === 'BORROWED').length})
              </button>
            </div>
          </div>

          {/* Category Tabs / Pills (Figma clean rounded-xl pills) */}
          <div className="flex items-center gap-2 overflow-x-auto pb-1 pt-1 no-scrollbar border-t border-slate-100 pt-3">
            <button
              type="button"
              onClick={() => setSelectedCategory('ALL')}
              className={`min-h-[40px] rounded-xl px-4 py-2 text-xs font-semibold whitespace-nowrap transition flex items-center gap-1.5 ${
                selectedCategory === 'ALL'
                  ? 'bg-slate-900 text-white shadow-xs font-bold'
                  : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
              }`}
            >
              <Package className="h-3.5 w-3.5" />
              <span>ทุกหมวดหมู่ ({activeEquipments.length})</span>
            </button>
            {mergedCategories.map((c) => {
              const count = activeEquipments.filter((e) => e.categoryId === c.id).length;
              const active = selectedCategory === c.id;
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setSelectedCategory(c.id)}
                  className={`min-h-[40px] rounded-xl px-3.5 py-2 text-xs font-semibold whitespace-nowrap transition flex items-center gap-1.5 ${
                    active
                      ? 'bg-slate-900 text-white shadow-xs font-bold'
                      : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                  }`}
                >
                  {getCategoryIcon(c.id)}
                  <span>{c.name} ({count})</span>
                </button>
              );
            })}
          </div>

          {/* Filter Status Summary and Reset */}
          {(selectedCategory !== 'ALL' || statusFilter !== 'ALL' || searchQuery.trim()) && (
            <div className="flex items-center justify-between text-xs text-slate-500 pt-1 border-t border-slate-100">
              <div>
                <span>พบ <b>{filteredEquipments.length}</b> รายการ</span>
                {selectedCategory !== 'ALL' && (
                  <span className="ml-1 text-emerald-800">
                    ในหมวด &ldquo;{catName[selectedCategory] || selectedCategory}&rdquo;
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={() => {
                  setSelectedCategory('ALL');
                  setStatusFilter('ALL');
                  setSearchQuery('');
                }}
                className="inline-flex items-center gap-1 font-bold text-emerald-700 hover:underline"
              >
                <RotateCcw className="h-3 w-3" /> ล้างตัวกรองทั้งหมด
              </button>
            </div>
          )}
        </div>

        {/* Content Showcase */}
        {eqLoading ? (
          <LoadingState text="กำลังโหลดรายการอุปกรณ์..." />
        ) : !filteredEquipments.length ? (
          <EmptyState
            title="ไม่พบอุปกรณ์ที่ตรงกับเงื่อนไข"
            description="ลองเปลี่ยนหมวดหมู่ ล้างคำค้นหา หรือเปลี่ยนตัวกรองสถานะ"
            action={
              <button
                type="button"
                onClick={() => {
                  setSelectedCategory('ALL');
                  setStatusFilter('ALL');
                  setSearchQuery('');
                }}
                className="btn-primary"
              >
                <RotateCcw className="h-4 w-4" /> ล้างตัวกรองทั้งหมด
              </button>
            }
          />
        ) : (
          <div className="space-y-10">
            {categorizedGroups.map((group) => (
              <div key={group.category.id} className="space-y-4">
                <div className="flex items-center justify-between border-b border-emerald-100/80 pb-3">
                  <div className="flex items-center gap-2.5">
                    <div className="p-2 rounded-2xl bg-emerald-100/80 text-emerald-800 border border-emerald-200">
                      {getCategoryIcon(group.category.id)}
                    </div>
                    <div>
                      <h3 className="font-heading font-bold text-slate-900 text-lg sm:text-xl">
                        {group.category.name}
                      </h3>
                      <p className="text-xs text-slate-500 font-medium">
                        อุปกรณ์ในหมวดนี้ {group.items.length} รายการ
                      </p>
                    </div>
                  </div>
                  {selectedCategory === 'ALL' && (
                    <button
                      type="button"
                      onClick={() => setSelectedCategory(group.category.id)}
                      className="text-xs font-bold text-emerald-700 hover:text-emerald-900 hover:underline inline-flex items-center gap-1"
                    >
                      ดูเฉพาะหมวดนี้ <ArrowRight className="h-3.5 w-3.5" />
                    </button>
                  )}
                  {selectedCategory !== 'ALL' && (
                    <button
                      type="button"
                      onClick={() => setSelectedCategory('ALL')}
                      className="text-xs font-bold text-slate-600 hover:text-slate-900 hover:underline inline-flex items-center gap-1"
                    >
                      ← แสดงทุกหมวดหมู่
                    </button>
                  )}
                </div>

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
                  {group.items.map((e) => renderEquipmentCard(e))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 6. ประวัติการยืมล่าสุดของคุณ (Recent Requests) */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-heading text-xl font-bold text-slate-900 flex items-center gap-2">
            <FileText className="h-6 w-6 text-emerald-700" aria-hidden="true" />
            <span>ประวัติการทำรายการล่าสุดของคุณ</span>
          </h2>
          <Link
            href="/my-requests/"
            className="text-sm font-bold text-emerald-800 hover:underline flex items-center gap-1"
          >
            ดูประวัติทั้งหมด <ArrowRight className="h-4 w-4" />
          </Link>
        </div>

        {mineLoading ? (
          <LoadingState text="กำลังโหลดประวัติ..." />
        ) : !recentHistory.length ? (
          <EmptyState
            title="คุณยังไม่เคยมีประวัติการยื่นคำขอยืม"
            description="เมื่อคุณยื่นคำขอยืมอุปกรณ์ รายการและสถานะการอนุมัติจะปรากฏที่นี่"
            action={
              <Link href="/equipment/" className="btn-cta">
                <Package className="h-4 w-4" /> เริ่มต้นเลือกอุปกรณ์
              </Link>
            }
          />
        ) : (
          <RequestTable requests={recentHistory} showBorrower={false} />
        )}
      </section>
    </div>
  );
}
