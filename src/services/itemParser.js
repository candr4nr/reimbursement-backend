// src/services/itemParser.js
// Ekstraksi DAFTAR ITEM (nama + harga, opsional qty) dari hasil groupLines().
//
// Ini parser paling kompleks karena format struk sangat bervariasi:
//   - "Kopi Susu Aren        32000"          (nama + harga satu baris)
//   - "Kopi Susu Aren"                        (nama panjang, wrap ke baris
//     "32000"                                 berikutnya karena kolom sempit)
//   - "2  Kopi Susu Aren     15000   30000"  (qty + nama + harga satuan + total)
//   - "Kopi Susu Aren x2         30000"      (qty inline dalam nama)
//
// Strategi umum (TANPA hardcode per merchant):
//   1. Tentukan batas akhir daftar item = row TOTAL/SUBTOTAL pertama yang
//      ditemukan (item selalu muncul SEBELUM baris total pada struk).
//   2. Di dalam batas itu, buang row yang jelas BUKAN item (header toko,
//      tanggal, nomor struk, label kolom "QTY/HARGA", pesan footer, dst)
//      lewat NON_ITEM_REGEX.
//   3. Untuk tiap row sisa:
//        a. Pisahkan dulu marker qty inline ("x2"/"2x") dari teks SEBELUM
//           ekstraksi nominal, supaya digit di dalam marker tidak salah
//           dianggap bagian dari harga/qty kolom.
//        b. Cari SEMUA angka nominal di sisa teks itu — angka yang
//           langsung diikuti huruf (mis. "600ML", "85GR", "20S") TIDAK
//           dianggap nominal, karena itu satuan/ukuran produk, bukan
//           harga/qty.
//        c. 1 angka -> itu harga, sisa teks (setelah angka dibuang) -> nama.
//        d. >=2 angka -> angka PALING KANAN = harga (line total), angka
//           kecil (<=100) di posisi lain (biasanya paling kiri) -> qty.
//        e. 0 angka -> nama tanpa harga eksplisit ("wrap"), tunggu row
//           berikutnya. Baris wrap berturut-turut DIAKUMULASI jadi satu
//           nama (bukan saling menimpa) sampai maksimum
//           MAX_WRAP_LINES baris, lalu dipasangkan ke row harga
//           berikutnya (row yang isinya cuma angka).
//   4. Nama dibersihkan dari sisa qty marker dan dirapikan.

const { normalizeText, parseNominal } = require('./normalizer');

// ─── Regex non-item (row yang harus DIABAIKAN, bukan item) ───────────────

const NON_ITEM_REGEX = new RegExp(
  [
    'TOTAL', 'SUBTOTAL', 'GRAND\\s*TOTAL',
    'TAX', 'PPN', 'PAJAK', 'SERVICE\\s*CHARGE',
    'DISCOUNT', 'DISKON', 'PROMO',
    'CASH', 'TUNAI', 'CHANGE', 'KEMBALI', 'PEMBAYARAN', 'PAYMENT',
    'DATE', 'TANGGAL', 'TGL', 'TIME', 'JAM',
    'NO\\.?\\s*(STRUK|TRANSAKSI|FAKTUR|INVOICE|REF)',
    'RECEIPT', 'INVOICE', 'FAKTUR',
    'KASIR', 'CASHIER', 'OPERATOR',
    'TERIMA\\s*KASIH', 'THANK\\s*YOU', 'SELAMAT', 'WELCOME',
    'QTY', 'HARGA\\s*SATUAN', '^ITEM$', '^NAMA$',
    'NPWP', 'ALAMAT', 'TELP', 'PHONE',
    // Baris alamat/kontak (mis. "Jl. Sudirman No. 123") sering lolos jadi
    // "nama item + harga" palsu karena mengandung digit tanpa keyword
    // transaksi apa pun. Dikecualikan di sini, konsisten dengan
    // NON_STORE_REGEX di storeParser.js.
    'JL\\.?\\s', 'JALAN\\s', 'RT\\s*\\d', 'RW\\s*\\d',
    'KEC\\.?\\s', 'KECAMATAN', 'KAB\\.?\\s', 'KABUPATEN', 'KOTA\\s', 'PROVINSI',
    'KODE\\s*POS', 'KELURAHAN', 'DESA\\s',
    'TELEPON', '\\bHP\\b', '\\bWA\\b', 'WHATSAPP', 'FAX',
  ].join('|'),
  'i'
);

// Pola angka nominal. PENTING:
//   - lookbehind `(?<![A-Za-z0-9])` dan lookahead `(?![A-Za-z0-9])` memeriksa
//     karakter yang LANGSUNG menempel (tanpa spasi) di kedua sisi angka.
//   - Ini menolak angka yang menyatu dengan huruf sebagai satuan/ukuran
//     produk (mis. "600ML", "85GR", "20S") ATAU sebagai bagian kode
//     alfanumerik (mis. "A1234").
//   - TIDAK memakai `\s*` di lookahead (beda dari versi awal yang salah),
//     supaya angka yang dipisah SPASI dari kata berikutnya (mis. qty
//     kolom "2  Kopi Susu Aren") tetap dianggap token angka yang valid.
function makeNominalRegex() {
  return /(?<![A-Za-z0-9])(?:Rp\.?\s*)?\d[\d.,]*(?![A-Za-z0-9])/g;
}

// Marker qty inline dalam nama, mis. "Kopi Susu Aren x2" atau "2x Kopi Susu Aren".
// Diproses & DIBUANG dari teks SEBELUM ekstraksi nominal, supaya digit di
// dalam marker ("2" pada "x2") tidak ikut dianggap harga/qty kolom.
const QTY_INLINE_REGEX = /(?:^|\s)(\d{1,3})\s*[xX]\s*(?=\s|$)|(?:^|\s)[xX]\s*(\d{1,3})(?:\s|$)/;

const MIN_ITEM_NAME_LENGTH = 2;
const MAX_QTY_VALUE = 100;
const MAX_WRAP_LINES = 3; // batas akumulasi baris nama yang wrap tanpa harga

// ─── Util ──────────────────────────────────────────────────────────────────

/**
 * Pisahkan marker qty inline ("x2"/"2x") dari teks. Mengembalikan teks
 * bersih (tanpa marker) + nilai qty kalau ditemukan.
 */
function extractInlineQty(text) {
  const match = text.match(QTY_INLINE_REGEX);
  if (!match) return { text, inlineQty: null };

  const inlineQty = Number(match[1] || match[2]);
  const cleaned = text.replace(QTY_INLINE_REGEX, ' ').replace(/\s{2,}/g, ' ').trim();
  return { text: cleaned, inlineQty: Number.isFinite(inlineQty) ? inlineQty : null };
}

/**
 * Ekstrak semua kandidat angka nominal dalam sebuah string, beserta posisi
 * kemunculannya (index), supaya bisa dibedakan mana yang "paling kanan".
 * Angka yang diikuti huruf langsung (satuan produk) sudah dikecualikan
 * oleh regex-nya sendiri.
 */
function extractAllNominals(text) {
  const matches = [];
  let m;
  const regex = makeNominalRegex();
  while ((m = regex.exec(text)) !== null) {
    const value = parseNominal(m[0]);
    if (Number.isFinite(value)) {
      matches.push({ raw: m[0], value, index: m.index });
    }
  }
  return matches;
}

/**
 * Buang semua substring angka nominal dari teks, sisakan teks nama.
 */
function stripNominals(text, nominals) {
  let result = text;
  // Hapus dari belakang ke depan supaya index tidak bergeser
  const sorted = [...nominals].sort((a, b) => b.index - a.index);
  for (const n of sorted) {
    result = result.slice(0, n.index) + result.slice(n.index + n.raw.length);
  }
  return result;
}

/**
 * Bersihkan nama item: rapikan spasi berlebih, buang karakter pemisah
 * kolom sisa (mis. "-", "|" berulang). Qty inline sudah dipisah lebih
 * dulu oleh extractInlineQty(), jadi di sini tidak perlu tangani lagi.
 */
function cleanItemName(rawName) {
  return rawName
    .replace(/[-=_|]{2,}/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Apakah row ini kemungkinan besar BUKAN item (header/label/footer)?
 */
function isNonItemRow(text) {
  if (!text || text.trim().length === 0) return true;
  if (NON_ITEM_REGEX.test(text)) return true;
  return false;
}

/**
 * Apakah row ini "hanya angka" (harga saja, tanpa nama) — dipakai untuk
 * pairing nama yang wrap ke baris berikutnya.
 */
function isPriceOnlyRow(text, nominals) {
  const stripped = stripNominals(text, nominals).trim();
  return stripped.length === 0 || stripped.length < MIN_ITEM_NAME_LENGTH;
}

/**
 * Validasi dasar harga item: positif dan tidak absurd.
 */
function isPlausiblePrice(value) {
  return Number.isFinite(value) && value > 0 && value < 1_000_000_000;
}

// ─── Penentuan batas akhir daftar item ─────────────────────────────────────

const BOUNDARY_REGEX = /\b(TOTAL|SUBTOTAL)\b/i;

/**
 * Cari index row pertama yang menandai AKHIR daftar item (biasanya
 * SUBTOTAL atau TOTAL pertama kali muncul dari atas).
 */
function findItemsEndIndex(rows) {
  for (let i = 0; i < rows.length; i++) {
    if (BOUNDARY_REGEX.test(rows[i].text)) return i;
  }
  return rows.length;
}

// ─── Parser utama ──────────────────────────────────────────────────────────

/**
 * Ekstrak daftar item dari rows hasil groupLines().
 *
 * @param {Array<Row>} rows
 * @param {{startIndex?:number, endIndex?:number}} options
 *   startIndex/endIndex opsional — dipakai coordinateParser.js untuk
 *   membatasi area scan kalau storeParser/dateParser sudah tahu di mana
 *   header berakhir. Kalau tidak diberikan, dideteksi otomatis.
 * @returns {Array<{name:string, price:number, quantity:number|null, raw:string}>}
 */
function parseItems(rows, options = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return [];

  const endIndex = options.endIndex ?? findItemsEndIndex(rows);
  const startIndex = options.startIndex ?? 0;

  const items = [];
  // pendingName menampung nama yang belum dapat harga (bisa hasil akumulasi
  // beberapa baris wrap berturut-turut).
  let pendingName = null; // { nameParts: string[], inlineQty, rawParts: string[] }

  const resetPending = () => {
    pendingName = null;
  };

  for (let i = startIndex; i < endIndex; i++) {
    const row = rows[i];
    const rawText = normalizeText(row.text);

    if (isNonItemRow(rawText)) {
      // Label/header/footer di tengah daftar item -> nama yang sedang
      // ditunggu harganya dianggap gugur (kemungkinan bukan bagian item).
      resetPending();
      continue;
    }

    const { text: textNoQty, inlineQty } = extractInlineQty(rawText);
    const nominals = extractAllNominals(textNoQty);

    if (nominals.length === 0) {
      // Row murni nama (kemungkinan wrap dari nama panjang).
      const name = cleanItemName(textNoQty);
      if (name.length < MIN_ITEM_NAME_LENGTH) continue;

      if (pendingName && pendingName.nameParts.length < MAX_WRAP_LINES) {
        // Akumulasi ke nama yang sedang ditunggu, bukan menimpanya.
        pendingName.nameParts.push(name);
        pendingName.rawParts.push(rawText);
        if (inlineQty != null && pendingName.inlineQty == null) {
          pendingName.inlineQty = inlineQty;
        }
      } else {
        pendingName = {
          nameParts: [name],
          rawParts: [rawText],
          inlineQty,
        };
      }
      continue;
    }

    if (isPriceOnlyRow(textNoQty, nominals)) {
      // Row cuma angka -> ini harga untuk pendingName (kalau ada).
      const price = nominals[nominals.length - 1].value;
      if (pendingName && isPlausiblePrice(price)) {
        items.push({
          name: pendingName.nameParts.join(' '),
          price,
          quantity: pendingName.inlineQty,
          raw: [...pendingName.rawParts, rawText].join(' | '),
        });
      }
      resetPending();
      continue;
    }

    // Row punya nama DAN angka -> pairing langsung. pendingName sebelumnya
    // (kalau ada, belum dapat harga) dianggap gugur karena row ini sudah
    // jadi item lengkap yang berbeda.
    resetPending();

    const rightmost = nominals[nominals.length - 1];
    const price = rightmost.value;

    if (!isPlausiblePrice(price)) continue;

    // Kandidat qty: angka kecil (<=100) SELAIN yang dipakai sebagai harga
    let quantity = null;
    if (nominals.length >= 2) {
      const qtyCandidate = nominals.find((n) => n !== rightmost && n.value > 0 && n.value <= MAX_QTY_VALUE);
      if (qtyCandidate) quantity = qtyCandidate.value;
    }

    const nameRaw = stripNominals(textNoQty, nominals);
    const name = cleanItemName(nameRaw);

    if (name.length < MIN_ITEM_NAME_LENGTH) continue; // tidak ada nama valid, skip

    items.push({
      name,
      price,
      quantity: quantity ?? inlineQty ?? null,
      raw: rawText,
    });
  }

  return items;
}

module.exports = {
  parseItems,
  findItemsEndIndex,
  extractAllNominals,
  isNonItemRow,
};