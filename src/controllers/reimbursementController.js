// src/controllers/reimbursementController.js
const pool = require('../config/db');

// ── GET /reimbursement — list milik user login ─────────────
const getMyList = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { status } = req.query;

    let query = `
      SELECT 
        r.reimbursement_id, r.user_id, u.name AS user_name,
        r.category_id, rc.name AS category_name,
        r.title, r.submit_date, r.description, r.amount, r.status,
        COALESCE(
          json_agg(
            json_build_object(
              'receipt_id', ri.receipt_id,
              'reimbursement_id', ri.reimbursement_id,
              'image_path', ri.image_path,
              'uploaded_at', ri.uploaded_at
            )
          ) FILTER (WHERE ri.receipt_id IS NOT NULL), '[]'
        ) AS images
      FROM reimbursement r
      JOIN "user" u ON u.user_id = r.user_id
      JOIN reimbursement_category rc ON rc.category_id = r.category_id
      LEFT JOIN receipt_image ri ON ri.reimbursement_id = r.reimbursement_id
      WHERE r.user_id = $1
    `;
    const params = [userId];

    if (status) {
      params.push(status);
      query += ` AND r.status = $${params.length}`;
    }

    query += ` GROUP BY r.reimbursement_id, u.name, rc.name ORDER BY r.submit_date DESC`;

    const result = await pool.query(query, params);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Gagal mengambil data' });
  }
};

// ── GET /reimbursement/:id — detail ───────────────────────
const getDetail = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;

    // cek kepemilikan (karyawan hanya bisa lihat miliknya, admin/keuangan bebas)
    const ownerCheck = req.user.role === 'karyawan'
      ? `AND r.user_id = ${userId}` : '';

    const result = await pool.query(`
      SELECT 
        r.reimbursement_id, r.user_id, u.name AS user_name,
        r.category_id, rc.name AS category_name,
        r.title, r.submit_date, r.description, r.amount, r.status,
        j.jabatan_id, j.nama_jabatan, j.divisi
      FROM reimbursement r
      JOIN "user" u ON u.user_id = r.user_id
      LEFT JOIN jabatan j ON u.jabatan_id = j.jabatan_id
      JOIN reimbursement_category rc ON rc.category_id = r.category_id
      WHERE r.reimbursement_id = $1 ${ownerCheck}
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Data tidak ditemukan' });
    }

    const reimbursement = result.rows[0];

    // ambil images
    const images = await pool.query(
      `SELECT * FROM receipt_image WHERE reimbursement_id = $1`, [id]
    );

    // ambil OCR
    const ocr = await pool.query(
      `SELECT * FROM ocr_result WHERE reimbursement_id = $1`, [id]
    );

    // ambil CNN
    const cnn = await pool.query(
      `SELECT * FROM cnn_result WHERE reimbursement_id = $1`, [id]
    );

    // ambil items
    const items = await pool.query(
      `SELECT * FROM receipt_item WHERE reimbursement_id = $1`, [id]
    );

    // ambil approval
    const approval = await pool.query(
      `SELECT * FROM approval WHERE reimbursement_id = $1 ORDER BY approved_at DESC LIMIT 1`, [id]
    );

    res.json({
      success: true,
      data: {
        ...reimbursement,
        images   : images.rows,
        ocr_result : ocr.rows[0] || null,
        cnn_result : cnn.rows[0] || null,
        items    : items.rows,
        approval : approval.rows[0] || null,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Gagal mengambil detail' });
  }
};

// ── POST /reimbursement — submit baru ─────────────────────
const submit = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { category_id, title, description, amount } = req.body;

    if (!category_id || !amount) {
      return res.status(400).json({ success: false, message: 'category_id dan amount wajib diisi' });
    }

    // cek max_amount kategori
    const cat = await pool.query(
      `SELECT max_amount FROM reimbursement_category WHERE category_id = $1`, [category_id]
    );
    if (cat.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Kategori tidak ditemukan' });
    }
    if (parseFloat(amount) > parseFloat(cat.rows[0].max_amount)) {
      return res.status(400).json({
        success: false,
        message: `Jumlah melebihi batas maksimal kategori (Rp ${Number(cat.rows[0].max_amount).toLocaleString('id-ID')})`,
      });
    }

    const result = await pool.query(`
      INSERT INTO reimbursement (user_id, category_id, title, description, amount, status)
      VALUES ($1, $2, $3, $4, $5, 'pending')
      RETURNING *
    `, [userId, category_id, title || null, description || '', amount]);

    const newId = result.rows[0].reimbursement_id;

    // ambil lengkap dengan join untuk response
    const detail = await pool.query(`
      SELECT r.*, u.name AS user_name, rc.name AS category_name
      FROM reimbursement r
      JOIN "user" u ON u.user_id = r.user_id
      JOIN reimbursement_category rc ON rc.category_id = r.category_id
      WHERE r.reimbursement_id = $1
    `, [newId]);

    res.status(201).json({ success: true, data: { ...detail.rows[0], images: [], items: [] } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Gagal submit pengajuan' });
  }
};

// ── PATCH /reimbursement/:id/cancel ───────────────────────
const cancel = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;

    const check = await pool.query(
      `SELECT * FROM reimbursement WHERE reimbursement_id = $1 AND user_id = $2`, [id, userId]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Data tidak ditemukan' });
    }
    if (check.rows[0].status !== 'pending') {
      return res.status(400).json({ success: false, message: 'Hanya pengajuan pending yang bisa dibatalkan' });
    }

    await pool.query(
      `UPDATE reimbursement SET status = 'cancelled' WHERE reimbursement_id = $1`, [id]
    );

    res.json({ success: true, message: 'Pengajuan berhasil dibatalkan' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Gagal membatalkan pengajuan' });
  }
};

// ── GET /reimbursement/all — semua data (keuangan/admin) ──
const getAll = async (req, res) => {
  try {
    const { status } = req.query;

    let query = `
      SELECT 
        r.reimbursement_id, r.user_id, u.name AS user_name,
        r.category_id, rc.name AS category_name,
        r.title, r.submit_date, r.description, r.amount, r.status,
        COALESCE(
          json_agg(
            json_build_object(
              'receipt_id', ri.receipt_id,
              'reimbursement_id', ri.reimbursement_id,
              'image_path', ri.image_path,
              'uploaded_at', ri.uploaded_at
            )
          ) FILTER (WHERE ri.receipt_id IS NOT NULL), '[]'
        ) AS images
      FROM reimbursement r
      JOIN "user" u ON u.user_id = r.user_id
      JOIN reimbursement_category rc ON rc.category_id = r.category_id
      LEFT JOIN receipt_image ri ON ri.reimbursement_id = r.reimbursement_id
    `;
    const params = [];

    if (status) {
      params.push(status);
      query += ` WHERE r.status = $1`;
    }

    query += ` GROUP BY r.reimbursement_id, u.name, rc.name ORDER BY r.submit_date DESC`;

    const result = await pool.query(query, params);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Gagal mengambil data' });
  }
};

module.exports = { getMyList, getDetail, submit, cancel, getAll };