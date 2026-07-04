const express = require('express');
const router  = express.Router();

const jabatan  = require('../controllers/jabatanController');
const category = require('../controllers/categoryController');

const verifyToken = require('../middleware/auth');
const checkRole   = require('../middleware/checkRole');

// ── Jabatan (/api/jabatan) ──────────────────────────────────────────
router.get   ('/jabatan',     verifyToken, jabatan.getAll);
router.get   ('/jabatan/:id', verifyToken, jabatan.getById);
router.post  ('/jabatan',     verifyToken, checkRole('admin'), jabatan.create);
router.put   ('/jabatan/:id', verifyToken, checkRole('admin'), jabatan.update);
router.delete('/jabatan/:id', verifyToken, checkRole('admin'), jabatan.remove);

// ── Category (/api/category) ────────────────────────────────────────
router.get   ('/category',     verifyToken, category.getAll);
router.get   ('/category/:id', verifyToken, category.getById);
router.post  ('/category',     verifyToken, checkRole('admin'), category.create);
router.put   ('/category/:id', verifyToken, checkRole('admin'), category.update);
router.delete('/category/:id', verifyToken, checkRole('admin'), category.remove);

module.exports = router;