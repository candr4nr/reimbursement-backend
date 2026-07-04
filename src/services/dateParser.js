// src/services/dateParser.js
// Ekstraksi TANGGAL dari hasil groupLines() (lihat lineGrouper.js).
//
// Strategi:
//   1. Cari row yang mengandung label tanggal ("DATE", "TANGGAL", "TGL").
//   2. Coba parse tanggal dari SISA teks row yang sama (kanan dari label).
//   3. Kalau row label tidak mengandung angka tanggal, cari row lain yang
//      Y-nya sejajar (label & value terpisah gara-gara threshold meleset).
//   4. Kalau masih gagal, scan SEMUA row untuk pola tanggal (tanpa label
//      eksplisit — banyak struk minimarket menaruh tanggal begitu saja).
//   5. Kalau parser koordinat gagal total, kembalikan null supaya
//      coordinateParser.js bisa fallback ke regexFallbackParser.

const {
  findRowByKeyword,
  findRowsNearY,
  getTokensRightOfX,
} = require('./lineGrouper');

const { normalizeYear } = require('./normalizer');

// ─── Konfigurasi ──────────────────────────────────────────────────────────

const LABEL_REGEX = /\b(DATE|TANGGAL|TGL)\b/i;

// Threshold Y untuk mencari row "sejajar" saat label & value terpisah row.
const Y_ALIGN_THRESHOLD = 15;

// Berbagai format tanggal yang umum muncul di struk Indonesia & internasional:
//   31/12/2026, 31-12-2026, 31.12.2026, 2026-12-31, 31 Des 2026, Dec 31 2026
const DATE_PATTERNS = [
  // DD/MM/YYYY atau DD-MM-YYYY atau DD.MM.YYYY
  {
    regex: /\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/,
    map: (m) => ({ day: m[1], month: m[2], year: m[3] }),
  },
  // YYYY-MM-DD atau YYYY/MM/DD
  {
    regex: /\b(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})\b/,
    map: (m) => ({ day: m[3], month: m[2], year: m[1] }),
  },
  // DD Mon YYYY (mis. 31 Des 2026 / 31 Dec 2026)
  {
    regex: /\b(\d{1,2})\s+(Jan|Feb|Mar|Apr|Mei|May|Jun|Jul|Agu|Aug|Sep|Okt|Oct|Nov|Des|Dec)[a-z]*\s+(\d{2,4})\b/i,
    map: (m) => ({ day: m[1], month: monthNameToNumber(m[2]), year: m[3] }),
  },
];

const MONTH_MAP = {
  jan: '01', feb: '02', mar: '03', apr: '04',
  mei: '05', may: '05', jun: '06', jul: '07',
  agu: '08', aug: '08', sep: '09',
  okt: '10', oct: '10', nov: '11', des: '12', dec: '12',
};

function monthNameToNumber(name) {
  const key = name.toLowerCase().slice(0, 3);
  return MONTH_MAP[key] || '01';
}

// ─── Ekstraksi tanggal dari sebuah string ─────────────────────────────────

/**
 * Coba cocokkan salah satu DATE_PATTERNS pada sebuah string.
 * @returns {{day:string, month:string, year:string}|null}
 */
function extractDateParts(text) {
  if (!text) return null;
  for (const pattern of DATE_PATTERNS) {
    const match = text.match(pattern.regex);
    if (match) return pattern.map(match);
  }
  return null;
}

/**
 * Bangun objek Date + string ISO dari day/month/year mentah, dengan
 * normalisasi tahun (mis. 2028 -> 2026 kalau melebihi tahun sekarang).
 */
function buildDateResult(parts, sourceText) {
  const day = String(parts.day).padStart(2, '0');
  const month = String(parts.month).padStart(2, '0');

  let year = String(parts.year);
  if (year.length === 2) year = `20${year}`;
  year = normalizeYear(year);

  const dayNum = Number(day);
  const monthNum = Number(month);
  const yearNum = Number(year);

  // Validasi dasar supaya tidak lolos tanggal absurd (mis. 45/99/2026)
  if (
    !Number.isFinite(dayNum) || dayNum < 1 || dayNum > 31 ||
    !Number.isFinite(monthNum) || monthNum < 1 || monthNum > 12 ||
    !Number.isFinite(yearNum)
  ) {
    return null;
  }

  const iso = `${year}-${month}-${day}`;

  return {
    raw: sourceText.trim(),
    day: dayNum,
    month: monthNum,
    year: yearNum,
    iso,
  };
}

// ─── Parser utama ──────────────────────────────────────────────────────────

/**
 * Ekstrak tanggal dari rows hasil groupLines().
 *
 * @param {Array<Row>} rows
 * @returns {{raw:string, day:number, month:number, year:number, iso:string}|null}
 */
function parseDate(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;

  // 1. Cari row berlabel
  const labelMatch = findRowByKeyword(rows, LABEL_REGEX);

  if (labelMatch) {
    const { row } = labelMatch;

    // 1a. Coba parse langsung dari sisa row yang sama
    const partsInRow = extractDateParts(row.text);
    if (partsInRow) {
      const result = buildDateResult(partsInRow, row.text);
      if (result) return result;
    }

    // 1b. Coba ambil dari token-token di kanan label (kalau formatnya
    // terpisah per-token, mis. label "TANGGAL" lalu token angka terpisah)
    const labelTokenEnd = getRightmostLabelTokenX(row, LABEL_REGEX);
    if (labelTokenEnd !== null) {
      const rightTokens = getTokensRightOfX(row, labelTokenEnd);
      const rightText = rightTokens.map((t) => t.text).join(' ');
      const partsRight = extractDateParts(rightText);
      if (partsRight) {
        const result = buildDateResult(partsRight, rightText);
        if (result) return result;
      }
    }

    // 1c. Label ada tapi value-nya di row lain yang sejajar Y
    const nearby = findRowsNearY(rows, row.y, Y_ALIGN_THRESHOLD)
      .filter((r) => r !== row);
    for (const r of nearby) {
      const parts = extractDateParts(r.text);
      if (parts) {
        const result = buildDateResult(parts, r.text);
        if (result) return result;
      }
    }
  }

  // 2. Tidak ada label eksplisit (atau label ada tapi value tak ketemu) —
  //    scan semua row untuk pola tanggal generik.
  for (const row of rows) {
    const parts = extractDateParts(row.text);
    if (parts) {
      const result = buildDateResult(parts, row.text);
      if (result) return result;
    }
  }

  // 3. Parser koordinat gagal total -> biar coordinateParser fallback ke regex
  return null;
}

/**
 * Cari X akhir dari token yang match LABEL_REGEX dalam sebuah row,
 * supaya getTokensRightOfX bisa dipakai untuk ambil value setelahnya.
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

module.exports = {
  parseDate,
  extractDateParts,
  buildDateResult,
};