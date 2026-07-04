const db = require('../config/db');

// GET all category
const getAll = async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM reimbursement_category ORDER BY category_id ASC'
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET category by ID
const getById = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(
      'SELECT * FROM reimbursement_category WHERE category_id = $1',
      [id]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ success: false, message: 'Kategori tidak ditemukan' });
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST create category
const create = async (req, res) => {
  try {
    const { name, max_amount, description } = req.body;
    if (!name || !max_amount)
      return res.status(400).json({ success: false, message: 'name dan max_amount wajib diisi' });

    const result = await db.query(
      'INSERT INTO reimbursement_category (name, max_amount, description) VALUES ($1, $2, $3) RETURNING *',
      [name, max_amount, description || null]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// PUT update category
const update = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, max_amount, description } = req.body;
    if (!name || !max_amount)
      return res.status(400).json({ success: false, message: 'name dan max_amount wajib diisi' });

    const result = await db.query(
      `UPDATE reimbursement_category
       SET name = $1, max_amount = $2, description = $3
       WHERE category_id = $4 RETURNING *`,
      [name, max_amount, description || null, id]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ success: false, message: 'Kategori tidak ditemukan' });
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// DELETE category
const remove = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(
      'DELETE FROM reimbursement_category WHERE category_id = $1 RETURNING *',
      [id]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ success: false, message: 'Kategori tidak ditemukan' });
    res.json({ success: true, message: 'Kategori berhasil dihapus' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = { getAll, getById, create, update, remove };