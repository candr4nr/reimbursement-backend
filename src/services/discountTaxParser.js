// src/services/discountTaxParser.js
// Ekstraksi nominal DISKON dan PAJAK/PPN dari hasil groupLines().
//
// Strategi MIRIP totalParser.js: cari baris berlabel, ambil angka nominal
// di kanan label pada row yang sama, atau di row lain yang Y-nya sejajar.
// Dipisah jadi modul sendiri (bukan digabung ke totalParser.js) karena
// semantiknya beda — dua komponen terpisah yang MEMPENGARUHI selisih
// antara subtotal dan total, bukan "nominal akhir" itu sendiri.
//
// Kenapa ini penting: SEBELUM ada modul ini, itemParser.js & storeParser.js
// SUDAH mengenali baris "DISKON"/"PPN" sebagai baris yang harus di-exclude
// dari daftar item (lihat nonDataRows.js), tapi nilainya dibuang begitu
// saja alih-alih diekstrak. Akibatnya computeConfidence() di
// coordinateParser.js salah menuduh hasil item "meleset dari total" pada
// struk yang sebenarnya sudah benar — wajar kalau ada diskon/pajak,
// sum(items) MEMANG tidak akan persis sama dengan total.

const { findRowsByKeyword, findRowsNearY, getTokensRightOfX } = require('./lineGrouper');
const { parseNominal, buildNominalTokenRegex } = require('./normalizer');

const DISKON_REGEX = /\b(DISKON|DISCOUNT|DISC|POTONGAN|PROMO)\b/i;

// Pola persentase, mis. "10%", "10 %". Dipakai KHUSUS untuk diskon —
// banyak struk Indonesia CUMA menulis persentase potongan ("Diskon 10%")
// TANPA nominal rupiah eksplisit sama sekali (beda dari baris pajak yang
// hampir selalu punya nominal Rp di baris yang sama), jadi
// findNominalByLabel() akan gagal total (return null) untuk baris seperti
// itu kalau tidak ada fallback ini. Dibatasi 1-3 digit sebelum '%' supaya
// tidak salah tangkap angka lain yang kebetulan diikuti karakter lain.
const DISKON_PERCENT_REGEX = /(\d{1,3}(?:[.,]\d+)?)\s*%/;

// Field ini secara historis dinamai "pajak", tapi cakupannya SEKARANG
// mencakup semua komponen yang DITAMBAHKAN ke subtotal untuk sampai ke
// total — bukan cuma pajak murni. Alasannya murni aritmatika: PPN, PB1
// (pajak restoran daerah), dan biaya layanan (service charge) SAMA-SAMA
// nominal tambahan di atas subtotal, jadi computeConfidence() di
// coordinateParser.js butuh totalnya digabung supaya rekonsiliasi
// sum(items) - diskon + pajak ≈ total tetap benar TANPA perlu field ke-4
// terpisah. Nama field TIDAK diganti (tetap "pajak") supaya tidak breaking
// change di ocrController.js/llmFallbackParser.js/skema DB yang sudah ada
// — kalau nanti butuh breakdown pajak vs service charge terpisah di UI,
// itu perubahan skema yang lebih besar, bukan sekadar nambah regex.
//
// Match: PPN/PAJAK/PB1 (pajak restoran daerah) + TAX/VAT (istilah asing)
// + SVC CHRG/SERVICE CHARGE/SERVICE/SC (biaya layanan, bukan pajak tapi
// diperlakukan sama secara aritmatika).
const PAJAK_REGEX = /\b(PPN|PAJAK|PB\s*1|TAX|VAT|SVC\s*CHRG|SERVICE\s*CHARGE|SERVICE|SC)\b/i;

// Frasa yang menandakan pajak/PPN di baris ini cuma KETERANGAN "sudah
// termasuk" (mis. "Total (sudah termasuk PPN)"), BUKAN baris nominal pajak
// terpisah yang perlu dikurangkan/ditambahkan manual — kalau sudah
// termasuk di harga item, jangan double-count.
const INCLUSIVE_QUALIFIER_REGEX = /\b(SUDAH\s*)?TERMASUK\b|\bINCL\.?\b|\bINCLUDED?\b/i;

const Y_ALIGN_THRESHOLD = 15;

function extractRightmostNominal(text) {
  if (!text) return null;
  const matches = text.match(buildNominalTokenRegex());
  if (!matches || matches.length === 0) return null;
  const value = parseNominal(matches[matches.length - 1]);
  return Number.isFinite(value) ? value : null;
}

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

function extractValueForLabelRow(row, rows, labelRegex) {
  const labelEndX = getRightmostLabelTokenX(row, labelRegex);
  if (labelEndX !== null) {
    const rightTokens = getTokensRightOfX(row, labelEndX);
    const rightText = rightTokens.map((t) => t.text).join(' ');
    const value = extractRightmostNominal(rightText);
    if (value !== null) return { raw: rightText.trim() || row.text, value };
  }

  const valueFromRow = extractRightmostNominal(row.text);
  if (valueFromRow !== null) return { raw: row.text, value: valueFromRow };

  const nearby = findRowsNearY(rows, row.y, Y_ALIGN_THRESHOLD).filter((r) => r !== row);
  for (const r of nearby) {
    const value = extractRightmostNominal(r.text);
    if (value !== null) return { raw: r.text, value };
  }
  return null;
}

/**
 * @param {Array<Row>} rows
 * @param {RegExp} labelRegex
 * @param {boolean} skipInclusiveQualifier - kalau true, baris yang ada
 *   embel-embel "(sudah) termasuk/incl/included" DI MANA PUN di baris itu
 *   (sebelum ATAU sesudah label — urutannya tidak konsisten antar struk,
 *   mis. "PPN @11% included in total" vs "Total (termasuk PPN)") dilewati,
 *   karena itu keterangan bahwa pajak SUDAH ada di dalam harga/total, jadi
 *   tidak boleh dijumlahkan lagi sebagai komponen tambahan. Dipakai khusus
 *   untuk PAJAK_REGEX.
 * @returns {{raw:string, value:number}|null}
 */
function findNominalByLabel(rows, labelRegex, skipInclusiveQualifier) {
  const candidates = findRowsByKeyword(rows, labelRegex);

  // Cari dari BAWAH ke ATAS (bukan urutan baca normal atas-ke-bawah).
  // Alasan: baris ringkasan diskon/pajak (yang kita cari di sini) SELALU
  // ada di blok ringkasan dekat TOTAL, yaitu di BAGIAN BAWAH struk, SETELAH
  // seluruh daftar item. Tapi label yang sama (mis. "Disc") sering juga
  // muncul PER-ITEM, diselipkan di antara baris item satu-satu (mis.
  // "Disc -1.250" tepat di bawah tiap item yang dapat potongan) — itu
  // muncul lebih AWAL di `rows` dibanding baris ringkasan. Kalau dicari
  // dari atas, nominal per-item yang pertama ketemu itu akan salah diambil
  // sebagai "nominal diskon struk", padahal itu cuma potongan SATU item,
  // bukan total diskon keseluruhan. Cari dari bawah memastikan baris
  // ringkasan (paling dekat ke TOTAL) yang diprioritaskan.
  for (let i = candidates.length - 1; i >= 0; i--) {
    const { row } = candidates[i];
    if (skipInclusiveQualifier && INCLUSIVE_QUALIFIER_REGEX.test(row.text)) continue;
    const result = extractValueForLabelRow(row, rows, labelRegex);
    if (result && Number.isFinite(result.value) && result.value >= 0) return result;
  }
  return null;
}

/**
 * Cari persentase diskon dari baris berlabel DISKON, dipakai HANYA sebagai
 * fallback kalau tidak ada nominal absolut yang ketemu sama sekali.
 * @returns {number|null} persentase (0-100), atau null kalau tidak ketemu.
 */
function findDiscountPercentValue(rows) {
  const candidates = findRowsByKeyword(rows, DISKON_REGEX);
  for (let i = candidates.length - 1; i >= 0; i--) {
    const { row } = candidates[i];
    const match = row.text.match(DISKON_PERCENT_REGEX);
    if (match) {
      const pct = parseFloat(match[1].replace(',', '.'));
      if (Number.isFinite(pct) && pct > 0 && pct <= 100) return pct;
    }
  }
  return null;
}

/**
 * Ekstrak nominal DISKON dan PAJAK dari rows hasil groupLines().
 * Return null (bukan 0) untuk field yang tidak ketemu sama sekali —
 * caller (coordinateParser.js) yang memutuskan cara memperlakukan "tidak
 * ketemu" (biasanya dianggap 0 saat dipakai untuk hitungan selisih total).
 *
 * @param {Array<Row>} rows
 * @param {number|null} itemsSubtotal - jumlah subtotal semua item SEBELUM
 *   diskon/pajak (mis. sum(items[].subtotal) dari itemParser/regexFallback).
 *   Dipakai HANYA sebagai fallback terakhir untuk diskon: kalau tidak ada
 *   baris nominal diskon eksplisit yang ketemu, tapi ada baris "Diskon 10%"
 *   (persentase saja, tanpa nominal rupiah — sangat umum di struk retail
 *   Indonesia), nominalnya dihitung dari persentase * itemsSubtotal.
 *   Opsional — kalau tidak diberikan (mis. dipanggil sebelum item selesai
 *   diparse), fallback ini dilewati dan diskon tetap null kalau baris
 *   nominal eksplisit tidak ketemu.
 * @returns {{diskon:number|null, pajak:number|null}}
 */
function parseDiscountAndTax(rows, itemsSubtotal = null) {
  if (!Array.isArray(rows) || rows.length === 0) return { diskon: null, pajak: null };

  const diskonResult = findNominalByLabel(rows, DISKON_REGEX, false);
  const pajakResult = findNominalByLabel(rows, PAJAK_REGEX, true);

  let diskon = diskonResult ? diskonResult.value : null;

  if (diskon === null && Number.isFinite(itemsSubtotal) && itemsSubtotal > 0) {
    const pct = findDiscountPercentValue(rows);
    if (pct !== null) {
      diskon = Math.round((itemsSubtotal * pct) / 100);
    }
  }

  return {
    diskon,
    pajak: pajakResult ? pajakResult.value : null,
  };
}

module.exports = {
  parseDiscountAndTax,
  // Diekspor supaya llmFallbackParser.js bisa memakai pola YANG SAMA untuk
  // membuang defensif baris "Diskon"/"Pajak" yang kadang tetap ikut
  // nyempil di items[] hasil LLM walau SYSTEM_PROMPT sudah melarangnya —
  // lihat komentar NON_ITEM_NAME_REGEX di llmFallbackParser.js.
  DISKON_REGEX,
  PAJAK_REGEX,
};