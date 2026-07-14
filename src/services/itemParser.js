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
//           harga/qty. Baris yang mengandung pola kode/ukuran produk
//           (mis. "30 X 40 X 50 CM", "DB012-XYZ") malah dilewati SELURUH
//           barisnya dari ekstraksi nominal (lihat hasProductCodePattern),
//           karena angka di dalam kode semacam itu bisa tidak menempel
//           huruf secara langsung (dipisah spasi/strip) sehingga lolos
//           dari filter per-token biasa.
//        c. 1 angka -> itu harga, sisa teks (setelah angka dibuang) -> nama.
//        d. >=2 angka -> angka PALING KANAN = harga (line total), angka
//           kecil (<=100) di posisi lain (biasanya paling kiri) -> qty.
//        e. 0 angka -> nama tanpa harga eksplisit ("wrap"), tunggu row
//           berikutnya. Baris wrap berturut-turut DIAKUMULASI jadi satu
//           nama (bukan saling menimpa) sampai maksimum
//           MAX_WRAP_LINES baris, lalu dipasangkan ke row harga
//           berikutnya (row yang isinya cuma angka).
//   4. Nama dibersihkan dari sisa qty marker dan dirapikan.

const { normalizeText, parseNominal, buildNominalTokenRegex } = require('./normalizer');
const { buildNonDataRegex } = require('./nonDataRows');

// ─── Regex non-item (row yang harus DIABAIKAN, bukan item) ───────────────

// Basis pola diambil dari nonDataRows.js (sama persis dipakai storeParser.js
// & regexFallbackParser.js), ditambah beberapa label kolom yang HANYA
// relevan untuk konteks daftar item (bukan area umum seperti alamat/toko).
const NON_ITEM_REGEX = buildNonDataRegex([
  'SERVICE\\s*CHARGE',
  'PEMBAYARAN',
  'HARGA\\s*SATUAN',
  '^ITEM$',
  '^NAMA$',
  '\\bALAMAT\\b',
]);

// Pola angka nominal. Sumbernya sekarang di normalizer.js (buildNominalTokenRegex),
// dipakai bersama regexFallbackParser.js — sudah mendukung pemisah ribuan
// berupa titik, koma, MAUPUN satu spasi (mis. "14 000" -> satu token nominal
// "14 000", bukan dua token terpisah "14" dan "000"). Detail lookbehind/
// lookahead (menolak angka menyatu dengan huruf, mis. "600ML") dan alasan
// kenapa satu spasi aman dipakai di sini dijelaskan di normalizer.js.
function makeNominalRegex() {
  return buildNominalTokenRegex();
}

// Marker qty inline dalam nama, mis. "Kopi Susu Aren x2" atau "2x Kopi Susu Aren".
// Diproses & DIBUANG dari teks SEBELUM ekstraksi nominal, supaya digit di
// dalam marker ("2" pada "x2") tidak ikut dianggap harga/qty kolom.
const QTY_INLINE_REGEX = /(?:^|\s)(\d{1,3})\s*[xX]\s*(?=\s|$)|(?:^|\s)[xX]\s*(\d{1,3})(?:\s|$)/;

const MIN_ITEM_NAME_LENGTH = 2;
const MAX_QTY_VALUE = 100;
const MAX_WRAP_LINES = 3; // batas akumulasi baris nama yang wrap tanpa harga

// ─── Deteksi baris kode produk / ukuran (rekomendasi #5) ──────────────────
//
// buildNominalTokenRegex() (normalizer.js) hanya menolak angka yang
// MENEMPEL LANGSUNG ke huruf (mis. "600ML"). Itu tidak cukup untuk kode
// ukuran/produk yang angkanya dipisah spasi/simbol dari huruf di
// sekitarnya, mis. "30 X 40 X 50 CM" (angka "30"/"40"/"50" tidak menempel
// huruf secara langsung, jadi masih lolos jadi nominal). Baris seperti
// ini harus dianggap "bukan kandidat item numerik" SECARA UTUH, bukan
// cuma membuang token angkanya satu-satu — supaya sisa angka acak di
// baris yang sama (kalau ada) tidak salah dipasangkan jadi harga.

// Pola ukuran/dimensi: MINIMAL 3 angka berturut yang dipisah x/*, mis.
// "30x40x50", "30 X 40 X 50". Sengaja disyaratkan >=3 angka (bukan 2)
// supaya tidak bentrok dengan pola qty x harga satuan ("2 x 30000") yang
// cuma 2 angka.
const DIMENSION_CODE_REGEX = /\d+\s*[xX*]\s*\d+\s*[xX*]\s*\d+/;

// Pola kode produk alfanumerik dengan strip, mis. "DB012-XYZ", "SKU-4521-A".
// Syarat dalam SATU token (tanpa spasi): ada strip, DAN minimal satu huruf,
// DAN minimal satu digit — supaya nama item biasa yang kebetulan pakai
// strip tanpa digit (mis. "Kopi-Susu") TIDAK ikut kena.
const ALNUM_CODE_TOKEN_REGEX = /\b(?=[A-Za-z0-9-]*[A-Za-z])(?=[A-Za-z0-9-]*\d)[A-Za-z0-9]+-[A-Za-z0-9-]*\b/;

/**
 * Apakah baris ini mengandung pola kode produk/ukuran? Kalau ya, SELURUH
 * baris ini bukan kandidat sumber harga/qty numerik — diperlakukan sama
 * seperti baris nama tanpa angka (bisa jadi bagian wrap nama item),
 * bukan diproses lewat extractAllNominals().
 */
function hasProductCodePattern(text) {
  return DIMENSION_CODE_REGEX.test(text) || ALNUM_CODE_TOKEN_REGEX.test(text);
}

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
 * @param {{startIndex?:number, endIndex?:number, excludeIndices?:Iterable<number>}} options
 *   startIndex/endIndex opsional — dipakai coordinateParser.js untuk
 *   membatasi area scan kalau storeParser/dateParser sudah tahu di mana
 *   header berakhir. Kalau tidak diberikan, dideteksi otomatis.
 *   excludeIndices opsional — index baris (relatif ke `rows`) yang SUDAH
 *   "diklaim" parser lain (mis. storeParser.claimedIndices, dateParser
 *   match index). Baris ini dilewati SELALU, walau lolos dari
 *   NON_ITEM_REGEX — supaya nama toko/tanggal yang kebetulan tidak
 *   mengandung keyword apa pun (mis. cuma "GEDUNG SENTRA 2") tidak jadi
 *   item palsu. Lihat rekomendasi #1: exclude berbasis posisi, bukan
 *   cuma kata kunci.
 * @returns {Array<{name:string, price:number, quantity:number|null, raw:string}>}
 */
function parseItems(rows, options = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return [];

  const endIndex = options.endIndex ?? findItemsEndIndex(rows);
  const startIndex = options.startIndex ?? 0;
  const excludeIndices = new Set(options.excludeIndices ?? []);

  const items = [];
  // pendingName menampung nama yang belum dapat harga (bisa hasil akumulasi
  // beberapa baris wrap berturut-turut).
  let pendingName = null; // { nameParts: string[], inlineQty, rawParts: string[] }

  const resetPending = () => {
    pendingName = null;
  };

  for (let i = startIndex; i < endIndex; i++) {
    if (excludeIndices.has(i)) {
      // Baris ini sudah dipastikan milik field lain (nama toko/tanggal)
      // oleh coordinateParser.js — skip tanpa syarat, jangan andalkan
      // regex kata kunci yang bisa meleset.
      resetPending();
      continue;
    }

    const row = rows[i];
    const rawText = normalizeText(row.text);

    if (isNonItemRow(rawText)) {
      // Label/header/footer di tengah daftar item -> nama yang sedang
      // ditunggu harganya dianggap gugur (kemungkinan bukan bagian item).
      resetPending();
      continue;
    }

    const { text: textNoQty, inlineQty } = extractInlineQty(rawText);

    // Rekomendasi #5: baris kode produk/ukuran (mis. "30 X 40 X 50 CM",
    // "DB012-XYZ") TIDAK boleh dipecah per-token angka — seluruh baris
    // langsung dianggap bukan kandidat numerik, diperlakukan sama seperti
    // baris nama tanpa angka (bisa diakumulasi sebagai wrap ke pendingName).
    // Dicek dari rawText (bukan textNoQty) supaya pola "x"/"*" pada kode
    // ukuran tidak keburu "dimakan" oleh extractInlineQty().
    if (hasProductCodePattern(rawText)) {
      const codeName = cleanItemName(textNoQty);
      if (codeName.length >= MIN_ITEM_NAME_LENGTH) {
        if (pendingName && pendingName.nameParts.length < MAX_WRAP_LINES) {
          pendingName.nameParts.push(codeName);
          pendingName.rawParts.push(rawText);
        } else {
          pendingName = { nameParts: [codeName], rawParts: [rawText], inlineQty: null };
        }
      }
      continue;
    }

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
  hasProductCodePattern,
};