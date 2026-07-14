// src/services/llmFallbackParser.js
// Fallback TERAKHIR (tier 3) untuk struk yang hasil parser koordinat +
// regex-nya masih diragukan: kirim rawText OCR ke LLM (Gemini, free tier),
// minta diekstrak jadi JSON terstruktur {namaToko, tanggal, total, items[]}.
//
// Kenapa LLM di sini masuk akal padahal sudah ada parser koordinat & regex:
// keduanya bekerja dengan MENCOCOKKAN POLA (regex/posisi) — daftar pola
// "bukan item"/"bukan nama toko" pasti selalu ada celah, karena format
// struk & typo OCR nyaris tak terbatas variannya (lihat komentar di
// itemParser.js/storeParser.js — kasus "Gedung AIA Central, Lantai 30" yang
// tidak match keyword apa pun tapi jelas alamat bagi manusia). LLM tidak
// mencocokkan pola, dia MEMAHAMI ARTI teks, jadi jauh lebih tahan terhadap
// noise semacam itu.
//
// Pakai Gemini (bukan Claude) karena free tier-nya cukup untuk volume
// struk reimbursement yang biasanya rendah — lihat GEMINI_API_KEY di .env.
// Kalau nanti pindah provider lain, cukup ubah isi extractWithLlm() —
// bentuk & nama fungsi yang dipanggil coordinateParser.js TIDAK berubah.
//
// Dipanggil HANYA kalau confidence hasil coordinate+regex rendah (lihat
// computeConfidence() & parseReceiptWithLlmFallback() di
// coordinateParser.js) — supaya struk yang sudah berhasil bagus lewat
// parser cepat & gratis TIDAK perlu memanggil API sama sekali (dan tidak
// ikut memakan kuota free tier yang terbatas per menit/hari).

const { DISKON_REGEX, PAJAK_REGEX } = require('./discountTaxParser');

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const MODEL = 'gemini-3.1-flash-lite'; // generasi Gemini 3.x, stabil (bukan preview), murah & cukup untuk ekstraksi terstruktur
const REQUEST_TIMEOUT_MS = 15000;

const SYSTEM_PROMPT = `Kamu adalah parser struk belanja Indonesia. Kamu akan menerima teks mentah hasil OCR sebuah struk (kadang ada typo/salah baca huruf-angka, baris terpotong, atau urutan baris sedikit kacau karena tata letak kolom yang digabung OCR secara linear).

Tugasmu: ekstrak data berikut dan kembalikan HANYA JSON valid, TANPA teks lain, TANPA markdown code fence, dengan skema PERSIS seperti ini:

{
  "namaToko": string | null,
  "tanggal": string | null,
  "subtotal": number | null,
  "diskon": number | null,
  "pajak": number | null,
  "total": number | null,
  "items": [
    { "nama_item": string, "qty": number, "harga_satuan": number, "subtotal": number }
  ]
}

Aturan:
- "tanggal" format ISO YYYY-MM-DD, null kalau tidak ketemu/tidak yakin.
- "subtotal" = jumlah harga semua item SEBELUM diskon & pajak. Kalau ada baris "Subtotal" eksplisit pakai itu; kalau tidak ada, hitung dari sum(items[].subtotal).
- "diskon" = total nominal diskon/promo/potongan harga (angka POSITIF yang MENGURANGI total). 0 kalau tidak ada baris diskon sama sekali — JANGAN null untuk kasus tidak ada, supaya gampang dihitung.
- "pajak" = total nominal SEMUA komponen yang DITAMBAHKAN ke subtotal (angka POSITIF) — bukan cuma pajak murni, tapi juga biaya layanan. Termasuk: PPN, "PB1"/"Pajak Bangunan 1"/"Pajak Restoran" (pajak daerah restoran/kafe di Indonesia, beda dari PPN), TAX, VAT, DAN biaya layanan seperti "Service Charge"/"SVC CHRG"/"SC"/"Service" (biaya layanan BUKAN pajak secara istilah, tapi digabung ke field ini karena sama-sama nominal tambahan sebelum total — kalau ada KEDUANYA, PPN dan Service Charge, jumlahkan semuanya jadi satu angka "pajak"). 0 kalau tidak ada baris pajak/biaya layanan sama sekali, ATAU kalau strukturnya bilang pajak SUDAH TERMASUK di harga/total (mis. "Total Incl. PPN", "PPN sudah termasuk", "harga sudah termasuk pajak") — dalam kasus "sudah termasuk", isi 0 karena tidak boleh dijumlahkan lagi di atas total, JANGAN masukkan nominalnya sebagai pajak terpisah walau angkanya disebutkan di struk.
- "total" adalah nominal AKHIR yang harus dibayar (biasanya berlabel TOTAL/GRAND TOTAL), BUKAN subtotal, BUKAN CASH/BAYAR (uang yang diberikan pelanggan), BUKAN kembalian. Idealnya total ≈ subtotal - diskon + pajak; kalau angka-angka di struk tidak pas dengan hubungan ini, tetap ambil nominal yang eksplisit berlabel TOTAL/GRAND TOTAL apa adanya (jangan dipaksakan dihitung ulang).
- items HANYA barang yang benar-benar dibeli. JANGAN masukkan baris alamat, NPWP, nomor struk, nama kasir, label kolom, baris diskon/pajak/biaya layanan/subtotal/total, atau baris footer sebagai item — termasuk "Service Charge"/"SVC CHRG"/"SC" (masuk ke field "pajak", BUKAN item).
- Kalau qty tidak disebutkan eksplisit, isi 1.
- Kalau subtotal item tidak eksplisit tapi harga_satuan & qty ada (atau sebaliknya), hitung yang belum ada dari yang sudah ada.
- Perbaiki typo OCR yang jelas dari konteks (mis. "0riginal" -> "Original"), tapi JANGAN mengarang data yang tidak ada di teks aslinya.
- Kalau namaToko/tanggal/total benar-benar tidak bisa ditentukan, isi null. JANGAN mengarang.
- Kembalikan HANYA objek JSON itu sendiri, tidak ada kalimat pembuka/penutup, tidak ada code fence.`;

/**
 * Panggil Gemini API untuk mengekstrak field struk dari rawText OCR.
 *
 * @param {string} rawText - teks OCR mentah (raw_text dari Flutter, BUKAN
 *   hasil groupLines() — LLM sengaja diberi teks asli apa adanya supaya
 *   tidak ikut mewarisi distorsi estimasi spasi kolom dari lineGrouper.js).
 * @param {{apiKey?, fetchImpl?, model?, timeoutMs?}} [options] - untuk
 *   testing (inject fetch/api key palsu) tanpa perlu ubah kode ini.
 * @returns {Promise<{namaToko:string|null, tanggal:string|null, total:number|null, items:Array}|null>}
 *   null kalau API gagal / key tidak ada / response tidak valid — supaya
 *   caller tahu harus fallback ke hasil coordinate+regex yang sudah ada,
 *   daripada tidak dapat apa-apa sama sekali.
 */
async function extractWithLlm(rawText, options = {}) {
  if (!rawText || typeof rawText !== 'string' || rawText.trim().length === 0) {
    return null;
  }

  const apiKey = options.apiKey ?? process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('[llmFallbackParser] GEMINI_API_KEY tidak diset, skip LLM fallback.');
    return null;
  }

  const model = options.model ?? MODEL;
  const url = `${GEMINI_API_BASE}/${model}:generateContent?key=${apiKey}`;

  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? REQUEST_TIMEOUT_MS);

  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [
          { role: 'user', parts: [{ text: `Teks OCR struk:\n\n${rawText}` }] },
        ],
        generationConfig: {
          temperature: 0,
          // Minta Gemini balikin JSON murni (dukungan native-nya), supaya
          // tidak perlu berharap model "nurut" instruksi "jangan pakai
          // code fence" di system prompt saja.
          responseMimeType: 'application/json',
        },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      console.error(`[llmFallbackParser] Gemini API error ${response.status}: ${errText}`);
      return null;
    }

    const data = await response.json();

    // Gemini bisa menolak jawab (safety filter, dsb) -> candidates kosong/
    // tidak ada, atau ada promptFeedback.blockReason. Anggap gagal, biar
    // caller fallback ke hasil coordinate+regex.
    if (data?.promptFeedback?.blockReason) {
      console.error(`[llmFallbackParser] Gemini blokir request: ${data.promptFeedback.blockReason}`);
      return null;
    }

    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      console.error('[llmFallbackParser] Gemini response tidak punya teks:', JSON.stringify(data).slice(0, 200));
      return null;
    }

    return parseAndValidateLlmJson(text);
  } catch (err) {
    console.error('[llmFallbackParser] Gagal memanggil/parse Gemini:', err.message);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Parse teks respons LLM jadi JSON, bersihkan markdown fence kalau masih
 * kebawa (walau sudah minta responseMimeType: application/json, tetap
 * dijaga sebagai pengaman untuk model/versi API yang mungkin tidak taat),
 * lalu validasi & bersihkan bentuknya sesuai skema yang diharapkan supaya
 * caller tidak perlu percaya buta pada output LLM.
 */
function parseAndValidateLlmJson(text) {
  const cleaned = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    console.error('[llmFallbackParser] Response bukan JSON valid:', cleaned.slice(0, 200));
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;

  const namaToko = typeof parsed.namaToko === 'string' && parsed.namaToko.trim().length > 0
    ? parsed.namaToko.trim()
    : null;

  const tanggal = typeof parsed.tanggal === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed.tanggal)
    ? parsed.tanggal
    : null;

  const total = Number.isFinite(parsed.total) && parsed.total > 0 ? parsed.total : null;

  // diskon/pajak DEFAULT 0 (bukan null) kalau tidak valid/tidak ada —
  // konsisten dengan instruksi di SYSTEM_PROMPT ("0 kalau tidak ada"),
  // supaya caller (computeConfidence di coordinateParser.js) bisa langsung
  // pakai dalam aritmatika tanpa perlu null-check terpisah.
  const diskon = Number.isFinite(parsed.diskon) && parsed.diskon >= 0 ? parsed.diskon : 0;
  const pajak = Number.isFinite(parsed.pajak) && parsed.pajak >= 0 ? parsed.pajak : 0;
  const subtotal = Number.isFinite(parsed.subtotal) && parsed.subtotal >= 0 ? parsed.subtotal : null;

  // FIX: SYSTEM_PROMPT sudah eksplisit melarang LLM memasukkan baris
  // diskon/pajak/biaya layanan ke items[] (nominalnya sudah ditampung
  // terpisah di field "diskon"/"pajak"), TAPI itu cuma instruksi teks —
  // Gemini kadang tetap menyertakannya (non-compliance), biasanya dengan
  // harga_satuan/subtotal 0 karena dia tidak tahu harus isi angka apa
  // untuk baris yang bukan barang. Angka 0 itu FINITE (bukan null), jadi
  // lolos filter ".subtotal !== null || .harga_satuan !== null" di bawah
  // dan ikut terkirim ke Flutter sebagai "item" dengan harga kosong/0 —
  // ini yang menyebabkan field "Harga satuan" kelihatan kosong di form
  // (baris "Diskon" versi hallucination ini menggantikan tempat baris
  // "Diskon" yang SEHARUSNYA disuntik otomatis oleh
  // appendDiscountTaxItems() di coordinateParser.js dengan nominal asli).
  // Solusinya: buang defensif di KODE, jangan cuma andalkan prompt —
  // pakai regex yang SAMA dengan discountTaxParser.js supaya konsisten
  // dengan bagaimana tier coordinate/regex mengecualikan baris ini juga.
  const isDiscountOrTaxRow = (namaItem) => DISKON_REGEX.test(namaItem) || PAJAK_REGEX.test(namaItem);

  const items = Array.isArray(parsed.items)
    ? parsed.items
        .filter((it) => it && typeof it.nama_item === 'string' && it.nama_item.trim().length > 0)
        .filter((it) => !isDiscountOrTaxRow(it.nama_item.trim()))
        .map((it) => {
          const harga_satuan = Number.isFinite(it.harga_satuan) ? it.harga_satuan : null;
          const subtotalItem = Number.isFinite(it.subtotal) ? it.subtotal : null;
          const qty = Number.isFinite(it.qty) && it.qty > 0 ? it.qty : 1;
          return {
            nama_item: it.nama_item.trim(),
            qty,
            harga_satuan: harga_satuan ?? (subtotalItem !== null ? Math.round((subtotalItem / qty) * 100) / 100 : null),
            subtotal: subtotalItem ?? (harga_satuan !== null ? harga_satuan * qty : null),
          };
        })
        .filter((it) => it.subtotal !== null || it.harga_satuan !== null)
    : [];

  return { namaToko, tanggal, subtotal, diskon, pajak, total, items };
}

module.exports = {
  extractWithLlm,
  parseAndValidateLlmJson,
};