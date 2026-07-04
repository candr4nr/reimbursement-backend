// Pakai setelah middleware auth
// Contoh: router.get('/users', auth, checkRole('admin'), controller)

const checkRole = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: 'Tidak terautentikasi' });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        message: `Akses ditolak. Role '${req.user.role}' tidak diizinkan.`
      });
    }

    next();
  };
};

module.exports = checkRole;