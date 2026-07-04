# Reimbursement Backend

Backend untuk aplikasi reimbursement berbasis Node.js + Express + PostgreSQL. API ini menangani autentikasi, pengelolaan reimbursement, upload bukti struk, OCR, approval, notifikasi, dan laporan.

## Fitur Utama

- Autentikasi pengguna dan reset password
- Manajemen data user, profile, dan role
- Proses reimbursement beserta upload bukti struk
- Integrasi OCR dan CNN untuk ekstraksi data struk
- Approval workflow untuk keuangan/admin
- Notifikasi dan laporan
- Penyimpanan file upload di folder public/uploads

## Teknologi yang Digunakan

- Node.js
- Express.js
- PostgreSQL
- JWT untuk autentikasi
- Multer untuk upload file
- Nodemailer untuk email
- CORS dan dotenv

## Struktur Folder

```text
reimbursement_be/
├── index.js
├── package.json
├── public/
│   └── uploads/
├── src/
│   ├── config/
│   ├── controllers/
│   ├── middleware/
│   ├── routes/
│   └── services/
```

## Prerequisites

Pastikan perangkat Anda sudah menginstal:

- Node.js v18+
- npm atau yarn
- PostgreSQL

## Instalasi

1. Masuk ke folder backend

```bash
cd reimbursement_be
```

2. Install dependency

```bash
npm install
```

3. Buat file environment

```bash
copy .env.example .env
```

Jika file .env.example belum ada, buat file .env manual dengan isi berikut:

```env
PORT=3000
DB_HOST=localhost
DB_PORT=5432
DB_NAME=reimbursement_db
DB_USER=postgres
DB_PASSWORD=your_password
JWT_SECRET=your_jwt_secret

SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=your_email@example.com
SMTP_PASS=your_email_password
```

4. Jalankan server

```bash
npm run dev
```

Atau untuk mode produksi:

```bash
npm start
```

Server akan berjalan di:

```text
http://localhost:3000
```

## API Endpoint Utama

Berikut beberapa endpoint penting yang tersedia:

- Auth
  - POST /api/auth/login
  - POST /api/auth/forgot-password
  - POST /api/auth/verify-otp
  - POST /api/auth/reset-password
  - POST /api/auth/logout

- Reimbursement
  - GET /api/reimbursement
  - GET /api/reimbursement/all
  - GET /api/reimbursement/:id
  - POST /api/reimbursement
  - PATCH /api/reimbursement/:id/cancel

- OCR / Receipt
  - POST /api/ocr/parse
  - POST /api/ocr/save
  - POST /api/receipt/upload/:reimbursementId

- Approval
  - POST /api/approval/...

- Report
  - GET /api/report/...

## Catatan

- Folder upload gambar disimpan di public/uploads.
- Pastikan database PostgreSQL sudah dibuat dan tabel yang dibutuhkan sudah tersedia.
- Untuk pengembangan, gunakan npm run dev agar server otomatis restart saat ada perubahan.

## Push ke GitHub

Jika ingin mengunggah ke GitHub, jalankan:

```bash
git init
git add .
git commit -m "Initial backend commit"
git branch -M main
git remote add origin <URL_REPOSITORY>
git push -u origin main
```
