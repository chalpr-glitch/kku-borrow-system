import os
import json
import logging
from threading import Lock

# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("DatabaseManager")

class DatabaseManager:
    def __init__(self):
        self.lock = Lock()
        self.use_google_sheets = False
        
        # Local paths
        self.base_dir = os.path.dirname(os.path.abspath(__file__))
        self.local_assets_path = os.path.join(self.base_dir, "db", "assets.json")
        self.local_transactions_path = os.path.join(self.base_dir, "db", "transactions.json")
        self.local_users_path = os.path.join(self.base_dir, "db", "users.json")
        
        # Ensure local DB directory exists
        os.makedirs(os.path.dirname(self.local_assets_path), exist_ok=True)
        
        # Google Sheets configuration
        self.spreadsheet_id = os.getenv("SPREADSHEET_ID")
        self.credentials_path = os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
        
        # Initialize Google Sheets client if parameters exist
        self.client = None
        self.spreadsheet = None
        self.assets_sheet = None
        self.transactions_sheet = None
        self.users_sheet = None
        
        if self.spreadsheet_id and self.credentials_path:
            # Check if file exists
            if os.path.exists(self.credentials_path):
                try:
                    import gspread
                    from google.oauth2.service_account import Credentials
                    
                    scopes = [
                        "https://www.googleapis.com/auth/spreadsheets",
                        "https://www.googleapis.com/auth/drive"
                    ]
                    
                    creds = Credentials.from_service_account_file(self.credentials_path, scopes=scopes)
                    self.client = gspread.authorize(creds)
                    self.spreadsheet = self.client.open_by_key(self.spreadsheet_id)
                    
                    # Try to fetch worksheets
                    self.assets_sheet = self.spreadsheet.worksheet("assets")
                    self.transactions_sheet = self.spreadsheet.worksheet("transactions")
                    
                    # Try to fetch users worksheet, fallback to local users.json if not found
                    try:
                        self.users_sheet = self.spreadsheet.worksheet("users")
                        logger.info("Successfully loaded 'users' worksheet from Google Sheets.")
                    except Exception as u_err:
                        logger.warning(f"Could not load 'users' worksheet ({u_err}). Will use local users.json for user directory.")
                        self.users_sheet = None
                    
                    self.use_google_sheets = True
                    logger.info("Successfully connected to Google Sheets database.")
                except Exception as e:
                    logger.error(f"Failed to connect to Google Sheets: {e}. Falling back to local JSON database.")
            else:
                logger.warning(f"Google credentials file not found at {self.credentials_path}. Falling back to local JSON database.")
        else:
            logger.info("Google Sheets config not fully provided. Using local JSON database.")

        # Initialize local JSON files if they don't exist
        self._init_local_db()

    def _init_local_db(self):
        """Prepopulate local files if they do not exist."""
        if not os.path.exists(self.local_assets_path):
            with open(self.local_assets_path, "w", encoding="utf-8") as f:
                json.dump([], f, ensure_ascii=False, indent=2)
                
        if not os.path.exists(self.local_transactions_path):
            with open(self.local_transactions_path, "w", encoding="utf-8") as f:
                json.dump([], f, ensure_ascii=False, indent=2)

        if not os.path.exists(self.local_users_path):
            with open(self.local_users_path, "w", encoding="utf-8") as f:
                json.dump([], f, ensure_ascii=False, indent=2)

    # --- Users DB Methods ---
    
    def get_all_users(self):
        """Retrieve all users, dynamically falling back if Google Sheets fails or is missing."""
        if self.use_google_sheets and self.users_sheet:
            try:
                return self.users_sheet.get_all_records()
            except Exception as e:
                logger.error(f"Google Sheets error in get_all_users: {e}. Falling back to local.")
        
        # Local JSON load
        with self.lock:
            try:
                with open(self.local_users_path, "r", encoding="utf-8") as f:
                    return json.load(f)
            except Exception as e:
                logger.error(f"Error reading local users JSON: {e}")
                return []

    def get_user_by_email(self, email):
        users = self.get_all_users()
        email_clean = email.strip().lower()
        for user in users:
            if user.get("email", "").strip().lower() == email_clean:
                return user
        return None

    # --- Assets DB Methods ---
    
    def get_all_assets(self):
        """Retrieve all assets, dynamically falling back if Google Sheets fails."""
        if self.use_google_sheets:
            try:
                records = self.assets_sheet.get_all_records()
                for r in records:
                    r['status'] = r.get('status', 'Available')
                return records
            except Exception as e:
                logger.error(f"Google Sheets error in get_all_assets: {e}. Falling back to local.")
        
        # Local JSON load
        with self.lock:
            try:
                with open(self.local_assets_path, "r", encoding="utf-8") as f:
                    return json.load(f)
            except Exception as e:
                logger.error(f"Error reading local assets JSON: {e}")
                return []

    def get_asset_by_id(self, asset_id):
        assets = self.get_all_assets()
        for asset in assets:
            if asset.get("asset_id") == asset_id:
                return asset
        return None

    def add_asset(self, asset_data):
        """Add a new asset in the system."""
        asset_row = {
            "asset_id": asset_data.get("asset_id"),
            "asset_name": asset_data.get("asset_name"),
            "category": asset_data.get("category"),
            "serial_number": asset_data.get("serial_number"),
            "status": asset_data.get("status", "Available"),
            "image_url": asset_data.get("image_url", "https://placehold.co/400x300?text=OAS+KKU")
        }

        if self.use_google_sheets:
            try:
                headers = self.assets_sheet.row_values(1)
                row_values = [asset_row.get(h, "") for h in headers]
                self.assets_sheet.append_row(row_values)
                logger.info(f"Added asset {asset_row['asset_id']} to Google Sheets.")
            except Exception as e:
                logger.error(f"Google Sheets error in add_asset: {e}. Saving locally.")

        # Local JSON
        with self.lock:
            try:
                with open(self.local_assets_path, "r", encoding="utf-8") as f:
                    assets = json.load(f)
                
                # Check for duplicate
                if any(a.get("asset_id") == asset_row["asset_id"] for a in assets):
                    return False
                    
                assets.append(asset_row)
                with open(self.local_assets_path, "w", encoding="utf-8") as f:
                    json.dump(assets, f, ensure_ascii=False, indent=2)
                logger.info(f"Added asset {asset_row['asset_id']} locally.")
                return True
            except Exception as e:
                logger.error(f"Error saving local asset: {e}")
        return False

    def delete_asset_by_id(self, asset_id):
        """Delete an asset from the system."""
        if self.use_google_sheets:
            try:
                headers = self.assets_sheet.row_values(1)
                asset_id_col = headers.index("asset_id") + 1
                col_values = self.assets_sheet.col_values(asset_id_col)
                row_idx = -1
                for idx, val in enumerate(col_values[1:], start=2):
                    if str(val) == str(asset_id):
                        row_idx = idx
                        break
                if row_idx != -1:
                    self.assets_sheet.delete_rows(row_idx)
                    logger.info(f"Deleted asset {asset_id} from Google Sheets.")
            except Exception as e:
                logger.error(f"Google Sheets error in delete_asset_by_id: {e}")

        # Local JSON
        with self.lock:
            try:
                with open(self.local_assets_path, "r", encoding="utf-8") as f:
                    assets = json.load(f)
                
                cleaned_assets = [a for a in assets if a.get("asset_id") != asset_id]
                
                with open(self.local_assets_path, "w", encoding="utf-8") as f:
                    json.dump(cleaned_assets, f, ensure_ascii=False, indent=2)
                logger.info(f"Deleted asset {asset_id} locally.")
                return True
            except Exception as e:
                logger.error(f"Error deleting local asset: {e}")
        return False

    def update_asset_status(self, asset_id, status):
        """Update asset status to 'Available', 'Borrowed', or 'Maintenance'."""
        if self.use_google_sheets:
            try:
                headers = self.assets_sheet.row_values(1)
                asset_id_col = headers.index("asset_id") + 1
                status_col = headers.index("status") + 1
                
                col_values = self.assets_sheet.col_values(asset_id_col)
                row_idx = -1
                for idx, val in enumerate(col_values[1:], start=2):
                    if str(val) == str(asset_id):
                        row_idx = idx
                        break
                        
                if row_idx != -1:
                    self.assets_sheet.update_cell(row_idx, status_col, status)
                    logger.info(f"Updated asset {asset_id} status to '{status}' in Google Sheets.")
                    return True
                else:
                    logger.warning(f"Asset ID {asset_id} not found in Google Sheets.")
            except Exception as e:
                logger.error(f"Google Sheets error in update_asset_status: {e}. Falling back to local.")

        # Update local JSON
        with self.lock:
            try:
                with open(self.local_assets_path, "r", encoding="utf-8") as f:
                    assets = json.load(f)
                
                updated = False
                for asset in assets:
                    if asset.get("asset_id") == asset_id:
                        asset["status"] = status
                        updated = True
                        break
                
                if updated:
                    with open(self.local_assets_path, "w", encoding="utf-8") as f:
                        json.dump(assets, f, ensure_ascii=False, indent=2)
                    logger.info(f"Updated asset {asset_id} status to '{status}' locally.")
                    return True
            except Exception as e:
                logger.error(f"Error updating local asset status: {e}")
        return False

    # --- Transactions DB Methods ---

    def get_all_transactions(self):
        """Retrieve all transactions, dynamically falling back if Google Sheets fails."""
        if self.use_google_sheets:
            try:
                records = self.transactions_sheet.get_all_records()
                for r in records:
                    r['reject_reason'] = r.get('reject_reason', '')
                return records
            except Exception as e:
                logger.error(f"Google Sheets error in get_all_transactions: {e}. Falling back to local.")
        
        # Local JSON load
        with self.lock:
            try:
                with open(self.local_transactions_path, "r", encoding="utf-8") as f:
                    return json.load(f)
            except Exception as e:
                logger.error(f"Error reading local transactions JSON: {e}")
                return []

    def get_transaction_by_id(self, transaction_id):
        txs = self.get_all_transactions()
        for tx in txs:
            if tx.get("transaction_id") == transaction_id:
                return tx
        return None

    def add_transaction(self, tx_data):
        """Insert a new transaction."""
        tx_row = {
            "transaction_id": tx_data.get("transaction_id"),
            "asset_id": tx_data.get("asset_id"),
            "borrower_name": tx_data.get("borrower_name"),
            "borrower_email": tx_data.get("borrower_email"),
            "department": tx_data.get("department"),
            "head_email": tx_data.get("head_email"),
            "borrow_date": tx_data.get("borrow_date"),
            "expected_return_date": tx_data.get("expected_return_date"),
            "actual_return_date": tx_data.get("actual_return_date", ""),
            "status": tx_data.get("status", "Pending Admin"),
            "reject_reason": tx_data.get("reject_reason", "")
        }

        if self.use_google_sheets:
            try:
                headers = self.transactions_sheet.row_values(1)
                row_values = [tx_row.get(h, "") for h in headers]
                self.transactions_sheet.append_row(row_values)
                logger.info(f"Added transaction {tx_row['transaction_id']} to Google Sheets.")
                return True
            except Exception as e:
                logger.error(f"Google Sheets error in add_transaction: {e}. Saving locally instead.")

        # Save local JSON
        with self.lock:
            try:
                with open(self.local_transactions_path, "r", encoding="utf-8") as f:
                    txs = json.load(f)
                
                txs.append(tx_row)
                
                with open(self.local_transactions_path, "w", encoding="utf-8") as f:
                    json.dump(txs, f, ensure_ascii=False, indent=2)
                logger.info(f"Added transaction {tx_row['transaction_id']} locally.")
                return True
            except Exception as e:
                logger.error(f"Error saving local transaction: {e}")
        return False

    def update_transaction_status(self, transaction_id, status, actual_return_date=None, reject_reason=None):
        """Update transaction status, with optional return date and rejection reason."""
        if self.use_google_sheets:
            try:
                headers = self.transactions_sheet.row_values(1)
                tx_id_col = headers.index("transaction_id") + 1
                status_col = headers.index("status") + 1
                
                col_values = self.transactions_sheet.col_values(tx_id_col)
                row_idx = -1
                for idx, val in enumerate(col_values[1:], start=2):
                    if str(val) == str(transaction_id):
                        row_idx = idx
                        break
                
                if row_idx != -1:
                    self.transactions_sheet.update_cell(row_idx, status_col, status)
                    
                    if actual_return_date is not None:
                        ret_col = headers.index("actual_return_date") + 1
                        self.transactions_sheet.update_cell(row_idx, ret_col, actual_return_date)
                        
                    if reject_reason is not None:
                        rej_col = headers.index("reject_reason") + 1
                        self.transactions_sheet.update_cell(row_idx, rej_col, reject_reason)
                        
                    logger.info(f"Updated transaction {transaction_id} status to '{status}' in Google Sheets.")
                    return True
                else:
                    logger.warning(f"Transaction ID {transaction_id} not found in Google Sheets.")
            except Exception as e:
                logger.error(f"Google Sheets error in update_transaction_status: {e}. Falling back to local.")

        # Update local JSON
        with self.lock:
            try:
                with open(self.local_transactions_path, "r", encoding="utf-8") as f:
                    txs = json.load(f)
                
                updated = False
                for tx in txs:
                    if tx.get("transaction_id") == transaction_id:
                        tx["status"] = status
                        if actual_return_date is not None:
                            tx["actual_return_date"] = actual_return_date
                        if reject_reason is not None:
                            tx["reject_reason"] = reject_reason
                        updated = True
                        break
                
                if updated:
                    with open(self.local_transactions_path, "w", encoding="utf-8") as f:
                        json.dump(txs, f, ensure_ascii=False, indent=2)
                    logger.info(f"Updated transaction {transaction_id} status to '{status}' locally.")
                    return True
            except Exception as e:
                logger.error(f"Error updating local transaction status: {e}")
        return False

    def add_user(self, user_data):
        user_row = {
            "email": user_data.get("email").strip().lower(),
            "name": user_data.get("name").strip(),
            "title": user_data.get("title", "").strip(),
            "admin_title": user_data.get("admin_title", "").strip(),
            "division": user_data.get("division", "").strip(),
            "department": user_data.get("department", "").strip(),
            "status": user_data.get("status", "user").strip()
        }
        
        if self.use_google_sheets and self.users_sheet:
            try:
                headers = self.users_sheet.row_values(1)
                row_values = [user_row.get(h, "") for h in headers]
                self.users_sheet.append_row(row_values)
                logger.info(f"Added user {user_row['email']} to Google Sheets.")
            except Exception as e:
                logger.error(f"Google Sheets error in add_user: {e}")
                
        with self.lock:
            try:
                with open(self.local_users_path, "r", encoding="utf-8") as f:
                    users = json.load(f)
                if any(u.get("email", "").strip().lower() == user_row["email"] for u in users):
                    return False
                users.append(user_row)
                with open(self.local_users_path, "w", encoding="utf-8") as f:
                    json.dump(users, f, ensure_ascii=False, indent=2)
                logger.info(f"Added user {user_row['email']} locally.")
                return True
            except Exception as e:
                logger.error(f"Error saving local user: {e}")
        return False

    def delete_user_by_email(self, email):
        email_clean = email.strip().lower()
        if self.use_google_sheets and self.users_sheet:
            try:
                headers = self.users_sheet.row_values(1)
                email_col = headers.index("email") + 1
                col_values = self.users_sheet.col_values(email_col)
                row_idx = -1
                for idx, val in enumerate(col_values[1:], start=2):
                    if str(val).strip().lower() == email_clean:
                        row_idx = idx
                        break
                if row_idx != -1:
                    self.users_sheet.delete_rows(row_idx)
                    logger.info(f"Deleted user {email} from Google Sheets.")
            except Exception as e:
                logger.error(f"Google Sheets error in delete_user: {e}")
                
        with self.lock:
            try:
                with open(self.local_users_path, "r", encoding="utf-8") as f:
                    users = json.load(f)
                cleaned_users = [u for u in users if u.get("email", "").strip().lower() != email_clean]
                with open(self.local_users_path, "w", encoding="utf-8") as f:
                    json.dump(cleaned_users, f, ensure_ascii=False, indent=2)
                logger.info(f"Deleted user {email} locally.")
                return True
            except Exception as e:
                logger.error(f"Error deleting local user: {e}")
        return False
