import os
import random
from datetime import datetime
from dotenv import load_dotenv
from flask import Flask, request, jsonify, abort
from flask_cors import CORS
from google.oauth2 import id_token
from google.auth.transport import requests as google_requests

# Load environment variables
load_dotenv()

# Initialize Database and Email Managers
from db_manager import DatabaseManager
from email_helper import EmailHelper

db = DatabaseManager()
emails = EmailHelper()

app = Flask(__name__, static_folder='../frontend', static_url_path='')
CORS(app)

# Helper to verify token/SSO session and extract user
def get_authorized_user(req):
    auth_header = req.headers.get("Authorization")
    if not auth_header:
        return None
    # Format: Bearer TOKEN
    parts = auth_header.split(" ")
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return None
    
    token = parts[1].strip()
    
    # Support master password for backwards compatibility
    master_pwd = os.getenv("ADMIN_PASSWORD", "admin123")
    if token == master_pwd:
        return {
            "email": "admin_oas@kku.ac.th",
            "name": "นักเทคโนโลยีสารสนเทศ (ระบบ)",
            "status": "admin/ staff",
            "department": "ภารกิจสารสนเทศและบริหารงานทั่วไป"
        }
        
    # Standard check: email token lookup in user database
    return db.get_user_by_email(token)

# Helper to generate unique transaction ID
def generate_tx_id():
    existing_ids = {t.get("transaction_id") for t in db.get_all_transactions()}
    while True:
        tx_id = f"TX-{random.randint(10000, 99999)}"
        if tx_id not in existing_ids:
            return tx_id

# Serve static frontend home page
@app.route('/')
def index_page():
    return app.send_static_file('index.html')

# --- API ENDPOINTS ---

@app.route('/api/auth/sso', methods=['POST'])
def sso_login():
    data = request.json or {}
    email = data.get("email", "").strip().lower()
    
    if not email:
        return jsonify({"error": "กรุณากรอกอีเมลมหาวิทยาลัย"}), 400
        
    user = db.get_user_by_email(email)
    if not user:
        return jsonify({"error": "ไม่พบข้อมูลผู้ใช้งานรายนี้ในฐานข้อมูล สบว. มข. กรุณาติดต่อเจ้าหน้าที่ดูแลระบบ"}), 401
        
    return jsonify({
        "message": "ล็อกอินเข้าใช้งานผ่าน SSO สำเร็จ",
        "user": {
            "email": user["email"],
            "name": user["name"],
            "title": user["title"],
            "division": user["division"],
            "department": user["department"],
            "status": user["status"]
        }
    })

@app.route('/api/config', methods=['GET'])
def get_config():
    return jsonify({
        "google_client_id": os.getenv("GOOGLE_CLIENT_ID", "")
    })

@app.route('/api/auth/google', methods=['POST'])
def google_login():
    data = request.json or {}
    token = data.get("credential")
    client_id = os.getenv("GOOGLE_CLIENT_ID")
    
    if not token:
        return jsonify({"error": "ไม่พบโทเค็นความปลอดภัย"}), 400
        
    if not client_id:
        return jsonify({"error": "ระบบยังไม่ได้ตั้งค่า GOOGLE_CLIENT_ID กรุณาติดต่อผู้ดูแลระบบ"}), 500
        
    try:
        # Verify the Google JWT token
        idinfo = id_token.verify_oauth2_token(token, google_requests.Request(), client_id)
        
        # Verify issuer is Google
        if idinfo['iss'] not in ['accounts.google.com', 'https://accounts.google.com']:
            raise ValueError('Wrong issuer.')
            
        email = idinfo.get('email', '').strip().lower()
        
        user = db.get_user_by_email(email)
        if not user:
            # Auto-register if it's a KKU email
            if email.endswith('@kku.ac.th'):
                new_user_data = {
                    "email": email,
                    "name": idinfo.get('name', 'ผู้ใช้ Google'),
                    "title": "บุคลากร สบว.",
                    "division": "สำนักบริการวิชาการ",
                    "department": "ฝ่ายบริการวิชาการ",
                    "status": "user"
                }
                db.add_user(new_user_data)
                user = new_user_data
            else:
                return jsonify({"error": f"ไม่พบอีเมล {email} ในระบบ และไม่อยู่ในโดเมนมหาวิทยาลัย (@kku.ac.th)"}), 401
                
        return jsonify({
            "message": "เข้าสู่ระบบด้วย Google สำเร็จ",
            "user": {
                "email": user["email"],
                "name": user["name"],
                "title": user.get("title", "บุคลากร"),
                "division": user.get("division", "สำนักบริการวิชาการ"),
                "department": user.get("department", "ฝ่ายบริการวิชาการ"),
                "status": user["status"]
            }
        })
        
    except ValueError as e:
        return jsonify({"error": f"โทเค็นไม่ถูกต้อง: {str(e)}"}), 401
    except Exception as e:
        return jsonify({"error": f"เกิดข้อผิดพลาดในการตรวจสอบสิทธิ์: {str(e)}"}), 500

@app.route('/api/assets', methods=['GET'])
def get_assets():
    try:
        assets = db.get_all_assets()
        return jsonify(assets)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/assets', methods=['POST'])
def add_new_asset():
    user = get_authorized_user(request)
    if not user or user.get("status") != "admin/ staff":
        return jsonify({"error": "ไม่มีสิทธิ์ดำเนินการ เฉพาะนักเทคโนโลยีสารสนเทศเท่านั้น"}), 403
        
    data = request.json or {}
    required = ["asset_id", "asset_name", "category", "serial_number"]
    for field in required:
        if not data.get(field):
            return jsonify({"error": f"กรุณากรอกข้อมูล '{field}'"}), 400
            
    # Normalize inputs
    asset_id = data["asset_id"].strip().upper()
    
    # Check if duplicate exists
    if db.get_asset_by_id(asset_id):
        return jsonify({"error": f"รหัสครุภัณฑ์ {asset_id} มีอยู่ในระบบแล้ว"}), 400
        
    new_asset = {
        "asset_id": asset_id,
        "asset_name": data["asset_name"].strip(),
        "category": data["category"].strip(),
        "serial_number": data["serial_number"].strip(),
        "status": "Available",
        "image_url": data.get("image_url", "").strip() or "https://placehold.co/400x300?text=OAS+KKU"
    }
    
    if db.add_asset(new_asset):
        return jsonify({"message": "เพิ่มครุภัณฑ์ใหม่สำเร็จ", "asset": new_asset}), 201
    return jsonify({"error": "เกิดข้อผิดพลาดในการบันทึกข้อมูลครุภัณฑ์"}), 500

@app.route('/api/assets/<asset_id>', methods=['DELETE'])
def delete_asset(asset_id):
    user = get_authorized_user(request)
    if not user or user.get("status") != "admin/ staff":
        return jsonify({"error": "ไม่มีสิทธิ์ดำเนินการ เฉพาะนักเทคโนโลยีสารสนเทศเท่านั้น"}), 403
        
    asset = db.get_asset_by_id(asset_id)
    if not asset:
        return jsonify({"error": "ไม่พบครุภัณฑ์ดังกล่าวในระบบ"}), 404
        
    # Optional check: prevent deletion of currently Borrowed items
    if asset.get("status") == "Borrowed":
        return jsonify({"error": "ไม่สามารถลบครุภัณฑ์ได้เนื่องจากอุปกรณ์กำลังถูกยืมอยู่"}), 400
        
    if db.delete_asset_by_id(asset_id):
        return jsonify({"message": f"ลบครุภัณฑ์ {asset_id} สำเร็จแล้ว"})
    return jsonify({"error": "เกิดข้อผิดพลาดในการลบข้อมูล"}), 500

@app.route('/api/assets/<asset_id>', methods=['PUT'])
def update_asset_route(asset_id):
    user = get_authorized_user(request)
    if not user or user.get("status") != "admin/ staff":
        return jsonify({"error": "ไม่มีสิทธิ์ดำเนินการ เฉพาะนักเทคโนโลยีสารสนเทศเท่านั้น"}), 403
        
    data = request.json or {}
    asset = db.get_asset_by_id(asset_id)
    if not asset:
        return jsonify({"error": "ไม่พบครุภัณฑ์ดังกล่าวในระบบ"}), 404
        
    # Validation
    if not data.get("asset_name") or not data.get("category") or not data.get("serial_number"):
        return jsonify({"error": "ข้อมูลไม่ครบถ้วน กรุณากรอก ชื่อครุภัณฑ์, ประเภท, และ Serial Number"}), 400
        
    # Populate updated details (keep status and image_url if not provided)
    update_data = {
        "asset_name": data["asset_name"].strip(),
        "category": data["category"].strip(),
        "serial_number": data["serial_number"].strip(),
        "status": data.get("status", asset.get("status", "Available")),
        "image_url": data.get("image_url", asset.get("image_url", "assets/macbook_pro.png"))
    }
    
    if db.update_asset(asset_id, update_data):
        return jsonify({"message": "แก้ไขข้อมูลครุภัณฑ์สำเร็จ", "asset": update_data})
    return jsonify({"error": "เกิดข้อผิดพลาดในการแก้ไขข้อมูล"}), 500


@app.route('/api/transactions', methods=['GET'])
def get_transactions():
    user = get_authorized_user(request)
    if not user or user.get("status") not in ["admin/ staff", "admin / Approve"]:
        return jsonify({"error": "ไม่มีสิทธิ์เข้าถึงข้อมูล"}), 403
        
    try:
        txs = db.get_all_transactions()
        txs.sort(key=lambda x: x.get("transaction_id", ""), reverse=True)
        return jsonify(txs)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/transactions/<tx_id>', methods=['GET'])
def get_transaction(tx_id):
    tx = db.get_transaction_by_id(tx_id)
    if not tx:
        return jsonify({"error": "ไม่พบข้อมูลรายการยืม"}), 404
        
    asset = db.get_asset_by_id(tx["asset_id"])
    return jsonify({
        "transaction": tx,
        "asset": asset
    })

@app.route('/api/transactions', methods=['POST'])
def create_transaction():
    data = request.json or {}
    
    required_fields = [
        "asset_id", "borrower_name", "borrower_email", 
        "department", "head_email", "borrow_date", 
        "expected_return_date", "purpose"
    ]
    
    for field in required_fields:
        if not data.get(field):
            return jsonify({"error": f"กรุณากรอกข้อมูล '{field}' ให้ครบถ้วน"}), 400
            
    email = data["borrower_email"].strip().lower()
    if not (email.endswith("@kku.ac.th") or email.endswith("@g.kku.ac.th")):
        return jsonify({"error": "กรุณาใช้อีเมลมหาวิทยาลัยขอนแก่น (@kku.ac.th หรือ @g.kku.ac.th)"}), 400
        
    asset = db.get_asset_by_id(data["asset_id"])
    if not asset:
        return jsonify({"error": "ไม่พบอุปกรณ์ครุภัณฑ์ดังกล่าว"}), 404
        
    if asset.get("status") != "Available":
        return jsonify({"error": "ขออภัย อุปกรณ์นี้ไม่พร้อมใช้งานในขณะนี้"}), 400
        
    tx_id = generate_tx_id()
    new_tx = {
        "transaction_id": tx_id,
        "asset_id": data["asset_id"],
        "borrower_name": data["borrower_name"],
        "borrower_email": email,
        "department": data["department"],
        "head_email": data["head_email"].strip().lower(),
        "borrow_date": data["borrow_date"],
        "expected_return_date": data["expected_return_date"],
        "actual_return_date": "",
        "status": "Pending Admin",
        "reject_reason": "",
        "purpose": data["purpose"]
    }
    
    if db.add_transaction(new_tx):
        emails.notify_admin_new_request(new_tx, asset)
        return jsonify({"message": "ยื่นคำขอยืมเรียบร้อยแล้ว รอเจ้าหน้าที่ตรวจสอบ", "transaction_id": tx_id}), 201
        
    return jsonify({"error": "เกิดข้อผิดพลาดในการบันทึกข้อมูล"}), 500

@app.route('/api/transactions/<tx_id>/admin-action', methods=['POST'])
def admin_action(tx_id):
    user = get_authorized_user(request)
    if not user or user.get("status") != "admin/ staff":
        return jsonify({"error": "ไม่มีสิทธิ์ดำเนินการ เฉพาะนักเทคโนโลยีสารสนเทศเท่านั้น"}), 403
        
    data = request.json or {}
    action = data.get("action")
    reject_reason = data.get("reject_reason", "")
    
    tx = db.get_transaction_by_id(tx_id)
    if not tx:
        return jsonify({"error": "ไม่พบรายการยืมดังกล่าว"}), 404
        
    if tx.get("status") != "Pending Admin":
        return jsonify({"error": "รายการนี้ได้รับการพิจารณาไปแล้ว"}), 400
        
    asset = db.get_asset_by_id(tx["asset_id"])
    
    if action == "approve":
        db.update_transaction_status(tx_id, "Pending Head")
        tx["status"] = "Pending Head"
        host_url = request.host_url.rstrip('/')
        emails.notify_head_approval(tx, asset, app_url=host_url)
        return jsonify({"message": "ส่งต่อคำขอให้หัวหน้างานพิจารณาเรียบร้อยแล้ว"})
        
    elif action == "reject":
        if not reject_reason:
            return jsonify({"error": "กรุณากรอกเหตุผลการปฏิเสธ"}), 400
            
        db.update_transaction_status(tx_id, "Rejected", reject_reason=reject_reason)
        tx["status"] = "Rejected"
        tx["reject_reason"] = reject_reason
        emails.notify_borrower_rejected(tx, asset, f"นักเทคโนโลยีสารสนเทศ ({user['name']})", reject_reason)
        return jsonify({"message": "ปฏิเสธคำขอเรียบร้อยแล้ว"})
        
    return jsonify({"error": "การทำงานไม่ถูกต้อง"}), 400

@app.route('/api/transactions/<tx_id>/head-action', methods=['POST'])
def head_action(tx_id):
    # SSO verification for Head: The request header's email token must match the head_email in the transaction
    tx = db.get_transaction_by_id(tx_id)
    if not tx:
        return jsonify({"error": "ไม่พบรายการยืมดังกล่าว"}), 404
        
    # Check if the caller is authorized
    caller = get_authorized_user(request)
    # The caller must either be the designated head_email, OR have "admin / Approve" status
    if not caller or (caller.get("email").strip().lower() != tx["head_email"].strip().lower() and caller.get("status") != "admin / Approve"):
        # For legacy compatibility, if it's the master admin token, we allow it
        if not (caller and caller.get("email") == "admin_oas@kku.ac.th"):
            return jsonify({"error": f"ไม่มีสิทธิ์อนุมัติ เฉพาะหัวหน้างาน ({tx['head_email']}) เท่านั้นที่มีสิทธิ์พิจารณา"}), 403

    data = request.json or {}
    action = data.get("action")
    reject_reason = data.get("reject_reason", "")
    
    if tx.get("status") != "Pending Head":
        return jsonify({"error": "รายการนี้ได้รับการพิจารณาไปแล้ว หรือยังไม่ได้รับการคัดกรองจากพัสดุ"}), 400
        
    asset = db.get_asset_by_id(tx["asset_id"])
    
    if action == "approve":
        if asset.get("status") != "Available" and asset.get("status") != "Borrowed":
            return jsonify({"error": "อุปกรณ์ดังกล่าวอยู่ในสถานะไม่พร้อมใช้งานชั่วคราว ไม่สามารถอนุมัติได้"}), 400
            
        db.update_transaction_status(tx_id, "Approved")
        tx["status"] = "Approved"
        db.update_asset_status(tx["asset_id"], "Borrowed")
        emails.notify_borrower_approved(tx, asset)
        return jsonify({"message": "อนุมัติคำขอเรียบร้อยแล้ว ระบบได้ส่งอีเมลแจ้งผู้ยืมเข้ารับอุปกรณ์แล้ว"})
        
    elif action == "reject":
        if not reject_reason:
            return jsonify({"error": "กรุณากรอกเหตุผลการปฏิเสธ"}), 400
            
        db.update_transaction_status(tx_id, "Rejected", reject_reason=reject_reason)
        tx["status"] = "Rejected"
        tx["reject_reason"] = reject_reason
        emails.notify_borrower_rejected(tx, asset, f"หัวหน้าฝ่าย/ผู้อนุมัติ ({caller['name'] if caller else 'ผู้อนุมัติ'})", reject_reason)
        return jsonify({"message": "ปฏิเสธคำขอเรียบร้อยแล้ว"})
        
    return jsonify({"error": "การทำงานไม่ถูกต้อง"}), 400

@app.route('/api/transactions/<tx_id>/return', methods=['POST'])
def return_asset(tx_id):
    user = get_authorized_user(request)
    if not user or user.get("status") != "admin/ staff":
        return jsonify({"error": "ไม่มีสิทธิ์ดำเนินการ เฉพาะนักเทคโนโลยีสารสนเทศเท่านั้น"}), 403
        
    tx = db.get_transaction_by_id(tx_id)
    if not tx:
        return jsonify({"error": "ไม่พบรายการยืมดังกล่าว"}), 404
        
    if tx.get("status") != "Approved":
        return jsonify({"error": f"รายการยืมนี้ไม่สามารถบันทึกคืนได้ เนื่องจากสถานะปัจจุบันคือ: {tx.get('status')}"}), 400
        
    actual_return_date = datetime.now().strftime("%Y-%m-%d")
    db.update_transaction_status(tx_id, "Returned", actual_return_date=actual_return_date)
    db.update_asset_status(tx["asset_id"], "Available")
    
    return jsonify({"message": "บันทึกการส่งคืนครุภัณฑ์เรียบร้อยแล้ว อุปกรณ์พร้อมให้บริการอีกครั้ง"})

@app.route('/api/track', methods=['GET'])
def track_status():
    email = request.args.get("email", "").strip().lower()
    if not email:
        return jsonify([])
        
    txs = db.get_all_transactions()
    user_txs = [t for t in txs if t.get("borrower_email", "").strip().lower() == email]
    
    for t in user_txs:
        asset = db.get_asset_by_id(t["asset_id"])
        t["asset_name"] = asset["asset_name"] if asset else "อุปกรณ์ถูกลบจากระบบ"
        t["image_url"] = asset["image_url"] if asset else ""
        
    user_txs.sort(key=lambda x: x.get("transaction_id", ""), reverse=True)
    return jsonify(user_txs)

@app.route('/api/dashboard/stats', methods=['GET'])
def get_dashboard_stats():
    user = get_authorized_user(request)
    if not user or user.get("status") not in ["admin/ staff", "admin / Approve"]:
        return jsonify({"error": "ไม่มีสิทธิ์เข้าถึง"}), 403
        
    assets = db.get_all_assets()
    txs = db.get_all_transactions()
    today_str = datetime.now().strftime("%Y-%m-%d")
    
    total_assets = len(assets)
    pending_admin = sum(1 for t in txs if t.get("status") == "Pending Admin")
    pending_head = sum(1 for t in txs if t.get("status") == "Pending Head")
    active_loans = sum(1 for t in txs if t.get("status") == "Approved")
    
    overdue_count = 0
    for t in txs:
        if t.get("status") == "Approved":
            expected = t.get("expected_return_date", "")
            if expected and expected < today_str:
                overdue_count += 1
                
    cat_counts = {}
    for a in assets:
        cat = a.get("category", "General")
        cat_counts[cat] = cat_counts.get(cat, 0) + 1
        
    dept_counts = {}
    for t in txs:
        dept = t.get("department", "อื่นๆ")
        dept_counts[dept] = dept_counts.get(dept, 0) + 1
        
    sorted_depts = sorted(dept_counts.items(), key=lambda x: x[1], reverse=True)[:5]
    top_depts = {k: v for k, v in sorted_depts}
    
    monthly_trends = {}
    for t in txs:
        b_date = t.get("borrow_date", "")
        if b_date:
            try:
                yr_mo = b_date[:7]
                monthly_trends[yr_mo] = monthly_trends.get(yr_mo, 0) + 1
            except:
                pass
                
    sorted_months = sorted(monthly_trends.items())
    trends = {k: v for k, v in sorted_months}
    
    return jsonify({
        "total_assets": total_assets,
        "pending_admin": pending_admin,
        "pending_head": pending_head,
        "active_loans": active_loans,
        "overdue_loans": overdue_count,
        "categories": cat_counts,
        "top_departments": top_depts,
        "monthly_trends": trends
    })

@app.route('/api/users', methods=['GET'])
def get_users_list():
    user = get_authorized_user(request)
    if not user or user.get("status") not in ["admin/ staff", "admin / Approve"]:
        return jsonify({"error": "ไม่มีสิทธิ์เข้าถึงข้อมูลผู้ใช้งาน"}), 403
    try:
        users = db.get_all_users()
        users.sort(key=lambda x: x.get("email", "").lower())
        return jsonify(users)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/users', methods=['POST'])
def add_new_user():
    user = get_authorized_user(request)
    if not user or user.get("status") != "admin/ staff":
        return jsonify({"error": "ไม่มีสิทธิ์ดำเนินการ เฉพาะนักเทคโนโลยีสารสนเทศเท่านั้น"}), 403
        
    data = request.json or {}
    required = ["email", "name", "division", "department", "status"]
    for field in required:
        if not data.get(field):
            return jsonify({"error": f"กรุณากรอกข้อมูล '{field}'"}), 400
            
    email = data["email"].strip().lower()
    if not (email.endswith("@kku.ac.th") or email.endswith("@g.kku.ac.th")):
        return jsonify({"error": "กรุณาใช้อีเมลมหาวิทยาลัยขอนแก่น (@kku.ac.th)"}), 400
        
    if db.get_user_by_email(email):
        return jsonify({"error": f"ผู้ใช้งานอีเมล {email} มีอยู่ในระบบแล้ว"}), 400
        
    new_user = {
        "email": email,
        "name": data["name"].strip(),
        "title": data.get("title", "").strip(),
        "admin_title": data.get("admin_title", "").strip(),
        "division": data["division"].strip(),
        "department": data["department"].strip(),
        "status": data["status"].strip()
    }
    
    if db.add_user(new_user):
        return jsonify({"message": "เพิ่มผู้ใช้งานสำเร็จ", "user": new_user}), 201
    return jsonify({"error": "เกิดข้อผิดพลาดในการบันทึกข้อมูลผู้ใช้"}), 500

@app.route('/api/users/<email>', methods=['DELETE'])
def delete_user(email):
    caller = get_authorized_user(request)
    if not caller or caller.get("status") != "admin/ staff":
        return jsonify({"error": "ไม่มีสิทธิ์ดำเนินการ เฉพาะนักเทคโนโลยีสารสนเทศเท่านั้น"}), 403
        
    email_clean = email.strip().lower()
    
    if caller.get("email").strip().lower() == email_clean:
        return jsonify({"error": "ไม่สามารถลบบัญชีของตนเองได้"}), 400
        
    user = db.get_user_by_email(email_clean)
    if not user:
        return jsonify({"error": "ไม่พบข้อมูลผู้ใช้งานนี้ในระบบ"}), 404
        
    if db.delete_user_by_email(email_clean):
        return jsonify({"message": f"ลบผู้ใช้งาน {email_clean} สำเร็จแล้ว"})
    return jsonify({"error": "เกิดข้อผิดพลาดในการลบข้อมูล"}), 500

@app.route('/api/users/<email>', methods=['PUT'])
def update_user_route(email):
    caller = get_authorized_user(request)
    if not caller or caller.get("status") != "admin/ staff":
        return jsonify({"error": "ไม่มีสิทธิ์ดำเนินการ เฉพาะนักเทคโนโลยีสารสนเทศเท่านั้น"}), 403
        
    data = request.json or {}
    email_clean = email.strip().lower()
    
    target_user = db.get_user_by_email(email_clean)
    if not target_user:
        return jsonify({"error": "ไม่พบข้อมูลผู้ใช้งานนี้ในระบบ"}), 404
        
    # Validation
    if not data.get("name") or not data.get("division") or not data.get("department") or not data.get("status"):
        return jsonify({"error": "ข้อมูลไม่ครบถ้วน กรุณากรอก ชื่อ-นามสกุล, กอง, ฝ่าย, และสิทธิ์การใช้งาน"}), 400
        
    update_data = {
        "name": data["name"].strip(),
        "title": data.get("title", "").strip(),
        "admin_title": data.get("admin_title", "").strip(),
        "division": data["division"].strip(),
        "department": data["department"].strip(),
        "status": data["status"].strip()
    }
    
    if db.update_user(email_clean, update_data):
        return jsonify({"message": "แก้ไขข้อมูลผู้ใช้งานสำเร็จ", "user": update_data})
    return jsonify({"error": "เกิดข้อผิดพลาดในการแก้ไขข้อมูล"}), 500


if __name__ == '__main__':
    port = int(os.getenv("PORT", 5001))
    app.run(host='0.0.0.0', port=port, debug=True)
