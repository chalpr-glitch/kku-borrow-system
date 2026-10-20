'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import {
  getRedirectResult,
  onAuthStateChanged,
  signInWithPopup,
  signInWithRedirect,
  signOut as fbSignOut,
  type User,
} from 'firebase/auth';
import { doc, getDoc, setDoc, writeBatch, collection, serverTimestamp } from 'firebase/firestore';
import { ALLOWED_DOMAIN, fb, googleProvider } from './firebase';
import { SEED_DATA } from './seed-data';
import type { AppUser } from './types';
import { errMsg } from './utils';

export function checkIsInAppBrowser(): boolean {
  if (typeof window === 'undefined') return false;
  const ua = navigator.userAgent || navigator.vendor || (window as any).opera || '';
  return (
    /FBAN|FBAV|Instagram|Line\/|KAKAOTALK|Twitter|Snapchat|MicroMessenger|GSA\/|Gmail|Outlook|AlohaBrowser/i.test(
      ua
    ) || (/(iPhone|iPod|iPad).*AppleWebKit(?!.*Safari)/i.test(ua) && !/CriOS/i.test(ua))
  );
}

interface AuthState {
  firebaseUser: User | null;
  profile: AppUser | null;
  realProfile: AppUser | null;
  isImpersonating: boolean;
  loading: boolean;
  error: string | null;
  isInAppBrowser: boolean;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  switchUser: (email: string | null) => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

/** ทำการ Initialize บุคลากร 30 คน และ 13 สังกัด อัตโนมัติในครั้งแรก */
async function bootstrapInitialDataIfEmpty(targetEmail: string): Promise<AppUser | null> {
  const { db } = fb();
  const foundInSeed = SEED_DATA.users.find((u) => u.email.toLowerCase() === targetEmail.toLowerCase());
  if (!foundInSeed) return null;

  try {
    const batch = writeBatch(db);
    
    // นำเข้าบุคลากรทั้งหมด
    for (const u of SEED_DATA.users) {
      batch.set(doc(db, 'users', u.email.toLowerCase()), {
        ...u,
        updatedAt: serverTimestamp(),
      }, { merge: true });
    }

    // นำเข้าหน่วยงานทั้งหมด
    for (const d of SEED_DATA.departments) {
      batch.set(doc(db, 'departments', d.code), d, { merge: true });
    }

    // นำเข้าหมวดหมู่ครุภัณฑ์เริ่มต้น
    const defaultCats = [
      { id: 'CAT-COMPUTER', name: 'คอมพิวเตอร์และโน้ตบุ๊ก', isActive: true },
      { id: 'CAT-PROJECTOR', name: 'เครื่องฉายภาพและจอโปรเจกเตอร์', isActive: true },
      { id: 'CAT-CAMERA', name: 'กล้องถ่ายภาพและวิดีโอ', isActive: true },
      { id: 'CAT-AUDIO', name: 'อุปกรณ์ระบบเสียงและไมโครโฟน', isActive: true },
      { id: 'CAT-ACCESSORY', name: 'อุปกรณ์เสริมและสายสัญญาณ', isActive: true },
      { id: 'CAT-OTHER', name: 'ครุภัณฑ์อื่นๆ', isActive: true },
    ];
    for (const c of defaultCats) {
      batch.set(doc(db, 'categories', c.id), c, { merge: true });
    }

    // นำเข้าครุภัณฑ์ตัวอย่างเริ่มต้น
    const sampleEquipments = [
      {
        id: 'EQ-001',
        assetNumber: '7440-001-0001/67',
        name: 'โน้ตบุ๊ก Dell Latitude 5440',
        categoryId: 'CAT-COMPUTER',
        brand: 'Dell',
        model: 'Latitude 5440',
        serialNumber: 'DL5440-001',
        accessories: ['สายชาร์จแท้', 'กระเป๋าโน้ตบุ๊ก', 'เมาส์ไร้สาย'],
        location: 'ห้องเทคโนโลยีสารสนเทศ ชั้น 2',
        acquiredDate: '2024-03-15',
        price: 32500,
        status: 'AVAILABLE',
        isDeleted: false,
      },
      {
        id: 'EQ-002',
        assetNumber: '7440-001-0002/67',
        name: 'โน้ตบุ๊ก Lenovo ThinkPad E14',
        categoryId: 'CAT-COMPUTER',
        brand: 'Lenovo',
        model: 'ThinkPad E14 Gen 5',
        serialNumber: 'LNV-E14-002',
        accessories: ['สายชาร์จ USB-C', 'กระเป๋าเป้'],
        location: 'ห้องเทคโนโลยีสารสนเทศ ชั้น 2',
        acquiredDate: '2024-05-20',
        price: 29800,
        status: 'AVAILABLE',
        isDeleted: false,
      },
      {
        id: 'EQ-003',
        assetNumber: '6710-002-0005/66',
        name: 'โปรเจกเตอร์ Epson EB-FH52 Full HD',
        categoryId: 'CAT-PROJECTOR',
        brand: 'Epson',
        model: 'EB-FH52',
        serialNumber: 'EPS-FH52-110',
        accessories: ['สาย HDMI 5m', 'สายไฟ', 'รีโมทคอนโทรล', 'กระเป๋า'],
        location: 'ตู้เก็บอุปกรณ์โสตทัศนศึกษา ชั้น 1',
        acquiredDate: '2023-11-10',
        price: 28900,
        status: 'AVAILABLE',
        isDeleted: false,
      },
      {
        id: 'EQ-004',
        assetNumber: '6710-003-0012/66',
        name: 'กล้องดิจิทัล Sony Alpha 7 IV',
        categoryId: 'CAT-CAMERA',
        brand: 'Sony',
        model: 'ILCE-7M4',
        serialNumber: 'SNY-A74-998',
        accessories: ['เลนส์ 24-70mm', 'แบตเตอรี่ 2 ก้อน', 'แท่นชาร์จ', 'SD Card 128GB', 'กระเป๋ากล้อง'],
        location: 'ห้องเทคโนโลยีสารสนเทศ ชั้น 2',
        acquiredDate: '2023-08-01',
        price: 85000,
        status: 'AVAILABLE',
        isDeleted: false,
      },
      {
        id: 'EQ-005',
        assetNumber: '6710-004-0003/67',
        name: 'ชุดไมโครโฟนไร้สาย Saramonic Blink 500 Pro B2',
        categoryId: 'CAT-AUDIO',
        brand: 'Saramonic',
        model: 'Blink 500 Pro B2',
        serialNumber: 'SRM-B500-44',
        accessories: ['ไมค์ Lavalier 2 ตัว', 'กล่องชาร์จ', 'สายแปลง 3.5mm'],
        location: 'ห้องเทคโนโลยีสารสนเทศ ชั้น 2',
        acquiredDate: '2024-02-14',
        price: 9900,
        status: 'AVAILABLE',
        isDeleted: false,
      }
    ];

    for (const eq of sampleEquipments) {
      batch.set(doc(db, 'equipments', eq.id), {
        ...eq,
        createdBy: 'chalpr@kku.ac.th',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }, { merge: true });
    }

    await batch.commit();
  } catch (err) {
    console.warn('Bootstrap note:', err);
  }

  return {
    email: targetEmail.toLowerCase(),
    employeeCode: foundInSeed.employeeCode,
    departmentCode: foundInSeed.departmentCode,
    name: foundInSeed.name,
    position: foundInSeed.position,
    division: foundInSeed.division,
    mission: foundInSeed.mission,
    role: foundInSeed.role as AppUser['role'],
    title: foundInSeed.title,
    active: foundInSeed.active,
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [realProfile, setRealProfile] = useState<AppUser | null>(null);
  const [impersonatedProfile, setImpersonatedProfile] = useState<AppUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isInApp, setIsInApp] = useState(false);

  useEffect(() => {
    setIsInApp(checkIsInAppBrowser());

    const { auth, db } = fb();

    // Check redirect result on load
    getRedirectResult(auth).catch((err) => {
      console.warn('Redirect auth result warning:', err);
    });

    return onAuthStateChanged(auth, async (u) => {
      setLoading(true);
      if (!u) {
        setFirebaseUser(null);
        setRealProfile(null);
        setImpersonatedProfile(null);
        setLoading(false);
        return;
      }
      const email = (u.email ?? '').toLowerCase();
      try {
        if (!email.endsWith(`@${ALLOWED_DOMAIN}`)) {
          throw new Error(`ใช้ได้เฉพาะบัญชี @${ALLOWED_DOMAIN} เท่านั้น`);
        }
        
        const userRef = doc(db, 'users', email);
        let snap = await getDoc(userRef);

        let userData: AppUser | null = null;
        if (!snap.exists()) {
          userData = await bootstrapInitialDataIfEmpty(email);
          if (!userData) {
            throw new Error(`ไม่พบ ${email} ในทะเบียนบุคลากร สำนักบริการวิชาการ`);
          }
        } else {
          userData = { email, ...snap.data() } as AppUser;
        }

        if (!userData.active) {
          throw new Error('บัญชีนี้ถูกปิดการใช้งาน');
        }

        setFirebaseUser(u);
        setRealProfile(userData);

        // เช็กว่าเคยเลือกสลับบทบาทไว้ใน localStorage หรือไม่
        const savedImp = typeof window !== 'undefined' ? localStorage.getItem('kku_test_impersonate') : null;
        if (process.env.NEXT_PUBLIC_USE_EMULATOR === 'true' && savedImp && savedImp !== email) {
          const impUser = SEED_DATA.users.find((x) => x.email.toLowerCase() === savedImp.toLowerCase());
          if (impUser) {
            setImpersonatedProfile({
              email: impUser.email.toLowerCase(),
              employeeCode: impUser.employeeCode,
              departmentCode: impUser.departmentCode,
              name: impUser.name,
              position: impUser.position,
              division: impUser.division,
              mission: impUser.mission,
              role: impUser.role as AppUser['role'],
              title: impUser.title,
              active: impUser.active,
            });
          }
        }

        setError(null);
      } catch (e) {
        setError(errMsg(e));
        setFirebaseUser(null);
        setRealProfile(null);
        setImpersonatedProfile(null);
        await fbSignOut(auth);
      } finally {
        setLoading(false);
      }
    });
  }, []);

  const signIn = useCallback(async () => {
    setError(null);
    // LINE และเว็บวิวของแอปอื่นอาจถูก Google ปฏิเสธการยืนยันตัวตน
    if (checkIsInAppBrowser()) {
      setError('กรุณาเปิดลิงก์นี้ใน Chrome หรือ Safari แล้วเข้าสู่ระบบอีกครั้ง');
      return;
    }
    const { auth } = fb();
    const provider = googleProvider();

    // Check if mobile or popup blocked
    const isMobile = typeof window !== 'undefined' && /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

    if (isMobile) {
      try {
        await signInWithPopup(auth, provider);
      } catch (popupErr: any) {
        console.warn('Popup login failed, attempting redirect...', popupErr);
        try {
          await signInWithRedirect(auth, provider);
        } catch (redirectErr) {
          setError(errMsg(redirectErr));
        }
      }
    } else {
      try {
        await signInWithPopup(auth, provider);
      } catch (e: any) {
        const m = errMsg(e);
        if (e?.code === 'auth/popup-blocked' || e?.code === 'auth/cancelled-popup-request') {
          try {
            await signInWithRedirect(auth, provider);
            return;
          } catch (redErr) {
            setError(errMsg(redErr));
            return;
          }
        }
        if (!m.includes('popup-closed')) setError(m);
      }
    }
  }, []);

  const signOut = useCallback(async () => {
    localStorage.removeItem('kku_test_impersonate');
    await fbSignOut(fb().auth);
  }, []);

  // ฟังก์ชันสำหรับโหมดทดสอบ สลับบทบาทเป็นผู้ใช้อื่น
  const switchUser = useCallback(async (targetEmail: string | null) => {
    if (process.env.NEXT_PUBLIC_USE_EMULATOR !== 'true') {
      localStorage.removeItem('kku_test_impersonate');
      setImpersonatedProfile(null);
      return;
    }
    if (!targetEmail || (realProfile && targetEmail.toLowerCase() === realProfile.email.toLowerCase())) {
      localStorage.removeItem('kku_test_impersonate');
      setImpersonatedProfile(null);
      return;
    }

    const impUser = SEED_DATA.users.find((x) => x.email.toLowerCase() === targetEmail.toLowerCase());
    if (impUser) {
      localStorage.setItem('kku_test_impersonate', targetEmail.toLowerCase());
      setImpersonatedProfile({
        email: impUser.email.toLowerCase(),
        employeeCode: impUser.employeeCode,
        departmentCode: impUser.departmentCode,
        name: impUser.name,
        position: impUser.position,
        division: impUser.division,
        mission: impUser.mission,
        role: impUser.role as AppUser['role'],
        title: impUser.title,
        active: impUser.active,
      });
    }
  }, [realProfile]);

  const activeProfile = (process.env.NEXT_PUBLIC_USE_EMULATOR === 'true' && impersonatedProfile) || realProfile;
  const isImpersonating = process.env.NEXT_PUBLIC_USE_EMULATOR === 'true' && !!impersonatedProfile;

  return (
    <AuthContext.Provider
      value={{
        firebaseUser,
        profile: activeProfile,
        realProfile,
        isImpersonating,
        loading,
        error,
        isInAppBrowser: isInApp,
        signIn,
        signOut,
        switchUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
