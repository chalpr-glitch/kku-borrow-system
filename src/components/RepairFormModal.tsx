'use client';

import React, { useState, useEffect } from 'react';
import { Printer, Plus, Trash2, X, FileText, CheckCircle2, Save, Download, AlertCircle } from 'lucide-react';
import type { Equipment, AppUser, RepairRequest } from '@/lib/types';
import { Modal } from '@/components/ui';
import { createRepairRequest } from '@/lib/repairs';

export interface RepairItem {
  id: string;
  equipmentId?: string;
  equipmentName: string;
  assetNumber: string;
  symptom: string;
  responsiblePerson: string;
}

interface RepairFormModalProps {
  open: boolean;
  onClose: () => void;
  currentUser?: AppUser | null;
  repairRequest?: RepairRequest | null;
  initialEquipments?: Array<{
    equipment: Equipment | { id: string; name: string; assetNumber: string };
    symptom?: string;
    responsiblePerson?: string;
  }>;
  onSaved?: (ticketNo: string) => void;
}

const THAI_MONTHS = [
  'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'
];

export function RepairFormModal({
  open,
  onClose,
  currentUser,
  repairRequest,
  initialEquipments = [],
  onSaved,
}: RepairFormModalProps) {
  const today = new Date();
  const [ticketNo, setTicketNo] = useState<string>(repairRequest?.ticketNo || '');
  const [day, setDay] = useState(String(today.getDate()));
  const [month, setMonth] = useState(THAI_MONTHS[today.getMonth()]);
  const [year, setYear] = useState(String(today.getFullYear() + 543));

  const [subject, setSubject] = useState('ขอแจ้งซ่อมอุปกรณ์ทางด้านคอมพิวเตอร์และอุปกรณ์สำนักงาน');
  const [recipient, setRecipient] = useState('ผู้อำนวยการกองบริหารงานสำนักบริการวิชาการ');

  // Dynamic Requester: Pull from logged in profile / current user (no hardcoding)
  const [requesterName, setRequesterName] = useState(currentUser?.name || '');
  const [requesterPosition, setRequesterPosition] = useState(currentUser?.position || '');
  const [requesterDivision, setRequesterDivision] = useState(currentUser?.division || 'กองบริหารงานสำนักบริการวิชาการ');

  // Dynamic Approver: Not hardcoded, can be edited or defaults to standard director title
  const [approverName, setApproverName] = useState(repairRequest?.approverName || '');
  const [approverTitle, setApproverTitle] = useState(
    repairRequest?.approverTitle || 'ผู้อำนวยการกองบริหารงานสำนักบริการวิชาการ'
  );

  const [items, setItems] = useState<RepairItem[]>([]);
  const [activeTab, setActiveTab] = useState<'preview' | 'edit'>('preview');
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Initialize items from props
  useEffect(() => {
    if (initialEquipments && initialEquipments.length > 0) {
      setItems(
        initialEquipments.map((item, idx) => ({
          id: String(idx + 1),
          responsiblePerson: item.responsiblePerson || currentUser?.name || requesterName,
          equipmentName: item.equipment.name || '',
          assetNumber: item.equipment.assetNumber || '',
          symptom: item.symptom || 'ชำรุดจากการใช้งาน / ขอส่งซ่อมบำรุง',
        }))
      );
    } else if (items.length === 0) {
      // Default 1 blank row
      setItems([
        {
          id: '1',
          responsiblePerson: currentUser?.name || requesterName,
          equipmentName: '',
          assetNumber: '',
          symptom: '',
        },
      ]);
    }
  }, [initialEquipments, open, currentUser]);

  useEffect(() => {
    if (currentUser?.name) {
      setRequesterName(currentUser.name);
    }
    if (currentUser?.position) {
      setRequesterPosition(currentUser.position);
    }
    if (currentUser?.division) {
      setRequesterDivision(currentUser.division);
    }
  }, [currentUser]);

  const handleAddItem = () => {
    setItems((prev) => [
      ...prev,
      {
        id: String(Date.now()),
        responsiblePerson: requesterName,
        equipmentName: '',
        assetNumber: '',
        symptom: '',
      },
    ]);
  };

  const handleRemoveItem = (idx: number) => {
    setItems((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleUpdateItem = (idx: number, field: keyof RepairItem, val: string) => {
    setItems((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], [field]: val };
      return next;
    });
  };

  const handlePrint = () => {
    window.print();
  };

  const handleSaveTicket = async () => {
    if (!currentUser) return;
    setSaving(true);
    setSaveError(null);
    setSaveSuccess(null);
    try {
      const validItems = items.filter((it) => it.equipmentName.trim() && it.symptom.trim());
      if (validItems.length === 0) {
        throw new Error('กรุณาระบุรายการครุภัณฑ์และอาการเสียอย่างน้อย 1 รายการ');
      }
      const generatedNo = await createRepairRequest(
        {
          subject,
          recipient,
          documentDate: `${year ? parseInt(year, 10) - 543 : today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${day.padStart(2, '0')}`,
          approverName,
          approverTitle,
          items: validItems,
          notes: 'สร้างจากแบบฟอร์มขอแจ้งซ่อมแซมอุปกรณ์',
          initialStatus: 'DRAFT',
        },
        currentUser
      );
      setTicketNo(generatedNo);
      setSaveSuccess(`บันทึกใบแจ้งซ่อมเลขที่ ${generatedNo} สำเร็จ (สถานะ: ร่างเอกสาร)`);
      if (onSaved) onSaved(generatedNo);
    } catch (err: any) {
      setSaveError(err.message || 'เกิดข้อผิดพลาดในการบันทึกใบแจ้งซ่อม');
    } finally {
      setSaving(false);
    }
  };

  const handleExportJson = () => {
    const payload = {
      ticketNo: ticketNo || 'DRAFT',
      subject,
      recipient,
      date: `${day} ${month} พ.ศ. ${year}`,
      requester: {
        name: requesterName,
        position: requesterPosition,
        division: requesterDivision,
      },
      approver: {
        name: approverName,
        title: approverTitle,
      },
      costs: {
        laborCost: repairRequest?.laborCost || 0,
        partsCost: repairRequest?.partsCost || 0,
        serviceCost: repairRequest?.serviceCost || 0,
        otherCost: repairRequest?.otherCost || 0,
        totalCost: repairRequest?.repairCost || 0,
      },
      completion: {
        vendorName: repairRequest?.vendorName || '',
        completionDate: repairRequest?.completionDate || '',
        completionNotes: repairRequest?.completionNotes || '',
      },
      items: items.filter((it) => it.equipmentName || it.symptom),
      exportedAt: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `repair-form-${ticketNo || 'draft'}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Guarantee at least 5 rows in print display for authentic form spacing
  const totalDisplayRows = Math.max(5, items.length);
  const displayRows = [...items];
  while (displayRows.length < totalDisplayRows) {
    displayRows.push({
      id: `empty_${displayRows.length}`,
      responsiblePerson: '',
      equipmentName: '',
      assetNumber: '',
      symptom: '',
    });
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="📄 แบบฟอร์ม ความต้องการ/ซ่อมแซม อุปกรณ์"
    >
      <div className="space-y-4">
        {/* Print Stylesheet */}
        <style dangerouslySetInnerHTML={{ __html: `
          @media print {
            body * {
              visibility: hidden !important;
            }
            #printable-repair-form, #printable-repair-form * {
              visibility: visible !important;
            }
            #printable-repair-form {
              position: absolute !important;
              left: 0 !important;
              top: 0 !important;
              width: 100% !important;
              padding: 10mm 15mm !important;
              background: white !important;
              color: black !important;
              font-family: 'Sarabun', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
              font-size: 14pt !important;
              line-height: 1.4 !important;
            }
            .no-print {
              display: none !important;
            }
          }
        `}} />

        {saveSuccess && (
          <div className="no-print p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-900 font-bold flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-emerald-600" />
            {saveSuccess}
          </div>
        )}

        {saveError && (
          <div className="no-print p-3 rounded-xl bg-red-50 border border-red-200 text-xs text-red-900 font-bold flex items-center gap-2">
            <AlertCircle className="h-4 w-4 text-red-600" />
            {saveError}
          </div>
        )}

        {/* Action Header (No Print) */}
        <div className="no-print flex flex-wrap items-center justify-between gap-3 bg-slate-50 p-3 rounded-xl border border-slate-200">
          <div className="flex flex-wrap items-center gap-2">
            {ticketNo ? (
              <span className="font-mono text-xs font-bold bg-brand-100 text-brand-900 px-2.5 py-1 rounded-md border border-brand-200">
                เลขที่: {ticketNo}
              </span>
            ) : (
              <span className="text-xs text-slate-500 font-medium">
                (ร่างยังไม่บันทึก)
              </span>
            )}

            <button
              type="button"
              onClick={() => setActiveTab('preview')}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition ${
                activeTab === 'preview'
                  ? 'bg-brand-600 text-white shadow-xs'
                  : 'bg-white text-slate-700 border border-slate-200 hover:bg-slate-100'
              }`}
            >
              <FileText className="inline-block h-3.5 w-3.5 mr-1" />
              พิมพ์เอกสาร (Print Preview)
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('edit')}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition ${
                activeTab === 'edit'
                  ? 'bg-brand-600 text-white shadow-xs'
                  : 'bg-white text-slate-700 border border-slate-200 hover:bg-slate-100'
              }`}
            >
              แก้ไขข้อมูล ({items.length} รายการ)
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {!ticketNo && currentUser && (
              <button
                type="button"
                onClick={handleSaveTicket}
                disabled={saving}
                className="btn-success text-xs py-1.5 px-3 min-h-[36px] flex items-center gap-1.5 shadow-sm"
              >
                <Save className="h-4 w-4" />
                {saving ? 'กำลังบันทึก...' : 'บันทึกเป็นตั๋วแจ้งซ่อม'}
              </button>
            )}

            <button
              type="button"
              onClick={handleExportJson}
              className="btn-outline text-xs py-1.5 px-2.5 min-h-[36px] bg-white flex items-center gap-1 text-slate-700 hover:bg-slate-50 shadow-2xs"
              title="ส่งออกโครงสร้างข้อมูล JSON สำหรับเชื่อมต่อภายนอก"
            >
              <Download className="h-3.5 w-3.5" />
              JSON
            </button>

            <button
              type="button"
              onClick={handlePrint}
              className="btn-primary text-xs py-1.5 px-3 min-h-[36px] bg-slate-900 hover:bg-black text-white flex items-center gap-1.5 shadow-sm"
            >
              <Printer className="h-4 w-4" />
              พิมพ์ / PDF
            </button>
            <button
              type="button"
              onClick={onClose}
              className="btn-outline text-xs py-1.5 px-3 min-h-[36px]"
            >
              ปิด
            </button>
          </div>
        </div>

        {/* Tab 1: Edit Mode (No Print) */}
        {activeTab === 'edit' && (
          <div className="no-print space-y-4 max-h-[70vh] overflow-y-auto p-1">
            <div className="card p-4 space-y-3 bg-white border border-slate-200">
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-600">
                1. ข้อมูลวันที่และหัวข้อเอกสาร
              </h3>
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="label text-2xs">วันที่</label>
                  <input
                    className="input text-xs"
                    value={day}
                    onChange={(e) => setDay(e.target.value)}
                  />
                </div>
                <div>
                  <label className="label text-2xs">เดือน</label>
                  <select
                    className="input text-xs"
                    value={month}
                    onChange={(e) => setMonth(e.target.value)}
                  >
                    {THAI_MONTHS.map((m) => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="label text-2xs">พ.ศ.</label>
                  <input
                    className="input text-xs"
                    value={year}
                    onChange={(e) => setYear(e.target.value)}
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="label text-2xs">เรื่อง</label>
                  <input
                    className="input text-xs"
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                  />
                </div>
                <div>
                  <label className="label text-2xs">เรียน</label>
                  <input
                    className="input text-xs"
                    value={recipient}
                    onChange={(e) => setRecipient(e.target.value)}
                  />
                </div>
              </div>
            </div>

            <div className="card p-4 space-y-3 bg-white border border-slate-200">
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-600">
                2. ข้อมูลเจ้าหน้าที่ผู้แจ้งซ่อม
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div>
                  <label className="label text-2xs">ชื่อ-สกุล ข้าพเจ้า</label>
                  <input
                    className="input text-xs"
                    value={requesterName}
                    onChange={(e) => setRequesterName(e.target.value)}
                  />
                </div>
                <div>
                  <label className="label text-2xs">ตำแหน่ง</label>
                  <input
                    className="input text-xs"
                    value={requesterPosition}
                    onChange={(e) => setRequesterPosition(e.target.value)}
                  />
                </div>
                <div>
                  <label className="label text-2xs">ส่วน / สังกัด</label>
                  <input
                    className="input text-xs"
                    value={requesterDivision}
                    onChange={(e) => setRequesterDivision(e.target.value)}
                  />
                </div>
              </div>
            </div>

            <div className="card p-4 space-y-3 bg-white border border-slate-200">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-600">
                  3. รายการอุปกรณ์ที่ต้องการซ่อมแซม ({items.length} รายการ)
                </h3>
                <button
                  type="button"
                  onClick={handleAddItem}
                  className="btn-outline text-2xs py-1 px-2.5 flex items-center gap-1 text-brand-700 border-brand-200 bg-brand-50 hover:bg-brand-100"
                >
                  <Plus className="h-3 w-3" /> เพิ่มแถวอุปกรณ์
                </button>
              </div>

              <div className="space-y-3">
                {items.map((item, idx) => (
                  <div
                    key={item.id}
                    className="p-3 bg-slate-50 rounded-xl border border-slate-200 space-y-2 relative"
                  >
                    <div className="flex items-center justify-between text-xs font-bold text-slate-700">
                      <span>ลำดับที่ {idx + 1}</span>
                      {items.length > 1 && (
                        <button
                          type="button"
                          onClick={() => handleRemoveItem(idx)}
                          className="text-red-600 hover:text-red-800 p-1 rounded-md"
                          title="ลบแถวนี้"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                      <div>
                        <label className="label text-2xs">ผู้รับผิดชอบ</label>
                        <input
                          className="input text-xs"
                          value={item.responsiblePerson}
                          onChange={(e) => handleUpdateItem(idx, 'responsiblePerson', e.target.value)}
                          placeholder="ชื่อผู้รับผิดชอบ"
                        />
                      </div>
                      <div>
                        <label className="label text-2xs">ชื่ออุปกรณ์</label>
                        <input
                          className="input text-xs"
                          value={item.equipmentName}
                          onChange={(e) => handleUpdateItem(idx, 'equipmentName', e.target.value)}
                          placeholder="เช่น เครื่องปรับอากาศ, จอภาพ, คอมพิวเตอร์"
                        />
                      </div>
                      <div>
                        <label className="label text-2xs">หมายเลขครุภัณฑ์</label>
                        <input
                          className="input text-xs font-mono"
                          value={item.assetNumber}
                          onChange={(e) => handleUpdateItem(idx, 'assetNumber', e.target.value)}
                          placeholder="เช่น 6520040000027 หรือ รหัสสินทรัพย์"
                        />
                      </div>
                      <div>
                        <label className="label text-2xs">รายละเอียด / อาการความผิดปกติ</label>
                        <input
                          className="input text-xs"
                          value={item.symptom}
                          onChange={(e) => handleUpdateItem(idx, 'symptom', e.target.value)}
                          placeholder="เช่น ไม่เย็น, เปิดไม่ติด, มีน้ำหยด, ชำรุด"
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="card p-4 space-y-3 bg-white border border-slate-200">
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-600">
                4. ข้อมูลผู้อนุมัติ (ส่วนท้ายเอกสาร)
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="label text-2xs">ชื่อผู้อนุมัติ</label>
                  <input
                    className="input text-xs"
                    value={approverName}
                    onChange={(e) => setApproverName(e.target.value)}
                  />
                </div>
                <div>
                  <label className="label text-2xs">ตำแหน่งผู้อนุมัติ</label>
                  <input
                    className="input text-xs"
                    value={approverTitle}
                    onChange={(e) => setApproverTitle(e.target.value)}
                  />
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Tab 2: Printable Document Preview (Matches the PDF layout exactly) */}
        <div className="bg-slate-100 p-2 sm:p-4 rounded-xl overflow-x-auto flex justify-center">
          <div
            id="printable-repair-form"
            className="bg-white text-black p-6 sm:p-10 shadow-lg border border-slate-300 w-full max-w-[210mm] min-h-[297mm] text-[13px] leading-relaxed mx-auto select-text font-serif"
            style={{
              fontFamily: "'Sarabun', 'TH Sarabun PSK', serif, sans-serif",
            }}
          >
            {/* Header Title with Ticket Number */}
            <div className="flex items-start justify-between mb-2">
              <div className="w-1/4 text-left text-[12px] text-slate-700 font-mono font-bold">
                {ticketNo ? `เลขที่: ${ticketNo}` : ''}
              </div>
              <div className="w-2/4 text-center font-bold text-base sm:text-lg">
                แบบฟอร์ม ความต้องการ/ซ่อมแซม อุปกรณ์
              </div>
              <div className="w-1/4"></div>
            </div>

            {/* Date line */}
            <div className="text-right mb-4 text-[13px]">
              วันที่ <span className="border-b border-dotted border-black px-2">{day || '.....'}</span>
              เดือน <span className="border-b border-dotted border-black px-4">{month || '..................'}</span>
              พ.ศ. <span className="border-b border-dotted border-black px-3">{year || '.........'}</span>
            </div>

            {/* Subject & Recipient */}
            <div className="space-y-1 mb-3 text-[13px]">
              <div>
                <span className="font-bold">เรื่อง</span> {subject}
              </div>
              <div>
                <span className="font-bold">เรียน</span> {recipient}
              </div>
            </div>

            {/* Requester Statement */}
            <div className="mb-4 text-[13px] leading-relaxed">
              &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;ข้าพเจ้า{' '}
              <span className="border-b border-dotted border-black font-semibold px-2">{requesterName || '.............................................'}</span>{' '}
              ตำแหน่ง{' '}
              <span className="border-b border-dotted border-black px-2">{requesterPosition || '.............................................'}</span>{' '}
              <br className="hidden sm:inline" />
              ส่วน{' '}
              <span className="border-b border-dotted border-black px-2">{requesterDivision || '...................................................'}</span>{' '}
              มีความประสงค์จะซ่อมแซม/จัดหาทดแทน
            </div>

            {/* Repair Items Table */}
            <div className="mb-6 overflow-x-auto">
              <table className="w-full border-collapse border border-black text-[12px] text-center">
                <thead>
                  <tr className="bg-slate-50/50">
                    <th className="border border-black p-1.5 w-[8%] font-bold">ลำดับ<br />ที่</th>
                    <th className="border border-black p-1.5 w-[24%] font-bold">ผู้รับผิดชอบ</th>
                    <th className="border border-black p-1.5 w-[22%] font-bold">อุปกรณ์</th>
                    <th className="border border-black p-1.5 w-[22%] font-bold">หมายเลขครุภัณฑ์</th>
                    <th className="border border-black p-1.5 w-[24%] font-bold">รายละเอียด / อาการ<br />ความผิดปกติ</th>
                  </tr>
                </thead>
                <tbody>
                  {displayRows.map((row, idx) => (
                    <tr key={row.id || idx} className="h-8">
                      <td className="border border-black p-1 text-center align-middle font-medium">
                        {row.equipmentName || row.assetNumber ? idx + 1 : ''}
                      </td>
                      <td className="border border-black p-1 text-left px-2 align-middle">
                        {row.responsiblePerson}
                      </td>
                      <td className="border border-black p-1 text-left px-2 align-middle">
                        {row.equipmentName}
                      </td>
                      <td className="border border-black p-1 text-center font-mono align-middle">
                        {row.assetNumber}
                      </td>
                      <td className="border border-black p-1 text-left px-2 align-middle">
                        {row.symptom}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Requester Signature Block */}
            <div className="flex justify-end mb-8 text-[13px]">
              <div className="text-center w-72 space-y-1">
                <div>ลงชื่อ ........................................................ เจ้าหน้าที่ผู้รับผิดชอบ</div>
                <div className="pt-0.5">( {requesterName || '........................................................'} )</div>
              </div>
            </div>

            {/* Approver Decision Section (Boxed border like official PDF) */}
            <div className="border border-black p-4 space-y-3 text-[13px]">
              <div className="text-center font-bold">
                สำหรับผู้อำนวยการกองบริหารงานฯ
              </div>
              <div className="space-y-1 pl-4">
                <div className="flex items-center gap-2">
                  <span className="inline-block w-4 h-4 border border-black rounded-xs text-center leading-3 font-mono text-xs"></span>
                  <span>อนุมัติ</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="inline-block w-4 h-4 border border-black rounded-xs text-center leading-3 font-mono text-xs"></span>
                  <span>ไม่อนุมัติ .....................................................................................................................</span>
                </div>
              </div>
              <div className="flex justify-center pt-2">
                <div className="text-center space-y-1">
                  <div>ลงชื่อ ........................................................</div>
                  <div>( {approverName || '........................................................'} )</div>
                  <div className="text-[12px]">{approverTitle || 'ผู้อำนวยการกองบริหารงานสำนักบริการวิชาการ'}</div>
                </div>
              </div>
            </div>

            {/* Completion Cost Summary (if completed) */}
            {Boolean(repairRequest?.repairCost) && (
              <div className="mt-4 border border-dashed border-slate-400 p-2 text-[12px] bg-slate-50/50">
                <div className="font-bold mb-1">สรุปค่าใช้จ่ายในการซ่อม (แยก ค่าแรง / ค่าอะไหล่ / ค่าบริการ / ค่าใช้จ่ายอื่นๆ):</div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center text-[11px]">
                  <div>ค่าแรง: <b>{(repairRequest?.laborCost || 0).toLocaleString()}</b> บ.</div>
                  <div>ค่าอะไหล่: <b>{(repairRequest?.partsCost || 0).toLocaleString()}</b> บ.</div>
                  <div>ค่าบริการ: <b>{(repairRequest?.serviceCost || 0).toLocaleString()}</b> บ.</div>
                  <div>อื่นๆ: <b>{(repairRequest?.otherCost || 0).toLocaleString()}</b> บ.</div>
                </div>
                <div className="text-right font-extrabold text-[12px] mt-1 text-emerald-800">
                  รวมทั้งสิ้น: {(repairRequest?.repairCost || 0).toLocaleString()} บาท
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
