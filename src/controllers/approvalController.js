// src/controllers/approvalController.js
const pool = require('../config/db');

// ── GET /api/approval/:reimbursementId — detail approval ──
const getDetail = async (req, res) => {
  try {
    const { reimbursementId } = req.params;

    const result = await pool.query(`
      SELECT a.*, u.name AS user_name, rc.name AS category_name,
             r.amount, r.submit_date
      FROM approval a
      JOIN reimbursement r ON r.reimbursement_id = a.reimbursement_id
      JOIN "user" u ON u.user_id = r.user_id
      JOIN reimbursement_category rc ON rc.category_id = r.category_id
      WHERE a.reimbursement_id = $1
      ORDER BY a.approved_at DESC
      LIMIT 1
    `, [reimbursementId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Data approval tidak ditemukan' });
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error('getDetail error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── PATCH /api/approval/:reimbursementId/approve ──────────
const approve = async (req, res) => {
  try {
    const { reimbursementId } = req.params;
    const { note } = req.body;

    // cek reimbursement ada dan masih pending
    const check = await pool.query(
      `SELECT * FROM reimbursement WHERE reimbursement_id = $1`, [reimbursementId]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Pengajuan tidak ditemukan' });
    }
    if (check.rows[0].status !== 'pending') {
      return res.status(400).json({ success: false, message: 'Pengajuan sudah ditindak sebelumnya' });
    }

    // update status reimbursement
    await pool.query(
      `UPDATE reimbursement SET status = 'approved' WHERE reimbursement_id = $1`,
      [reimbursementId]
    );

    // insert atau update approval record
    const existing = await pool.query(
      `SELECT approval_id FROM approval WHERE reimbursement_id = $1`, [reimbursementId]
    );

    let approval;
    if (existing.rows.length > 0) {
      const upd = await pool.query(`
        UPDATE approval
        SET status = 'approved', note = $1, approved_at = NOW()
        WHERE reimbursement_id = $2
        RETURNING *
      `, [note || null, reimbursementId]);
      approval = upd.rows[0];
    } else {
      const ins = await pool.query(`
        INSERT INTO approval (reimbursement_id, status, note, approved_at)
        VALUES ($1, 'approved', $2, NOW())
        RETURNING *
      `, [reimbursementId, note || null]);
      approval = ins.rows[0];
    }

    res.json({ success: true, data: approval });
  } catch (err) {
    console.error('approve error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── PATCH /api/approval/:reimbursementId/reject ───────────
const reject = async (req, res) => {
  try {
    const { reimbursementId } = req.params;
    const { note } = req.body;

    if (!note || note.trim() === '') {
      return res.status(400).json({ success: false, message: 'Alasan penolakan wajib diisi' });
    }

    // cek reimbursement ada dan masih pending
    const check = await pool.query(
      `SELECT * FROM reimbursement WHERE reimbursement_id = $1`, [reimbursementId]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Pengajuan tidak ditemukan' });
    }
    if (check.rows[0].status !== 'pending') {
      return res.status(400).json({ success: false, message: 'Pengajuan sudah ditindak sebelumnya' });
    }

    // update status reimbursement
    await pool.query(
      `UPDATE reimbursement SET status = 'rejected' WHERE reimbursement_id = $1`,
      [reimbursementId]
    );

    // insert atau update approval record
    const existing = await pool.query(
      `SELECT approval_id FROM approval WHERE reimbursement_id = $1`, [reimbursementId]
    );

    let approval;
    if (existing.rows.length > 0) {
      const upd = await pool.query(`
        UPDATE approval
        SET status = 'rejected', note = $1, approved_at = NOW()
        WHERE reimbursement_id = $2
        RETURNING *
      `, [note.trim(), reimbursementId]);
      approval = upd.rows[0];
    } else {
      const ins = await pool.query(`
        INSERT INTO approval (reimbursement_id, status, note, approved_at)
        VALUES ($1, 'rejected', $2, NOW())
        RETURNING *
      `, [reimbursementId, note.trim()]);
      approval = ins.rows[0];
    }

    res.json({ success: true, data: approval });
  } catch (err) {
    console.error('reject error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = { getDetail, approve, reject };