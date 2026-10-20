'use client';

import { useMemo, useRef, useState } from 'react';
import { collection, limit, orderBy, query } from 'firebase/firestore';
import {
  Plus,
  Upload,
  Download,
  Tag,
  History,
  Search,
  RotateCcw,
  Trash2,
  Edit,
  Package,
  CheckCircle2,
  FileSpreadsheet,
  Image as ImageIcon,
  X,
  Loader2,
  Link as LinkIcon,
  QrCode,
  Printer,
  CheckSquare,
  Square,
  Wrench,
} from 'lucide-react';
import AppShell from '@/components/AppShell';
import { Alert, ConfirmDialog, EquipmentBadge, LoadingState, Modal } from '@/components/ui';
import { RepairFormModal } from '@/components/RepairFormModal';
import { QRCodeCanvas, QRCodeImage } from '@/components/QrCode';
import { useAuth } from '@/lib/auth-context';
import { fb } from '@/lib/firebase';
import {
  deleteCategory,
  deleteEquipment,
  importEquipments,
  restoreEquipment,
  saveCategory,
  saveEquipment,
  uploadEquipmentImage,
  type EquipmentInput,
} from '@/lib/equipment';
import { useCategories, useEquipments, useLiveQuery } from '@/lib/hooks';
import type { Equipment, EquipmentStatus } from '@/lib/types';
import { DEFAULT_CATEGORIES, EQUIPMENT_STATUS_META, downloadCsv, errMsg, fmtTs, parseCsv } from '@/lib/utils';
import type { Timestamp } from 'firebase/firestore';

export default function AdminEquipmentPage() {
  return (
    <AppShell title="จัดการฐานข้อมูลครุภัณฑ์" roles={['CUSTODIAN', 'EXECUTIVE']}>
      <Admin />
    </AppShell>
  );
}

const CSV_HEADER = [
  'assetNumber',
  'name',
  'categoryId',
  'brand',
  'model',
  'serialNumber',
  'accessories',
  'location',
  'acquiredDate',
  'price',
];

function Admin() {
  const { profile, loading: authLoading } = useAuth();
  const { data: equipments, loading } = useEquipments();
  const { data: categories } = useCategories();
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [status, setStatus] = useState('');
  const [showDeleted, setShowDeleted] = useState(false);
  const [editing, setEditing] = useState<Equipment | 'new' | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Equipment | null>(null);
  const [catOpen, setCatOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [qrModalOpen, setQrModalOpen] = useState(false);
  const [qrModalEquipments, setQrModalEquipments] = useState<Equipment[]>([]);
  const [repairModalOpen, setRepairModalOpen] = useState(false);
  const [repairModalEquipments, setRepairModalEquipments] = useState<any[]>([]);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const openRepairForm = (targetItems?: Equipment[]) => {
    const toSend = targetItems && targetItems.length > 0
      ? targetItems
      : equipments.filter((e) => e.status === 'MAINTENANCE' && !e.isDeleted);
    setRepairModalEquipments(
      toSend.map((eq) => ({
        equipment: eq,
        symptom: eq.note || 'ขอแจ้งซ่อมแซม/จัดหาทดแทน',
        responsiblePerson: profile?.name || '',
      }))
    );
    setRepairModalOpen(true);
  };

  if (authLoading || !profile) {
    return <LoadingState text="กำลังโหลดข้อมูล..." />;
  }

  const me = profile;

  const mergedCategories = useMemo(() => {
    const list = [...categories];
    for (const def of DEFAULT_CATEGORIES) {
      if (!list.some((c) => c.id === def.id)) {
        list.push({ id: def.id, name: def.name, isActive: true });
      }
    }
    return list;
  }, [categories]);

  const catName = useMemo(
    () => Object.fromEntries(mergedCategories.map((c) => [c.id, c.name])),
    [mergedCategories]
  );

  const list = equipments
    .filter((e) => (showDeleted ? e.isDeleted : !e.isDeleted))
    .filter((e) => !cat || e.categoryId === cat)
    .filter((e) => !status || e.status === status)
    .filter((e) => {
      const s = q.trim().toLowerCase();
      return (
        !s ||
        [e.name, e.assetNumber, e.serialNumber, e.brand].some((x) =>
          x?.toLowerCase().includes(s)
        )
      );
    })
    .sort((a, b) => a.assetNumber.localeCompare(b.assetNumber));

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeleteTarget(null);
    try {
      const mode = await deleteEquipment(me, target);
      setMsg({
        kind: 'success',
        text:
          mode === 'soft'
            ? `ลบ "${target.name}" แล้ว (เก็บประวัติไว้เพราะเคยถูกยืม — กู้คืนได้ทุกเมื่อ)`
            : `ลบ "${target.name}" ออกจากระบบถาวรเรียบร้อยแล้ว`,
      });
    } catch (err) {
      setMsg({ kind: 'error', text: errMsg(err) });
    }
  };

  const onRestore = async (e: Equipment) => {
    try {
      await restoreEquipment(me, e);
      setMsg({ kind: 'success', text: `กู้คืน "${e.name}" สำเร็จ` });
    } catch (err) {
      setMsg({ kind: 'error', text: errMsg(err) });
    }
  };

  const onImport = async (file: File) => {
    try {
      const rows = parseCsv(await file.text());
      const body = rows[0]?.[0]?.trim() === 'assetNumber' ? rows.slice(1) : rows;
      const res = await importEquipments(
        me,
        body,
        new Set(equipments.map((e) => e.assetNumber))
      );
      setMsg({
        kind: 'success',
        text: `นำเข้าสำเร็จ ${res.added} รายการ${
          res.skipped.length
            ? ` · ข้ามเลขซ้ำ ${res.skipped.length} รายการ (${res.skipped.slice(0, 5).join(', ')})`
            : ''
        }`,
      });
    } catch (err) {
      setMsg({ kind: 'error', text: errMsg(err) });
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const exportCsv = () =>
    downloadCsv(`ทะเบียนครุภัณฑ์-${new Date().toISOString().slice(0, 10)}.csv`, [
      [
        'เลขครุภัณฑ์',
        'ชื่อ',
        'หมวดหมู่',
        'ยี่ห้อ',
        'รุ่น',
        'S/N',
        'อุปกรณ์เสริม',
        'สถานที่เก็บ',
        'วันที่ได้มา',
        'ราคา',
        'สถานะ',
        'ถูกลบ',
      ],
      ...equipments.map((e) => [
        e.assetNumber,
        e.name,
        catName[e.categoryId] ?? e.categoryId,
        e.brand,
        e.model,
        e.serialNumber,
        (e.accessories ?? []).join('; '),
        e.location,
        e.acquiredDate,
        e.price ?? '',
        EQUIPMENT_STATUS_META[e.status]?.label,
        e.isDeleted ? 'ใช่' : '',
      ]),
    ]);

  return (
    <div className="space-y-6 pb-4 sm:pb-8">
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}

      {/* Action Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2.5">
          <button className="btn-primary min-h-[44px]" onClick={() => setEditing('new')}>
            <Plus className="h-4 w-4" /> เพิ่มครุภัณฑ์
          </button>
          <button className="btn-outline min-h-[44px]" onClick={() => fileRef.current?.click()}>
            <Upload className="h-4 w-4" /> นำเข้า CSV
          </button>
          <button
            className="btn-outline min-h-[44px]"
            onClick={() =>
              downloadCsv('template-ครุภัณฑ์.csv', [
                CSV_HEADER,
                [
                  '7440-001-0001/67',
                  'Notebook Dell Latitude 5440',
                  'CAT-COMPUTER',
                  'Dell',
                  'Latitude 5440',
                  'CN123',
                  'สายชาร์จ;กระเป๋า',
                  'ห้อง IT ชั้น 2',
                  '2024-03-15',
                  '32000',
                ],
              ])
            }
          >
            <FileSpreadsheet className="h-4 w-4" /> แบบฟอร์ม CSV
          </button>
          <button className="btn-outline min-h-[44px]" onClick={exportCsv}>
            <Download className="h-4 w-4" /> ส่งออกทะเบียน
          </button>
          <button
            className="btn-outline min-h-[44px] text-slate-700 hover:border-brand-300"
            onClick={() => {
              setQrModalEquipments(list);
              setQrModalOpen(true);
            }}
          >
            <Printer className="h-4 w-4 text-brand-600" /> พิมพ์ป้าย QR ครุภัณฑ์
          </button>
          <button
            className="btn-outline min-h-[44px] text-amber-800 border-amber-300 bg-amber-50/60 hover:bg-amber-100/70"
            onClick={() => openRepairForm()}
            title="ออกใบแจ้งซ่อมแซมอุปกรณ์ (อ้างอิงแบบฟอร์มทางการ)"
          >
            <Wrench className="h-4 w-4 text-amber-600" /> แบบฟอร์มแจ้งซ่อมแซมอุปกรณ์
          </button>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="btn-outline text-xs min-h-[44px]" onClick={() => setCatOpen(true)}>
            <Tag className="h-3.5 w-3.5" /> หมวดหมู่
          </button>
          <button className="btn-outline text-xs min-h-[44px]" onClick={() => setLogOpen(true)}>
            <History className="h-3.5 w-3.5" /> ประวัติแก้ไข
          </button>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={(e) => e.target.files?.[0] && onImport(e.target.files[0])}
        />
      </div>

      {/* Filter Bar */}
      <div className="card space-y-4">
        <div className="grid gap-3 sm:grid-cols-4">
          <div className="relative sm:col-span-2">
            <Search className="absolute left-3.5 top-3 h-4 w-4 text-slate-400" />
            <input
              className="input pl-10"
              placeholder="ค้นหาชื่อครุภัณฑ์ / เลขครุภัณฑ์ / Serial Number"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <select className="input min-h-[44px]" value={cat} onChange={(e) => setCat(e.target.value)}>
            <option value="">ทุกหมวดหมู่ ({mergedCategories.length})</option>
            {mergedCategories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <select className="input min-h-[44px]" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">ทุกสถานะ</option>
            {Object.entries(EQUIPMENT_STATUS_META).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center justify-between border-t border-slate-100 pt-3 text-xs text-slate-500 font-medium">
          <div>
            พบทั้งหมด <span className="font-bold text-slate-900">{list.length}</span> รายการ
          </div>
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              className="h-4 w-4 rounded accent-brand-600"
              checked={showDeleted}
              onChange={(e) => setShowDeleted(e.target.checked)}
            />
            แสดงเฉพาะรายการที่ถูกลบ (Soft Delete)
          </label>
        </div>
      </div>

      {/* Mobile Card List View */}
      <div className="space-y-3 sm:hidden">
        {loading ? (
          <div className="p-8 text-center text-slate-500 bg-white rounded-2xl border border-slate-200">
            กำลังโหลดข้อมูล...
          </div>
        ) : !list.length ? (
          <div className="p-8 text-center text-slate-500 bg-white rounded-2xl border border-slate-200">
            <Package className="mx-auto h-8 w-8 text-slate-300 mb-2" />
            ไม่พบรายการครุภัณฑ์
          </div>
        ) : (
          list.map((e) => (
            <div key={e.id} className="p-4 rounded-2xl border border-slate-200 bg-white shadow-xs space-y-3">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono font-bold text-xs text-slate-800 bg-slate-100 px-2.5 py-1 rounded-md">
                  {e.assetNumber}
                </span>
                <EquipmentBadge status={e.status} deleted={e.isDeleted} />
              </div>

              <div>
                <div className="font-bold text-slate-900 text-sm leading-snug">{e.name}</div>
                <div className="text-xs text-slate-500 font-medium mt-0.5">
                  {[e.brand, e.model, e.serialNumber && `S/N: ${e.serialNumber}`]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
                <span className="bg-slate-50 border border-slate-200 px-2 py-0.5 rounded-md">
                  🏷️ {catName[e.categoryId] ?? e.categoryId}
                </span>
                {e.location && (
                  <span className="bg-slate-50 border border-slate-200 px-2 py-0.5 rounded-md">
                    📍 {e.location}
                  </span>
                )}
              </div>

              <div className="pt-2 border-t border-slate-100 flex items-center justify-end gap-2">
                {e.isDeleted ? (
                  <button
                    className="btn-outline text-xs text-emerald-700 hover:bg-emerald-50 min-h-[40px] px-3 w-full flex items-center justify-center gap-1.5"
                    onClick={() => onRestore(e)}
                  >
                    <RotateCcw className="h-3.5 w-3.5" /> กู้คืนครุภัณฑ์
                  </button>
                ) : (
                  <div className="grid grid-cols-4 gap-1.5 w-full">
                    <button
                      className="btn-outline text-xs text-amber-700 hover:text-amber-800 hover:bg-amber-50 min-h-[40px] flex items-center justify-center gap-1"
                      onClick={() => openRepairForm([e])}
                      title="ออกใบแจ้งซ่อมแซม"
                    >
                      <Wrench className="h-3.5 w-3.5 text-amber-600" /> ซ่อม
                    </button>
                    <button
                      className="btn-outline text-xs text-slate-700 hover:text-brand-700 min-h-[40px] flex items-center justify-center gap-1"
                      onClick={() => {
                        setQrModalEquipments([e]);
                        setQrModalOpen(true);
                      }}
                    >
                      <QrCode className="h-3.5 w-3.5 text-brand-600" /> QR
                    </button>
                    <button
                      className="btn-outline text-xs min-h-[40px] flex items-center justify-center gap-1"
                      onClick={() => setEditing(e)}
                    >
                      <Edit className="h-3.5 w-3.5" /> แก้ไข
                    </button>
                    <button
                      className="btn-outline text-xs text-rose-600 hover:border-rose-300 hover:bg-rose-50 min-h-[40px] flex items-center justify-center gap-1"
                      onClick={() => setDeleteTarget(e)}
                    >
                      <Trash2 className="h-3.5 w-3.5" /> ลบ
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Desktop Data Table */}
      <div className="hidden sm:block overflow-x-auto rounded-2xl border border-slate-200/80 bg-white shadow-xs">
        <table className="min-w-full divide-y divide-slate-100 text-sm">
          <thead>
            <tr>
              <th className="th">เลขครุภัณฑ์</th>
              <th className="th">ชื่อครุภัณฑ์</th>
              <th className="th">หมวดหมู่</th>
              <th className="th">สถานที่เก็บ</th>
              <th className="th">สถานะ</th>
              <th className="th text-right">จัดการ</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading ? (
              <tr>
                <td className="td text-center py-10" colSpan={6}>
                  กำลังโหลดข้อมูล...
                </td>
              </tr>
            ) : !list.length ? (
              <tr>
                <td className="td text-center text-slate-500 py-12" colSpan={6}>
                  <Package className="mx-auto h-8 w-8 text-slate-300 mb-2" />
                  ไม่พบรายการครุภัณฑ์
                </td>
              </tr>
            ) : (
              list.map((e) => (
                <tr key={e.id} className="transition hover:bg-slate-50/70">
                  <td className="td font-mono font-bold text-slate-800 text-xs">{e.assetNumber}</td>
                  <td className="td">
                    <div className="font-bold text-slate-900">{e.name}</div>
                    <div className="text-xs text-slate-500 font-medium">
                      {[e.brand, e.model, e.serialNumber && `S/N: ${e.serialNumber}`]
                        .filter(Boolean)
                        .join(' · ')}
                    </div>
                  </td>
                  <td className="td text-slate-600">{catName[e.categoryId] ?? e.categoryId}</td>
                  <td className="td text-slate-600">{e.location || '-'}</td>
                  <td className="td">
                    <EquipmentBadge status={e.status} deleted={e.isDeleted} />
                  </td>
                  <td className="td whitespace-nowrap text-right">
                    {e.isDeleted ? (
                      <button
                        className="btn-outline text-xs text-emerald-700 hover:bg-emerald-50"
                        onClick={() => onRestore(e)}
                      >
                        <RotateCcw className="h-3 w-3" /> กู้คืน
                      </button>
                    ) : (
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          className="btn-outline text-xs text-amber-700 hover:text-amber-800 hover:border-amber-300 hover:bg-amber-50"
                          onClick={() => openRepairForm([e])}
                          title="ออกใบแจ้งซ่อมแซมสำหรับครุภัณฑ์นี้"
                        >
                          <Wrench className="h-3.5 w-3.5 text-amber-600" /> แจ้งซ่อม
                        </button>
                        <button
                          className="btn-outline text-xs text-slate-700 hover:text-brand-700"
                          onClick={() => {
                            setQrModalEquipments([e]);
                            setQrModalOpen(true);
                          }}
                          title="ดูและพิมพ์ป้าย QR Code"
                        >
                          <QrCode className="h-3.5 w-3.5 text-brand-600" /> QR
                        </button>
                        <button className="btn-outline text-xs" onClick={() => setEditing(e)}>
                          <Edit className="h-3.5 w-3.5" /> แก้ไข
                        </button>
                        <button
                          className="btn-outline text-xs text-rose-600 hover:border-rose-300 hover:bg-rose-50"
                          onClick={() => setDeleteTarget(e)}
                        >
                          <Trash2 className="h-3.5 w-3.5" /> ลบ
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <EquipmentForm
        key={editing === 'new' ? 'new' : editing?.id ?? 'none'}
        open={!!editing}
        existing={editing === 'new' ? undefined : editing ?? undefined}
        categories={mergedCategories}
        onClose={() => setEditing(null)}
        onSaved={(t) => {
          setEditing(null);
          setMsg({ kind: 'success', text: t });
        }}
      />
      <CategoryManager
        open={catOpen}
        onClose={() => setCatOpen(false)}
        equipments={equipments}
      />
      <AuditLog open={logOpen} onClose={() => setLogOpen(false)} />
      <AssetQrModal
        open={qrModalOpen}
        onClose={() => setQrModalOpen(false)}
        initialEquipments={qrModalEquipments}
        allEquipments={equipments.filter((e) => !e.isDeleted)}
        categories={mergedCategories}
      />
      <RepairFormModal
        open={repairModalOpen}
        onClose={() => setRepairModalOpen(false)}
        currentUser={me}
        initialEquipments={repairModalEquipments}
      />

      {/* Delete Confirmation Modal */}
      <ConfirmDialog
        open={!!deleteTarget}
        danger={true}
        title="ยืนยันการลบครุภัณฑ์"
        message={`คุณต้องการลบ "${deleteTarget?.name}" (เลขครุภัณฑ์: ${deleteTarget?.assetNumber}) ใช่หรือไม่? หากเคยมีประวัติการยืม ระบบจะทำการ Soft Delete เพื่อเก็บรักษาประวัติไว้`}
        confirmLabel="ลบครุภัณฑ์"
        cancelLabel="ยกเลิก"
        onConfirm={handleConfirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}

function EquipmentForm({
  open,
  existing,
  categories,
  onClose,
  onSaved,
}: {
  open: boolean;
  existing?: Equipment;
  categories: { id: string; name: string }[];
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const { profile } = useAuth();
  const [f, setF] = useState<EquipmentInput>(() => ({
    assetNumber: existing?.assetNumber ?? '',
    name: existing?.name ?? '',
    categoryId: existing?.categoryId ?? (categories[0]?.id || 'CAT-COMPUTER'),
    brand: existing?.brand ?? '',
    model: existing?.model ?? '',
    serialNumber: existing?.serialNumber ?? '',
    accessories: existing?.accessories ?? [],
    location: existing?.location ?? '',
    acquiredDate: existing?.acquiredDate ?? '',
    price: existing?.price ?? null,
    imageUrl: existing?.imageUrl ?? '',
    note: existing?.note ?? '',
    status: existing?.status ?? 'AVAILABLE',
  }));
  const [accText, setAccText] = useState((existing?.accessories ?? []).join(', '));
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [showUrlInput, setShowUrlInput] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof EquipmentInput>(k: K, v: EquipmentInput[K]) =>
    setF((p) => ({ ...p, [k]: v }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!f.assetNumber.trim()) {
      setError('กรุณากรอกเลขครุภัณฑ์');
      return;
    }
    if (!f.name.trim()) {
      setError('กรุณากรอกชื่อครุภัณฑ์');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const accessories = accText
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

      await saveEquipment(
        profile!,
        {
          ...f,
          accessories,
        },
        existing
      );

      onSaved(existing ? `บันทึกการแก้ไข "${f.name}" แล้ว` : `เพิ่มครุภัณฑ์ "${f.name}" เรียบร้อยแล้ว`);
    } catch (err) {
      console.error('Save equipment error:', err);
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const onImage = async (file?: File) => {
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const url = await uploadEquipmentImage(file);
      set('imageUrl', url);
    } catch (err) {
      setError(`ไม่สามารถประมวลผลรูปภาพได้: ${errMsg(err)}`);
    } finally {
      setUploading(false);
    }
  };

  const statusOptions: EquipmentStatus[] =
    existing?.status === 'BORROWED'
      ? ['BORROWED']
      : ['AVAILABLE', 'MAINTENANCE', 'LOST', 'RETIRED'];

  return (
    <Modal open={open} onClose={onClose} title={existing ? 'แก้ไขข้อมูลครุภัณฑ์' : 'เพิ่มครุภัณฑ์ใหม่'}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert>{error}</Alert>}

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label">เลขครุภัณฑ์ *</label>
            <input
              className="input font-mono"
              placeholder="เช่น 7440-001-0001/67"
              value={f.assetNumber}
              onChange={(e) => set('assetNumber', e.target.value)}
              required
            />
          </div>
          <div>
            <label className="label">ชื่อครุภัณฑ์ *</label>
            <input
              className="input"
              placeholder="เช่น โน้ตบุ๊ก Dell Latitude 5440"
              value={f.name}
              onChange={(e) => set('name', e.target.value)}
              required
            />
          </div>
          <div>
            <label className="label">หมวดหมู่ *</label>
            <select
              className="input"
              value={f.categoryId}
              onChange={(e) => set('categoryId', e.target.value)}
              required
            >
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">สถานะ</label>
            <select
              className="input"
              value={f.status}
              onChange={(e) => set('status', e.target.value as EquipmentStatus)}
              disabled={existing?.status === 'BORROWED'}
            >
              {statusOptions.map((s) => (
                <option key={s} value={s}>
                  {EQUIPMENT_STATUS_META[s].label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">ยี่ห้อ (Brand)</label>
            <input
              className="input"
              placeholder="เช่น Dell, Epson, Sony"
              value={f.brand || ''}
              onChange={(e) => set('brand', e.target.value)}
            />
          </div>
          <div>
            <label className="label">รุ่น (Model)</label>
            <input
              className="input"
              placeholder="เช่น Latitude 5440"
              value={f.model || ''}
              onChange={(e) => set('model', e.target.value)}
            />
          </div>
          <div>
            <label className="label">Serial Number</label>
            <input
              className="input font-mono text-xs"
              placeholder="S/N ประจำตัวเครื่อง"
              value={f.serialNumber || ''}
              onChange={(e) => set('serialNumber', e.target.value)}
            />
          </div>
          <div>
            <label className="label">สถานที่เก็บประจำ</label>
            <input
              className="input"
              placeholder="เช่น ห้อง IT ชั้น 2"
              value={f.location || ''}
              onChange={(e) => set('location', e.target.value)}
            />
          </div>
          <div>
            <label className="label">วันที่ได้มา</label>
            <input
              type="date"
              className="input"
              value={f.acquiredDate || ''}
              onChange={(e) => set('acquiredDate', e.target.value)}
            />
          </div>
          <div>
            <label className="label">ราคาครุภัณฑ์ (บาท)</label>
            <input
              type="number"
              min={0}
              className="input"
              placeholder="0.00"
              value={f.price ?? ''}
              onChange={(e) =>
                set('price', e.target.value ? Number(e.target.value) : null)
              }
            />
          </div>
          <div className="sm:col-span-2">
            <label className="label">อุปกรณ์เสริมที่ต้องส่งมอบด้วย (คั่นด้วยเครื่องหมายจุลภาค ,)</label>
            <input
              className="input"
              value={accText}
              onChange={(e) => setAccText(e.target.value)}
              placeholder="เช่น สายชาร์จแท้, กระเป๋า, เมาส์ไร้สาย, รีโมท"
            />
          </div>
          <div className="sm:col-span-2">
            <label className="label">หมายเหตุเพิ่มเติม</label>
            <input
              className="input"
              value={f.note || ''}
              onChange={(e) => set('note', e.target.value)}
              placeholder="เช่น สำหรับโครงการบริการวิชาการเท่านั้น"
            />
          </div>

          {/* Image Upload Section */}
          <div className="sm:col-span-2 space-y-2">
            <div className="flex items-center justify-between">
              <label className="label mb-0">รูปภาพครุภัณฑ์</label>
              <button
                type="button"
                onClick={() => setShowUrlInput(!showUrlInput)}
                className="text-xs font-semibold text-brand-600 hover:text-brand-800 flex items-center gap-1"
              >
                <LinkIcon className="h-3 w-3" /> {showUrlInput ? 'อัปโหลดจากไฟล์' : 'ระบุ URL รูปภาพ'}
              </button>
            </div>

            {showUrlInput ? (
              <input
                className="input text-xs"
                placeholder="https://example.com/image.jpg"
                value={f.imageUrl || ''}
                onChange={(e) => set('imageUrl', e.target.value)}
              />
            ) : (
              <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4 rounded-2xl border border-dashed border-slate-200 p-4 bg-slate-50/50">
                <div className="relative">
                  {f.imageUrl ? (
                    <div className="relative group">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={f.imageUrl}
                        alt=""
                        className="h-24 w-24 rounded-xl object-cover border border-slate-200 shadow-xs"
                      />
                      <button
                        type="button"
                        onClick={() => set('imageUrl', '')}
                        className="absolute -top-2 -right-2 flex h-6 w-6 items-center justify-center rounded-full bg-rose-600 text-white shadow hover:bg-rose-700"
                        title="ลบรูปภาพนี้"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ) : (
                    <div className="flex h-24 w-24 items-center justify-center rounded-xl bg-slate-100 text-slate-400 border border-slate-200/60">
                      <ImageIcon className="h-10 w-10 text-slate-300" />
                    </div>
                  )}
                  {uploading && (
                    <div className="absolute inset-0 flex items-center justify-center bg-white/80 rounded-xl">
                      <Loader2 className="h-6 w-6 animate-spin text-brand-600" />
                    </div>
                  )}
                </div>

                <div className="flex-1 space-y-2">
                  <div className="flex items-center gap-2">
                    <label className="btn-outline text-xs cursor-pointer py-2">
                      <Upload className="h-3.5 w-3.5" /> เลือกรูปภาพจากเครื่อง...
                      <input
                        type="file"
                        accept="image/*"
                        onChange={(e) => onImage(e.target.files?.[0])}
                        className="hidden"
                      />
                    </label>
                    {f.imageUrl && (
                      <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700 bg-emerald-50 px-2 py-1 rounded-md border border-emerald-200">
                        <CheckCircle2 className="h-3.5 w-3.5" /> แนบรูปภาพแล้ว
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-slate-400 leading-tight">
                    {uploading
                      ? 'กำลังประมวลผลและบีบอัดรูปภาพอัตโนมัติ...'
                      : 'รองรับไฟล์ JPG, PNG, WebP ทุกขนาด (ระบบจะบีบอัดให้คมชัดและโหลดไวอัตโนมัติ)'}
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2.5 border-t border-slate-100 pt-4">
          <button type="button" className="btn-outline min-h-[44px]" onClick={onClose} disabled={busy}>
            ยกเลิก
          </button>
          <button type="submit" className="btn-primary min-h-[44px]" disabled={busy || uploading}>
            {busy ? 'กำลังบันทึก...' : 'บันทึกข้อมูลครุภัณฑ์'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function CategoryManager({
  open,
  onClose,
  equipments,
}: {
  open: boolean;
  onClose: () => void;
  equipments: Equipment[];
}) {
  const { profile } = useAuth();
  const { data: categories } = useCategories();
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errMsg(e));
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="จัดการหมวดหมู่ครุภัณฑ์">
      {error && <div className="mb-3"><Alert>{error}</Alert></div>}
      <div className="mb-4 flex flex-wrap gap-2">
        <input
          className="input w-44 font-mono text-xs"
          placeholder="รหัส เช่น CAT-CAMERA"
          value={id}
          onChange={(e) => setId(e.target.value)}
        />
        <input
          className="input flex-1"
          placeholder="ชื่อหมวดหมู่ เช่น กล้องถ่ายภาพ"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button
          className="btn-primary"
          onClick={() =>
            run(async () => {
              await saveCategory(profile!, id, name);
              setId('');
              setName('');
            })
          }
        >
          เพิ่ม/แก้ไข
        </button>
      </div>
      <ul className="divide-y divide-slate-100 max-h-80 overflow-y-auto">
        {[...categories]
          .sort((a, b) => a.name.localeCompare(b.name, 'th'))
          .map((c) => (
            <li key={c.id} className="flex items-center justify-between py-2.5 text-sm">
              <div>
                <span className="font-mono text-xs font-bold text-slate-500">{c.id}</span> ·{' '}
                <span className="font-semibold text-slate-900">{c.name}</span>{' '}
                <span className="text-xs text-slate-500 font-medium">
                  (
                  {
                    equipments.filter((e) => e.categoryId === c.id && !e.isDeleted).length
                  }{' '}
                  รายการ)
                </span>
                {!c.isActive && (
                  <span className="ml-1 text-xs font-semibold text-rose-500">(ปิดใช้)</span>
                )}
              </div>
              <div className="flex gap-1.5">
                <button
                  className="btn-outline text-xs px-2.5 py-1"
                  onClick={() => {
                    setId(c.id);
                    setName(c.name);
                  }}
                >
                  แก้ไข
                </button>
                <button
                  className="btn-outline text-xs px-2.5 py-1"
                  onClick={() =>
                    run(() => saveCategory(profile!, c.id, c.name, !c.isActive))
                  }
                >
                  {c.isActive ? 'ปิด' : 'เปิด'}
                </button>
                <button
                  className="btn-outline text-xs px-2.5 py-1 text-rose-600"
                  onClick={() =>
                    confirm(`ยืนยันลบหมวด "${c.name}"?`) &&
                    run(() => deleteCategory(profile!, c, equipments))
                  }
                >
                  ลบ
                </button>
              </div>
            </li>
          ))}
      </ul>
    </Modal>
  );
}

interface LogRow {
  id: string;
  action: string;
  entity: string;
  entityId: string;
  byName: string;
  at: Timestamp;
  changes: Record<string, unknown> | null;
}

function AuditLog({ open, onClose }: { open: boolean; onClose: () => void}) {
  const { data } = useLiveQuery<LogRow>(
    () =>
      open
        ? query(collection(fb().db, 'audit_logs'), orderBy('at', 'desc'), limit(50))
        : null,
    [open]
  );

  return (
    <Modal open={open} onClose={onClose} title="ประวัติการแก้ไขข้อมูล (Audit Log 50 รายการล่าสุด)">
      <ul className="max-h-[60vh] divide-y divide-slate-100 overflow-y-auto text-sm pr-1">
        {data.map((l) => (
          <li key={l.id} className="py-3">
            <div className="flex items-center justify-between">
              <div>
                <span className="rounded-md bg-slate-100 px-2 py-0.5 font-mono text-xs font-bold text-slate-800">
                  {l.action}
                </span>{' '}
                <span className="text-slate-600 font-medium">
                  {l.entity}/{l.entityId}
                </span>
              </div>
              <span className="text-xs text-slate-500 font-medium">{fmtTs(l.at)}</span>
            </div>
            <div className="mt-1 text-xs text-slate-500 font-medium">
              ผู้ดำเนินการ: <span className="text-slate-800 font-bold">{l.byName}</span>
            </div>
            {l.changes && (
              <pre className="mt-2 overflow-x-auto rounded-xl bg-slate-50 p-3 text-xs font-mono text-slate-700 border border-slate-100">
                {JSON.stringify(l.changes, null, 2)}
              </pre>
            )}
          </li>
        ))}
      </ul>
    </Modal>
  );
}

function AssetQrModal({
  open,
  onClose,
  initialEquipments,
  allEquipments,
  categories,
}: {
  open: boolean;
  onClose: () => void;
  initialEquipments: Equipment[];
  allEquipments: Equipment[];
  categories: { id: string; name: string }[];
}) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => new Set(initialEquipments.map((e) => e.id))
  );
  const [filterCat, setFilterCat] = useState('');
  const [stickerSize, setStickerSize] = useState<'standard' | 'large'>('standard');

  // Sync initial selection when opened
  useMemo(() => {
    if (open) {
      setSelectedIds(new Set(initialEquipments.map((e) => e.id)));
    }
  }, [open, initialEquipments]);

  const filteredItems = useMemo(() => {
    if (!filterCat) return allEquipments;
    return allEquipments.filter((e) => e.categoryId === filterCat);
  }, [allEquipments, filterCat]);

  const itemsToPrint = useMemo(() => {
    return allEquipments.filter((e) => selectedIds.has(e.id));
  }, [allEquipments, selectedIds]);

  const toggleItem = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAllFiltered = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      filteredItems.forEach((e) => next.add(e.id));
      return next;
    });
  };

  const deselectAllFiltered = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      filteredItems.forEach((e) => next.delete(e.id));
      return next;
    });
  };

  const handlePrint = () => {
    window.print();
  };

  const getBaseUrl = () => {
    if (typeof window !== 'undefined') {
      return window.location.origin;
    }
    return 'https://borrowoas.web.app';
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="🖨️ พิมพ์ป้าย QR Code ติดครุภัณฑ์ (Asset QR Label)"
    >
      <div className="space-y-5">
        <style dangerouslySetInnerHTML={{ __html: `
          @media print {
            body * {
              visibility: hidden;
            }
            #printable-qr-area, #printable-qr-area * {
              visibility: visible;
            }
            #printable-qr-area {
              position: absolute;
              left: 0;
              top: 0;
              width: 100%;
              padding: 0;
              margin: 0;
            }
            .no-print {
              display: none !important;
            }
            .page-break {
              page-break-after: always;
            }
          }
        `}} />

        {/* Controls Toolbar (Hidden in Print) */}
        <div className="no-print space-y-3 rounded-2xl bg-slate-50 p-4 border border-slate-200/70">
          <div className="flex flex-wrap items-center justify-between gap-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <select
                className="input text-xs py-1.5 h-8 bg-white"
                value={filterCat}
                onChange={(e) => setFilterCat(e.target.value)}
              >
                <option value="">ทุกหมวดหมู่ ({allEquipments.length})</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>

              <button
                type="button"
                className="btn-outline text-xs py-1 px-2.5 h-8 bg-white"
                onClick={selectAllFiltered}
              >
                <CheckSquare className="h-3.5 w-3.5 text-slate-600" /> เลือกทั้งหมด ({filteredItems.length})
              </button>
              <button
                type="button"
                className="btn-outline text-xs py-1 px-2.5 h-8 bg-white text-slate-500"
                onClick={deselectAllFiltered}
              >
                <Square className="h-3.5 w-3.5" /> ล้างเลือก
              </button>
            </div>

            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-500 font-medium">ขนาดป้าย:</span>
              <button
                type="button"
                className={`rounded-lg px-2.5 py-1 text-xs font-semibold transition ${
                  stickerSize === 'standard'
                    ? 'bg-brand-600 text-white'
                    : 'bg-white text-slate-600 border border-slate-200'
                }`}
                onClick={() => setStickerSize('standard')}
              >
                มาตรฐาน (กะทัดรัด)
              </button>
              <button
                type="button"
                className={`rounded-lg px-2.5 py-1 text-xs font-semibold transition ${
                  stickerSize === 'large'
                    ? 'bg-brand-600 text-white'
                    : 'bg-white text-slate-600 border border-slate-200'
                }`}
                onClick={() => setStickerSize('large')}
              >
                ขนาดใหญ่ (ชัดเจน)
              </button>
            </div>
          </div>

          <div className="flex items-center justify-between text-xs text-slate-600 pt-2 border-t border-slate-200/60">
            <div>
              เลือกแล้ว <b className="text-brand-700 font-bold">{itemsToPrint.length}</b> รายการ จาก {allEquipments.length} รายการ
            </div>
            <div className="text-slate-400">
              💡 แนะนำ: ใช้กระดาษสติกเกอร์ A4 หรือสติกเกอร์ไดคัท และตั้งค่าพิมพ์ Scale 100%
            </div>
          </div>
        </div>

        {/* Printable Area */}
        <div id="printable-qr-area">
          {itemsToPrint.length === 0 ? (
            <div className="text-center py-12 text-slate-400 text-sm">
              ยังไม่ได้เลือกครุภัณฑ์ที่จะพิมพ์ป้าย กรุณาเลือกอย่างน้อย 1 รายการ
            </div>
          ) : (
            <div
              className={`grid gap-3 ${
                stickerSize === 'standard'
                  ? 'grid-cols-1 sm:grid-cols-2 md:grid-cols-3'
                  : 'grid-cols-1 sm:grid-cols-2'
              }`}
            >
              {itemsToPrint.map((item) => {
                const qrVal = `${getBaseUrl()}/borrow/?eq=${encodeURIComponent(item.id)}`;
                return (
                  <div
                    key={item.id}
                    className="relative rounded-xl border-2 border-slate-300 bg-white p-3 shadow-xs flex flex-col justify-between break-inside-avoid print:shadow-none print:border-slate-800"
                    style={{ minHeight: stickerSize === 'standard' ? '140px' : '170px' }}
                  >
                    {/* Header Strip */}
                    <div className="flex items-center justify-between border-b border-slate-100 pb-1.5 mb-2">
                      <div className="flex items-center gap-1.5">
                        <div className="h-4 w-1.5 rounded-full bg-[#9a281e]" />
                        <span className="text-[10px] font-bold text-[#9a281e] tracking-tight uppercase">
                          สำนักบริการวิชาการ มข. (KKU OAS)
                        </span>
                      </div>
                      <span className="text-[9px] font-mono text-slate-400">
                        {item.location || 'KKU OAS'}
                      </span>
                    </div>

                    {/* Content Body */}
                    <div className="flex items-center gap-3">
                      <div className="flex-shrink-0 bg-white p-1 rounded-md border border-slate-200 print:border-slate-400">
                        <QRCodeCanvas
                          value={qrVal}
                          size={stickerSize === 'standard' ? 76 : 96}
                          level="M"
                          includeMargin={false}
                        />
                      </div>

                      <div className="flex-1 min-w-0 space-y-0.5">
                        <div className="text-xs font-bold text-slate-900 line-clamp-2 leading-tight">
                          {item.name}
                        </div>
                        <div className="font-mono text-xs font-black text-[#9a281e] tracking-tight truncate">
                          {item.assetNumber}
                        </div>
                        {item.serialNumber && (
                          <div className="text-[10px] text-slate-500 font-mono truncate">
                            S/N: {item.serialNumber}
                          </div>
                        )}
                        <div className="text-[10px] text-slate-500 truncate">
                          {[item.brand, item.model].filter(Boolean).join(' · ')}
                        </div>
                      </div>
                    </div>

                    {/* Footer Guide */}
                    <div className="mt-2 pt-1 border-t border-slate-100 flex items-center justify-between text-[8px] text-slate-400">
                      <span>📷 สแกนเพื่อยืม/ตรวจนับ</span>
                      <span className="font-mono">{item.id}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Modal Action Buttons (Hidden in Print) */}
        <div className="no-print flex items-center justify-between pt-4 border-t border-slate-100">
          <button
            type="button"
            className="btn-outline"
            onClick={onClose}
          >
            ปิดหน้าต่าง
          </button>
          <button
            type="button"
            className="btn-primary flex items-center gap-2 text-sm py-2 px-5 shadow-md"
            disabled={itemsToPrint.length === 0}
            onClick={handlePrint}
          >
            <Printer className="h-4 w-4" /> สั่งพิมพ์ป้ายสติกเกอร์ ({itemsToPrint.length} ป้าย)
          </button>
        </div>
      </div>
    </Modal>
  );
}

