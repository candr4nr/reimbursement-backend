const db      = require('../config/db');
const bcrypt  = require('bcryptjs');
const mailer  = require('../config/mailer');

// ─── Helper: generate password acak 8 karakter ───────────
const generatePassword = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let password = '';
  for (let i = 0; i < 8; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return password;
};

// ─── Helper: kirim email info akun ───────────────────────
const sendAccountEmail = async (name, email, password) => {
  await mailer.sendMail({
    from: process.env.EMAIL_FROM,
    to: email,
    subject: 'Informasi Akun Reimbursement',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: auto;">
        <h2 style="color: #1877F2;">Akun Anda Telah Dibuat</h2>
        <p>Halo <strong>${name}</strong>,</p>
        <p>Berikut informasi akun Anda untuk mengakses aplikasi Reimbursement:</p>
        <div style="background: #f4f5f9; border-radius: 8px; padding: 16px; margin: 16px 0;">
          <p style="margin: 4px 0;"><strong>Email&nbsp;&nbsp;&nbsp;:</strong> ${email}</p>
          <p style="margin: 4px 0;"><strong>Password:</strong> ${password}</p>
        </div>
        <p>Silakan login menggunakan informasi di atas. Segera ganti password Anda setelah login pertama kali.</p>
        <p style="color: #8d929a; font-size: 12px;">Jika Anda merasa tidak mendaftar, abaikan email ini.</p>
      </div>
    `,
  });
};

// GET all users (dengan join jabatan)
const getAll = async (req, res) => {
  try {
    const result = await db.query(
      `SELECT u.user_id, u.name, u.email, u.nip, u.role, u.status, u.created_at,
              j.jabatan_id, j.nama_jabatan, j.divisi
       FROM "user" u
       LEFT JOIN jabatan j ON u.jabatan_id = j.jabatan_id
       ORDER BY u.user_id ASC`
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET user by ID
const getById = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(
      `SELECT u.user_id, u.name, u.email, u.nip, u.role, u.status, u.created_at,
              j.jabatan_id, j.nama_jabatan, j.divisi
       FROM "user" u
       LEFT JOIN jabatan j ON u.jabatan_id = j.jabatan_id
       WHERE u.user_id = $1`,
      [id]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ success: false, message: 'User tidak ditemukan' });
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST create user — password digenerate otomatis, dikirim via email
const create = async (req, res) => {
  try {
    const { name, email, nip, jabatan_id, role, status } = req.body;

    if (!name || !email || !jabatan_id || !role)
      return res.status(400).json({ success: false, message: 'name, email, jabatan_id, role wajib diisi' });

    // Cek email duplikat
    const existing = await db.query('SELECT user_id FROM "user" WHERE email = $1', [email]);
    if (existing.rows.length > 0)
      return res.status(400).json({ success: false, message: 'Email sudah terdaftar' });

    // Generate & hash password
    const plainPassword  = generatePassword();
    const hashedPassword = await bcrypt.hash(plainPassword, 10);

    const result = await db.query(
      `INSERT INTO "user" (name, email, nip, jabatan_id, password, role, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING user_id, name, email, nip, jabatan_id, role, status, created_at`,
      [name, email, nip || null, jabatan_id, hashedPassword, role, status || 'inactive']
    );

    // Kirim email (jangan block response kalau email gagal)
    try {
      await sendAccountEmail(name, email, plainPassword);
    } catch (mailErr) {
      console.error('Gagal kirim email:', mailErr.message);
    }

    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// PUT update user
const update = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, email, nip, jabatan_id, role, status } = req.body;

    if (!name || !email || !jabatan_id || !role)
      return res.status(400).json({ success: false, message: 'name, email, jabatan_id, role wajib diisi' });

    const existing = await db.query(
      'SELECT user_id FROM "user" WHERE email = $1 AND user_id != $2',
      [email, id]
    );
    if (existing.rows.length > 0)
      return res.status(400).json({ success: false, message: 'Email sudah dipakai user lain' });

    const result = await db.query(
      `UPDATE "user"
       SET name = $1, email = $2, nip = $3, jabatan_id = $4, role = $5, status = $6
       WHERE user_id = $7
       RETURNING user_id, name, email, nip, jabatan_id, role, status, created_at`,
      [name, email, nip || null, jabatan_id, role, status || 'active', id]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ success: false, message: 'User tidak ditemukan' });
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// DELETE user
const remove = async (req, res) => {
  try {
    const { id } = req.params;

    if (parseInt(id) === req.user.userId)
      return res.status(400).json({ success: false, message: 'Tidak bisa menghapus akun sendiri' });

    const result = await db.query(
      'DELETE FROM "user" WHERE user_id = $1 RETURNING user_id, name',
      [id]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ success: false, message: 'User tidak ditemukan' });
    res.json({ success: true, message: `User ${result.rows[0].name} berhasil dihapus` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// PUT reset password — generate ulang password acak, kirim email
const resetPassword = async (req, res) => {
  try {
    const { id } = req.params;

    const userResult = await db.query(
      'SELECT name, email FROM "user" WHERE user_id = $1',
      [id]
    );
    if (userResult.rows.length === 0)
      return res.status(404).json({ success: false, message: 'User tidak ditemukan' });

    const { name, email } = userResult.rows[0];
    const plainPassword   = generatePassword();
    const hashedPassword  = await bcrypt.hash(plainPassword, 10);

    await db.query('UPDATE "user" SET password = $1 WHERE user_id = $2', [hashedPassword, id]);

    try {
      await sendAccountEmail(name, email, plainPassword);
    } catch (mailErr) {
      console.error('Gagal kirim email reset:', mailErr.message);
    }

    res.json({ success: true, message: 'Password berhasil direset dan dikirim ke email karyawan' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = { getAll, getById, create, update, remove, resetPassword };