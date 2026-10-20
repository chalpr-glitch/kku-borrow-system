import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// โหลดข้อมูลบุคลากรและหน่วยงาน
const seedPath = path.join(__dirname, '../data/seed-data.json');
if (!fs.existsSync(seedPath)) {
  console.error('❌ ไม่พบไฟล์ data/seed-data.json');
  process.exit(1);
}
const seedData = JSON.parse(fs.readFileSync(seedPath, 'utf8'));

// ตั้งค่า Firebase Admin
const serviceAccountPath = path.join(__dirname, '../service-account.json');
let app;
if (process.env.FIRESTORE_EMULATOR_HOST) {
  console.log('🔌 เชื่อมต่อ Firestore Emulator:', process.env.FIRESTORE_EMULATOR_HOST);
  app = initializeApp({ projectId: 'kku-oas-borrow' });
} else if (fs.existsSync(serviceAccountPath)) {
  const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
  app = initializeApp({
    credential: cert(serviceAccount),
    projectId: serviceAccount.project_id,
  });
} else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  app = initializeApp();
} else {
  console.log('⚠️ ไม่พบ service-account.json หรือ Emulator');
  console.log('💡 วิธีใช้:');
  console.log('  1. ดาวน์โหลด Service Account JSON จาก Firebase Console และบันทึกเป็น service-account.json');
  console.log('  2. หรือรันผ่าน Emulator: FIRESTORE_EMULATOR_HOST=localhost:8080 node scripts/seed.mjs');
  process.exit(0);
}

const db = getFirestore(app);

// หมวดหมู่ครุภัณฑ์เริ่มต้น
const SAMPLE_CATEGORIES = [
  { id: 'CAT-COMPUTER', name: 'คอมพิวเตอร์และโน้ตบุ๊ก', isActive: true },
  { id: 'CAT-PROJECTOR', name: 'เครื่องฉายภาพและจอโปรเจกเตอร์', isActive: true },
  { id: 'CAT-CAMERA', name: 'กล้องถ่ายภาพและวิดีโอ', isActive: true },
  { id: 'CAT-AUDIO', name: 'อุปกรณ์ระบบเสียงและไมโครโฟน', isActive: true },
  { id: 'CAT-ACCESSORY', name: 'อุปกรณ์เสริมและสายสัญญาณ', isActive: true },
  { id: 'CAT-OTHER', name: 'ครุภัณฑ์อื่นๆ', isActive: true },
];

// รายการครุภัณฑ์ตัวอย่าง
const SAMPLE_EQUIPMENTS = [
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
    note: 'สำหรับงานอบรมและภารกิจทั่วไป',
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
    name: 'โปรเจกเตอร์ Epson EB-FH52',
    categoryId: 'CAT-PROJECTOR',
    brand: 'Epson',
    model: 'EB-FH52 Full HD',
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
    model: 'ILCE-7M4 (A7 IV)',
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
    model: 'Blink 500 Pro B2 (2TX + 1RX)',
    serialNumber: 'SRM-B500-44',
    accessories: ['ไมค์ Lavalier 2 ตัว', 'กล่องชาร์จ', 'สายแปลง 3.5mm สำหรับกล้องและมือถือ'],
    location: 'ห้องเทคโนโลยีสารสนเทศ ชั้น 2',
    acquiredDate: '2024-02-14',
    price: 9900,
    status: 'AVAILABLE',
    isDeleted: false,
  },
  {
    id: 'EQ-006',
    assetNumber: '7440-005-0008/66',
    name: 'จอแสดงผลแบบพกพา ASUS ZenScreen 15.6"',
    categoryId: 'CAT-ACCESSORY',
    brand: 'ASUS',
    model: 'MB16AC',
    serialNumber: 'ASUS-MB16-77',
    accessories: ['สาย Type-C', 'Smart Case/Stand'],
    location: 'ห้องเทคโนโลยีสารสนเทศ ชั้น 2',
    acquiredDate: '2023-12-05',
    price: 7500,
    status: 'AVAILABLE',
    isDeleted: false,
  }
];

async function seed() {
  console.log('🚀 เริ่มต้นนำเข้าข้อมูลตั้งต้น...');

  const batch = db.batch();

  // 1) นำเข้า Users
  console.log(`👤 นำเข้าบุคลากร (${seedData.users.length} ท่าน)...`);
  for (const user of seedData.users) {
    const userRef = db.collection('users').doc(user.email.toLowerCase());
    batch.set(
      userRef,
      {
        ...user,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  }

  // 2) นำเข้า Departments
  console.log(`🏢 นำเข้าหน่วยงาน/ภารกิจ (${seedData.departments.length} หน่วยงาน)...`);
  for (const dept of seedData.departments) {
    const deptRef = db.collection('departments').doc(dept.code);
    batch.set(deptRef, dept, { merge: true });
  }

  // 3) นำเข้า Categories
  console.log(`🏷️ นำเข้าหมวดหมู่ครุภัณฑ์ (${SAMPLE_CATEGORIES.length} หมวด)...`);
  for (const cat of SAMPLE_CATEGORIES) {
    const catRef = db.collection('categories').doc(cat.id);
    batch.set(catRef, cat, { merge: true });
  }

  // 4) นำเข้า Sample Equipments
  console.log(`📦 นำเข้าครุภัณฑ์ตัวอย่าง (${SAMPLE_EQUIPMENTS.length} รายการ)...`);
  for (const eq of SAMPLE_EQUIPMENTS) {
    const eqRef = db.collection('equipments').doc(eq.id);
    batch.set(
      eqRef,
      {
        ...eq,
        createdBy: 'chalpr@kku.ac.th',
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  }

  await batch.commit();
  console.log('✅ นำเข้าข้อมูลสำเร็จเรียบร้อยทั้งหมด!');
}

seed().catch((err) => {
  console.error('❌ เกิดข้อผิดพลาดในการ seed:', err);
  process.exit(1);
});
