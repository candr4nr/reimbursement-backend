// src/controllers/notificationController.js
const pool = require('../config/db');

// ─── GET /notification — karyawan (status pengajuan sendiri) ───
const getMyNotifications = async (req, res) => {
  try {
    const userId = req.user.userId;

    const result = await pool.query(`
      SELECT 
        a.approval_id,
        a.reimbursement_id,
        a.status,
        a.note,
        a.approved_at,
        r.amount,
        r.submit_date,
        rc.name AS category_name
      FROM approval a
      JOIN reimbursement r ON r.reimbursement_id = a.reimbursement_id
      JOIN reimbursement_category rc ON rc.category_id = r.category_id
      WHERE r.user_id = $1
        AND a.status IN ('approved', 'rejected')
      ORDER BY a.approved_at DESC
    `, [userId]);

    const now          = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const terbaru    = result.rows.filter(n => new Date(n.approved_at) >= sevenDaysAgo);
    const sebelumnya = result.rows.filter(n => new Date(n.approved_at) < sevenDaysAgo);

    res.json({ success: true, data: { terbaru, sebelumnya } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Gagal mengambil notifikasi' });
  }
};

// ─── GET /notification/keuangan — role keuangan ───────────────
const getKeuanganNotifications = async (req, res) => {
  try {
    const now          = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const pendingRes = await pool.query(`
      SELECT
        r.reimbursement_id,
        r.amount,
        r.submit_date,
        r.status,
        u.name  AS user_name,
        rc.name AS category_name,
        NULL    AS approved_at,
        NULL    AS note
      FROM reimbursement r
      JOIN "user" u ON u.user_id = r.user_id
      JOIN reimbursement_category rc ON rc.category_id = r.category_id
      WHERE r.status = 'pending'
      ORDER BY r.submit_date DESC
    `);

    const actionedRes = await pool.query(`
      SELECT
        r.reimbursement_id,
        r.amount,
        r.submit_date,
        a.status,
        u.name  AS user_name,
        rc.name AS category_name,
        a.approved_at,
        a.note
      FROM approval a
      JOIN reimbursement r ON r.reimbursement_id = a.reimbursement_id
      JOIN "user" u ON u.user_id = r.user_id
      JOIN reimbursement_category rc ON rc.category_id = r.category_id
      WHERE a.status IN ('approved', 'rejected')
      ORDER BY a.approved_at DESC
      LIMIT 30
    `);

    const allNotifs = [
      ...pendingRes.rows.map(r => ({ ...r, type: 'pending' })),
      ...actionedRes.rows.map(r => ({ ...r, type: 'actioned' })),
    ].sort((a, b) => {
      const dateA = new Date(a.approved_at || a.submit_date);
      const dateB = new Date(b.approved_at || b.submit_date);
      return dateB - dateA;
    });

    const terbaru    = allNotifs.filter(n => new Date(n.approved_at || n.submit_date) >= sevenDaysAgo);
    const sebelumnya = allNotifs.filter(n => new Date(n.approved_at || n.submit_date) < sevenDaysAgo);

    res.json({ success: true, data: { terbaru, sebelumnya } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Gagal mengambil notifikasi' });
  }
};

// ─── GET /notification/admin — role admin (lebih luas) ────────
// Mencakup: karyawan baru, pengajuan masuk, approval oleh keuangan
const getAdminNotifications = async (req, res) => {
  try {
    const now          = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    // 1. Karyawan baru (created_at 30 hari terakhir)
    const userRes = await pool.query(`
      SELECT
        u.user_id,
        u.name,
        u.email,
        u.role,
        u.status,
        u.created_at,
        j.nama_jabatan
      FROM "user" u
      LEFT JOIN jabatan j ON j.jabatan_id = u.jabatan_id
      WHERE u.created_at >= NOW() - INTERVAL '30 days'
        AND u.role != 'admin'
      ORDER BY u.created_at DESC
    `);

    // 2. Pengajuan reimbursement masuk (30 hari terakhir)
    const reimburseRes = await pool.query(`
      SELECT
        r.reimbursement_id,
        r.amount,
        r.submit_date,
        r.status,
        u.name  AS user_name,
        rc.name AS category_name
      FROM reimbursement r
      JOIN "user" u ON u.user_id = r.user_id
      JOIN reimbursement_category rc ON rc.category_id = r.category_id
      WHERE r.submit_date >= NOW() - INTERVAL '30 days'
      ORDER BY r.submit_date DESC
    `);

    // 3. Approval yang dilakukan keuangan (30 hari terakhir)
    const approvalRes = await pool.query(`
      SELECT
        a.approval_id,
        a.status,
        a.note,
        a.approved_at,
        r.amount,
        r.reimbursement_id,
        u.name  AS user_name,
        rc.name AS category_name
      FROM approval a
      JOIN reimbursement r ON r.reimbursement_id = a.reimbursement_id
      JOIN "user" u ON u.user_id = r.user_id
      JOIN reimbursement_category rc ON rc.category_id = r.category_id
      WHERE a.approved_at >= NOW() - INTERVAL '30 days'
        AND a.status IN ('approved', 'rejected')
      ORDER BY a.approved_at DESC
    `);

    // Gabung semua dengan type label
    const allNotifs = [
      ...userRes.rows.map(r => ({
        ...r,
        type     : 'new_user',
        sort_date: r.created_at,
      })),
      ...reimburseRes.rows.map(r => ({
        ...r,
        type     : 'new_reimbursement',
        sort_date: r.submit_date,
      })),
      ...approvalRes.rows.map(r => ({
        ...r,
        type     : 'approval',
        sort_date: r.approved_at,
      })),
    ].sort((a, b) => new Date(b.sort_date) - new Date(a.sort_date));

    const terbaru    = allNotifs.filter(n => new Date(n.sort_date) >= sevenDaysAgo);
    const sebelumnya = allNotifs.filter(n => new Date(n.sort_date) < sevenDaysAgo);

    res.json({ success: true, data: { terbaru, sebelumnya } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Gagal mengambil notifikasi admin' });
  }
};

module.exports = { getMyNotifications, getKeuanganNotifications, getAdminNotifications };