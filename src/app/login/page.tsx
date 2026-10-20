'use client';
import Image from 'next/image';

import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Package,
  ShieldCheck,
  Sparkles,
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  Phone,
  Mail,
  HelpCircle,
  Lock,
  ArrowRight,
} from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { ALLOWED_DOMAIN } from '@/lib/firebase';
import { Alert, LoadingState } from '@/components/ui';
import { validateReturnUrl } from '@/lib/utils';

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-dvh items-center justify-center bg-slate-900 text-white">
          <LoadingState text="กำลังโหลดหน้าเข้าสู่ระบบ..." />
        </div>
      }
    >
      <LoginContent />
    </Suspense>
  );
}

function LoginContent() {
  const { profile, loading, error, signIn, isInAppBrowser } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirectParam = searchParams.get('redirect');
  const [contactOpen, setContactOpen] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const copyInputRef = useRef<HTMLInputElement>(null);

  // คำนวณและตรวจสอบ redirect target ทันที ป้องกัน Open Redirect อย่างเข้มงวด
  const validatedTarget = useMemo(() => {
    if (redirectParam) {
      const checked = validateReturnUrl(redirectParam);
      if (checked && checked !== '/') return checked;
    }
    if (typeof window !== 'undefined') {
      try {
        const stored =
          sessionStorage.getItem('post_login_redirect') ||
          localStorage.getItem('post_login_redirect');
        if (stored) {
          const checked = validateReturnUrl(stored);
          if (checked && checked !== '/') return checked;
        }
      } catch {}
    }
    return '/';
  }, [redirectParam]);

  // บันทึก URL ปลายทางที่ผ่านการตรวจสอบแล้วลงใน storage ของเบราว์เซอร์ปัจจุบันทันทีเมื่อโหลด
  // เพื่อรองรับทั้งกรณี signInWithPopup และ signInWithRedirect ที่กลับมาโดยไม่มี query string
  useEffect(() => {
    if (validatedTarget !== '/' && typeof window !== 'undefined') {
      try {
        sessionStorage.setItem('post_login_redirect', validatedTarget);
        localStorage.setItem('post_login_redirect', validatedTarget);
      } catch {}
    }
  }, [validatedTarget]);

  // ลิงก์สมบูรณ์สำหรับคัดลอกไปเปิดใน Chrome หรือ Safari
  const shareableExternalUrl = useMemo(() => {
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    return validatedTarget !== '/' ? `${origin}${validatedTarget}` : origin || '/';
  }, [validatedTarget]);

  const copyExternalLink = async () => {
    const textToCopy = shareableExternalUrl;
    let copied = false;

    // ลำดับที่ 1: ลองใช้ Modern Async Clipboard API ก่อน
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      try {
        await navigator.clipboard.writeText(textToCopy);
        copied = true;
      } catch {
        copied = false;
      }
    }

    // ลำดับที่ 2: Fallback สำหรับ WebView / เบราว์เซอร์ที่ปิดกั้น Clipboard API
    if (!copied && typeof document !== 'undefined') {
      try {
        const textarea = document.createElement('textarea');
        textarea.value = textToCopy;
        textarea.style.position = 'fixed';
        textarea.style.left = '-9999px';
        textarea.style.top = '-9999px';
        textarea.setAttribute('readonly', '');
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        textarea.setSelectionRange(0, 99999);
        copied = document.execCommand('copy');
        document.body.removeChild(textarea);
      } catch {
        copied = false;
      }
    }

    if (copied) {
      setLinkCopied(true);
      setCopyFailed(false);
      setTimeout(() => setLinkCopied(false), 3000);
    } else {
      // ลำดับที่ 3: กรณีทั้งสองวิธีถูกบล็อกทั้งหมด ไฮไลต์กล่อง input เพื่อให้ผู้ใช้แตะคัดลอกเองได้ทันที
      setCopyFailed(true);
      if (copyInputRef.current) {
        copyInputRef.current.focus();
        copyInputRef.current.select();
        copyInputRef.current.setSelectionRange(0, 99999);
      }
    }
  };

  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.title = 'เข้าสู่ระบบ | ระบบยืม-คืนครุภัณฑ์ สำนักบริการวิชาการ มข.';
    }
  }, []);

  // ส่งผู้ใช้ไปยังปลายทางเดียวกันหลังเข้าสู่ระบบสำเร็จ ทั้งกรณี Popup และ Redirect
  useEffect(() => {
    if (profile) {
      const dest = validatedTarget !== '/' ? validatedTarget : '/';
      if (typeof window !== 'undefined') {
        try {
          sessionStorage.removeItem('post_login_redirect');
          localStorage.removeItem('post_login_redirect');
        } catch {}
      }
      router.replace(dest);
    }
  }, [profile, router, validatedTarget]);

  return (
    <div className="relative flex min-h-dvh items-center justify-center bg-gradient-to-br from-slate-900 via-slate-800 to-emerald-950 p-4 sm:p-6 lg:p-8">
      <Image src="/branding/technology-banner.png" alt="" fill priority sizes="100vw" className="object-cover" />
      <div aria-hidden="true" className="absolute inset-0 bg-slate-950/65" />
      {/* Decorative backdrop glow */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-40 -left-40 h-96 w-96 rounded-full bg-emerald-500/20 blur-3xl" />
        <div className="absolute -bottom-40 -right-40 h-96 w-96 rounded-full bg-teal-500/15 blur-3xl" />
      </div>

      <div className="relative w-full max-w-lg rounded-3xl bg-white p-6 sm:p-10 shadow-2xl border border-emerald-100/80">
        {/* Header Branding */}
        <div className="text-center space-y-3 pb-2">
          <Image src="/branding/oas-kku-logo.png" alt="ตราสำนักบริการวิชาการ มหาวิทยาลัยขอนแก่น" width={750} height={450} priority className="mx-auto h-auto w-48 max-w-full object-contain" />

          <div className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 border border-emerald-200 px-3.5 py-1 text-xs font-bold text-emerald-900">
            <Sparkles className="h-3.5 w-3.5 text-emerald-600" /> สำนักบริการวิชาการ มหาวิทยาลัยขอนแก่น
          </div>

          <h1 className="font-heading text-2xl sm:text-3xl font-black text-slate-900 tracking-tight">
            ระบบยืม-คืน ครุภัณฑ์ออนไลน์
          </h1>

          {/* Key Benefit Statement */}
          <p className="text-base text-slate-600 font-medium leading-relaxed max-w-sm mx-auto">
            ตรวจสอบอุปกรณ์ ยื่นคำขอยืม และติดตามสถานะได้ในที่เดียว
          </p>
        </div>

        {/* In-App Browser Guidance Banner */}
        {isInAppBrowser && (
          <div className="my-4 rounded-2xl bg-amber-50 border border-amber-200 p-3.5 text-xs text-amber-900 space-y-2">
            <div className="font-bold flex items-center gap-1.5 text-amber-950">
              <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" />
              <span>📱 เปิดจากแอป LINE หรือ In-App Browser:</span>
            </div>
            <p className="text-[11px] leading-relaxed text-amber-900/90">
              Google ไม่อนุญาตให้เข้าสู่ระบบผ่านเบราว์เซอร์ใน LINE กดปุ่ม <b>⋯ (สามจุด)</b> แล้วเลือก <b>เปิดใน Chrome/Safari</b> หรือคัดลอกลิงก์ด้านล่างไปเปิดในเบราว์เซอร์ดังกล่าว:
            </p>
            <div className="space-y-1.5 pt-1">
              <input
                ref={copyInputRef}
                readOnly
                aria-label="ลิงก์คำขอสำหรับเปิดใน Chrome หรือ Safari"
                className="w-full rounded-lg border border-amber-300 bg-white px-2.5 py-2 text-xs font-mono text-slate-800 shadow-xs focus:ring-2 focus:ring-amber-500 select-all"
                value={shareableExternalUrl}
                onFocus={(e) => {
                  e.currentTarget.select();
                  e.currentTarget.setSelectionRange(0, 99999);
                }}
                onClick={(e) => {
                  e.currentTarget.select();
                  e.currentTarget.setSelectionRange(0, 99999);
                }}
              />
              <div className="flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={copyExternalLink}
                  className="rounded-lg border border-amber-500 bg-amber-100 hover:bg-amber-200 text-amber-950 px-3 py-1.5 text-xs font-bold shadow-xs transition-colors flex items-center gap-1.5"
                >
                  {linkCopied ? '✅ คัดลอกลิงก์สำเร็จแล้ว' : '📋 คัดลอกลิงก์คำขอ'}
                </button>
                <span className="text-[10px] text-amber-800/80">
                  {copyFailed ? '⚠️ กรุณากดค้างที่กล่องข้อความเพื่อคัดลอก' : 'แตะหรือคัดลอกไปวางที่เบราว์เซอร์'}
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Feature Highlights */}
        <div className="my-6 grid gap-2.5 rounded-2xl bg-emerald-50/50 p-4 border border-emerald-100 text-sm text-slate-700 font-medium">
          <div className="flex items-center gap-2.5">
            <CheckCircle2 className="h-4 w-4 text-emerald-600 flex-shrink-0" />
            <span>ยื่นคำขอยืมสะดวกรวดเร็วใน 3 ขั้นตอน</span>
          </div>
          <div className="flex items-center gap-2.5">
            <CheckCircle2 className="h-4 w-4 text-emerald-600 flex-shrink-0" />
            <span>สแกน QR Code รับและส่งคืนอุปกรณ์ได้ทันที</span>
          </div>
          <div className="flex items-center gap-2.5">
            <CheckCircle2 className="h-4 w-4 text-emerald-600 flex-shrink-0" />
            <span>แจ้งเตือนสถานะการอนุมัติผ่านอีเมลแบบ Real-time</span>
          </div>
        </div>

        {/* Error / Unauthorized State */}
        {error && (
          <div className="mb-5">
            <Alert kind="error">
              <div className="space-y-1">
                <div className="font-bold text-sm">ไม่สามารถเข้าสู่ระบบได้</div>
                <div className="text-xs text-rose-800">{error}</div>
              </div>
            </Alert>
          </div>
        )}

        {/* Login Button Card */}
        <div className="space-y-4">
          <button
            type="button"
            onClick={signIn}
            disabled={loading || isInAppBrowser}
            className="btn-cta w-full py-3.5 text-base flex items-center justify-center gap-3 shadow-md"
            aria-label={`เข้าสู่ระบบด้วยบัญชี Google @${ALLOWED_DOMAIN}`}
          >
            {loading ? (
              <span className="inline-flex items-center gap-2">
                <span className="h-5 w-5 animate-spin rounded-full border-2 border-white border-t-transparent" />
                กำลังเชื่อมต่อบัญชี Google...
              </span>
            ) : (
              <>
                {/* Google Icon SVG */}
                <svg className="h-5 w-5 bg-white rounded-full p-0.5" viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    fill="#4285F4"
                    d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                  />
                  <path
                    fill="#34A853"
                    d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                  />
                  <path
                    fill="#FBBC05"
                    d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
                  />
                  <path
                    fill="#EA4335"
                    d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
                  />
                </svg>
                <span>{isInAppBrowser ? 'เปิดใน Chrome/Safari เพื่อเข้าสู่ระบบ' : `เข้าสู่ระบบด้วยบัญชี @${ALLOWED_DOMAIN}`}</span>
              </>
            )}
          </button>

          {/* Privacy & Safety Note */}
          <div className="flex items-center justify-center gap-1.5 text-xs text-slate-500 font-medium">
            <Lock className="h-3.5 w-3.5 text-slate-400" />
            <span>เข้าสู่ระบบอย่างปลอดภัยผ่าน Google OAuth โดยตรง</span>
          </div>
        </div>

        {/* Footer & Admin Contact */}
        <div className="mt-8 border-t border-slate-100 pt-5 text-center">
          <button
            type="button"
            onClick={() => setContactOpen(!contactOpen)}
            className="inline-flex items-center gap-1 text-xs font-bold text-emerald-800 hover:text-emerald-950 hover:underline transition"
          >
            <HelpCircle className="h-3.5 w-3.5" />
            พบปัญหาการเข้าสู่ระบบ หรือต้องการเพิ่มสิทธิ์?
          </button>

          {contactOpen && (
            <div className="mt-4 rounded-2xl bg-emerald-50/40 p-4 text-left text-xs text-slate-700 border border-emerald-100 space-y-2 animate-in fade-in duration-200">
              <div className="font-bold text-slate-900 flex items-center gap-1.5">
                <ShieldCheck className="h-4 w-4 text-emerald-700" /> ติดต่อผู้ดูแลระบบ:
              </div>
              <p className="leading-relaxed">
                งานพัสดุและอาคารสถานที่ สำนักบริการวิชาการ มหาวิทยาลัยขอนแก่น
              </p>
              <div className="flex flex-col sm:flex-row gap-2 pt-1 font-medium text-slate-700">
                <span className="flex items-center gap-1">
                  <Phone className="h-3.5 w-3.5 text-slate-500" /> โทร. 043-009700 ต่อ 42123
                </span>
                <span className="flex items-center gap-1">
                  <Mail className="h-3.5 w-3.5 text-slate-500" /> oas.kku@gmail.com
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
