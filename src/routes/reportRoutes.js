// src/routes/reportRoutes.js
const express     = require('express');
const router      = express.Router();
const report      = require('../controllers/reportController');
const verifyToken = require('../middleware/auth');
const checkRole   = require('../middleware/checkRole');

const adminKeuangan = checkRole('admin', 'keuangan');

router.get('/trend',        verifyToken, adminKeuangan, report.getTrend);
router.get('/per-kategori', verifyToken, adminKeuangan, report.getPerKategori);
router.get('/summary',      verifyToken, adminKeuangan, report.getSummary);
router.get('/per-divisi',   verifyToken, adminKeuangan, report.getPerDivisi);
router.get('/chart',        verifyToken, adminKeuangan, report.getChart);

module.exports = router;