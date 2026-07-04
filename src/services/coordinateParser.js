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
const { parseWithRegex } = require('./regexFallbackParser');

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
  const coordinateItems = parseItemsCoordinate(rows);

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

  return {
    namaToko,
    tanggal,
    total,
    items,
    meta: { source },
  };
}

module.exports = {
  parseReceipt,
  buildRows,
  buildPlainLines,
  normalizeCoordinateItems,
};