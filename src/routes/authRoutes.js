const express = require('express');
const router  = express.Router();
const auth    = require('../middleware/auth');
const {
  login,
  forgotPassword,
  verifyOTP,
  resendOTP,
  resetPassword,
  logout,
} = require('../controllers/authController');

// POST /api/auth/login
router.post('/login', login);

// POST /api/auth/forgot-password
router.post('/forgot-password', forgotPassword);

// POST /api/auth/verify-otp
router.post('/verify-otp', verifyOTP);

// POST /api/auth/resend-otp
router.post('/resend-otp', resendOTP);

// POST /api/auth/reset-password
router.post('/reset-password', resetPassword);

// POST /api/auth/logout (butuh token)
router.post('/logout', auth, logout);

module.exports = router;