'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  setDoc,
  updateDoc,
  deleteDoc,
  serverTimestamp,
  limit,
} from 'firebase/firestore';
import {
  Settings,
  Users,
  Building2,
  Tag,
  Shield,
  Sliders,
  History,
  Download,
  RotateCcw,
  Plus,
  Edit2,
  Trash2,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Search,
  Check,
  X,
  FileSpreadsheet,
  Lock,
  UserCheck,
  ShieldAlert,
  Sparkles,
  Mail,
  Send,
  Eye,
  Inbox,
  RefreshCw,
  ExternalLink,
  Copy,
  Zap,
} from 'lucide-react';
import AppShell from '@/components/AppShell';
import { Modal } from '@/components/ui';
import { fb, getFbFunctions } from '@/lib/firebase';
import { httpsCallable } from 'firebase/functions';
import { useAuth } from '@/lib/auth-context';
import { useCategories, useDepartments } from '@/lib/hooks';
import { sendTestEmailNotification, retryEmailJob, batchProcessPendingQueue, evaluateDailyReminders } from '@/lib/notifications';
import { SEED_DATA } from '@/lib/seed-data';
import type { AppUser, Category, Department, Role } from '@/lib/types';
import { ROLE_LABEL, fmtTs } from '@/lib/utils';

export default function SettingsPage() {
  return (
    <AppShell
      title="ตั้งค่าและบริหารจัดการระบบ"
      roles={['CUSTODIAN', 'APPROVER', 'EXECUTIVE']}
    >
      <Suspense fallback={<div className="p-8 text-center text-slate-500">กำลังโหลด...</div>}>
        <SettingsContent />
      </Suspense>
    </AppShell>
  );
}

type TabType =
  | 'users'
  | 'categories'
  | 'departments'
  | 'policy'
  | 'notifications'
  | 'audit'
  | 'backup';

function SettingsContent() {
  const searchParams = useSearchParams();
  const initialTab = (searchParams.get('tab') as TabType) || 'users';
  const [activeTab, setActiveTab] = useState<TabType>(initialTab);
  const { profile } = useAuth();

  // Floating Toast Notification State
  const [toast, setToast] = useState<{ type: 'success' | 'error' | 'info'; message: string } | null>(null);

  const showToast = (type: 'success' | 'error' | 'info', message: string) => {
    setToast({ type, message });
    setTimeout(() => {
      setToast((cur) => (cur?.message === message ? null : cur));
    }, 4500);
  };

  // 1. Users State
  const [users, setUsers] = useState<AppUser[]>([]);
  const [userSearch, setUserSearch] = useState('');
  const [userRoleFilter, setUserRoleFilter] = useState<string>('ALL');
  const [selectedUser, setSelectedUser] = useState<AppUser | null>(null);
  const [userModalOpen, setUserModalOpen] = useState(false);
  const [userForm, setUserForm] = useState<Partial<AppUser>>({});
  const [userSaving, setUserSaving] = useState(false);

  // 2. Categories State
  const { data: categories } = useCategories();
  const [catModalOpen, setCatModalOpen] = useState(false);
  const [catForm, setCatForm] = useState<{ id: string; name: string; isNew: boolean }>({
    id: '',
    name: '',
    isNew: false,
  });
  const [catSaving, setCatSaving] = useState(false);

  // 3. Departments State
  const { data: departments } = useDepartments();
  const [deptModalOpen, setDeptModalOpen] = useState(false);
  const [deptForm, setDeptForm] = useState<{ id: string; code: string; name: string; isNew: boolean }>({
    id: '',
    code: '',
    name: '',
    isNew: false,
  });
  const [deptSaving, setDeptSaving] = useState(false);

  // 4. Policy State
  const [policyForm, setPolicyForm] = useState({
    maxBorrowDays: 15,
    advanceReminderDays: 2,
    enableTwoStepApproval: true,
    enableTestMode: true,
    enableEmailNotifications: true,
    custodianEmail: 'chalpr@kku.ac.th',
    approverEmail: 'praysu@kku.ac.th',
    emailProvider: 'NONE' as 'NONE' | 'GOOGLE_APPS_SCRIPT' | 'BREVO' | 'RESEND',
    gasWebhookUrl: '',
    gasSecretToken: '',
    gasSenderName: 'ระบบยืม-คืน ครุภัณฑ์ สำนักบริการวิชาการ มข.',
    gasSenderEmail: '',
    brevoApiKey: '',
    brevoSenderEmail: 'noreply.oas@kku.ac.th',
    brevoSenderName: 'ระบบยืม-คืน ครุภัณฑ์ สำนักบริการวิชาการ มข.',
    resendApiKey: '',
    resendSender: 'ระบบยืม-คืน ครุภัณฑ์ <onboarding@resend.dev>',
    guidelines:
      '1. การยืมครุภัณฑ์ต้องได้รับความเห็นชอบจากผู้ดูแลพัสดุและผู้อนุมัติ\n2. ระยะเวลาการยืมไม่เกิน 15 วันทำการต่อครั้ง\n3. ผู้ยืมต้องดูแลรักษาครุภัณฑ์ให้อยู่ในสภาพสมบูรณ์และส่งคืนตรงตามเวลาที่กำหนด',
  });
  const [policySaving, setPolicySaving] = useState(false);
  const [policySavedMsg, setPolicySavedMsg] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [gatewayStatus, setGatewayStatus] = useState<{
    configured?: boolean;
    provider?: string;
    hasGasWebhookUrl?: boolean;
    hasGasSecretToken?: boolean;
    gasSenderName?: string;
    gasSenderEmail?: string;
    hasBrevoApiKey?: boolean;
    brevoSenderEmail?: string;
    brevoSenderName?: string;
    hasResendApiKey?: boolean;
    resendSender?: string;
    updatedAt?: string | null;
    updatedBy?: string | null;
  }>({});

  // 5. Notifications / Mail Jobs State
  const [mailJobs, setMailJobs] = useState<any[]>([]);
  const [mailLoading, setMailLoading] = useState(false);
  const [mailFilterStatus, setMailFilterStatus] = useState<string>('ALL');
  const [mailFilterType, setMailFilterType] = useState<string>('ALL');
  const [mailSearch, setMailSearch] = useState('');
  const [batchProcessing, setBatchProcessing] = useState(false);
  const [schedulerRunning, setSchedulerRunning] = useState(false);
  const [batchResultMsg, setBatchResultMsg] = useState('');
  const [testEmailTarget, setTestEmailTarget] = useState(profile?.email || 'chalpr@kku.ac.th');
  const [testSending, setTestSending] = useState(false);
  const [testSentMsg, setTestSentMsg] = useState('');
  const [previewMail, setPreviewMail] = useState<any | null>(null);
  const [retryingJobId, setRetryingJobId] = useState<string | null>(null);
  const [showGasGuide, setShowGasGuide] = useState(false);
  const [gasCopied, setGasCopied] = useState(false);

  // 6. Audit Logs State
  const [auditLogs, setAuditLogs] = useState<any[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);

  // 7. Backup / Reset State
  const [exporting, setExporting] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetMsg, setResetMsg] = useState('');

  // Fetch Gateway Status via Secure Cloud Function with Spark Free Tier Policy Fallback
  const fetchGatewayStatus = async () => {
    try {
      const fn = getFbFunctions();
      const getStatus = httpsCallable<void, any>(fn, 'getGatewayConfigStatus');
      const res = await getStatus();
      if (res.data) {
        setGatewayStatus(res.data);
        if (res.data.provider && res.data.provider !== 'NONE') {
          setPolicyForm((prev) => ({
            ...prev,
            emailProvider:
              prev.emailProvider && prev.emailProvider !== 'NONE'
                ? prev.emailProvider
                : res.data.provider,
            gasSenderName: prev.gasSenderName || res.data.gasSenderName || 'ระบบยืม-คืน ครุภัณฑ์ สำนักบริการวิชาการ มข.',
            gasSenderEmail: prev.gasSenderEmail || res.data.gasSenderEmail || '',
            brevoSenderEmail: prev.brevoSenderEmail || res.data.brevoSenderEmail || 'noreply.oas@kku.ac.th',
            brevoSenderName: prev.brevoSenderName || res.data.brevoSenderName || 'ระบบยืม-คืน ครุภัณฑ์ สำนักบริการวิชาการ มข.',
            resendSender: prev.resendSender || res.data.resendSender || 'ระบบยืม-คืน ครุภัณฑ์ <onboarding@resend.dev>',
          }));
        }
        return;
      }
    } catch {
      // Cloud Functions not deployed (Spark Plan) -> fallback to reading policy document
    }

    try {
      const { db } = fb();
      const snap = await getDoc(doc(db, 'system_settings', 'policy'));
      if (snap.exists()) {
        const d = snap.data();
        setGatewayStatus({
          configured: Boolean(d.gasWebhookUrl || d.brevoApiKey || d.resendApiKey),
          provider: d.emailProvider || 'NONE',
          hasGasWebhookUrl: Boolean(d.gasWebhookUrl),
          hasGasSecretToken: Boolean(d.gasSecretToken),
          gasSenderName: d.gasSenderName || '',
          gasSenderEmail: d.gasSenderEmail || '',
          hasBrevoApiKey: Boolean(d.brevoApiKey),
          brevoSenderEmail: d.brevoSenderEmail || '',
          brevoSenderName: d.brevoSenderName || '',
          hasResendApiKey: Boolean(d.resendApiKey),
          resendSender: d.resendSender || '',
          updatedAt: d.updatedAt ? (d.updatedAt.toDate ? d.updatedAt.toDate().toISOString() : d.updatedAt) : null,
          updatedBy: d.updatedBy || null,
        });
        if (d.emailProvider && d.emailProvider !== 'NONE') {
          setPolicyForm((prev) => ({
            ...prev,
            emailProvider: d.emailProvider,
            gasSenderName: prev.gasSenderName || d.gasSenderName || 'ระบบยืม-คืน ครุภัณฑ์ สำนักบริการวิชาการ มข.',
            gasSenderEmail: prev.gasSenderEmail || d.gasSenderEmail || '',
            brevoSenderEmail: prev.brevoSenderEmail || d.brevoSenderEmail || 'noreply.oas@kku.ac.th',
            brevoSenderName: prev.brevoSenderName || d.brevoSenderName || 'ระบบยืม-คืน ครุภัณฑ์ สำนักบริการวิชาการ มข.',
            resendSender: prev.resendSender || d.resendSender || 'ระบบยืม-คืน ครุภัณฑ์ <onboarding@resend.dev>',
          }));
        }
      }
    } catch (err) {
      console.warn('Could not fetch gateway status from policy:', err);
    }
  };

  // Load Users from Firestore (or fallback to SEED_DATA)
  useEffect(() => {
    const { db } = fb();
    const unsub = onSnapshot(collection(db, 'users'), (snap) => {
      if (!snap.empty) {
        const list: AppUser[] = [];
        snap.forEach((d) => list.push(d.data() as AppUser));
        setUsers(list);
      } else {
        setUsers(SEED_DATA.users as unknown as AppUser[]);
      }
    });
    return () => unsub();
  }, []);

  // Load System Policy (Strictly non-secret general policy)
  useEffect(() => {
    const { db } = fb();
    const unsubPolicy = onSnapshot(doc(db, 'system_settings', 'policy'), (snap) => {
      if (snap.exists()) {
        const data = snap.data();
        setPolicyForm((prev) => ({
          ...prev,
          enableTestMode: typeof data.enableTestMode === 'boolean' ? data.enableTestMode : prev.enableTestMode,
          enableEmailNotifications: typeof data.enableEmailNotifications === 'boolean' ? data.enableEmailNotifications : prev.enableEmailNotifications,
          maxBorrowDays: data.maxBorrowDays ?? prev.maxBorrowDays,
          advanceReminderDays: data.advanceReminderDays ?? prev.advanceReminderDays,
          enableTwoStepApproval: data.enableTwoStepApproval ?? prev.enableTwoStepApproval,
          guidelines: data.guidelines ?? prev.guidelines,
          emailProvider:
            prev.emailProvider && prev.emailProvider !== 'NONE'
              ? prev.emailProvider
              : data.emailProvider || prev.emailProvider,
          custodianEmail: data.custodianEmail || prev.custodianEmail,
          approverEmail: data.approverEmail || prev.approverEmail,
        }));
      }
    });

    fetchGatewayStatus();

    return () => {
      unsubPolicy();
    };
  }, []);

  // Load Mail Jobs when notifications tab active
  useEffect(() => {
    if (activeTab === 'notifications') {
      setMailLoading(true);
      const { db } = fb();
      const q = query(collection(db, 'mail'), orderBy('createdAt', 'desc'), limit(50));
      const unsub = onSnapshot(
        q,
        (snap) => {
          const list: any[] = [];
          snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
          setMailJobs(list);
          setMailLoading(false);
        },
        () => {
          setMailLoading(false);
        }
      );
      return () => unsub();
    }
  }, [activeTab]);

  // Load Audit Logs when tab active
  useEffect(() => {
    if (activeTab === 'audit') {
      setAuditLoading(true);
      const { db } = fb();
      const q = query(collection(db, 'audit_logs'), orderBy('timestamp', 'desc'), limit(50));
      const unsub = onSnapshot(
        q,
        (snap) => {
          const list: any[] = [];
          snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
          setAuditLogs(list);
          setAuditLoading(false);
        },
        () => {
          setAuditLoading(false);
        }
      );
      return () => unsub();
    }
  }, [activeTab]);

  // Filtered Users
  const filteredUsers = useMemo(() => {
    return users.filter((u) => {
      const matchText =
        !userSearch ||
        u.name.toLowerCase().includes(userSearch.toLowerCase()) ||
        u.email.toLowerCase().includes(userSearch.toLowerCase()) ||
        u.employeeCode.toLowerCase().includes(userSearch.toLowerCase()) ||
        u.position.toLowerCase().includes(userSearch.toLowerCase()) ||
        u.mission.toLowerCase().includes(userSearch.toLowerCase());
      const matchRole = userRoleFilter === 'ALL' || u.role === userRoleFilter;
      return matchText && matchRole;
    });
  }, [users, userSearch, userRoleFilter]);

  // Save User (Edit Role/Details)
  const handleSaveUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!userForm.email || !userForm.name) return;
    setUserSaving(true);
    try {
      const { db } = fb();
      const email = userForm.email.toLowerCase().trim();
      const payload: AppUser = {
        email,
        employeeCode: userForm.employeeCode || 'OAS00',
        departmentCode: userForm.departmentCode || '01',
        name: userForm.name,
        position: userForm.position || 'บุคลากร',
        division: userForm.division || 'กองบริหารงานสำนัก',
        mission: userForm.mission || 'สำนักบริการวิชาการ',
        role: (userForm.role as Role) || 'USER',
        title: userForm.title || '',
        active: userForm.active ?? true,
      };
      await setDoc(doc(db, 'users', email), payload, { merge: true });
      showToast('success', `บันทึกข้อมูล ${payload.name} สำเร็จ`);
      setUserModalOpen(false);
    } catch (err: any) {
      showToast('error', 'เกิดข้อผิดพลาด: ' + err.message);
    } finally {
      setUserSaving(false);
    }
  };

  // Quick Role Change
  const handleQuickRoleChange = async (user: AppUser, newRole: Role) => {
    try {
      const { db } = fb();
      await updateDoc(doc(db, 'users', user.email.toLowerCase()), {
        role: newRole,
      });
      showToast('success', `เปลี่ยนสิทธิ์ของ ${user.name} เป็น ${ROLE_LABEL[newRole]} สำเร็จ`);
    } catch (err: any) {
      showToast('error', 'ไม่สามารถเปลี่ยนสิทธิ์ได้: ' + err.message);
    }
  };

  // Save Category
  const handleSaveCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!catForm.name.trim()) return;
    setCatSaving(true);
    try {
      const { db } = fb();
      const catId = catForm.isNew
        ? catForm.name.trim().toLowerCase().replace(/\s+/g, '_')
        : catForm.id;
      await setDoc(
        doc(db, 'categories', catId),
        {
          id: catId,
          name: catForm.name.trim(),
          isActive: true,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
      showToast('success', `บันทึกหมวดหมู่ "${catForm.name}" สำเร็จ`);
      setCatModalOpen(false);
    } catch (err: any) {
      showToast('error', 'เกิดข้อผิดพลาด: ' + err.message);
    } finally {
      setCatSaving(false);
    }
  };

  // Delete Category
  const handleDeleteCategory = async (cat: Category) => {
    if (!confirm(`ต้องการลบหมวดหมู่ "${cat.name}" หรือไม่?`)) return;
    try {
      const { db } = fb();
      await deleteDoc(doc(db, 'categories', cat.id));
      showToast('success', `ลบหมวดหมู่ "${cat.name}" สำเร็จ`);
    } catch (err: any) {
      showToast('error', 'ไม่สามารถลบได้: ' + err.message);
    }
  };

  // Save Department
  const handleSaveDept = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!deptForm.name.trim() || !deptForm.code.trim()) return;
    setDeptSaving(true);
    try {
      const { db } = fb();
      const deptId = deptForm.code.trim();
      await setDoc(
        doc(db, 'departments', deptId),
        {
          id: deptId,
          code: deptForm.code.trim(),
          name: deptForm.name.trim(),
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
      showToast('success', `บันทึกกลุ่มงาน "${deptForm.name}" สำเร็จ`);
      setDeptModalOpen(false);
    } catch (err: any) {
      showToast('error', 'เกิดข้อผิดพลาด: ' + err.message);
    } finally {
      setDeptSaving(false);
    }
  };

  // Delete Department
  const handleDeleteDept = async (dept: Department) => {
    if (!confirm(`ต้องการลบกลุ่มงาน "${dept.name}" หรือไม่?`)) return;
    try {
      const { db } = fb();
      await deleteDoc(doc(db, 'departments', dept.id));
      showToast('success', `ลบกลุ่มงาน "${dept.name}" สำเร็จ`);
    } catch (err: any) {
      showToast('error', 'ไม่สามารถลบได้: ' + err.message);
    }
  };

  // Save System Policy & Email Settings
  const handleSavePolicy = async (e: React.FormEvent) => {
    e.preventDefault();
    setPolicySaving(true);
    setPolicySavedMsg(false);
    setFormError(null);

    // Validation: Email fields
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const custodianEmailClean = policyForm.custodianEmail.trim();
    if (!custodianEmailClean || !emailRegex.test(custodianEmailClean)) {
      setFormError('กรุณากรอกอีเมลผู้ดูแลพัสดุ (CUSTODIAN) ให้ถูกต้อง เช่น chalpr@kku.ac.th');
      setPolicySaving(false);
      return;
    }

    const approverEmailClean = policyForm.approverEmail.trim();
    if (!approverEmailClean || !emailRegex.test(approverEmailClean)) {
      setFormError('กรุณากรอกอีเมลผู้อนุมัติ (APPROVER) ให้ถูกต้อง เช่น praysu@kku.ac.th');
      setPolicySaving(false);
      return;
    }

    // Validation: Provider specific
    if (policyForm.emailProvider === 'GOOGLE_APPS_SCRIPT') {
      const url = policyForm.gasWebhookUrl.trim();
      if (!gatewayStatus.hasGasWebhookUrl && !url) {
        setFormError('กรุณากรอก Google Apps Script Web App URL');
        setPolicySaving(false);
        return;
      }
      if (url && (!url.startsWith('https://script.google.com/') || !url.includes('/macros/s/'))) {
        setFormError('Google Apps Script Web App URL ต้องขึ้นต้นด้วย https://script.google.com/macros/s/...');
        setPolicySaving(false);
        return;
      }
    } else if (policyForm.emailProvider === 'BREVO') {
      if (!gatewayStatus.hasBrevoApiKey && !policyForm.brevoApiKey.trim()) {
        setFormError('กรุณากรอก Brevo API Key');
        setPolicySaving(false);
        return;
      }
    } else if (policyForm.emailProvider === 'RESEND') {
      if (!gatewayStatus.hasResendApiKey && !policyForm.resendApiKey.trim()) {
        setFormError('กรุณากรอก Resend API Key');
        setPolicySaving(false);
        return;
      }
    }

    try {
      const { db } = fb();
      const fn = getFbFunctions();

      // 1. General policy & Gateway configuration (saved directly in system_settings/policy for Spark Free Tier)
      const policyData: Record<string, any> = {
        enableTestMode: policyForm.enableTestMode,
        enableEmailNotifications: policyForm.enableEmailNotifications,
        maxBorrowDays: policyForm.maxBorrowDays,
        advanceReminderDays: policyForm.advanceReminderDays,
        enableTwoStepApproval: policyForm.enableTwoStepApproval,
        guidelines: policyForm.guidelines,
        emailProvider: policyForm.emailProvider,
        custodianEmail: custodianEmailClean,
        approverEmail: approverEmailClean,
        updatedBy: profile?.email || 'admin',
        updatedAt: serverTimestamp(),
      };

      if (policyForm.gasWebhookUrl && policyForm.gasWebhookUrl.trim()) {
        policyData.gasWebhookUrl = policyForm.gasWebhookUrl.trim();
      }
      if (policyForm.gasSecretToken && policyForm.gasSecretToken.trim()) {
        policyData.gasSecretToken = policyForm.gasSecretToken.trim();
      }
      if (policyForm.gasSenderName !== undefined && policyForm.gasSenderName.trim()) {
        policyData.gasSenderName = policyForm.gasSenderName.trim();
      }
      if (policyForm.gasSenderEmail !== undefined && policyForm.gasSenderEmail.trim()) {
        policyData.gasSenderEmail = policyForm.gasSenderEmail.trim();
      }
      if (policyForm.brevoApiKey && policyForm.brevoApiKey.trim()) {
        policyData.brevoApiKey = policyForm.brevoApiKey.trim();
      }
      if (policyForm.brevoSenderEmail !== undefined && policyForm.brevoSenderEmail.trim()) {
        policyData.brevoSenderEmail = policyForm.brevoSenderEmail.trim();
      }
      if (policyForm.brevoSenderName !== undefined && policyForm.brevoSenderName.trim()) {
        policyData.brevoSenderName = policyForm.brevoSenderName.trim();
      }
      if (policyForm.resendApiKey && policyForm.resendApiKey.trim()) {
        policyData.resendApiKey = policyForm.resendApiKey.trim();
      }
      if (policyForm.resendSender !== undefined && policyForm.resendSender.trim()) {
        policyData.resendSender = policyForm.resendSender.trim();
      }

      await setDoc(doc(db, 'system_settings', 'policy'), policyData, { merge: true });

      // 2. Secret & Gateway Configuration sync (Optional Cloud Functions sync if deployed)
      try {
        const updateGateway = httpsCallable<any, { success: boolean }>(fn, 'updateGatewayConfig');
        const gatewayPayload: Record<string, string> = {
          provider: policyForm.emailProvider,
        };
        if (policyForm.gasWebhookUrl && policyForm.gasWebhookUrl.trim()) gatewayPayload.gasWebhookUrl = policyForm.gasWebhookUrl.trim();
        if (policyForm.gasSecretToken && policyForm.gasSecretToken.trim()) gatewayPayload.gasSecretToken = policyForm.gasSecretToken.trim();
        if (policyForm.gasSenderName && policyForm.gasSenderName.trim()) gatewayPayload.gasSenderName = policyForm.gasSenderName.trim();
        if (policyForm.gasSenderEmail && policyForm.gasSenderEmail.trim()) gatewayPayload.gasSenderEmail = policyForm.gasSenderEmail.trim();
        if (policyForm.brevoApiKey && policyForm.brevoApiKey.trim()) gatewayPayload.brevoApiKey = policyForm.brevoApiKey.trim();
        if (policyForm.brevoSenderEmail && policyForm.brevoSenderEmail.trim()) gatewayPayload.brevoSenderEmail = policyForm.brevoSenderEmail.trim();
        if (policyForm.brevoSenderName && policyForm.brevoSenderName.trim()) gatewayPayload.brevoSenderName = policyForm.brevoSenderName.trim();
        if (policyForm.resendApiKey && policyForm.resendApiKey.trim()) gatewayPayload.resendApiKey = policyForm.resendApiKey.trim();
        if (policyForm.resendSender && policyForm.resendSender.trim()) gatewayPayload.resendSender = policyForm.resendSender.trim();

        const sanitizedPayload: Record<string, string> = {};
        for (const [k, v] of Object.entries(gatewayPayload)) {
          if (v !== undefined && v !== null && typeof v === 'string') {
            sanitizedPayload[k] = v;
          }
        }
        await updateGateway(sanitizedPayload);
      } catch (fnErr: any) {
        console.info('Cloud Functions sync optional notice (Spark Free Tier direct policy storage used):', fnErr?.message || fnErr);
      }

      await fetchGatewayStatus();

      // Clear plain secrets from browser state
      setPolicyForm((prev) => ({
        ...prev,
        gasWebhookUrl: '',
        gasSecretToken: '',
        brevoApiKey: '',
        resendApiKey: '',
      }));

      setPolicySavedMsg(true);
      showToast('success', 'บันทึกนโยบายระบบและการตั้งค่า Gateway สำเร็จ');
      setTimeout(() => setPolicySavedMsg(false), 3000);
    } catch (err: any) {
      console.error('Error saving policy/gateway settings:', err);
      let friendlyMsg = 'เกิดข้อผิดพลาดในการบันทึกข้อมูล กรุณาลองใหม่อีกครั้ง';
      const errorCode = err?.code || '';
      const rawMsg = err?.message || '';

      if (errorCode === 'functions/permission-denied' || rawMsg.includes('permission-denied') || rawMsg.includes('ไม่มีสิทธิ์')) {
        friendlyMsg = 'คุณไม่มีสิทธิ์ในการบันทึกการตั้งค่า Gateway (จำกัดเฉพาะสิทธิ์ CUSTODIAN หรือ EXECUTIVE เท่านั้น)';
      } else if (errorCode === 'functions/unauthenticated' || rawMsg.includes('unauthenticated') || rawMsg.includes('เข้าสู่ระบบ')) {
        friendlyMsg = 'กรุณาเข้าสู่ระบบด้วยบัญชีกูเกิลของมหาวิทยาลัย (@kku.ac.th) ก่อนทำรายการ';
      } else if (errorCode === 'functions/invalid-argument' || rawMsg.includes('invalid-argument')) {
        friendlyMsg = 'ข้อมูลการตั้งค่า Gateway ไม่ถูกต้อง: ' + rawMsg.replace(/^functions\/[a-z-]+:\s*/i, '');
      } else if (errorCode === 'functions/internal' || rawMsg === 'internal' || rawMsg === 'INTERNAL') {
        friendlyMsg = 'เซิร์ฟเวอร์ Cloud Functions ขัดข้องภายใน กรุณาตรวจสอบการตั้งค่า Firebase Functions หรือสิทธิ์การเข้าถึง';
      } else if (rawMsg) {
        friendlyMsg = rawMsg.replace(/^functions\/[a-z-]+:\s*/i, '').replace(/^[A-Za-z]+Error:\s*/i, '');
      }

      setFormError(friendlyMsg);
      showToast('error', friendlyMsg);
    } finally {
      setPolicySaving(false);
    }
  };

  // Send Test Email
  const handleSendTestEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanTarget = testEmailTarget.trim();
    if (!cleanTarget || !cleanTarget.includes('@')) {
      showToast('error', 'กรุณากรอกอีเมลผู้รับทดสอบให้ถูกต้อง เช่น praysu@kku.ac.th');
      return;
    }
    setTestSending(true);
    setTestSentMsg('');
    try {
      const mailId = await sendTestEmailNotification(cleanTarget, profile?.name || 'ผู้ดูแลระบบ');
      if (mailId) {
        setTestSentMsg(`✅ ส่งคำสั่งสร้างคิว Email สำเร็จ (Job ID: ${mailId})`);
        showToast('success', `ส่งคำสั่งสร้างคิว Email สำเร็จ (Job ID: ${mailId})`);
      } else {
        setTestSentMsg('⚠️ ระบบบันทึกคิว Email ปิดอยู่ หรือไม่สามารถส่งได้');
        showToast('info', 'ระบบบันทึกคิว Email ปิดอยู่ หรือไม่สามารถส่งได้');
      }
    } catch (err: any) {
      showToast('error', 'เกิดข้อผิดพลาด: ' + err.message);
    } finally {
      setTestSending(false);
    }
  };

  // Run Batch Processor for Pending/Failed Jobs
  const handleRunBatchQueue = async () => {
    setBatchProcessing(true);
    setBatchResultMsg('');
    try {
      const res = await batchProcessPendingQueue(30);
      const msg = `ประมวลผลคิวเรียบร้อย: สำเร็จ ${res.success} รายการ, ล้มเหลว ${res.failed} รายการ, ข้าม ${res.skipped} รายการ (รวม ${res.processed} งาน)`;
      setBatchResultMsg(`✅ ${msg}`);
      showToast('success', msg);
      setTimeout(() => setBatchResultMsg(''), 8000);
    } catch (err: any) {
      showToast('error', 'เกิดข้อผิดพลาดในการประมวลผลคิว: ' + err.message);
    } finally {
      setBatchProcessing(false);
    }
  };

  // Run Daily Reminders Evaluator
  const handleRunDailyReminders = async () => {
    setSchedulerRunning(true);
    setBatchResultMsg('');
    try {
      const res = await evaluateDailyReminders();
      const msg = `ตรวจสอบคำขอที่กำลังใช้งาน ${res.checked} รายการ: สร้างการแจ้งเตือนใหม่ ${res.remindersQueued} รายการ`;
      setBatchResultMsg(`✅ ${msg}`);
      showToast('success', msg);
      setTimeout(() => setBatchResultMsg(''), 8000);
    } catch (err: any) {
      showToast('error', 'เกิดข้อผิดพลาดในการประเมินการแจ้งเตือน: ' + err.message);
    } finally {
      setSchedulerRunning(false);
    }
  };

  // Retry sending an email from mail queue
  const handleRetryEmail = async (job: any) => {
    if (!job?.id) return;
    setRetryingJobId(job.id);
    try {
      const res = await retryEmailJob(job.id, job);
      if (res.success) {
        showToast('success', res.message || 'ส่งอีเมลซ้ำ (Retry) สำเร็จเรียบร้อยแล้ว');
      } else {
        showToast('error', 'ไม่สามารถส่งซ้ำได้: ' + (res.message || 'โปรดตรวจสอบสถานะของคิว'));
      }
    } catch (err: any) {
      showToast('error', 'เกิดข้อผิดพลาด: ' + err.message);
    } finally {
      setRetryingJobId(null);
    }
  };

  // Filtered Mail Jobs
  const filteredMailJobs = useMemo(() => {
    return mailJobs.filter((job) => {
      const toStr = (job.to || []).join(' ').toLowerCase();
      const subject = (job.message?.subject || '').toLowerCase();
      const reqId = (job.requestId || '').toLowerCase();
      const idKey = (job.idempotencyKey || '').toLowerCase();
      const search = mailSearch.toLowerCase().trim();

      const matchSearch =
        !search ||
        toStr.includes(search) ||
        subject.includes(search) ||
        reqId.includes(search) ||
        idKey.includes(search);

      const matchStatus =
        mailFilterStatus === 'ALL' ||
        (mailFilterStatus === 'SUCCESS' && job.status === 'SUCCESS') ||
        (mailFilterStatus === 'PENDING' && (job.status === 'PENDING' || !job.status)) ||
        (mailFilterStatus === 'PROCESSING' && job.status === 'PROCESSING') ||
        ((mailFilterStatus === 'FAILED' || mailFilterStatus === 'ERROR') && (job.status === 'FAILED' || job.status === 'ERROR')) ||
        (mailFilterStatus === 'RECONCILIATION_REQUIRED' && (job.status === 'RECONCILIATION_REQUIRED' || job.requiresReconciliation)) ||
        (mailFilterStatus === 'SKIPPED' && job.status === 'SKIPPED');

      const matchType = mailFilterType === 'ALL' || job.type === mailFilterType;

      return matchSearch && matchStatus && matchType;
    });
  }, [mailJobs, mailSearch, mailFilterStatus, mailFilterType]);

  const gasScriptCode = `/**
 * Google Apps Script Webhook Gateway สำหรับระบบยืม-คืน ครุภัณฑ์ สำนักบริการวิชาการ มข.
 * บัญชีที่ Deploy: @kku.ac.th
 */

// โทเค็นความปลอดภัย (Shared Secret Token) กำหนดให้ตรงกับในระบบ (หากไม่ต้องการตรวจสอบให้ปล่อยว่าง '')
var EXPECTED_TOKEN = "${policyForm.gasSecretToken || ''}";

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return ContentService.createTextOutput(JSON.stringify({ status: 'ERROR', message: 'No post data' }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    var data = JSON.parse(e.postData.contents);

    // ตรวจสอบความปลอดภัยด้วย Secret Token (หากกำหนดไว้)
    if (EXPECTED_TOKEN && EXPECTED_TOKEN !== '' && data.secretToken !== EXPECTED_TOKEN) {
      return ContentService.createTextOutput(JSON.stringify({ 
        status: 'ERROR', 
        message: 'Unauthorized: Invalid secret token' 
      })).setMimeType(ContentService.MimeType.JSON);
    }

    var toList = Array.isArray(data.to) ? data.to.join(',') : (data.to || '');
    var ccList = Array.isArray(data.cc) ? data.cc.join(',') : (data.cc || '');
    var subject = data.subject || (data.message && data.message.subject) || 'แจ้งเตือนระบบยืม-คืน ครุภัณฑ์ สำนักบริการวิชาการ มข.';
    var htmlBody = data.html || (data.message && data.message.html) || data.text || '';
    var textBody = data.text || (data.message && data.message.text) || '';
    var senderName = data.senderName || 'ระบบยืม-คืน ครุภัณฑ์ สำนักบริการวิชาการ มข.';

    if (!toList) {
      return ContentService.createTextOutput(JSON.stringify({ status: 'ERROR', message: 'Missing recipient email' }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    var mailOptions = {
      to: toList,
      subject: subject,
      htmlBody: htmlBody,
      body: textBody,
      name: senderName
    };

    if (ccList) {
      mailOptions.cc = ccList;
    }
    if (data.senderEmail) {
      mailOptions.replyTo = data.senderEmail;
    }

    MailApp.sendEmail(mailOptions);

    return ContentService.createTextOutput(JSON.stringify({ 
      status: 'SUCCESS',
      messageId: 'gas_' + new Date().getTime(),
      timestamp: new Date().toISOString(),
      recipient: toList
    })).setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ 
      status: 'ERROR', 
      message: err.toString() 
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

function doGet(e) {
  return ContentService.createTextOutput(JSON.stringify({
    status: 'ONLINE',
    service: 'KKU OAS Borrowing Notification Gateway',
    timestamp: new Date().toISOString()
  })).setMimeType(ContentService.MimeType.JSON);
}`;

  const handleCopyGasScript = () => {
    navigator.clipboard.writeText(gasScriptCode);
    setGasCopied(true);
    setTimeout(() => setGasCopied(false), 2500);
  };

  // Full Database Backup (Export JSON)
  const handleExportBackup = async () => {
    setExporting(true);
    try {
      const { db } = fb();
      const [uSnap, eqSnap, reqSnap, catSnap, depSnap] = await Promise.all([
        getDocs(collection(db, 'users')),
        getDocs(collection(db, 'equipments')),
        getDocs(collection(db, 'borrow_requests')),
        getDocs(collection(db, 'categories')),
        getDocs(collection(db, 'departments')),
      ]);

      const backupData = {
        exportedAt: new Date().toISOString(),
        exportedBy: profile?.email,
        users: uSnap.docs.map((d) => d.data()),
        equipments: eqSnap.docs.map((d) => d.data()),
        borrow_requests: reqSnap.docs.map((d) => ({ ...d.data(), id: d.id })),
        categories: catSnap.docs.map((d) => d.data()),
        departments: depSnap.docs.map((d) => d.data()),
      };

      const blob = new Blob([JSON.stringify(backupData, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `kku-oas-borrow-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showToast('success', 'ส่งออกไฟล์สำรองข้อมูล JSON สำเร็จเรียบร้อยแล้ว');
    } catch (err: any) {
      showToast('error', 'ส่งออกข้อมูลล้มเหลว: ' + err.message);
    } finally {
      setExporting(false);
    }
  };

  // Re-seed initial master data
  const handleResetMasterData = async () => {
    if (
      !confirm(
        'คุณแน่ใจหรือไม่ว่าต้องการอัปเดตและซิงค์ข้อมูลบุคลากร 30 ท่าน และกลุ่มงาน 13 ฝ่าย ตามฐานข้อมูลมาตรฐาน?'
      )
    )
      return;
    setResetting(true);
    setResetMsg('');
    try {
      const { db } = fb();
      // Re-seed Users
      for (const u of SEED_DATA.users) {
        await setDoc(doc(db, 'users', u.email.toLowerCase()), u, { merge: true });
      }
      // Re-seed Departments
      for (const d of SEED_DATA.departments) {
        await setDoc(doc(db, 'departments', d.code), { id: d.code, code: d.code, name: d.name }, { merge: true });
      }
      // Re-seed Categories
      for (const c of SEED_DATA.categories) {
        await setDoc(doc(db, 'categories', c.id), { id: c.id, name: c.name, isActive: true }, { merge: true });
      }
      const successText = 'ซิงค์ข้อมูลบุคลากร 31 ท่าน กลุ่มงาน 13 ฝ่าย และหมวดหมู่ครุภัณฑ์ 6 หมวดสำเร็จ';
      setResetMsg(`✅ ${successText}`);
      showToast('success', successText);
      setTimeout(() => setResetMsg(''), 5000);
    } catch (err: any) {
      showToast('error', 'เกิดข้อผิดพลาด: ' + err.message);
    } finally {
      setResetting(false);
    }
  };

  return (
    <div className="space-y-6 pb-28 sm:pb-12">
      {/* Toast Notification */}
      {toast && (
        <div className="fixed top-5 right-5 z-50 max-w-md animate-in fade-in slide-in-from-top-3">
          <div
            className={`flex items-center gap-3 rounded-2xl px-5 py-3.5 shadow-xl border text-sm font-bold backdrop-blur-md ${
              toast.type === 'success'
                ? 'bg-emerald-50/95 border-emerald-300 text-emerald-950'
                : toast.type === 'error'
                ? 'bg-rose-50/95 border-rose-300 text-rose-950'
                : 'bg-sky-50/95 border-sky-300 text-sky-950'
            }`}
          >
            {toast.type === 'success' && <CheckCircle2 className="h-5 w-5 text-emerald-600 flex-shrink-0" />}
            {toast.type === 'error' && <XCircle className="h-5 w-5 text-rose-600 flex-shrink-0" />}
            {toast.type === 'info' && <AlertTriangle className="h-5 w-5 text-sky-600 flex-shrink-0" />}
            <span className="flex-1">{toast.message}</span>
            <button
              type="button"
              onClick={() => setToast(null)}
              className="text-slate-400 hover:text-slate-600 p-1 rounded-lg min-h-[44px] min-w-[44px] inline-flex items-center justify-center"
              aria-label="ปิดการแจ้งเตือน"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* Top Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200/80 pb-5">
        <div>
          <h1 className="text-xl sm:text-2xl font-black text-slate-900 flex items-center gap-2.5">
            <Settings className="h-6 w-6 sm:h-7 sm:w-7 text-brand-600 flex-shrink-0" />
            <span className="break-words">ศูนย์ตั้งค่าและบริหารจัดการระบบ</span>
          </h1>
          <p className="text-xs sm:text-sm text-slate-500 font-medium mt-1 break-words">
            สำนักบริการวิชาการ มหาวิทยาลัยขอนแก่น (Office of Academic Services, KKU)
          </p>
        </div>
      </div>

      {/* Tabs Bar */}
      <div className="flex gap-2 border-b border-slate-200/80 pb-2 overflow-x-auto max-w-full scrollbar-none">
        <button
          type="button"
          onClick={() => setActiveTab('users')}
          className={`min-h-[44px] inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-bold whitespace-nowrap flex-shrink-0 transition ${
            activeTab === 'users'
              ? 'bg-brand-600 text-white shadow-sm'
              : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
          }`}
        >
          <Users className="h-4 w-4" />
          บุคลากรและสิทธิ์ ({users.length})
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('categories')}
          className={`min-h-[44px] inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-bold whitespace-nowrap flex-shrink-0 transition ${
            activeTab === 'categories'
              ? 'bg-brand-600 text-white shadow-sm'
              : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
          }`}
        >
          <Tag className="h-4 w-4" />
          หมวดหมู่ครุภัณฑ์ ({categories.length})
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('departments')}
          className={`min-h-[44px] inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-bold whitespace-nowrap flex-shrink-0 transition ${
            activeTab === 'departments'
              ? 'bg-brand-600 text-white shadow-sm'
              : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
          }`}
        >
          <Building2 className="h-4 w-4" />
          กลุ่มงาน/ฝ่าย ({departments.length})
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('policy')}
          className={`min-h-[44px] inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-bold whitespace-nowrap flex-shrink-0 transition ${
            activeTab === 'policy'
              ? 'bg-brand-600 text-white shadow-sm'
              : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
          }`}
        >
          <Sliders className="h-4 w-4" />
          นโยบายและกฎการยืม
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('notifications')}
          className={`min-h-[44px] inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-bold whitespace-nowrap flex-shrink-0 transition ${
            activeTab === 'notifications'
              ? 'bg-brand-600 text-white shadow-sm'
              : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
          }`}
        >
          <Mail className="h-4 w-4" />
          การแจ้งเตือนทาง Email
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('audit')}
          className={`min-h-[44px] inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-bold whitespace-nowrap flex-shrink-0 transition ${
            activeTab === 'audit'
              ? 'bg-brand-600 text-white shadow-sm'
              : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
          }`}
        >
          <History className="h-4 w-4" />
          ประวัติกิจกรรม
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('backup')}
          className={`min-h-[44px] inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-bold whitespace-nowrap flex-shrink-0 transition ${
            activeTab === 'backup'
              ? 'bg-brand-600 text-white shadow-sm'
              : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
          }`}
        >
          <Download className="h-4 w-4" />
          สำรองข้อมูล & รีเซ็ต
        </button>
      </div>

      {/* TAB 1: USERS & ROLES */}
      {activeTab === 'users' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex flex-wrap items-center gap-3 flex-1 max-w-xl">
              <div className="relative flex-1 min-w-[240px]">
                <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                <input
                  type="text"
                  placeholder="ค้นหาชื่อ, รหัส, อีเมล หรือตำแหน่ง..."
                  className="input pl-10 text-sm"
                  value={userSearch}
                  onChange={(e) => setUserSearch(e.target.value)}
                />
              </div>
              <select
                className="input w-auto text-sm"
                value={userRoleFilter}
                onChange={(e) => setUserRoleFilter(e.target.value)}
              >
                <option value="ALL">สิทธิ์ทั้งหมด</option>
                <option value="USER">ผู้ใช้ทั่วไป (USER)</option>
                <option value="CUSTODIAN">ผู้ดูแลพัสดุ (CUSTODIAN)</option>
                <option value="APPROVER">ผู้อนุมัติ (APPROVER)</option>
                <option value="EXECUTIVE">ผู้บริหาร (EXECUTIVE)</option>
              </select>
            </div>

            <button
              type="button"
              onClick={() => {
                setUserForm({
                  email: '',
                  employeeCode: `OAS${users.length + 1 < 10 ? '0' : ''}${users.length + 1}`,
                  name: '',
                  position: 'บุคลากร',
                  division: 'กองบริหารงานสำนัก',
                  mission: 'สำนักบริการวิชาการ',
                  departmentCode: '01',
                  role: 'USER',
                  active: true,
                });
                setUserModalOpen(true);
              }}
              className="btn-primary text-xs"
            >
              <Plus className="h-4 w-4" /> เพิ่มบุคลากรใหม่
            </button>
          </div>

          <div className="card overflow-x-auto p-0 border border-slate-200">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-xs font-bold uppercase text-slate-600">
                <tr>
                  <th className="px-4 py-3.5">รหัส</th>
                  <th className="px-4 py-3.5">ชื่อ - สกุล</th>
                  <th className="px-4 py-3.5">ตำแหน่ง & ภารกิจ</th>
                  <th className="px-4 py-3.5">อีเมล KKU</th>
                  <th className="px-4 py-3.5">สิทธิ์การใช้งาน (Role)</th>
                  <th className="px-4 py-3.5 text-right">การจัดการ</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredUsers.map((u) => {
                  const isCustodian = u.role === 'CUSTODIAN';
                  const isApprover = u.role === 'APPROVER';
                  const isExecutive = u.role === 'EXECUTIVE';

                  return (
                    <tr key={u.email} className="hover:bg-slate-50/70 transition">
                      <td className="px-4 py-3 font-mono font-bold text-brand-700 text-xs">
                        {u.employeeCode}
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-bold text-slate-900">{u.name}</div>
                        {u.title && <div className="text-xs text-slate-500">{u.title}</div>}
                      </td>
                      <td className="px-4 py-3">
                        <div className="text-slate-800 text-xs font-semibold">{u.position}</div>
                        <div className="text-slate-500 text-xs">{u.mission}</div>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-slate-600">
                        {u.email}
                      </td>
                      <td className="px-4 py-3">
                        <select
                          value={u.role}
                          onChange={(e) => handleQuickRoleChange(u, e.target.value as Role)}
                          className={`rounded-lg px-2.5 py-1 text-xs font-bold border ${
                            isCustodian
                              ? 'bg-amber-50 text-amber-800 border-amber-300'
                              : isApprover
                              ? 'bg-emerald-50 text-emerald-800 border-emerald-300'
                              : isExecutive
                              ? 'bg-purple-50 text-purple-800 border-purple-300'
                              : 'bg-slate-100 text-slate-700 border-slate-300'
                          }`}
                        >
                          <option value="USER">👤 ผู้ใช้ทั่วไป (USER)</option>
                          <option value="CUSTODIAN">🛡️ ผู้ดูแลพัสดุ (CUSTODIAN)</option>
                          <option value="APPROVER">✍️ ผู้อนุมัติ (APPROVER)</option>
                          <option value="EXECUTIVE">👑 ผู้บริหาร (EXECUTIVE)</option>
                        </select>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          type="button"
                          onClick={() => {
                            setUserForm(u);
                            setUserModalOpen(true);
                          }}
                          className="btn-outline text-xs py-1 px-2.5"
                        >
                          <Edit2 className="h-3.5 w-3.5" /> แก้ไข
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 2: CATEGORIES */}
      {activeTab === 'categories' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-base font-bold text-slate-900">รายการหมวดหมู่ครุภัณฑ์</h3>
              <p className="text-xs text-slate-500 font-medium">
                หมวดหมู่สำหรับจัดกลุ่มอุปกรณ์และสร้างตัวกรองการยืม
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                setCatForm({ id: '', name: '', isNew: true });
                setCatModalOpen(true);
              }}
              className="btn-primary text-xs"
            >
              <Plus className="h-4 w-4" /> เพิ่มหมวดหมู่ใหม่
            </button>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {categories.map((c) => (
              <div
                key={c.id}
                className="card flex items-center justify-between p-4 border border-slate-200/80 hover:shadow-sm transition"
              >
                <div className="flex items-center gap-3">
                  <div className="rounded-xl bg-brand-50 p-2.5 text-brand-600">
                    <Tag className="h-5 w-5" />
                  </div>
                  <div>
                    <div className="font-bold text-slate-900 text-sm">{c.name}</div>
                    <div className="font-mono text-xs text-slate-400">ID: {c.id}</div>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => {
                      setCatForm({ id: c.id, name: c.name, isNew: false });
                      setCatModalOpen(true);
                    }}
                    className="p-1.5 text-slate-400 hover:text-slate-700 transition"
                    title="แก้ไข"
                  >
                    <Edit2 className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDeleteCategory(c)}
                    className="p-1.5 text-slate-400 hover:text-red-600 transition"
                    title="ลบ"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* TAB 3: DEPARTMENTS */}
      {activeTab === 'departments' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-base font-bold text-slate-900">โครงสร้างกลุ่มงานและฝ่าย</h3>
              <p className="text-xs text-slate-500 font-medium">
                รายชื่อกลุ่มงานและภารกิจภายในสำนักบริการวิชาการ
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                setDeptForm({ id: '', code: '', name: '', isNew: true });
                setDeptModalOpen(true);
              }}
              className="btn-primary text-xs"
            >
              <Plus className="h-4 w-4" /> เพิ่มกลุ่มงานใหม่
            </button>
          </div>

          <div className="card overflow-x-auto p-0 border border-slate-200">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-xs font-bold uppercase text-slate-600">
                <tr>
                  <th className="px-4 py-3.5">รหัสกลุ่มงาน</th>
                  <th className="px-4 py-3.5">ชื่อกลุ่มงาน / ภารกิจ</th>
                  <th className="px-4 py-3.5 text-right">การจัดการ</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {departments.map((d) => (
                  <tr key={d.id} className="hover:bg-slate-50/70 transition">
                    <td className="px-4 py-3 font-mono font-bold text-brand-700 text-xs">
                      {d.code}
                    </td>
                    <td className="px-4 py-3 font-bold text-slate-900">{d.name}</td>
                    <td className="px-4 py-3 text-right">
                      <div className="inline-flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => {
                            setDeptForm({ id: d.id, code: d.code, name: d.name, isNew: false });
                            setDeptModalOpen(true);
                          }}
                          className="btn-outline text-xs py-1 px-2.5"
                        >
                          <Edit2 className="h-3.5 w-3.5" /> แก้ไข
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteDept(d)}
                          className="p-1.5 text-slate-400 hover:text-red-600 transition ml-1"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 4: POLICY & RULES */}
      {activeTab === 'policy' && (
        <form onSubmit={handleSavePolicy} className="card max-w-2xl space-y-6">
          <div>
            <h3 className="text-base font-bold text-slate-900">ตั้งค่านโยบายและกฎการยืม-คืน</h3>
            <p className="text-xs text-slate-500 font-medium">
              กำหนดข้อจำกัด ระยะเวลาการยืม และโหมดการทำงานของระบบ
            </p>
          </div>

          {/* Test Mode Switch Card */}
          <div className="rounded-2xl border border-amber-300 bg-amber-50/70 p-5 space-y-2.5">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-2.5">
                <div className="rounded-xl bg-amber-500 p-2 text-white shadow-xs">
                  <Sparkles className="h-5 w-5" />
                </div>
                <div>
                  <div className="text-sm font-bold text-amber-950">
                    โหมดทดสอบระบบ (Test Mode / สลับสิทธิ์ 30 ท่าน)
                  </div>
                  <div className="text-xs text-amber-800 font-medium">
                    สถานะปัจจุบัน: {policyForm.enableTestMode ? '🟢 เปิดใช้งาน' : '⚪ ปิดใช้งาน (โหมดใช้งานจริง)'}
                  </div>
                </div>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={policyForm.enableTestMode}
                  onChange={(e) =>
                    setPolicyForm({ ...policyForm, enableTestMode: e.target.checked })
                  }
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-slate-300 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-amber-500 shadow-inner"></div>
              </label>
            </div>
            <p className="text-xs text-amber-900/90 leading-relaxed font-normal pt-1 border-t border-amber-200/80">
              • <b>เมื่อเปิดใช้งาน:</b> แถบสีเหลืองด้านบนสุดของเว็บไซต์จะแสดงขึ้น เพื่อให้ผู้ดูแลสามารถกดสลับสวมบทบาทเป็นบุคลากรท่านใดก็ได้ (30 ท่าน) เพื่อทดสอบขั้นตอนการยื่นคำขอ, การตรวจสอบ (นายชาลี), และการอนุมัติ (นายประหยัด)<br/>
              • <b>เมื่อปิดใช้งาน:</b> แถบสีเหลืองจะถูกซ่อนทั้งหมด เพื่อเข้าสู่โหมดการใช้งานจริง (Production)
            </p>
          </div>

          <div className="space-y-4">
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">
                ระยะเวลายืมสูงสุดต่อครั้ง (วัน) *
              </label>
              <input
                type="number"
                min={1}
                max={90}
                className="input max-w-xs"
                value={policyForm.maxBorrowDays}
                onChange={(e) =>
                  setPolicyForm({ ...policyForm, maxBorrowDays: Number(e.target.value) })
                }
                required
              />
              <span className="text-xs text-slate-400 mt-1 block">
                ระบบจะไม่ยินยอมให้ผู้ใช้ระบุวันที่ยืมเกินจำนวนวันนี้ (ค่ามาตรฐาน 15 วัน)
              </span>
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">
                แจ้งเตือนล่วงหน้าก่อนครบกำหนดส่งคืน (วัน)
              </label>
              <input
                type="number"
                min={1}
                max={7}
                className="input max-w-xs"
                value={policyForm.advanceReminderDays}
                onChange={(e) =>
                  setPolicyForm({ ...policyForm, advanceReminderDays: Number(e.target.value) })
                }
                required
              />
            </div>

            <div className="pt-2">
              <label className="flex items-center gap-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                  checked={policyForm.enableTwoStepApproval}
                  onChange={(e) =>
                    setPolicyForm({ ...policyForm, enableTwoStepApproval: e.target.checked })
                  }
                />
                <span className="text-sm font-bold text-slate-800">
                  เปิดใช้งานการอนุมัติ 2 ขั้นตอน (Step 1 นายชาลี ตรวจสอบ -&gt; Step 2 นายประหยัด อนุมัติ)
                </span>
              </label>
            </div>

            <div className="pt-2">
              <label className="block text-xs font-bold text-slate-700 mb-1">
                ข้อกำหนดและแนวปฏิบัติการยืม (แสดงในแบบฟอร์มขอยืม)
              </label>
              <textarea
                rows={5}
                className="input"
                value={policyForm.guidelines}
                onChange={(e) => setPolicyForm({ ...policyForm, guidelines: e.target.value })}
              />
            </div>
          </div>

          <div className="flex items-center gap-3 pt-2">
            <button type="submit" disabled={policySaving} className="btn-primary">
              {policySaving ? 'กำลังบันทึก...' : 'บันทึกการตั้งค่า'}
            </button>
            {policySavedMsg && (
              <span className="text-xs font-bold text-emerald-600 flex items-center gap-1">
                <Check className="h-4 w-4" /> บันทึกสำเร็จเรียบร้อย
              </span>
            )}
          </div>
        </form>
      )}

      {/* TAB 5: NOTIFICATIONS & EMAIL */}
      {activeTab === 'notifications' && (
        <div className="space-y-6">
          {/* Top Banner Guide */}
          <div className="rounded-2xl bg-gradient-to-r from-emerald-800 to-teal-900 p-4 sm:p-6 text-white shadow-lg overflow-hidden">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-500/30 text-emerald-200 text-xs font-bold uppercase mb-2">
                  <Zap className="h-3.5 w-3.5 text-amber-300 flex-shrink-0" />
                  <span>Email Gateway (ส่งอีเมลจริงฟรี 100%)</span>
                </div>
                <h2 className="text-lg sm:text-xl font-black text-white break-words">
                  ระบบส่งอีเมลแจ้งเตือนอัตโนมัติ (Direct Mail Gateway)
                </h2>
                <p className="text-xs text-emerald-100 mt-1 max-w-2xl leading-relaxed break-words">
                  เชื่อมต่อการส่งอีเมลตรงเข้าสู่กล่องข้อความผู้ใช้ (Inbox) ของบุคลากร มข. รองรับการเชื่อมต่อผ่าน <b>Google Apps Script (@kku.ac.th)</b> หรือ <b>Brevo / Resend API</b> โดยไม่ต้องอัปเกรดเป็น Firebase Blaze
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowGasGuide(!showGasGuide)}
                className="btn-outline bg-white/10 hover:bg-white/20 text-white border-white/30 text-xs py-2.5 px-4 min-h-[44px] flex items-center justify-center whitespace-normal sm:whitespace-nowrap self-stretch sm:self-center text-center font-bold"
              >
                {showGasGuide ? 'ซ่อนวิธีตั้งค่า Google Apps Script' : '📖 วิธีสร้าง Apps Script ใน 1 นาที'}
              </button>
            </div>

            {/* Collapsible Google Apps Script Guide */}
            {showGasGuide && (
              <div className="mt-5 pt-5 border-t border-emerald-700/60 text-slate-100 text-xs space-y-4">
                <div className="font-bold text-sm text-amber-300 flex items-center gap-2">
                  <span>🚀 ขั้นตอนการสร้าง Webhook ฟรีผ่านบัญชี Google KKU (@kku.ac.th):</span>
                </div>
                <ol className="list-decimal list-inside space-y-2 text-emerald-50 bg-black/20 p-4 rounded-xl leading-relaxed">
                  <li>
                    เข้าสู่เว็บไซต์ <a href="https://script.google.com" target="_blank" rel="noreferrer" className="text-amber-300 underline font-bold inline-flex items-center gap-0.5 break-all">script.google.com <ExternalLink className="h-3 w-3 flex-shrink-0" /></a> ด้วยบัญชี <b>@kku.ac.th</b> แล้วกด <b>&quot;New project&quot; (โครงการใหม่)</b>
                  </li>
                  <li>
                    ลบโค้ดเดิมออกทั้งหมด แล้ววางโค้ดด้านล่างนี้ลงไปแทน:
                  </li>
                </ol>

                <div className="relative max-w-full overflow-hidden space-y-2 sm:space-y-0">
                  <pre className="bg-slate-950 text-emerald-300 p-3 sm:p-4 rounded-xl text-xs font-mono overflow-x-auto border border-emerald-800/60 max-h-60 max-w-full">
                    {gasScriptCode}
                  </pre>
                  <button
                    type="button"
                    onClick={handleCopyGasScript}
                    className="sm:absolute sm:top-3 sm:right-3 btn-primary bg-emerald-600 hover:bg-emerald-500 text-xs py-2 px-3.5 shadow min-h-[44px] w-full sm:w-auto flex items-center justify-center gap-1.5 font-bold"
                  >
                    {gasCopied ? <span className="flex items-center gap-1 text-white"><Check className="h-4 w-4" /> คัดลอกแล้ว</span> : <span className="flex items-center gap-1"><Copy className="h-4 w-4" /> คัดลอกโค้ด</span>}
                  </button>
                </div>

                <ol start={3} className="list-decimal list-inside space-y-2 text-emerald-50 bg-black/20 p-4 rounded-xl leading-relaxed">
                  <li>
                    กดปุ่มสีน้ำเงินมุมขวาบน <b>&quot;Deploy&quot; (การทำให้ใช้งานได้) ➔ &quot;New deployment&quot; (การทำให้ใช้งานได้ใหม่)</b>
                  </li>
                  <li>
                    เลือกประเภทเป็น <b>&quot;Web app&quot; (เว็บแอป)</b> แล้วตั้งค่า:
                    <ul className="list-disc list-inside pl-5 mt-1 text-slate-200">
                      <li><b>Execute as (เรียกใช้ในฐานะ):</b> Me (ฉัน)</li>
                      <li><b>Who has access (ผู้มีสิทธิ์เข้าถึง):</b> Anyone (ทุกคน)</li>
                    </ul>
                  </li>
                  <li>
                    กด <b>Deploy</b> แล้วคัดลอก <b>Web app URL</b> ที่ได้ มาวางในช่อง <i>&quot;Google Apps Script Webhook URL&quot;</i> ด้านล่างนี้ แล้วกดบันทึก!
                  </li>
                </ol>
              </div>
            )}
          </div>

          <div className="grid gap-6 lg:grid-cols-12">
            {/* Email Gateway Configuration Card (7 cols) */}
            <form onSubmit={handleSavePolicy} className="card space-y-4 lg:col-span-7">
              <div className="flex items-center gap-3">
                <div className="rounded-xl bg-emerald-50 p-2.5 text-emerald-700 flex-shrink-0">
                  <Mail className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="font-bold text-slate-900 text-sm sm:text-base">ตั้งค่าบริการส่ง Email (Gateway Provider)</h3>
                  <p className="text-xs text-slate-500 font-medium">
                    เลือกช่องทางการส่งอีเมลตรงถึงผู้ใช้งาน
                  </p>
                </div>
              </div>

              {/* Form Error State Banner */}
              {formError && (
                <div className="rounded-xl bg-rose-50 border border-rose-300 p-3.5 text-xs text-rose-900 flex items-start justify-between gap-2 animate-in fade-in">
                  <div className="flex items-start gap-2">
                    <XCircle className="h-4 w-4 text-rose-600 flex-shrink-0 mt-0.5" />
                    <div>
                      <div className="font-bold">ข้อมูลไม่ถูกต้อง (Validation Error)</div>
                      <div className="mt-0.5 break-words">{formError}</div>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setFormError(null)}
                    className="text-rose-400 hover:text-rose-700 p-1 min-h-[32px] min-w-[32px] inline-flex items-center justify-center font-bold"
                    aria-label="ปิดการแจ้งเตือนข้อผิดพลาด"
                  >
                    ✕
                  </button>
                </div>
              )}

              {/* CUSTODIAN and EXECUTIVE Role Permission Notice */}
              {profile && !['CUSTODIAN', 'EXECUTIVE'].includes(profile.role) && (
                <div className="rounded-xl bg-amber-50 border border-amber-200 p-3.5 text-xs text-amber-900 flex items-start gap-2">
                  <AlertTriangle className="h-4 w-4 text-amber-600 flex-shrink-0 mt-0.5" />
                  <div>
                    <div className="font-bold">จำกัดสิทธิ์เฉพาะผู้ดูแลพัสดุ (CUSTODIAN) หรือผู้บริหาร (EXECUTIVE)</div>
                    <div className="mt-0.5 leading-relaxed">
                      บัญชีปัจจุบันของคุณ ({profile.email}) มีสิทธิ์เป็น <b>{profile.role}</b> การแก้ไขข้อมูลความลับ (API Keys หรือ Webhook Secret Token) สามารถบันทึกได้เฉพาะผู้ดูแลพัสดุ (CUSTODIAN) หรือผู้บริหาร (EXECUTIVE)
                    </div>
                  </div>
                </div>
              )}

              {/* Master Email Toggle */}
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3.5 sm:p-4 space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-bold text-slate-800 break-words">
                    เปิดใช้งานระบบส่ง Email แจ้งเตือน
                  </span>
                  <label className="relative inline-flex items-center cursor-pointer min-h-[44px] min-w-[48px] justify-end">
                    <input
                      type="checkbox"
                      checked={policyForm.enableEmailNotifications}
                      onChange={(e) => {
                        setPolicyForm({
                          ...policyForm,
                          enableEmailNotifications: e.target.checked,
                        });
                        setFormError(null);
                      }}
                      className="sr-only peer"
                    />
                    <div className="w-11 h-6 bg-slate-300 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[12px] after:right-[22px] peer-checked:after:right-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-emerald-600 shadow-inner"></div>
                  </label>
                </div>
                <p className="text-xs text-slate-500">
                  เมื่อเปิดใช้งาน ระบบจะสร้างคำสั่งและยิงอีเมลอัตโนมัติตามขั้นตอนการยืม-คืน
                </p>
              </div>

              {/* Provider Selection */}
              <div className="space-y-1">
                <label className="block text-xs font-bold text-slate-700">
                  ผู้ให้บริการส่งอีเมล (Email Gateway Provider) *
                </label>
                <select
                  className="input font-semibold min-h-[44px] text-xs sm:text-sm w-full"
                  value={policyForm.emailProvider}
                  onChange={(e: any) => {
                    setPolicyForm({ ...policyForm, emailProvider: e.target.value });
                    setFormError(null);
                  }}
                >
                  <option value="GOOGLE_APPS_SCRIPT">
                    🌟 Google Apps Script Webhook (แนะนำสำหรับ มข. - ส่งฟรีผ่าน @kku.ac.th 1,500 เมล/วัน)
                  </option>
                  <option value="BREVO">
                    ⚡ Brevo (Sendinblue) API (ส่งฟรี 300 เมล/วัน ไม่ต้องผูกบัตร)
                  </option>
                  <option value="RESEND">
                    ✉️ Resend API (ส่งฟรี 100 เมล/วัน)
                  </option>
                  <option value="NONE">
                    📦 บันทึกคิวลง Firestore เท่านั้น (สำหรับ Firebase Extension)
                  </option>
                </select>
              </div>

              {/* Dynamic Provider Fields: GOOGLE_APPS_SCRIPT */}
              {policyForm.emailProvider === 'GOOGLE_APPS_SCRIPT' && (
                <div className="rounded-xl bg-emerald-50/60 border border-emerald-200 p-3.5 sm:p-4 space-y-3.5">
                  <div>
                    <div className="flex flex-wrap items-center justify-between gap-1 mb-1">
                      <label className="block text-xs font-bold text-emerald-950">
                        Google Apps Script Web App URL *
                      </label>
                      <button
                        type="button"
                        onClick={() => setShowGasGuide(true)}
                        className="text-xs text-emerald-700 font-bold hover:underline min-h-[32px] inline-flex items-center"
                      >
                        ดูวิธีสร้าง URL
                      </button>
                    </div>
                    <input
                      type="url"
                      className="input bg-white font-mono text-xs min-h-[44px] w-full"
                      placeholder={
                        gatewayStatus.hasGasWebhookUrl
                          ? '•••••••• (ตั้งค่าไว้ในเซิร์ฟเวอร์แล้ว - กรอกใหม่เมื่อต้องการเปลี่ยน)'
                          : 'https://script.google.com/macros/s/.../exec'
                      }
                      value={policyForm.gasWebhookUrl}
                      onChange={(e) => {
                        setPolicyForm({ ...policyForm, gasWebhookUrl: e.target.value });
                        setFormError(null);
                      }}
                      required={
                        policyForm.emailProvider === 'GOOGLE_APPS_SCRIPT' &&
                        !gatewayStatus.hasGasWebhookUrl
                      }
                    />
                  </div>

                  {/* Shared Secret Token Input */}
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="block text-xs font-bold text-emerald-950">
                        Shared Secret Token (โทเค็นความลับยืนยันสิทธิ์ Webhook)
                      </label>
                      {gatewayStatus.hasGasSecretToken && (
                        <span className="text-[10px] font-bold text-emerald-700 bg-emerald-100 px-2 py-0.5 rounded-full">
                          🔒 บันทึกแล้ว
                        </span>
                      )}
                    </div>
                    <input
                      type="password"
                      className="input bg-white font-mono text-xs min-h-[44px] w-full"
                      placeholder={
                        gatewayStatus.hasGasSecretToken
                          ? '•••••••• (บันทึกไว้ในเซิร์ฟเวอร์แล้ว - กรอกใหม่เมื่อต้องการเปลี่ยน)'
                          : 'กำหนดโทเค็นความลับ (เช่น kku_secret_2026) หรือปล่อยว่าง'
                      }
                      value={policyForm.gasSecretToken}
                      onChange={(e) => {
                        setPolicyForm({ ...policyForm, gasSecretToken: e.target.value });
                        setFormError(null);
                      }}
                    />
                    <p className="text-[11px] text-emerald-700 font-medium mt-1">
                      🔒 ป้องกันบุคคลภายนอกยิง Webhook ตรง โดยระบบจะแนบ secretToken นี้ไปใน Payload ทุกครั้ง
                    </p>
                  </div>

                  {/* Sender Name & Sender Email (Reply-To) */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                    <div>
                      <label className="block text-xs font-bold text-slate-700 mb-1">
                        ชื่อผู้ส่งที่แสดง (Sender Name)
                      </label>
                      <input
                        type="text"
                        className="input bg-white text-xs min-h-[44px] w-full"
                        placeholder="ระบบยืม-คืน ครุภัณฑ์ สำนักบริการวิชาการ มข."
                        value={policyForm.gasSenderName}
                        onChange={(e) => {
                          setPolicyForm({ ...policyForm, gasSenderName: e.target.value });
                          setFormError(null);
                        }}
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-bold text-slate-700 mb-1">
                        อีเมลสำหรับตอบกลับ (Reply-To / ไม่บังคับ)
                      </label>
                      <input
                        type="email"
                        className="input bg-white text-xs min-h-[44px] w-full"
                        placeholder="เช่น chalpr@kku.ac.th"
                        value={policyForm.gasSenderEmail}
                        onChange={(e) => {
                          setPolicyForm({ ...policyForm, gasSenderEmail: e.target.value });
                          setFormError(null);
                        }}
                      />
                    </div>
                  </div>

                  <p className="text-[11px] text-emerald-700 font-medium pt-1">
                    ℹ️ ส่งอีเมลแจ้งเตือนผ่าน Google Apps Script ภายใต้โควตาการส่งของบัญชี Google Workspace มหาวิทยาลัยขอนแก่น (ฟรี 1,500 เมล/วัน)
                  </p>
                </div>
              )}

              {/* Dynamic Provider Fields: BREVO */}
              {policyForm.emailProvider === 'BREVO' && (
                <div className="rounded-xl bg-sky-50/60 border border-sky-200 p-3.5 sm:p-4 space-y-3">
                  <div>
                    <label className="block text-xs font-bold text-sky-950 mb-1">
                      Brevo API Key (v3) *
                    </label>
                    <input
                      type="password"
                      className="input bg-white font-mono text-xs min-h-[44px] w-full"
                      placeholder={
                        gatewayStatus.hasBrevoApiKey
                          ? '•••••••• (บันทึกไว้ในเซิร์ฟเวอร์แล้ว - กรอกใหม่เมื่อต้องการเปลี่ยน)'
                          : 'xkeysib-...'
                      }
                      value={policyForm.brevoApiKey}
                      onChange={(e) => {
                        setPolicyForm({ ...policyForm, brevoApiKey: e.target.value });
                        setFormError(null);
                      }}
                      required={
                        policyForm.emailProvider === 'BREVO' &&
                        !gatewayStatus.hasBrevoApiKey
                      }
                    />
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-bold text-slate-700 mb-1">อีเมลผู้ส่ง (Sender)</label>
                      <input
                        type="email"
                        className="input bg-white text-xs min-h-[44px] w-full"
                        value={policyForm.brevoSenderEmail}
                        onChange={(e) => {
                          setPolicyForm({ ...policyForm, brevoSenderEmail: e.target.value });
                          setFormError(null);
                        }}
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-bold text-slate-700 mb-1">ชื่อผู้ส่ง (Sender Name)</label>
                      <input
                        type="text"
                        className="input bg-white text-xs min-h-[44px] w-full"
                        value={policyForm.brevoSenderName}
                        onChange={(e) => {
                          setPolicyForm({ ...policyForm, brevoSenderName: e.target.value });
                          setFormError(null);
                        }}
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* Dynamic Provider Fields: RESEND */}
              {policyForm.emailProvider === 'RESEND' && (
                <div className="rounded-xl bg-purple-50/60 border border-purple-200 p-3.5 sm:p-4 space-y-3">
                  <div>
                    <label className="block text-xs font-bold text-purple-950 mb-1">
                      Resend API Key *
                    </label>
                    <input
                      type="password"
                      className="input bg-white font-mono text-xs min-h-[44px] w-full"
                      placeholder={
                        gatewayStatus.hasResendApiKey
                          ? '•••••••• (บันทึกไว้ในเซิร์ฟเวอร์แล้ว - กรอกใหม่เมื่อต้องการเปลี่ยน)'
                          : 're_...'
                      }
                      value={policyForm.resendApiKey}
                      onChange={(e) => {
                        setPolicyForm({ ...policyForm, resendApiKey: e.target.value });
                        setFormError(null);
                      }}
                      required={
                        policyForm.emailProvider === 'RESEND' &&
                        !gatewayStatus.hasResendApiKey
                      }
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-slate-700 mb-1">ผู้ส่ง (Sender Header)</label>
                    <input
                      type="text"
                      className="input bg-white text-xs min-h-[44px] w-full"
                      placeholder="ระบบยืม-คืน ครุภัณฑ์ <onboarding@resend.dev>"
                      value={policyForm.resendSender}
                      onChange={(e) => {
                        setPolicyForm({ ...policyForm, resendSender: e.target.value });
                        setFormError(null);
                      }}
                    />
                  </div>
                </div>
              )}

              {/* Core Email Recipients */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="block text-xs font-bold text-slate-700">
                      อีเมลผู้ดูแลพัสดุ (นายชาลี พรหมอินทร์) *
                    </label>
                    <span className="text-[10px] font-bold bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded">
                      CUSTODIAN
                    </span>
                  </div>
                  <input
                    type="email"
                    className="input text-xs min-h-[44px] w-full"
                    value={policyForm.custodianEmail}
                    onChange={(e) => {
                      setPolicyForm({ ...policyForm, custodianEmail: e.target.value });
                      setFormError(null);
                    }}
                    required
                  />
                  <span className="text-[11px] text-slate-400 mt-1 block">
                    รับแจ้งเตือนเมื่อมีคำขอยื่นใหม่
                  </span>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="block text-xs font-bold text-slate-700">
                      อีเมลผู้อนุมัติ (นายประหยัด สืบเมืองซ้าย) *
                    </label>
                    <span className="text-[10px] font-bold bg-blue-100 text-blue-800 px-1.5 py-0.5 rounded">
                      APPROVER
                    </span>
                  </div>
                  <input
                    type="email"
                    className="input text-xs min-h-[44px] w-full"
                    value={policyForm.approverEmail}
                    onChange={(e) => {
                      setPolicyForm({ ...policyForm, approverEmail: e.target.value });
                      setFormError(null);
                    }}
                    required
                  />
                  <span className="text-[11px] text-slate-400 mt-1 block">
                    รับแจ้งเตือนเมื่อคำขอผ่านตรวจขั้น 1
                  </span>
                </div>
              </div>

              <div className="pt-2 flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
                <button type="submit" disabled={policySaving} className="btn-primary text-xs sm:text-sm min-h-[44px] w-full sm:w-auto flex items-center justify-center font-bold">
                  {policySaving ? 'กำลังบันทึก...' : 'บันทึกการตั้งค่า Gateway'}
                </button>
                {policySavedMsg && (
                  <span className="text-xs font-bold text-emerald-600 flex items-center justify-center sm:justify-start gap-1">
                    <Check className="h-4 w-4" /> บันทึกสำเร็จ
                  </span>
                )}
              </div>
            </form>

            {/* Test Email Card (5 cols) */}
            <form onSubmit={handleSendTestEmail} className="card space-y-4 border-slate-200 lg:col-span-5 flex flex-col justify-between">
              <div className="space-y-4">
                <div className="flex items-center gap-3">
                  <div className="rounded-xl bg-emerald-100 p-2.5 text-emerald-800 flex-shrink-0">
                    <Send className="h-5 w-5" />
                  </div>
                  <div>
                    <h3 className="font-bold text-slate-900 text-sm sm:text-base">ทดสอบการส่ง Email ทันที</h3>
                    <p className="text-xs text-slate-500 font-medium">
                      ยิงอีเมลทดสอบผ่าน Gateway ที่เลือก
                    </p>
                  </div>
                </div>

                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-bold text-slate-700 mb-1">
                      อีเมลผู้รับทดสอบ (@kku.ac.th) *
                    </label>
                    <input
                      type="email"
                      className="input bg-white text-xs min-h-[44px] w-full"
                      placeholder="เช่น praysu@kku.ac.th"
                      value={testEmailTarget}
                      onChange={(e) => setTestEmailTarget(e.target.value)}
                      required
                    />
                  </div>

                  <div className="rounded-xl bg-slate-50 p-3.5 border border-slate-200 text-xs text-slate-600 leading-relaxed space-y-1.5">
                    <div className="font-bold text-slate-800 flex items-center gap-1.5">
                      <Zap className="h-3.5 w-3.5 text-amber-500 flex-shrink-0" /> สถานะ Provider ปัจจุบัน:
                    </div>
                    <div className="font-mono text-[11px] font-bold text-emerald-700 break-words">
                      {policyForm.emailProvider === 'GOOGLE_APPS_SCRIPT'
                        ? '🟢 Google Apps Script Webhook'
                        : policyForm.emailProvider === 'BREVO'
                        ? '🟢 Brevo Direct API'
                        : policyForm.emailProvider === 'RESEND'
                        ? '🟢 Resend Direct API'
                        : '⚪ Firestore Queue Only'}
                    </div>
                  </div>
                </div>
              </div>

              <div className="space-y-2 pt-4">
                <button
                  type="submit"
                  disabled={testSending}
                  className="btn-primary w-full text-xs sm:text-sm shadow-md min-h-[44px] flex items-center justify-center gap-1.5 font-bold"
                >
                  <Send className="h-4 w-4" />
                  {testSending ? 'กำลังยิงอีเมล...' : 'ส่ง Email ทดสอบทันที'}
                </button>

                {testSentMsg && (
                  <div className="text-xs font-bold text-emerald-800 text-center bg-emerald-50 p-2.5 rounded-lg border border-emerald-200 break-words">
                    {testSentMsg}
                  </div>
                )}
              </div>
            </form>
          </div>

          {/* Mail Queue History Table */}
          <div className="space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
                  <Inbox className="h-5 w-5 text-emerald-700 flex-shrink-0" />
                  <span>ประวัติและคิวการส่ง Email (Mail Queue History)</span>
                </h3>
                <p className="text-xs text-slate-500 font-medium">
                  รายการอีเมลทั้งหมดที่ระบบสร้าง สามารถกดส่งซ้ำ (Retry), กวาดคิวตกค้าง หรือทดสอบ Scheduler รายวันได้
                </p>
              </div>

              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 w-full sm:w-auto">
                <button
                  type="button"
                  onClick={handleRunBatchQueue}
                  disabled={batchProcessing}
                  className="btn-outline border-emerald-300 text-emerald-700 hover:bg-emerald-50 text-xs py-2 px-3.5 inline-flex items-center justify-center gap-1.5 shadow-sm font-bold min-h-[44px] w-full sm:w-auto"
                  title="ส่งสัญญาณให้เซิร์ฟเวอร์กวาดคิวอีเมลตกค้าง (เคารพ Backoff และ Lock)"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${batchProcessing ? 'animate-spin' : ''}`} />
                  <span>{batchProcessing ? 'กำลังส่งสัญญาณ...' : 'กวาดคิวตกค้าง (Signal Queue Sweep)'}</span>
                </button>

                <button
                  type="button"
                  onClick={handleRunDailyReminders}
                  disabled={schedulerRunning}
                  className="btn-outline border-amber-300 text-amber-800 hover:bg-amber-50 text-xs py-2 px-3.5 inline-flex items-center justify-center gap-1.5 shadow-sm font-bold min-h-[44px] w-full sm:w-auto"
                  title="จำลองการทำงานของตัวตรวจเตือนล่วงหน้าและเตือนเกินกำหนดประจำวัน"
                >
                  <Sparkles className={`h-3.5 w-3.5 ${schedulerRunning ? 'animate-spin' : ''}`} />
                  <span>{schedulerRunning ? 'กำลังตรวจเตือน...' : 'ทดสอบตรวจเตือนรายวัน (Run Daily Schedulers)'}</span>
                </button>
              </div>
            </div>

            {batchResultMsg && (
              <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-xs font-bold text-emerald-900 shadow-sm animate-fade-in break-words">
                {batchResultMsg}
              </div>
            )}

            {/* Filter & Search Toolbar */}
            <div className="flex flex-col sm:flex-row flex-wrap items-stretch sm:items-center gap-2.5 bg-slate-50 p-3 rounded-xl border border-slate-200">
              <div className="relative flex-1 min-w-0 sm:min-w-[200px]">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
                <input
                  type="text"
                  placeholder="ค้นหาตามอีเมลผู้รับ, เลขคำขอ, หรือหัวข้อ..."
                  className="input pl-9 text-xs bg-white min-h-[44px] w-full"
                  value={mailSearch}
                  onChange={(e) => setMailSearch(e.target.value)}
                />
              </div>

              <select
                className="input w-full sm:w-auto text-xs bg-white min-h-[44px]"
                value={mailFilterStatus}
                onChange={(e) => setMailFilterStatus(e.target.value)}
              >
                <option value="ALL">สถานะทั้งหมด</option>
                <option value="SUCCESS">ส่งสำเร็จ (SUCCESS)</option>
                <option value="PENDING">รอดำเนินการ (PENDING / QUEUED)</option>
                <option value="PROCESSING">กำลังประมวลผล (PROCESSING)</option>
                <option value="FAILED">ส่งไม่สำเร็จ (FAILED)</option>
                <option value="RECONCILIATION_REQUIRED">ต้องตรวจสอบก่อนส่ง (RECONCILIATION_REQUIRED)</option>
                <option value="SKIPPED">ข้ามแล้ว (SKIPPED - ซ้ำ/ล้าสมัย)</option>
              </select>

              <select
                className="input w-full sm:w-auto text-xs bg-white min-h-[44px]"
                value={mailFilterType}
                onChange={(e) => setMailFilterType(e.target.value)}
              >
                <option value="ALL">เหตุการณ์ทั้งหมด (Types)</option>
                <option value="NEW_REQUEST">NEW_REQUEST (มีคำขอยื่นใหม่)</option>
                <option value="REQUEST_CONFIRMATION">REQUEST_CONFIRMATION (ยืนยันรับคำขอ)</option>
                <option value="REVIEW_PASSED">REVIEW_PASSED (ผ่านตรวจขั้น 1)</option>
                <option value="REVIEW_REJECTED">REVIEW_REJECTED (ไม่ผ่านตรวจ)</option>
                <option value="APPROVED">APPROVED (อนุมัติแล้ว)</option>
                <option value="REJECTED">REJECTED (ไม่อนุมัติ)</option>
                <option value="HANDED_OVER">HANDED_OVER (ส่งมอบอุปกรณ์)</option>
                <option value="CANCELLED">CANCELLED (ยกเลิกคำขอ)</option>
                <option value="UPCOMING_DUE_REMINDER">UPCOMING_DUE_REMINDER (ใกล้ครบกำหนด)</option>
                <option value="DUE_TODAY_REMINDER">DUE_TODAY_REMINDER (ครบกำหนดวันนี้)</option>
                <option value="OVERDUE_REMINDER">OVERDUE_REMINDER (เกินกำหนดคืน)</option>
                <option value="RETURN_CONFIRMATION">RETURN_CONFIRMATION (ส่งคืนสำเร็จ)</option>
                <option value="DAMAGED_LOST_ALERT">DAMAGED_LOST_ALERT (ชำรุด/สูญหาย)</option>
                <option value="TEST_EMAIL">TEST_EMAIL (ทดสอบระบบ)</option>
              </select>

              {(mailSearch || mailFilterStatus !== 'ALL' || mailFilterType !== 'ALL') && (
                <button
                  type="button"
                  onClick={() => {
                    setMailSearch('');
                    setMailFilterStatus('ALL');
                    setMailFilterType('ALL');
                  }}
                  className="text-xs text-slate-500 hover:text-slate-800 underline font-semibold min-h-[44px] inline-flex items-center justify-center px-2"
                >
                  ล้างตัวกรอง
                </button>
              )}
            </div>

            {mailLoading ? (
              <div className="p-8 text-center text-slate-500 font-medium">กำลังโหลดประวัติอีเมล...</div>
            ) : !filteredMailJobs.length ? (
              <div className="card text-center text-slate-400 py-10">
                {mailJobs.length ? 'ไม่พบรายการที่ตรงกับตัวกรองที่เลือก' : 'ยังไม่มีรายการงานส่งอีเมลในระบบ'}
              </div>
            ) : (
              <>
                {/* Mobile View: Responsive Stacked Cards (sm:hidden) */}
                <div className="block sm:hidden space-y-3">
                  {filteredMailJobs.map((job) => (
                    <div
                      key={`mob-${job.id}`}
                      className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm space-y-3"
                    >
                      {/* Top Row: Date & Status Badge */}
                      <div className="flex items-center justify-between gap-2 border-b border-slate-100 pb-2.5">
                        <span className="font-mono text-xs text-slate-500">
                          {fmtTs(job.createdAt)}
                        </span>
                        <span
                          className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-bold ${
                            job.status === 'SUCCESS'
                              ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                              : job.status === 'SKIPPED'
                              ? 'bg-slate-100 text-slate-600 border border-slate-300'
                              : job.status === 'FAILED' || job.status === 'ERROR'
                              ? 'bg-red-50 text-red-700 border border-red-200'
                              : job.status === 'RECONCILIATION_REQUIRED' || job.requiresReconciliation
                              ? 'bg-purple-50 text-purple-700 border border-purple-200'
                              : job.status === 'PROCESSING'
                              ? 'bg-blue-50 text-blue-700 border border-blue-200'
                              : 'bg-amber-50 text-amber-700 border border-amber-200'
                          }`}
                        >
                          <span
                            className={`h-1.5 w-1.5 rounded-full ${
                              job.status === 'SUCCESS'
                                ? 'bg-emerald-500'
                                : job.status === 'SKIPPED'
                                ? 'bg-slate-400'
                                : job.status === 'FAILED' || job.status === 'ERROR'
                                ? 'bg-red-500'
                                : job.status === 'RECONCILIATION_REQUIRED' || job.requiresReconciliation
                                ? 'bg-purple-500'
                                : job.status === 'PROCESSING'
                                ? 'bg-blue-500'
                                : 'bg-amber-500'
                            }`}
                          />
                          {job.status === 'SUCCESS'
                            ? 'ส่งสำเร็จ'
                            : job.status === 'SKIPPED'
                            ? 'ข้ามแล้ว'
                            : job.status === 'RECONCILIATION_REQUIRED' || job.requiresReconciliation
                            ? '⚠️ ตรวจสอบ'
                            : job.status === 'PROCESSING'
                            ? 'กำลังส่ง...'
                            : job.status === 'FAILED' || job.status === 'ERROR'
                            ? 'ส่งไม่สำเร็จ'
                            : 'รอดำเนินการ'}
                        </span>
                      </div>

                      {/* Subject */}
                      <div>
                        <div className="font-bold text-slate-900 text-sm leading-snug break-words">
                          {job.message?.subject || '-'}
                        </div>
                      </div>

                      {/* Recipient & Type */}
                      <div className="space-y-1.5 text-xs">
                        <div className="flex items-start gap-1.5 text-slate-600">
                          <span className="font-semibold text-slate-500 flex-shrink-0">ถึง:</span>
                          <span className="font-mono text-slate-800 break-all font-medium">
                            {job.to?.join(', ')}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="inline-flex rounded-md bg-slate-100 px-2 py-0.5 font-mono text-[11px] font-bold text-slate-700">
                            {job.type || 'NOTIFICATION'}
                          </span>
                          {typeof job.attempts === 'number' && job.attempts > 0 && (
                            <span className="text-[11px] text-slate-400 font-mono">
                              (ครั้งที่ {job.attempts})
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Error or Skip details */}
                      {job.errorDetails && (
                        <div className="text-xs text-red-600 bg-red-50 p-2.5 rounded-lg border border-red-200 break-words">
                          {job.errorDetails}
                        </div>
                      )}
                      {job.skipReason && (
                        <div className="text-xs text-slate-600 bg-slate-50 p-2.5 rounded-lg border border-slate-200 break-words">
                          ℹ️ {job.skipReason}
                        </div>
                      )}

                      {/* Action Buttons: 44px touch targets */}
                      <div className="grid grid-cols-2 gap-2 pt-1 border-t border-slate-100">
                        <button
                          type="button"
                          onClick={() => handleRetryEmail(job)}
                          disabled={retryingJobId === job.id}
                          className="btn-outline text-xs min-h-[44px] flex items-center justify-center gap-1.5 text-emerald-700 border-emerald-300 hover:bg-emerald-50 font-bold"
                          title="ยิงส่งอีเมลไปยังผู้รับทันที"
                        >
                          <RefreshCw className={`h-3.5 w-3.5 ${retryingJobId === job.id ? 'animate-spin' : ''}`} />
                          <span>{retryingJobId === job.id ? 'กำลังส่ง...' : 'ส่งทันที'}</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => setPreviewMail(job)}
                          className="btn-outline text-xs min-h-[44px] flex items-center justify-center gap-1.5 font-bold"
                        >
                          <Eye className="h-4 w-4" />
                          <span>ดู HTML</span>
                        </button>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Desktop View: Clean Table (hidden on mobile) */}
                <div className="hidden sm:block card overflow-x-auto p-0 border border-slate-200">
                  <table className="w-full text-left text-sm">
                    <thead className="border-b border-slate-200 bg-slate-50 text-xs font-bold uppercase text-slate-600">
                      <tr>
                        <th className="px-4 py-3.5 whitespace-nowrap">วัน-เวลา</th>
                        <th className="px-4 py-3.5">ผู้รับ (To)</th>
                        <th className="px-4 py-3.5">ประเภท</th>
                        <th className="px-4 py-3.5">หัวข้ออีเมล (Subject)</th>
                        <th className="px-4 py-3.5">สถานะ</th>
                        <th className="px-4 py-3.5 text-right whitespace-nowrap">การจัดการ</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {filteredMailJobs.map((job) => (
                        <tr key={job.id} className="hover:bg-slate-50/70 transition">
                          <td className="px-4 py-3 font-mono text-xs text-slate-500 whitespace-nowrap">
                            {fmtTs(job.createdAt)}
                          </td>
                          <td className="px-4 py-3 font-mono text-xs font-semibold text-slate-800 break-all max-w-[200px]">
                            {job.to?.join(', ')}
                          </td>
                          <td className="px-4 py-3">
                            <span className="inline-flex rounded-md bg-slate-100 px-2 py-0.5 font-mono text-[11px] font-bold text-slate-700 whitespace-nowrap">
                              {job.type || 'NOTIFICATION'}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-xs font-bold text-slate-900 max-w-xs break-words">
                            {job.message?.subject || '-'}
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex flex-col gap-1">
                              <span
                                className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-bold w-fit whitespace-nowrap ${
                                  job.status === 'SUCCESS'
                                    ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                                    : job.status === 'SKIPPED'
                                    ? 'bg-slate-100 text-slate-600 border border-slate-300'
                                    : job.status === 'FAILED' || job.status === 'ERROR'
                                    ? 'bg-red-50 text-red-700 border border-red-200'
                                    : job.status === 'RECONCILIATION_REQUIRED' || job.requiresReconciliation
                                    ? 'bg-purple-50 text-purple-700 border border-purple-200'
                                    : job.status === 'PROCESSING'
                                    ? 'bg-blue-50 text-blue-700 border border-blue-200'
                                    : 'bg-amber-50 text-amber-700 border border-amber-200'
                                }`}
                              >
                                <span
                                  className={`h-1.5 w-1.5 rounded-full ${
                                    job.status === 'SUCCESS'
                                      ? 'bg-emerald-500'
                                      : job.status === 'SKIPPED'
                                      ? 'bg-slate-400'
                                      : job.status === 'FAILED' || job.status === 'ERROR'
                                      ? 'bg-red-500'
                                      : job.status === 'RECONCILIATION_REQUIRED' || job.requiresReconciliation
                                      ? 'bg-purple-500'
                                      : job.status === 'PROCESSING'
                                      ? 'bg-blue-500'
                                      : 'bg-amber-500'
                                  }`}
                                />
                                {job.status === 'SUCCESS'
                                  ? 'ส่งสำเร็จ'
                                  : job.status === 'SKIPPED'
                                  ? 'ข้ามแล้ว (สถานะล้าสมัย/ซ้ำ)'
                                  : job.status === 'RECONCILIATION_REQUIRED' || job.requiresReconciliation
                                  ? '⚠️ ตรวจสอบก่อนส่ง'
                                  : job.status === 'PROCESSING'
                                  ? 'กำลังส่ง...'
                                  : job.status === 'FAILED' || job.status === 'ERROR'
                                  ? 'ส่งไม่สำเร็จ'
                                  : 'รอดำเนินการ (Queued)'}
                              </span>
                              {job.errorDetails && (
                                <span className="text-[10px] text-red-600 max-w-xs truncate" title={job.errorDetails}>
                                  {job.errorDetails}
                                </span>
                              )}
                              {job.skipReason && (
                                <span className="text-[10px] text-slate-500 max-w-xs truncate" title={job.skipReason}>
                                  ℹ️ {job.skipReason}
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-3 text-right whitespace-nowrap">
                            <div className="flex items-center justify-end gap-1.5">
                              <button
                                type="button"
                                onClick={() => handleRetryEmail(job)}
                                disabled={retryingJobId === job.id}
                                className="btn-outline text-xs min-h-[36px] py-1.5 px-3 inline-flex items-center gap-1.5 text-emerald-700 hover:bg-emerald-50 font-bold"
                                title="ยิงส่งอีเมลไปยังผู้รับทันที"
                              >
                                <RefreshCw className={`h-3 w-3 ${retryingJobId === job.id ? 'animate-spin' : ''}`} />
                                <span>{retryingJobId === job.id ? 'กำลังส่ง...' : 'ส่งทันที'}</span>
                              </button>
                              <button
                                type="button"
                                onClick={() => setPreviewMail(job)}
                                className="btn-outline text-xs min-h-[36px] py-1.5 px-3 inline-flex items-center gap-1.5 font-bold"
                              >
                                <Eye className="h-3.5 w-3.5" />
                                <span>ดู HTML</span>
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* TAB 6: AUDIT LOGS */}
      {activeTab === 'audit' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-base font-bold text-slate-900">บันทึกประวัติกิจกรรมของระบบ (Audit Logs)</h3>
              <p className="text-xs text-slate-500 font-medium">
                รายการประวัติการเพิ่ม ลบ แก้ไข อนุมัติ และส่งคืนครุภัณฑ์
              </p>
            </div>
          </div>

          {auditLoading ? (
            <div className="p-8 text-center text-slate-500">กำลังโหลดประวัติ...</div>
          ) : !auditLogs.length ? (
            <div className="card text-center text-slate-400 py-10">
              ยังไม่มีประวัติกิจกรรมในระบบ
            </div>
          ) : (
            <div className="card overflow-x-auto p-0 border border-slate-200">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-slate-200 bg-slate-50 text-xs font-bold uppercase text-slate-600">
                  <tr>
                    <th className="px-4 py-3.5">วัน-เวลา</th>
                    <th className="px-4 py-3.5">ผู้ดำเนินการ</th>
                    <th className="px-4 py-3.5">การกระทำ (Action)</th>
                    <th className="px-4 py-3.5">เป้าหมาย (Target)</th>
                    <th className="px-4 py-3.5">รายละเอียด</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {auditLogs.map((log) => (
                    <tr key={log.id} className="hover:bg-slate-50/70 transition">
                      <td className="px-4 py-3 font-mono text-xs text-slate-500">
                        {fmtTs(log.timestamp)}
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-bold text-slate-900 text-xs">{log.actorName || log.actor}</div>
                        <div className="font-mono text-[11px] text-slate-400">{log.actorEmail}</div>
                      </td>
                      <td className="px-4 py-3">
                        <span className="inline-flex rounded-md bg-slate-100 px-2 py-0.5 font-mono text-xs font-bold text-slate-700">
                          {log.action}
                        </span>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-brand-700 font-semibold">
                        {log.targetType}: {log.targetId}
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-600">
                        {log.details ? JSON.stringify(log.details) : '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* TAB 7: BACKUP & SYSTEM RESET */}
      {activeTab === 'backup' && (
        <div className="grid gap-6 md:grid-cols-2">
          {/* Backup */}
          <div className="card space-y-4">
            <div className="flex items-center gap-3">
              <div className="rounded-xl bg-brand-50 p-3 text-brand-600">
                <Download className="h-6 w-6" />
              </div>
              <div>
                <h3 className="font-bold text-slate-900">ส่งออกข้อมูลสำรอง (Backup JSON)</h3>
                <p className="text-xs text-slate-500 font-medium">
                  ดาวน์โหลดข้อมูลครุภัณฑ์ บุคลากร คำขอยืม และหมวดหมู่ทั้งหมดเป็นไฟล์ JSON
                </p>
              </div>
            </div>

            <p className="text-xs text-slate-600 leading-relaxed bg-slate-50 p-3 rounded-xl border border-slate-200/60">
              การสำรองข้อมูลช่วยให้สามารถกู้คืนฐานข้อมูลครุภัณฑ์และรายการคำขอย้อนหลังได้ทุกเมื่อ
            </p>

            <button
              type="button"
              onClick={handleExportBackup}
              disabled={exporting}
              className="btn-primary w-full"
            >
              {exporting ? 'กำลังส่งออกข้อมูล...' : 'ดาวน์โหลดไฟล์สำรองข้อมูล (JSON)'}
            </button>
          </div>

          {/* Reset / Sync Master Data */}
          <div className="card space-y-4 border-amber-200 bg-amber-50/30">
            <div className="flex items-center gap-3">
              <div className="rounded-xl bg-amber-100 p-3 text-amber-700">
                <RotateCcw className="h-6 w-6" />
              </div>
              <div>
                <h3 className="font-bold text-slate-900">ซิงค์ / รีเซ็ตข้อมูลตั้งต้น (Sync Master Data)</h3>
                <p className="text-xs text-slate-500 font-medium">
                  ซิงค์รายชื่อบุคลากร 30 ท่าน และกลุ่มงาน 13 ฝ่ายตามตารางทางการ
                </p>
              </div>
            </div>

            <p className="text-xs text-amber-900 leading-relaxed bg-amber-50 p-3 rounded-xl border border-amber-200/80 font-medium">
              ระบบจะอัปเดตข้อมูลรายชื่อและโครงสร้างฝ่ายงานให้ตรงกับฐานข้อมูลของสำนักบริการวิชาการ โดยไม่ลบคำขอยืมเดิม
            </p>

            <button
              type="button"
              onClick={handleResetMasterData}
              disabled={resetting}
              className="btn-outline w-full border-amber-400 text-amber-900 hover:bg-amber-100 font-bold"
            >
              {resetting ? 'กำลังซิงค์ข้อมูล...' : 'ซิงค์ข้อมูลบุคลากรและกลุ่มงาน'}
            </button>

            {resetMsg && (
              <div className="text-xs font-bold text-emerald-700 text-center">{resetMsg}</div>
            )}
          </div>
        </div>
      )}

      {/* MODAL: EDIT USER */}
      <Modal
        open={userModalOpen}
        onClose={() => setUserModalOpen(false)}
        title={userForm.email ? `แก้ไขข้อมูลบุคลากร: ${userForm.name}` : 'เพิ่มบุคลากรใหม่'}
      >
        <form onSubmit={handleSaveUser} className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">รหัสบุคลากร *</label>
              <input
                type="text"
                className="input"
                value={userForm.employeeCode || ''}
                onChange={(e) => setUserForm({ ...userForm, employeeCode: e.target.value })}
                required
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">อีเมล @kku.ac.th *</label>
              <input
                type="email"
                className="input"
                value={userForm.email || ''}
                onChange={(e) => setUserForm({ ...userForm, email: e.target.value })}
                required
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1">ชื่อ - สกุล (พร้อมคำนำหน้า) *</label>
            <input
              type="text"
              className="input"
              value={userForm.name || ''}
              onChange={(e) => setUserForm({ ...userForm, name: e.target.value })}
              required
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">ตำแหน่ง</label>
              <input
                type="text"
                className="input"
                value={userForm.position || ''}
                onChange={(e) => setUserForm({ ...userForm, position: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">กลุ่มงาน / ภารกิจ</label>
              <input
                type="text"
                className="input"
                value={userForm.mission || ''}
                onChange={(e) => setUserForm({ ...userForm, mission: e.target.value })}
              />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">สิทธิ์การใช้งาน (Role) *</label>
              <select
                className="input"
                value={userForm.role || 'USER'}
                onChange={(e) => setUserForm({ ...userForm, role: e.target.value as Role })}
              >
                <option value="USER">ผู้ใช้ทั่วไป (USER)</option>
                <option value="CUSTODIAN">ผู้ดูแลพัสดุ (CUSTODIAN - ชาลี)</option>
                <option value="APPROVER">ผู้อนุมัติ (APPROVER - ประหยัด)</option>
                <option value="EXECUTIVE">ผู้บริหาร (EXECUTIVE - ทิวากร/ผอ.)</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">สถานะผู้ใช้</label>
              <select
                className="input"
                value={userForm.active ? 'active' : 'inactive'}
                onChange={(e) => setUserForm({ ...userForm, active: e.target.value === 'active' })}
              >
                <option value="active">เปิดใช้งาน (Active)</option>
                <option value="inactive">ปิดใช้งาน (Inactive)</option>
              </select>
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-3 border-t border-slate-100">
            <button
              type="button"
              className="btn-outline text-xs"
              onClick={() => setUserModalOpen(false)}
            >
              ยกเลิก
            </button>
            <button type="submit" disabled={userSaving} className="btn-primary text-xs">
              {userSaving ? 'กำลังบันทึก...' : 'บันทึกข้อมูลบุคลากร'}
            </button>
          </div>
        </form>
      </Modal>

      {/* MODAL: CATEGORY */}
      <Modal
        open={catModalOpen}
        onClose={() => setCatModalOpen(false)}
        title={catForm.isNew ? 'เพิ่มหมวดหมู่ครุภัณฑ์ใหม่' : `แก้ไขหมวดหมู่: ${catForm.name}`}
      >
        <form onSubmit={handleSaveCategory} className="space-y-4">
          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1">ชื่อหมวดหมู่ *</label>
            <input
              type="text"
              className="input"
              placeholder="เช่น โสตทัศนูปกรณ์, เครื่องคอมพิวเตอร์..."
              value={catForm.name}
              onChange={(e) => setCatForm({ ...catForm, name: e.target.value })}
              required
            />
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              className="btn-outline text-xs"
              onClick={() => setCatModalOpen(false)}
            >
              ยกเลิก
            </button>
            <button type="submit" disabled={catSaving} className="btn-primary text-xs">
              {catSaving ? 'กำลังบันทึก...' : 'บันทึกหมวดหมู่'}
            </button>
          </div>
        </form>
      </Modal>

      {/* MODAL: DEPARTMENT */}
      <Modal
        open={deptModalOpen}
        onClose={() => setDeptModalOpen(false)}
        title={deptForm.isNew ? 'เพิ่มกลุ่มงานใหม่' : `แก้ไขกลุ่มงาน: ${deptForm.name}`}
      >
        <form onSubmit={handleSaveDept} className="space-y-4">
          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1">รหัสกลุ่มงาน *</label>
            <input
              type="text"
              className="input"
              placeholder="เช่น 02-1, 03-2"
              value={deptForm.code}
              onChange={(e) => setDeptForm({ ...deptForm, code: e.target.value })}
              required
            />
          </div>
          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1">ชื่อกลุ่มงาน / ภารกิจ *</label>
            <input
              type="text"
              className="input"
              placeholder="เช่น ภารกิจแผน การเงิน และพัสดุ"
              value={deptForm.name}
              onChange={(e) => setDeptForm({ ...deptForm, name: e.target.value })}
              required
            />
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              className="btn-outline text-xs"
              onClick={() => setDeptModalOpen(false)}
            >
              ยกเลิก
            </button>
            <button type="submit" disabled={deptSaving} className="btn-primary text-xs">
              {deptSaving ? 'กำลังบันทึก...' : 'บันทึกกลุ่มงาน'}
            </button>
          </div>
        </form>
      </Modal>

      {/* MODAL: PREVIEW EMAIL */}
      <Modal
        open={!!previewMail}
        onClose={() => setPreviewMail(null)}
        title={previewMail?.message?.subject || 'ตัวอย่างเนื้อหา Email'}
      >
        {previewMail && (
          <div className="space-y-4 max-w-full">
            <div className="rounded-xl bg-slate-50 p-3.5 text-xs space-y-2 border border-slate-200 break-words">
              <div className="flex flex-col sm:flex-row sm:items-center sm:gap-2">
                <span className="font-bold text-slate-600 flex-shrink-0">ผู้รับ (To): </span>
                <span className="font-mono text-slate-900 break-all">{previewMail.to?.join(', ')}</span>
              </div>
              <div className="flex flex-col sm:flex-row sm:items-center sm:gap-2">
                <span className="font-bold text-slate-600 flex-shrink-0">เวลาที่สร้าง: </span>
                <span className="text-slate-900">{fmtTs(previewMail.createdAt)}</span>
              </div>
              <div className="flex flex-col sm:flex-row sm:items-center sm:gap-2">
                <span className="font-bold text-slate-600 flex-shrink-0">ประเภท: </span>
                <span className="font-mono text-brand-700 font-bold">{previewMail.type}</span>
              </div>
            </div>

            <div className="rounded-xl border border-slate-200 p-1 sm:p-2 bg-white max-h-[50vh] sm:max-h-96 overflow-y-auto">
              <iframe
                title="Email Preview"
                srcDoc={previewMail.message?.html}
                className="w-full h-64 sm:h-80 border-0 rounded-lg"
                sandbox=""
              />
            </div>

            <div className="flex justify-end pt-2">
              <button
                type="button"
                className="btn-outline text-xs min-h-[44px] w-full sm:w-auto flex items-center justify-center px-4 font-bold"
                onClick={() => setPreviewMail(null)}
              >
                ปิดหน้าต่าง
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
