'use client';
import Image from 'next/image';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { collection, doc, onSnapshot, query, serverTimestamp, setDoc, where } from 'firebase/firestore';
import {
  Home,
  Package,
  ClipboardList,
  History,
  CheckCircle2,
  Scan,
  Database,
  BarChart3,
  Search,
  LogOut,
  Sparkles,
  Menu,
  X,
  User,
  ShieldCheck,
  Settings,
  Bell,
  Building,
  Mail,
  MoreHorizontal,
  Star,
  Wrench,
} from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { fb } from '@/lib/firebase';
import { SEED_DATA } from '@/lib/seed-data';
import type { Role } from '@/lib/types';
import { ROLE_LABEL } from '@/lib/utils';
import QrScannerModal from '@/components/QrScannerModal';
import { Modal, OfflineBanner, UnauthorizedState } from '@/components/ui';

interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  roles?: Role[];
  badgeKey?: string;
}

// 1. Primary Navigation (General Users)
const PRIMARY_NAV: NavItem[] = [
  { href: '/', label: 'หน้าหลัก', icon: Home },
  { href: '/equipment/', label: 'ค้นหาและยืมอุปกรณ์', icon: Search },
  { href: '/my-requests/', label: 'รายการยืมของฉัน', icon: ClipboardList, badgeKey: 'my-active' },
  { href: '/my-requests/?tab=history', label: 'ประวัติการยืม-คืน', icon: History },
  { href: '/tracking/', label: 'ติดตามสถานะคำขอ', icon: Bell, badgeKey: 'tracking' },
];

// 2. Staff / Admin Management Navigation
const ADMIN_NAV: NavItem[] = [
  { href: '/review/', label: 'ตรวจสอบคำขอ (ขั้น 1)', icon: Search, roles: ['CUSTODIAN', 'EXECUTIVE'], badgeKey: '/review/' },
  { href: '/approve/', label: 'อนุมัติคำขอ (ขั้น 2)', icon: CheckCircle2, roles: ['APPROVER', 'EXECUTIVE'], badgeKey: '/approve/' },
  { href: '/handover/', label: 'ส่งมอบ / รับคืน', icon: Scan, roles: ['CUSTODIAN', 'APPROVER', 'EXECUTIVE'], badgeKey: '/handover/' },
  { href: '/admin/repairs/', label: 'จัดการงานแจ้งซ่อม', icon: Wrench, roles: ['CUSTODIAN', 'APPROVER', 'EXECUTIVE'] },
  { href: '/admin/equipment/', label: 'จัดการครุภัณฑ์', icon: Database, roles: ['CUSTODIAN', 'EXECUTIVE'] },
  { href: '/reports/', label: 'รายงานและสถิติ', icon: BarChart3, roles: ['CUSTODIAN', 'APPROVER', 'EXECUTIVE'] },
  { href: '/reports/?tab=csat', label: 'ความพึงพอใจและความคิดเห็น', icon: Star, roles: ['CUSTODIAN', 'APPROVER', 'EXECUTIVE'] },
  { href: '/admin/settings/', label: 'ตั้งค่าระบบ', icon: Settings, roles: ['CUSTODIAN', 'APPROVER', 'EXECUTIVE'] },
];

export default function AppShell({
  children,
  roles,
  title,
  actions,
}: {
  children: ReactNode;
  roles?: Role[];
  title?: string;
  actions?: ReactNode;
}) {
  const { profile, realProfile, isImpersonating, switchUser, loading, signOut } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [currentSearch, setCurrentSearch] = useState('');
  const [badges, setBadges] = useState<Record<string, number>>({});
  const [menuOpen, setMenuOpen] = useState(false);
  const [testModeOpen, setTestModeOpen] = useState(false);
  const [testModeEnabled, setTestModeEnabled] = useState<boolean>(false);
  const [qrScannerOpen, setQrScannerOpen] = useState(false);
  const [profileModalOpen, setProfileModalOpen] = useState(false);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      setCurrentSearch(window.location.search);
    }
  }, [pathname]);

  useEffect(() => {
    if (!loading && !profile) {
      const search = typeof window !== 'undefined' ? window.location.search : '';
      let cleanPath = pathname;
      if (!cleanPath.endsWith('/')) {
        cleanPath += '/';
      }
      const fullPath = cleanPath + search;
      if (fullPath && fullPath !== '/' && !fullPath.startsWith('/login')) {
        try {
          sessionStorage.setItem('post_login_redirect', fullPath);
          localStorage.setItem('post_login_redirect', fullPath);
        } catch {}
        router.replace(`/login/?redirect=${encodeURIComponent(fullPath)}`);
      } else {
        router.replace('/login/');
      }
    }
  }, [loading, profile, router, pathname]);

  // Dynamic Document Title Sync
  useEffect(() => {
    if (typeof document !== 'undefined') {
      if (title) {
        document.title = `${title} | ระบบยืม-คืนครุภัณฑ์ สำนักบริการวิชาการ มข.`;
      } else {
        document.title = 'ระบบยืม-คืนครุภัณฑ์ | สำนักบริการวิชาการ มหาวิทยาลัยขอนแก่น';
      }
    }
  }, [title]);

  // Real-time Test Mode Sync
  useEffect(() => {
    const { db } = fb();
    const unsub = onSnapshot(doc(db, 'system_settings', 'policy'), (snap) => {
      if (snap.exists()) {
        const data = snap.data();
        if (typeof data.enableTestMode === 'boolean') {
          setTestModeEnabled(process.env.NEXT_PUBLIC_USE_EMULATOR === 'true' && data.enableTestMode);
          if (!data.enableTestMode && isImpersonating) {
            switchUser(null);
          }
        }
      }
    });
    return () => unsub();
  }, [isImpersonating, switchUser]);

  const handleDisableTestMode = async () => {
    try {
      const { db } = fb();
      await setDoc(
        doc(db, 'system_settings', 'policy'),
        { enableTestMode: false, updatedAt: serverTimestamp() },
        { merge: true }
      );
    } catch {
      // If permission or network issue, fallback to closing locally
    }
    if (isImpersonating) {
      switchUser(null);
    }
    setTestModeEnabled(false);
  };

  // Real-time Badge Counters
  useEffect(() => {
    if (!profile) return;
    const { db } = fb();
    const unsubs: (() => void)[] = [];

    // Watch admin items
    if (profile.role === 'CUSTODIAN') {
      unsubs.push(
        onSnapshot(
          query(collection(db, 'borrow_requests'), where('status', '==', 'PENDING_REVIEW')),
          (s) => setBadges((b) => ({ ...b, '/review/': s.size }))
        )
      );
      unsubs.push(
        onSnapshot(
          query(
            collection(db, 'borrow_requests'),
            where('status', 'in', ['APPROVED_WAITING_PICKUP', 'OVERDUE'])
          ),
          (s) => setBadges((b) => ({ ...b, '/handover/': s.size }))
        )
      );
    }
    if (profile.role === 'APPROVER') {
      unsubs.push(
        onSnapshot(
          query(collection(db, 'borrow_requests'), where('status', '==', 'PENDING_APPROVAL')),
          (s) => setBadges((b) => ({ ...b, '/approve/': s.size }))
        )
      );
    }

    // Watch user's own active requests
    unsubs.push(
      onSnapshot(
        query(
          collection(db, 'borrow_requests'),
          where('borrower.email', '==', profile.email.toLowerCase()),
          where('status', 'in', ['PENDING_REVIEW', 'PENDING_APPROVAL', 'APPROVED_WAITING_PICKUP', 'IN_USE', 'OVERDUE'])
        ),
        (s) => setBadges((b) => ({ ...b, 'my-active': s.size }))
      )
    );

    return () => unsubs.forEach((u) => u());
  }, [profile]);

  // Automated Background Worker: Sweep stray PENDING mail queue items for active staff sessions
  useEffect(() => {
    if (!profile) return;
    const isStaff = ['CUSTODIAN', 'APPROVER', 'EXECUTIVE'].includes(profile.role);
    if (!isStaff) return;

    let isMounted = true;
    const runSweep = async () => {
      try {
        const { batchProcessPendingQueue } = await import('@/lib/notifications');
        if (isMounted) {
          await batchProcessPendingQueue(10);
        }
      } catch {
        // Silently ignore background sweep errors
      }
    };

    // Initial sweep after 3 seconds, then periodically every 60 seconds
    const initialTimer = setTimeout(runSweep, 3000);
    const intervalTimer = setInterval(runSweep, 60000);

    return () => {
      isMounted = false;
      clearTimeout(initialTimer);
      clearInterval(intervalTimer);
    };
  }, [profile]);

  if (loading || !profile) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-[#F8FAFC] text-slate-600 font-medium">
        <div className="flex flex-col items-center gap-3">
          <div className="h-10 w-10 animate-spin rounded-full border-3 border-slate-900 border-t-transparent shadow-sm" />
          <span className="font-heading font-bold text-slate-800">กำลังโหลดระบบ...</span>
        </div>
      </div>
    );
  }

  const allowed = !roles || roles.includes(profile.role);
  const isAdminOrStaff = profile.role === 'CUSTODIAN' || profile.role === 'APPROVER' || profile.role === 'EXECUTIVE';
  const availableAdminNav = ADMIN_NAV.filter((n) => !n.roles || n.roles.includes(profile.role));

  const renderNavLinks = (items: NavItem[]) => (
    <div className="space-y-1.5">
      {items.map((n) => {
        const Icon = n.icon;
        const [rawPath, navQuery] = n.href.split('?');
        const targetPath = rawPath.endsWith('/') && rawPath !== '/' ? rawPath.slice(0, -1) : rawPath;
        const cleanCurrentPath = pathname.endsWith('/') && pathname !== '/' ? pathname.slice(0, -1) : pathname;
        const pathMatches =
          targetPath === '/'
            ? cleanCurrentPath === '/'
            : cleanCurrentPath === targetPath || cleanCurrentPath.startsWith(targetPath + '/');

        const isHistoryLink = navQuery === 'tab=history';
        const isHistoryQueryActive = currentSearch.includes('tab=history');
        const isCsatLink = navQuery === 'tab=csat';
        const isCsatQueryActive = currentSearch.includes('tab=csat');
        const active =
          pathMatches &&
          (targetPath === '/my-requests'
            ? isHistoryLink
              ? isHistoryQueryActive
              : !isHistoryQueryActive
            : targetPath === '/reports'
            ? isCsatLink
              ? isCsatQueryActive
              : !isCsatQueryActive
            : true);

        const badgeCount = n.badgeKey ? badges[n.badgeKey] : 0;

        return (
          <Link
            key={n.href}
            href={n.href}
            onClick={() => {
              setCurrentSearch(navQuery ? `?${navQuery}` : '');
              setMenuOpen(false);
            }}
            className={`flex min-h-[44px] items-center justify-between rounded-xl px-3.5 py-2.5 text-sm font-semibold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900/30 ${
              active
                ? 'bg-slate-900 text-white shadow-xs font-bold'
                : 'text-slate-700 hover:bg-slate-100 hover:text-slate-900'
            }`}
          >
            <span className="flex items-center gap-3">
              <Icon
                className={`h-5 w-5 flex-shrink-0 ${active ? 'text-white' : 'text-slate-500'}`}
                aria-hidden="true"
              />
              <span>{n.label}</span>
            </span>
            {badgeCount && badgeCount > 0 ? (
              <span
                className={`rounded-full px-2 py-0.5 text-xs font-bold ${
                  active ? 'bg-white text-slate-900' : 'bg-slate-900 text-white shadow-2xs'
                }`}
              >
                {badgeCount}
              </span>
            ) : null}
          </Link>
        );
      })}
    </div>
  );

  return (
    <div className="flex min-h-dvh flex-col bg-[#F8FAFC] text-slate-900 overflow-x-hidden pb-[calc(4.25rem+env(safe-area-inset-bottom,0px))] md:pb-0">
      {/* 1. Offline Listener Banner */}
      <OfflineBanner />

      {/* 2. Test Mode Banner */}
      {testModeEnabled && (
        <>
          <div className="no-print border-b border-amber-300 bg-amber-400 px-4 py-2 text-xs text-amber-950 shadow-xs">
            <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 font-medium">
                <span className="flex items-center gap-1.5 font-bold">
                  <Sparkles className="h-4 w-4" /> โหมดทดสอบระบบ:
                </span>
                <span>
                  สลับบทบาทเป็น: <b>{profile.name}</b>
                </span>
                <span className="rounded-full bg-amber-900/15 px-2.5 py-0.5 text-[11px] font-bold">
                  {ROLE_LABEL[profile.role]}
                </span>
                {isImpersonating && (
                  <span className="rounded-full bg-amber-900 px-2 py-0.5 text-[10px] font-semibold text-white">
                    จำลองสิทธิ์
                  </span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => switchUser('chalpr@kku.ac.th')}
                  className={`rounded-xl px-2.5 py-1 text-xs font-bold transition ${
                    profile.email === 'chalpr@kku.ac.th'
                      ? 'bg-amber-950 text-white shadow-xs'
                      : 'bg-white/80 hover:bg-white text-amber-950'
                  }`}
                >
                  นายชาลี (ผู้ดูแล)
                </button>
                <button
                  type="button"
                  onClick={() => switchUser('praysu@kku.ac.th')}
                  className={`rounded-xl px-2.5 py-1 text-xs font-bold transition ${
                    profile.email === 'praysu@kku.ac.th'
                      ? 'bg-amber-950 text-white shadow-xs'
                      : 'bg-white/80 hover:bg-white text-amber-950'
                  }`}
                >
                  นายประหยัด (ผู้อนุมัติ)
                </button>
                <button
                  type="button"
                  onClick={() => switchUser('tiwaka@kku.ac.th')}
                  className={`rounded-xl px-2.5 py-1 text-xs font-bold transition ${
                    profile.email === 'tiwaka@kku.ac.th'
                      ? 'bg-amber-950 text-white shadow-xs'
                      : 'bg-white/80 hover:bg-white text-amber-950'
                  }`}
                >
                  นายทิวากร (ผู้ยื่น)
                </button>
                <button
                  type="button"
                  onClick={() => setTestModeOpen(!testModeOpen)}
                  className="rounded-xl border border-amber-900/30 bg-amber-800 px-2.5 py-1 text-xs font-bold text-white hover:bg-amber-900"
                >
                  📋 เลือกจาก 30 ท่าน...
                </button>
                {isImpersonating && (
                  <button
                    type="button"
                    onClick={() => switchUser(null)}
                    className="rounded-xl bg-slate-900 px-2.5 py-1 text-xs font-bold text-white hover:bg-black"
                  >
                    ↩ บัญชีจริง
                  </button>
                )}
                <button
                  type="button"
                  onClick={handleDisableTestMode}
                  className="rounded-xl border border-rose-300 bg-white hover:bg-rose-50 text-rose-800 px-2.5 py-1 text-xs font-bold transition flex items-center gap-1 shadow-2xs"
                  title="ปิดโหมดทดสอบระบบ (ซ่อนแถบนี้)"
                >
                  <X className="h-3.5 w-3.5 text-rose-700" />
                  <span>ปิดโหมดทดสอบ</span>
                </button>
              </div>
            </div>
          </div>

          {/* Test Selector Modal */}
          {testModeOpen && (
            <div className="no-print border-b border-amber-200 bg-amber-50 p-5 shadow-inner">
              <div className="mx-auto max-w-7xl">
                <div className="mb-3 flex items-center justify-between">
                  <span className="font-bold text-amber-950">
                    เลือกบุคลากรที่ต้องการสลับเพื่อทดสอบ (ทั้งหมด 30 ท่าน):
                  </span>
                  <button
                    type="button"
                    onClick={() => setTestModeOpen(false)}
                    className="text-xs font-bold text-amber-800 underline hover:text-amber-950"
                  >
                    ปิดกล่องนี้
                  </button>
                </div>
                <div className="grid max-h-72 gap-2 overflow-y-auto sm:grid-cols-2 lg:grid-cols-3 pr-1">
                  {SEED_DATA.users.map((u) => {
                    const isCur = profile.email === u.email.toLowerCase();
                    return (
                      <button
                        key={u.employeeCode}
                        type="button"
                        onClick={() => {
                          switchUser(u.email);
                          setTestModeOpen(false);
                        }}
                        className={`flex items-start justify-between rounded-2xl border p-2.5 text-left text-xs transition ${
                          isCur
                            ? 'border-emerald-600 bg-emerald-50/80 font-bold text-emerald-900 shadow-xs'
                            : 'border-slate-200 bg-white hover:border-emerald-300 hover:bg-emerald-50/30 text-slate-700'
                        }`}
                      >
                        <div>
                          <div className="font-bold text-slate-900">{u.name}</div>
                          <div className="text-[11px] text-slate-500">{u.position}</div>
                          <div className="text-[10px] text-slate-500 font-medium">{u.mission}</div>
                        </div>
                        <span
                          className={`ml-1 rounded-full px-2 py-0.5 text-[10px] font-bold whitespace-nowrap ${
                            u.role === 'CUSTODIAN'
                              ? 'bg-amber-100 text-amber-900 border border-amber-200'
                              : u.role === 'APPROVER'
                              ? 'bg-sky-100 text-sky-900 border border-sky-200'
                              : u.role === 'EXECUTIVE'
                              ? 'bg-purple-100 text-purple-900 border border-purple-200'
                              : 'bg-slate-100 text-slate-600'
                          }`}
                        >
                          {ROLE_LABEL[u.role as Role] || u.role}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </>
      )}

      <div className="flex flex-1">
        {/* 3. Accessible Sidebar (Desktop + Mobile Drawer) */}
        <aside
          className={`no-print fixed inset-y-0 left-0 z-50 w-64 transform border-r border-slate-200/80 bg-white p-5 transition-transform duration-200 ease-in-out md:static md:translate-x-0 flex flex-col justify-between overflow-y-auto ${
            menuOpen ? 'translate-x-0 shadow-2xl' : '-translate-x-full'
          }`}
          aria-label="เมนูหลัก"
        >
          <div>
            {/* Logo Brand */}
            <div className="mb-6 flex items-center justify-between border-b border-slate-100 pb-4">
              <Link href="/" className="flex items-center gap-3" onClick={() => setMenuOpen(false)}>
                <Image src="/branding/oas-kku-logo.png" alt="ตราสำนักบริการวิชาการ มข." width={750} height={450} className="h-auto w-20 shrink-0 object-contain" />
                <div>
                  <div className="font-heading text-base font-bold text-slate-900 leading-tight">
                    ระบบยืม-คืนครุภัณฑ์
                  </div>
                  <div className="text-xs font-semibold text-[#155E53] tracking-wide">
                    สำนักบริการวิชาการ มข.
                  </div>
                </div>
              </Link>
              <button
                type="button"
                onClick={() => setMenuOpen(false)}
                className="md:hidden flex h-10 w-10 min-h-[44px] min-w-[44px] items-center justify-center rounded-xl text-slate-400 hover:bg-slate-100 transition"
                aria-label="ปิดเมนู"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Section 1: เมนูทั่วไปสำหรับผู้ใช้ */}
            <div className="space-y-4">
              <div className="text-xs font-bold uppercase tracking-wider text-slate-500 px-3">
                เมนูผู้ใช้งาน
              </div>
              {renderNavLinks(PRIMARY_NAV)}

              {/* Section 2: เมนูสำหรับเจ้าหน้าที่ & ผู้บริหาร */}
              {isAdminOrStaff && availableAdminNav.length > 0 && (
                <div className="pt-4 border-t border-slate-100 space-y-2">
                  <div className="text-xs font-semibold uppercase tracking-wider text-slate-700 px-3 flex items-center justify-between">
                    <span>งานตรวจสอบ & บริหาร</span>
                    <ShieldCheck className="h-3.5 w-3.5 text-slate-500" />
                  </div>
                  {renderNavLinks(availableAdminNav)}
                </div>
              )}
            </div>
          </div>

          {/* User Profile Card Footer */}
          <div className="mt-8 pt-4 border-t border-slate-100">
            <div
              onClick={() => setProfileModalOpen(true)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setProfileModalOpen(true);
                }
              }}
              className="rounded-2xl bg-slate-50 border border-slate-200/80 p-3 text-sm shadow-2xs hover:border-slate-300 transition cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900"
              role="button"
              tabIndex={0}
              aria-label="ดูข้อมูลโปรไฟล์ผู้ใช้งาน"
            >
              <div className="flex items-center gap-2.5">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-900 text-white font-heading font-bold text-sm shadow-xs">
                  {profile.name.slice(0, 1)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-heading font-bold text-slate-900 text-sm">
                    {profile.name}
                  </div>
                  <div className="truncate text-xs text-slate-500 font-medium">{profile.position}</div>
                </div>
              </div>
              <div className="mt-2.5 flex items-center justify-between border-t border-slate-200/60 pt-2 text-xs">
                <span className="rounded-lg bg-slate-200/70 px-2 py-0.5 text-[11px] font-semibold text-slate-800">
                  {ROLE_LABEL[profile.role]}
                </span>
                <span className="text-slate-800 font-bold hover:underline">
                  ดูโปรไฟล์ →
                </span>
              </div>
            </div>
          </div>
        </aside>

        {/* Mobile Backdrop */}
        {menuOpen && (
          <div
            className="fixed inset-0 z-40 bg-slate-900/40 backdrop-blur-xs md:hidden"
            onClick={() => setMenuOpen(false)}
            aria-hidden="true"
          />
        )}

        {/* 4. Main Page Content */}
        <main className="min-w-0 flex-1 flex flex-col">
          {/* Top Navbar Header */}
          <header className="no-print sticky top-0 z-20 flex min-h-[52px] sm:min-h-[64px] h-13 sm:h-16 items-center justify-between gap-3 border-b border-slate-200/80 bg-white/90 px-3.5 sm:px-6 md:px-10 backdrop-blur-md">
            <div className="flex items-center gap-2.5 min-w-0">
              <button
                type="button"
                className="btn-outline min-h-[38px] p-2 md:hidden"
                onClick={() => setMenuOpen(true)}
                aria-label="เปิดเมนูการนำทาง"
              >
                <Menu className="h-5 w-5" />
              </button>
              <h1 className="truncate font-heading text-base sm:text-xl font-black text-slate-900">
                {title}
              </h1>
            </div>

            {/* Quick Actions in Navbar */}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setQrScannerOpen(true)}
                className="btn-outline min-h-[38px] flex items-center gap-1.5 text-xs sm:text-sm px-2.5 sm:px-3.5 font-bold border-emerald-200 text-emerald-800 bg-emerald-50/60 hover:bg-emerald-100/70 transition shadow-2xs"
                title="เปิดกล้องสแกน QR Code"
              >
                <Scan className="h-4 w-4 text-emerald-700" aria-hidden="true" />
                <span className="hidden sm:inline">สแกน QR</span>
              </button>
              {actions}
            </div>
          </header>

          {/* Page Body */}
          <div className="p-3 sm:p-6 md:p-10 max-w-7xl mx-auto w-full flex-1">
            {allowed ? (
              children
            ) : (
              <UnauthorizedState
                title="ไม่มีสิทธิ์เข้าถึงหน้านี้"
                description={`หน้านี้สงวนไว้เฉพาะสำหรับ: ${roles?.map((r) => ROLE_LABEL[r]).join(', ')}`}
              />
            )}
          </div>
        </main>
      </div>

      {/* 5. Mobile-First Bottom Floating Dock Navigation (Hidden on md+) */}
      <nav
        className="no-print fixed bottom-0 left-0 right-0 z-30 flex md:hidden items-center justify-around border-t border-slate-200/90 bg-white/95 px-2 pt-1.5 pb-[max(0.45rem,env(safe-area-inset-bottom,0px))] backdrop-blur-lg shadow-lg"
        aria-label="เมนูลัดสำหรับมือถือ"
      >
        <Link
          href="/"
          className={`flex flex-col items-center gap-0.5 rounded-xl px-2.5 py-1 text-[11px] font-semibold transition ${
            pathname === '/' ? 'text-slate-900 font-bold' : 'text-slate-500 hover:text-slate-900'
          }`}
        >
          <Home className={`h-5 w-5 ${pathname === '/' ? 'text-slate-900' : 'text-slate-400'}`} />
          <span>หน้าหลัก</span>
        </Link>

        <Link
          href="/equipment/"
          className={`flex flex-col items-center gap-0.5 rounded-xl px-2.5 py-1 text-[11px] font-semibold transition ${
            pathname.startsWith('/equipment') ? 'text-slate-900 font-bold' : 'text-slate-500 hover:text-slate-900'
          }`}
        >
          <Search className={`h-5 w-5 ${pathname.startsWith('/equipment') ? 'text-slate-900' : 'text-slate-400'}`} />
          <span>ค้นหา</span>
        </Link>

        {/* Center Radiant QR Scan Action */}
        <button
          type="button"
          onClick={() => setQrScannerOpen(true)}
          className="-mt-4 flex h-12 w-12 flex-col items-center justify-center rounded-full bg-slate-900 text-white shadow-lg shadow-slate-900/30 ring-4 ring-white active:scale-95 transition"
          aria-label="เปิดกล้องสแกน QR Code"
        >
          <Scan className="h-5 w-5" />
        </button>

        <Link
          href="/my-requests/"
          className={`relative flex flex-col items-center gap-0.5 rounded-xl px-2.5 py-1 text-[11px] font-semibold transition ${
            pathname.startsWith('/my-requests') ? 'text-slate-900 font-bold' : 'text-slate-500 hover:text-slate-900'
          }`}
        >
          <ClipboardList className={`h-5 w-5 ${pathname.startsWith('/my-requests') ? 'text-slate-900' : 'text-slate-400'}`} />
          <span>คำขอของฉัน</span>
          {badges['my-active'] && badges['my-active'] > 0 ? (
            <span className="absolute top-0 right-1 flex h-4 w-4 items-center justify-center rounded-full bg-slate-900 text-[10px] font-bold text-white ring-2 ring-white">
              {badges['my-active']}
            </span>
          ) : null}
        </Link>

        <button
          type="button"
          onClick={() => setMenuOpen(true)}
          className="flex flex-col items-center gap-0.5 rounded-xl px-2.5 py-1 text-[11px] font-semibold text-slate-500 hover:text-slate-900"
          aria-label="เปิดเมนูเพิ่มเติม"
        >
          <MoreHorizontal className="h-5 w-5 text-slate-400" />
          <span>เมนู</span>
        </button>
      </nav>

      {/* Profile Detail Modal */}
      <Modal
        open={profileModalOpen}
        onClose={() => setProfileModalOpen(false)}
        title="ข้อมูลโปรไฟล์ผู้ใช้งาน"
      >
        <div className="space-y-5">
          <div className="flex items-center gap-4 p-4 rounded-3xl bg-emerald-50/60 border border-emerald-100">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-600 to-teal-700 text-white font-heading font-black text-2xl shadow-sm">
              {profile.name.slice(0, 1)}
            </div>
            <div>
              <h3 className="font-heading text-lg font-bold text-slate-900">{profile.name}</h3>
              <p className="text-sm text-slate-600 font-medium">{profile.position}</p>
              <span className="mt-1 inline-block rounded-full bg-emerald-600 px-3 py-0.5 text-xs font-bold text-white shadow-2xs">
                {ROLE_LABEL[profile.role]}
              </span>
            </div>
          </div>

          <div className="grid gap-3 text-sm">
            <div className="flex items-center justify-between p-3.5 rounded-2xl bg-slate-50 border border-slate-100">
              <span className="text-slate-500 font-medium flex items-center gap-2">
                <Building className="h-4 w-4" /> สังกัด / ฝ่ายงาน
              </span>
              <span className="font-bold text-slate-800">{profile.mission || '-'}</span>
            </div>
            <div className="flex items-center justify-between p-3.5 rounded-2xl bg-slate-50 border border-slate-100">
              <span className="text-slate-500 font-medium flex items-center gap-2">
                <Mail className="h-4 w-4" /> อีเมล
              </span>
              <span className="font-mono font-bold text-slate-800">{profile.email}</span>
            </div>
            <div className="flex items-center justify-between p-3.5 rounded-2xl bg-slate-50 border border-slate-100">
              <span className="text-slate-500 font-medium flex items-center gap-2">
                <ShieldCheck className="h-4 w-4" /> รหัสบุคลากร
              </span>
              <span className="font-mono font-bold text-slate-800">{profile.employeeCode}</span>
            </div>
          </div>

          <div className="flex items-center justify-between pt-3 border-t border-slate-100">
            <button
              type="button"
              onClick={signOut}
              className="btn-danger min-h-[40px] text-sm px-4 py-2 flex items-center gap-2"
            >
              <LogOut className="h-4 w-4" /> ออกจากระบบ
            </button>
            <button
              type="button"
              onClick={() => setProfileModalOpen(false)}
              className="btn-outline min-h-[40px] text-sm"
            >
              ปิด
            </button>
          </div>
        </div>
      </Modal>

      {/* Universal QR Code Scanner Modal */}
      <QrScannerModal
        open={qrScannerOpen}
        onClose={() => setQrScannerOpen(false)}
      />
    </div>
  );
}
