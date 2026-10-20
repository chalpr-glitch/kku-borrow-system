/**
 * =========================================================================
 * GOOGLE APPS SCRIPT: Email Webhook Gateway for KKU OAS Borrow System
 * สำนักบริการวิชาการ มหาวิทยาลัยขอนแก่น
 * =========================================================================
 * 
 * วิธีการติดตั้งและเผยแพร่ (100% ฟรีบน Google Workspace @kku.ac.th):
 * 1. ไปที่ https://script.google.com ด้วยบัญชีกูเกิลของมหาวิทยาลัย (@kku.ac.th)
 * 2. สร้าง "โครงการใหม่" (New Project) ตั้งชื่อว่า "KKU OAS Borrow Mail Gateway"
 * 3. คัดลอกโค้ดนี้ทั้งหมดไปวางแทนที่โค้ดเดิมในไฟล์ Code.gs
 * 4. กำหนดค่า SHARED_SECRET_TOKEN ด้านล่างให้เป็นรหัสลับที่ปลอดภัย
 * 5. กดปุ่ม "การทำให้ใช้งานได้" (Deploy) -> "การทำให้ใช้งานได้รายการใหม่" (New deployment)
 * 6. เลือกประเภทเป็น "เว็บแอป" (Web app)
 *    - คำอธิบาย (Description): "Production Mail Gateway v1"
 *    - ดำเนินการในฐานะ (Execute as): "ฉัน" (Me - บัญชี @kku.ac.th ของคุณ)
 *    - ผู้มีสิทธิ์เข้าถึง (Who has access): "ทุกคน" (Anyone)
 * 7. กด "ทำให้ใช้งานได้" (Deploy) แล้วคัดลอก "URL เว็บแอป" (ลงท้ายด้วย /exec)
 * 8. นำ URL และ Secret Token ไปกรอกที่เมนู "ตั้งค่าระบบ" (Settings) -> แถบ "อีเมล & Gateway"
 *    บนระบบ https://borrowoas.web.app/admin/settings
 * =========================================================================
 */

// กำหนด Shared Secret Token ให้ตรงกับที่ตั้งค่าในระบบหน้า /admin/settings
var SHARED_SECRET_TOKEN = '93d6cbbb8170d18addee871d22f591eb54fe7e902b89b0cb';

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return responseJson({ status: 'FAILED', message: 'No POST data received' });
    }

    var data = JSON.parse(e.postData.contents);

    // 1. ตรวจสอบ Shared Secret Token ป้องกันการส่งที่ไม่ได้รับอนุญาต
    if (!data.secretToken || data.secretToken !== SHARED_SECRET_TOKEN) {
      return responseJson({ status: 'FAILED', message: 'Unauthorized: Invalid or missing Secret Token' });
    }

    // 2. ตรวจสอบอีเมลผู้รับ (Recipient Validation)
    var toList = Array.isArray(data.to) ? data.to : [data.to];
    var validTo = toList.filter(function(email) {
      return typeof email === 'string' && email.indexOf('@') > 0;
    });

    if (validTo.length === 0) {
      return responseJson({ status: 'FAILED', message: 'No valid recipient email address found' });
    }

    // 3. ตรวจสอบหัวข้ออีเมล (Subject & CRLF Sanitization)
    var subject = (data.subject || 'แจ้งเตือนจากระบบยืม-คืน ครุภัณฑ์ สำนักบริการวิชาการ มข.').replace(/[\r\n]+/g, ' ').trim();
    var htmlBody = data.html || data.text || '';
    var textBody = data.text || '';
    var senderName = data.senderName || 'ระบบยืม-คืน ครุภัณฑ์ สำนักบริการวิชาการ มข.';

    // 4. เตรียมตัวเลือกการส่งอีเมล
    var options = {
      name: senderName,
      htmlBody: htmlBody
    };

    if (data.cc && Array.isArray(data.cc) && data.cc.length > 0) {
      var validCc = data.cc.filter(function(email) {
        return typeof email === 'string' && email.indexOf('@') > 0;
      });
      if (validCc.length > 0) {
        options.cc = validCc.join(',');
      }
    }

    // 5. ส่งอีเมลผ่าน MailApp ของ Google Workspace (@kku.ac.th โควตาสูงสุด 1,500 ฉบับ/วัน)
    var recipientStr = validTo.join(',');
    MailApp.sendEmail(recipientStr, subject, textBody, options);

    var messageId = 'gas_' + new Date().getTime() + '_' + Math.floor(Math.random() * 10000);

    return responseJson({
      status: 'SUCCESS',
      message: 'Email dispatched successfully via Google Apps Script',
      messageId: messageId,
      quotaRemaining: MailApp.getRemainingDailyQuota()
    });

  } catch (err) {
    return responseJson({
      status: 'FAILED',
      message: 'Apps Script Error: ' + err.toString()
    });
  }
}

function doGet(e) {
  // สำหรับตรวจสอบความพร้อม (Health Check / Liveness)
  return responseJson({
    status: 'ONLINE',
    service: 'KKU OAS Borrow Mail Gateway',
    timestamp: new Date().toISOString(),
    quotaRemaining: MailApp.getRemainingDailyQuota()
  });
}

function responseJson(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
