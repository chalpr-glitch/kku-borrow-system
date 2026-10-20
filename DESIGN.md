# KKU OAS Equipment Borrowing — Design System Guidelines (DESIGN.md)

เอกสารแนวทางการออกแบบส่วนติดต่อผู้ใช้ (UI/UX Design System) ของ **ระบบยืม-คืนครุภัณฑ์ สำนักบริการวิชาการ มหาวิทยาลัยขอนแก่น (KKU OAS Equipment Borrowing System)**

---

## 1. สีและชุดสีประจำระบบ (Color Palette)

### 1.1 สีหลักขององค์กร (Primary Brand Colors)
* **Brand Primary (Emerald 600)**: `#059669` — สีหลักของปุ่ม CTA, หัวเรื่อง และไอคอนหลัก
* **Brand Primary Dark (Emerald 700)**: `#047857` — สถานะ Hover/Active และแถบนำทาง
* **Brand Primary Light (Emerald 50)**: `#ecfdf5` — สีพื้นหลังของการ์ดเน้นและสถานะสำเร็จ
* **Deep Navy / Slate 900**: `#0f172a` — สีข้อความหัวข้อหลัก (Headings)

### 1.2 สีสถานะการทำงาน (Workflow Status Colors)
* **Pending / In Review (รอตรวจสอบ - สีอำพัน)**:
  * Text: `#b45309` (`text-amber-700`)
  * Background: `#fffbeb` (`bg-amber-50`)
  * Border: `#fde68a` (`border-amber-200`)
* **Approved / Active (อนุมัติแล้ว / พร้อมใช้งาน - สีเขียวมรกต)**:
  * Text: `#047857` (`text-emerald-700`)
  * Background: `#ecfdf5` (`bg-emerald-50`)
  * Border: `#a7f3d0` (`border-emerald-200`)
* **Extension / In Progress (ต่ออายุ / ส่งมอบแล้ว - สีฟ้าคราม)**:
  * Text: `#0369a1` (`text-sky-700`)
  * Background: `#f0f9ff` (`bg-sky-50`)
  * Border: `#bae6fd` (`border-sky-200`)
* **Rejected / Cancelled / Overdue (ไม่อนุมัติ / ยกเลิก / เกินกำหนด - สีแดงกุหลาบ)**:
  * Text: `#be123c` (`text-rose-700`)
  * Background: `#fff1f2` (`bg-rose-50`)
  * Border: `#fecdd3` (`border-rose-200`)

### 1.3 สีพื้นหลังและข้อความกลาง (Neutrals)
* **Background Body**: `#f8fafc` (`bg-slate-50/70`)
* **Surface / Card**: `#ffffff` (`bg-white`)
* **Text Primary**: `#1e293b` (`text-slate-800`) — อัตรา Contrast ≥ 7:1 (ผ่านเกณฑ์ WCAG AAA)
* **Text Secondary**: `#475569` (`text-slate-600`) หรือ `#64748b` (`text-slate-500 font-medium`) — อัตรา Contrast ≥ 4.5:1 (ผ่านเกณฑ์ WCAG AA)

---

## 2. ระบบตัวพิมพ์ (Typography)

* **ฟอนต์หลัก (Sans)**: `Prompt`, `Sarabun`, `-apple-system`, `BlinkMacSystemFont`, `sans-serif`
* **ลำดับขนาดตัวอักษร (Type Scale)**:
  * **Page Heading (H1)**: `text-2xl font-bold sm:text-3xl font-heading tracking-tight` (24–30px)
  * **Section Heading (H2)**: `text-lg font-bold sm:text-xl font-heading` (18–20px)
  * **Sub-heading (H3)**: `text-base font-bold` (16px)
  * **Body Text**: `text-sm sm:text-base leading-relaxed` (14–16px)
  * **Caption / Meta**: `text-xs font-medium` (12px)
  * **Badge Text**: `text-[11px] sm:text-xs font-bold` (11–12px)

---

## 3. ระยะห่างและมุมโค้ง (Spacing & Radius)

* **Grid Base**: 4px / 8px Increments
* **Container Width**: `max-w-7xl mx-auto px-4 sm:px-6 lg:px-8`
* **มุมโค้ง (Corner Radius)**:
  * ปุ่มและช่องกรอก (Inputs/Buttons): `rounded-xl` (12px)
  * ป้ายสถานะ (Badges): `rounded-lg` (8px) หรือ `rounded-full` (9999px)
  * การ์ดเนื้อหา (Cards): `rounded-2xl` (16px)
  * Modal และกล่องลอย (Dialogs): `rounded-3xl` (24px)
* **เงาและความลอย (Elevation)**:
  * Card: `shadow-xs border border-slate-200/80`
  * Modal: `shadow-2xl border border-slate-200`
  * Floating CTA / Toast: `shadow-lg`

---

## 4. มาตรฐานองค์ประกอบส่วนต่อประสาน (UI Components)

### 4.1 ปุ่ม (Buttons)
* **Touch Target**: ความสูงอย่างน้อย 40–44px (`min-h-[40px]` หรือ `min-h-[44px]`) บนหน้าจอมือถือ
* **Primary Button**: `btn-primary` (พื้นสี Emerald 600, ตัวหนังสือสีขาว, มี Hover/Active feedback)
* **Secondary / Outline**: `btn-outline` (เส้นขอบสี Slate 300, ตัวหนังสือสี Slate 700)
* **Focus Ring**: `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500`

### 4.2 ช่องกรอกข้อมูล (Form Controls)
* ความสูงมาตรฐาน 42–46px
* แสดงข้อความแจ้งเตือนข้อผิดพลาด (Inline Validation Error) กำกับใต้ช่องกรอกด้วยสีแดง `text-rose-600` เสมอ
* เลื่อนโฟกัส (Auto-scroll & focus) ไปยังช่องแรกที่กรอกผิดเมื่อกดส่งฟอร์ม

### 4.3 หน้าต่างป๊อปอัป (Modals & Drawers)
* มี Backdrop Overlay สีดำโปร่งแสง `bg-slate-900/50 backdrop-blur-xs`
* รองรับการปิดด้วยปุ่ม `Escape` บนคีย์บอร์ด
* ล็อกการเลื่อนหน้าจอด้านหลัง (`overflow: hidden` บน `document.body`) ขณะเปิด
* รองรับการคลิกนอกกรอบ (Backdrop Click) เพื่อปิด

### 4.4 การแสดงสถานะการโหลดและข้อมูลว่าง (States)
* **Loading**: แสดงข้อความกำกับร่วมกับ **Skeleton Loader** (`SkeletonGrid` / `TableSkeleton`) เพื่อลดความรู้สึกรอนาน
* **Empty State**: แสดงไอคอนขนาดใหญ่ หัวข้อชัดเจน และมีปุ่ม Action เชิญชวนให้ทำขั้นตอนถัดไป (Call-to-Action)
* **Feedback**: ใช้ In-App Floating Toast แจ้งผลสำเร็จหรือข้อผิดพลาด แทนการใช้เบราว์เซอร์ `alert()`

---

## 5. การรองรับหน้าจอมือถือและการเข้าถึง (Mobile & Accessibility)

* **Mobile Overflow Protection**: แถบแท็บแนวนอนต้องมี `overflow-x-auto scrollbar-none whitespace-nowrap` ไม่ดันขอบจอขยาย
* **iOS Safe Area Inset**: แถบนำทางด้านล่างต้องเพิ่ม `pb-[env(safe-area-inset-bottom)]`
* **Keyboard Accessibility**: ทุกลิงก์ ปุ่ม และการ์ดที่คลิกได้ ต้องมี `role="button"` หรือใช้แท็ก `<button>` พร้อมรองรับการกด `Tab`, `Enter`, และ `Space`
* **Color Contrast (WCAG 2.1 AA)**: หลีกเลี่ยงสีเทาจาง `text-slate-400` บนพื้นขาว ให้ใช้ `text-slate-500` หรือ `text-slate-600` ที่มี Contrast Ratio ไม่ต่ำกว่า 4.5:1
