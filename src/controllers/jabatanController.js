const db = require('../config/db');

// GET all jabatan
const getAll = async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM jabatan ORDER BY jabatan_id ASC'
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET jabatan by ID
const getById = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(
      'SELECT * FROM jabatan WHERE jabatan_id = $1',
      [id]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ success: false, message: 'Jabatan tidak ditemukan' });
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST create jabatan
const create = async (req, res) => {
  try {
    const { nama_jabatan, divisi } = req.body;
    if (!nama_jabatan)
      return res.status(400).json({ success: false, message: 'nama_jabatan wajib diisi' });

    const result = await db.query(
      'INSERT INTO jabatan (nama_jabatan, divisi) VALUES ($1, $2) RETURNING *',
      [nama_jabatan, divisi || null]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// PUT update jabatan
const update = async (req, res) => {
  try {
    const { id } = req.params;
    const { nama_jabatan, divisi } = req.body;
    if (!nama_jabatan)
      return res.status(400).json({ success: false, message: 'nama_jabatan wajib diisi' });

    const result = await db.query(
      'UPDATE jabatan SET nama_jabatan = $1, divisi = $2 WHERE jabatan_id = $3 RETURNING *',
      [nama_jabatan, divisi || null, id]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ success: false, message: 'Jabatan tidak ditemukan' });
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// DELETE jabatan
const remove = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(
      'DELETE FROM jabatan WHERE jabatan_id = $1 RETURNING *',
      [id]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ success: false, message: 'Jabatan tidak ditemukan' });
    res.json({ success: true, message: 'Jabatan berhasil dihapus' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = { getAll, getById, create, update, remove };