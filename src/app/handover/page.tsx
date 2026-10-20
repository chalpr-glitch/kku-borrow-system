'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Scan,
  RotateCcw,
  CheckCircle2,
  Clock,
  AlertTriangle,
  Search,
  ArrowRight,
  Package,
  User,
  Calendar,
  Wrench,
  Camera,
  Image as ImageIcon,
  Trash2,
  FileText,
  Upload,
  Plus,
} from 'lucide-react';
import AppShell from '@/components/AppShell';
import { Alert, EmptyState, LoadingState, Modal, StatCard, StatusBadge, TableSkeleton } from '@/components/ui';
import { RepairFormModal } from '@/components/RepairFormModal';
import { useAuth } from '@/lib/auth-context';
import { useAllRequests } from '@/lib/hooks';
import { handoverRequest, returnRequest } from '@/lib/requests';
import { uploadEquipmentImage } from '@/lib/equipment';
import type { BorrowRequest, ReturnCondition } from '@/lib/types';
import { daysUntil, errMsg, fmtDate, sortByCreatedDesc, todayStr } from '@/lib/utils';
import QrScannerModal from '@/components/QrScannerModal';

export default function HandoverPage() {
  return (
    <AppShell title="จัดการรายการยืม-คืนครุภัณฑ์ (Admin Dashboard)" roles={['CUSTODIAN', 'APPROVER', 'EXECUTIVE']}>
      <HandoverContent />
    </AppShell>
  );
}

function HandoverContent() {
  const { profile, loading: authLoading } = useAuth();
  const { data: allRequests, loading } = useAllRequests();

  const [tab, setTab] = useState<'in_use' | 'pickup' | 'history'>('in_use');
  const [q, setQ] = useState('');
  const [qrScannerOpen, setQrScannerOpen] = useState(false);

  // Modals
  const [handoverModalReq, setHandoverModalReq] = useState<BorrowRequest | null>(null);
  const [returnModalReq, setReturnModalReq] = useState<BorrowRequest | null>(null);

  if (authLoading || !profile) {
    return <LoadingState text="กำลังโหลดข้อมูล..." />;
  }

  const me = profile;

  // Return Form State
  const [returnCondition, setReturnCondition] = useState<ReturnCondition>('NORMAL');
  const [returnRemarks, setReturnRemarks] = useState('');

  // Damaged Subform State (แบบฟอร์มแจ้งซ่อมแซม)
  const [damageSymptom, setDamageSymptom] = useState('');
  const [damageDetails, setDamageDetails] = useState('');
  const [damageCause, setDamageCause] = useState('');
  const [damagedAccessories, setDamagedAccessories] = useState<string[]>([]);
  const [customDamagedAcc, setCustomDamagedAcc] = useState('');
  const [damagePhotos, setDamagePhotos] = useState<string[]>([]);

  // Lost Subform State (รายงานสูญหาย)
  const [lostIncidentDate, setLostIncidentDate] = useState(todayStr());
  const [lostLocation, setLostLocation] = useState('');
  const [lostDetails, setLostDetails] = useState('');
  const [lostPoliceReportNo, setLostPoliceReportNo] = useState('');
  const [lostLiabilityAccepted, setLostLiabilityAccepted] = useState(false);
  const [lostPhotos, setLostPhotos] = useState<string[]>([]);

  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [repairModalOpen, setRepairModalOpen] = useState(false);
  const [repairModalEquipments, setRepairModalEquipments] = useState<any[]>([]);

  // Handover Form State
  const [handoverAcc, setHandoverAcc] = useState('');
  const [handoverNote, setHandoverNote] = useState('สภาพสมบูรณ์');

  const openReturnModal = (r: BorrowRequest) => {
    setReturnModalReq(r);
    setReturnCondition('NORMAL');
    setReturnRemarks('');
    setDamageSymptom('');
    setDamageDetails('');
    setDamageCause('');
    setDamagedAccessories([]);
    setCustomDamagedAcc('');
    setDamagePhotos([]);
    setLostIncidentDate(todayStr());
    setLostLocation('');
    setLostDetails('');
    setLostPoliceReportNo('');
    setLostLiabilityAccepted(false);
    setLostPhotos([]);
    setError(null);
  };

  const handlePhotoUpload = async (e: React.ChangeEvent<HTMLInputElement>, type: 'damage' | 'lost') => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setUploadingPhoto(true);
    setError(null);
    try {
      const currentList = type === 'damage' ? damagePhotos : lostPhotos;
      if (currentList.length >= 4) {
        throw new Error('สามารถแนบรูปภาพได้สูงสุด 4 รูป');
      }
      const newPhotos: string[] = [];
      for (let i = 0; i < files.length; i++) {
        if (currentList.length + newPhotos.length >= 4) break;
        const file = files[i];
        const compressed = await uploadEquipmentImage(file);
        newPhotos.push(compressed);
      }
      if (type === 'damage') {
        setDamagePhotos((prev) => [...prev, ...newPhotos]);
      } else {
        setLostPhotos((prev) => [...prev, ...newPhotos]);
      }
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setUploadingPhoto(false);
      e.target.value = '';
    }
  };

  const removePhoto = (index: number, type: 'damage' | 'lost') => {
    if (type === 'damage') {
      setDamagePhotos((prev) => prev.filter((_, i) => i !== index));
    } else {
      setLostPhotos((prev) => prev.filter((_, i) => i !== index));
    }
  };

  const toggleDamagedAcc = (acc: string) => {
    setDamagedAccessories((prev) =>
      prev.includes(acc) ? prev.filter((x) => x !== acc) : [...prev, acc]
    );
  };

  const pickupList = useMemo(() => {
    return allRequests
      .filter((r) => r.status === 'APPROVED_WAITING_PICKUP')
      .sort((a, b) => a.startDate.localeCompare(b.startDate));
  }, [allRequests]);

  const inUseList = useMemo(() => {
    return allRequests
      .filter((r) => ['IN_USE', 'OVERDUE'].includes(r.status))
      .sort((a, b) => a.expectedReturnDate.localeCompare(b.expectedReturnDate));
  }, [allRequests]);

  const historyList = useMemo(() => {
    return sortByCreatedDesc(
      allRequests.filter((r) =>
        ['RETURNED', 'RETURNED_DAMAGED', 'LOST', 'CANCELLED', 'REJECTED', 'REVIEW_REJECTED'].includes(
          r.status
        )
      )
    );
  }, [allRequests]);

  const activeList = tab === 'in_use' ? inUseList : tab === 'pickup' ? pickupList : historyList;

  const filteredList = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return activeList;
    return activeList.filter((r) =>
      [r.id, r.borrower.name, r.equipment.name, r.equipment.assetNumber].some((x) =>
        x?.toLowerCase().includes(s)
      )
    );
  }, [activeList, q]);

  const overdueCount = inUseList.filter((r) => r.status === 'OVERDUE').length;

  const handleReturnSubmit = async () => {
    if (!returnModalReq) return;
    setBusy(true);
    setError(null);
    try {
      if (returnCondition === 'DAMAGED') {
        if (!damageSymptom.trim()) {
          throw new Error('กรุณาระบุอาการเสีย / ความเสียหายของครุภัณฑ์');
        }
        const accList = [...damagedAccessories];
        if (customDamagedAcc.trim() && !accList.includes(customDamagedAcc.trim())) {
          accList.push(customDamagedAcc.trim());
        }
        await returnRequest(returnModalReq, me, {
          condition: 'DAMAGED',
          remarks: returnRemarks.trim() || damageSymptom.trim(),
          damageReport: {
            symptom: damageSymptom.trim(),
            damageDetails: damageDetails.trim() || undefined,
            cause: damageCause.trim() || undefined,
            damagedAccessories: accList.length > 0 ? accList : undefined,
            photos: damagePhotos.length > 0 ? damagePhotos : undefined,
          },
        });
      } else if (returnCondition === 'LOST') {
        if (!lostDetails.trim()) {
          throw new Error('กรุณาระบุรายละเอียดเหตุการณ์สูญหาย');
        }
        await returnRequest(returnModalReq, me, {
          condition: 'LOST',
          remarks: returnRemarks.trim() || `สูญหาย: ${lostDetails.trim()}`,
          lostReport: {
            incidentDate: lostIncidentDate || todayStr(),
            location: lostLocation.trim() || undefined,
            incidentDetails: lostDetails.trim(),
            policeReportNo: lostPoliceReportNo.trim() || undefined,
            borrowerLiabilityAccepted: lostLiabilityAccepted,
            photos: lostPhotos.length > 0 ? lostPhotos : undefined,
          },
        });
      } else {
        await returnRequest(returnModalReq, me, {
          condition: 'NORMAL',
          remarks: returnRemarks.trim(),
        });
      }

      const returnedReq = returnModalReq;
      const isDamaged = returnCondition === 'DAMAGED';
      const isLost = returnCondition === 'LOST';

      setSuccessMsg(
        isDamaged
          ? `บันทึกรับคืน ${returnedReq.equipment.name} (${returnedReq.equipment.assetNumber}) เรียบร้อยแล้ว (สถานะครุภัณฑ์: ส่งซ่อมบำรุง)`
          : isLost
          ? `บันทึกรับคืน ${returnedReq.equipment.name} (${returnedReq.equipment.assetNumber}) สถานะสูญหายเรียบร้อยแล้ว`
          : `บันทึกรับคืน ${returnedReq.equipment.name} (${returnedReq.equipment.assetNumber}) เรียบร้อยแล้ว ครุภัณฑ์กลับมาเป็นสถานะ "ว่างพร้อมยืม"`
      );

      if (isDamaged) {
        setRepairModalEquipments([
          {
            equipment: returnedReq.equipment,
            symptom: damageSymptom.trim() || returnRemarks.trim() || 'ชำรุดจากการยืมใช้งาน / ส่งซ่อมบำรุง',
            responsiblePerson: returnedReq.borrower.name || me.name,
          },
        ]);
        setRepairModalOpen(true);
      }

      setReturnModalReq(null);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const handleHandoverSubmit = async () => {
    if (!handoverModalReq) return;
    setBusy(true);
    setError(null);
    try {
      await handoverRequest(handoverModalReq, me, {
        accessories: handoverAcc.split(',').map((s) => s.trim()).filter(Boolean),
        conditionNote: handoverNote,
      });
      setSuccessMsg(
        `บันทึกส่งมอบ ${handoverModalReq.equipment.name} ให้แก่ ${handoverModalReq.borrower.name} เรียบร้อยแล้ว`
      );
      setHandoverModalReq(null);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const handleQrScan = (decodedText: string) => {
    const text = decodedText.trim();
    let reqId = text;
    if (text.includes('id=')) {
      const match = text.match(/id=([^&]+)/);
      if (match) reqId = decodeURIComponent(match[1]);
    }

    const matchedReq = allRequests.find(
      (r) =>
        r.id === reqId ||
        r.equipment.assetNumber === text ||
        r.equipment.equipmentId === text
    );

    if (matchedReq) {
      if (matchedReq.status === 'APPROVED_WAITING_PICKUP') {
        setTab('pickup');
        setHandoverModalReq(matchedReq);
        setHandoverAcc(matchedReq.review?.accessoriesToHandover?.join(', ') || '');
      } else if (['IN_USE', 'OVERDUE'].includes(matchedReq.status)) {
        setTab('in_use');
        openReturnModal(matchedReq);
      } else {
        setTab('history');
        setQ(matchedReq.id);
      }
    } else {
      setQ(text);
    }
  };

  return (
    <div className="space-y-6">
      {successMsg && <Alert kind="success">{successMsg}</Alert>}

      {/* Top Stat Overview */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="กำลังถูกยืม (รอรับคืน)"
          value={inUseList.length}
          hint="รายการที่อยู่ระหว่างนำไปใช้"
          tone="sky"
        />
        <StatCard
          label="เกินกำหนดคืน (Overdue)"
          value={overdueCount}
          hint={overdueCount > 0 ? '⚠️ เกินกำหนดส่งคืน' : 'ไม่มีรายการค้างส่ง'}
          tone={overdueCount > 0 ? 'red' : 'green'}
        />
        <StatCard
          label="อนุมัติแล้ว รอส่งมอบ"
          value={pickupList.length}
          hint="ผู้ยืมเตรียมมารับของ"
          tone="amber"
        />
        <StatCard
          label="ส่งคืนเรียบร้อยแล้ว"
          value={historyList.filter((r) => r.status === 'RETURNED').length}
          hint="ประวัติการยืม-คืนสำเร็จ"
          tone="slate"
        />
      </div>

      {/* Tabs & Search Bar */}
      <div className="card space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-4">
          <div className="flex flex-wrap gap-2">
            <button
              className={`rounded-xl px-4 py-2 text-sm font-bold transition ${
                tab === 'in_use'
                  ? 'bg-brand-600 text-white shadow-sm'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
              onClick={() => setTab('in_use')}
            >
              🔄 กำลังถูกยืม / รอรับคืน ({inUseList.length})
              {overdueCount > 0 && (
                <span className="ml-1.5 rounded-full bg-red-600 px-2 py-0.5 text-xs text-white">
                  เกิน {overdueCount}
                </span>
              )}
            </button>
            <button
              className={`rounded-xl px-4 py-2 text-sm font-bold transition ${
                tab === 'pickup'
                  ? 'bg-brand-600 text-white shadow-sm'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
              onClick={() => setTab('pickup')}
            >
              📤 รอส่งมอบ ({pickupList.length})
            </button>
            <button
              className={`rounded-xl px-4 py-2 text-sm font-bold transition ${
                tab === 'history'
                  ? 'bg-brand-600 text-white shadow-sm'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
              onClick={() => setTab('history')}
            >
              📋 ประวัติทั้งหมด ({historyList.length})
            </button>
          </div>

          <div className="flex items-center gap-2 w-full sm:w-auto">
            <button
              type="button"
              onClick={() => setQrScannerOpen(true)}
              className="btn-primary text-xs py-2 px-3.5 flex items-center gap-1.5 whitespace-nowrap shadow-xs"
            >
              <Scan className="h-4 w-4" /> สแกน QR รับ/คืน
            </button>
            <div className="relative flex-1 sm:w-64">
              <Search className="absolute left-3.5 top-2.5 h-4 w-4 text-slate-400" />
              <input
                className="input pl-10 text-xs py-2"
                placeholder="ค้นหาชื่อ, รหัสครุภัณฑ์..."
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
          </div>
        </div>

        {/* Data Table */}
        {loading ? (
          <div className="space-y-4">
            <LoadingState text="กำลังโหลดรายการส่งมอบ-รับคืน..." />
            <TableSkeleton rows={5} />
          </div>
        ) : !filteredList.length ? (
          <EmptyState
            title="ไม่พบรายการในหมวดนี้"
            description="ไม่มีคำขอยืมที่ตรงกับเงื่อนไขการค้นหาหรือสถานะที่เลือก"
          />
        ) : (
          <>
            {/* Desktop / Tablet Table View */}
            <div className="hidden sm:block overflow-x-auto rounded-2xl border border-slate-200 bg-white">
              <table className="min-w-full divide-y divide-slate-100 text-sm">
                <thead>
                  <tr>
                    <th className="th">เลขที่คำขอ</th>
                    <th className="th">ผู้ยืม / สังกัด</th>
                    <th className="th">ครุภัณฑ์</th>
                    <th className="th">กำหนดคืน</th>
                    <th className="th">สถานะ</th>
                    <th className="th text-right">ปุ่มจัดการด่วน</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredList.map((r) => {
                    const due = daysUntil(r.expectedReturnDate);
                    const isOverdue = r.status === 'OVERDUE';

                    return (
                      <tr key={r.id} className="transition hover:bg-slate-50/70">
                        <td className="td">
                          <Link
                            href={`/request/?id=${r.id}`}
                            className="font-mono font-bold text-brand-700 hover:underline"
                          >
                            {r.id}
                          </Link>
                        </td>
                        <td className="td">
                          <div className="font-bold text-slate-900">{r.borrower.name}</div>
                          <div className="text-xs text-slate-500 font-medium">
                            {r.borrower.mission}
                          </div>
                        </td>
                        <td className="td">
                          <div className="font-medium text-slate-800">{r.equipment.name}</div>
                          <div className="font-mono text-xs text-slate-500 font-medium">
                            {r.equipment.assetNumber}
                          </div>
                        </td>
                        <td className="td whitespace-nowrap">
                          <div className="font-medium text-slate-700">
                            {fmtDate(r.expectedReturnDate)}
                          </div>
                          {['IN_USE', 'OVERDUE'].includes(r.status) && (
                            <div className="text-xs mt-0.5">
                              {isOverdue ? (
                                <span className="font-bold text-red-600">
                                  เกินกำหนด {-due} วัน
                                </span>
                              ) : due === 0 ? (
                                <span className="font-bold text-orange-600">ครบกำหนดวันนี้</span>
                              ) : due <= 3 ? (
                                <span className="font-medium text-amber-700">
                                  อีก {due} วันครบกำหนด
                                </span>
                              ) : (
                                <span className="text-slate-500 font-medium">เหลืออีก {due} วัน</span>
                              )}
                            </div>
                          )}
                        </td>
                        <td className="td">
                          <StatusBadge status={r.status} />
                        </td>
                        <td className="td text-right whitespace-nowrap">
                          {r.status === 'APPROVED_WAITING_PICKUP' ? (
                            <button
                              onClick={() => {
                                setHandoverModalReq(r);
                                setHandoverAcc(
                                  (r.review?.accessoriesToHandover ?? []).join(', ')
                                );
                              }}
                              className="btn-primary text-xs py-1.5 px-3"
                            >
                              📤 บันทึกส่งมอบ
                            </button>
                          ) : ['IN_USE', 'OVERDUE'].includes(r.status) ? (
                            <button
                              onClick={() => openReturnModal(r)}
                              className="btn-success text-xs py-1.5 px-3 shadow-xs"
                            >
                              📥 กดรับคืน (เปลี่ยนเป็นว่าง)
                            </button>
                          ) : (
                            <div className="flex items-center justify-end gap-1.5">
                              {r.status === 'RETURNED_DAMAGED' && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setRepairModalEquipments([
                                      {
                                        equipment: r.equipment,
                                        symptom: r.returnInfo?.remarks || 'ตรวจพบชำรุดจากการยืมใช้งาน',
                                        responsiblePerson: r.borrower.name || me.name,
                                      },
                                    ]);
                                    setRepairModalOpen(true);
                                  }}
                                  className="btn-outline text-xs text-amber-800 border-amber-300 bg-amber-50 hover:bg-amber-100 py-1.5 px-2.5 flex items-center gap-1 shadow-2xs"
                                  title="พิมพ์แบบฟอร์มแจ้งซ่อมแซมอุปกรณ์"
                                >
                                  <Wrench className="h-3 w-3 text-amber-600" /> ใบแจ้งซ่อม
                                </button>
                              )}
                              <Link
                                href={`/request/?id=${r.id}`}
                                className="btn-outline text-xs py-1.5 px-3"
                              >
                                ดูรายละเอียด
                              </Link>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Mobile Card List View */}
            <div className="sm:hidden space-y-3">
              {filteredList.map((r) => {
                const due = daysUntil(r.expectedReturnDate);
                const isOverdue = r.status === 'OVERDUE';

                return (
                  <div
                    key={r.id}
                    className="rounded-2xl border border-slate-200 bg-white p-4 shadow-2xs space-y-3"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <Link
                        href={`/request/?id=${r.id}`}
                        className="font-mono font-bold text-sm text-brand-700 hover:underline"
                      >
                        {r.id}
                      </Link>
                      <StatusBadge status={r.status} />
                    </div>

                    <div className="space-y-1">
                      <div className="font-bold text-slate-900 text-base">{r.equipment.name}</div>
                      <div className="font-mono text-xs text-slate-500 font-medium">
                        รหัส: {r.equipment.assetNumber}
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-2 text-xs pt-2 border-t border-slate-100">
                      <div>
                        <span className="text-slate-500 block">ผู้ยืม:</span>
                        <span className="font-semibold text-slate-800">{r.borrower.name}</span>
                        <span className="text-slate-500 block text-[11px]">{r.borrower.mission}</span>
                      </div>
                      <div>
                        <span className="text-slate-500 block">กำหนดคืน:</span>
                        <span className="font-semibold text-slate-800">{fmtDate(r.expectedReturnDate)}</span>
                        {['IN_USE', 'OVERDUE'].includes(r.status) && (
                          <div className="mt-0.5">
                            {isOverdue ? (
                              <span className="font-bold text-red-600">เกินกำหนด {-due} วัน</span>
                            ) : due === 0 ? (
                              <span className="font-bold text-orange-600">ครบกำหนดวันนี้</span>
                            ) : due <= 3 ? (
                              <span className="font-medium text-amber-700">อีก {due} วัน</span>
                            ) : (
                              <span className="text-slate-500 font-medium">เหลืออีก {due} วัน</span>
                            )}
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="pt-2 border-t border-slate-100 flex items-center justify-end gap-2">
                      <Link
                        href={`/request/?id=${r.id}`}
                        className="btn-outline text-xs py-2 px-3 flex-1 text-center justify-center min-h-[38px]"
                      >
                        ดูรายละเอียด
                      </Link>
                      {r.status === 'APPROVED_WAITING_PICKUP' ? (
                        <button
                          onClick={() => {
                            setHandoverModalReq(r);
                            setHandoverAcc(
                              (r.review?.accessoriesToHandover ?? []).join(', ')
                            );
                          }}
                          className="btn-primary text-xs py-2 px-3 flex-1 justify-center min-h-[38px]"
                        >
                          📤 บันทึกส่งมอบ
                        </button>
                      ) : ['IN_USE', 'OVERDUE'].includes(r.status) ? (
                        <button
                          onClick={() => openReturnModal(r)}
                          className="btn-success text-xs py-2 px-3 flex-1 justify-center min-h-[38px] shadow-xs"
                        >
                          📥 กดรับคืน
                        </button>
                      ) : r.status === 'RETURNED_DAMAGED' ? (
                        <button
                          type="button"
                          onClick={() => {
                            setRepairModalEquipments([
                              {
                                equipment: r.equipment,
                                symptom: r.returnInfo?.remarks || 'ตรวจพบชำรุดจากการยืมใช้งาน',
                                responsiblePerson: r.borrower.name || me.name,
                              },
                            ]);
                            setRepairModalOpen(true);
                          }}
                          className="btn-outline text-xs text-amber-800 border-amber-300 bg-amber-50 hover:bg-amber-100 py-2 px-3 flex-1 justify-center min-h-[38px] flex items-center gap-1 shadow-2xs"
                        >
                          <Wrench className="h-3.5 w-3.5 text-amber-600" /> ใบแจ้งซ่อม
                        </button>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      {/* Modal: บันทึกรับคืนอุปกรณ์ (พร้อมฟอร์มแจ้งซ่อมและรายงานสูญหาย) */}
      <Modal
        open={!!returnModalReq}
        onClose={() => setReturnModalReq(null)}
        title={`ตรวจรับคืนครุภัณฑ์: ${returnModalReq?.equipment.name}`}
      >
        {returnModalReq && (
          <div className="space-y-4 max-h-[80vh] overflow-y-auto pr-1">
            {error && <Alert kind="error">{error}</Alert>}

            {/* บัตรข้อมูลครุภัณฑ์และผู้ยืม (ดึงข้อมูลอัตโนมัติ) */}
            <div className="rounded-2xl bg-slate-50 p-4 border border-slate-200/70 space-y-2 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-1 border-b border-slate-200/60 pb-2">
                <span className="text-slate-500 font-medium">ข้อมูลคำขอยืม</span>
                <span className="font-mono font-bold text-brand-700 bg-brand-50 px-2 py-0.5 rounded-md border border-brand-200/60">
                  {returnModalReq.id}
                </span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-slate-700">
                <div>
                  ผู้ยืม: <b className="text-slate-900">{returnModalReq.borrower.name}</b>
                  <div className="text-slate-500">{returnModalReq.borrower.mission || returnModalReq.borrower.division}</div>
                </div>
                <div>
                  ครุภัณฑ์: <b className="text-slate-900">{returnModalReq.equipment.name}</b>
                  <div className="font-mono text-slate-600">รหัส: {returnModalReq.equipment.assetNumber}</div>
                </div>
                <div>
                  วันที่เริ่มยืม: <b>{fmtDate(returnModalReq.startDate)}</b>
                </div>
                <div>
                  กำหนดส่งคืนเดิม: <b>{fmtDate(returnModalReq.expectedReturnDate)}</b>
                </div>
                <div className="sm:col-span-2 text-slate-600">
                  วันที่ตรวจรับคืน: <b className="text-brand-800">{fmtDate(todayStr())} (วันนี้)</b>
                </div>
                {returnModalReq.handover?.accessories && returnModalReq.handover.accessories.length > 0 && (
                  <div className="sm:col-span-2 pt-1 border-t border-slate-200/50 text-slate-600">
                    อุปกรณ์เสริมที่ส่งมอบไว้: <b className="text-slate-800">{returnModalReq.handover.accessories.join(', ')}</b>
                  </div>
                )}
              </div>
            </div>

            {/* เลือกผลตรวจสภาพอุปกรณ์ */}
            <div className="space-y-2">
              <label className="label">ผลการตรวจสภาพอุปกรณ์ที่ส่งคืน *</label>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 sm:gap-3">
                {[
                  ['NORMAL', '🟢 สมบูรณ์เรียบร้อย', 'ครุภัณฑ์ปกติ อุปกรณ์ครบ'],
                  ['DAMAGED', '🟠 ชำรุด/มีปัญหา', 'เปิดฟอร์มแจ้งซ่อม'],
                  ['LOST', '🔴 สูญหาย', 'เปิดรายงานสูญหาย'],
                ].map(([v, l, sub]) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setReturnCondition(v as ReturnCondition)}
                    className={`rounded-xl border p-3 text-xs font-bold transition text-left flex flex-col justify-center min-h-[48px] ${
                      returnCondition === v
                        ? v === 'NORMAL'
                          ? 'border-emerald-600 bg-emerald-50/80 text-emerald-950 shadow-xs ring-1 ring-emerald-500'
                          : v === 'DAMAGED'
                          ? 'border-amber-600 bg-amber-50/90 text-amber-950 shadow-xs ring-1 ring-amber-500'
                          : 'border-red-600 bg-red-50/90 text-red-950 shadow-xs ring-1 ring-red-500'
                        : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    <span>{l}</span>
                    <span className="text-[10px] font-normal text-slate-500 mt-0.5">{sub}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* กรณีที่ 1: ปกติสมบูรณ์ (NORMAL) */}
            {returnCondition === 'NORMAL' && (
              <div className="space-y-3 rounded-2xl bg-emerald-50/40 border border-emerald-200 p-4">
                <div className="flex items-center gap-2 text-emerald-900 font-bold text-xs">
                  <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                  สภาพครุภัณฑ์สมบูรณ์พร้อมให้บริการต่อ
                </div>
                <div>
                  <label className="label text-slate-700">หมายเหตุเพิ่มเติม (ถ้ามี)</label>
                  <input
                    className="input text-xs"
                    placeholder="เช่น ทำความสะอาดเรียบร้อย, อุปกรณ์ครบตามรายการ..."
                    value={returnRemarks}
                    onChange={(e) => setReturnRemarks(e.target.value)}
                  />
                </div>
              </div>
            )}

            {/* กรณีที่ 2: ชำรุด/มีปัญหา (DAMAGED) -> ฟอร์มแจ้งซ่อมแซมครุภัณฑ์ */}
            {returnCondition === 'DAMAGED' && (
              <div className="space-y-4 rounded-2xl bg-amber-50/50 border border-amber-300/80 p-4 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-amber-200 pb-3">
                  <div className="flex items-center gap-2 text-amber-900 font-bold text-sm">
                    <Wrench className="h-4 w-4 text-amber-700" />
                    <span>แบบฟอร์มแจ้งซ่อมแซมครุภัณฑ์</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setRepairModalEquipments([
                        {
                          equipment: returnModalReq.equipment,
                          symptom: damageSymptom.trim() || 'ชำรุดจากการยืมใช้งาน / ส่งซ่อมบำรุง',
                          responsiblePerson: returnModalReq.borrower.name || me.name,
                        },
                      ]);
                      setRepairModalOpen(true);
                    }}
                    className="btn-outline text-xs py-1.5 px-3 bg-white border-amber-300 text-amber-900 hover:bg-amber-100/60 flex items-center gap-1.5 shadow-2xs font-semibold"
                  >
                    <FileText className="h-3.5 w-3.5 text-amber-700" />
                    ดู/พิมพ์แบบฟอร์มราชการ (A4)
                  </button>
                </div>

                <div className="space-y-3">
                  <div>
                    <label className="label text-amber-950 font-bold">
                      อาการเสีย / ความเสียหายที่ตรวจพบ * <span className="text-red-600">(จำเป็น)</span>
                    </label>
                    <input
                      className="input text-xs"
                      placeholder="เช่น เปิดไม่ติด, หน้าจอแตก, เลนส์มีรอยร้าว, สวิตช์หลุดหลวม"
                      value={damageSymptom}
                      onChange={(e) => setDamageSymptom(e.target.value)}
                    />
                  </div>

                  <div>
                    <label className="label text-amber-950">รายละเอียดความเสียหายเพิ่มเติม</label>
                    <textarea
                      className="input min-h-[60px] text-xs"
                      placeholder="ระบุลักษณะรอยแตก หัก บิ่น คราบน้ำ หรือชิ้นส่วนที่ชำรุดอย่างละเอียด..."
                      value={damageDetails}
                      onChange={(e) => setDamageDetails(e.target.value)}
                    />
                  </div>

                  <div>
                    <label className="label text-amber-950">สาเหตุหรือหมายเหตุการชำรุด</label>
                    <textarea
                      className="input min-h-[50px] text-xs"
                      placeholder="เช่น ตกหล่นจากโต๊ะทำงานระหว่างใช้งาน, โดนละอองฝน, เกิดจากการเสื่อมสภาพ..."
                      value={damageCause}
                      onChange={(e) => setDamageCause(e.target.value)}
                    />
                  </div>

                  {/* อุปกรณ์เสริมที่ขาดหรือชำรุด */}
                  <div className="space-y-2">
                    <label className="label text-amber-950">
                      อุปกรณ์เสริมที่ขาดหรือเสียหาย
                    </label>
                    {returnModalReq.handover?.accessories && returnModalReq.handover.accessories.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {returnModalReq.handover.accessories.map((acc) => {
                          const isChecked = damagedAccessories.includes(acc);
                          return (
                            <button
                              key={acc}
                              type="button"
                              onClick={() => toggleDamagedAcc(acc)}
                              className={`rounded-lg px-2.5 py-1 text-xs font-medium border transition flex items-center gap-1.5 ${
                                isChecked
                                  ? 'bg-amber-600 text-white border-amber-600 shadow-2xs'
                                  : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-100'
                              }`}
                            >
                              <span>{isChecked ? '✓' : '+'}</span>
                              <span>{acc}</span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                    <input
                      className="input text-xs"
                      placeholder="ระบุอุปกรณ์เสริมอื่น ๆ ที่ชำรุดหรือขาดหาย (ถ้ามี)..."
                      value={customDamagedAcc}
                      onChange={(e) => setCustomDamagedAcc(e.target.value)}
                    />
                  </div>

                  {/* ภาพถ่ายความเสียหายจากมือถือ */}
                  <div className="space-y-2 pt-2 border-t border-amber-200/60">
                    <div className="flex items-center justify-between">
                      <label className="label text-amber-950 font-bold mb-0">
                        ภาพถ่ายความเสียหาย (รองรับกล้องมือถือ/รูปภาพ)
                      </label>
                      <span className="text-[11px] text-slate-500 font-medium">
                        {damagePhotos.length}/4 รูป
                      </span>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <label className="btn-outline cursor-pointer text-xs py-2 px-3 bg-white border-amber-300 text-amber-900 hover:bg-amber-100/50 flex items-center gap-1.5 min-h-[44px]">
                        <Camera className="h-4 w-4 text-amber-700" />
                        <span>ถ่ายภาพด้วยกล้อง</span>
                        <input
                          type="file"
                          accept="image/*"
                          capture="environment"
                          className="hidden"
                          onChange={(e) => handlePhotoUpload(e, 'damage')}
                          disabled={uploadingPhoto || damagePhotos.length >= 4}
                        />
                      </label>

                      <label className="btn-outline cursor-pointer text-xs py-2 px-3 bg-white border-slate-300 text-slate-700 hover:bg-slate-50 flex items-center gap-1.5 min-h-[44px]">
                        <ImageIcon className="h-4 w-4 text-slate-600" />
                        <span>เลือกจากอัลบั้มรูป</span>
                        <input
                          type="file"
                          accept="image/*"
                          multiple
                          className="hidden"
                          onChange={(e) => handlePhotoUpload(e, 'damage')}
                          disabled={uploadingPhoto || damagePhotos.length >= 4}
                        />
                      </label>

                      {uploadingPhoto && (
                        <span className="text-xs text-amber-800 animate-pulse font-medium">
                          กำลังประมวลผลและบีบอัดภาพ...
                        </span>
                      )}
                    </div>

                    {/* แสดงรายการรูปภาพ Thumbnail */}
                    {damagePhotos.length > 0 && (
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1">
                        {damagePhotos.map((photo, idx) => (
                          <div
                            key={idx}
                            className="relative group rounded-xl overflow-hidden border border-amber-300 aspect-video bg-black/5"
                          >
                            <img
                              src={photo}
                              alt={`ความเสียหาย ${idx + 1}`}
                              className="w-full h-full object-cover"
                            />
                            <button
                              type="button"
                              onClick={() => removePhoto(idx, 'damage')}
                              className="absolute top-1 right-1 rounded-full bg-red-600 text-white p-1 shadow-sm hover:bg-red-700 transition"
                              title="ลบรูปนี้"
                            >
                              <Trash2 className="h-3 w-3" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* กรณีที่ 3: สูญหาย (LOST) -> แยก Workflow บันทึกเหตุการณ์และใบแจ้งความ */}
            {returnCondition === 'LOST' && (
              <div className="space-y-4 rounded-2xl bg-red-50/50 border border-red-300 p-4 text-xs">
                <div className="flex items-center gap-2 text-red-950 font-bold text-sm border-b border-red-200 pb-2">
                  <AlertTriangle className="h-4 w-4 text-red-600" />
                  <span>บันทึกรายงานครุภัณฑ์สูญหาย (Lost Incident Workflow)</span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="label text-red-950">วันที่เกิดเหตุสูญหาย</label>
                    <input
                      type="date"
                      className="input text-xs"
                      value={lostIncidentDate}
                      onChange={(e) => setLostIncidentDate(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="label text-red-950">สถานที่เกิดเหตุ</label>
                    <input
                      className="input text-xs"
                      placeholder="เช่น ห้องบรรยาย 1 อาคารสารสนเทศ หรือระหว่างการเดินทาง"
                      value={lostLocation}
                      onChange={(e) => setLostLocation(e.target.value)}
                    />
                  </div>
                </div>

                <div>
                  <label className="label text-red-950 font-bold">
                    รายละเอียดเหตุการณ์สูญหาย * <span className="text-red-600">(จำเป็น)</span>
                  </label>
                  <textarea
                    className="input min-h-[70px] text-xs"
                    placeholder="ระบุพฤติการณ์ วัน เวลา และสถานที่ที่สูญหายอย่างละเอียด..."
                    value={lostDetails}
                    onChange={(e) => setLostDetails(e.target.value)}
                  />
                </div>

                <div>
                  <label className="label text-red-950">
                    เลขที่บันทึกประจำวัน / รายงานแจ้งความตำรวจ (ถ้ามี)
                  </label>
                  <input
                    className="input text-xs"
                    placeholder="เช่น ปจว. ข้อ 2 สภ.เมืองขอนแก่น ลงวันที่ 12 ต.ค. 2569"
                    value={lostPoliceReportNo}
                    onChange={(e) => setLostPoliceReportNo(e.target.value)}
                  />
                </div>

                {/* ภาพถ่ายเอกสารหรือหลักฐานประกอบ */}
                <div className="space-y-2 pt-2 border-t border-red-200">
                  <div className="flex items-center justify-between">
                    <label className="label text-red-950 font-bold mb-0">
                      เอกสารหรือรูปถ่ายหลักฐานประกอบ (เช่น ใบแจ้งความ, ปจว.)
                    </label>
                    <span className="text-[11px] text-slate-500 font-medium">
                      {lostPhotos.length}/4 รูป
                    </span>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <label className="btn-outline cursor-pointer text-xs py-2 px-3 bg-white border-red-300 text-red-900 hover:bg-red-50 flex items-center gap-1.5 min-h-[44px]">
                      <Camera className="h-4 w-4 text-red-700" />
                      <span>ถ่ายภาพเอกสาร</span>
                      <input
                        type="file"
                        accept="image/*"
                        capture="environment"
                        className="hidden"
                        onChange={(e) => handlePhotoUpload(e, 'lost')}
                        disabled={uploadingPhoto || lostPhotos.length >= 4}
                      />
                    </label>

                    <label className="btn-outline cursor-pointer text-xs py-2 px-3 bg-white border-slate-300 text-slate-700 hover:bg-slate-50 flex items-center gap-1.5 min-h-[44px]">
                      <ImageIcon className="h-4 w-4 text-slate-600" />
                      <span>เลือกจากอัลบั้มรูป</span>
                      <input
                        type="file"
                        accept="image/*"
                        multiple
                        className="hidden"
                        onChange={(e) => handlePhotoUpload(e, 'lost')}
                        disabled={uploadingPhoto || lostPhotos.length >= 4}
                      />
                    </label>

                    {uploadingPhoto && (
                      <span className="text-xs text-red-800 animate-pulse font-medium">
                        กำลังประมวลผลและบีบอัดภาพ...
                      </span>
                    )}
                  </div>

                  {lostPhotos.length > 0 && (
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1">
                      {lostPhotos.map((photo, idx) => (
                        <div
                          key={idx}
                          className="relative group rounded-xl overflow-hidden border border-red-300 aspect-video bg-black/5"
                        >
                          <img
                            src={photo}
                            alt={`เอกสารหลักฐาน ${idx + 1}`}
                            className="w-full h-full object-cover"
                          />
                          <button
                            type="button"
                            onClick={() => removePhoto(idx, 'lost')}
                            className="absolute top-1 right-1 rounded-full bg-red-600 text-white p-1 shadow-sm hover:bg-red-700 transition"
                            title="ลบรูปนี้"
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* ข้อตกลงยินยอมรับผิดชอบชดใช้ค่าเสียหาย */}
                <div className="pt-2 border-t border-red-200">
                  <label className="flex items-start gap-2.5 p-3 rounded-xl bg-white border border-red-200 text-xs text-red-950 cursor-pointer shadow-2xs">
                    <input
                      type="checkbox"
                      className="accent-red-600 mt-0.5 h-4 w-4 rounded"
                      checked={lostLiabilityAccepted}
                      onChange={(e) => setLostLiabilityAccepted(e.target.checked)}
                    />
                    <span className="leading-relaxed">
                      ผู้ยืมรับทราบและยินยอมปฏิบัติตามระเบียบการชดใช้ค่าเสียหายหรือจัดหาครุภัณฑ์ทดแทนตามระเบียบพัสดุมหาวิทยาลัยขอนแก่น
                    </span>
                  </label>
                </div>
              </div>
            )}

            {/* Modal Footer Buttons */}
            <div className="flex flex-col-reverse sm:flex-row justify-end gap-2.5 pt-4 border-t border-slate-100">
              <button
                type="button"
                className="btn-outline min-h-[44px]"
                onClick={() => setReturnModalReq(null)}
                disabled={busy}
              >
                ยกเลิก
              </button>
              <button
                type="button"
                className={`min-h-[44px] font-bold px-4 py-2 rounded-xl text-white transition shadow-sm ${
                  returnCondition === 'NORMAL'
                    ? 'bg-emerald-600 hover:bg-emerald-700'
                    : returnCondition === 'DAMAGED'
                    ? 'bg-amber-600 hover:bg-amber-700'
                    : 'bg-red-600 hover:bg-red-700'
                }`}
                disabled={
                  busy ||
                  (returnCondition === 'DAMAGED' && !damageSymptom.trim()) ||
                  (returnCondition === 'LOST' && !lostDetails.trim())
                }
                onClick={handleReturnSubmit}
              >
                {busy
                  ? 'กำลังบันทึก...'
                  : returnCondition === 'NORMAL'
                  ? '✓ ยืนยันการรับคืน (ปรับครุภัณฑ์เป็นว่างพร้อมยืม)'
                  : returnCondition === 'DAMAGED'
                  ? '🔧 ยืนยันรับคืนชำรุด (ส่งซ่อมบำรุง)'
                  : '⚠️ ยืนยันรับคืน (บันทึกสูญหาย)'}
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* Modal: บันทึกส่งมอบอุปกรณ์ */}
      <Modal
        open={!!handoverModalReq}
        onClose={() => setHandoverModalReq(null)}
        title={`บันทึกการส่งมอบครุภัณฑ์: ${handoverModalReq?.equipment.name}`}
      >
        {handoverModalReq && (
          <div className="space-y-4">
            {error && <Alert>{error}</Alert>}

            <div className="rounded-2xl bg-slate-50 p-4 border border-slate-200/60 space-y-1 text-xs">
              <div>
                ผู้รับมอบ: <b className="text-slate-900">{handoverModalReq.borrower.name}</b>
              </div>
              <div>
                เลขครุภัณฑ์: <b className="font-mono text-slate-800">{handoverModalReq.equipment.assetNumber}</b>
              </div>
              <div>
                ช่วงเวลาการใช้งาน:{' '}
                <b>
                  {fmtDate(handoverModalReq.startDate)} – {fmtDate(handoverModalReq.expectedReturnDate)}
                </b>
              </div>
            </div>

            <div>
              <label className="label">อุปกรณ์เสริมที่ส่งมอบ (คั่นด้วยเครื่องหมายจุลภาค ,)</label>
              <input
                className="input text-xs"
                value={handoverAcc}
                onChange={(e) => setHandoverAcc(e.target.value)}
              />
            </div>

            <div>
              <label className="label">สภาพก่อนส่งมอบ</label>
              <input
                className="input text-xs"
                value={handoverNote}
                onChange={(e) => setHandoverNote(e.target.value)}
              />
            </div>

            <div className="flex justify-end gap-2.5 pt-4 border-t border-slate-100">
              <button
                type="button"
                className="btn-outline"
                onClick={() => setHandoverModalReq(null)}
                disabled={busy}
              >
                ยกเลิก
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={busy}
                onClick={handleHandoverSubmit}
              >
                {busy ? 'กำลังบันทึก...' : 'ยืนยันการส่งมอบ'}
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* Modal: สแกน QR Code */}
      <QrScannerModal
        open={qrScannerOpen}
        onClose={() => setQrScannerOpen(false)}
        onScan={handleQrScan}
      />

      {/* Modal: แบบฟอร์มแจ้งซ่อมแซมอุปกรณ์ */}
      <RepairFormModal
        open={repairModalOpen}
        onClose={() => setRepairModalOpen(false)}
        currentUser={me}
        initialEquipments={repairModalEquipments}
      />
    </div>
  );
}
