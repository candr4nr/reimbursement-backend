require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: {
    rejectUnauthorized: false,
  },
});

pool.connect()
  .then(() => {
    console.log('✅ Terhubung ke PostgreSQL (Neon)');
  })
  .catch((err) => {
    console.error('❌ Gagal koneksi ke PostgreSQL:', err.message);
  });

module.exports = pool;