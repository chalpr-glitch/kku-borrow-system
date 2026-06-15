import os
import smtplib
import logging
from datetime import datetime
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart

# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("EmailHelper")

class EmailHelper:
    def __init__(self):
        self.smtp_host = os.getenv("SMTP_HOST")
        self.smtp_port = os.getenv("SMTP_PORT")
        self.smtp_user = os.getenv("SMTP_USER")
        self.smtp_password = os.getenv("SMTP_PASSWORD")
        self.smtp_sender = os.getenv("SMTP_SENDER", self.smtp_user)
        self.admin_email = os.getenv("ADMIN_EMAIL", "admin_oas@kku.ac.th")
        
        # Local log path
        self.base_dir = os.path.dirname(os.path.abspath(__file__))
        self.email_log_path = os.path.join(self.base_dir, "emails_sent.log")
        
        # Determine if SMTP is ready
        self.use_smtp = all([self.smtp_host, self.smtp_port, self.smtp_user, self.smtp_password])
        if self.use_smtp:
            try:
                self.smtp_port = int(self.smtp_port)
                logger.info(f"SMTP configured. Host: {self.smtp_host}:{self.smtp_port}")
            except ValueError:
                self.use_smtp = False
                logger.error("Invalid SMTP_PORT provided. Falling back to email log.")
        else:
            logger.info("SMTP configuration incomplete. Using local email log file.")

    def _log_email_locally(self, to_email, subject, body_html):
        """Append the email content to a local file for debugging."""
        try:
            timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            with open(self.email_log_path, "a", encoding="utf-8") as f:
                f.write(f"\n==================================================\n")
                f.write(f"TIMESTAMP: {timestamp}\n")
                f.write(f"TO: {to_email}\n")
                f.write(f"SUBJECT: {subject}\n")
                f.write(f"BODY:\n{body_html}\n")
                f.write(f"==================================================\n")
            logger.info(f"Email to {to_email} logged locally to backend/emails_sent.log")
            return True
        except Exception as e:
            logger.error(f"Failed to log email locally: {e}")
            return False

    def send_html_email(self, to_email, subject, body_html):
        """Send an HTML email, falling back to local logging on error/absence."""
        if not self.use_smtp:
            return self._log_email_locally(to_email, subject, body_html)
            
        try:
            msg = MIMEMultipart("alternative")
            msg["Subject"] = subject
            msg["From"] = self.smtp_sender
            msg["To"] = to_email
            
            part = MIMEText(body_html, "html", "utf-8")
            msg.attach(part)
            
            # Connect and send
            with smtplib.SMTP(self.smtp_host, self.smtp_port) as server:
                server.starttls()
                server.login(self.smtp_user, self.smtp_password)
                server.sendmail(self.smtp_sender, to_email, msg.as_string())
                
            logger.info(f"Successfully sent email to {to_email}")
            return True
        except Exception as e:
            logger.error(f"SMTP sending failed: {e}. Logging locally instead.")
            return self._log_email_locally(to_email, subject, body_html)

    # --- Pre-styled Email Notification Functions ---

    def notify_admin_new_request(self, tx, asset):
        """Alert 1: Notify Admin of new transaction pending screening."""
        subject = f"[ระบบยืมคืนครุภัณฑ์ OAS KKU] คำขอยืมใหม่รอการตรวจสอบ - {tx['transaction_id']}"
        body_html = f"""
        <div style="font-family: 'Prompt', 'Sarabun', sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 8px;">
            <div style="background-color: #F15A22; padding: 15px; border-radius: 8px 8px 0 0; text-align: center; color: white;">
                <h2>คำขอยืมครุภัณฑ์ใหม่</h2>
                <p>สำนักบริการวิชาการ มหาวิทยาลัยขอนแก่น (OAS KKU)</p>
            </div>
            <div style="padding: 20px; color: #333333; line-height: 1.6;">
                <p>เรียน <b>นักเทคโนโลยีสารสนเทศ</b>,</p>
                <p>มีคำขอยืมครุภัณฑ์ใหม่เข้ามาในระบบ รายละเอียดดังนี้:</p>
                <table style="width: 100%; border-collapse: collapse;">
                    <tr style="background-color: #f9f9f9;"><td style="padding: 8px; font-weight: bold; width: 40%;">รหัสธุรกรรม:</td><td style="padding: 8px;">{tx['transaction_id']}</td></tr>
                    <tr><td style="padding: 8px; font-weight: bold;">ผู้ขอ:</td><td style="padding: 8px;">{tx['borrower_name']} ({tx['borrower_email']})</td></tr>
                    <tr style="background-color: #f9f9f9;"><td style="padding: 8px; font-weight: bold;">หน่วยงาน/ฝ่าย:</td><td style="padding: 8px;">{tx['department']}</td></tr>
                    <tr><td style="padding: 8px; font-weight: bold;">ครุภัณฑ์ที่ยืม:</td><td style="padding: 8px;"><b>{asset['asset_name']}</b> (รหัส: {tx['asset_id']})</td></tr>
                    <tr style="background-color: #f9f9f9;"><td style="padding: 8px; font-weight: bold;">วันที่เริ่มยืม:</td><td style="padding: 8px;">{tx['borrow_date']}</td></tr>
                    <tr><td style="padding: 8px; font-weight: bold;">กำหนดส่งคืน:</td><td style="padding: 8px;">{tx['expected_return_date']}</td></tr>
                </table>
                <p style="margin-top: 25px; text-align: center;">
                    <a href="http://localhost:5000/" style="background-color: #333333; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; font-weight: bold;">เข้าสู่ระบบจัดการของผู้ดูแลระบบ</a>
                </p>
            </div>
            <div style="background-color: #f5f5f5; padding: 10px; border-radius: 0 0 8px 8px; text-align: center; font-size: 12px; color: #666666;">
                นี่คืออีเมลอัตโนมัติจากระบบ กรุณาอย่าตอบกลับอีเมลนี้
            </div>
        </div>
        """
        return self.send_html_email(self.admin_email, subject, body_html)

    def notify_head_approval(self, tx, asset, app_url="http://localhost:5000"):
        """Alert 2: Notify Department Head to approve/reject the request."""
        subject = f"[ระบบยืมคืนครุภัณฑ์ OAS KKU] ขอความอนุเคราะห์อนุมัติการยืมครุภัณฑ์ - {tx['borrower_name']}"
        approval_url = f"{app_url}/?page=approve&id={tx['transaction_id']}"
        body_html = f"""
        <div style="font-family: 'Prompt', 'Sarabun', sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 8px;">
            <div style="background-color: #F15A22; padding: 15px; border-radius: 8px 8px 0 0; text-align: center; color: white;">
                <h2>ขอความเห็นชอบคำขอยืมครุภัณฑ์</h2>
                <p>สำนักบริการวิชาการ มหาวิทยาลัยขอนแก่น (OAS KKU)</p>
            </div>
            <div style="padding: 20px; color: #333333; line-height: 1.6;">
                <p>เรียน <b>หัวหน้าฝ่าย/ผู้อนุมัติขั้นที่ 2</b>,</p>
                <p>บุคลากรในสังกัดของท่านได้ยื่นขออนุมัติยืมอุปกรณ์/ครุภัณฑ์ รายละเอียดดังนี้:</p>
                <table style="width: 100%; border-collapse: collapse;">
                    <tr style="background-color: #f9f9f9;"><td style="padding: 8px; font-weight: bold; width: 40%;">ผู้ขอยืม:</td><td style="padding: 8px;">{tx['borrower_name']} ({tx['borrower_email']})</td></tr>
                    <tr><td style="padding: 8px; font-weight: bold;">ฝ่ายที่สังกัด:</td><td style="padding: 8px;">{tx['department']}</td></tr>
                    <tr style="background-color: #f9f9f9;"><td style="padding: 8px; font-weight: bold;">ครุภัณฑ์ที่ยืม:</td><td style="padding: 8px;"><b>{asset['asset_name']}</b> (Serial Number: {asset['serial_number']})</td></tr>
                    <tr><td style="padding: 8px; font-weight: bold;">วันที่เริ่มยืม:</td><td style="padding: 8px;">{tx['borrow_date']}</td></tr>
                    <tr style="background-color: #f9f9f9;"><td style="padding: 8px; font-weight: bold;">กำหนดคืน:</td><td style="padding: 8px;">{tx['expected_return_date']}</td></tr>
                </table>
                <p style="margin-top: 25px; text-align: center;">
                    <a href="{approval_url}" style="background-color: #F15A22; color: white; padding: 12px 25px; text-decoration: none; border-radius: 5px; font-weight: bold; display: inline-block;">พิจารณา อนุมัติ/ไม่อนุมัติ</a>
                </p>
                <p style="font-size: 12px; color: #888888; text-align: center; margin-top: 10px;">
                    หรือเข้าลิงก์ตรง: <a href="{approval_url}">{approval_url}</a>
                </p>
            </div>
            <div style="background-color: #f5f5f5; padding: 10px; border-radius: 0 0 8px 8px; text-align: center; font-size: 12px; color: #666666;">
                นี่คืออีเมลอัตโนมัติจากระบบ กรุณาอย่าตอบกลับอีเมลนี้
            </div>
        </div>
        """
        return self.send_html_email(tx["head_email"], subject, body_html)

    def notify_borrower_approved(self, tx, asset):
        """Alert 3: Notify Borrower and Admin of final approval."""
        subject = f"[ระบบยืมคืนครุภัณฑ์ OAS KKU] อนุมัติคำขอยืมครุภัณฑ์เรียบร้อยแล้ว - {tx['transaction_id']}"
        body_html = f"""
        <div style="font-family: 'Prompt', 'Sarabun', sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 8px;">
            <div style="background-color: #28a745; padding: 15px; border-radius: 8px 8px 0 0; text-align: center; color: white;">
                <h2>คำขอยืมครุภัณฑ์ได้รับอนุมัติแล้ว!</h2>
                <p>สำนักบริการวิชาการ มหาวิทยาลัยขอนแก่น (OAS KKU)</p>
            </div>
            <div style="padding: 20px; color: #333333; line-height: 1.6;">
                <p>เรียน คุณ <b>{tx['borrower_name']}</b>,</p>
                <p>คำขอยืมอุปกรณ์/ครุภัณฑ์ของคุณได้รับการตรวจสอบและ<b>อนุมัติ</b>จากหัวหน้างานเรียบร้อยแล้ว:</p>
                <table style="width: 100%; border-collapse: collapse;">
                    <tr style="background-color: #f9f9f9;"><td style="padding: 8px; font-weight: bold; width: 40%;">รหัสธุรกรรม:</td><td style="padding: 8px;">{tx['transaction_id']}</td></tr>
                    <tr><td style="padding: 8px; font-weight: bold;">ครุภัณฑ์:</td><td style="padding: 8px;"><b>{asset['asset_name']}</b></td></tr>
                    <tr style="background-color: #f9f9f9;"><td style="padding: 8px; font-weight: bold;">หมายเลขเครื่อง (Serial):</td><td style="padding: 8px;">{asset['serial_number']}</td></tr>
                    <tr><td style="padding: 8px; font-weight: bold;">กำหนดช่วงเวลายืม:</td><td style="padding: 8px;">{tx['borrow_date']} ถึง {tx['expected_return_date']}</td></tr>
                    <tr style="background-color: #f9f9f9;"><td style="padding: 8px; font-weight: bold;">สถานะ:</td><td style="padding: 8px; color: #28a745; font-weight: bold;">อนุมัติแล้ว / พร้อมรับอุปกรณ์</td></tr>
                </table>
                
                <div style="margin-top: 20px; padding: 15px; background-color: #e8f5e9; border-left: 4px solid #28a745; border-radius: 4px;">
                    <p style="margin: 0; font-weight: bold; color: #1b5e20;">คำแนะนำในการรับอุปกรณ์:</p>
                    <p style="margin: 5px 0 0 0; font-size: 14px;">โปรดนำอีเมลฉบับนี้ไปติดต่อขอรับอุปกรณ์ที่ **ฝ่ายพัสดุและอาคารสถานที่ สำนักบริการวิชาการ มข.** ในวันและเวลาราชการ</p>
                </div>
            </div>
            <div style="background-color: #f5f5f5; padding: 10px; border-radius: 0 0 8px 8px; text-align: center; font-size: 12px; color: #666666;">
                นี่คืออีเมลอัตโนมัติจากระบบ กรุณาอย่าตอบกลับอีเมลนี้
            </div>
        </div>
        """
        # Send to borrower
        self.send_html_email(tx["borrower_email"], subject, body_html)
        # Also CC to Admin
        self.send_html_email(self.admin_email, f"[CC Admin] อนุมัติยืมคืนครุภัณฑ์ - {tx['transaction_id']}", body_html)
        return True

    def notify_borrower_rejected(self, tx, asset, rejecter_role, reason):
        """Alert 4: Notify Borrower of rejection (from Admin or Head)."""
        subject = f"[ระบบยืมคืนครุภัณฑ์ OAS KKU] ปฏิเสธคำขอยืมครุภัณฑ์ - {tx['transaction_id']}"
        body_html = f"""
        <div style="font-family: 'Prompt', 'Sarabun', sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 8px;">
            <div style="background-color: #dc3545; padding: 15px; border-radius: 8px 8px 0 0; text-align: center; color: white;">
                <h2>ขอแสดงความเสียใจ คำขอถูกปฏิเสธ</h2>
                <p>สำนักบริการวิชาการ มหาวิทยาลัยขอนแก่น (OAS KKU)</p>
            </div>
            <div style="padding: 20px; color: #333333; line-height: 1.6;">
                <p>เรียน คุณ <b>{tx['borrower_name']}</b>,</p>
                <p>คำขอยืมอุปกรณ์/ครุภัณฑ์ของคุณได้รับการพิจารณาและ<b>ปฏิเสธการยืม</b>โดย <b>{rejecter_role}</b> รายละเอียดดังนี้:</p>
                <table style="width: 100%; border-collapse: collapse;">
                    <tr style="background-color: #f9f9f9;"><td style="padding: 8px; font-weight: bold; width: 40%;">รหัสธุรกรรม:</td><td style="padding: 8px;">{tx['transaction_id']}</td></tr>
                    <tr><td style="padding: 8px; font-weight: bold;">ครุภัณฑ์ที่ยืม:</td><td style="padding: 8px;"><b>{asset['asset_name']}</b></td></tr>
                    <tr style="background-color: #f9f9f9;"><td style="padding: 8px; font-weight: bold;">เหตุผลการปฏิเสธ:</td><td style="padding: 8px; color: #dc3545; font-weight: bold;">{reason}</td></tr>
                </table>
                <p style="margin-top: 15px;">ท่านสามารถยื่นขออุปกรณ์อื่นๆ หรือตรวจสอบช่วงเวลาใหม่อีกครั้งผ่านหน้าเว็บไซต์หลัก</p>
            </div>
            <div style="background-color: #f5f5f5; padding: 10px; border-radius: 0 0 8px 8px; text-align: center; font-size: 12px; color: #666666;">
                นี่คืออีเมลอัตโนมัติจากระบบ กรุณาอย่าตอบกลับอีเมลนี้
            </div>
        </div>
        """
        return self.send_html_email(tx["borrower_email"], subject, body_html)
