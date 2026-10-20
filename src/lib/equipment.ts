import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import { fb } from './firebase';
import type { AppUser, BorrowRequest, Category, Equipment, EquipmentStatus } from './types';
import { ACTIVE_STATUSES } from './utils';

export type EquipmentInput = Omit<Equipment, 'id' | 'isDeleted' | 'deletedAt' | 'createdAt' | 'updatedAt' | 'createdBy'>;

async function recordAuditLog(me: AppUser, entity: string, entityId: string, action: string, changes?: Record<string, unknown> | string) {
  try {
    const { db } = fb();
    const detailsStr = typeof changes === 'string' ? changes : changes ? JSON.stringify(changes) : '';
    await addDoc(collection(db, 'audit_logs'), {
      action,
      target: entityId || entity,
      details: detailsStr,
      actor: me.email,
      actorName: me.name,
      actorEmail: me.email,
      timestamp: serverTimestamp(),
      entity,
      entityId,
      by: me.email,
      byName: me.name,
    });
  } catch (err) {
    console.warn('Audit log write failed (non-blocking):', err);
  }
}

async function assetNumberTaken(assetNumber: string, exceptId?: string) {
  try {
    const s = await getDocs(query(collection(fb().db, 'equipments'), where('assetNumber', '==', assetNumber)));
    return s.docs.some((d) => d.id !== exceptId && !d.data()?.isDeleted);
  } catch (err) {
    console.warn('assetNumber check fallback:', err);
    return false;
  }
}

function diff(before: Record<string, unknown>, after: Record<string, unknown>) {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of Object.keys(after)) {
    if (JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null)) {
      out[k] = { from: before[k] ?? null, to: after[k] ?? null };
    }
  }
  return out;
}

/** บีบอัดรูปภาพฝั่ง Client ทันทีแบบรวดเร็วและปลอดภัย (< 60KB) ไม่ต้องรอ Network */
export async function uploadEquipmentImage(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('รองรับเฉพาะไฟล์รูปภาพ (JPG, PNG, WebP)');
  if (file.size > 20 * 1024 * 1024) throw new Error('ไฟล์รูปต้องไม่เกิน 20MB');

  return new Promise((resolve, reject) => {
    try {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          try {
            const canvas = document.createElement('canvas');
            const MAX_WIDTH = 600;
            const MAX_HEIGHT = 450;
            let width = img.width;
            let height = img.height;

            if (width > height) {
              if (width > MAX_WIDTH) {
                height = Math.round((height * MAX_WIDTH) / width);
                width = MAX_WIDTH;
              }
            } else {
              if (height > MAX_HEIGHT) {
                width = Math.round((width * MAX_HEIGHT) / height);
                height = MAX_HEIGHT;
              }
            }

            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            if (!ctx) {
              resolve(e.target?.result as string);
              return;
            }
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'medium';
            ctx.drawImage(img, 0, 0, width, height);
            const dataUrl = canvas.toDataURL('image/jpeg', 0.75);
            resolve(dataUrl);
          } catch (canvasErr) {
            console.error('Canvas compression error:', canvasErr);
            resolve(e.target?.result as string);
          }
        };
        img.onerror = () => reject(new Error('ไม่สามารถประมวลผลไฟล์รูปภาพได้'));
        img.src = e.target?.result as string;
      };
      reader.onerror = () => reject(new Error('เกิดข้อผิดพลาดในการเปิดไฟล์'));
      reader.readAsDataURL(file);
    } catch (err) {
      reject(err);
    }
  });
}

/** เพิ่ม/แก้ไขครุภัณฑ์ */
export async function saveEquipment(me: AppUser, input: EquipmentInput, existing?: Equipment): Promise<string> {
  const { db } = fb();
  const assetNumber = input.assetNumber?.trim();
  const name = input.name?.trim();

  if (!assetNumber) throw new Error('กรุณาระบุเลขครุภัณฑ์');
  if (!name) throw new Error('กรุณาระบุชื่อครุภัณฑ์');
  
  if (await assetNumberTaken(assetNumber, existing?.id)) {
    throw new Error(`เลขครุภัณฑ์ "${assetNumber}" มีอยู่แล้วในระบบ`);
  }

  const payload = {
    assetNumber,
    name,
    categoryId: input.categoryId || 'CAT-OTHER',
    brand: input.brand?.trim() || '',
    model: input.model?.trim() || '',
    serialNumber: input.serialNumber?.trim() || '',
    accessories: Array.isArray(input.accessories) ? input.accessories : [],
    location: input.location?.trim() || '',
    acquiredDate: input.acquiredDate || '',
    price: typeof input.price === 'number' && !isNaN(input.price) ? input.price : null,
    imageUrl: input.imageUrl || '',
    note: input.note?.trim() || '',
    status: (input.status || 'AVAILABLE') as EquipmentStatus,
    updatedAt: serverTimestamp(),
  };

  if (existing) {
    const eqRef = doc(db, 'equipments', existing.id);
    await updateDoc(eqRef, payload);
    const { id: _id, ...before } = existing;
    void _id;
    recordAuditLog(me, 'equipments', existing.id, 'UPDATE', diff(before as Record<string, unknown>, payload));
    return existing.id;
  }

  const newRef = doc(collection(db, 'equipments'));
  await setDoc(newRef, {
    ...payload,
    isDeleted: false,
    deletedAt: null,
    createdBy: me.email,
    createdAt: serverTimestamp(),
  });
  recordAuditLog(me, 'equipments', newRef.id, 'CREATE', { name: payload.name, assetNumber: payload.assetNumber });
  return newRef.id;
}

/** ลบครุภัณฑ์ */
export async function deleteEquipment(me: AppUser, eq: Equipment): Promise<'soft' | 'hard'> {
  const { db } = fb();
  try {
    const s = await getDocs(query(collection(db, 'borrow_requests'), where('equipment.equipmentId', '==', eq.id)));
    const reqs = s.docs.map((d) => ({ ...d.data(), id: d.id }) as BorrowRequest);
    if (reqs.some((r) => ACTIVE_STATUSES.includes(r.status))) {
      throw new Error('ลบไม่ได้: ครุภัณฑ์นี้มีคำขอยืมที่ยังดำเนินการอยู่');
    }
    if (reqs.length > 0) {
      await updateDoc(doc(db, 'equipments', eq.id), {
        isDeleted: true,
        deletedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      recordAuditLog(me, 'equipments', eq.id, 'SOFT_DELETE', { name: eq.name });
      return 'soft';
    }
  } catch (checkErr: unknown) {
    if (checkErr instanceof Error && checkErr.message.includes('ลบไม่ได้')) throw checkErr;
  }

  await deleteDoc(doc(db, 'equipments', eq.id));
  recordAuditLog(me, 'equipments', eq.id, 'HARD_DELETE', { name: eq.name, assetNumber: eq.assetNumber });
  return 'hard';
}

export async function restoreEquipment(me: AppUser, eq: Equipment) {
  const { db } = fb();
  await updateDoc(doc(db, 'equipments', eq.id), {
    isDeleted: false,
    deletedAt: null,
    updatedAt: serverTimestamp(),
  });
  recordAuditLog(me, 'equipments', eq.id, 'RESTORE', { name: eq.name });
}

/** นำเข้าจาก CSV */
export async function importEquipments(me: AppUser, rows: string[][], existingAssetNumbers: Set<string>) {
  const { db } = fb();
  let added = 0;
  const skipped: string[] = [];
  
  for (const r of rows) {
    const [assetNumber, name, categoryId, brand, model, serialNumber, accessories, location, acquiredDate, price] =
      r.map((c) => (c ?? '').trim());
    if (!assetNumber || !name) continue;
    if (existingAssetNumbers.has(assetNumber)) {
      skipped.push(assetNumber);
      continue;
    }
    existingAssetNumbers.add(assetNumber);
    const ref2 = doc(collection(db, 'equipments'));
    await setDoc(ref2, {
      assetNumber,
      name,
      categoryId: categoryId || 'CAT-OTHER',
      brand: brand || '',
      model: model || '',
      serialNumber: serialNumber || '',
      accessories: accessories ? accessories.split(/[;|]/).map((x) => x.trim()).filter(Boolean) : [],
      location: location || '',
      acquiredDate: acquiredDate || '',
      price: price ? Number(price) : null,
      status: 'AVAILABLE' as EquipmentStatus,
      isDeleted: false,
      deletedAt: null,
      createdBy: me.email,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    added++;
  }
  if (added) {
    recordAuditLog(me, 'equipments', '-', 'IMPORT', { added });
  }
  return { added, skipped };
}

/* หมวดหมู่ ------------------------------------------------------------ */
export async function saveCategory(me: AppUser, id: string, name: string, isActive = true) {
  const { db } = fb();
  const cid = id.trim().toUpperCase().replace(/[^A-Z0-9-]/g, '-');
  if (!cid || !name.trim()) throw new Error('กรุณาระบุรหัสและชื่อหมวดหมู่');
  await setDoc(doc(db, 'categories', cid), { name: name.trim(), isActive }, { merge: true });
  recordAuditLog(me, 'categories', cid, 'UPSERT', { name });
}

export async function deleteCategory(me: AppUser, c: Category, equipments: Equipment[]) {
  if (equipments.some((e) => e.categoryId === c.id && !e.isDeleted)) {
    throw new Error('ลบไม่ได้: ยังมีครุภัณฑ์อยู่ในหมวดหมู่นี้');
  }
  const { db } = fb();
  await deleteDoc(doc(db, 'categories', c.id));
  recordAuditLog(me, 'categories', c.id, 'DELETE', { name: c.name });
}
