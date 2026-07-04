// src/services/lineGrouper.js
// Mengelompokkan `lines` (raw hasil bounding box dari ocrService.dart, lihat
// struktur OcrLine di brief) menjadi "logical row" — baris yang secara visual
// sejajar meskipun ML Kit mengirimnya sebagai beberapa elemen text terpisah.
//
// Ini FONDASI untuk storeParser/dateParser/totalParser/itemParser: mereka
// semua bekerja di atas hasil groupLines(), bukan langsung ke `lines` mentah.
//
// Tidak menentukan MAKNA baris (itu tugas dateParser dkk) — file ini murni
// menjawab pertanyaan geometris: "token mana saja yang satu baris?" dan
// "urutan baca dari kiri-ke-kanan, atas-ke-bawah seperti apa?"

const { normalizeText } = require('./normalizer');

// ─── Konfigurasi default ─────────────────────────────────────────────────

// Threshold Y dihitung relatif terhadap tinggi rata-rata line (bukan angka
// tetap), supaya tetap masuk akal baik untuk struk resolusi rendah maupun
// foto resolusi tinggi.
const DEFAULT_Y_THRESHOLD_RATIO = 0.6;

// Kalau line tidak punya height (mis. dari fallback rawText tanpa koordinat),
// pakai nilai default ini sebagai tinggi baris sintetis.
const FALLBACK_LINE_HEIGHT = 20;

// ─── Normalisasi & validasi input ────────────────────────────────────────

/**
 * Bersihkan & normalisasi array `lines` mentah dari Flutter:
 *   - buang entri kosong / tidak valid
 *   - normalisasi teks tiap token (perbaiki salah baca huruf<->angka)
 *   - pastikan x/y/width/height berupa Number
 */
function sanitizeLines(rawLines) {
  if (!Array.isArray(rawLines)) return [];

  return rawLines
    .filter((l) => l && typeof l.text === 'string' && l.text.trim().length > 0)
    .map((l) => ({
      text: normalizeText(l.text.trim()),
      x: Number(l.x) || 0,
      y: Number(l.y) || 0,
      width: Number(l.width) || 0,
      height: Number(l.height) || 0,
    }));
}

function averageHeight(lines) {
  const withHeight = lines.filter((l) => l.height > 0);
  if (withHeight.length === 0) return FALLBACK_LINE_HEIGHT;
  const total = withHeight.reduce((sum, l) => sum + l.height, 0);
  return total / withHeight.length;
}

// ─── Grouping utama ───────────────────────────────────────────────────────

/**
 * Kelompokkan lines menjadi logical rows berdasarkan abs(y1 - y2) < threshold.
 *
 * @param {Array<{text:string,x:number,y:number,width:number,height:number}>} rawLines
 * @param {{yThreshold?: number, yThresholdRatio?: number}} options
 * @returns {Array<Row>} rows terurut dari atas ke bawah struk
 *
 * Row = {
 *   text: string,        // gabungan token kiri->kanan, spasi merepresentasikan gap kolom
 *   tokens: OcrLine[],    // token asli dalam row ini, terurut berdasarkan x
 *   y: number,            // rata-rata y token dalam row (anchor row)
 *   minX, maxX, minY, maxY, height: number
 * }
 */
function groupLines(rawLines, options = {}) {
  const lines = sanitizeLines(rawLines);
  if (lines.length === 0) return [];

  const avgHeight = averageHeight(lines);
  const threshold =
    options.yThreshold ?? avgHeight * (options.yThresholdRatio ?? DEFAULT_Y_THRESHOLD_RATIO);

  // Urutan baca: atas ke bawah dulu, lalu kiri ke kanan sebagai tie-breaker
  const sorted = [...lines].sort((a, b) => a.y - b.y || a.x - b.x);

  const groups = [];
  let currentGroup = null;
  let currentAnchorY = null;

  for (const line of sorted) {
    if (currentGroup && Math.abs(line.y - currentAnchorY) < threshold) {
      currentGroup.push(line);
      // Anchor dihitung ulang sebagai rata-rata berjalan supaya row yang agak
      // miring tidak "lepas" hanya karena dibandingkan ke token pertama saja.
      currentAnchorY = currentGroup.reduce((sum, l) => sum + l.y, 0) / currentGroup.length;
    } else {
      if (currentGroup) groups.push(currentGroup);
      currentGroup = [line];
      currentAnchorY = line.y;
    }
  }
  if (currentGroup) groups.push(currentGroup);

  return groups.map(buildRow);
}

/**
 * Gabungkan token-token dalam satu row jadi objek Row siap pakai.
 * Gap antar token dikonversi jadi spasi proporsional supaya pola regex
 * `\s{2,}` (dipakai itemParser & regexFallbackParser untuk memisahkan
 * "nama item" dari "kolom harga") tetap valid di atas hasil koordinat.
 */
function buildRow(rowTokens) {
  const sortedByX = [...rowTokens].sort((a, b) => a.x - b.x);

  let text = '';
  for (let i = 0; i < sortedByX.length; i++) {
    const token = sortedByX[i];
    if (i === 0) {
      text += token.text;
      continue;
    }
    const prev = sortedByX[i - 1];
    const gap = token.x - (prev.x + prev.width);
    const avgCharWidth = prev.width > 0 && prev.text.length > 0
      ? prev.width / prev.text.length
      : 8;
    const estimatedSpaces = Math.max(1, Math.round(gap / Math.max(avgCharWidth, 1)));
    text += (estimatedSpaces >= 3 ? '   ' : ' ') + token.text;
  }

  const minX = Math.min(...sortedByX.map((t) => t.x));
  const maxX = Math.max(...sortedByX.map((t) => t.x + t.width));
  const minY = Math.min(...sortedByX.map((t) => t.y));
  const maxY = Math.max(...sortedByX.map((t) => t.y + t.height));
  const avgY = sortedByX.reduce((sum, t) => sum + t.y, 0) / sortedByX.length;

  return {
    text,
    tokens: sortedByX,
    y: avgY,
    minX,
    maxX,
    minY,
    maxY,
    height: maxY - minY,
  };
}

// ─── Fallback: bangun rows dari raw_text tanpa koordinat ─────────────────

/**
 * Dipakai coordinateParser saat `lines` kosong/tidak dikirim (client lama
 * atau kasus edge tertentu), supaya storeParser/dateParser/totalParser/
 * itemParser tetap bisa jalan di atas struktur Row yang sama — hanya saja
 * tanpa informasi X sungguhan (semua token dianggap satu kolom).
 */
function groupLinesFromRawText(rawText) {
  if (!rawText || typeof rawText !== 'string') return [];

  return rawText
    .split('\n')
    .map((line) => normalizeText(line.trim()))
    .filter((line) => line.length > 0)
    .map((text, index) => ({
      text,
      tokens: [{ text, x: 0, y: index * FALLBACK_LINE_HEIGHT, width: text.length * 8, height: FALLBACK_LINE_HEIGHT }],
      y: index * FALLBACK_LINE_HEIGHT,
      minX: 0,
      maxX: text.length * 8,
      minY: index * FALLBACK_LINE_HEIGHT,
      maxY: index * FALLBACK_LINE_HEIGHT + FALLBACK_LINE_HEIGHT,
      height: FALLBACK_LINE_HEIGHT,
    }));
}

// ─── Helper pencarian untuk parser lain ──────────────────────────────────

/**
 * Cari row pertama yang teksnya cocok dengan regex/keyword.
 * @returns {{row: Row, index: number}|null}
 */
function findRowByKeyword(rows, regex) {
  for (let i = 0; i < rows.length; i++) {
    if (regex.test(rows[i].text)) {
      return { row: rows[i], index: i };
    }
  }
  return null;
}

/**
 * Cari SEMUA row yang cocok dengan regex/keyword.
 */
function findRowsByKeyword(rows, regex) {
  return rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => regex.test(row.text));
}

/**
 * Ambil token-token dalam sebuah row yang berada di sebelah kanan
 * koordinat X tertentu. Berguna untuk dateParser/totalParser: setelah
 * ketemu row yang mengandung label ("TOTAL", "DATE"), ambil nilainya
 * yang letaknya di sisi kanan label pada row yang sama.
 */
function getTokensRightOfX(row, xThreshold) {
  return row.tokens.filter((t) => t.x >= xThreshold).sort((a, b) => a.x - b.x);
}

/**
 * Cari row lain yang Y-nya "sejajar" (dalam threshold yang sama) dengan
 * row acuan tapi bukan row itu sendiri — berguna kalau label & value
 * ternyata terpisah jadi dua row gara-gara threshold grouping meleset
 * tipis di pinggir.
 */
function findRowsNearY(rows, targetY, threshold) {
  return rows.filter((row) => Math.abs(row.y - targetY) < threshold);
}

/**
 * Ambil N row teratas (dipakai storeParser untuk mencari blok nama toko
 * di bagian paling atas struk).
 */
function getTopRows(rows, n = 5) {
  return rows.slice(0, n);
}

/**
 * Konversi rows kembali ke array of string, dipakai saat perlu fallback ke
 * regexFallbackParser.parseWithRegex(lines) yang menerima array string biasa.
 */
function rowsToPlainLines(rows) {
  return rows.map((row) => row.text);
}

module.exports = {
  groupLines,
  groupLinesFromRawText,
  sanitizeLines,
  findRowByKeyword,
  findRowsByKeyword,
  getTokensRightOfX,
  findRowsNearY,
  getTopRows,
  rowsToPlainLines,
  DEFAULT_Y_THRESHOLD_RATIO,
  FALLBACK_LINE_HEIGHT,
};