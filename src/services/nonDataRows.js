// src/services/nonDataRows.js
// Basis pola bersama untuk mengenali baris yang BUKAN data inti struk —
// alamat, kontak, dokumen resmi (NPWP/invoice/nota), tanggal/waktu,
// kasir/operator, sapaan pembuka/penutup, label kolom transaksi
// (TOTAL/QTY/HARGA/dll), dan label umum lain (MEMBER/CABANG/OUTLET).
//
// Dipakai bersama oleh itemParser.js (buang baris non-item di tengah
// daftar item) dan regexFallbackParser.js (skip baris non-item saat
// fallback regex murni). Idealnya storeParser.js juga memakai basis yang
// sama untuk filter "bukan nama toko" (lihat komentar di NON_STORE_REGEX
// storeParser.js), supaya tidak ada 3 daftar exclude yang independen dan
// bisa saling tidak sinkron kalau salah satu diupdate tapi yang lain lupa
// — ini rekomendasi #1 (satukan & perluas daftar exclude).
//
// Setiap pemanggil bisa menambahkan pola KHUSUS konteksnya sendiri lewat
// parameter `extra` (mis. itemParser.js menambah 'SERVICE CHARGE',
// 'HARGA SATUAN'; regexFallbackParser.js menambah 'kembalian', 'poin',
// dst) tanpa perlu mengubah basis bersama ini.

// ─── Basis pola (dipakai SEMUA pemanggil) ──────────────────────────────

const BASE_PATTERNS = [
  // Alamat
  'JL\\.?\\s', 'JALAN\\s', '\\bNO\\.?\\s*\\d', 'RT\\s*\\d', 'RW\\s*\\d',
  'KEC\\.?\\s', 'KECAMATAN', 'KAB\\.?\\s', 'KABUPATEN', 'KOTA\\s', 'PROVINSI',
  'KODE\\s*POS', 'KELURAHAN', 'DESA\\s',

  // Kontak
  'TELP', 'TELEPON', 'PHONE', '\\bHP\\b', '\\bWA\\b', 'WHATSAPP', 'FAX',

  // Identitas resmi / dokumen
  'NPWP', 'NO\\.?\\s*(STRUK|TRANSAKSI|FAKTUR|INVOICE|REF|NOTA)',
  'RECEIPT', 'INVOICE', 'FAKTUR', '\\bNOTA\\b',

  // Tanggal & waktu
  '\\b(DATE|TANGGAL|TGL|TIME|JAM)\\b',

  // Kasir / operator
  'KASIR', 'CASHIER', 'OPERATOR', 'KODE\\s*KASIR',

  // Sapaan (pembuka/penutup struk, bukan bagian data)
  'SELAMAT\\s*DATANG', 'WELCOME\\s*TO', 'TERIMA\\s*KASIH', 'THANK\\s*YOU',

  // Label struk umum lain
  'MEMBER', '\\bCABANG\\b', '\\bOUTLET\\b',

  // Baris ringkasan/label transaksi (TOTAL, pajak, diskon, pembayaran, dll)
  'GRAND\\s*TOTAL', '\\bTOTAL\\b', '\\bSUBTOTAL\\b', '\\bTAX\\b', '\\bVAT\\b', '\\bPPN\\b',
  '\\bPAJAK\\b', '\\bDISKON\\b', '\\bDISCOUNT\\b', '\\bDISC\\b', '\\bPROMO\\b',
  // PB1 ("Pajak Bangunan 1" / Pajak Restoran) — pajak daerah restoran/kafe
  // di Indonesia, BEDA dari PPN (pajak pusat), tapi sama-sama baris pajak
  // yang harus dikecualikan dari daftar item. Disyaratkan diikuti "1"
  // (PB1/PB 1) supaya "PB" 2-huruf saja tidak salah nangkep token lain.
  '\\bPB\\s*1\\b',
  // Biaya layanan (BUKAN pajak, tapi sama-sama komponen tambahan sebelum
  // total, jadi harus dikecualikan dari item juga). 'SERVICE' & 'SC'
  // sengaja diberi word-boundary ketat (\b...\b, bukan cuma substring)
  // karena keduanya pendek/generik — risiko false-positive lebih tinggi
  // dibanding pola lain di daftar ini kalau ada nama item/toko yang
  // kebetulan sama persis, tapi cukup jarang terjadi di praktik untuk
  // dijadikan pengecualian.
  'SVC\\s*CHRG', 'SERVICE\\s*CHARGE', '\\bSERVICE\\b', '\\bSC\\b',
  '\\bCASH\\b', '\\bTUNAI\\b', '\\bCHANGE\\b', '\\bKEMBALI\\b',
  '\\bPAYMENT\\b', '\\bBAYAR\\b', '\\bQTY\\b', '\\bHARGA\\b', '\\bITEM\\b',
];

/**
 * Bangun regex GLOBAL (case-insensitive) untuk mendeteksi baris non-data,
 * dari BASE_PATTERNS + pola tambahan spesifik pemanggil (`extra`).
 *
 * Pola tambahan yang SAMA dengan salah satu BASE_PATTERNS tidak masalah
 * kalau dobel (regex OR tetap benar, cuma sedikit redundan) — pemanggil
 * tidak perlu cek manual sebelum menambahkannya.
 *
 * @param {string[]} extra - pola regex tambahan (tanpa anchor/flag) yang
 *   relevan HANYA untuk konteks pemanggil (mis. label kolom item, atau
 *   kata kunci khusus fallback regex).
 * @returns {RegExp}
 */
function buildNonDataRegex(extra = []) {
  const patterns = [...BASE_PATTERNS, ...(Array.isArray(extra) ? extra : [])];
  return new RegExp(patterns.join('|'), 'i');
}

module.exports = {
  buildNonDataRegex,
  BASE_PATTERNS,
};