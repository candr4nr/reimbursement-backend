// src/controllers/ocrController.js
//
// REFACTOR: seluruh logika parsing (nama toko, tanggal, total, items)
// SUDAH DIPINDAH ke services/coordinateParser.js (parser koordinat +
// regex fallback). Controller ini TIDAK BOLEH lagi berisi regex parsing
// sendiri — kalau butuh field baru atau perbaikan akurasi, edit di
// services/storeParser.js / dateParser.js / totalParser.js / itemParser.js
// / regexFallbackParser.js, BUKAN di sini.
//
// Controller hanya bertanggung jawab atas: validasi request, memanggil
// parser, dan menyimpan/membaca dari database (PostgreSQL, via `pg`).

const pool = require('../config/db');
const { parseReceipt } = require('../services/coordinateParser');

// ─── POST /api/ocr/parse ───────────────────────────────────────────────
// Body: { raw_text, lines? }
//   raw_text : string, teks OCR mentah (WAJIB)
//   lines    : Array<OcrLine>, hasil bounding box dari ML Kit (OPSIONAL —
//              kalau tidak dikirim/kosong, parser tetap jalan berbasis
//              baris dari raw_text, lihat lineGrouper.groupLinesFromRawText)
//
// Return: { success, data: { raw_text, nama_toko, tanggal, items, total, meta } }
exports.parseOcr = (req, res) => {
  try {
    const { raw_text, lines } = req.body;

    if (!raw_text) {
      return res.status(400).json({ success: false, message: 'raw_text wajib diisi' });
    }

    const hasil = parseReceipt({ rawText: raw_text, lines });

    res.json({
      success: true,
      message: 'OK',
      data: {
        raw_text,
        nama_toko: hasil.namaToko,
        tanggal: hasil.tanggal,
        items: hasil.items,
        total: hasil.total,
        // meta.source menandai asal tiap field ('coordinate' | 'regex' | null).
        // Berguna untuk debugging & analisis akurasi (skripsi), boleh
        // diabaikan/dibuang di frontend kalau tidak perlu ditampilkan.
        meta: hasil.meta,
      },
    });
  } catch (err) {
    console.error('parseOcr error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─── POST /api/ocr/save ────────────────────────────────────────────────
// Body: { reimbursement_id, nama_toko, tanggal, total, raw_text, items[] }
// Simpan ke tabel ocr_result + receipt_item.
//
// ASUMSI SKEMA: kolom `reimbursement_id` di tabel `ocr_result` punya
// UNIQUE/PRIMARY KEY constraint, supaya ON CONFLICT di bawah valid.
exports.saveOcr = async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      reimbursement_id,
      nama_toko,
      tanggal,
      total,
      total_amount, // Flutter (ocrService.saveOcrResult) mengirim key ini,
                    // BUKAN "total" — jangan hapus, lihat catatan di bawah.
      raw_text,
      items = [],
    } = req.body;

    // Terima kedua nama field untuk jaga-jaga (backward compat kalau ada
    // caller lain yang masih kirim "total"), tapi Flutter versi terbaru
    // selalu mengirim "total_amount" — field itu yang diprioritaskan.
    const finalTotal = total_amount ?? total ?? null;

    if (!reimbursement_id) {
      return res.status(400).json({ success: false, message: 'reimbursement_id wajib diisi' });
    }

    await client.query('BEGIN');

    // Upsert ocr_result (kalau sudah ada, update)
    await client.query(`
      INSERT INTO ocr_result (reimbursement_id, nama_toko, transaction_date, total_amount, raw_text)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (reimbursement_id) DO UPDATE SET
        nama_toko        = EXCLUDED.nama_toko,
        transaction_date = EXCLUDED.transaction_date,
        total_amount     = EXCLUDED.total_amount,
        raw_text         = EXCLUDED.raw_text
    `, [reimbursement_id, nama_toko || null, tanggal || null, finalTotal, raw_text || null]);

    // Hapus items lama, insert ulang
    await client.query(
      'DELETE FROM receipt_item WHERE reimbursement_id = $1',
      [reimbursement_id]
    );

    for (const item of items) {
      await client.query(`
        INSERT INTO receipt_item (reimbursement_id, nama_item, qty, harga_satuan, subtotal)
        VALUES ($1, $2, $3, $4, $5)
      `, [
        reimbursement_id,
        item.nama_item,
        item.qty || 1,
        item.harga_satuan || 0,
        item.subtotal || 0,
      ]);
    }

    await client.query('COMMIT');

    res.json({ success: true, message: 'Hasil OCR berhasil disimpan' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('saveOcr error:', err);
    res.status(500).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
};