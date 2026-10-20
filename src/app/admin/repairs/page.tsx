'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Wrench,
  Search,
  Plus,
  FileText,
  Printer,
  CheckCircle2,
  Clock,
  Truck,
  RotateCcw,
  Trash2,
  Edit,
  Send,
  AlertCircle,
  ArrowRight,
  ShieldCheck,
  Building,
  Lock,
} from 'lucide-react';
import AppShell from '@/components/AppShell';
import { Alert, EmptyState, LoadingState, Modal, StatCard, TableSkeleton } from '@/components/ui';
import { RepairFormModal } from '@/components/RepairFormModal';
import { useAuth } from '@/lib/auth-context';
import { useEquipments, useRepairRequests, useUsers } from '@/lib/hooks';
import {
  createRepairRequest,
  transitionRepairStatus,
  updateRepairDraft,
  type CreateRepairInput,
} from '@/lib/repairs';
import type { AppUser, Equipment, RepairItem, RepairRequest, RepairStatus } from '@/lib/types';
import { REPAIR_STATUS_META } from '@/lib/types';
import { errMsg, fmtDate, todayStr } from '@/lib/utils';

export default function RepairsManagementPage() {
  return (
    <AppShell
      title="จัดการงานแจ้งซ่อมแซมครุภัณฑ์ (Repair Management)"
      roles={['CUSTODIAN', 'APPROVER', 'EXECUTIVE']}
    >
      <RepairsContent />
    </AppShell>
  );
}

function RepairsContent() {
  const { profile, loading: authLoading } = useAuth();
  const { data: repairs, loading: repairsLoading } = useRepairRequests();
  const { data: equipments } = useEquipments();
  const { data: users } = useUsers();

  const [tab, setTab] = useState<RepairStatus | 'ALL'>('ALL');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Print/Official Form Modal
  const [printModalOpen, setPrintModalOpen] = useState(false);
  const [printTicket, setPrintTicket] = useState<RepairRequest | null>(null);

  // Create/Edit Draft Modal State
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editingTicket, setEditingTicket] = useState<RepairRequest | null>(null);

  // Form fields for create/edit
  const [formSubject, setFormSubject] = useState('ขอแจ้งซ่อมอุปกรณ์ทางด้านคอมพิวเตอร์และอุปกรณ์สำนักงาน');
  const [formRecipient, setFormRecipient] = useState('ผู้อำนวยการกองบริหารงานสำนักบริการวิชาการ');
  const [formDocDate, setFormDocDate] = useState(todayStr());
  const [formApproverName, setFormApproverName] = useState('');
  const [formApproverTitle, setFormApproverTitle] = useState('ผู้อำนวยการกองบริหารงานสำนักบริการวิชาการ');
  const [formNotes, setFormNotes] = useState('');
  const [formItems, setFormItems] = useState<RepairItem[]>([]);

  // Completion Dialog State
  const [completeModalOpen, setCompleteModalOpen] = useState(false);
  const [completeTicket, setCompleteTicket] = useState<RepairRequest | null>(null);
  const [completeVendor, setCompleteVendor] = useState('');
  const [completeLaborCost, setCompleteLaborCost] = useState('');
  const [completePartsCost, setCompletePartsCost] = useState('');
  const [completeServiceCost, setCompleteServiceCost] = useState('');
  const [completeOtherCost, setCompleteOtherCost] = useState('');
  const [completeNotes, setCompleteNotes] = useState('');
  const [completeDate, setCompleteDate] = useState(todayStr());

  const calculatedTotalCost = useMemo(() => {
    const l = parseFloat(completeLaborCost) || 0;
    const p = parseFloat(completePartsCost) || 0;
    const s = parseFloat(completeServiceCost) || 0;
    const o = parseFloat(completeOtherCost) || 0;
    return l + p + s + o;
  }, [completeLaborCost, completePartsCost, completeServiceCost, completeOtherCost]);

  // In-Repair (Dispatch) Dialog State
  const [dispatchModalOpen, setDispatchModalOpen] = useState(false);
  const [dispatchTicket, setDispatchTicket] = useState<RepairRequest | null>(null);
  const [dispatchVendor, setDispatchVendor] = useState('');

  if (authLoading || !profile) {
    return <LoadingState text="กำลังโหลดระบบจัดการงานแจ้งซ่อม..." />;
  }

  const me = profile;

  // Active approver suggestion from users directory
  const approverUsers = useMemo(() => {
    return users.filter((u) => u.active && (u.role === 'APPROVER' || u.role === 'EXECUTIVE'));
  }, [users]);

  // Sorting: most recent first
  const sortedRepairs = useMemo(() => {
    return [...repairs].sort((a, b) => {
      const ta = a.createdAt?.seconds || 0;
      const tb = b.createdAt?.seconds || 0;
      return tb - ta;
    });
  }, [repairs]);

  // Counts by status
  const draftCount = sortedRepairs.filter((r) => r.status === 'DRAFT').length;
  const pendingCount = sortedRepairs.filter((r) => r.status === 'PENDING_REVIEW').length;
  const approvedCount = sortedRepairs.filter((r) => r.status === 'APPROVED').length;
  const inRepairCount = sortedRepairs.filter((r) => r.status === 'IN_REPAIR').length;
  const completedCount = sortedRepairs.filter((r) => r.status === 'COMPLETED').length;

  // Filtered List
  const filteredList = useMemo(() => {
    let list = sortedRepairs;
    if (tab !== 'ALL') {
      list = list.filter((r) => r.status === tab);
    }
    const s = q.trim().toLowerCase();
    if (!s) return list;
    return list.filter((r) => {
      const matchTicket = r.ticketNo?.toLowerCase().includes(s) || r.id?.toLowerCase().includes(s);
      const matchReq = r.requesterName?.toLowerCase().includes(s);
      const matchItems = (r.items || []).some(
        (it) => it.equipmentName?.toLowerCase().includes(s) || it.assetNumber?.toLowerCase().includes(s) || it.symptom?.toLowerCase().includes(s)
      );
      return matchTicket || matchReq || matchItems;
    });
  }, [sortedRepairs, tab, q]);

  // Open Create New Ticket
  const handleOpenCreate = () => {
    setEditingTicket(null);
    setFormSubject('ขอแจ้งซ่อมอุปกรณ์ทางด้านคอมพิวเตอร์และอุปกรณ์สำนักงาน');
    setFormRecipient('ผู้อำนวยการกองบริหารงานสำนักบริการวิชาการ');
    setFormDocDate(todayStr());
    setFormApproverName(approverUsers[0]?.name || '');
    setFormApproverTitle(approverUsers[0]?.position || 'ผู้อำนวยการกองบริหารงานสำนักบริการวิชาการ');
    setFormNotes('');
    setFormItems([
      {
        id: '1',
        equipmentId: '',
        equipmentName: '',
        assetNumber: '',
        symptom: '',
        responsiblePerson: me.name,
      },
    ]);
    setError(null);
    setEditModalOpen(true);
  };

  // Open Edit Draft
  const handleOpenEdit = (ticket: RepairRequest) => {
    setEditingTicket(ticket);
    setFormSubject(ticket.subject || 'ขอแจ้งซ่อมอุปกรณ์ทางด้านคอมพิวเตอร์และอุปกรณ์สำนักงาน');
    setFormRecipient(ticket.recipient || 'ผู้อำนวยการกองบริหารงานสำนักบริการวิชาการ');
    setFormDocDate(ticket.documentDate || todayStr());
    setFormApproverName(ticket.approverName || '');
    setFormApproverTitle(ticket.approverTitle || 'ผู้อำนวยการกองบริหารงานสำนักบริการวิชาการ');
    setFormNotes(ticket.notes || '');
    setFormItems(
      ticket.items?.length
        ? ticket.items.map((it, idx) => ({ ...it, id: it.id || String(idx + 1) }))
        : [
            {
              id: '1',
              equipmentId: '',
              equipmentName: '',
              assetNumber: '',
              symptom: '',
              responsiblePerson: ticket.requesterName || me.name,
            },
          ]
    );
    setError(null);
    setEditModalOpen(true);
  };

  // Add Item Row in Modal
  const handleAddItemRow = () => {
    setFormItems((prev) => [
      ...prev,
      {
        id: String(Date.now()),
        equipmentId: '',
        equipmentName: '',
        assetNumber: '',
        symptom: '',
        responsiblePerson: me.name,
      },
    ]);
  };

  // Select equipment into row
  const handleSelectEquipment = (idx: number, eqId: string) => {
    const eq = equipments.find((e) => e.id === eqId);
    if (!eq) return;
    setFormItems((prev) => {
      const next = [...prev];
      next[idx] = {
        ...next[idx],
        equipmentId: eq.id,
        equipmentName: eq.name,
        assetNumber: eq.assetNumber,
      };
      return next;
    });
  };

  // Save Ticket (Create or Update Draft)
  const handleSaveDraft = async (submitForReview = false) => {
    setBusy(true);
    setError(null);
    try {
      const validItems = formItems.filter((it) => it.equipmentName.trim() && it.symptom.trim());
      if (validItems.length === 0) {
        throw new Error('กรุณาระบุรายการครุภัณฑ์และอาการเสียอย่างน้อย 1 รายการ');
      }

      if (editingTicket) {
        await updateRepairDraft(
          editingTicket.id,
          {
            subject: formSubject,
            recipient: formRecipient,
            documentDate: formDocDate,
            approverName: formApproverName,
            approverTitle: formApproverTitle,
            notes: formNotes,
            items: validItems,
          },
          me
        );
        if (submitForReview && editingTicket.status === 'DRAFT') {
          await transitionRepairStatus(editingTicket.id, 'PENDING_REVIEW', me);
        }
        setSuccessMsg(`บันทึกการแก้ไขใบแจ้งซ่อม ${editingTicket.id} เรียบร้อยแล้ว`);
      } else {
        const ticketNo = await createRepairRequest(
          {
            subject: formSubject,
            recipient: formRecipient,
            documentDate: formDocDate,
            approverName: formApproverName,
            approverTitle: formApproverTitle,
            notes: formNotes,
            items: validItems,
            initialStatus: submitForReview ? 'PENDING_REVIEW' : 'DRAFT',
          },
          me
        );
        setSuccessMsg(
          submitForReview
            ? `สร้างและส่งใบแจ้งซ่อมเลขที่ ${ticketNo} ขออนุมัติเรียบร้อยแล้ว`
            : `บันทึกร่างใบแจ้งซ่อมเลขที่ ${ticketNo} เรียบร้อยแล้ว (สถานะครุภัณฑ์: ส่งซ่อมบำรุง)`
        );
      }
      setEditModalOpen(false);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  // Submit for Review
  const handleSubmitReview = async (ticket: RepairRequest) => {
    setBusy(true);
    setError(null);
    try {
      await transitionRepairStatus(ticket.id, 'PENDING_REVIEW', me);
      setSuccessMsg(`ส่งใบแจ้งซ่อม ${ticket.id} เพื่อรอการตรวจสอบและอนุมัติเรียบร้อยแล้ว`);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  // Approve Ticket
  const handleApproveTicket = async (ticket: RepairRequest) => {
    setBusy(true);
    setError(null);
    try {
      await transitionRepairStatus(ticket.id, 'APPROVED', me);
      setSuccessMsg(`อนุมัติใบแจ้งซ่อม ${ticket.id} เรียบร้อยแล้ว`);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  // Open Dispatch Modal
  const handleOpenDispatch = (ticket: RepairRequest) => {
    setDispatchTicket(ticket);
    setDispatchVendor(ticket.vendorName || '');
    setDispatchModalOpen(true);
  };

  // Submit Dispatch (IN_REPAIR)
  const handleConfirmDispatch = async () => {
    if (!dispatchTicket) return;
    setBusy(true);
    setError(null);
    try {
      await transitionRepairStatus(dispatchTicket.id, 'IN_REPAIR', me, {
        vendorName: dispatchVendor,
      });
      setSuccessMsg(`บันทึกส่งซ่อมสำหรับใบแจ้งซ่อม ${dispatchTicket.id} เรียบร้อยแล้ว`);
      setDispatchModalOpen(false);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  // Open Complete Modal (บันทึกปิดงานซ่อม)
  const handleOpenComplete = (ticket: RepairRequest) => {
    setCompleteTicket(ticket);
    setCompleteVendor(ticket.vendorName || '');
    setCompleteLaborCost(ticket.laborCost !== undefined && ticket.laborCost !== null ? String(ticket.laborCost) : '');
    setCompletePartsCost(ticket.partsCost !== undefined && ticket.partsCost !== null ? String(ticket.partsCost) : '');
    setCompleteServiceCost(ticket.serviceCost !== undefined && ticket.serviceCost !== null ? String(ticket.serviceCost) : '');
    setCompleteOtherCost(ticket.otherCost !== undefined && ticket.otherCost !== null ? String(ticket.otherCost) : '');
    setCompleteNotes(ticket.completionNotes || 'ซ่อมแซมและตรวจรับสภาพสมบูรณ์');
    setCompleteDate(todayStr());
    setCompleteModalOpen(true);
  };

  // Submit Complete (COMPLETED -> equipment becomes AVAILABLE)
  const handleConfirmComplete = async () => {
    if (!completeTicket) return;
    setBusy(true);
    setError(null);
    try {
      const labor = completeLaborCost ? parseFloat(completeLaborCost) : 0;
      const parts = completePartsCost ? parseFloat(completePartsCost) : 0;
      const service = completeServiceCost ? parseFloat(completeServiceCost) : 0;
      const other = completeOtherCost ? parseFloat(completeOtherCost) : 0;
      const total = labor + parts + service + other;

      await transitionRepairStatus(completeTicket.id, 'COMPLETED', me, {
        completionDate: completeDate,
        completionNotes: completeNotes,
        laborCost: labor,
        partsCost: parts,
        serviceCost: service,
        otherCost: other,
        repairCost: total,
        vendorName: completeVendor,
      });
      setSuccessMsg(
        `บันทึกปิดงานซ่อม ${completeTicket.id} เรียบร้อยแล้ว! รวมค่าซ่อมทั้งสิ้น ${total.toLocaleString()} บาท (ครุภัณฑ์ทั้งหมดถูกปรับสถานะเป็น "พร้อมใช้งาน" อัตโนมัติ)`
      );
      setCompleteModalOpen(false);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  // Open Official Print Form Modal
  const handleOpenPrint = (ticket: RepairRequest) => {
    setPrintTicket(ticket);
    setPrintModalOpen(true);
  };

  return (
    <div className="space-y-6">
      {successMsg && <Alert kind="success">{successMsg}</Alert>}
      {error && <Alert kind="error">{error}</Alert>}

      {/* Top Stat Overview */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard
          label="ร่างเอกสาร (Draft)"
          value={draftCount}
          hint="อยู่ระหว่างแก้ไขร่าง"
          tone="slate"
        />
        <StatCard
          label="รอตรวจสอบ (Pending)"
          value={pendingCount}
          hint="ส่งเรื่องแล้ว รอตรวจ"
          tone={pendingCount > 0 ? 'amber' : 'slate'}
        />
        <StatCard
          label="อนุมัติแล้ว (Approved)"
          value={approvedCount}
          hint="รอส่งร้านซ่อม"
          tone={approvedCount > 0 ? 'sky' : 'slate'}
        />
        <StatCard
          label="อยู่ระหว่างส่งซ่อม"
          value={inRepairCount}
          hint="ครุภัณฑ์อยู่ร้านซ่อม"
          tone={inRepairCount > 0 ? 'amber' : 'slate'}
        />
        <StatCard
          label="ปิดงานสำเร็จแล้ว"
          value={completedCount}
          hint="ซ่อมเสร็จ/กลับมาว่าง"
          tone="green"
        />
      </div>

      {/* Action Bar & Tabs */}
      <div className="card space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-4">
          <div className="flex flex-wrap items-center gap-1.5">
            {[
              ['ALL', `ทั้งหมด (${sortedRepairs.length})`],
              ['DRAFT', `ร่าง (${draftCount})`],
              ['PENDING_REVIEW', `รอตรวจสอบ (${pendingCount})`],
              ['APPROVED', `อนุมัติแล้ว (${approvedCount})`],
              ['IN_REPAIR', `ส่งซ่อม (${inRepairCount})`],
              ['COMPLETED', `ปิดงาน (${completedCount})`],
            ].map(([st, label]) => (
              <button
                key={st}
                type="button"
                onClick={() => setTab(st as any)}
                className={`rounded-xl px-3 py-1.5 text-xs font-bold transition ${
                  tab === st
                    ? 'bg-brand-600 text-white shadow-xs'
                    : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2 w-full sm:w-auto">
            <button
              type="button"
              onClick={handleOpenCreate}
              className="btn-primary text-xs py-2 px-3.5 flex items-center gap-1.5 whitespace-nowrap shadow-xs min-h-[40px]"
            >
              <Plus className="h-4 w-4" /> สร้างใบแจ้งซ่อมใหม่
            </button>

            <div className="relative flex-1 sm:w-64">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
              <input
                className="input pl-9 text-xs py-2 min-h-[40px]"
                placeholder="ค้นหาเลขที่, ครุภัณฑ์, อาการ..."
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
          </div>
        </div>

        {/* Data Content */}
        {repairsLoading ? (
          <div className="space-y-4">
            <LoadingState text="กำลังโหลดรายการแจ้งซ่อมแซม..." />
            <TableSkeleton rows={4} />
          </div>
        ) : !filteredList.length ? (
          <EmptyState
            title="ไม่พบรายการแจ้งซ่อม"
            description="ยังไม่มีใบแจ้งซ่อมที่ตรงกับเงื่อนไขการค้นหาหรือสถานะที่เลือก"
          />
        ) : (
          <>
            {/* Desktop Table View */}
            <div className="hidden sm:block overflow-x-auto rounded-2xl border border-slate-200 bg-white">
              <table className="min-w-full divide-y divide-slate-100 text-sm">
                <thead>
                  <tr>
                    <th className="th">เลขที่ใบแจ้งซ่อม</th>
                    <th className="th">วันที่</th>
                    <th className="th">รายการครุภัณฑ์ & อาการเสีย</th>
                    <th className="th">ผู้แจ้งซ่อม / สังกัด</th>
                    <th className="th">สถานะ</th>
                    <th className="th text-right">ปุ่มจัดการด่วน</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredList.map((ticket) => {
                    const meta = REPAIR_STATUS_META[ticket.status] || {
                      label: ticket.status,
                      badgeClass: 'bg-slate-100 text-slate-800',
                    };
                    const isDraft = ticket.status === 'DRAFT';
                    const isPending = ticket.status === 'PENDING_REVIEW';
                    const isApproved = ticket.status === 'APPROVED';
                    const isInRepair = ticket.status === 'IN_REPAIR';
                    const isCompleted = ticket.status === 'COMPLETED';

                    return (
                      <tr key={ticket.id} className="transition hover:bg-slate-50/70">
                        <td className="td whitespace-nowrap">
                          <span className="font-mono font-bold text-brand-700 bg-brand-50 px-2.5 py-1 rounded-md border border-brand-200">
                            {ticket.ticketNo || ticket.id}
                          </span>
                        </td>
                        <td className="td whitespace-nowrap text-xs text-slate-600">
                          {fmtDate(ticket.documentDate)}
                        </td>
                        <td className="td max-w-xs">
                          <div className="font-bold text-slate-900">
                            {ticket.items?.[0]?.equipmentName || 'ไม่มีข้อมูลครุภัณฑ์'}
                            {ticket.items?.length > 1 && (
                              <span className="ml-1.5 text-xs text-brand-700 font-semibold bg-brand-50 px-1.5 py-0.5 rounded-full">
                                +{ticket.items.length - 1} รายการ
                              </span>
                            )}
                          </div>
                          <div className="text-xs font-mono text-slate-500">
                            {ticket.items?.[0]?.assetNumber}
                          </div>
                          <div className="text-xs text-slate-700 line-clamp-1 mt-0.5">
                            อาการ: {ticket.items?.[0]?.symptom}
                          </div>
                          {ticket.repairCost !== undefined && ticket.repairCost !== null && ticket.repairCost > 0 && (
                            <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px]">
                              <span className="font-bold text-emerald-800 bg-emerald-50 px-1.5 py-0.5 rounded border border-emerald-200">
                                รวม {ticket.repairCost.toLocaleString()} บ.
                              </span>
                              <span className="text-slate-500 font-mono text-[10px]">
                                (แรง: {ticket.laborCost || 0} | อะไหล่: {ticket.partsCost || 0} | บริการ: {ticket.serviceCost || 0} | อื่นๆ: {ticket.otherCost || 0})
                              </span>
                            </div>
                          )}
                        </td>
                        <td className="td whitespace-nowrap">
                          <div className="font-semibold text-slate-900">{ticket.requesterName}</div>
                          <div className="text-xs text-slate-500">{ticket.requesterDivision}</div>
                        </td>
                        <td className="td whitespace-nowrap">
                          <span className={`inline-block px-2.5 py-1 rounded-full text-xs font-bold border ${meta.badgeClass}`}>
                            {meta.label}
                          </span>
                        </td>
                        <td className="td text-right whitespace-nowrap">
                          <div className="flex items-center justify-end gap-1.5">
                            {/* Official Print Form button */}
                            <button
                              type="button"
                              onClick={() => handleOpenPrint(ticket)}
                              className="btn-outline text-xs py-1.5 px-2.5 flex items-center gap-1 shadow-2xs"
                              title="พิมพ์แบบฟอร์มขอแจ้งซ่อมแซมอุปกรณ์ราชการ (A4)"
                            >
                              <Printer className="h-3.5 w-3.5 text-slate-600" />
                              <span>แบบฟอร์ม (A4)</span>
                            </button>

                            {/* Workflow Actions */}
                            {(isDraft || isPending) && (
                              <button
                                type="button"
                                onClick={() => handleOpenEdit(ticket)}
                                className="btn-outline text-xs py-1.5 px-2.5 flex items-center gap-1 shadow-2xs text-brand-800 border-brand-200 bg-brand-50 hover:bg-brand-100"
                              >
                                <Edit className="h-3.5 w-3.5" />
                                <span>แก้ไขร่าง</span>
                              </button>
                            )}

                            {/* สถานะล็อกหลังอนุมัติ ป้องกันการแก้ข้อมูลเดิม */}
                            {(isApproved || isInRepair || isCompleted) && (
                              <span
                                className="inline-flex items-center gap-1 text-[11px] font-semibold text-slate-500 bg-slate-100 px-2 py-1 rounded-md border border-slate-200 shadow-2xs"
                                title="ข้อมูลเดิมถูกล็อกแล้วหลังได้รับการอนุมัติ ป้องกันการแก้ไขย้อนหลัง"
                              >
                                <Lock className="h-3 w-3 text-slate-400" />
                                <span>ล็อกหลังอนุมัติ</span>
                              </span>
                            )}

                            {isDraft && (
                              <button
                                type="button"
                                onClick={() => handleSubmitReview(ticket)}
                                disabled={busy}
                                className="btn-primary text-xs py-1.5 px-2.5 flex items-center gap-1 shadow-2xs"
                              >
                                <Send className="h-3.5 w-3.5" />
                                <span>ส่งตรวจ</span>
                              </button>
                            )}

                            {isPending && (me.role === 'APPROVER' || me.role === 'EXECUTIVE') && (
                              <button
                                type="button"
                                onClick={() => handleApproveTicket(ticket)}
                                disabled={busy}
                                className="btn-success text-xs py-1.5 px-2.5 flex items-center gap-1 shadow-2xs"
                              >
                                <CheckCircle2 className="h-3.5 w-3.5" />
                                <span>อนุมัติ</span>
                              </button>
                            )}

                            {isApproved && (
                              <button
                                type="button"
                                onClick={() => handleOpenDispatch(ticket)}
                                disabled={busy}
                                className="btn-primary text-xs py-1.5 px-2.5 flex items-center gap-1 bg-indigo-600 hover:bg-indigo-700 shadow-2xs"
                              >
                                <Truck className="h-3.5 w-3.5" />
                                <span>ส่งซ่อม</span>
                              </button>
                            )}

                            {isInRepair && (
                              <button
                                type="button"
                                onClick={() => handleOpenComplete(ticket)}
                                disabled={busy}
                                className="btn-success text-xs py-1.5 px-2.5 flex items-center gap-1 shadow-2xs"
                              >
                                <CheckCircle2 className="h-3.5 w-3.5" />
                                <span>ปิดงาน</span>
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Mobile Card List View */}
            <div className="sm:hidden space-y-3">
              {filteredList.map((ticket) => {
                const meta = REPAIR_STATUS_META[ticket.status] || {
                  label: ticket.status,
                  badgeClass: 'bg-slate-100 text-slate-800',
                };
                const isDraft = ticket.status === 'DRAFT';
                const isPending = ticket.status === 'PENDING_REVIEW';
                const isApproved = ticket.status === 'APPROVED';
                const isInRepair = ticket.status === 'IN_REPAIR';
                const isCompleted = ticket.status === 'COMPLETED';

                return (
                  <div
                    key={ticket.id}
                    className="rounded-2xl border border-slate-200 bg-white p-4 shadow-2xs space-y-3"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-mono font-bold text-xs text-brand-700 bg-brand-50 px-2 py-0.5 rounded border border-brand-200">
                        {ticket.ticketNo || ticket.id}
                      </span>
                      <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold border ${meta.badgeClass}`}>
                        {meta.label}
                      </span>
                    </div>

                    <div>
                      <div className="font-bold text-slate-900 text-sm">
                        {ticket.items?.[0]?.equipmentName || 'ไม่มีข้อมูลครุภัณฑ์'}
                        {ticket.items?.length > 1 && (
                          <span className="ml-1.5 text-xs text-brand-700 font-semibold bg-brand-50 px-1.5 py-0.5 rounded-full">
                            +{ticket.items.length - 1} รายการ
                          </span>
                        )}
                      </div>
                      <div className="text-xs font-mono text-slate-500">
                        รหัส: {ticket.items?.[0]?.assetNumber}
                      </div>
                      <div className="text-xs text-slate-700 mt-1">
                        อาการ: {ticket.items?.[0]?.symptom}
                      </div>
                      {ticket.repairCost !== undefined && ticket.repairCost !== null && ticket.repairCost > 0 && (
                        <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px]">
                          <span className="font-bold text-emerald-800 bg-emerald-50 px-1.5 py-0.5 rounded border border-emerald-200">
                            รวม {ticket.repairCost.toLocaleString()} บ.
                          </span>
                          <span className="text-slate-500 font-mono text-[10px]">
                            (แรง: {ticket.laborCost || 0} | อะไหล่: {ticket.partsCost || 0} | บริการ: {ticket.serviceCost || 0} | อื่นๆ: {ticket.otherCost || 0})
                          </span>
                        </div>
                      )}
                    </div>

                    <div className="flex items-center justify-between text-xs text-slate-500 border-t border-slate-100 pt-2">
                      <span>ผู้แจ้ง: {ticket.requesterName}</span>
                      <span>{fmtDate(ticket.documentDate)}</span>
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5 pt-1">
                      <button
                        type="button"
                        onClick={() => handleOpenPrint(ticket)}
                        className="btn-outline text-xs py-2 px-3 flex-1 justify-center min-h-[44px] flex items-center gap-1"
                      >
                        <Printer className="h-3.5 w-3.5" />
                        <span>แบบฟอร์ม (A4)</span>
                      </button>

                      {(isDraft || isPending) && (
                        <button
                          type="button"
                          onClick={() => handleOpenEdit(ticket)}
                          className="btn-outline text-xs py-2 px-3 flex-1 justify-center min-h-[44px] flex items-center gap-1 text-brand-800 border-brand-200 bg-brand-50"
                        >
                          <Edit className="h-3.5 w-3.5" />
                          <span>แก้ไขร่าง</span>
                        </button>
                      )}

                      {/* แสดงล็อกข้อมูลหลังอนุมัติ */}
                      {(isApproved || isInRepair || isCompleted) && (
                        <span className="flex-1 min-h-[44px] flex items-center justify-center gap-1.5 text-xs font-semibold text-slate-500 bg-slate-100 rounded-xl border border-slate-200">
                          <Lock className="h-3.5 w-3.5 text-slate-400" />
                          <span>ล็อกหลังอนุมัติ</span>
                        </span>
                      )}

                      {isDraft && (
                        <button
                          type="button"
                          onClick={() => handleSubmitReview(ticket)}
                          disabled={busy}
                          className="btn-primary text-xs py-2 px-3 flex-1 justify-center min-h-[44px] flex items-center gap-1"
                        >
                          <Send className="h-3.5 w-3.5" />
                          <span>ส่งตรวจ</span>
                        </button>
                      )}

                      {isPending && (me.role === 'APPROVER' || me.role === 'EXECUTIVE') && (
                        <button
                          type="button"
                          onClick={() => handleApproveTicket(ticket)}
                          disabled={busy}
                          className="btn-success text-xs py-2 px-3 flex-1 justify-center min-h-[44px] flex items-center gap-1"
                        >
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          <span>อนุมัติ</span>
                        </button>
                      )}

                      {isApproved && (
                        <button
                          type="button"
                          onClick={() => handleOpenDispatch(ticket)}
                          disabled={busy}
                          className="btn-primary text-xs py-2 px-3 flex-1 justify-center min-h-[44px] flex items-center gap-1 bg-indigo-600 hover:bg-indigo-700"
                        >
                          <Truck className="h-3.5 w-3.5" />
                          <span>ส่งซ่อม</span>
                        </button>
                      )}

                      {isInRepair && (
                        <button
                          type="button"
                          onClick={() => handleOpenComplete(ticket)}
                          disabled={busy}
                          className="btn-success text-xs py-2 px-3 flex-1 justify-center min-h-[44px] flex items-center gap-1"
                        >
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          <span>ปิดงาน</span>
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      {/* Modal: สร้าง / แก้ไขร่างใบแจ้งซ่อม */}
      <Modal
        open={editModalOpen}
        onClose={() => setEditModalOpen(false)}
        title={editingTicket ? `แก้ไขร่างใบแจ้งซ่อม: ${editingTicket.id}` : 'สร้างใบแจ้งซ่อมแซมครุภัณฑ์ใหม่'}
      >
        <div className="space-y-4 max-h-[80vh] overflow-y-auto pr-1">
          {error && <Alert kind="error">{error}</Alert>}

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="label text-xs">วันที่เอกสาร</label>
              <input
                type="date"
                className="input text-xs"
                value={formDocDate}
                onChange={(e) => setFormDocDate(e.target.value)}
              />
            </div>
            <div className="sm:col-span-2">
              <label className="label text-xs">เรื่อง</label>
              <input
                className="input text-xs"
                value={formSubject}
                onChange={(e) => setFormSubject(e.target.value)}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="label text-xs">เรียน (ผู้รับเอกสาร)</label>
              <input
                className="input text-xs"
                value={formRecipient}
                onChange={(e) => setFormRecipient(e.target.value)}
              />
            </div>
            <div>
              <label className="label text-xs">ผู้อนุมัติ (ดึงตามตำแหน่ง/ผู้บริหารปัจจุบัน)</label>
              <input
                className="input text-xs"
                placeholder="ชื่อ-สกุล ผู้อนุมัติ"
                value={formApproverName}
                onChange={(e) => setFormApproverName(e.target.value)}
              />
            </div>
          </div>

          {/* ตารางรายการครุภัณฑ์ (5 คอลัมน์ตามแบบฟอร์มต้นฉบับ) */}
          <div className="space-y-2 border-t border-slate-100 pt-3">
            <div className="flex items-center justify-between">
              <label className="label text-xs font-bold text-slate-900 mb-0">
                รายการครุภัณฑ์ที่ต้องการแจ้งซ่อม ({formItems.length} รายการ)
              </label>
              <button
                type="button"
                onClick={handleAddItemRow}
                className="btn-outline text-xs py-1 px-2.5 flex items-center gap-1 font-semibold"
              >
                <Plus className="h-3.5 w-3.5" /> เพิ่มแถวอุปกรณ์
              </button>
            </div>

            <div className="space-y-3">
              {formItems.map((item, idx) => (
                <div
                  key={item.id || idx}
                  className="rounded-xl border border-slate-200 bg-slate-50/70 p-3 space-y-2 relative"
                >
                  <div className="flex items-center justify-between text-xs font-bold text-slate-700">
                    <span>ลำดับที่ {idx + 1}</span>
                    {formItems.length > 1 && (
                      <button
                        type="button"
                        onClick={() => setFormItems((prev) => prev.filter((_, i) => i !== idx))}
                        className="text-red-600 hover:text-red-800 text-xs flex items-center gap-1"
                      >
                        <Trash2 className="h-3.5 w-3.5" /> ลบแถวนี้
                      </button>
                    )}
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                    <div>
                      <label className="text-2xs text-slate-500 font-medium">เลือกจากครุภัณฑ์ในระบบ (ดึงข้อมูลอัตโนมัติ)</label>
                      <select
                        className="input text-xs"
                        value={item.equipmentId || ''}
                        onChange={(e) => handleSelectEquipment(idx, e.target.value)}
                      >
                        <option value="">-- พิมพ์เอง หรือเลือกจากระบบ --</option>
                        {equipments.map((eq) => (
                          <option key={eq.id} value={eq.id}>
                            {eq.name} ({eq.assetNumber}) - {eq.status}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="text-2xs text-slate-500 font-medium">ผู้รับผิดชอบ</label>
                      <input
                        className="input text-xs"
                        value={item.responsiblePerson}
                        onChange={(e) => {
                          const v = e.target.value;
                          setFormItems((prev) => {
                            const n = [...prev];
                            n[idx].responsiblePerson = v;
                            return n;
                          });
                        }}
                      />
                    </div>

                    <div>
                      <label className="text-2xs text-slate-500 font-medium">ชื่ออุปกรณ์ / รายการ *</label>
                      <input
                        className="input text-xs"
                        placeholder="เช่น เครื่องปรับอากาศ, จอภาพคอมพิวเตอร์"
                        value={item.equipmentName}
                        onChange={(e) => {
                          const v = e.target.value;
                          setFormItems((prev) => {
                            const n = [...prev];
                            n[idx].equipmentName = v;
                            return n;
                          });
                        }}
                      />
                    </div>

                    <div>
                      <label className="text-2xs text-slate-500 font-medium">หมายเลขครุภัณฑ์</label>
                      <input
                        className="input text-xs font-mono"
                        placeholder="เช่น 6520040000027"
                        value={item.assetNumber}
                        onChange={(e) => {
                          const v = e.target.value;
                          setFormItems((prev) => {
                            const n = [...prev];
                            n[idx].assetNumber = v;
                            return n;
                          });
                        }}
                      />
                    </div>

                    <div className="sm:col-span-2">
                      <label className="text-2xs text-slate-500 font-medium">รายละเอียด / อาการความผิดปกติ *</label>
                      <input
                        className="input text-xs"
                        placeholder="เช่น ไม่เย็น, มีเสียงดัง, เปิดไม่ติด"
                        value={item.symptom}
                        onChange={(e) => {
                          const v = e.target.value;
                          setFormItems((prev) => {
                            const n = [...prev];
                            n[idx].symptom = v;
                            return n;
                          });
                        }}
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div>
            <label className="label text-xs">หมายเหตุเพิ่มเติม</label>
            <textarea
              className="input min-h-[60px] text-xs"
              placeholder="บันทึกข้อความหรือข้อสังเกตเพิ่มเติม..."
              value={formNotes}
              onChange={(e) => setFormNotes(e.target.value)}
            />
          </div>

          {/* Action Buttons */}
          <div className="flex flex-col-reverse sm:flex-row justify-end gap-2.5 pt-4 border-t border-slate-100">
            <button
              type="button"
              className="btn-outline min-h-[44px]"
              onClick={() => setEditModalOpen(false)}
              disabled={busy}
            >
              ยกเลิก
            </button>
            <button
              type="button"
              className="btn-secondary min-h-[44px]"
              disabled={busy}
              onClick={() => handleSaveDraft(false)}
            >
              {busy ? 'กำลังบันทึก...' : '💾 บันทึกร่าง (Draft)'}
            </button>
            <button
              type="button"
              className="btn-primary min-h-[44px]"
              disabled={busy}
              onClick={() => handleSaveDraft(true)}
            >
              {busy ? 'กำลังส่ง...' : '📤 บันทึกและส่งขออนุมัติ'}
            </button>
          </div>
        </div>
      </Modal>

      {/* Modal: บันทึกส่งซ่อม (IN_REPAIR) */}
      <Modal
        open={dispatchModalOpen}
        onClose={() => setDispatchModalOpen(false)}
        title={`บันทึกนำส่งร้านซ่อม: ${dispatchTicket?.id}`}
      >
        <div className="space-y-4 text-xs">
          <div>
            <label className="label">ชื่อร้านค้า / ศูนย์บริการ / ผู้รับจ้างซ่อม</label>
            <input
              className="input text-xs"
              placeholder="เช่น ศูนย์บริการ Dell ขอนแก่น หรือ หจก. แอร์เซอร์วิส"
              value={dispatchVendor}
              onChange={(e) => setDispatchVendor(e.target.value)}
            />
          </div>
          <div className="p-3 bg-amber-50 rounded-xl border border-amber-200 text-amber-900 leading-relaxed">
            เมื่อบันทึกส่งซ่อม สถานะจะเปลี่ยนเป็น <b>"ส่งซ่อม/ดำเนินการ"</b> โดยครุภัณฑ์จะยังคงสถานะ <b>"ซ่อมบำรุง (MAINTENANCE)"</b> จนกว่าจะมีการบันทึกปิดงาน
          </div>
          <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
            <button
              type="button"
              className="btn-outline min-h-[40px]"
              onClick={() => setDispatchModalOpen(false)}
            >
              ยกเลิก
            </button>
            <button
              type="button"
              className="btn-primary min-h-[40px]"
              disabled={busy}
              onClick={handleConfirmDispatch}
            >
              {busy ? 'กำลังบันทึก...' : 'ยืนยันนำส่งซ่อม'}
            </button>
          </div>
        </div>
      </Modal>

      {/* Modal: บันทึกปิดงานซ่อม (COMPLETED -> equipment AVAILABLE) */}
      <Modal
        open={completeModalOpen}
        onClose={() => setCompleteModalOpen(false)}
        title={`บันทึกปิดงานซ่อม: ${completeTicket?.id}`}
      >
        <div className="space-y-4 text-xs">
          <div className="p-3 bg-emerald-50 rounded-xl border border-emerald-200 text-emerald-950 leading-relaxed font-medium">
            ✓ เมื่อปิดงานซ่อมบำรุงสำเร็จ ระบบจะปรับสถานะครุภัณฑ์ทั้งหมดในใบแจ้งซ่อมนี้กลับเป็น <b>"พร้อมใช้งาน (AVAILABLE)"</b> อัตโนมัติทันที
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="label">วันที่ตรวจรับ / ซ่อมเสร็จ</label>
              <input
                type="date"
                className="input text-xs"
                value={completeDate}
                onChange={(e) => setCompleteDate(e.target.value)}
              />
            </div>
            <div>
              <label className="label">ร้านค้า / ผู้รับจ้างซ่อม</label>
              <input
                className="input text-xs"
                placeholder="เช่น ร้านไอทีเซอร์วิส หรือ งานซ่อมบำรุงภายใน"
                value={completeVendor}
                onChange={(e) => setCompleteVendor(e.target.value)}
              />
            </div>
          </div>

          {/* รายละเอียดค่าใช้จ่าย: แยก ค่าแรง / ค่าอะไหล่ / ค่าบริการ / ค่าใช้จ่ายอื่นๆ */}
          <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="font-bold text-slate-800 text-xs">
                รายละเอียดค่าใช้จ่าย (แยก ค่าแรง / ค่าอะไหล่ / ค่าบริการ / อื่นๆ)
              </span>
              <span className="text-emerald-700 font-extrabold text-xs bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-md">
                รวมทั้งสิ้น: {calculatedTotalCost.toLocaleString()} บาท
              </span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <div>
                <label className="text-[11px] font-medium text-slate-600 block mb-1">1. ค่าแรง (บาท)</label>
                <input
                  type="number"
                  className="input text-xs font-mono"
                  placeholder="0"
                  value={completeLaborCost}
                  onChange={(e) => setCompleteLaborCost(e.target.value)}
                />
              </div>
              <div>
                <label className="text-[11px] font-medium text-slate-600 block mb-1">2. ค่าอะไหล่ (บาท)</label>
                <input
                  type="number"
                  className="input text-xs font-mono"
                  placeholder="0"
                  value={completePartsCost}
                  onChange={(e) => setCompletePartsCost(e.target.value)}
                />
              </div>
              <div>
                <label className="text-[11px] font-medium text-slate-600 block mb-1">3. ค่าบริการ (บาท)</label>
                <input
                  type="number"
                  className="input text-xs font-mono"
                  placeholder="0"
                  value={completeServiceCost}
                  onChange={(e) => setCompleteServiceCost(e.target.value)}
                />
              </div>
              <div>
                <label className="text-[11px] font-medium text-slate-600 block mb-1">4. อื่นๆ/ขนส่ง (บาท)</label>
                <input
                  type="number"
                  className="input text-xs font-mono"
                  placeholder="0"
                  value={completeOtherCost}
                  onChange={(e) => setCompleteOtherCost(e.target.value)}
                />
              </div>
            </div>
          </div>

          <div>
            <label className="label">ผลการตรวจรับ / บันทึกการปิดงาน</label>
            <textarea
              className="input min-h-[60px] text-xs"
              placeholder="ระบุการเปลี่ยนชิ้นส่วน สภาพการทดสอบใช้งาน..."
              value={completeNotes}
              onChange={(e) => setCompleteNotes(e.target.value)}
            />
          </div>

          <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
            <button
              type="button"
              className="btn-outline min-h-[40px]"
              onClick={() => setCompleteModalOpen(false)}
            >
              ยกเลิก
            </button>
            <button
              type="button"
              className="btn-success min-h-[40px]"
              disabled={busy}
              onClick={handleConfirmComplete}
            >
              {busy ? 'กำลังบันทึก...' : '✓ ยืนยันปิดงานซ่อม (ปรับครุภัณฑ์เป็นว่าง)'}
            </button>
          </div>
        </div>
      </Modal>

      {/* Modal: แบบฟอร์มราชการ (A4 Print Modal) */}
      {printTicket && (
        <RepairFormModal
          open={printModalOpen}
          onClose={() => {
            setPrintModalOpen(false);
            setPrintTicket(null);
          }}
          currentUser={me}
          repairRequest={printTicket}
          initialEquipments={printTicket.items.map((it) => ({
            equipment: { id: it.equipmentId || '', name: it.equipmentName, assetNumber: it.assetNumber },
            symptom: it.symptom,
            responsiblePerson: it.responsiblePerson,
          }))}
        />
      )}
    </div>
  );
}
