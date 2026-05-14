# VISMAX - Tích hợp SePay Auto Nạp Tiền

## Luồng hoạt động

```
User chọn số tiền nạp
    ↓
App gọi server → server tạo mã VLTxxxxxxxx
    ↓
Hiển thị QR VietQR kèm mã VLT + số tiền
    ↓
User chuyển khoản (nội dung: VLT...)
    ↓
SePay nhận tiền → gọi webhook server
    ↓
Server tìm mã VLT → cộng tiền cho đúng user
    ↓
App polling 5s → nhận thành công → cập nhật số dư
```

---

## Bước 1 — Deploy server lên Render.com (miễn phí)

1. Tạo tài khoản tại **render.com**
2. New → Web Service → Connect GitHub (upload folder này)
3. Build Command: `npm install`
4. Start Command: `node server.js`
5. Thêm biến môi trường: `SEPAY_SECRET=your_secret`
6. Deploy → Copy URL (VD: `https://vismax-abc123.onrender.com`)

---

## Bước 2 — Cài đặt SePay (miễn phí)

1. Đăng ký tại **sepay.vn**
2. Liên kết tài khoản ngân hàng Techcombank
3. Vào mục **Webhook** → Thêm webhook:
   - URL: `https://your-app.onrender.com/webhook/sepay`
   - Method: POST
   - Copy **Webhook Secret**
4. Dán Secret vào biến môi trường `SEPAY_SECRET` trên Render

---

## Bước 3 — Cập nhật app HTML

Mở file `vismax-v10.html`, tìm dòng:
```js
const SERVER_URL = 'https://your-app.onrender.com';
```
→ Thay bằng URL Render thật của bạn.

---

## Bước 4 — Cài app ở local để test

```bash
npm install
npm start
# Server chạy tại http://localhost:3000
```

Test webhook giả lập:
```bash
curl -X POST http://localhost:3000/webhook/sepay \
  -H "Content-Type: application/json" \
  -d '{
    "transferType": "in",
    "transferAmount": 500000,
    "content": "VLT1A2B3C4D NGUYEN VAN AN chuyen khoan",
    "referenceCode": "FT25015123456"
  }'
```

---

## API Endpoints

| Method | Path | Mô tả |
|--------|------|-------|
| POST | `/api/deposit/create` | App tạo lệnh nạp, nhận mã VLT |
| GET | `/api/deposit/check?txCode=VLT...` | App polling kiểm tra trạng thái |
| GET | `/api/balance?phone=0912...` | Lấy số dư mới sau khi cộng tiền |
| POST | `/webhook/sepay` | SePay gọi vào khi nhận tiền |
| POST | `/api/users/sync` | Đồng bộ danh sách user lên server |

---

## Khi server offline

App vẫn hoạt động bình thường — tạo mã local, user chuyển khoản,
admin duyệt thủ công trong panel (tab "Nạp tiền chờ duyệt").
