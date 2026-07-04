// src/routes/cnnRoutes.js
const express     = require('express');
const router      = express.Router();
const verifyToken = require('../middleware/auth');
const cnn         = require('../controllers/cnnController');

// Simpan hasil validasi CNN ke DB
router.post('/save', verifyToken, cnn.saveCnnResult);

module.exports = router;