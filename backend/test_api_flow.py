import requests
import json
import os

BASE_URL = "http://localhost:5001"

def run_integration_flow():
    print("=== STARTING COMPLETE WORKFLOW INTEGRATION TEST ===")
    
    # 1. Login as Admin Staff to get headers
    print("\nStep 1: Logging in as Admin Staff (wassjo@kku.ac.th)...")
    res = requests.post(f"{BASE_URL}/api/auth/sso", json={"email": "wassjo@kku.ac.th"})
    assert res.status_code == 200
    admin_data = res.json()["user"]
    admin_headers = {
        "Authorization": f"Bearer {admin_data['email']}",
        "Content-Type": "application/json"
    }
    print(f"Logged in admin: {admin_data['name']}")

    # 2. Add a new user
    print("\nStep 2: Admin creating a new user (test_api_member@kku.ac.th)...")
    new_user_payload = {
        "email": "test_api_member@kku.ac.th",
        "name": "สมาชิกทดสอบ ระบบยืม",
        "title": "นักวิชาการศึกษา",
        "admin_title": "",
        "division": "ศูนย์จัดการศึกษาตลอดชีวิต",
        "department": "ภารกิจสนับสนุนการจัดการศึกษาตลอดชีวิต",
        "status": "user"
    }
    res = requests.post(f"{BASE_URL}/api/users", headers=admin_headers, json=new_user_payload)
    assert res.status_code == 201, f"Failed to add user: {res.text}"
    print(f"User created: {res.json()['message']}")

    # Verify user exists in directory
    res = requests.get(f"{BASE_URL}/api/users", headers=admin_headers)
    users = res.json()
    new_user = next((u for u in users if u["email"] == "test_api_member@kku.ac.th"), None)
    assert new_user is not None, "Created user not found in database"
    print(f"Verified user in DB: {new_user['name']} | Role: {new_user['status']}")

    # 3. Test SSO login for the newly registered user
    print("\nStep 3: Testing SSO login for new user (test_api_member@kku.ac.th)...")
    res = requests.post(f"{BASE_URL}/api/auth/sso", json={"email": "test_api_member@kku.ac.th"})
    assert res.status_code == 200, f"New user SSO failed: {res.text}"
    logged_user = res.json()["user"]
    print(f"Logged in as new user: {logged_user['name']} | Department: {logged_user['department']}")

    # 4. Admin registers a new asset
    print("\nStep 4: Admin registering a new asset (ASSET-TEST-99)...")
    new_asset_payload = {
        "asset_id": "ASSET-TEST-99",
        "asset_name": "Test Asset DSLR Camera",
        "category": "Camera",
        "serial_number": "SN-999-TEST",
        "image_url": "assets/sony_camera.png"
    }
    res = requests.post(f"{BASE_URL}/api/assets", headers=admin_headers, json=new_asset_payload)
    assert res.status_code == 201, f"Failed to register asset: {res.text}"
    print(f"Asset registered: {res.json()['message']}")

    # 5. Submit borrow request for the newly registered user on the new asset
    print("\nStep 5: Submitting borrow request...")
    borrow_payload = {
        "asset_id": "ASSET-TEST-99",
        "borrower_name": logged_user["name"],
        "borrower_email": logged_user["email"],
        "department": f"{logged_user['division']} ({logged_user['department']})",
        "head_email": "praysu@kku.ac.th", # Head Approver
        "borrow_date": "2026-06-16",
        "expected_return_date": "2026-06-22",
        "purpose": "ใช้ทดสอบระบบเพิ่มลบครุภัณฑ์และระบบจัดการผู้ใช้งาน"
    }
    res = requests.post(f"{BASE_URL}/api/transactions", json=borrow_payload)
    assert res.status_code == 201, f"Failed to submit request: {res.text}"
    tx_id = res.json()["transaction_id"]
    print(f"Borrow request submitted. Transaction ID: {tx_id}")

    # 6. Admin Screening: Pass to Head
    print("\nStep 6: Admin screening request (Pass to Head)...")
    res = requests.post(f"{BASE_URL}/api/transactions/{tx_id}/admin-action", headers=admin_headers, json={"action": "approve"})
    assert res.status_code == 200
    print(f"Admin action: {res.json()['message']}")

    # 7. Head Approval: Approve the request
    head_headers = {
        "Authorization": "Bearer praysu@kku.ac.th",
        "Content-Type": "application/json"
    }
    print("\nStep 7: Department Head approving the transaction...")
    res = requests.post(f"{BASE_URL}/api/transactions/{tx_id}/head-action", headers=head_headers, json={"action": "approve"})
    assert res.status_code == 200
    print(f"Head action: {res.json()['message']}")

    # 8. Admin records return
    print("\nStep 8: Admin marking asset as returned...")
    res = requests.post(f"{BASE_URL}/api/transactions/{tx_id}/return", headers=admin_headers)
    assert res.status_code == 200
    print(f"Return response: {res.json()['message']}")

    # 9. Admin Deletes the test asset
    print("\nStep 9: Admin deleting the asset (ASSET-TEST-99)...")
    res = requests.delete(f"{BASE_URL}/api/assets/ASSET-TEST-99", headers=admin_headers)
    assert res.status_code == 200
    print(f"Asset deleted: {res.json()['message']}")

    # 10. Admin Deletes the test user
    print("\nStep 10: Admin deleting the user (test_api_member@kku.ac.th)...")
    res = requests.delete(f"{BASE_URL}/api/users/test_api_member@kku.ac.th", headers=admin_headers)
    assert res.status_code == 200, f"Failed to delete user: {res.text}"
    print(f"User deleted: {res.json()['message']}")

    # Verify user is gone
    res = requests.get(f"{BASE_URL}/api/users", headers=admin_headers)
    users = res.json()
    deleted_user = next((u for u in users if u["email"] == "test_api_member@kku.ac.th"), None)
    assert deleted_user is None, "User was not deleted successfully"
    print("Verified test user no longer exists in database.")

    print("\n=== INTEGRATION TEST COMPLETED SUCCESSFULLY ===")

if __name__ == "__main__":
    run_integration_flow()
