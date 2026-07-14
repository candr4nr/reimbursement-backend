// src/services/coordinateParser.js
// Orchestrator utama parser struk. Ini satu-satunya entry point yang
// dipanggil ocrController.js — controller TIDAK boleh memanggil
// storeParser/dateParser/totalParser/itemParser/regexFallbackParser
// secara langsung, supaya seluruh logika "parser koordinat dulu, regex
// belakangan" terkumpul di satu tempat dan mudah diuji.
//
// Alur per field (store / tanggal / total / items):
//   1. Coba parser BERBASIS KOORDINAT (storeParser/dateParser/totalParser/
//      itemParser) di atas hasil groupLines().
//   2. Kalau field itu gagal ditemukan (null / array kosong), field itu
//      SAJA diambil dari hasil regexFallbackParser.parseWithRegex().
//   3. regexFallbackParser hanya dijalankan SEKALI (lazy, di-cache) kalau
//      memang ada minimal satu field yang butuh fallback — supaya struk
//      yang sepenuhnya berhasil lewat parser koordinat tidak menjalankan
//      regex sama sekali.
//
// Bentuk output akhir DISERAGAMKAN ke skema yang sama dipakai
// regexFallbackParser (namaToko, tanggal, total, items[{nama_item, qty,
// harga_satuan, subtotal}]) supaya controller & lapisan database tidak
// perlu tahu field itu berasal dari parser koordinat atau regex.

const { groupLines, groupLinesFromRawText, rowsToPlainLines } = require('./lineGrouper');
const { parseStore } = require('./storeParser');
const { parseDate } = require('./dateParser');
const { parseTotal } = require('./totalParser');
const { parseItems: parseItemsCoordinate } = require('./itemParser');
const { parseDiscountAndTax } = require('./discountTaxParser');
const { parseWithRegex } = require('./regexFallbackParser');
const { extractWithLlm } = require('./llmFallbackParser');

// Toleransi selisih antara jumlah subtotal semua item vs `total` struk,
// sebelum dianggap "item kemungkinan salah baca" (bisa item palsu ikut
// terhitung, atau item asli hilang/salah kolom). 15% cukup longgar untuk
// menoleransi pembulatan/service charge/ongkos kirim yang belum
// diperhitungkan itemParser, tapi cukup ketat untuk menangkap kasus
// seperti 3 contoh nyata sebelumnya (item palsu bikin subtotal meleset
// jauh dari total asli).
const ITEMS_TOTAL_MISMATCH_TOLERANCE = 0.15;

/**
 * Bangun `rows` (logical row hasil groupLines) dari payload OCR.
 * Prioritas: pakai `lines` (bounding box) kalau ada & tidak kosong.
 * Kalau tidak ada (client lama / fallback), bangun dari `rawText` per baris.
 */
function buildRows({ rawText, lines }) {
  if (Array.isArray(lines) && lines.length > 0) {
    return groupLines(lines);
  }
  return groupLinesFromRawText(rawText);
}

/**
 * Bangun array of string untuk regexFallbackParser. Prioritas pakai
 * rawText asli (sesuai kontrak regexFallbackParser: "raw_text yang sudah
 * displit per baris & di-trim"), supaya layout aslinya tidak terdistorsi
 * oleh estimasi spasi kolom dari groupLines(). Kalau rawText tidak ada,
 * turunkan dari rows (fallback dari fallback).
 */
function buildPlainLines({ rawText }, rows) {
  if (typeof rawText === 'string' && rawText.trim().length > 0) {
    return rawText
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  }
  return rowsToPlainLines(rows);
}

/**
 * Ubah hasil itemParser (coordinate) ke skema seragam
 * {nama_item, qty, harga_satuan, subtotal} yang sama dengan
 * regexFallbackParser.parseItems(), supaya konsumen (controller/DB)
 * tidak perlu tahu asal datanya.
 */
function normalizeCoordinateItems(items) {
  return items.map((item) => {
    const qty = item.quantity ?? 1;
    const subtotal = item.price;
    // Kalau ada qty > 1 dan item.price adalah harga TOTAL baris (bukan
    // harga satuan), turunkan harga satuan dengan pembagian — konsisten
    // dengan cara regexFallbackParser menghitung harga_satuan.
    const hargaSatuan = qty > 1 ? Math.round((subtotal / qty) * 100) / 100 : subtotal;
    return {
      nama_item: item.name,
      qty,
      harga_satuan: hargaSatuan,
      subtotal,
    };
  });
}

/**
 * Suntikkan diskon & pajak sebagai BARIS TAMBAHAN di `items[]` (bukan cuma
 * field terpisah di level atas), supaya sum(items[].subtotal) SELALU sama
 * dengan `total` pada struk yang punya diskon/pajak eksplisit — konsumen
 * (mis. rekap pengeluaran, reimbursement) yang cuma men-jumlah daftar item
 * tidak akan dapat angka yang meleset dari nominal yang benar-benar
 * dibayar.
 *
 * - Diskon dimasukkan sebagai nominal NEGATIF (mengurangi jumlah).
 * - Pajak/service charge dimasukkan sebagai nominal POSITIF (menambah
 *   jumlah) — field "pajak" di sini sudah gabungan PPN/PB1/service charge,
 *   lihat catatan di discountTaxParser.js.
 * - Kalau `items` kosong (tidak ada item yang berhasil terbaca sama
 *   sekali), JANGAN suntikkan apa pun — baris diskon/pajak tanpa item
 *   nyata di atasnya tidak ada gunanya dan bisa bikin `items` kelihatan
 *   "ada isinya" padahal sebenarnya parsing item gagal total.
 *
 * @param {Array<{nama_item:string, qty:number, harga_satuan:number, subtotal:number}>} items
 * @param {number|null} diskon
 * @param {number|null} pajak
 * @returns {Array<{nama_item:string, qty:number, harga_satuan:number, subtotal:number}>}
 */
function appendDiscountTaxItems(items, diskon, pajak) {
  if (!Array.isArray(items) || items.length === 0) return items;

  const extra = [];
  const diskonValue = Number(diskon);
  const pajakValue = Number(pajak);

  if (Number.isFinite(diskonValue) && diskonValue > 0) {
    extra.push({
      nama_item: 'Diskon',
      qty: 1,
      harga_satuan: -diskonValue,
      subtotal: -diskonValue,
    });
  }

  if (Number.isFinite(pajakValue) && pajakValue > 0) {
    extra.push({
      nama_item: 'Pajak/Biaya Layanan',
      qty: 1,
      harga_satuan: pajakValue,
      subtotal: pajakValue,
    });
  }

  return extra.length > 0 ? [...items, ...extra] : items;
}

/**
 * Parse hasil OCR (raw_text + lines) menjadi data struk siap simpan.
 *
 * @param {{rawText: string, lines: Array}} ocrPayload - sesuai struktur
 *   JSON yang dikirim Flutter (lihat brief): { raw_text, lines }.
 *   Terima juga bentuk camelCase (rawText/lines) atau snake_case
 *   (raw_text/lines) supaya tidak tergantung konvensi body-parser.
 * @returns {{
 *   namaToko: string|null,
 *   tanggal: string|null,
 *   total: number|null,
 *   items: Array<{nama_item:string, qty:number, harga_satuan:number, subtotal:number}>,
 *   meta: { source: { namaToko:string, tanggal:string, total:string, items:string } }
 * }}
 */
function parseReceipt(ocrPayload = {}) {
  const rawText = ocrPayload.rawText ?? ocrPayload.raw_text ?? '';
  const lines = ocrPayload.lines ?? [];

  const rows = buildRows({ rawText, lines });

  // ── 1. Coba parser koordinat untuk semua field ───────────────────────
  const storeResult = parseStore(rows);
  const dateResult = parseDate(rows);
  const totalResult = parseTotal(rows);

  // Rekomendasi #1: baris yang sudah "diklaim" storeParser/dateParser/
  // totalParser dikecualikan dari kandidat item secara BERBASIS POSISI
  // (index di `rows`), bukan cuma kata kunci — supaya baris seperti
  // alamat/header/label total yang kebetulan tidak mengandung keyword apa
  // pun (mis. "Gedung AIA Central, Lantai 30") tidak ikut kebaca sebagai
  // item palsu oleh itemParser.
  const excludeIndices = new Set([
    ...(storeResult?.lineIndices ?? []),
    ...(dateResult?.lineIndices ?? []),
    ...(totalResult?.lineIndices ?? []),
  ]);
  const coordinateItems = parseItemsCoordinate(rows, { excludeIndices });

  const source = {
    namaToko: storeResult ? 'coordinate' : null,
    tanggal: dateResult ? 'coordinate' : null,
    total: totalResult ? 'coordinate' : null,
    items: coordinateItems.length > 0 ? 'coordinate' : null,
  };

  // ── 2. Tentukan field mana saja yang butuh fallback regex ────────────
  const needsFallback =
    !storeResult || !dateResult || !totalResult || coordinateItems.length === 0;

  // regexFallbackParser hanya dijalankan kalau BENAR-BENAR dibutuhkan,
  // dan cuma sekali (hasilnya dipakai untuk field manapun yang perlu).
  let regexResult = null;
  if (needsFallback) {
    const plainLines = buildPlainLines({ rawText }, rows);
    regexResult = parseWithRegex(plainLines);
  }

  // ── 3. Susun hasil akhir, field per field ─────────────────────────────
  const namaToko = storeResult
    ? storeResult.name
    : regexResult?.namaToko ?? null;
  if (!storeResult && regexResult?.namaToko) source.namaToko = 'regex';

  const tanggal = dateResult
    ? dateResult.iso
    : regexResult?.tanggal ?? null;
  if (!dateResult && regexResult?.tanggal) source.tanggal = 'regex';

  const total = totalResult
    ? totalResult.value
    : regexResult?.total ?? null;
  if (!totalResult && regexResult?.total) source.total = 'regex';

  let items;
  if (coordinateItems.length > 0) {
    items = normalizeCoordinateItems(coordinateItems);
  } else {
    items = regexResult?.items ?? [];
    if (items.length > 0) source.items = 'regex';
  }

  // Diskon & pajak diekstrak SETELAH item final diketahui (bukan di awal
  // fungsi lagi) supaya fallback persentase diskon (lihat
  // findDiscountPercentValue() di discountTaxParser.js — struk yang cuma
  // tulis "Diskon 10%" tanpa nominal rupiah eksplisit) punya
  // itemsSubtotal yang benar untuk dihitung, apa pun sumber item-nya
  // (coordinate atau regex fallback).
  const itemsSubtotal = items.reduce((sum, it) => sum + (Number(it.subtotal) || 0), 0);
  const { diskon, pajak } = parseDiscountAndTax(rows, itemsSubtotal);

  // Suntikkan diskon/pajak sebagai baris item terakhir (lihat
  // appendDiscountTaxItems()) supaya sum(items) konsisten dengan total.
  items = appendDiscountTaxItems(items, diskon, pajak);

  return {
    namaToko,
    tanggal,
    total,
    diskon,
    pajak,
    items,
    meta: { source },
  };
}

/**
 * Nilai seberapa bisa dipercaya hasil parseReceipt() (coordinate+regex).
 * TIDAK menghakimi field satu-satu secara halus — cukup sinyal kasar yang
 * sudah terbukti berkorelasi dengan struk bermasalah di 3 contoh nyata
 * (item palsu dari baris header, item asli hilang, dsb):
 *
 *   - namaToko/tanggal/total tidak ketemu sama sekali (null)
 *   - items kosong padahal mustahil struk tanpa barang
 *   - jumlah subtotal semua item MELESET jauh dari `total` (indikasi kuat
 *     ada item palsu ikut kehitung, atau item asli tidak terbaca / salah
 *     kolom harga).
 *
 * CATATAN PENTING: sejak appendDiscountTaxItems() ada, `result.items` yang
 * datang dari parseReceipt()/parseReceiptWithLlmFallback()/
 * parseReceiptLlmFirst() SUDAH menyertakan diskon (nominal negatif) & pajak
 * (nominal positif) sebagai baris tersendiri kalau ada (lihat
 * appendDiscountTaxItems() di atas). Jadi sum(items[].subtotal) di sini
 * SUDAH bersih (net) terhadap diskon/pajak — TIDAK PERLU dikurangi/
 * ditambah lagi secara manual di sini, karena itu akan double-counting.
 * `result.diskon`/`result.pajak` di parameter cuma dipertahankan di skema
 * balikan untuk keperluan tampilan/breakdown terpisah, bukan dipakai lagi
 * di rekonsiliasi ini.
 *
 * @param {{namaToko, tanggal, total, diskon, pajak, items}} result
 * @returns {{isLowConfidence: boolean, issues: string[]}}
 */
function computeConfidence(result) {
  const issues = [];

  if (!result.namaToko) issues.push('namaToko_missing');
  if (!result.tanggal) issues.push('tanggal_missing');
  if (!result.total) issues.push('total_missing');

  if (result.items.length === 0) {
    issues.push('items_empty');
  } else if (result.total) {
    const itemsSum = result.items.reduce((sum, it) => sum + (Number(it.subtotal) || 0), 0);
    const relativeDiff = Math.abs(itemsSum - result.total) / result.total;
    if (relativeDiff > ITEMS_TOTAL_MISMATCH_TOLERANCE) {
      issues.push('items_total_mismatch');
    }
  }

  return { isLowConfidence: issues.length > 0, issues };
}

/**
 * Tier 3: parseReceipt() (coordinate -> regex) DULU seperti biasa (cepat,
 * gratis, offline). Kalau confidence-nya rendah (lihat computeConfidence),
 * BARU kirim rawText ke LLM sebagai upaya terakhir — dan gabungkan
 * hasilnya field-per-field, bukan menimpa buta:
 *   - Field yang SUDAH confident dari tier 1/2 tetap dipakai (LLM juga bisa
 *     halusinasi, jadi tidak otomatis lebih benar untuk field yang memang
 *     sudah jelas).
 *   - `items` diganti LLM HANYA kalau tier 1/2 kosong atau mismatch jauh
 *     dari total; kalau tier 1/2 sudah masuk akal (sum ≈ total), items
 *     itu yang dipakai.
 *   - Kalau LLM gagal/tidak tersedia (tidak ada API key, network error,
 *     dsb), tetap kembalikan hasil tier 1/2 apa adanya — never worse than
 *     sebelumnya, LLM murni sebagai peningkatan, bukan single point of
 *     failure.
 *
 * @param {{rawText: string, lines: Array}} ocrPayload
 * @param {{apiKey?, fetchImpl?, model?}} [llmOptions] - diteruskan ke
 *   extractWithLlm(), berguna untuk testing (inject fetch/api key palsu).
 * @returns {Promise<ReturnType<typeof parseReceipt> & {meta:{llmUsed:boolean, llmFailed?:boolean, confidenceIssues?:string[]}}>}
 */
async function parseReceiptWithLlmFallback(ocrPayload = {}, llmOptions = {}) {
  const baseResult = parseReceipt(ocrPayload);
  const { isLowConfidence, issues } = computeConfidence(baseResult);

  if (!isLowConfidence) {
    return { ...baseResult, meta: { ...baseResult.meta, llmUsed: false } };
  }

  const rawText = ocrPayload.rawText ?? ocrPayload.raw_text ?? '';
  const llmResult = await extractWithLlm(rawText, llmOptions);

  if (!llmResult) {
    // LLM gagal/tidak tersedia -> tetap pakai hasil coordinate+regex apa
    // adanya (walau confidence rendah) DARIPADA tidak dapat apa-apa.
    return {
      ...baseResult,
      meta: { ...baseResult.meta, llmUsed: false, llmFailed: true, confidenceIssues: issues },
    };
  }

  const itemsFromBaseAreTrustworthy =
    baseResult.items.length > 0 && !issues.includes('items_total_mismatch');

  // diskon/pajak: baseResult (tier 1) TIDAK PERNAH null (discountTaxParser
  // selalu balikin angka atau null utuh, bukan dianggap 0 di parseReceipt),
  // jadi null di sini berarti tier 1 memang tidak nemu apa pun -> pakai
  // punya LLM (yang sudah pasti 0 kalau LLM juga tidak nemu, lihat
  // parseAndValidateLlmJson).
  const finalDiskon = baseResult.diskon ?? llmResult.diskon;
  const finalPajak = baseResult.pajak ?? llmResult.pajak;

  // `baseResult.items` (kalau dipakai) SUDAH dibakukan dengan
  // baseResult.diskon/pajak sendiri lewat parseReceipt() ->
  // appendDiscountTaxItems(). `llmResult.items` (kalau dipakai) BELUM,
  // karena SYSTEM_PROMPT llmFallbackParser.js sengaja melarang LLM
  // memasukkan baris diskon/pajak/service charge ke items -> perlu
  // dibakukan manual di sini, pakai finalDiskon/finalPajak yang sama
  // dengan yang dikembalikan di field diskon/pajak level atas supaya
  // konsisten.
  const finalItems = itemsFromBaseAreTrustworthy
    ? baseResult.items
    : appendDiscountTaxItems(
        llmResult.items.length > 0 ? llmResult.items : baseResult.items,
        finalDiskon,
        finalPajak,
      );

  return {
    namaToko: baseResult.namaToko ?? llmResult.namaToko,
    tanggal: baseResult.tanggal ?? llmResult.tanggal,
    diskon: finalDiskon,
    pajak: finalPajak,
    total: baseResult.total ?? llmResult.total,
    items: finalItems,
    meta: { ...baseResult.meta, llmUsed: true, confidenceIssues: issues },
  };
}

/**
 * Alternatif tier order: LLM DULU untuk SEMUA struk (bukan cuma yang
 * confidence-nya rendah), parser koordinat+regex jadi JARING PENGAMAN
 * kalau LLM gagal/tidak tersedia/hasilnya kosong total — bukan sebaliknya
 * seperti parseReceiptWithLlmFallback().
 *
 * PERTIMBANGKAN baik-baik sebelum pakai ini sebagai default produksi:
 *   - SETIAP struk kena panggil API (bukan cuma yang bermasalah) -> kuota
 *     free tier (mis. Gemini ~15 req/menit) jauh lebih cepat habis kalau
 *     volume upload tinggi/menumpuk di jam tertentu.
 *   - SETIAP struk datanya (nominal, nama toko, item) terkirim ke API
 *     eksternal, bukan cuma subset yang meragukan.
 *   - Latensi per-request naik (network round-trip untuk semua struk,
 *     bukan cuma yang gagal parser lokal).
 * Kalau volume rendah/menengah dan prioritasnya akurasi maksimal per
 * struk, ini masuk akal. Kalau volume tinggi/prioritas hemat kuota &
 * privasi, parseReceiptWithLlmFallback() (LLM sebagai tier 3 saja) lebih
 * aman.
 *
 * @param {{rawText: string, lines: Array}} ocrPayload
 * @param {{apiKey?, fetchImpl?, model?}} [llmOptions]
 * @returns {Promise<ReturnType<typeof parseReceipt> & {meta:{llmUsed:boolean, llmFailed?:boolean}}>}
 */
async function parseReceiptLlmFirst(ocrPayload = {}, llmOptions = {}) {
  const rawText = ocrPayload.rawText ?? ocrPayload.raw_text ?? '';
  const llmResult = await extractWithLlm(rawText, llmOptions);

  const llmHasSubstance = llmResult && (
    llmResult.namaToko || llmResult.tanggal || llmResult.total || llmResult.items.length > 0
  );

  if (llmHasSubstance) {
    return {
      namaToko: llmResult.namaToko,
      tanggal: llmResult.tanggal,
      diskon: llmResult.diskon,
      pajak: llmResult.pajak,
      total: llmResult.total,
      // llmResult.items BELUM menyertakan diskon/pajak sebagai baris
      // (dilarang eksplisit di SYSTEM_PROMPT llmFallbackParser.js) ->
      // bakukan di sini juga, supaya konsisten dengan parseReceipt().
      items: appendDiscountTaxItems(llmResult.items, llmResult.diskon, llmResult.pajak),
      meta: {
        source: { namaToko: 'llm', tanggal: 'llm', total: 'llm', items: 'llm' },
        llmUsed: true,
      },
    };
  }

  // LLM gagal / API tidak tersedia / hasilnya kosong total -> jangan
  // kembalikan struk kosong ke user, fallback ke parser lokal.
  const fallback = parseReceipt(ocrPayload);
  return {
    ...fallback,
    meta: { ...fallback.meta, llmUsed: false, llmFailed: true },
  };
}

module.exports = {
  parseReceipt,
  parseReceiptWithLlmFallback,
  parseReceiptLlmFirst,
  computeConfidence,
  buildRows,
  buildPlainLines,
  normalizeCoordinateItems,
  appendDiscountTaxItems,
};