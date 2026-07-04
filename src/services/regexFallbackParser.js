// src/services/regexFallbackParser.js
// Fallback murni regex — dipertahankan dari implementasi lama (ocrController.js
// versi sebelum refactor). Dipanggil coordinateParser.js HANYA untuk field yang
// gagal ditemukan parser koordinat (mis. lines kosong/tidak dikirim client lama,
// atau layout struk yang belum tertangani parser bounding-box).

const { parseNominal, normalizeYear } = require('./normalizer');

// ─── Tanggal ───────────────────────────────────────────────────────────
const parseTanggal = (text) => {
  const patternDMY = /(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/;
  const patternISO = /(\d{4})-(\d{2})-(\d{2})/;
  const patternWords =
    /(\d{1,2})\s+(Jan(?:uari?)?|Feb(?:ruari?)?|Mar(?:et)?|Apr(?:il)?|Mei|May|Jun(?:i|e)?|Jul(?:i|y)?|Agu(?:stus)?|Aug(?:ust)?|Sep(?:tember)?|Okt(?:ober)?|Oct(?:ober)?|Nov(?:ember)?|Des(?:ember)?|Dec(?:ember)?)\s+(\d{2,4})/i;
  const patternDMonthSlashY =
    /(\d{1,2})\s*[\/\-]\s*(Jan(?:uari?)?|Feb(?:ruari?)?|Mar(?:et)?|Apr(?:il)?|Mei|May|Jun(?:i|e)?|Jul(?:i|y)?|Agu(?:stus)?|Aug(?:ust)?|Sep(?:tember)?|Okt(?:ober)?|Oct(?:ober)?|Nov(?:ember)?|Des(?:ember)?|Dec(?:ember)?)\s*[\/\-]\s*(\d{2,4})/i;

  const monthMap = {
    jan: '01', januari: '01', january: '01',
    feb: '02', februari: '02', february: '02',
    mar: '03', maret: '03', march: '03',
    apr: '04', april: '04',
    mei: '05', may: '05',
    jun: '06', juni: '06', june: '06',
    jul: '07', juli: '07', july: '07',
    agu: '08', agustus: '08', aug: '08', august: '08',
    sep: '09', september: '09',
    okt: '10', oktober: '10', oct: '10', october: '10',
    nov: '11', november: '11',
    des: '12', desember: '12', dec: '12', december: '12',
  };

  let match;

  match = text.match(patternISO);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;

  match = text.match(patternWords);
  if (match) {
    const month = monthMap[match[2].toLowerCase()] || '01';
    const year = normalizeYear(match[3].length === 2 ? `20${match[3]}` : match[3]);
    const day = match[1].padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  match = text.match(patternDMonthSlashY);
  if (match) {
    const month = monthMap[match[2].toLowerCase()] || '01';
    const year = normalizeYear(match[3].length === 2 ? `20${match[3]}` : match[3]);
    const day = match[1].padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  match = text.match(patternDMY);
  if (match) {
    const day = match[1].padStart(2, '0');
    const month = match[2].padStart(2, '0');
    const year = normalizeYear(match[3].length === 2 ? `20${match[3]}` : match[3]);
    return `${year}-${month}-${day}`;
  }

  return null;
};

// ─── Items ─────────────────────────────────────────────────────────────
const parseItems = (lines) => {
  const items = [];

  const skipKeywords =
    /total|grand|subtotal|diskon|discount|pajak|tax|ppn|service|charge|cash|tunai|change|kembali|kembalian|bayar|payment|void|struk|nota|invoice|terima kasih|thank|member|poin|point|no\.|nomor|tanggal|date|time|jam|kasir|cashier|toko|store|address|alamat|telp|phone|fax|channel|order\s*number|rounding|qpon|coupon|download|feedback|customer\s*care|best\s*seller/i;

  const isPlausibleItemName = (name) => {
    const trimmed = name.trim();
    return trimmed.length >= 3 && /[a-zA-Z]{3,}/.test(trimmed);
  };

  const isNumericRow = (line) => {
    const tokens = line.split(/\s{2,}/).map((t) => t.trim()).filter(Boolean);
    if (tokens.length === 0) return false;
    return tokens.every((t) => /^[\d.,]+$/.test(t));
  };

  const isModifierLine = (line) => /^\+/.test(line.trim());

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.length < 3) continue;
    if (skipKeywords.test(trimmed)) continue;
    if (isModifierLine(trimmed)) continue;
    if (isNumericRow(trimmed)) continue;

    let match = trimmed.match(/^(.+?)\s{2,}(\d+)\s{2,}([\d.,]+)\s{2,}([\d.,]+)\s*$/);
    if (match && isPlausibleItemName(match[1])) {
      const qty = parseInt(match[2]) || 1;
      const hargaSatuan = parseNominal(match[3]);
      const subtotal = parseNominal(match[4]);
      if (hargaSatuan && subtotal) {
        items.push({ nama_item: match[1].trim(), qty, harga_satuan: hargaSatuan, subtotal });
        continue;
      }
    }

    match = trimmed.match(/^(.+?)\s{2,}([\d.,]+)\s*$/);
    const isShortNumber = match && /^\d{1,2}$/.test(match[2]);
    if (match && !isShortNumber && isPlausibleItemName(match[1])) {
      const subtotal = parseNominal(match[2]);
      if (subtotal && subtotal > 0 && subtotal < 100_000_000) {
        items.push({ nama_item: match[1].trim(), qty: 1, harga_satuan: subtotal, subtotal });
        continue;
      }
    }

    const trailingQtyMatch = trimmed.match(/\s{2,}(\d{1,2})\s*$/);
    const qtyFromNameRow = trailingQtyMatch ? parseInt(trailingQtyMatch[1]) : null;
    const namaItem = trailingQtyMatch
      ? trimmed.slice(0, trailingQtyMatch.index).trim()
      : trimmed;

    if (!isPlausibleItemName(namaItem)) continue;

    for (let j = i + 1; j <= Math.min(i + 3, lines.length - 1); j++) {
      const nextLine = lines[j].trim();
      if (!nextLine) continue;
      if (skipKeywords.test(nextLine)) break;
      if (isModifierLine(nextLine)) continue;
      if (!isNumericRow(nextLine)) break;

      const numericTokens = nextLine
        .split(/\s{2,}/)
        .map((t) => t.trim())
        .map(parseNominal)
        .filter((n) => n !== null);

      if (numericTokens.length >= 1) {
        const subtotal = numericTokens[numericTokens.length - 1];
        let qty = qtyFromNameRow;
        if (!qty) {
          qty = numericTokens.length === 3 && numericTokens[1] < 100 ? numericTokens[1] : 1;
        }
        const hargaSatuan = qtyFromNameRow && qty > 0
          ? Math.round((subtotal / qty) * 100) / 100
          : numericTokens[0] || subtotal;

        if (subtotal) {
          items.push({ nama_item: namaItem, qty, harga_satuan: hargaSatuan, subtotal });
        }
      }
      i = j;
      break;
    }
  }

  return items;
};

// ─── Store / total / subtotal / tax ────────────────────────────────────
const labelLineKeywords =
  /^(date|channel|order\s*number|no\.?|nomor|tanggal|time|jam|kasir|cashier|receipt|invoice|struk|nota)\s*:?\s*$/i;

function extractByKeyword(lines, keywordRegex) {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (keywordRegex.test(line)) {
      let numbers = line.match(/[\d.,]+/g);
      if ((!numbers || numbers.length === 0) && lines[i + 1]) {
        numbers = lines[i + 1].match(/[\d.,]+/g);
      }
      if (numbers && numbers.length > 0) {
        const parsed = parseNominal(numbers[numbers.length - 1]);
        if (parsed && parsed > 0) return parsed;
      }
    }
  }
  return null;
}

/**
 * @param {string[]} lines - raw_text yang sudah displit per baris & di-trim
 * @returns {{namaToko: string|null, tanggal: string|null, total: number|null, items: Array}}
 */
function parseWithRegex(lines) {
  // Nama toko: baris non-kosong pertama di bagian atas struk
  let namaToko = null;
  for (let i = 0; i < Math.min(10, lines.length); i++) {
    const line = lines[i];
    if (/^[\d\s\-.\/*=]+$/.test(line)) continue;
    if (labelLineKeywords.test(line)) continue;
    if (line.length < 3) continue;
    namaToko = line;
    break;
  }

  // Tanggal: scan semua baris, tolak kalau OCR salah baca jadi masa depan
  let tanggal = null;
  for (const line of lines) {
    const t = parseTanggal(line);
    if (t && new Date(t) <= new Date()) {
      tanggal = t;
    }
  }

  const subtotalValue = extractByKeyword(lines, /\bsubtotal\b/i);
  const taxValue = extractByKeyword(lines, /\b(tax|pajak|ppn)\b/i);

  let total = null;
  const totalKeywords =
    /\b(grand\s*total|total\s*bayar|total\s*amount|total\s*harga|total\s*pembayaran|total)\b/i;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (totalKeywords.test(line)) {
      let numbers = line.match(/[\d.,]+/g);
      if ((!numbers || numbers.length === 0) && lines[i + 1]) {
        numbers = lines[i + 1].match(/[\d.,]+/g);
      }
      if (numbers && numbers.length > 0) {
        const parsed = parseNominal(numbers[numbers.length - 1]);
        if (parsed && parsed > 0) {
          total = parsed;
          break;
        }
      }
    }
  }

  // Validasi silang: kalau total < subtotal, OCR kemungkinan salah baca —
  // pakai subtotal + tax yang masing-masing sudah lolos parseNominal terpisah.
  if (subtotalValue) {
    const computedTotal = subtotalValue + (taxValue || 0);
    if (total === null || total < subtotalValue) {
      total = computedTotal;
    }
  }

  const items = parseItems(lines);

  return { namaToko, tanggal, total, items };
}

module.exports = { parseWithRegex, parseTanggal, parseItems };