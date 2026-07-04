const express = require('express');
const router  = express.Router();

const user        = require('../controllers/userController');
const verifyToken = require('../middleware/auth');
const checkRole   = require('../middleware/checkRole');

// Semua route user hanya bisa diakses admin
router.get   ('/',              verifyToken, checkRole('admin'), user.getAll);
router.get   ('/:id',          verifyToken, checkRole('admin'), user.getById);
router.post  ('/',              verifyToken, checkRole('admin'), user.create);
router.put   ('/:id',          verifyToken, checkRole('admin'), user.update);
router.delete('/:id',          verifyToken, checkRole('admin'), user.remove);
router.put   ('/:id/reset-password', verifyToken, checkRole('admin'), user.resetPassword);

module.exports = router;