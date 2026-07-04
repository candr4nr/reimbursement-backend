// src/routes/notificationRoutes.js
const express     = require('express');
const router      = express.Router();
const verifyToken = require('../middleware/auth');
const checkRole   = require('../middleware/checkRole');
const {
  getMyNotifications,
  getKeuanganNotifications,
  getAdminNotifications,
} = require('../controllers/notificationController');

router.get('/notification',          verifyToken, getMyNotifications);
router.get('/notification/keuangan', verifyToken, checkRole('keuangan'), getKeuanganNotifications);
router.get('/notification/admin',    verifyToken, checkRole('admin'),    getAdminNotifications);

module.exports = router;