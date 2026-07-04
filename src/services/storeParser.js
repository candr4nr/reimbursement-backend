// src/services/storeParser.js
// Ekstraksi NAMA TOKO dari hasil groupLines() (lihat lineGrouper.js).
//
// Nama toko pada struk hampir selalu berada di BLOK PALING ATAS, kadang
// terpecah jadi beberapa row terpisah oleh ML Kit (mis. "TOMORO" di satu
// row, "COFFEE" di row berikutnya) walau secara visual itu satu baris logo
// / header. Tugas parser ini menyatukannya jadi satu string:
//
//   "TOMORO"        }
//   "COFFEE"        } -> "TOMORO COFFEE"
//
// Strategi (TANPA hardcode daftar nama toko):
//   1. Ambil beberapa row TERATAS (getTopRows) sebagai area kandidat.
//   2. Mulai dari row paling atas, AKUMULASI row berturut-turut yang
//      "kemungkinan bagian nama toko" (bukan alamat, telp, NPWP, nomor
//      struk, tanggal, separator, dst).
//   3. Berhenti akumulasi begitu ketemu row yang jelas BUKAN nama toko
//      (alamat/telp/NPWP/tanggal/separator) atau sudah mencapai
//      MAX_NAME_LINES baris.
//   4. Gabungkan row yang terkumpul jadi satu string nama toko.
//   5. Kalau tidak ada satu row pun yang lolos, kembalikan null supaya
//      coordinateParser.js bisa fallback ke regexFallbackParser.

const { getTopRows } = require('./lineGrouper');

// ─── Konfigurasi ──────────────────────────────────────────────────────────

// Berapa row paling atas yang dianggap "area kandidat" nama toko.
const DEFAULT_TOP_ROWS = 6;

// Maksimum berapa row berturut-turut yang boleh digabung jadi satu nama
// toko (mencegah nama toko "menelan" baris alamat kalau filter meleset).
const MAX_NAME_LINES = 3;

const MIN_STORE_NAME_LENGTH = 2;

// Row yang jelas BUKAN bagian nama toko meski berada di blok atas struk.
const NON_STORE_REGEX = new RegExp(
  [
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
    // Sapaan (biasanya SETELAH nama toko, bukan bagian dari nama)
    'SELAMAT\\s*DATANG', 'WELCOME\\s*TO', 'TERIMA\\s*KASIH', 'THANK\\s*YOU',
    // Label struk umum lain
    'MEMBER', '\\bCABANG\\b', '\\bOUTLET\\b',
    // Baris harga/transaksi (TOTAL, item, dll) -- kalau blok header tidak
    // diakhiri baris alamat/telp yang jelas, baris ini jadi penanda batas
    // paling akhir supaya nama toko tidak "menelan" baris TOTAL/harga.
    'GRAND\\s*TOTAL', '\\bTOTAL\\b', '\\bSUBTOTAL\\b', '\\bTAX\\b', '\\bPPN\\b',
    '\\bPAJAK\\b', '\\bDISKON\\b', '\\bDISCOUNT\\b', '\\bPROMO\\b',
    '\\bCASH\\b', '\\bTUNAI\\b', '\\bCHANGE\\b', '\\bKEMBALI\\b',
    '\\bPAYMENT\\b', '\\bBAYAR\\b', '\\bQTY\\b', '\\bHARGA\\b', '\\bITEM\\b',
  ].join('|'),
  'i'
);

// Baris separator murni (garis pemisah header), mis. "========", "* * *"
const SEPARATOR_REGEX = /^[\s\-=*_~.#]{3,}$/;

// Baris yang isinya (hampir) cuma digit/simbol -> bukan nama toko
// (nomor telp, nomor struk yang tidak ketangkap NON_STORE_REGEX, dll).
const MOSTLY_NUMERIC_REGEX = /^[\d\s\-().,+/:]{3,}$/;

// Baris yang mengandung angka mirip HARGA (>=3 digit berurutan, mis.
// "32000"). Nama toko pada praktiknya nyaris tidak pernah mengandung
// angka sepanjang itu, sementara baris item ("Kopi Susu Aren   32000")
// atau nomor NPWP/telepon sering begitu. Dipakai sebagai jaring pengaman
// terakhir kalau baris tsb lolos dari semua keyword di atas.
const PRICE_LIKE_REGEX = /\d{3,}/;

// ─── Util ──────────────────────────────────────────────────────────────────

/**
 * Apakah row ini kemungkinan besar BUKAN bagian nama toko?
 */
function isNonStoreRow(text) {
  const trimmed = (text || '').trim();
  if (trimmed.length === 0) return true;
  if (SEPARATOR_REGEX.test(trimmed)) return true;
  if (MOSTLY_NUMERIC_REGEX.test(trimmed)) return true;
  if (PRICE_LIKE_REGEX.test(trimmed)) return true;
  if (NON_STORE_REGEX.test(trimmed)) return true;
  return false;
}

/**
 * Rapikan nama toko hasil gabungan: spasi berlebih & separator sisa.
 */
function cleanStoreName(rawName) {
  return rawName
    .replace(/[-=_|]{2,}/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ─── Parser utama ──────────────────────────────────────────────────────────

/**
 * Ekstrak nama toko dari rows hasil groupLines().
 *
 * @param {Array<Row>} rows
 * @param {{topRows?:number, maxNameLines?:number}} options
 * @returns {{name:string, raw:string, lineCount:number}|null}
 */
function parseStore(rows, options = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return null;

  const candidateRows = getTopRows(rows, options.topRows ?? DEFAULT_TOP_ROWS);
  const maxNameLines = options.maxNameLines ?? MAX_NAME_LINES;

  const collected = [];

  for (const row of candidateRows) {
    const text = (row.text || '').trim();

    if (isNonStoreRow(text)) {
      // Kalau sudah mulai mengumpulkan nama dan ketemu row non-toko,
      // berhenti — blok nama toko dianggap selesai.
      if (collected.length > 0) break;
      // Kalau belum mengumpulkan apa-apa, lewati row ini (mis. logo/garis
      // pembuka) dan lanjut cek row berikutnya.
      continue;
    }

    collected.push(text);
    if (collected.length >= maxNameLines) break;
  }

  if (collected.length === 0) return null;

  const name = cleanStoreName(collected.join(' '));
  if (name.length < MIN_STORE_NAME_LENGTH) return null;

  return {
    name,
    raw: collected.join(' | '),
    lineCount: collected.length,
  };
}

module.exports = {
  parseStore,
  isNonStoreRow,
};