// src/routes/ocrRoutes.js
const express    = require('express');
const router     = express.Router();
const verifyToken = require('../middleware/auth');
const checkRole  = require('../middleware/checkRole');
const ocr        = require('../controllers/ocrController');

// Parse raw text → ekstrak nama_toko, tanggal, items, total
router.post('/parse', verifyToken, ocr.parseOcr);

// Simpan hasil OCR ke DB (ocr_result + receipt_item)
router.post('/save',  verifyToken, ocr.saveOcr);

module.exports = router;