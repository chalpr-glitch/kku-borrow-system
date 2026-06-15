// Constants and state management
const API_URL = window.location.origin;
let allAssets = [];
let adminTransactions = [];
let activeAdminTab = 'tab-summary';

// Toast Notification helper
function showToast(message, type = 'info') {
  const toast = document.getElementById('toast-notification');
  const icon = document.getElementById('toast-icon');
  const msgText = document.getElementById('toast-message');

  msgText.textContent = message;
  toast.className = `toast active ${type}`;

  if (type === 'success') {
    icon.className = 'fa-solid fa-circle-check';
  } else if (type === 'error') {
    icon.className = 'fa-solid fa-circle-exclamation';
  } else {
    icon.className = 'fa-solid fa-circle-info';
  }

  setTimeout(() => {
    toast.classList.remove('active');
  }, 4000);
}

// Check SSO Session and adjust UI elements
function checkSsoSession() {
  const sessionStr = localStorage.getItem('user_session');
  const ssoGate = document.getElementById('sso-login-gate');
  const appWrapper = document.getElementById('app-content-wrapper');
  
  // Parse URL queries for head approval portal
  const urlParams = new URLSearchParams(window.location.search);
  const page = urlParams.get('page');
  const txId = urlParams.get('id');
  const isApprovalPage = (page === 'approve' && txId);

  if (isApprovalPage) {
    ssoGate.style.display = 'none';
    appWrapper.style.display = 'flex';
    // Hide navigation elements for department head approval isolation
    const nav = document.querySelector('nav');
    if (nav) nav.style.display = 'none';
    switchView('head-approval-view');
    loadHeadApproval(txId);
    return;
  }

  if (!sessionStr) {
    ssoGate.style.display = 'flex';
    appWrapper.style.display = 'none';
  } else {
    ssoGate.style.display = 'none';
    appWrapper.style.display = 'flex';
    
    const user = JSON.parse(sessionStr);
    
    // Update profile header
    document.getElementById('session-user-info').innerHTML = `
      คุณ <b>${user.name}</b> (${getRoleLabel(user.status)})
    `;

    // Manage tab button visibility based on SSO role
    const isAdmin = (user.status === 'admin/ staff' || user.status === 'admin / Approve');
    const adminNavBtn = document.getElementById('nav-btn-admin');
    if (isAdmin) {
      adminNavBtn.style.display = 'inline-block';
    } else {
      adminNavBtn.style.display = 'none';
    }

    // Toggle Manage Assets tab visibility (Admins only)
    const manageAssetsBtn = document.getElementById('admin-tab-manage-assets-btn');
    if (user.status === 'admin/ staff') {
      manageAssetsBtn.style.display = 'inline-block';
    } else {
      manageAssetsBtn.style.display = 'none';
    }

    // Toggle Manage Users tab visibility (Admins only)
    const manageUsersBtn = document.getElementById('admin-tab-manage-users-btn');
    if (user.status === 'admin/ staff') {
      manageUsersBtn.style.display = 'inline-block';
    } else {
      manageUsersBtn.style.display = 'none';
    }

    // Prefill track-email read-only input
    const trackEmailInput = document.getElementById('track-email');
    if (trackEmailInput) {
      trackEmailInput.value = user.email;
    }
  }
}

function getRoleLabel(status) {
  if (status === 'admin/ staff') return 'นักเทคโนโลยีสารสนเทศ';
  if (status === 'admin / Approve') return 'หัวหน้างานอนุมัติ';
  return 'บุคลากร สบว.';
}

// Sync dropdown and text input for SSO mockup
function syncSsoInput() {
  const select = document.getElementById('sso-email-select');
  const input = document.getElementById('sso-email-input');
  if (select && input && select.value) {
    input.value = select.value;
  }
}

// Execute SSO login request
async function executeSsoLogin() {
  const email = document.getElementById('sso-email-input').value.trim();
  if (!email) {
    showToast('กรุณากรอกหรือเลือกอีเมลเข้าใช้งาน', 'error');
    return;
  }

  try {
    const response = await fetch(`${API_URL}/api/auth/sso`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });

    const result = await response.json();
    if (!response.ok) throw new Error(result.error);

    // Save SSO session in local storage
    localStorage.setItem('user_session', JSON.stringify(result.user));
    showToast(result.message, 'success');
    
    // Check session and switch views
    checkSsoSession();
    switchView('browse-view');
  } catch (error) {
    showToast(error.message, 'error');
  }
}

// Google Credential Response callback
async function handleCredentialResponse(response) {
  try {
    const res = await fetch(`${API_URL}/api/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential: response.credential })
    });

    const result = await res.json();
    if (!res.ok) throw new Error(result.error);

    // Save session in local storage
    localStorage.setItem('user_session', JSON.stringify(result.user));
    showToast(result.message, 'success');
    
    // Check session, switch views, and reload user list
    checkSsoSession();
    switchView('browse-view');
    await fetchUsersList();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

// Load Google Client ID and initialize OAuth button dynamically
async function loadGoogleAuth() {
  const container = document.getElementById("google-signin-container");
  const btn = document.getElementById("google-signin-btn");
  if (!container || !btn) return;

  try {
    const res = await fetch(`${API_URL}/api/config`);
    const config = await res.json();
    if (config.google_client_id) {
      container.style.display = 'block';
      window.google?.accounts.id.initialize({
        client_id: config.google_client_id,
        callback: handleCredentialResponse
      });
      window.google?.accounts.id.renderButton(btn, {
        theme: "outline",
        size: "large",
        width: "300",
        text: "continue_with"
      });
    } else {
      container.style.display = 'none';
    }
  } catch (err) {
    console.error("Failed to load Google Auth configuration:", err);
    container.style.display = 'none';
  }
}

// Log out user
function executeLogout() {
  localStorage.removeItem('user_session');
  showToast('ออกจากระบบเรียบร้อยแล้ว', 'success');
  checkSsoSession();
}

// Get authorization headers from active user session
function getAuthHeader() {
  const sessionStr = localStorage.getItem('user_session');
  if (!sessionStr) return {};
  const user = JSON.parse(sessionStr);
  return { 'Authorization': `Bearer ${user.email}` };
}

// Switch between SPA views
function switchView(viewId) {
  // Hide all views
  document.querySelectorAll('.view-section').forEach(view => {
    view.classList.remove('active');
  });

  // Deactivate all navigation links
  document.querySelectorAll('.nav-link').forEach(link => {
    link.classList.remove('active');
  });

  // Activate chosen view
  const targetView = document.getElementById(viewId);
  if (targetView) {
    targetView.classList.add('active');
  }

  // Activate corresponding nav button
  const navBtn = document.getElementById(`nav-btn-${viewId.replace('-view', '')}`);
  if (navBtn) {
    navBtn.classList.add('active');
  }

  // View initialization logic
  if (viewId === 'browse-view') {
    fetchAssets();
  } else if (viewId === 'admin-view') {
    checkAdminAuth();
  }
}

// Modal handling
function openModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.classList.add('active');
  }
}

function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.classList.remove('active');
    if (modalId === 'borrow-modal') {
      document.getElementById('borrow-request-form').reset();
    } else if (modalId === 'reject-modal') {
      document.getElementById('form-reject-reason').value = '';
    }
  }
}

// --- CATALOG SEARCH & BROWSE ---

async function fetchAssets() {
  const container = document.getElementById('asset-grid-container');
  try {
    const response = await fetch(`${API_URL}/api/assets`);
    if (!response.ok) throw new Error('ไม่สามารถโหลดข้อมูลครุภัณฑ์ได้');
    allAssets = await response.json();
    renderAssets(allAssets);
  } catch (error) {
    console.error(error);
    container.innerHTML = `
      <div style="text-align: center; grid-column: 1/-1; padding: 40px; color: var(--danger);">
        <i class="fa-solid fa-triangle-exclamation" style="font-size: 32px; margin-bottom: 10px;"></i>
        <p>${error.message}</p>
        <button class="btn btn-secondary" onclick="fetchAssets()" style="margin-top: 15px;">ลองอีกครั้ง</button>
      </div>
    `;
  }
}

function renderAssets(assets) {
  const container = document.getElementById('asset-grid-container');
  if (assets.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; grid-column: 1/-1; padding: 40px; color: #888;">
        <i class="fa-solid fa-magnifying-glass" style="font-size: 32px; margin-bottom: 10px;"></i>
        <p>ไม่พบครุภัณฑ์ที่ตรงกับเงื่อนไขการค้นหา</p>
      </div>
    `;
    return;
  }

  container.innerHTML = assets.map(asset => {
    let statusClass = '';
    let statusThai = '';
    let isBtnDisabled = asset.status !== 'Available';

    if (asset.status === 'Available') {
      statusClass = 'available';
      statusThai = 'พร้อมใช้งาน';
    } else if (asset.status === 'Borrowed') {
      statusClass = 'borrowed';
      statusThai = 'ถูกยืมอยู่';
    } else if (asset.status === 'Maintenance') {
      statusClass = 'maintenance';
      statusThai = 'ส่งซ่อมบำรุง';
    }

    return `
      <div class="asset-card">
        <div class="asset-image-wrapper">
          <img src="${asset.image_url}" alt="${asset.asset_name}" onerror="this.src='https://placehold.co/400x300?text=OAS+KKU'">
          <span class="status-badge ${statusClass}">${statusThai}</span>
        </div>
        <div class="asset-info">
          <span class="asset-category">${getCategoryThai(asset.category)}</span>
          <h3 class="asset-name" title="${asset.asset_name}">${asset.asset_name}</h3>
          <div class="asset-details">
            <span>รหัส: <b>${asset.asset_id}</b></span>
            <span>S/N: <b>${asset.serial_number}</b></span>
          </div>
          <button class="borrow-btn" onclick="openBorrowModal('${asset.asset_id}')" ${isBtnDisabled ? 'disabled' : ''}>
            <i class="fa-solid fa-file-signature"></i> ยื่นคำขอยืม
          </button>
        </div>
      </div>
    `;
  }).join('');
}

function getCategoryThai(cat) {
  const mapping = {
    'Notebook': 'Notebook (โน้ตบุ๊ก)',
    'Projector': 'Projector (โปรเจกเตอร์)',
    'Tablet': 'Tablet (แท็บเล็ต)',
    'Camera': 'Camera (กล้องถ่ายภาพ)',
    'Audio': 'Audio (ระบบเสียง/ไมโครโฟน)'
  };
  return mapping[cat] || cat;
}

function filterAssets() {
  const searchQuery = document.getElementById('asset-search').value.toLowerCase().trim();
  const categoryFilter = document.getElementById('category-filter').value;

  const filtered = allAssets.filter(asset => {
    const matchesSearch = asset.asset_name.toLowerCase().includes(searchQuery) || 
                          asset.asset_id.toLowerCase().includes(searchQuery) ||
                          asset.serial_number.toLowerCase().includes(searchQuery);
    const matchesCategory = categoryFilter === '' || asset.category === categoryFilter;
    return matchesSearch && matchesCategory;
  });

  renderAssets(filtered);
}

// --- BORROW REQUEST ACTION ---

function openBorrowModal(assetId) {
  const sessionStr = localStorage.getItem('user_session');
  if (!sessionStr) {
    showToast('กรุณาล็อกอินด้วย SSO ก่อนยื่นคำขอ', 'error');
    checkSsoSession();
    return;
  }
  
  const user = JSON.parse(sessionStr);
  const asset = allAssets.find(a => a.asset_id === assetId);
  if (!asset) return;

  // Prepopulate asset details
  document.getElementById('form-asset-id').value = asset.asset_id;
  document.getElementById('form-asset-id-text').textContent = asset.asset_id;
  document.getElementById('form-asset-name').textContent = asset.asset_name;
  document.getElementById('form-asset-serial').textContent = asset.serial_number;
  document.getElementById('form-asset-cat').textContent = getCategoryThai(asset.category);
  document.getElementById('form-asset-img').src = asset.image_url;

  // Prefill borrower credentials from active SSO session
  document.getElementById('form-borrower-name').value = user.name;
  document.getElementById('form-borrower-email').value = user.email;
  document.getElementById('form-department').value = `${user.division} (${user.department})`;

  // Set default dates
  const today = new Date().toISOString().split('T')[0];
  document.getElementById('form-borrow-date').value = today;
  document.getElementById('form-borrow-date').min = today;
  document.getElementById('form-return-date').min = today;

  openModal('borrow-modal');
}

async function submitBorrowRequest(event) {
  event.preventDefault();
  
  const assetId = document.getElementById('form-asset-id').value;
  const name = document.getElementById('form-borrower-name').value.trim();
  const email = document.getElementById('form-borrower-email').value.trim();
  const department = document.getElementById('form-department').value;
  const headEmail = document.getElementById('form-head-email-select').value.trim();
  const borrowDate = document.getElementById('form-borrow-date').value;
  const returnDate = document.getElementById('form-return-date').value;
  const purpose = document.getElementById('form-purpose').value.trim();

  // Date check
  if (returnDate < borrowDate) {
    showToast('กำหนดวันคืนต้องไม่เกิดก่อนวันที่เริ่มยืม', 'error');
    return;
  }

  const payload = {
    asset_id: assetId,
    borrower_name: name,
    borrower_email: email,
    department: department,
    head_email: headEmail,
    borrow_date: borrowDate,
    expected_return_date: returnDate,
    purpose: purpose
  };

  try {
    const response = await fetch(`${API_URL}/api/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'เกิดข้อผิดพลาดในการส่งคำขอ');

    showToast('ยื่นคำขอยืมครุภัณฑ์สำเร็จแล้ว!', 'success');
    closeModal('borrow-modal');
    fetchAssets();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

// --- PERSONAL TRACK STATUS ---

async function trackUserStatus() {
  const email = document.getElementById('track-email').value.trim().lower();
  if (!email) {
    showToast('ไม่พบอีเมลผู้ใช้งานระบบ', 'error');
    return;
  }

  const container = document.getElementById('track-results-container');
  const timeline = document.getElementById('timeline-container');
  
  timeline.innerHTML = '<p style="text-align:center; padding: 20px;"><i class="fa-solid fa-circle-notch fa-spin"></i> กำลังค้นหาข้อมูล...</p>';
  container.style.display = 'block';

  try {
    const response = await fetch(`${API_URL}/api/track?email=${encodeURIComponent(email)}`);
    if (!response.ok) throw new Error('ไม่สามารถตรวจสอบสถานะการยืมได้');
    const logs = await response.json();

    if (logs.length === 0) {
      timeline.innerHTML = `
        <div style="text-align: center; padding: 20px; color: #888;">
          <p>ไม่พบประวัติการทำรายการยืมของคุณในระบบ</p>
        </div>
      `;
      return;
    }

    timeline.innerHTML = logs.map(tx => {
      let statusText = '';
      let statusClass = '';

      if (tx.status === 'Pending Admin') {
        statusText = 'รอนักเทคโนโลยีสารสนเทศคัดกรอง';
        statusClass = 'pending-admin';
      } else if (tx.status === 'Pending Head') {
        statusText = 'รอหัวหน้างานพิจารณาอนุมัติ';
        statusClass = 'pending-head';
      } else if (tx.status === 'Approved') {
        statusText = 'อนุมัติการยืมเรียบร้อยแล้ว (สามารถรับอุปกรณ์ได้)';
        statusClass = 'approved';
      } else if (tx.status === 'Rejected') {
        statusText = `ไม่อนุมัติคำขอ (เหตุผล: ${tx.reject_reason || 'ไม่มี'})`;
        statusClass = 'rejected';
      } else if (tx.status === 'Returned') {
        statusText = `คืนอุปกรณ์เรียบร้อยแล้ว (ส่งคืนเมื่อ: ${tx.actual_return_date})`;
        statusClass = 'returned';
      }

      return `
        <div class="timeline-card">
          <div class="timeline-header">
            <span class="timeline-item-name">${tx.asset_name}</span>
            <span class="status-label ${statusClass}">${statusText}</span>
          </div>
          <div class="timeline-details">
            <p>รหัสยืม: <b>${tx.transaction_id}</b> | รหัสครุภัณฑ์: <b>${tx.asset_id}</b></p>
            <p>วันที่ขอยืม: <b>${tx.borrow_date}</b> ถึง <b>${tx.expected_return_date}</b></p>
            <p>วัตถุประสงค์: <i>${tx.purpose || '-'}</i></p>
            <p>ผู้อนุมัติ (หัวหน้าฝ่าย): <b>${tx.head_email}</b></p>
          </div>
        </div>
      `;
    }).join('');

  } catch (error) {
    showToast(error.message, 'error');
    timeline.innerHTML = `<p style="color:var(--danger); text-align:center;">${error.message}</p>`;
  }
}

// --- DEPARTMENT HEAD APPROVAL PORTAL ---

async function loadHeadApproval(txId) {
  const panel = document.getElementById('head-approval-panel');
  try {
    const response = await fetch(`${API_URL}/api/transactions/${txId}`);
    if (!response.ok) {
      if (response.status === 404) throw new Error('ไม่พบข้อมูลคำขอยืมสำหรับรหัสธุรกรรมนี้');
      throw new Error('เกิดข้อผิดพลาดในการโหลดข้อมูลคำขอ');
    }
    const data = await response.json();
    const tx = data.transaction;
    const asset = data.asset;

    if (tx.status !== 'Pending Head') {
      let statusThai = '';
      if (tx.status === 'Approved') statusThai = '<span class="status-label approved">อนุมัติแล้ว</span>';
      else if (tx.status === 'Rejected') statusThai = '<span class="status-label rejected">ถูกปฏิเสธแล้ว</span>';
      else if (tx.status === 'Returned') statusThai = '<span class="status-label returned">คืนอุปกรณ์แล้ว</span>';
      else statusThai = `<span class="status-label pending-admin">รอตรวจสอบ (ปัจจุบัน: ${tx.status})</span>`;

      panel.innerHTML = `
        <div style="text-align: center; padding: 20px;">
          <div class="logo-icon" style="margin:0 auto 20px auto;">OAS</div>
          <h2>ข้อมูลได้รับการพิจารณาไปแล้ว</h2>
          <p style="margin: 15px 0;">คำขอยืมรหัส <b>${txId}</b> ได้รับการดำเนินการพิจารณาเรียบร้อยแล้ว</p>
          <div style="margin-bottom: 25px;">สถานะปัจจุบัน: ${statusThai}</div>
          <a href="/" style="background:var(--charcoal); color:white; padding:10px 20px; border-radius:5px;">กลับหน้าหลัก</a>
        </div>
      `;
      return;
    }

    panel.innerHTML = `
      <h2>พิจารณาคำขอยืมอุปกรณ์/ครุภัณฑ์</h2>
      <h3>สำนักบริการวิชาการ มหาวิทยาลัยขอนแก่น (OAS KKU)</h3>
      
      <div style="background-color: #f9f9f9; padding: 15px; border-radius: 8px; margin-bottom: 25px;">
        <div class="detail-row"><span>รหัสธุรกรรม</span><span>${tx.transaction_id}</span></div>
        <div class="detail-row"><span>ผู้ขอยืม</span><span>${tx.borrower_name} (${tx.borrower_email})</span></div>
        <div class="detail-row"><span>ฝ่ายที่สังกัด</span><span>${tx.department}</span></div>
        <div class="detail-row"><span>อุปกรณ์ครุภัณฑ์</span><span><b>${asset.asset_name}</b></span></div>
        <div class="detail-row"><span>รหัสครุภัณฑ์ / S/N</span><span>${tx.asset_id} / ${asset.serial_number}</span></div>
        <div class="detail-row"><span>กำหนดเวลายืม</span><span>${tx.borrow_date} ถึง ${tx.expected_return_date}</span></div>
        <div class="detail-row"><span>วัตถุประสงค์การยืม</span><span>${tx.purpose}</span></div>
      </div>

      <div class="approval-actions">
        <button class="btn btn-danger" onclick="openRejectReasonModal('${tx.transaction_id}', 'head')">
          <i class="fa-solid fa-circle-xmark"></i> ไม่อนุมัติ (Reject)
        </button>
        <button class="btn btn-primary" onclick="submitHeadDecision('${tx.transaction_id}', 'approve')">
          <i class="fa-solid fa-circle-check"></i> อนุมัติการยืม (Approve)
        </button>
      </div>
      <p class="reject-note">เมื่อกดปุ่ม "อนุมัติ" ระบบจะเปลี่ยนสถานะเครื่องเป็น "ถูกยืมอยู่" และแจ้งผู้ยืมให้รับอุปกรณ์</p>
    `;

  } catch (error) {
    panel.innerHTML = `
      <div style="text-align: center; padding: 40px; color: var(--danger);">
        <i class="fa-solid fa-triangle-exclamation" style="font-size: 40px; margin-bottom: 15px;"></i>
        <h2>เกิดข้อผิดพลาด</h2>
        <p>${error.message}</p>
        <a href="/" class="btn btn-secondary" style="display:inline-block; margin-top:20px;">กลับสู่หน้าหลัก</a>
      </div>
    `;
  }
}

async function submitHeadDecision(txId, action, rejectReason = "") {
  try {
    const response = await fetch(`${API_URL}/api/transactions/${txId}/head-action`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        ...getAuthHeader()
      },
      body: JSON.stringify({ action, reject_reason: rejectReason })
    });

    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'ไม่สามารถบันทึกการอนุมัติได้');

    showToast(result.message, 'success');
    loadHeadApproval(txId);
  } catch (error) {
    showToast(error.message, 'error');
  }
}

// --- ADMIN PORTAL VIEWS ---

function checkAdminAuth() {
  const sessionStr = localStorage.getItem('user_session');
  if (!sessionStr) {
    showToast('กรุณาล็อกอินเข้าระบบด้วย SSO', 'error');
    checkSsoSession();
    return;
  }

  const user = JSON.parse(sessionStr);
  const isAdmin = (user.status === 'admin/ staff' || user.status === 'admin / Approve');

  if (isAdmin) {
    fetchAdminData();
  } else {
    showToast('บัญชีผู้ใช้ของคุณไม่มีสิทธิ์เข้าถึงส่วนนี้', 'error');
    switchView('browse-view');
  }
}

async function fetchAdminData() {
  try {
    const response = await fetch(`${API_URL}/api/transactions`, {
      headers: getAuthHeader()
    });
    if (!response.ok) throw new Error('ไม่สามารถโหลดข้อมูลคำขอยืมได้');
    adminTransactions = await response.json();
    
    // Update counters
    const pendingCount = adminTransactions.filter(t => t.status === 'Pending Admin').length;
    const activeCount = adminTransactions.filter(t => t.status === 'Approved').length;
    document.getElementById('badge-pending-admin').textContent = pendingCount;
    document.getElementById('badge-active-loans').textContent = activeCount;

    // Load active tab data
    if (activeAdminTab === 'tab-summary') {
      loadDashboardStats();
    } else if (activeAdminTab === 'tab-pending') {
      renderPendingAdminTable();
    } else if (activeAdminTab === 'tab-loans') {
      renderActiveLoansTable();
    } else if (activeAdminTab === 'tab-logs') {
      renderLogsTable(adminTransactions);
    } else if (activeAdminTab === 'tab-manage-assets') {
      renderManageAssetsTable();
    } else if (activeAdminTab === 'tab-manage-users') {
      await fetchUsersList();
      renderManageUsersTable();
    }
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function switchAdminTab(tabId) {
  activeAdminTab = tabId;
  document.querySelectorAll('.admin-tab-btn').forEach(btn => {
    btn.classList.remove('active');
  });
  document.querySelectorAll('.admin-tab-content').forEach(content => {
    content.classList.remove('active');
  });

  // Activate tab button
  const activeBtn = document.getElementById(`admin-${tabId}-btn`);
  if (activeBtn) activeBtn.classList.add('active');

  // Activate content section
  const contentSection = document.getElementById(tabId);
  if (contentSection) contentSection.classList.add('active');

  fetchAdminData();
}

// Render summary charts & KPI cards
async function loadDashboardStats() {
  try {
    const response = await fetch(`${API_URL}/api/dashboard/stats`, {
      headers: getAuthHeader()
    });
    if (!response.ok) throw new Error('ไม่สามารถโหลดสถิติแดชบอร์ดได้');
    const stats = await response.json();

    document.getElementById('kpi-total-assets').textContent = stats.total_assets;
    document.getElementById('kpi-pending-admin').textContent = stats.pending_admin;
    document.getElementById('kpi-pending-head').textContent = stats.pending_head;
    document.getElementById('kpi-active-loans').textContent = stats.active_loans;
    document.getElementById('kpi-overdue').textContent = stats.overdue_loans;

    renderDonutChart(stats.categories);
    renderHorizontalBarChart(stats.top_departments);
    renderLineChart(stats.monthly_trends);
  } catch (error) {
    showToast(error.message, 'error');
  }
}

let catChartInstance = null;
let deptChartInstance = null;
let trendChartInstance = null;

function renderDonutChart(categoriesData) {
  const ctx = document.getElementById('categoryDonutChart').getContext('2d');
  if (catChartInstance) catChartInstance.destroy();
  
  const labels = Object.keys(categoriesData).map(getCategoryThai);
  const data = Object.values(categoriesData);

  catChartInstance = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: labels,
      datasets: [{
        data: data,
        backgroundColor: ['#F15A22', '#333333', '#4b5563', '#ff9800', '#2196f3'],
        borderWidth: 2
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'right',
          labels: { font: { family: 'Prompt', size: 12 } }
        }
      }
    }
  });
}

function renderHorizontalBarChart(departmentsData) {
  const ctx = document.getElementById('deptBarChart').getContext('2d');
  if (deptChartInstance) deptChartInstance.destroy();
  
  const labels = Object.keys(departmentsData);
  const data = Object.values(departmentsData);

  deptChartInstance = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [{
        label: 'จำนวนการยืมครุภัณฑ์',
        data: data,
        backgroundColor: 'rgba(241, 90, 34, 0.85)',
        borderColor: '#F15A22',
        borderWidth: 1,
        borderRadius: 4
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false }
      },
      scales: {
        x: { beginAtZero: true, ticks: { stepSize: 1, font: { family: 'Prompt', size: 11 } } },
        y: { ticks: { font: { family: 'Prompt', size: 11 } } }
      }
    }
  });
}

function renderLineChart(trendsData) {
  const ctx = document.getElementById('monthlyTrendChart').getContext('2d');
  if (trendChartInstance) trendChartInstance.destroy();
  
  const labels = Object.keys(trendsData);
  const data = Object.values(trendsData);

  trendChartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [{
        label: 'จำนวนธุรกรรมในเดือนนี้',
        data: data,
        fill: true,
        backgroundColor: 'rgba(241, 90, 34, 0.1)',
        borderColor: '#F15A22',
        borderWidth: 3,
        tension: 0.3,
        pointBackgroundColor: '#F15A22',
        pointRadius: 4
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false }
      },
      scales: {
        x: { ticks: { font: { family: 'Prompt', size: 11 } } },
        y: { beginAtZero: true, ticks: { stepSize: 1, font: { family: 'Prompt', size: 11 } } }
      }
    }
  });
}

// Render Pending screening requests table
function renderPendingAdminTable() {
  const tbody = document.getElementById('table-pending-body');
  const pending = adminTransactions.filter(t => t.status === 'Pending Admin');

  if (pending.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" style="text-align: center; color: #888; padding: 25px;">ไม่มีรายการรอตรวจสอบในขณะนี้</td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = pending.map(t => {
    const asset = allAssets.find(a => a.asset_id === t.asset_id);
    const assetName = asset ? asset.asset_name : t.asset_id;

    return `
      <tr>
        <td><b>${t.transaction_id}</b></td>
        <td>
          <div style="font-weight: 600;">${assetName}</div>
          <div style="font-size: 11px; color: #777;">รหัส: ${t.asset_id}</div>
        </td>
        <td>
          <div>${t.borrower_name}</div>
          <div style="font-size: 11px; color: #777;">${t.department} | ${t.borrower_email}</div>
        </td>
        <td style="font-size: 12px; color: #555;">${t.head_email}</td>
        <td>
          <div>ยืม: <b>${t.borrow_date}</b></div>
          <div>คืน: <b>${t.expected_return_date}</b></div>
        </td>
        <td style="max-width: 150px; font-size: 12px;" title="${t.purpose || ''}">${t.purpose || '-'}</td>
        <td style="text-align: center;">
          <div style="display: flex; gap: 8px; justify-content: center;">
            <button class="btn btn-secondary" style="padding: 6px 12px; font-size: 12px;" onclick="openRejectReasonModal('${t.transaction_id}', 'admin')">
              <i class="fa-solid fa-circle-xmark"></i> ปฏิเสธ
            </button>
            <button class="btn btn-primary" style="padding: 6px 12px; font-size: 12px;" onclick="adminAction('${t.transaction_id}', 'approve')">
              <i class="fa-solid fa-share-from-square"></i> ส่งต่อหัวหน้า
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

async function adminAction(txId, action, rejectReason = "") {
  if (action === 'reject' && !rejectReason) {
    showToast('กรุณากรอกเหตุผลการปฏิเสธ', 'error');
    return;
  }

  try {
    const response = await fetch(`${API_URL}/api/transactions/${txId}/admin-action`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeader()
      },
      body: JSON.stringify({ action, reject_reason: rejectReason })
    });

    const result = await response.json();
    if (!response.ok) throw new Error(result.error);

    showToast(result.message, 'success');
    if (action === 'reject') {
      closeModal('reject-modal');
    }
    fetchAdminData();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

// Render Active loans
function renderActiveLoansTable() {
  const tbody = document.getElementById('table-loans-body');
  const active = adminTransactions.filter(t => t.status === 'Approved');

  if (active.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" style="text-align: center; color: #888; padding: 25px;">ไม่มีอุปกรณ์ถูกยืมอยู่ในขณะนี้</td>
      </tr>
    `;
    return;
  }

  const todayStr = new Date().toISOString().split('T')[0];

  tbody.innerHTML = active.map(t => {
    const asset = allAssets.find(a => a.asset_id === t.asset_id);
    const assetName = asset ? asset.asset_name : t.asset_id;
    const isOverdue = t.expected_return_date < todayStr;

    return `
      <tr>
        <td><b>${t.transaction_id}</b></td>
        <td>
          <div style="font-weight: 600;">${assetName}</div>
          <div style="font-size: 11px; color: #777;">รหัส: ${t.asset_id}</div>
        </td>
        <td>
          <div>${t.borrower_name}</div>
          <div style="font-size: 11px; color: #777;">${t.department}</div>
        </td>
        <td>${t.borrow_date}</td>
        <td style="${isOverdue ? 'color: var(--danger); font-weight: bold;' : ''}">
          ${t.expected_return_date}
          ${isOverdue ? ' <span style="font-size:10px;" class="status-label rejected">เกินกำหนด</span>' : ''}
        </td>
        <td><span class="status-label approved">กำลังยืมอยู่</span></td>
        <td style="text-align: center;">
          <button class="btn btn-primary" style="padding: 6px 12px; font-size: 12px; background-color: var(--success);" onclick="returnAsset('${t.transaction_id}')">
            <i class="fa-solid fa-rotate-left"></i> บันทึกการคืน
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

async function returnAsset(txId) {
  if (!confirm(`ยืนยันการรับคืนครุภัณฑ์สำหรับรหัสรายการ: ${txId} ใช่หรือไม่?`)) return;

  try {
    const response = await fetch(`${API_URL}/api/transactions/${txId}/return`, {
      method: 'POST',
      headers: getAuthHeader()
    });

    const result = await response.json();
    if (!response.ok) throw new Error(result.error);

    showToast(result.message, 'success');
    fetchAdminData();
    fetchAssets();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

// Render logs table
function renderLogsTable(logs) {
  const tbody = document.getElementById('table-logs-body');

  if (logs.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="8" style="text-align: center; color: #888; padding: 25px;">ไม่มีบันทึกการทำธุรกรรมในขณะนี้</td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = logs.map(t => {
    const asset = allAssets.find(a => a.asset_id === t.asset_id);
    const assetName = asset ? asset.asset_name : t.asset_id;

    let statusText = '';
    let statusClass = '';
    if (t.status === 'Pending Admin') { statusText = 'รอพัสดุ'; statusClass = 'pending-admin'; }
    else if (t.status === 'Pending Head') { statusText = 'รอหัวหน้า'; statusClass = 'pending-head'; }
    else if (t.status === 'Approved') { statusText = 'กำลังยืม'; statusClass = 'approved'; }
    else if (t.status === 'Rejected') { statusText = 'ปฏิเสธ'; statusClass = 'rejected'; }
    else if (t.status === 'Returned') { statusText = 'คืนแล้ว'; statusClass = 'returned'; }

    return `
      <tr>
        <td><b>${t.transaction_id}</b></td>
        <td>
          <div style="font-weight: 600;">${assetName}</div>
          <div style="font-size: 11px; color: #777;">รหัส: ${t.asset_id}</div>
        </td>
        <td>${t.borrower_name}</td>
        <td>${t.department}</td>
        <td>
          <div style="font-size: 11px;">ยืม: ${t.borrow_date}</div>
          <div style="font-size: 11px;">คืน: ${t.expected_return_date}</div>
        </td>
        <td>${t.actual_return_date || '-'}</td>
        <td><span class="status-label ${statusClass}">${statusText}</span></td>
        <td style="max-width: 150px; font-size: 12px; color: var(--danger);" title="${t.reject_reason || ''}">${t.reject_reason || '-'}</td>
      </tr>
    `;
  }).join('');
}

function filterLogs() {
  const searchQuery = document.getElementById('log-search').value.toLowerCase().trim();
  const statusFilter = document.getElementById('log-status-filter').value;

  const filtered = adminTransactions.filter(t => {
    const asset = allAssets.find(a => a.asset_id === t.asset_id);
    const assetName = asset ? asset.asset_name : '';
    
    const matchesSearch = t.transaction_id.toLowerCase().includes(searchQuery) ||
                          t.borrower_name.toLowerCase().includes(searchQuery) ||
                          t.asset_id.toLowerCase().includes(searchQuery) ||
                          assetName.toLowerCase().includes(searchQuery);
                          
    const matchesStatus = statusFilter === '' || t.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  renderLogsTable(filtered);
}

// --- ADMIN ASSETS MANAGEMENT (ADD & DELETE) ---

// Sync image selection template for adding new asset
function syncNewAssetImage() {
  const select = document.getElementById('new-asset-img-template');
  const input = document.getElementById('new-asset-img-input');
  if (select.value) {
    input.value = select.value;
  }
}

// API Call: Add Asset
async function executeAddAsset(event) {
  event.preventDefault();

  const id = document.getElementById('new-asset-id').value.trim().toUpperCase();
  const name = document.getElementById('new-asset-name').value.trim();
  const category = document.getElementById('new-asset-category').value;
  const serial = document.getElementById('new-asset-serial').value.trim();
  const imageUrl = document.getElementById('new-asset-img-input').value.trim();

  const payload = {
    asset_id: id,
    asset_name: name,
    category: category,
    serial_number: serial,
    image_url: imageUrl
  };

  try {
    const response = await fetch(`${API_URL}/api/assets`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeader()
      },
      body: JSON.stringify(payload)
    });

    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'เกิดข้อผิดพลาดในการบันทึกครุภัณฑ์');

    showToast('เพิ่มรายการครุภัณฑ์ใหม่เรียบร้อยแล้ว!', 'success');
    document.getElementById('add-asset-form').reset();
    
    // Refresh lists
    await fetchAssets();
    renderManageAssetsTable();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

// API Call: Delete Asset
async function executeDeleteAsset(assetId) {
  if (!confirm(`คุณต้องการลบข้อมูลครุภัณฑ์รหัส ${assetId} ออกจากระบบถาวรใช่หรือไม่?`)) return;

  try {
    const response = await fetch(`${API_URL}/api/assets/${assetId}`, {
      method: 'DELETE',
      headers: getAuthHeader()
    });

    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'ไม่สามารถลบครุภัณฑ์ได้');

    showToast(result.message, 'success');
    
    // Refresh lists
    await fetchAssets();
    renderManageAssetsTable();
  } catch (error) {
    showToast(error.message, 'error');
  }
}


// Open Edit Asset Modal and Prefill details
function openEditAssetModal(assetId) {
  const asset = allAssets.find(a => a.asset_id === assetId);
  if (!asset) {
    showToast('ไม่พบข้อมูลครุภัณฑ์ดังกล่าว', 'error');
    return;
  }
  
  document.getElementById('edit-asset-id').value = asset.asset_id;
  document.getElementById('edit-asset-name').value = asset.asset_name;
  document.getElementById('edit-asset-category').value = asset.category;
  document.getElementById('edit-asset-serial').value = asset.serial_number;
  document.getElementById('edit-asset-status').value = asset.status || 'Available';
  document.getElementById('edit-asset-img-input').value = asset.image_url || '';
  
  openModal('edit-asset-modal');
}

// API Call: Update Asset details
async function executeEditAsset(event) {
  event.preventDefault();
  
  const id = document.getElementById('edit-asset-id').value;
  const name = document.getElementById('edit-asset-name').value.trim();
  const category = document.getElementById('edit-asset-category').value;
  const serial = document.getElementById('edit-asset-serial').value.trim();
  const status = document.getElementById('edit-asset-status').value;
  const imageUrl = document.getElementById('edit-asset-img-input').value.trim();
  
  const payload = {
    asset_name: name,
    category: category,
    serial_number: serial,
    status: status,
    image_url: imageUrl
  };
  
  try {
    const response = await fetch(`${API_URL}/api/assets/${id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeader()
      },
      body: JSON.stringify(payload)
    });
    
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'เกิดข้อผิดพลาดในการบันทึกการแก้ไข');
    
    showToast('แก้ไขข้อมูลครุภัณฑ์เรียบร้อยแล้ว!', 'success');
    closeModal('edit-asset-modal');
    
    // Refresh lists
    await fetchAssets();
    renderManageAssetsTable();
  } catch (error) {
    showToast(error.message, 'error');
  }
}


// Render Manage Assets Table list
function renderManageAssetsTable() {
  const tbody = document.getElementById('table-manage-assets-body');
  document.getElementById('manage-assets-count').textContent = allAssets.length;

  if (allAssets.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" style="text-align: center; color: #888; padding: 25px;">ไม่มีรายชื่ออุปกรณ์ในระบบ</td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = allAssets.map(asset => {
    let statusClass = '';
    let statusThai = '';
    if (asset.status === 'Available') { statusClass = 'available'; statusThai = 'พร้อม'; }
    else if (asset.status === 'Borrowed') { statusClass = 'borrowed'; statusThai = 'ถูกยืม'; }
    else if (asset.status === 'Maintenance') { statusClass = 'maintenance'; statusThai = 'ซ่อม'; }

    return `
      <tr>
        <td>
          <img src="${asset.image_url}" alt="" style="width: 40px; height: 30px; object-fit: cover; border-radius: 4px;" onerror="this.src='https://placehold.co/400x300?text=OAS+KKU'">
        </td>
        <td><b>${asset.asset_id}</b></td>
        <td>
          <div style="font-weight:600;">${asset.asset_name}</div>
          <div style="font-size:10px; color:#888;">ประเภท: ${getCategoryThai(asset.category)}</div>
        </td>
        <td>${asset.serial_number}</td>
        <td><span class="status-label ${statusClass}" style="padding: 2px 6px; font-size:11px;">${statusThai}</span></td>
        <td style="text-align: center; white-space: nowrap;">
          <button class="btn btn-warning" style="padding: 4px 8px; font-size: 11px; margin-right: 5px;" onclick="openEditAssetModal('${asset.asset_id}')">
            <i class="fa-solid fa-pen-to-square"></i> แก้ไข
          </button>
          <button class="btn btn-danger" style="padding: 4px 8px; font-size: 11px;" onclick="executeDeleteAsset('${asset.asset_id}')" ${asset.status === 'Borrowed' ? 'disabled' : ''}>
            <i class="fa-solid fa-trash-can"></i> ลบ
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

// Rejection Reason Modal Logic
function openRejectReasonModal(txId, sourceRole) {
  document.getElementById('reject-tx-id').value = txId;
  document.getElementById('reject-source-role').value = sourceRole;
  openModal('reject-modal');
}

function submitRejection() {
  const txId = document.getElementById('reject-tx-id').value;
  const sourceRole = document.getElementById('reject-source-role').value;
  const reason = document.getElementById('form-reject-reason').value.trim();

  if (!reason) {
    showToast('กรุณาระบุเหตุผลการปฏิเสธ', 'error');
    return;
  }

  if (sourceRole === 'admin') {
    adminAction(txId, 'reject', reason);
  } else if (sourceRole === 'head') {
    submitHeadDecision(txId, 'reject', reason);
    closeModal('reject-modal');
  }
}

// Export to CSV utility
function exportLogsToCSV() {
  if (adminTransactions.length === 0) {
    showToast('ไม่มีข้อมูลสำหรับการส่งออก', 'error');
    return;
  }

  const headers = [
    'รหัสธุรกรรม',
    'รหัสครุภัณฑ์',
    'ชื่อผู้ขอเช่า',
    'อีเมลผู้ขอเช่า',
    'หน่วยงาน/ฝ่าย',
    'อีเมลผู้อนุมัติ',
    'วันที่เริ่มยืม',
    'กำหนดส่งคืน',
    'วันที่ส่งคืนจริง',
    'สถานะธุรกรรม',
    'เหตุผลการปฏิเสธ'
  ];

  const rows = adminTransactions.map(t => [
    t.transaction_id,
    t.asset_id,
    t.borrower_name,
    t.borrower_email,
    t.department,
    t.head_email,
    t.borrow_date,
    t.expected_return_date,
    t.actual_return_date || '',
    t.status,
    t.reject_reason || ''
  ]);

  const csvContent = "\uFEFF" + [
    headers.join(','),
    ...rows.map(row => row.map(val => `"${String(val).replace(/"/g, '""')}"`).join(','))
  ].join('\n');

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', `OAS_KKU_Borrowing_Logs_${new Date().toISOString().split('T')[0]}.csv`);
  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  
  showToast('ส่งออกไฟล์ข้อมูล CSV สำเร็จ', 'success');
}

// --- ADMIN USERS MANAGEMENT (ADD & DELETE) ---

let allUsers = [];

async function fetchUsersList() {
  try {
    const response = await fetch(`${API_URL}/api/users`, {
      headers: getAuthHeader()
    });
    if (!response.ok) throw new Error('ไม่สามารถโหลดรายชื่อผู้ใช้งานได้');
    allUsers = await response.json();
    updateSsoDropdown();
  } catch (error) {
    console.error(error);
  }
}

function updateSsoDropdown() {
  const select = document.getElementById('sso-email-select');
  if (!select) return;
  
  const currentVal = select.value;
  select.innerHTML = `
    <option value="">-- ป้อนอีเมลเอง หรือ เลือกบัญชีตัวอย่างด้านล่าง --</option>
    ${allUsers.map(u => `
      <option value="${u.email}">${u.email} - ${u.name} (${getRoleLabel(u.status)})</option>
    `).join('')}
  `;
  
  if (currentVal) select.value = currentVal;
}

function renderManageUsersTable() {
  const tbody = document.getElementById('table-manage-users-body');
  document.getElementById('manage-users-count').textContent = allUsers.length;

  if (allUsers.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="5" style="text-align: center; color: #888; padding: 25px;">ไม่มีข้อมูลผู้ใช้ในระบบ</td>
      </tr>
    `;
    return;
  }

  const sessionStr = localStorage.getItem('user_session');
  const currentUser = sessionStr ? JSON.parse(sessionStr) : null;

  tbody.innerHTML = allUsers.map(u => {
    const isSelf = currentUser && currentUser.email === u.email;
    return `
      <tr>
        <td>
          <div style="font-weight:600;">${u.name}</div>
          <div style="font-size:11px; color:#666;">${u.title || 'ไม่มีตำแหน่งทางการ'}</div>
        </td>
        <td><b>${u.email}</b></td>
        <td>
          <div style="font-size:11px;">${u.division}</div>
          <div style="font-size:10px; color:#888;">${u.department}</div>
        </td>
        <td><span class="status-label ${u.status === 'admin/ staff' ? 'approved' : u.status === 'admin / Approve' ? 'pending-head' : 'returned'}" style="padding: 2px 6px; font-size:11px;">${getRoleLabel(u.status)}</span></td>
        <td style="text-align: center; white-space: nowrap;">
          <button class="btn btn-warning" style="padding: 4px 8px; font-size: 11px; margin-right: 5px;" onclick="openEditUserModal('${u.email}')">
            <i class="fa-solid fa-pen-to-square"></i> แก้ไข
          </button>
          <button class="btn btn-danger" style="padding: 4px 8px; font-size: 11px;" onclick="executeDeleteUser('${u.email}')" ${isSelf ? 'disabled' : ''}>
            <i class="fa-solid fa-trash-can"></i> ลบ
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

async function executeAddUser(event) {
  event.preventDefault();

  const email = document.getElementById('new-user-email').value.trim();
  const name = document.getElementById('new-user-name').value.trim();
  const title = document.getElementById('new-user-title').value.trim();
  const adminTitle = document.getElementById('new-user-admin-title').value.trim();
  const division = document.getElementById('new-user-division').value.trim();
  const department = document.getElementById('new-user-department').value.trim();
  const status = document.getElementById('new-user-status').value;

  const kkuEmailRegex = /^[a-zA-Z0-9._%+-]+@(g\.)?kku\.ac\.th$/i;
  if (!kkuEmailRegex.test(email)) {
    showToast('กรุณากรอกอีเมลมหาวิทยาลัยขอนแก่น (@kku.ac.th)', 'error');
    return;
  }

  const payload = { email, name, title, admin_title: adminTitle, division, department, status };

  try {
    const response = await fetch(`${API_URL}/api/users`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeader()
      },
      body: JSON.stringify(payload)
    });

    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'เกิดข้อผิดพลาดในการบันทึกผู้ใช้');

    showToast('เพิ่มผู้ใช้งานระบบใหม่สำเร็จแล้ว!', 'success');
    document.getElementById('add-user-form').reset();
    
    await fetchUsersList();
    renderManageUsersTable();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function executeDeleteUser(email) {
  if (!confirm(`คุณต้องการลบผู้ใช้ ${email} ออกจากระบบถาวรใช่หรือไม่?`)) return;

  try {
    const response = await fetch(`${API_URL}/api/users/${encodeURIComponent(email)}`, {
      method: 'DELETE',
      headers: getAuthHeader()
    });

    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'ไม่สามารถลบผู้ใช้งานได้');

    showToast(result.message, 'success');
    
    await fetchUsersList();
    renderManageUsersTable();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

// Open Edit User Modal and Prefill details
function openEditUserModal(email) {
  const user = allUsers.find(u => u.email === email);
  if (!user) {
    showToast('ไม่พบข้อมูลผู้ใช้งานดังกล่าว', 'error');
    return;
  }
  
  document.getElementById('edit-user-email').value = user.email;
  document.getElementById('edit-user-name').value = user.name;
  document.getElementById('edit-user-title').value = user.title || '';
  document.getElementById('edit-user-admin-title').value = user.admin_title || '';
  document.getElementById('edit-user-division').value = user.division || '';
  document.getElementById('edit-user-department').value = user.department || '';
  document.getElementById('edit-user-status').value = user.status || 'user';
  
  openModal('edit-user-modal');
}

// API Call: Update User details
async function executeEditUser(event) {
  event.preventDefault();
  
  const email = document.getElementById('edit-user-email').value;
  const name = document.getElementById('edit-user-name').value.trim();
  const title = document.getElementById('edit-user-title').value.trim();
  const adminTitle = document.getElementById('edit-user-admin-title').value.trim();
  const division = document.getElementById('edit-user-division').value.trim();
  const department = document.getElementById('edit-user-department').value.trim();
  const status = document.getElementById('edit-user-status').value;
  
  const payload = {
    name,
    title,
    admin_title: adminTitle,
    division,
    department,
    status
  };
  
  try {
    const response = await fetch(`${API_URL}/api/users/${encodeURIComponent(email)}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeader()
      },
      body: JSON.stringify(payload)
    });
    
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'เกิดข้อผิดพลาดในการบันทึกการแก้ไข');
    
    showToast('แก้ไขข้อมูลผู้ใช้งานสำเร็จแล้ว!', 'success');
    closeModal('edit-user-modal');
    
    // Refresh lists
    await fetchUsersList();
    renderManageUsersTable();
  } catch (error) {
    showToast(error.message, 'error');
  }
}


function filterUsersList() {
  const searchQuery = document.getElementById('user-search').value.toLowerCase().trim();

  const filtered = allUsers.filter(u => {
    return u.name.toLowerCase().includes(searchQuery) || 
           u.email.toLowerCase().includes(searchQuery) ||
           u.title.toLowerCase().includes(searchQuery) ||
           u.department.toLowerCase().includes(searchQuery);
  });

  const tbody = document.getElementById('table-manage-users-body');
  const sessionStr = localStorage.getItem('user_session');
  const currentUser = sessionStr ? JSON.parse(sessionStr) : null;

  tbody.innerHTML = filtered.map(u => {
    const isSelf = currentUser && currentUser.email === u.email;
    return `
      <tr>
        <td>
          <div style="font-weight:600;">${u.name}</div>
          <div style="font-size:11px; color:#666;">${u.title || 'ไม่มีตำแหน่งทางการ'}</div>
        </td>
        <td><b>${u.email}</b></td>
        <td>
          <div style="font-size:11px;">${u.division}</div>
          <div style="font-size:10px; color:#888;">${u.department}</div>
        </td>
        <td><span class="status-label ${u.status === 'admin/ staff' ? 'approved' : u.status === 'admin / Approve' ? 'pending-head' : 'returned'}" style="padding: 2px 6px; font-size:11px;">${getRoleLabel(u.status)}</span></td>
        <td style="text-align: center; white-space: nowrap;">
          <button class="btn btn-warning" style="padding: 4px 8px; font-size: 11px; margin-right: 5px;" onclick="openEditUserModal('${u.email}')">
            <i class="fa-solid fa-pen-to-square"></i> แก้ไข
          </button>
          <button class="btn btn-danger" style="padding: 4px 8px; font-size: 11px;" onclick="executeDeleteUser('${u.email}')" ${isSelf ? 'disabled' : ''}>
            <i class="fa-solid fa-trash-can"></i> ลบ
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

// --- INITIAL ROUTING & LIFECYCLE ---

window.addEventListener('DOMContentLoaded', async () => {
  // Check active SSO session
  checkSsoSession();
  
  const sessionStr = localStorage.getItem('user_session');
  if (sessionStr) {
    await fetchUsersList();
  } else {
    // Populate dropdown logic if element is present
    allUsers = [
      { email: "chukam@kku.ac.th", name: "รศ.น.สพ.ดร.ชูชาติ กมลเลิศ", status: "user" },
      { email: "wassjo@kku.ac.th", name: "นางสาววาสนา ขจรกิตติพงษ์", status: "admin/ staff" },
      { email: "praysu@kku.ac.th", name: "นายประหยัด สินเมืองซ้าย", status: "admin / Approve" },
      { email: "cprako@kku.ac.th", name: "นางประครอง เชียงสนาม", status: "user" },
      { email: "chalpr@kku.ac.th", name: "นายชาลี พรหมอินทร์", status: "user" }
    ];
    updateSsoDropdown();
    // Load Google authentication flow
    loadGoogleAuth();
  }
  
  // Load asset catalog
  fetchAssets();
});
