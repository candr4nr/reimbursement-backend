require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');

const authRoutes          = require('./src/routes/authRoutes');
const masterRoutes        = require('./src/routes/masterRoutes');
const userRoutes          = require('./src/routes/userRoutes');
const profileRoutes       = require('./src/routes/profileRoutes');
const reimbursementRoutes = require('./src/routes/reimbursementRoutes');
const notificationRoutes  = require('./src/routes/notificationRoutes');
const reportRoutes        = require('./src/routes/reportRoutes');
const approvalRoutes      = require('./src/routes/approvalRoutes');
const ocrRoutes           = require('./src/routes/ocrRoutes');
const cnnRoutes           = require('./src/routes/cnnRoutes');  // ← tambah

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware global ────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// serve folder uploads (struk foto)
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));

// ─── Routes ──────────────────────────────────────────────
app.use('/api/auth',         authRoutes);
app.use('/api',              masterRoutes);
app.use('/api/admin/users',  userRoutes);
app.use('/api/user',         profileRoutes);
app.use('/api',              reimbursementRoutes);
app.use('/api',              notificationRoutes);
app.use('/api/report',       reportRoutes);
app.use('/api/approval',     approvalRoutes);
app.use('/api/ocr',          ocrRoutes);
app.use('/api/cnn',          cnnRoutes);

// Health check
app.get('/api', (req, res) => {
  res.json({ message: 'Reimburse API is running ✅' });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({ message: 'Reimburse API root. Gunakan /api untuk endpoint utama.' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ message: `Route ${req.method} ${req.path} tidak ditemukan` });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ message: err.message || 'Terjadi kesalahan server' });
});

// ─── Start server ─────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Server berjalan di http://localhost:${PORT}`);
});

// debug
const fs = require("fs");

app.get("/debug/uploads", (req, res) => {
  const uploadDir = path.join(__dirname, "public/uploads");

  res.json({
    uploadDir,
    exists: fs.existsSync(uploadDir),
    files: fs.existsSync(uploadDir) ? fs.readdirSync(uploadDir) : []
  });
});