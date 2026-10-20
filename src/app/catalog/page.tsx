'use client';

import { Suspense, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { LoadingState } from '@/components/ui';

export default function CatalogRedirectPage() {
  return (
    <Suspense fallback={<LoadingState text="กำลังไปยังหน้ารายการอุปกรณ์..." />}>
      <CatalogRedirectContent />
    </Suspense>
  );
}

function CatalogRedirectContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const item = searchParams.get('item') || searchParams.get('eq') || searchParams.get('id') || '';

  useEffect(() => {
    if (item) {
      router.replace(`/borrow/?eq=${encodeURIComponent(item)}`);
    } else {
      router.replace('/equipment/');
    }
  }, [item, router]);

  return (
    <div className="flex min-h-dvh items-center justify-center bg-[#F6FAF7]">
      <LoadingState text="กำลังนำทางไปยังอุปกรณ์..." />
    </div>
  );
}
