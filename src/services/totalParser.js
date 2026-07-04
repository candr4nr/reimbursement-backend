// src/services/totalParser.js
// Ekstraksi TOTAL (nominal akhir yang harus dibayar) dari hasil groupLines().
//
// Prioritas pencarian label (dari paling spesifik ke paling umum):
//   1. "GRAND TOTAL"           -> paling otoritatif, selalu dipakai kalau ada
//   2. "TOTAL" (bukan SUBTOTAL) -> fallback kalau tidak ada grand total
//
// SUBTOTAL, TAX/PPN, dan DISCOUNT sengaja DIKECUALIKAN supaya tidak salah
// tertangkap sebagai TOTAL akhir (kasus umum: struk punya urutan
// Subtotal -> Tax -> Total, dan angka Subtotal seringkali muncul duluan).
//
// Strategi ambil nilai, mirip dateParser.js:
//   1. Cari row berlabel (GRAND TOTAL diprioritaskan atas TOTAL biasa).
//   2. Ambil token angka di kanan label pada row yang sama.
//   3. Kalau row label tidak punya angka, cari row lain yang Y-nya sejajar.
//   4. Kalau parser koordinat gagal total, kembalikan null -> coordinateParser
//      fallback ke regexFallbackParser.

const {
  findRowsByKeyword,
  findRowsNearY,
  getTokensRightOfX,
} = require('./lineGrouper');

const { parseNominal } = require('./normalizer');

// ─── Konfigurasi label ─────────────────────────────────────────────────────

const GRAND_TOTAL_REGEX = /\bGRAND\s*TOTAL\b/i;
const TOTAL_REGEX = /\bTOTAL\b/i;
const EXCLUDE_REGEX = /\b(SUB\s*TOTAL|TAX|PPN|DISCOUNT|DISKON|CHANGE|KEMBALI|CASH|TUNAI)\b/i;

// Threshold Y untuk mencari row "sejajar" saat label & value terpisah row.
const Y_ALIGN_THRESHOLD = 15;

// Pola nominal generik: angka dengan opsional pemisah ribuan/desimal,
// opsional diawali "Rp". Dipakai untuk cari kandidat angka di sebuah string.
const NOMINAL_REGEX = /(?:Rp\.?\s*)?\d[\d.,]*\d|\d/g;

// ─── Util ──────────────────────────────────────────────────────────────────

/**
 * Ambil kandidat angka terbaik dari sebuah string (row text atau gabungan
 * token). Kalau ada beberapa angka, ambil yang PALING KANAN (paling besar
 * posisi kemunculannya) karena pola umum struk: "TOTAL   Rp 32.000" ->
 * label di kiri, nominal di kanan.
 */
function extractRightmostNominal(text) {
  if (!text) return null;
  const matches = text.match(NOMINAL_REGEX);
  if (!matches || matches.length === 0) return null;

  const lastMatch = matches[matches.length - 1];
  const value = parseNominal(lastMatch);
  return Number.isFinite(value) ? value : null;
}

/**
 * Cari X akhir dari token yang match sebuah label regex dalam satu row.
 */
function getRightmostLabelTokenX(row, labelRegex) {
  let maxEndX = null;
  for (const token of row.tokens) {
    if (labelRegex.test(token.text)) {
      const endX = token.x + token.width;
      if (maxEndX === null || endX > maxEndX) maxEndX = endX;
    }
  }
  return maxEndX;
}

/**
 * Validasi dasar: total harus angka positif dan masuk akal (bukan 0,
 * bukan nomor telepon/kode struk yang kebetulan ke-parse).
 */
function isPlausibleTotal(value) {
  return Number.isFinite(value) && value > 0 && value < 1_000_000_000;
}

// ─── Pencarian nilai untuk satu row label ──────────────────────────────────

/**
 * Coba ekstrak nominal dari row label + row-row di sekitarnya (Y sejajar).
 * @returns {{raw:string, value:number}|null}
 */
function extractValueForLabelRow(row, rows) {
  // 1. Coba token di kanan label pada row yang sama
  const labelEndX = getRightmostLabelTokenX(row, TOTAL_REGEX) ??
    getRightmostLabelTokenX(row, GRAND_TOTAL_REGEX);

  if (labelEndX !== null) {
    const rightTokens = getTokensRightOfX(row, labelEndX);
    const rightText = rightTokens.map((t) => t.text).join(' ');
    const value = extractRightmostNominal(rightText);
    if (value !== null && isPlausibleTotal(value)) {
      return { raw: rightText.trim() || row.text, value };
    }
  }

  // 2. Coba parse dari seluruh teks row (kalau token split-nya tidak rapi)
  const valueFromRow = extractRightmostNominal(row.text);
  if (valueFromRow !== null && isPlausibleTotal(valueFromRow)) {
    return { raw: row.text, value: valueFromRow };
  }

  // 3. Row lain yang Y-nya sejajar dengan row label
  const nearby = findRowsNearY(rows, row.y, Y_ALIGN_THRESHOLD).filter((r) => r !== row);
  for (const r of nearby) {
    const value = extractRightmostNominal(r.text);
    if (value !== null && isPlausibleTotal(value)) {
      return { raw: r.text, value };
    }
  }

  return null;
}

// ─── Parser utama ──────────────────────────────────────────────────────────

/**
 * Ekstrak nominal TOTAL dari rows hasil groupLines().
 *
 * @param {Array<Row>} rows
 * @returns {{raw:string, value:number, label:'GRAND TOTAL'|'TOTAL'}|null}
 */
function parseTotal(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;

  // 1. Prioritas: GRAND TOTAL
  const grandTotalRows = findRowsByKeyword(rows, GRAND_TOTAL_REGEX)
    .filter(({ row }) => !EXCLUDE_REGEX.test(row.text.replace(GRAND_TOTAL_REGEX, '')));

  for (const { row } of grandTotalRows) {
    const result = extractValueForLabelRow(row, rows);
    if (result) return { ...result, label: 'GRAND TOTAL' };
  }

  // 2. Fallback: TOTAL biasa, tapi kecualikan row yang sebenarnya
  //    SUBTOTAL/TAX/DISCOUNT/CASH/dll (kata-kata itu sering mengandung
  //    substring lain yang bisa salah kena regex label lain).
  const totalRows = findRowsByKeyword(rows, TOTAL_REGEX)
    .filter(({ row }) => !EXCLUDE_REGEX.test(row.text));

  for (const { row } of totalRows) {
    const result = extractValueForLabelRow(row, rows);
    if (result) return { ...result, label: 'TOTAL' };
  }

  // 3. Parser koordinat gagal total -> coordinateParser fallback ke regex
  return null;
}

module.exports = {
  parseTotal,
  extractRightmostNominal,
  isPlausibleTotal,
};