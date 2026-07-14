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
// Filter "baris mana yang BUKAN nama toko" (NON_STORE_REGEX) memakai
// basis bersama dari nonDataRows.js — sama persis dengan yang dipakai
// itemParser.js & regexFallbackParser.js (rekomendasi #1). Kalau perlu
// menambah pola exclude baru yang relevan untuk SEMUA parser, ubah di
// nonDataRows.js, bukan di sini.
//
// Strategi (TANPA hardcode daftar nama toko):
//   0. PRIORITAS UTAMA: cari baris berlabel eksplisit ("Toko:", "Store:",
//      "Merchant:") di SELURUH dokumen (findExplicitStoreLabel), bukan
//      cuma area top rows. Kalau ketemu, langsung dipakai — heuristik di
//      bawah ini tidak dijalankan sama sekali. Lihat rekomendasi #6.
//   1. Kalau tidak ada label eksplisit, ambil beberapa row TERATAS
//      (getTopRows) sebagai area kandidat.
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
const { buildNonDataRegex } = require('./nonDataRows');

// ─── Konfigurasi ──────────────────────────────────────────────────────────

// Berapa row paling atas yang dianggap "area kandidat" nama toko.
const DEFAULT_TOP_ROWS = 6;

// Maksimum berapa row berturut-turut yang boleh digabung jadi satu nama
// toko (mencegah nama toko "menelan" baris alamat kalau filter meleset).
const MAX_NAME_LINES = 3;

const MIN_STORE_NAME_LENGTH = 2;

// Row yang jelas BUKAN bagian nama toko meski berada di blok atas struk.
// Basis pola diambil dari nonDataRows.js — SAMA PERSIS dengan yang dipakai
// itemParser.js & regexFallbackParser.js (lihat rekomendasi #1: satukan
// & perluas daftar exclude supaya ketiga parser tidak punya daftar
// independen yang bisa saling tidak sinkron). Tidak ada pola tambahan
// khusus toko di sini — semua kebutuhan storeParser sudah tercakup basis
// bersama (alamat, kontak, dokumen resmi, tanggal/waktu, kasir, sapaan,
// label transaksi).
const NON_STORE_REGEX = buildNonDataRegex();

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

// ─── Label eksplisit nama toko (rekomendasi #6) ────────────────────────────
//
// Kalau struk punya baris berlabel eksplisit ("Toko: ...", "Store: ...",
// "Merchant: ..."), itu jauh lebih bisa dipercaya dibanding heuristik
// "beberapa baris teratas" — karena heuristik itu bisa keliru kalau blok
// atas struk didahului logo/slogan/baris kosong yang tidak konsisten, atau
// kalau baris pertama yang lolos filter justru bukan nama toko. Label
// eksplisit sengaja dicari di SELURUH dokumen (bukan cuma area top rows),
// karena beberapa format struk meletakkannya di footer.
const EXPLICIT_LABEL_REGEX = /\b(?:TOKO|STORE|MERCHANT)\s*:\s*(.+)/i;

/**
 * Cari baris berlabel eksplisit nama toko di seluruh `rows`. Return objek
 * {name, raw, lineIndex} kalau ketemu (dan hasilnya cukup panjang untuk
 * dianggap valid), atau null kalau tidak ada.
 */
function findExplicitStoreLabel(rows) {
  for (let i = 0; i < rows.length; i++) {
    const text = (rows[i].text || '').trim();
    if (!text) continue;

    const match = text.match(EXPLICIT_LABEL_REGEX);
    if (!match) continue;

    const name = cleanStoreName(match[1]);
    if (name.length >= MIN_STORE_NAME_LENGTH) {
      return { name, raw: text, lineIndex: i };
    }
  }
  return null;
}

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

  // Prioritas utama (rekomendasi #6): baris berlabel eksplisit di mana saja
  // dalam dokumen. Kalau ketemu, langsung dipakai — tidak perlu lanjut ke
  // heuristik "baris teratas" sama sekali.
  const explicit = findExplicitStoreLabel(rows);
  if (explicit) {
    return {
      name: explicit.name,
      raw: explicit.raw,
      lineCount: 1,
      source: 'explicit_label',
      // Rekomendasi #1: laporkan index baris yang "diklaim" jadi nama toko,
      // supaya itemParser (lewat coordinateParser.js) bisa mengecualikannya
      // dari kandidat item secara berbasis posisi, bukan cuma kata kunci.
      lineIndices: [explicit.lineIndex],
    };
  }

  const candidateRows = getTopRows(rows, options.topRows ?? DEFAULT_TOP_ROWS);
  const maxNameLines = options.maxNameLines ?? MAX_NAME_LINES;

  const collected = [];
  const collectedIndices = [];

  // candidateRows = getTopRows(rows, n) = rows.slice(0, n), jadi index di
  // candidateRows SAMA dengan index di `rows` asli (selalu mulai dari 0).
  for (let idx = 0; idx < candidateRows.length; idx++) {
    const row = candidateRows[idx];
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
    collectedIndices.push(idx);
    if (collected.length >= maxNameLines) break;
  }

  if (collected.length === 0) return null;

  const name = cleanStoreName(collected.join(' '));
  if (name.length < MIN_STORE_NAME_LENGTH) return null;

  // Selain baris yang benar-benar terpakai jadi nama toko, storeParser di
  // titik ini SUDAH TAHU baris mana lagi di jendela top-rows yang jelas
  // "bukan nama toko" (alamat/telp/NPWP/kecamatan/dst, lewat isNonStoreRow
  // yang sama persis dipakai di atas) — walau berhenti akumulasi nama di
  // situ. Baris-baris itu tetap bagian dari blok header, bukan kandidat
  // item, jadi ikut dilaporkan supaya itemParser tidak salah membacanya
  // sebagai item palsu (mis. "Jakarta Selatan 1293" -> nama "Jakarta
  // Selatan" + harga 1293). Sengaja DIBATASI ke jendela top-rows yang sama
  // (kecil, dekat atas struk) supaya tidak berisiko menelan item asli yang
  // kebetulan ada di bawahnya.
  const headerNoiseIndices = [];
  for (let idx = 0; idx < candidateRows.length; idx++) {
    const text = (candidateRows[idx].text || '').trim();
    if (isNonStoreRow(text)) headerNoiseIndices.push(idx);
  }

  return {
    name,
    raw: collected.join(' | '),
    lineCount: collected.length,
    source: 'top_rows',
    lineIndices: [...new Set([...collectedIndices, ...headerNoiseIndices])],
  };
}

module.exports = {
  parseStore,
  isNonStoreRow,
  findExplicitStoreLabel,
};