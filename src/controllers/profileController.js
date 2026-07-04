const db = require('../config/db');

// GET /user/profile — ambil profil user yang sedang login
const getProfile = async (req, res) => {
  try {
    const userId = req.user.userId;
    const result = await db.query(
      `SELECT u.user_id, u.name, u.email, u.nip, u.role, u.status, u.created_at,
              j.jabatan_id, j.nama_jabatan, j.divisi
       FROM "user" u
       LEFT JOIN jabatan j ON u.jabatan_id = j.jabatan_id
       WHERE u.user_id = $1`,
      [userId]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ success: false, message: 'User tidak ditemukan' });
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /user/profile — update nama & nip saja (email & jabatan read only)
const updateProfile = async (req, res) => {
  try {
    const userId     = req.user.userId;
    const { name, nip } = req.body;

    if (!name || name.trim() === '')
      return res.status(400).json({ success: false, message: 'Nama wajib diisi' });

    const result = await db.query(
      `UPDATE "user" SET name = $1, nip = $2
       WHERE user_id = $3
       RETURNING user_id, name, email, nip, role, status, created_at`,
      [name.trim(), nip || null, userId]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ success: false, message: 'User tidak ditemukan' });

    // Ambil ulang dengan join jabatan
    const full = await db.query(
      `SELECT u.user_id, u.name, u.email, u.nip, u.role, u.status, u.created_at,
              j.jabatan_id, j.nama_jabatan, j.divisi
       FROM "user" u
       LEFT JOIN jabatan j ON u.jabatan_id = j.jabatan_id
       WHERE u.user_id = $1`,
      [userId]
    );
    res.json({ success: true, data: full.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /user/change-password
const changePassword = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { old_password, new_password } = req.body;

    if (!old_password || !new_password)
      return res.status(400).json({ success: false, message: 'Password lama dan baru wajib diisi' });

    if (new_password.length < 6)
      return res.status(400).json({ success: false, message: 'Password baru minimal 6 karakter' });

    const bcrypt = require('bcryptjs');

    // Ambil password lama dari DB
    const result = await db.query('SELECT password FROM "user" WHERE user_id = $1', [userId]);
    if (result.rows.length === 0)
      return res.status(404).json({ success: false, message: 'User tidak ditemukan' });

    const match = await bcrypt.compare(old_password, result.rows[0].password);
    if (!match)
      return res.status(400).json({ success: false, message: 'Password lama tidak sesuai' });

    const hashed = await bcrypt.hash(new_password, 10);
    await db.query('UPDATE "user" SET password = $1 WHERE user_id = $2', [hashed, userId]);

    res.json({ success: true, message: 'Password berhasil diubah' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = { getProfile, updateProfile, changePassword };