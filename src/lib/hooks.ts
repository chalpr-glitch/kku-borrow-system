'use client';

import { useEffect, useState } from 'react';
import { collection, onSnapshot, query, where, type DocumentData, type Query } from 'firebase/firestore';
import { fb } from './firebase';
import type { BorrowRequest, Category, Equipment, AppUser, Department, RepairRequest } from './types';

/** Subscribe to a Firestore query in real time. */
export function useLiveQuery<T>(factory: () => Query<DocumentData> | null, deps: unknown[]) {
  const [data, setData] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const q = factory();
    if (!q) {
      setData([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    return onSnapshot(
      q,
      (s) => {
        setData(s.docs.map((d) => ({ ...d.data(), id: d.id }) as T));
        setLoading(false);
        setError(null);
      },
      (e) => {
        setError(e.message);
        setLoading(false);
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, loading, error };
}

/** คำขอทั้งหมด (ระบบขนาดเล็ก ~30 ผู้ใช้ ดึงทั้งหมดแล้วกรองฝั่ง client ได้) */
export function useAllRequests(enabled = true) {
  return useLiveQuery<BorrowRequest>(() => (enabled ? collection(fb().db, 'borrow_requests') : null), [enabled]);
}

export function useRequestsByStatus(statuses: string[]) {
  const key = statuses.join(',');
  return useLiveQuery<BorrowRequest>(
    () => query(collection(fb().db, 'borrow_requests'), where('status', 'in', statuses)),
    [key],
  );
}

export function useMyRequests(email?: string) {
  return useLiveQuery<BorrowRequest>(
    () => (email ? query(collection(fb().db, 'borrow_requests'), where('borrower.email', '==', email)) : null),
    [email],
  );
}

export function useEquipments() {
  return useLiveQuery<Equipment>(() => collection(fb().db, 'equipments'), []);
}

export function useCategories() {
  return useLiveQuery<Category>(() => collection(fb().db, 'categories'), []);
}

export function useDepartments() {
  return useLiveQuery<Department>(() => collection(fb().db, 'departments'), []);
}

export function useUsers() {
  return useLiveQuery<AppUser & { id: string }>(() => collection(fb().db, 'users'), []);
}

export function useRepairRequests() {
  return useLiveQuery<RepairRequest>(() => collection(fb().db, 'repair_requests'), []);
}

