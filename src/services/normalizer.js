// src/services/normalizer.js
// Pembersih hasil OCR (Google ML Kit) sebelum diproses parser koordinat
// maupun regex fallback. Menangani dua jenis kesalahan OCR yang paling
// sering muncul di struk:
//
//   1. Salah baca huruf <-> angka pada kata     (TOMOR0 -> TOMORO, Smal1 -> Small)
//   2. Salah baca / hilang digit pada angka     (Rp 32,00 -> Rp 32,000, tahun 2028 -> 2026)
//
// File ini TIDAK tahu apa-apa soal bounding box / koordinat — murni
// fungsi normalisasi string & angka yang reusable di banyak tempat
// (lineGrouper, storeParser, dateParser, totalParser, itemParser,
// regexFallbackParser).

// ─── Kamus koreksi kata (exact match, case-insensitive) ────────────────
// Tambahkan entri baru di sini begitu ketemu kasus OCR salah baca yang
// konsisten dari hasil testing real. Key HARUS lowercase.
const KNOWN_OCR_FIXES = {
  'tomor0': 'TOMORO',
  'tom0ro': 'TOMORO',
  'smal1': 'Small',
  'a11': 'All',
  'coffe': 'Coffee',
  'coff33': 'Coffee',
  'gr4nd': 'Grand',
  't0tal': 'Total',
  'tota1': 'Total',
  'su8total': 'Subtotal',
  'subt0tal': 'Subtotal',
  'ca5h': 'Cash',
  'tun4i': 'Tunai',
  'me d1um': 'Medium',
  'med1um': 'Medium',
  'larg3': 'Large',
  'disk0n': 'Diskon',
  'p4jak': 'Pajak',
};

// Daftar kata "aman" (whitelist) yang sering muncul di struk. Dipakai
// untuk memvalidasi hasil substitusi heuristik supaya tidak asal ganti
// digit jadi huruf pada kata yang justru memang berisi angka (mis. "A4", "V2").
const KNOWN_WORDS_WHITELIST = new Set([
  'small', 'medium', 'large', 'all', 'total', 'grand', 'subtotal', 'tax',
  'cash', 'change', 'kembali', 'kembalian', 'tunai', 'bayar', 'payment',
  'diskon', 'discount', 'pajak', 'ppn', 'service', 'charge', 'member',
  'poin', 'point', 'struk', 'nota', 'invoice', 'coffee', 'tomoro',
  'indomaret', 'alfamart', 'lawson', 'familymart', 'starbucks', 'kasir',
  'cashier', 'date', 'tanggal', 'time', 'jam', 'nomor', 'channel', 'order',
]);

// Peta kemiripan visual digit -> huruf. Hanya dipakai pada token yang
// SUDAH diduga kata (bukan angka murni), lihat isLikelyWordToken().
const DIGIT_TO_LETTER = {
  '0': 'O',
  '1': 'I',
  '5': 'S',
  '8': 'B',
  '6': 'G',
  '2': 'Z',
  '4': 'A',
  '9': 'g',
};

// Peta kemiripan visual huruf -> digit. Dipakai kebalikannya di dalam
// parseNominal() saat sebuah token numerik "terkontaminasi" huruf akibat
// salah baca (mis. "3O.OOO" harusnya "30.000").
const LETTER_TO_DIGIT = {
  o: '0',
  O: '0',
  i: '1',
  I: '1',
  l: '1',
  L: '1',
  s: '5',
  S: '5',
  b: '8',
  B: '8',
  g: '9',
  G: '6',
  z: '2',
  Z: '2',
};

// ─── Helper klasifikasi token ───────────────────────────────────────────

/**
 * Token dianggap "kemungkinan kata" (bukan angka) kalau proporsi huruf
 * lebih banyak dari digit, dan panjangnya cukup untuk dinilai sebagai
 * kata (bukan angka pendek seperti kode/qty).
 */
function isLikelyWordToken(token) {
  const letters = (token.match(/[a-zA-Z]/g) || []).length;
  const digits = (token.match(/[0-9]/g) || []).length;
  if (letters === 0) return false;
  if (digits === 0) return false; // token full huruf tidak butuh koreksi di sini
  return letters > digits && token.length >= 3;
}

/**
 * Token dianggap "kemungkinan angka" kalau isinya hanya digit, separator
 * (. , spasi), atau huruf yang mirip digit secara visual.
 */
function isLikelyNumericToken(token) {
  const cleaned = token.replace(/[.,\s]/g, '');
  if (cleaned.length === 0) return false;
  return /^[0-9oOiIlLsSbBgGzZ]+$/.test(cleaned);
}

// ─── Normalisasi teks (kata) ────────────────────────────────────────────

/**
 * Perbaiki satu token/kata hasil OCR.
 * Urutan prioritas:
 *   1. Cocokkan ke KNOWN_OCR_FIXES (paling akurat, hasil observasi nyata)
 *   2. Kalau token kemungkinan kata yang terkontaminasi digit, coba
 *      substitusi digit->huruf lalu validasi ke whitelist
 *   3. Kalau tidak ada yang cocok, kembalikan token asli (tidak dipaksa ubah)
 */
function normalizeWord(token) {
  if (!token) return token;

  const bare = token.trim();
  if (!bare) return token;

  // Pisahkan tanda baca di ujung (titik dua, koma, dst) supaya matching
  // kamus tidak gagal gara-gara "TOMOR0:" != "tomor0"
  const leadingMatch = bare.match(/^[^a-zA-Z0-9]*/)[0];
  const trailingMatch = bare.match(/[^a-zA-Z0-9]*$/)[0];
  const core = bare.slice(leadingMatch.length, bare.length - trailingMatch.length);
  if (!core) return token;

  const lowerCore = core.toLowerCase();

  // 1. Kamus exact match
  if (KNOWN_OCR_FIXES[lowerCore]) {
    return leadingMatch + KNOWN_OCR_FIXES[lowerCore] + trailingMatch;
  }

  // 2. Heuristik substitusi digit->huruf, divalidasi via whitelist
  if (isLikelyWordToken(core)) {
    const substituted = core
      .split('')
      .map((ch) => DIGIT_TO_LETTER[ch] || ch)
      .join('');

    if (KNOWN_WORDS_WHITELIST.has(substituted.toLowerCase())) {
      return leadingMatch + substituted + trailingMatch;
    }
  }

  // 3. Tidak ada koreksi yang meyakinkan -> biarkan apa adanya
  return token;
}

/**
 * Normalisasi satu baris/blok teks OCR. Aman dipanggil untuk raw_text
 * penuh maupun per-line dari bounding box, karena hanya memproses token
 * yang "kemungkinan kata" dan membiarkan token angka apa adanya (angka
 * ditangani terpisah oleh parseNominal saat parser butuh nilainya).
 */
function normalizeText(text) {
  if (!text) return text;

  return text
    .split(/(\s+)/) // pertahankan whitespace supaya layout tidak rusak
    .map((token) => (token.trim() ? normalizeWord(token) : token))
    .join('');
}

// ─── Normalisasi angka / nominal ────────────────────────────────────────

/**
 * Parse string angka hasil OCR (yang mungkin mengandung huruf mirip
 * digit, separator ribuan tidak konsisten, atau kehilangan satu digit)
 * menjadi Number murni. Return null kalau tidak bisa diparse sama sekali.
 *
 * Contoh:
 *   "32.000"   -> 32000
 *   "32,000"   -> 32000
 *   "1.234.567"-> 1234567
 *   "32,00"    -> 32000   (heuristik: OCR kehilangan satu digit terakhir)
 *   "3O.OOO"   -> 30000   (O disubstitusi jadi 0 lebih dulu)
 */
function parseNominal(raw) {
  if (raw === null || raw === undefined) return null;

  let str = String(raw).trim();
  if (!str) return null;

  // Buang simbol mata uang & spasi
  str = str.replace(/rp\.?/gi, '').replace(/\s+/g, '');
  if (!str) return null;

  // Substitusi huruf yang mirip digit (hanya kalau token ini memang
  // kemungkinan angka, supaya tidak salah proses kata biasa)
  if (!isLikelyNumericToken(str)) return null;
  str = str
    .split('')
    .map((ch) => LETTER_TO_DIGIT[ch] || ch)
    .join('');

  // Hanya sisakan digit dan separator
  str = str.replace(/[^0-9.,]/g, '');
  if (!str) return null;

  const separators = str.match(/[.,]/g) || [];

  // Tidak ada separator sama sekali -> langsung integer
  if (separators.length === 0) {
    const n = parseInt(str, 10);
    return Number.isNaN(n) ? null : n;
  }

  // Lebih dari satu separator -> semuanya separator ribuan (mis. "1.234.567")
  if (separators.length > 1) {
    const n = parseInt(str.replace(/[.,]/g, ''), 10);
    return Number.isNaN(n) ? null : n;
  }

  // Tepat satu separator -> cek jumlah digit di belakangnya
  const sepIndex = Math.max(str.lastIndexOf('.'), str.lastIndexOf(','));
  const integerPart = str.slice(0, sepIndex);
  const fractionPart = str.slice(sepIndex + 1);

  if (fractionPart.length === 3) {
    // Separator ribuan standar: "32.000" / "32,000"
    const n = parseInt(integerPart + fractionPart, 10);
    return Number.isNaN(n) ? null : n;
  }

  if (fractionPart.length === 2) {
    if (fractionPart === '00') {
      // Kasus dari brief: "Rp 32,00" maksudnya "Rp 32.000" tapi OCR
      // kehilangan satu digit nol di akhir -> tambahkan satu nol.
      const n = parseInt(integerPart + fractionPart + '0', 10);
      return Number.isNaN(n) ? null : n;
    }
    // Dua digit selain "00" -> kemungkinan memang nilai desimal kecil
    // (jarang di struk Indonesia, tapi ditangani supaya tidak hilang).
    const n = Math.round(parseFloat(`${integerPart}.${fractionPart}`));
    return Number.isNaN(n) ? null : n;
  }

  if (fractionPart.length === 1) {
    // Satu digit di belakang separator biasanya typo/OCR noise, gabung saja.
    const n = parseInt(integerPart + fractionPart, 10);
    return Number.isNaN(n) ? null : n;
  }

  // fractionPart kosong (mis. "32,") -> abaikan separator
  const n = parseInt(integerPart, 10);
  return Number.isNaN(n) ? null : n;
}

// ─── Normalisasi tahun ───────────────────────────────────────────────────

// Peta kemiripan visual antar digit, dipakai khusus untuk koreksi tahun
// (arah lebih luas dibanding DIGIT_TO_LETTER karena di sini kita cuma
// tukar digit ke digit lain yang bentuknya mirip).
const DIGIT_CONFUSION = {
  '0': ['8', '6', '9'],
  '1': ['7'],
  '2': ['7'],
  '3': ['8'],
  '5': ['6', '8', '9'],
  '6': ['5', '8', '0'],
  '7': ['1', '2'],
  '8': ['0', '3', '6', '9'],
  '9': ['8', '5', '0'],
};

/**
 * Koreksi tahun hasil OCR yang melebihi (tahun sekarang + toleransi).
 * Strategi: kalau tahun masih masuk akal (dalam rentang toleransi),
 * kembalikan apa adanya. Kalau tidak, coba tukar 1-2 digit terakhir
 * dengan digit yang bentuknya mirip sampai ketemu tahun yang masuk akal.
 * Kalau tetap tidak ketemu, clamp ke tahun sekarang.
 *
 * @param {string|number} yearInput - string/number tahun 4 digit
 * @param {number} toleranceYears - berapa tahun ke depan masih dianggap wajar
 * @param {number} maxYearsBack - batas berapa tahun ke belakang masih dianggap wajar
 * @returns {string} tahun 4 digit yang sudah dikoreksi
 */
function normalizeYear(yearInput, toleranceYears = 1, maxYearsBack = 15) {
  const currentYear = new Date().getFullYear();
  const year = parseInt(yearInput, 10);

  if (!year || Number.isNaN(year) || String(year).length !== 4) {
    return String(currentYear);
  }

  const isPlausible = (y) =>
    y <= currentYear + toleranceYears && y >= currentYear - maxYearsBack;

  if (isPlausible(year)) {
    return String(year);
  }

  const digits = String(year).split('');

  // Kumpulkan SEMUA kandidat substitusi 1 digit (posisi terakhir & kedua
  // dari belakang — sesuai pola error OCR yang lebih sering kena di situ)
  // yang menghasilkan tahun masuk akal, lalu pilih yang PALING DEKAT ke
  // tahun sekarang. Tidak boleh berhenti di kandidat valid pertama, karena
  // urutan di DIGIT_CONFUSION tidak merepresentasikan "paling mungkin".
  let best = null;
  for (let pos = digits.length - 1; pos >= digits.length - 2 && pos >= 0; pos--) {
    const original = digits[pos];
    const candidates = DIGIT_CONFUSION[original] || [];
    for (const candidate of candidates) {
      const testDigits = [...digits];
      testDigits[pos] = candidate;
      const testYear = parseInt(testDigits.join(''), 10);
      if (!isPlausible(testYear)) continue;

      const diff = Math.abs(testYear - currentYear);
      if (best === null || diff < best.diff) {
        best = { year: testYear, diff };
      }
    }
  }

  if (best !== null) {
    return String(best.year);
  }

  // Tidak ketemu kombinasi yang masuk akal -> clamp ke tahun sekarang
  // supaya tidak menyimpan tanggal yang jelas-jelas salah ke database.
  return String(currentYear);
}

module.exports = {
  normalizeText,
  normalizeWord,
  parseNominal,
  normalizeYear,
  // exported untuk keperluan testing / dipakai lineGrouper kalau perlu
  isLikelyWordToken,
  isLikelyNumericToken,
  KNOWN_OCR_FIXES,
  KNOWN_WORDS_WHITELIST,
};