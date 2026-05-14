// ============================================================
//  VISMAX - SePay Webhook Server
//  Nhận webhook từ SePay → tự động cộng tiền cho user
// ============================================================
const express = require('express');
const cors    = require('cors');
const crypto  = require('crypto');
const fs      = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Đọc SEPAY_SECRET từ biến môi trường hoặc file .env ─────
const SEPAY_SECRET = process.env.SEPAY_SECRET || 'your_sepay_webhook_secret';

// ── File lưu dữ liệu user (thay bằng DB thật nếu có) ───────
const DB_FILE = './data/users.json';
const TX_FILE = './data/transactions.json';

// ── Đảm bảo thư mục data tồn tại ───────────────────────────
if (!fs.existsSync('./data')) fs.mkdirSync('./data');
if (!fs.existsSync(DB_FILE))  fs.writeFileSync(DB_FILE, '{}');
if (!fs.existsSync(TX_FILE))  fs.writeFileSync(TX_FILE, '[]');

// ── Helpers ─────────────────────────────────────────────────
function loadUsers()  { try { return JSON.parse(fs.readFileSync(DB_FILE)); } catch { return {}; } }
function saveUsers(u) { fs.writeFileSync(DB_FILE, JSON.stringify(u, null, 2)); }
function loadTxs()    { try { return JSON.parse(fs.readFileSync(TX_FILE)); } catch { return []; } }
function saveTxs(t)   { fs.writeFileSync(TX_FILE, JSON.stringify(t, null, 2)); }

function fmtVND(n)    { return n.toLocaleString('vi-VN'); }

// Tạo mã giao dịch VLT: VLT + 8 ký tự ngẫu nhiên
function genTxCode()  { return 'VLT' + crypto.randomBytes(4).toString('hex').toUpperCase(); }

// Verify chữ ký SePay (HMAC-SHA256)
function verifySign(body, sig) {
  const expected = crypto
    .createHmac('sha256', SEPAY_SECRET)
    .update(JSON.stringify(body))
    .digest('hex');
  return expected === sig;
}

// ── Middleware ───────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// Log mọi request
app.use((req, res, next) => {
  console.log(`[${new Date().toLocaleString('vi-VN')}] ${req.method} ${req.path}`);
  next();
});

// ============================================================
//  POST /api/users/sync
//  App gọi endpoint này mỗi lần user đăng nhập/đăng ký
//  để đồng bộ danh sách user lên server
// ============================================================
app.post('/api/users/sync', (req, res) => {
  const { users } = req.body;
  if (!users || typeof users !== 'object') {
    return res.status(400).json({ ok: false, msg: 'Thiếu dữ liệu users' });
  }
  const existing = loadUsers();
  // Merge: giữ dữ liệu server, chỉ thêm user mới
  let added = 0;
  Object.keys(users).forEach(phone => {
    if (!existing[phone]) {
      existing[phone] = users[phone];
      added++;
    }
  });
  saveUsers(existing);
  console.log(`[sync] +${added} user mới, tổng: ${Object.keys(existing).length}`);
  res.json({ ok: true, total: Object.keys(existing).length, added });
});

// ============================================================
//  POST /api/deposit/create
//  App gọi khi user chọn số tiền nạp → server trả về txCode
// ============================================================
app.post('/api/deposit/create', (req, res) => {
  const { phone, amount } = req.body;
  if (!phone || !amount) return res.status(400).json({ ok: false, msg: 'Thiếu phone/amount' });

  const txCode = genTxCode();
  const txs    = loadTxs();
  txs.push({
    txCode,
    phone,
    amount: parseInt(amount),
    status: 'pending',   // pending → success / expired
    createdAt: Date.now(),
    expiredAt: Date.now() + 15 * 60 * 1000, // 15 phút
  });
  saveTxs(txs);

  console.log(`[deposit/create] ${phone} nạp ${fmtVND(amount)}đ → mã ${txCode}`);
  res.json({ ok: true, txCode, expiredAt: Date.now() + 15 * 60 * 1000 });
});

// ============================================================
//  GET /api/deposit/check?txCode=VLTxxxxxxxx
//  App polling mỗi 5 giây để kiểm tra trạng thái
// ============================================================
app.get('/api/deposit/check', (req, res) => {
  const { txCode } = req.query;
  if (!txCode) return res.status(400).json({ ok: false, msg: 'Thiếu txCode' });

  const txs = loadTxs();
  const tx  = txs.find(t => t.txCode === txCode);
  if (!tx) return res.status(404).json({ ok: false, msg: 'Không tìm thấy giao dịch' });

  // Kiểm tra hết hạn
  if (tx.status === 'pending' && Date.now() > tx.expiredAt) {
    tx.status = 'expired';
    saveTxs(txs);
  }

  res.json({ ok: true, status: tx.status, amount: tx.amount, phone: tx.phone });
});

// ============================================================
//  POST /webhook/sepay
//  SePay gọi endpoint này khi nhận được tiền chuyển khoản
//  Docs: https://sepay.vn/lap-trinh-webhook.html
// ============================================================
app.post('/webhook/sepay', (req, res) => {
  // 1. Xác thực chữ ký (bỏ comment khi đã có secret thật)
  // const sig = req.headers['x-sepay-signature'];
  // if (!verifySign(req.body, sig)) {
  //   console.warn('[webhook] Chữ ký không hợp lệ!');
  //   return res.status(401).json({ success: false });
  // }

  const data = req.body;
  console.log('[webhook] Nhận từ SePay:', JSON.stringify(data));

  /*
    Cấu trúc payload SePay:
    {
      id: 12345,
      gateway: "techcombank",
      transactionDate: "2025-01-15 10:30:00",
      accountNumber: "19076215910013",
      code: null,           ← nội dung chuyển khoản (mình tìm VLT... ở đây)
      content: "VLT4A2B3C4D NGUYEN VAN AN chuyen khoan",
      transferType: "in",   ← "in" = nhận tiền
      transferAmount: 500000,
      accumulated: 500000,
      referenceCode: "FT25015...",
      description: "..."
    }
  */

  // 2. Chỉ xử lý giao dịch nhận tiền (in)
  if (data.transferType !== 'in') {
    return res.json({ success: true, msg: 'Bỏ qua: không phải giao dịch nhận tiền' });
  }

  const content = (data.content || '') + ' ' + (data.description || '');
  const amount  = parseInt(data.transferAmount) || 0;

  // 3. Tìm mã VLT... trong nội dung chuyển khoản
  const match = content.match(/VLT[A-Z0-9]{8}/i);
  if (!match) {
    console.log('[webhook] Không tìm thấy mã VLT trong nội dung:', content);
    return res.json({ success: true, msg: 'Không có mã VLT — bỏ qua' });
  }

  const txCode = match[0].toUpperCase();
  console.log(`[webhook] Tìm thấy mã: ${txCode}, số tiền: ${fmtVND(amount)}đ`);

  // 4. Tìm giao dịch trong danh sách pending
  const txs = loadTxs();
  const tx  = txs.find(t => t.txCode === txCode && t.status === 'pending');

  if (!tx) {
    console.log(`[webhook] Không tìm thấy giao dịch pending với mã ${txCode}`);
    return res.json({ success: true, msg: 'Không tìm thấy giao dịch pending' });
  }

  // 5. Kiểm tra số tiền (cho phép chênh lệch ±1000đ)
  if (Math.abs(amount - tx.amount) > 1000) {
    console.warn(`[webhook] Số tiền không khớp: gửi ${amount}đ, yêu cầu ${tx.amount}đ`);
    tx.status = 'amount_mismatch';
    tx.receivedAmount = amount;
    saveTxs(txs);
    return res.json({ success: true, msg: 'Số tiền không khớp' });
  }

  // 6. Cộng tiền cho user
  const users = loadUsers();
  const user  = users[tx.phone];

  if (!user) {
    console.error(`[webhook] Không tìm thấy user: ${tx.phone}`);
    return res.json({ success: true, msg: 'Không tìm thấy user' });
  }

  // Cập nhật số dư
  user.balance = (user.balance || 0) + amount;

  // Cập nhật lịch sử nạp tiền
  user.depositHistory = user.depositHistory || [];
  const depRecord = user.depositHistory.find(d => d.txCode === txCode);
  if (depRecord) {
    depRecord.status  = 'Thành công';
    depRecord.amount  = amount;
  } else {
    user.depositHistory.unshift({
      date:   new Date().toLocaleString('vi-VN'),
      amount: amount,
      status: 'Thành công',
      type:   'Nạp tiền',
      txCode: txCode,
    });
  }

  // Đánh dấu giao dịch thành công
  tx.status        = 'success';
  tx.completedAt   = Date.now();
  tx.receivedAmount = amount;
  tx.sepayRef      = data.referenceCode || data.id;

  saveUsers(users);
  saveTxs(txs);

  console.log(`✅ [webhook] Cộng ${fmtVND(amount)}đ cho ${tx.phone} (${txCode})`);
  res.json({ success: true });
});

// ============================================================
//  GET /api/balance?phone=0912345678
//  App gọi sau khi deposit thành công để lấy số dư mới
// ============================================================
app.get('/api/balance', (req, res) => {
  const { phone } = req.query;
  if (!phone) return res.status(400).json({ ok: false });
  const users = loadUsers();
  const user  = users[phone];
  if (!user)  return res.status(404).json({ ok: false, msg: 'Không tìm thấy user' });
  res.json({
    ok:      true,
    balance: user.balance || 0,
    depositHistory: (user.depositHistory || []).slice(0, 20),
  });
});

// ============================================================
//  GET / — kiểm tra server còn sống
// ============================================================
app.get('/', (req, res) => {
  const txs   = loadTxs();
  const users = loadUsers();
  res.json({
    name:    'VISMAX SePay Webhook Server',
    status:  'running',
    users:   Object.keys(users).length,
    pending: txs.filter(t => t.status === 'pending').length,
    success: txs.filter(t => t.status === 'success').length,
    time:    new Date().toLocaleString('vi-VN'),
  });
});

app.listen(PORT, () => {
  console.log(`\n🚀 VISMAX SePay Server chạy tại http://localhost:${PORT}`);
  console.log(`   POST /webhook/sepay     ← SePay gọi vào đây`);
  console.log(`   POST /api/deposit/create ← App tạo mã giao dịch`);
  console.log(`   GET  /api/deposit/check  ← App polling kiểm tra`);
  console.log(`   GET  /api/balance        ← App lấy số dư mới\n`);
});
