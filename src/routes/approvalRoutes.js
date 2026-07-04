// src/routes/approvalRoutes.js
const express   = require('express');
const router    = express.Router();
const { getDetail, approve, reject } = require('../controllers/approvalController');
const auth      = require('../middleware/auth');
const checkRole = require('../middleware/checkRole');

// GET  /api/approval/:reimbursementId
router.get('/:reimbursementId', auth, getDetail);

// PATCH /api/approval/:reimbursementId/approve
router.patch('/:reimbursementId/approve', auth, checkRole('keuangan', 'admin'), approve);

// PATCH /api/approval/:reimbursementId/reject
router.patch('/:reimbursementId/reject', auth, checkRole('keuangan', 'admin'), reject);

module.exports = router;