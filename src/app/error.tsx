'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, RotateCcw, Home, Sparkles } from 'lucide-react';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [isChunkError, setIsChunkError] = useState(false);

  useEffect(() => {
    console.error('Unhandled Application Error:', error);
    const msg = (error?.message || '').toLowerCase();
    const isChunk =
      msg.includes('loading chunk') ||
      msg.includes('chunkloaderror') ||
      msg.includes('failed to fetch dynamically imported module');

    if (isChunk) {
      setIsChunkError(true);
      // Auto-reload once within 10 seconds to get fresh build bundles
      const lastReload = sessionStorage.getItem('kku_chunk_reload');
      const now = Date.now();
      if (!lastReload || now - parseInt(lastReload, 10) > 10000) {
        sessionStorage.setItem('kku_chunk_reload', String(now));
        window.location.reload();
      }
    }
  }, [error]);

  const handleHardReload = () => {
    sessionStorage.removeItem('kku_chunk_reload');
    window.location.reload();
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#F6FAF7] p-4">
      <div className="card max-w-lg w-full text-center space-y-5 p-8 shadow-xl border border-emerald-100">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-3xl bg-amber-50 text-amber-600 border border-amber-200">
          {isChunkError ? <Sparkles className="h-8 w-8" /> : <AlertTriangle className="h-8 w-8" aria-hidden="true" />}
        </div>
        <div className="space-y-2">
          <h2 className="font-heading text-xl font-black text-slate-900">
            {isChunkError ? 'ตรวจพบเวอร์ชันใหม่ของระบบ' : 'เกิดข้อผิดพลาดในการแสดงผล'}
          </h2>
          <p className="text-sm text-slate-600 font-medium leading-relaxed">
            {isChunkError
              ? 'ระบบเพิ่งได้รับการอัปเดตเวอร์ชันใหม่ กรุณากดปุ่มด้านล่างเพื่อโหลดเวอร์ชันล่าสุด'
              : error?.message || 'ระบบไม่สามารถประมวลผลคำขอได้ในขณะนี้ กรุณาลองใหม่อีกครั้ง'}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
          <button
            type="button"
            onClick={isChunkError ? handleHardReload : () => reset()}
            className="btn-primary flex items-center gap-2 text-sm"
          >
            <RotateCcw className="h-4 w-4" /> {isChunkError ? 'โหลดเวอร์ชันล่าสุด' : 'ลองใหม่อีกครั้ง'}
          </button>
          <Link
            href="/"
            className="btn-outline flex items-center gap-2 text-sm hover:border-emerald-400"
          >
            <Home className="h-4 w-4 text-emerald-700" /> กลับหน้าหลัก
          </Link>
        </div>
      </div>
    </div>
  );
}
