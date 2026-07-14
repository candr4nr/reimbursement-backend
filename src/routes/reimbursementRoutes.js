// src/routes/reimbursementRoutes.js
const express = require('express');
const router = express.Router();
const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');

const cloudinary = require('../config/cloudinary');
const reimbursement = require('../controllers/reimbursementController');
const receipt = require('../controllers/receiptController');
const verifyToken = require('../middleware/auth');
const checkRole = require('../middleware/checkRole');

// ── Multer + Cloudinary setup ──────────────────────────────
const storage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: 'reimbursement',
    allowed_formats: ['jpg', 'jpeg', 'png'],
    public_id: (req, file) => `receipt_${Date.now()}`,
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5 MB
  },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/jpg', 'image/png'];

    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Format file tidak didukung. Gunakan JPG atau PNG.'));
    }
  },
});

// ── Reimbursement ──────────────────────────────────────────

// karyawan: list milik sendiri
router.get(
  '/reimbursement',
  verifyToken,
  checkRole('karyawan'),
  reimbursement.getMyList
);

// keuangan & admin: semua data
router.get(
  '/reimbursement/all',
  verifyToken,
  checkRole('keuangan', 'admin'),
  reimbursement.getAll
);

// semua role: detail
router.get(
  '/reimbursement/:id',
  verifyToken,
  reimbursement.getDetail
);

// karyawan: submit baru
router.post(
  '/reimbursement',
  verifyToken,
  checkRole('karyawan'),
  reimbursement.submit
);

// karyawan: batalkan
router.patch(
  '/reimbursement/:id/cancel',
  verifyToken,
  checkRole('karyawan'),
  reimbursement.cancel
);

// karyawan: tambah item manual
router.post(
  '/reimbursement/:id/items',
  verifyToken,
  checkRole('karyawan'),
  receipt.addItem
);

// ── Receipt / OCR / CNN ────────────────────────────────────

router.post(
  '/receipt/upload/:reimbursementId',
  verifyToken,
  upload.single('image'),
  receipt.uploadReceipt
);

router.delete(
  '/receipt/:receiptId',
  verifyToken,
  receipt.deleteReceipt
);

router.get(
  '/ocr/:reimbursementId',
  verifyToken,
  receipt.getOCRResult
);

router.get(
  '/cnn/:reimbursementId',
  verifyToken,
  receipt.getCNNResult
);

module.exports = router;