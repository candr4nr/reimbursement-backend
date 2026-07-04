const express     = require('express');
const router      = express.Router();
const profile     = require('../controllers/profileController');
const verifyToken = require('../middleware/auth');

router.get ('/profile',         verifyToken, profile.getProfile);
router.put ('/profile',         verifyToken, profile.updateProfile);
router.put ('/change-password', verifyToken, profile.changePassword);

module.exports = router;