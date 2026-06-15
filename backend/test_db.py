import os
import sys

# Add backend directory to path
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from db_manager import DatabaseManager

def test_database_fallback():
    print("--- starting Database Fallback Verification ---")
    
    # 1. Instantiate database manager
    # It should automatically fall back to local JSON since SPREADSHEET_ID is not configured in .env
    db = DatabaseManager()
    
    print(f"Using Google Sheets: {db.use_google_sheets}")
    assert db.use_google_sheets is False, "Expected use_google_sheets to be False on fallback test"
    
    # 2. Get assets
    assets = db.get_all_assets()
    print(f"Fetched {len(assets)} assets from local database.")
    assert len(assets) > 0, "Assets list should not be empty"
    
    # Check that ASSET-001 exists
    asset = db.get_asset_by_id("ASSET-001")
    assert asset is not None, "ASSET-001 should exist"
    print(f"ASSET-001 Details: {asset['asset_name']} | Status: {asset['status']}")
    
    # 3. Create a test transaction
    test_tx = {
        "transaction_id": "TX-TEST-99",
        "asset_id": "ASSET-001",
        "borrower_name": "ทดสอบ ระบบ",
        "borrower_email": "test@g.kku.ac.th",
        "department": "ฝ่ายเทคโนโลยีสารสนเทศ",
        "head_email": "head_test@kku.ac.th",
        "borrow_date": "2026-06-15",
        "expected_return_date": "2026-06-20",
        "status": "Pending Admin",
        "purpose": "Unit testing the local database layer"
    }
    
    # Check write
    success = db.add_transaction(test_tx)
    assert success is True, "Failed to write transaction"
    print(f"Transaction TX-TEST-99 created successfully.")
    
    # Fetch back
    tx = db.get_transaction_by_id("TX-TEST-99")
    assert tx is not None, "Failed to fetch back TX-TEST-99"
    assert tx["borrower_name"] == "ทดสอบ ระบบ", "Data mismatch in transaction"
    print(f"Fetched transaction status: {tx['status']}")
    
    # 4. Update transaction status to Pending Head
    success = db.update_transaction_status("TX-TEST-99", "Pending Head")
    assert success is True, "Failed to update transaction status"
    tx_updated = db.get_transaction_by_id("TX-TEST-99")
    assert tx_updated["status"] == "Pending Head", "Transaction status did not update correctly"
    print(f"Transaction status updated to: {tx_updated['status']}")
    
    # 5. Clean up test transaction
    # Load all, remove TX-TEST-99, and save
    import json
    with open(db.local_transactions_path, "r", encoding="utf-8") as f:
        txs = json.load(f)
    
    cleaned_txs = [t for t in txs if t.get("transaction_id") != "TX-TEST-99"]
    
    with open(db.local_transactions_path, "w", encoding="utf-8") as f:
        json.dump(cleaned_txs, f, ensure_ascii=False, indent=2)
        
    print("Cleaned up unit test transaction from local DB.")
    print("--- Database Fallback Verification: SUCCESS ---")

if __name__ == "__main__":
    test_database_fallback()
