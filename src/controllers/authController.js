const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const pool     = require('../config/db');
const { sendOTPEmail } = require('../config/mailer');

const generateOTP = () => Math.floor(100000 + Math.random() * 900000).toString();

// ─────────────────────────────────────────────────────────
// POST /api/auth/login
// ─────────────────────────────────────────────────────────
const login = async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: 'Email dan password wajib diisi' });
  }

  try {
    const result = await pool.query(
      `SELECT u.user_id, u.name, u.email, u.password, u.nip,
              u.jabatan_id, u.role, u.status,
              j.nama_jabatan
       FROM "user" u
       LEFT JOIN jabatan j ON u.jabatan_id = j.jabatan_id
       WHERE u.email = $1`,
      [email]
    );

    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({ message: 'Email atau password salah' });
    }

    if (user.status !== 'active') {
      return res.status(403).json({ message: 'Akun belum aktif. Cek email untuk aktivasi.' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ message: 'Email atau password salah' });
    }

    const token = jwt.sign(
      { userId: user.user_id, role: user.role, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN }
    );

    return res.json({
      message: 'Login berhasil',
      data: {
        token,
        user: {
          user_id     : user.user_id,
          name        : user.name,
          email       : user.email,
          nip         : user.nip,
          jabatan_id  : user.jabatan_id,
          nama_jabatan: user.nama_jabatan,
          role        : user.role,
          status      : user.status,
        },
      },
    });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ message: 'Terjadi kesalahan server' });
  }
};

// ─────────────────────────────────────────────────────────
// POST /api/auth/forgot-password
// Body: { email }
// Response data.status dipakai frontend untuk menentukan apakah
// ini aktivasi akun pertama kali (inactive) atau lupa password
// biasa (active) — menentukan apakah step password sementara
// perlu ditampilkan atau tidak.
// ─────────────────────────────────────────────────────────
const forgotPassword = async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ message: 'Email wajib diisi' });
  }

  try {
    const result = await pool.query(
      'SELECT user_id, status FROM "user" WHERE email = $1',
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Email tidak terdaftar' });
    }

    const otp     = generateOTP();
    const expires = new Date(Date.now() + 1 * 60 * 1000);

    await pool.query(
      `UPDATE "user" SET otp_code = $1, otp_expired_at = $2 WHERE email = $3`,
      [otp, expires, email]
    );

    await sendOTPEmail(email, otp);

    return res.json({
      message: 'OTP berhasil dikirim ke email',
      data: { status: result.rows[0].status },
    });
  } catch (err) {
    console.error('Forgot password error:', err);
    return res.status(500).json({ message: 'Terjadi kesalahan server' });
  }
};

// ─────────────────────────────────────────────────────────
// POST /api/auth/verify-otp
// Body: { email, otp_code }
// PENTING: OTP tidak dihapus di sini — dihapus saat reset-password
// ─────────────────────────────────────────────────────────
const verifyOTP = async (req, res) => {
  const { email, otp_code } = req.body;

  if (!email || !otp_code) {
    return res.status(400).json({ message: 'Email dan OTP wajib diisi' });
  }

  try {
    const result = await pool.query(
      `SELECT otp_code, otp_expired_at FROM "user" WHERE email = $1`,
      [email]
    );

    const user = result.rows[0];

    if (!user || user.otp_code !== otp_code) {
      return res.status(400).json({ message: 'OTP tidak valid' });
    }

    if (new Date() > new Date(user.otp_expired_at)) {
      return res.status(400).json({ message: 'OTP sudah expired, minta OTP baru' });
    }

    // ← OTP TIDAK dihapus di sini supaya bisa divalidasi lagi di reset-password

    return res.json({ message: 'OTP valid' });
  } catch (err) {
    console.error('Verify OTP error:', err);
    return res.status(500).json({ message: 'Terjadi kesalahan server' });
  }
};

// ─────────────────────────────────────────────────────────
// POST /api/auth/resend-otp
// Body: { email }
// ─────────────────────────────────────────────────────────
const resendOTP = async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ message: 'Email wajib diisi' });
  }

  try {
    const result = await pool.query(
      'SELECT user_id FROM "user" WHERE email = $1',
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Email tidak terdaftar' });
    }

    const otp     = generateOTP();
    const expires = new Date(Date.now() + 1 * 60 * 1000);

    await pool.query(
      `UPDATE "user" SET otp_code = $1, otp_expired_at = $2 WHERE email = $3`,
      [otp, expires, email]
    );

    await sendOTPEmail(email, otp);

    return res.json({ message: 'OTP baru berhasil dikirim' });
  } catch (err) {
    console.error('Resend OTP error:', err);
    return res.status(500).json({ message: 'Terjadi kesalahan server' });
  }
};

// ─────────────────────────────────────────────────────────
// POST /api/auth/reset-password
// Body: { email, otp_code, temp_password, new_password }
// Dipakai untuk: forgot password & aktivasi akun
//
// temp_password: password yang dikirim admin lewat email saat akun
// karyawan pertama kali dibuat (lihat sendAccountEmail() di
// userController.js). Ini jadi lapisan verifikasi TAMBAHAN di
// samping OTP — user harus tahu OTP (bukti akses ke email saat ini)
// DAN password sementara asli (bukti dia penerima akun yang sah),
// sebelum boleh set password baru.
// ─────────────────────────────────────────────────────────
const resetPassword = async (req, res) => {
  const { email, otp_code, temp_password, new_password } = req.body;

  if (!email || !otp_code || !new_password) {
    return res.status(400).json({
      message: 'Email, OTP, dan password baru wajib diisi',
    });
  }

  try {
    const result = await pool.query(
      `SELECT otp_code, otp_expired_at, password, status FROM "user" WHERE email = $1`,
      [email]
    );

    const user = result.rows[0];

    if (!user) {
      return res.status(404).json({ message: 'Email tidak terdaftar' });
    }

    if (user.otp_code !== otp_code) {
      return res.status(400).json({ message: 'OTP tidak valid' });
    }

    if (new Date() > new Date(user.otp_expired_at)) {
      return res.status(400).json({ message: 'OTP sudah expired, minta OTP baru' });
    }

    if (user.status === 'inactive') {
      if (!temp_password) {
        return res.status(400).json({ message: 'Password sementara wajib diisi' });
      }
      const isTempPasswordValid = await bcrypt.compare(temp_password, user.password);
      if (!isTempPasswordValid) {
        return res.status(400).json({ message: 'Password sementara tidak sesuai' });
      }
    }

    const hashed = await bcrypt.hash(new_password, 10);

    await pool.query(
      `UPDATE "user"
       SET password = $1, status = 'active', otp_code = NULL, otp_expired_at = NULL
       WHERE email = $2`,
      [hashed, email]
    );

    return res.json({ message: 'Password berhasil direset' });
  } catch (err) {
    console.error('Reset password error:', err);
    return res.status(500).json({ message: 'Terjadi kesalahan server' });
  }
};

// ─────────────────────────────────────────────────────────
// POST /api/auth/logout
// ─────────────────────────────────────────────────────────
const logout = async (req, res) => {
  return res.json({ message: 'Logout berhasil' });
};

module.exports = { login, forgotPassword, verifyOTP, resendOTP, resetPassword, logout };