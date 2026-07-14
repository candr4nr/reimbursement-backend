// src/controllers/receiptController.js

const pool = require('../config/db');
const cloudinary = require('../config/cloudinary');

// ── POST /receipt/upload/:reimbursementId ──────────────────
const uploadReceipt = async (req, res) => {
  try {
    const { reimbursementId } = req.params;

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'File gambar wajib diunggah',
      });
    }

    // URL Cloudinary
    const imagePath = req.file.path;

    const result = await pool.query(
      `
      INSERT INTO receipt_image (reimbursement_id, image_path)
      VALUES ($1, $2)
      RETURNING *
      `,
      [reimbursementId, imagePath]
    );

    res.status(201).json({
      success: true,
      data: result.rows[0],
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      success: false,
      message: 'Gagal upload struk',
    });
  }
};

// ── DELETE /receipt/:receiptId ─────────────────────────────
const deleteReceipt = async (req, res) => {
  try {
    const { receiptId } = req.params;

    const check = await pool.query(
      `SELECT * FROM receipt_image WHERE receipt_id = $1`,
      [receiptId]
    );

    if (check.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Struk tidak ditemukan',
      });
    }

    const imageUrl = check.rows[0].image_path;

    // Hapus gambar dari Cloudinary (jika URL Cloudinary)
    if (imageUrl && imageUrl.includes('res.cloudinary.com')) {
      try {
        const url = new URL(imageUrl);

        // contoh:
        // /demo/image/upload/v1784/reimbursement/receipt_123.jpg
        const parts = url.pathname.split('/');

        const uploadIndex = parts.indexOf('upload');

        if (uploadIndex !== -1) {
          let publicIdParts = parts.slice(uploadIndex + 1);

          // buang versi (v123456789)
          if (
            publicIdParts.length > 0 &&
            /^v\d+$/.test(publicIdParts[0])
          ) {
            publicIdParts.shift();
          }

          let publicId = publicIdParts.join('/');

          // buang ekstensi file
          publicId = publicId.replace(/\.[^/.]+$/, '');

          await cloudinary.uploader.destroy(publicId);
        }
      } catch (e) {
        console.error('Gagal menghapus file Cloudinary:', e.message);
      }
    }

    await pool.query(
      `DELETE FROM receipt_image WHERE receipt_id = $1`,
      [receiptId]
    );

    res.json({
      success: true,
      message: 'Struk berhasil dihapus',
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      success: false,
      message: 'Gagal menghapus struk',
    });
  }
};

// ── GET /ocr/:reimbursementId ──────────────────────────────
const getOCRResult = async (req, res) => {
  try {
    const { reimbursementId } = req.params;

    const result = await pool.query(
      `SELECT * FROM ocr_result WHERE reimbursement_id = $1`,
      [reimbursementId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Hasil OCR belum tersedia',
      });
    }

    res.json({
      success: true,
      data: result.rows[0],
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      success: false,
      message: 'Gagal mengambil hasil OCR',
    });
  }
};

// ── GET /cnn/:reimbursementId ──────────────────────────────
const getCNNResult = async (req, res) => {
  try {
    const { reimbursementId } = req.params;

    const result = await pool.query(
      `SELECT * FROM cnn_result WHERE reimbursement_id = $1`,
      [reimbursementId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Hasil CNN belum tersedia',
      });
    }

    res.json({
      success: true,
      data: result.rows[0],
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      success: false,
      message: 'Gagal mengambil hasil CNN',
    });
  }
};

// ── POST /reimbursement/:id/items ──────────────────────────
const addItem = async (req, res) => {
  try {
    const { id } = req.params;
    const { nama_item, qty, harga_satuan } = req.body;

    if (!nama_item || !qty || !harga_satuan) {
      return res.status(400).json({
        success: false,
        message: 'nama_item, qty, harga_satuan wajib diisi',
      });
    }

    const subtotal = qty * harga_satuan;

    const result = await pool.query(
      `
      INSERT INTO receipt_item
      (reimbursement_id, nama_item, qty, harga_satuan, subtotal)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
      `,
      [id, nama_item, qty, harga_satuan, subtotal]
    );

    res.status(201).json({
      success: true,
      data: result.rows[0],
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      success: false,
      message: 'Gagal menambah item',
    });
  }
};

module.exports = {
  uploadReceipt,
  deleteReceipt,
  getOCRResult,
  getCNNResult,
  addItem,
};