// src/controllers/reportController.js
const pool = require('../config/db');

// ── Helper default range ───────────────────────────────────
const defaultRange = () => {
  const now = new Date();
  const dari   = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
  const sampai = now.toISOString().split('T')[0];
  return { dari, sampai };
};

// ── GET /api/report/trend ─────────────────────────────────
// Tren pengajuan (dashboard admin), dipecah per status.
// Semua tanggal dalam range ikut ditampilkan walau nilainya 0.
exports.getTrend = async (req, res) => {
  try {
    const { dari = defaultRange().dari, sampai = defaultRange().sampai } = req.query;

    const d1 = new Date(dari);
    const d2 = new Date(sampai);
    const selisih = Math.ceil((d2 - d1) / (1000 * 60 * 60 * 24));

    let truncUnit, labelFormat;
    if (selisih <= 31) {
      truncUnit = 'day';   labelFormat = 'DD Mon';
    } else if (selisih <= 366) {
      truncUnit = 'month'; labelFormat = 'Mon YYYY';
    } else {
      truncUnit = 'year';  labelFormat = 'YYYY';
    }

    const result = await pool.query(`
      WITH series AS (
        SELECT generate_series(
          DATE_TRUNC($1, $3::date),
          DATE_TRUNC($1, $4::date),
          ('1 ' || $1)::interval
        ) AS raw_date
      ),
      counts AS (
        SELECT
          DATE_TRUNC($1, submit_date) AS raw_date,
          status,
          COUNT(*)::int AS total
        FROM reimbursement
        WHERE submit_date::date BETWEEN $3 AND $4
        GROUP BY DATE_TRUNC($1, submit_date), status
      )
      SELECT
        TO_CHAR(s.raw_date, $2) AS label,
        COALESCE(SUM(c.total) FILTER (WHERE c.status = 'approved'), 0)::int AS approved,
        COALESCE(SUM(c.total) FILTER (WHERE c.status = 'pending'), 0)::int  AS pending,
        COALESCE(SUM(c.total) FILTER (WHERE c.status = 'rejected'), 0)::int AS rejected
      FROM series s
      LEFT JOIN counts c ON c.raw_date = s.raw_date
      GROUP BY s.raw_date
      ORDER BY s.raw_date
    `, [truncUnit, labelFormat, dari, sampai]);

    res.json({ message: 'OK', dari, sampai, data: result.rows });
  } catch (err) {
    console.error('getTrend error:', err);
    res.status(500).json({ message: err.message });
  }
};

// ── GET /api/report/per-kategori ──────────────────────────
exports.getPerKategori = async (req, res) => {
  try {
    const { dari = defaultRange().dari, sampai = defaultRange().sampai } = req.query;

    const result = await pool.query(`
      SELECT
        c.category_id,
        c.name AS category_name,
        COUNT(r.reimbursement_id)::int AS total
      FROM reimbursement_category c
      LEFT JOIN reimbursement r
        ON r.category_id = c.category_id
        AND r.submit_date::date BETWEEN $1 AND $2
      GROUP BY c.category_id, c.name
      ORDER BY total DESC
    `, [dari, sampai]);

    res.json({ message: 'OK', dari, sampai, data: result.rows });
  } catch (err) {
    console.error('getPerKategori error:', err);
    res.status(500).json({ message: err.message });
  }
};

// ── GET /api/report/summary ───────────────────────────────
// Jumlah pengajuan + total nominal per kategori
// Query param opsional: status (pending | approved | rejected)
exports.getSummary = async (req, res) => {
  try {
    const { dari = defaultRange().dari, sampai = defaultRange().sampai, status } = req.query;

    const params = [dari, sampai];
    let statusFilter = '';
    if (status && status !== 'semua') {
      params.push(status);
      statusFilter = `AND r.status = $${params.length}`;
    }

    const result = await pool.query(`
      SELECT
        c.category_id,
        c.name AS category_name,
        COUNT(r.reimbursement_id)::int    AS jumlah,
        COALESCE(SUM(r.amount), 0)::float AS total_nominal
      FROM reimbursement_category c
      LEFT JOIN reimbursement r
        ON r.category_id = c.category_id
        AND r.submit_date::date BETWEEN $1 AND $2
        ${statusFilter}
      GROUP BY c.category_id, c.name
      ORDER BY total_nominal DESC
    `, params);

    res.json({ message: 'OK', dari, sampai, status: status || 'semua', data: result.rows });
  } catch (err) {
    console.error('getSummary error:', err);
    res.status(500).json({ message: err.message });
  }
};

// ── GET /api/report/per-divisi ────────────────────────────
// Total spending per divisi jabatan
// Query param opsional: status (pending | approved | rejected)
exports.getPerDivisi = async (req, res) => {
  try {
    const { dari = defaultRange().dari, sampai = defaultRange().sampai, status } = req.query;

    // ambil total semua dulu untuk hitung persentase (ikut difilter status)
    const totalParams = [dari, sampai];
    let totalStatusFilter = '';
    if (status && status !== 'semua') {
      totalParams.push(status);
      totalStatusFilter = `AND status = $${totalParams.length}`;
    }

    const totalRes = await pool.query(`
      SELECT COALESCE(SUM(amount), 0)::float AS grand_total
      FROM reimbursement
      WHERE submit_date::date BETWEEN $1 AND $2
      ${totalStatusFilter}
    `, totalParams);
    const grandTotal = totalRes.rows[0].grand_total || 1;

    // query utama (alias reimbursement = r, jadi filter pakai r.status)
    const mainParams = [dari, sampai];
    let mainStatusFilter = '';
    if (status && status !== 'semua') {
      mainParams.push(status);
      mainStatusFilter = `AND r.status = $${mainParams.length}`;
    }

    const result = await pool.query(`
      SELECT
        j.divisi,
        COUNT(r.reimbursement_id)::int    AS jumlah,
        COALESCE(SUM(r.amount), 0)::float AS total_nominal
      FROM jabatan j
      LEFT JOIN "user" u ON u.jabatan_id = j.jabatan_id
      LEFT JOIN reimbursement r
        ON r.user_id = u.user_id
        AND r.submit_date::date BETWEEN $1 AND $2
        ${mainStatusFilter}
      GROUP BY j.divisi
      ORDER BY total_nominal DESC
    `, mainParams);

    const data = result.rows.map(row => ({
      ...row,
      progress: parseFloat((row.total_nominal / grandTotal).toFixed(4)),
    }));

    res.json({ message: 'OK', dari, sampai, status: status || 'semua', grand_total: grandTotal, data });
  } catch (err) {
    console.error('getPerDivisi error:', err);
    res.status(500).json({ message: err.message });
  }
};

// ── GET /api/report/chart ─────────────────────────────────
// Tren pengajuan (report screen keuangan), dipecah per status.
// Semua tanggal dalam range ikut ditampilkan walau nilainya 0.
exports.getChart = async (req, res) => {
  try {
    const { dari = defaultRange().dari, sampai = defaultRange().sampai } = req.query;

    const d1 = new Date(dari);
    const d2 = new Date(sampai);
    const selisih = Math.ceil((d2 - d1) / (1000 * 60 * 60 * 24));

    let truncUnit, labelFormat, groupBy;
    if (selisih <= 31) {
      truncUnit = 'day';   labelFormat = 'DD Mon'; groupBy = 'hari';
    } else if (selisih <= 366) {
      truncUnit = 'month'; labelFormat = 'Mon YYYY'; groupBy = 'bulan';
    } else {
      truncUnit = 'year';  labelFormat = 'YYYY'; groupBy = 'tahun';
    }

    const result = await pool.query(`
      WITH series AS (
        SELECT generate_series(
          DATE_TRUNC($1, $3::date),
          DATE_TRUNC($1, $4::date),
          ('1 ' || $1)::interval
        ) AS raw_date
      ),
      counts AS (
        SELECT
          DATE_TRUNC($1, submit_date) AS raw_date,
          status,
          COUNT(*)::int AS total
        FROM reimbursement
        WHERE submit_date::date BETWEEN $3 AND $4
          AND status IN ('pending', 'approved', 'rejected')
        GROUP BY DATE_TRUNC($1, submit_date), status
      )
      SELECT
        TO_CHAR(s.raw_date, $2) AS label,
        COALESCE(SUM(c.total) FILTER (WHERE c.status = 'pending'), 0)::int  AS pending,
        COALESCE(SUM(c.total) FILTER (WHERE c.status = 'approved'), 0)::int AS approved,
        COALESCE(SUM(c.total) FILTER (WHERE c.status = 'rejected'), 0)::int AS rejected
      FROM series s
      LEFT JOIN counts c ON c.raw_date = s.raw_date
      GROUP BY s.raw_date
      ORDER BY s.raw_date
    `, [truncUnit, labelFormat, dari, sampai]);

    res.json({ message: 'OK', dari, sampai, groupBy, data: result.rows });
  } catch (err) {
    console.error('getChart error:', err);
    res.status(500).json({ message: err.message });
  }
};