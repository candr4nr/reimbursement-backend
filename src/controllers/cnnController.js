// src/controllers/cnnController.js
const pool = require('../config/db');

// ─── POST /api/cnn/save ───────────────────────────────
// Body: { reimbursement_id, label, confidence }
// Simpan hasil validasi CNN ke tabel cnn_result
exports.saveCnnResult = async (req, res) => {
  try {
    const { reimbursement_id, label, confidence } = req.body;

    if (!reimbursement_id || !label || confidence === undefined) {
      return res.status(400).json({
        message: 'reimbursement_id, label, dan confidence wajib diisi',
      });
    }

    const existing = await pool.query(
      `SELECT cnn_id FROM cnn_result WHERE reimbursement_id = $1`,
      [reimbursement_id]
    );

    if (existing.rows.length > 0) {
      await pool.query(
        `UPDATE cnn_result
         SET label = $1,
             confidence = $2,
             created_at = CURRENT_TIMESTAMP
         WHERE reimbursement_id = $3`,
        [label, confidence, reimbursement_id]
      );
    } else {
      await pool.query(
        `INSERT INTO cnn_result (reimbursement_id, label, confidence)
         VALUES ($1, $2, $3)`,
        [reimbursement_id, label, confidence]
      );
    }

    res.json({ message: 'Hasil CNN berhasil disimpan' });
  } catch (err) {
    console.error('saveCnnResult error:', err);
    res.status(500).json({ message: err.message });
  }
};