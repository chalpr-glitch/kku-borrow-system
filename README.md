# ระบบยืม-คืน ครุภัณฑ์ สำนักบริการวิชาการ มหาวิทยาลัยขอนแก่น (KKU OAS Equipment Borrowing System)

เว็บแอปพลิเคชันจัดการการยืม-คืนครุภัณฑ์ สำนักบริการวิชาการ มหาวิทยาลัยขอนแก่น พัฒนาด้วย **Next.js + Tailwind CSS** และฐานข้อมูลแบบ NoSQL **Google Cloud Firestore (Firebase)**

---

## ✨ คุณสมบัติเด่นของระบบ

1. **การตรวจสอบและอนุมัติ 2 ขั้นตอน (2-Step Approval Workflow)**
   - **ขั้นที่ 1:** **นายชาลี พรหมอินทร์** (`chalpr@kku.ac.th` - ผู้ดูแลอุปกรณ์) ตรวจสอบความพร้อมของครุภัณฑ์, ตรวจสอบการชนของช่วงวันจอง, และตรวจสอบประวัติค้างส่งของผู้ยืม
   - **ขั้นที่ 2:** **นายประหยัด สืบเมืองซ้าย** (`praysu@kku.ac.th` - ผู้อนุมัติ) พิจารณาอนุมัติคำขอที่ผ่านการตรวจสอบแล้ว
2. **เงื่อนไขการยืม:**
   - บุคลากรยืมได้สูงสุดครั้งละไม่เกิน **15 วัน**
   - ระบบตรวจสอบช่วงวันจองที่ซ้อนทับกัน (Overlapping Dates) อัตโนมัติ ทำให้ครุภัณฑ์ 1 ชิ้นสามารถรับการจองล่วงหน้าในคนละช่วงเวลาได้
3. **ระบบจัดการฐานข้อมูลครุภัณฑ์ (เฉพาะผู้ดูแลอุปกรณ์):**
   - เพิ่ม/แก้ไข/ลบ ครุภัณฑ์, อัปโหลดรูปภาพ, บันทึกหมายเลขครุภัณฑ์, S/N, และรายการอุปกรณ์เสริม
   - กฎการลบปลอดภัย (Soft Delete สำหรับครุภัณฑ์ที่เคยมีประวัติการยืม เพื่อคงรายงานย้อนหลังไว้)
   - นำเข้าข้อมูลครุภัณฑ์ผ่านไฟล์ **Excel / CSV** แบบ Batch Import
   - จัดการหมวดหมู่ครุภัณฑ์ และบันทึกประวัติการแก้ไข (Audit Logs)
4. **ระบบติดตามสถานะและการส่งมอบ-รับคืน:**
   - แถบความคืบหน้า (Progress Stepper) และ Timeline บันทึกผู้ดำเนินการทุกขั้นตอน
   - แจ้งเตือนเมื่อใกล้ครบกำหนดคืน (D-3, D-1) และตรวจจับสถานะ **เกินกำหนดคืน (OVERDUE)**
   - ตรวจรับคืนพร้อมบันทึกสภาพอุปกรณ์ (ปกติ / ชำรุด / สูญหาย)
5. **ระบบรายงานสรุปและสถิติ (Reports & Analytics):**
   - Dashboard แสดงสถิติการยืมแยกตามภารกิจ/หน่วยงาน และแยกตามประเภทครุภัณฑ์
   - อันดับครุภัณฑ์ที่ถูกยืมสูงสุด (Top 5) และสถานะคงคลังปัจจุบัน
   - ส่งออกข้อมูลเป็นไฟล์ Excel (.csv) และรองรับการพิมพ์ / บันทึกเป็น PDF

---

## 👥 บทบาทผู้ใช้งานและรายชื่อบุคลากร (อ้างอิงจากฐานข้อมูลสำนักฯ)

| บทบาท | ชื่อ-สกุล | อีเมล | สิทธิ์ในระบบ |
|---|---|---|---|
| **ผู้ดูแลอุปกรณ์ (CUSTODIAN)** | นายชาลี พรหมอินทร์ | `chalpr@kku.ac.th` | ตรวจสอบคำขอยืม (ขั้นที่ 1), จัดการฐานข้อมูลครุภัณฑ์, ส่งมอบ-รับคืนของ, ดูรายงาน |
| **ผู้อนุมัติ (APPROVER)** | นายประหยัด สืบเมืองซ้าย | `praysu@kku.ac.th` | พิจารณาอนุมัติ/ไม่อนุมัติ (ขั้นที่ 2), ติดตามสถานะ, ดูรายงาน |
| **ผู้บริหาร (EXECUTIVE)** | รศ.น.สพ.ดร.ชูชาติ กมลเลิศ และคณะผู้บริหาร | `chukam@kku.ac.th` ฯลฯ | ยื่นคำขอยืม, ติดตามสถานะภาพรวม, ดูรายงานสรุป |
| **บุคลากรทั่วไป (USER)** | บุคลากรสำนักบริการวิชาการทุกท่าน | `@kku.ac.th` | ค้นหาครุภัณฑ์, ยื่นคำขอยืม (<= 15 วัน), ติดตามคำขอของตนเอง |

---

## 🚀 วิธีการติดตั้งและเริ่มต้นใช้งาน

### 1. ติดตั้ง Dependencies
```bash
npm install
```

### 2. กำหนดค่า Firebase (.env.local)
คัดลอกไฟล์ `.env.local.example` เป็น `.env.local` แล้วใส่ค่า Config จาก Firebase Console:
```bash
cp .env.local.example .env.local
```
```env
NEXT_PUBLIC_FIREBASE_API_KEY=AIzaSy...
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=kku-oas-borrow.firebaseapp.com
NEXT_PUBLIC_FIREBASE_PROJECT_ID=kku-oas-borrow
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=kku-oas-borrow.appspot.com
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=...
NEXT_PUBLIC_FIREBASE_APP_ID=...

NEXT_PUBLIC_ALLOWED_DOMAIN=kku.ac.th
```

### 3. นำเข้าข้อมูลตั้งต้น (Seeding Data)
นำเข้าข้อมูลบุคลากร 30 ท่าน และ 13 หน่วยงานจากไฟล์ Excel พร้อมครุภัณฑ์ตัวอย่าง:
1. นำ Service Account Key จาก Firebase Console มาวางที่ `service-account.json` ในโฟลเดอร์โปรเจกต์
2. รันคำสั่ง Seed:
```bash
npm run seed
```

### 4. รันระบบในโหมดพัฒนา (Development Mode)
```bash
npm run dev
```
เปิดเบราว์เซอร์ไปที่ [http://localhost:3000](http://localhost:3000)

### 5. Build & Deploy (Static Export ไปยัง Firebase Hosting)
```bash
npm run build
firebase deploy
```

---

## 📁 โครงสร้างโปรเจกต์

```text
kku-oas-borrow/
├── data/
│   └── seed-data.json         # ข้อมูลบุคลากร 30 คน และหน่วยงาน 13 สังกัด
├── scripts/
│   └── seed.mjs               # สคริปต์นำเข้าข้อมูลสู่ Firestore
├── src/
│   ├── app/                   # Next.js App Router (11 หน้าหลัก)
│   │   ├── admin/equipment/   # หน้าจัดการฐานข้อมูลครุภัณฑ์ (เพิ่ม/แก้ไข/ลบ/นำเข้า)
│   │   ├── approve/           # หน้าคิวอนุมัติ (นายประหยัด)
│   │   ├── borrow/            # หน้าแบบฟอร์มยื่นคำขอยืม
│   │   ├── equipment/         # หน้าแค็ตตาล็อกครุภัณฑ์
│   │   ├── handover/          # หน้าส่งมอบ/รับคืนของ (นายชาลี)
│   │   ├── login/             # หน้าเข้าสู่ระบบด้วย Google KKU
│   │   ├── my-requests/       # หน้าประวัติคำขอของผู้ยืม
│   │   ├── reports/           # หน้ารายงานสรุป กราฟ และส่งออกข้อมูล
│   │   ├── request/           # หน้ารายละเอียดคำขอ + Timeline + Action Panels
│   │   ├── review/            # หน้าคิวตรวจสอบ (นายชาลี)
│   │   ├── tracking/          # หน้าติดตามสถานะคำขอทั้งหมด
│   │   ├── globals.css        # สไตล์ Tailwind v4 & Print Layout
│   │   ├── layout.tsx         # โครงร่างหลัก & Sarabun Font
│   │   └── page.tsx           # หน้า Dashboard รวม
│   ├── components/
│   │   ├── AppShell.tsx       # เมนูด้านข้างตาม Role และแจ้งเตือน Badge
│   │   └── ui.tsx             # คอมโพเนนต์ UI (StatCard, Timeline, Badges, Table)
│   └── lib/
│       ├── auth-context.tsx   # ระบบตรวจสอบสิทธิ์ Google @kku.ac.th
│       ├── equipment.ts       # โมดูลจัดการครุภัณฑ์, รูปภาพ, Audit Logs
│       ├── firebase.ts        # การเชื่อมต่อ Firebase Client
│       ├── hooks.ts           # Realtime Firestore Hooks
│       ├── requests.ts        # โมดูล Workflow 2 ขั้นตอนและ Transaction
│       ├── types.ts           # โครงสร้าง Type ภาษา TypeScript
│       └── utils.ts           # ฟังก์ชันคำนวณวัน, เช็กวันชน, แปลงฟอร์แมต
├── firestore.rules            # กฎความปลอดภัย Firestore ตามสิทธิ์ Role
├── firestore.indexes.json     # ดัชนีการสืบค้นข้อมูล
├── firebase.json              # การตั้งค่า Hosting & Firestore
└── package.json
```
