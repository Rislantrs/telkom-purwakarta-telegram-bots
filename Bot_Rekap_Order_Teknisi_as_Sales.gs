/**
 * ============================================================================
 * BOT TELEGRAM REKAP ORDER TEKNISI (TEKNISI AS SALES) - GOOGLE APPS SCRIPT
 * ============================================================================
 * @file        Bot_Rekap_Order_Teknisi_as_Sales.gs
 *              (Catatan: Di editor Google Apps Script, salin isi file ini ke tab default `Code.gs`)
 * @author      M Rislan Tristansyah
 * @platform    Google Apps Script, Google Sheets, Telegram Bot API
 * @description Sistem otomasi pencatatan order Teknisi as Sales (kode SC dan WO)
 *              melalui bot Telegram dengan dukungan parsing multi-skenario,
 *              validasi duplikasi lintas sheet (DATA BOT dan DATA MANUAL),
 *              manajemen profil teknisi (TABEL), serta penguncian konkurensi.
 *
 * Prasyarat Konfigurasi Script Properties:
 * Buka menu Project Settings -> Script Properties di Google Apps Script, lalu
 * tambahkan properti berikut:
 * - `BOT_TOKEN`  : Token Bot Telegram dari @BotFather.
 * - `WEBAPP_URL` : URL Deployment Web App (`/exec`) untuk registrasi webhook.
 * ============================================================================
 */

// ----------------------------------------------------------------------------
// 1. KONFIGURASI UTAMA (SCRIPT PROPERTIES & PARAMETER SPREADSHEET)
// ----------------------------------------------------------------------------

const SCRIPT_PROP = PropertiesService.getScriptProperties();

/** @type {string} Token autentikasi Bot Telegram (diambil dari Script Properties). */
const BOT_TOKEN = SCRIPT_PROP.getProperty("BOT_TOKEN") || "";

/** @type {string} URL Web App hasil deployment untuk pengaturan webhook Telegram. */
const WEBAPP_URL = SCRIPT_PROP.getProperty("WEBAPP_URL") || "";

/** @type {string} Nama sheet utama penyimpanan hasil pencatatan order bot. */
const NAMA_SHEET_BOT = "DATA BOT";

/** @type {string} Nama sheet data manual historis untuk pencegahan duplikasi SC/WO. */
const NAMA_SHEET_MANUAL = "DATA MANUAL";

/** @type {string} Nama sheet master profil dan identitas teknisi. */
const NAMA_SHEET_TABEL = "TABEL";

/** @type {boolean} Pengaturan pemotongan otomatis karakter tambahan pada akun Digipos. */
const AUTO_POTONG_DGPS = true;

/** @type {string[]} Daftar kode Sentral Telepon Otomat (STO) yang valid. */
const STO_VALID = ["PWK", "PLD", "CBU"];

/** @type {string[]} Daftar penamaan bulan dalam Bahasa Indonesia. */
const NAMA_BULAN = [
  "Januari", "Februari", "Maret", "April", "Mei", "Juni",
  "Juli", "Agustus", "September", "Oktober", "November", "Desember"
];

/**
 * Data bawaan master teknisi untuk inisialisasi awal sheet `TABEL` apabila kosong.
 * Dikosongkan pada repositori publik untuk menjaga kerahasiaan data personil.
 *
 * Contoh struktur entri:
 * { no: 1, nik: "12345678", nama: "NAMA TEKNISI", stream: "ASR", tele: "@username_tele", digipos: "" }
 * @type {Array<{no: number, nik: string, nama: string, stream: string, tele: string, digipos: string}>}
 */
const DAFTAR_TEKNISI_DEFAULT = [
  // Isi daftar teknisi lokal jika diperlukan auto-seeding sheet TABEL
];


// 2. ATURAN REGEX & VALIDASI
const REGEX_RULES = {
  STO_EXACT: /^(PWK|PLD|CBU)$/i,
  WA_HEADER: /^\[?\d{1,2}[:.]\d{2}\s*(?:AM|PM)?\s*,\s*\d{1,2}\/\d{1,2}\/\d{2,4}\]?\s*[^:]{1,40}:\s*/i,
  BULLET_PREFIX: /^(?:\d+[\.\)\-]\s*|[\u2022\-*]\s*)/,
  DGPS_EXTRACT: /\b(DGPS[0-9A-Za-z]+?)(?:-[A-Za-z0-9_]+~|~|\s|$)/i,
  CIRI_WO: /^WO[-_]?[0-9A-Za-z]{5,30}$/i,
  CIRI_SC: /^(?:DGPS|SC|MYIR|MYID|AO)[-_]?[0-9A-Za-z]{5,200}$/i,
  KODE_ORDER_AMAN: /^(?=(?:.*\d){4,})[A-Za-z0-9/_~.-]{5,200}$/,
  NIK_VALID: /^[A-Za-z0-9.-]{5,25}$/,
  DIGIPOS_VALID: /^[A-Za-z0-9_.@-]{3,40}$/
};

// 3. HANDLER WEBHOOK TELEGRAM
/**
 * Mendaftarkan URL Web App Google Apps Script sebagai endpoint webhook resmi Telegram.
 * Jalankan fungsi ini satu kali setelah deployment selesai atau setelah URL Web App berubah.
 */
function setWebhook() {
  const url = "https://api.telegram.org/bot" + BOT_TOKEN + "/setWebhook?url=" + encodeURIComponent(WEBAPP_URL) + "&drop_pending_updates=true";
  const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  Logger.log("Hasil Set Webhook: " + response.getContentText());
  return JSON.parse(response.getContentText());
}

/**
 * Memeriksa status, jumlah antrean pembaruan, dan pesan galat terakhir dari webhook Telegram.
 */
function getWebhookInfo() {
  const url = "https://api.telegram.org/bot" + BOT_TOKEN + "/getWebhookInfo";
  const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  Logger.log(response.getContentText());
  return JSON.parse(response.getContentText());
}

/**
 * Endpoint HTTP GET untuk verifikasi ketersediaan layanan Web App bot order teknisi.
 * @return {GoogleAppsScript.Content.TextOutput} Respons teks status layanan aktif.
 */
function doGet() {
  return HtmlService.createHtmlOutput("Sistem Rekap Order Teknisi Telkom Aktif 24/7.");
}

/**
 * Handler utama webhook Telegram (HTTP POST) dengan mekanisme idempotency berbasis
 * CacheService dan penyaringan pesan grup non-order agar tidak memicu balasan palsu.
 * @param {GoogleAppsScript.Events.DoPost} e Objek event payload JSON dari Telegram.
 */
function doPost(e) {
  let update = null;
  try {
    if (!e || !e.postData || !e.postData.contents) return HtmlService.createHtmlOutput("OK");
    update = JSON.parse(e.postData.contents);

    // Mencegah request ganda (idempotency) dengan CacheService
    if (update.update_id) {
      const cache = CacheService.getScriptCache();
      const cacheKey = "tg_up_" + update.update_id;
      if (cache.get(cacheKey)) {
        return HtmlService.createHtmlOutput("OK");
      }
      cache.put(cacheKey, "1", 300);
    }

    if (!update.message || !update.message.text) return HtmlService.createHtmlOutput("OK");

    const msg = update.message;
    const chatId = msg.chat.id;
    const telegramId = String(msg.from.id);
    const tgUsername = msg.from.username
      ? "@" + msg.from.username
      : (msg.from.first_name || "user_" + telegramId);

    const text = msg.text.trim();
    const lowerText = text.toLowerCase();

    // Filter pesan grup: jika bukan perintah atau format order, abaikan tanpa membalas
    const isGroup = chatId < 0 || (msg.chat && msg.chat.type && msg.chat.type !== "private");
    if (isGroup && !apakahPesanTerkaitBot(text)) {
      return HtmlService.createHtmlOutput("OK");
    }

    if (lowerText === "/start" || lowerText === "/help" || lowerText === "/panduan") {
      kirimPanduan(chatId, telegramId, tgUsername);
      return HtmlService.createHtmlOutput("OK");
    }

    if (lowerText === "/profil" || lowerText === "/cek") {
      cekProfilTeknisi(chatId, telegramId, tgUsername);
      return HtmlService.createHtmlOutput("OK");
    }

    if (lowerText === "/regist" || lowerText === "/register" || lowerText === "/daftar" || lowerText === "/ubah" || lowerText === "/ganti" || lowerText === "/update") {
      kirimPanduanRegist(chatId, telegramId, tgUsername);
      return HtmlService.createHtmlOutput("OK");
    }

    prosesPesan(chatId, telegramId, tgUsername, text, msg.message_id, isGroup);

  } catch (err) {
    Logger.log("Error doPost: " + err.toString());
  }

  return HtmlService.createHtmlOutput("OK");
}

/**
 * Menyaring pesan grup agar hanya memproses pesan yang berisi perintah bot, mention,
 * atau kata kunci/pola order teknisi (STO, SC, WO, Digipos, Registrasi).
 * @param {string} text Isi teks pesan masuk.
 * @return {boolean} Bernilai true apabila pesan relevan untuk diproses oleh bot.
 */
function apakahPesanTerkaitBot(text) {
  const t = text.trim();
  if (t.startsWith("/")) return true;
  if (/@\w+_bot\b/i.test(t)) return true;

  const hasSto = /\b(PWK|PLD|CBU)\b/i.test(t);
  const hasOrderCode = /\b(DGPS\d+|WO\d+|SC\d+)\b/i.test(t);
  if (hasSto && hasOrderCode) return true;

  if (/\b(NO\.?\s*SC|NO\.?\s*WO|NOMOR\s*SC|NOMOR\s*WO)\s*[:=]/i.test(t)) return true;
  if (/\b(STO|AREA)\s*[:=]/i.test(t) && hasOrderCode) return true;

  return false;
}

// 4. PEMROSESAN PESAN UTAMA
/**
 * Mengarahkan pesan masuk ke alur perintah bantuan, cek profil, registrasi/pembaruan data,
 * atau alur ekstraksi serta penyimpanan order SC dan WO.
 * @param {number|string} chatId ID chat tujuan balasan.
 * @param {string} telegramId ID unik pengirim pada platform Telegram.
 * @param {string} tgUsername Username pengirim diawali simbol @ jika tersedia.
 * @param {string} text Isi pesan mentah.
 * @param {number} messageId ID pesan untuk referensi balasan.
 * @param {boolean} isGroup Penanda apakah pesan berasal dari obrolan grup.
 */
function prosesPesan(chatId, telegramId, tgUsername, text, messageId, isGroup) {
  let rawText = text.replace(/@\w+_bot\b/gi, "").trim();
  const isCmdRegist = /^\/(regist|register|daftar|update|ubah|ganti)\b/i.test(rawText);
  const cleanText = rawText.replace(/^\/(regist|register|daftar|update|ubah|ganti|sto|order|input|kirim)\b/i, "").trim();

  if (isCmdRegist) {
    let profil = ambilProfilTeknisi(telegramId, tgUsername);
    const regData = parseRegistrasi(rawText, profil);
    return prosesRegistrasi(
      chatId,
      telegramId,
      tgUsername,
      regData.nik,
      regData.nama,
      regData.digipos,
      messageId,
      regData.newTele
    );
  }

  const hasilParse = parsePesanMultiSkenario(cleanText);

  if (isGroup && (!hasilParse.orders || hasilParse.orders.length === 0) && (!hasilParse.errors || hasilParse.errors.length === 0)) {
    return;
  }

  const explicitData = {
    digipos: hasilParse.explicitDigipos,
    nik: hasilParse.explicitNik,
    nama: hasilParse.explicitNama
  };

  const profil = tentukanProfilOrder(telegramId, tgUsername, explicitData);

  if (!profil) {
    if (isGroup && (!hasilParse.orders || hasilParse.orders.length === 0)) {
      return;
    }
    return kirimPesan(
      chatId,
      "Akun Telegram Anda (" + tgUsername + ") belum terdaftar di Sheet TABEL.\n\n" +
      "Panduan:\n" +
      "- Jika input sendiri: Ketik /regist NIK / NAMA\n" +
      "- Jika inputkan teman: Cantumkan Nama/NIK teman\n" +
      "Contoh: NAMA : ATA / PWK DGPS... WO...",
      messageId
    );
  }

  return simpanOrderKeSheet(chatId, profil, hasilParse.orders, hasilParse.errors, messageId);
}

// 5. ATRIBUSI PEMILIK ORDER & UNLOCKED DIGIPOS
/**
 * Menentukan pemilik order berdasarkan profil pengirim di sheet TABEL atau data
 * identitas eksplisit (NIK, Nama, Username Digipos) yang ditulis pada pesan order.
 * @param {string} telegramId ID Telegram pengirim.
 * @param {string} tgUsername Username Telegram pengirim.
 * @param {Object} explicitData Data NIK, Nama, dan Digipos hasil ekstraksi pesan.
 * @return {Object} Status kecocokan profil beserta objek identitas teknisi.
 */
function tentukanProfilOrder(telegramId, tgUsername, explicitData) {
  const profilPengirim = ambilProfilTeknisi(telegramId, tgUsername);
  const explicitDigiposVal = explicitData && explicitData.digipos ? String(explicitData.digipos).trim() : "";

  // Skenario A: Pengirim terdaftar di sheet TABEL
  if (profilPengirim) {
    const adaNamaBeda = explicitData && explicitData.nama && (explicitData.nama.trim().toLowerCase() !== profilPengirim.nama.toLowerCase());
    const adaNikBeda = explicitData && explicitData.nik && (explicitData.nik.replace(/['\s]/g, "") !== profilPengirim.nik.replace(/['\s]/g, ""));

    // Jika sengaja menulis NIK/Nama teman
    if (adaNamaBeda || adaNikBeda) {
      const matchedTeman = cariTeknisiDiTabel("", explicitData.nik, explicitData.nama);
      if (matchedTeman) {
        return {
          nik: matchedTeman.nik,
          nama: matchedTeman.nama,
          stream: matchedTeman.stream || "Teknisi",
          digipos: explicitDigiposVal || (matchedTeman.digipos && matchedTeman.digipos !== "-" ? matchedTeman.digipos : "-"),
          tgUsername: matchedTeman.tgUsername || tgUsername,
          diinputOleh: tgUsername
        };
      } else {
        const namaPakai = explicitData.nama || "TEKNISI";
        return {
          nik: explicitData.nik || "-",
          nama: namaPakai,
          stream: "Freelance",
          digipos: explicitDigiposVal || "-",
          tgUsername: tgUsername,
          diinputOleh: tgUsername
        };
      }
    }

    // Order milik pengirim sendiri (Digipos bebas diisi apa saja, tidak di-lock)
    const digiposPakai = explicitDigiposVal || (profilPengirim.digipos && profilPengirim.digipos !== "-" ? profilPengirim.digipos : "-");
    return {
      nik: profilPengirim.nik,
      nama: profilPengirim.nama,
      stream: profilPengirim.stream || "Teknisi",
      digipos: digiposPakai,
      tgUsername: tgUsername || profilPengirim.tgUsername,
      diinputOleh: ""
    };
  }

  // Skenario B: Pengirim belum terdaftar di TABEL tapi menyebut NIK/Nama teknisi
  if (explicitData && (explicitData.nik || explicitData.nama)) {
    const matched = cariTeknisiDiTabel("", explicitData.nik, explicitData.nama);
    if (matched) {
      return {
        nik: matched.nik,
        nama: matched.nama,
        stream: matched.stream || "Teknisi",
        digipos: explicitDigiposVal || (matched.digipos && matched.digipos !== "-" ? matched.digipos : "-"),
        tgUsername: matched.tgUsername || tgUsername,
        diinputOleh: tgUsername
      };
    } else {
      const namaPakai = explicitData.nama || "TEKNISI";
      return {
        nik: explicitData.nik || "-",
        nama: namaPakai,
        stream: "Freelance",
        digipos: explicitDigiposVal || "-",
        tgUsername: tgUsername,
        diinputOleh: tgUsername
      };
    }
  }

  // Skenario C: Pengirim belum terdaftar tapi mengisi Digipos (tetap diizinkan)
  if (explicitDigiposVal) {
    return {
      nik: "-",
      nama: tgUsername.replace(/^@/, ""),
      stream: "Teknisi",
      digipos: explicitDigiposVal,
      tgUsername: tgUsername,
      diinputOleh: ""
    };
  }

  return null;
}

// 6. PARSER ORDER MULTI-SKENARIO
/**
 * Mengekstrak informasi identitas teknisi dan daftar order (STO, SC, WO) dari berbagai
 * gaya penulisan pesan teknisi secara fleksibel (berbaris, satu baris, atau multi-blok).
 * @param {string} text Teks pesan laporan order dari teknisi.
 * @return {{nik: string, nama: string, digipos: string, orders: Array, parseErrors: Array}} Hasil ekstraksi terstruktur.
 */
function parsePesanMultiSkenario(text) {
  let normalizedText = text
    .replace(/\\+/g, "/")
    .replace(/\s+((?:DIGIPOS|AKUN\s*DIGIPOS|USER\s*DIGIPOS|NIK|NAMA\s*TEKNISI|TEKNISI|STO|NO\s*SC|NO\s*WO|KODE\s*STO)\s*[:=])/gi, function(m, p) { return "\n" + p; })
    .replace(/(\b(?:STO|AREA)\s*[:=]\s*(?:PWK|PLD|CBU))\s+/gi, function(m, p) { return p + "\n"; });

  const rawLines = normalizedText.split(/\r?\n/).map(s => s.trim()).filter(Boolean);

  let explicitNik = "";
  let explicitNama = "";
  let explicitDigipos = "";

  let activeSto = "";
  let pendingScList = [];
  let pendingWoList = [];

  const validOrders = [];
  const errors = [];

  function bersihkanKodeOrder(rawVal) {
    let v = String(rawVal || "").trim().replace(/[\\/]+$/, "");
    if (!v) return "";

    if (AUTO_POTONG_DGPS) {
      const dgpsMatch = v.match(REGEX_RULES.DGPS_EXTRACT);
      if (dgpsMatch && dgpsMatch[1]) {
        return dgpsMatch[1].toUpperCase();
      }
      if (/^DGPS\d+/i.test(v) && (v.includes("-AOi") || v.includes("~"))) {
        return v.split(/(?:-AOi|~)/i)[0].trim().toUpperCase();
      }
    }

    return v.split(/\s+/)[0].toUpperCase();
  }

  function validasiDanMasukkanOrder(stoRaw, scRaw, woRaw, konteksBaris) {
    const stoClean = String(stoRaw || "").trim().toUpperCase();
    let scClean = bersihkanKodeOrder(scRaw);
    let woClean = bersihkanKodeOrder(woRaw);

    if (!REGEX_RULES.STO_EXACT.test(stoClean)) {
      errors.push(konteksBaris + ": STO \"" + (stoRaw || "Kosong") + "\" tidak valid (Wajib: PWK, PLD, atau CBU).");
      return;
    }

    const scAdalahWo = REGEX_RULES.CIRI_WO.test(scClean) && !REGEX_RULES.CIRI_WO.test(woClean);
    const woAdalahSc = REGEX_RULES.CIRI_SC.test(woClean) && !REGEX_RULES.CIRI_SC.test(scClean);

    if (scAdalahWo || woAdalahSc) {
      const temp = scClean;
      scClean = woClean;
      woClean = temp;
    }

    if (REGEX_RULES.STO_EXACT.test(scClean) || REGEX_RULES.STO_EXACT.test(woClean)) {
      errors.push(konteksBaris + ": Kode STO (" + stoClean + ") tidak boleh masuk ke NO SC / NO WO.");
      return;
    }

    if (!REGEX_RULES.KODE_ORDER_AMAN.test(scClean)) {
      errors.push(konteksBaris + ": Format NO SC (" + scRaw + ") tidak valid.");
      return;
    }
    if (!REGEX_RULES.KODE_ORDER_AMAN.test(woClean)) {
      errors.push(konteksBaris + ": Format NO WO (" + woRaw + ") tidak valid.");
      return;
    }

    if (scClean === woClean) {
      errors.push(konteksBaris + ": NO SC dan NO WO tidak boleh identik (" + scClean + ").");
      return;
    }

    validOrders.push({
      sto: stoClean,
      sc: scClean,
      wo: woClean
    });
  }

  function flushPendingLabelOrders(barisInfo) {
    if (pendingScList.length === 0 && pendingWoList.length === 0) return;

    if (!activeSto) {
      errors.push(barisInfo + ": STO belum diisi (Wajib: PWK, PLD, atau CBU).");
    } else if (!REGEX_RULES.STO_EXACT.test(activeSto)) {
      errors.push(barisInfo + ": STO \"" + activeSto + "\" tidak valid!");
    } else if (pendingScList.length === 0) {
      errors.push(barisInfo + ": NO SC belum diisi untuk NO WO " + pendingWoList.join(", ") + ".");
    } else if (pendingWoList.length === 0) {
      errors.push(barisInfo + ": NO WO belum diisi untuk NO SC " + pendingScList.join(", ") + ".");
    } else if (pendingScList.length !== pendingWoList.length) {
      errors.push(barisInfo + ": Jumlah NO SC (" + pendingScList.length + ") tidak sama dengan jumlah NO WO (" + pendingWoList.length + ").");
    } else {
      for (let i = 0; i < pendingScList.length; i++) {
        validasiDanMasukkanOrder(activeSto, pendingScList[i], pendingWoList[i], barisInfo);
      }
    }

    pendingScList = [];
    pendingWoList = [];
  }

  for (let idx = 0; idx < rawLines.length; idx++) {
    let line = rawLines[idx]
      .trim()
      .replace(REGEX_RULES.WA_HEADER, "")
      .replace(REGEX_RULES.BULLET_PREFIX, "")
      .trim();

    if (!line) continue;
    const labelBaris = "Baris " + (idx + 1);

    const kvMatch = line.match(/^([a-zA-Z\s_.#-]{2,30})\s*[:=]\s*(.+)$/);
    if (kvMatch) {
      const key = kvMatch[1].trim().toLowerCase().replace(/[.#_]/g, " ").replace(/\s+/g, " ").trim();
      const val = kvMatch[2].trim();

      if (key === "nik" || key === "no nik" || key === "nomor induk") {
        explicitNik = val;
        continue;
      }
      if (key === "nama" || key === "nama teknisi" || key === "teknisi" || key === "nama lengkap") {
        explicitNama = val;
        continue;
      }
      if (key.includes("digipos") || key === "akun digipos" || key === "user digipos" || key === "username digipos") {
        explicitDigipos = val;
        continue;
      }
      if (key === "bulan" || key.includes("tanggal") || key.includes("telegram") || key === "tgl") {
        continue;
      }

      if (key === "sto" || key === "no sto" || key === "kode sto" || key === "area") {
        activeSto = val.toUpperCase();
        if (pendingScList.length > 0 && pendingWoList.length > 0) {
          flushPendingLabelOrders(labelBaris);
        } else if (!REGEX_RULES.STO_EXACT.test(activeSto)) {
          errors.push(labelBaris + ": STO \"" + val + "\" tidak valid (PWK/PLD/CBU).");
        }
        continue;
      }

      if (key === "no sc" || key === "nosc" || key === "sc" || key === "nomor sc" || key === "sc number") {
        pendingScList = val.split(/[,;]+/).map(s => bersihkanKodeOrder(s)).filter(Boolean);
        if (activeSto && pendingScList.length > 0 && pendingWoList.length > 0) {
          flushPendingLabelOrders(labelBaris);
        }
        continue;
      }

      if (key === "no wo" || key === "nowo" || key === "wo" || key === "nomor wo" || key === "wo number") {
        pendingWoList = val.split(/[,;]+/).map(s => bersihkanKodeOrder(s)).filter(Boolean);
        if (activeSto && pendingScList.length > 0 && pendingWoList.length > 0) {
          flushPendingLabelOrders(labelBaris);
        }
        continue;
      }
    }

    if (REGEX_RULES.STO_EXACT.test(line)) {
      activeSto = line.toUpperCase();
      if (pendingScList.length > 0 && pendingWoList.length > 0) {
        flushPendingLabelOrders(labelBaris);
      }
      continue;
    }

    const rawTokens = line
      .replace(/\b(NO\.?\s*SC|NOSC|NOMOR\s*SC)\b/gi, " ")
      .replace(/\b(NO\.?\s*WO|NOWO|NOMOR\s*WO)\b/gi, " ")
      .replace(/\b(NO\.?\s*STO|KODE\s*STO|STO)\b/gi, " ")
      .split(/[\s,|;/\\]+/)
      .filter(Boolean);

    const stoToken = rawTokens.find(t => REGEX_RULES.STO_EXACT.test(t));
    const woToken = rawTokens.find(t => REGEX_RULES.CIRI_WO.test(t));
    
    let scToken = rawTokens.find(t => REGEX_RULES.CIRI_SC.test(t) && t !== woToken && t !== stoToken);
    if (!scToken) {
      scToken = rawTokens.find(t => REGEX_RULES.KODE_ORDER_AMAN.test(t) && t !== woToken && t !== stoToken);
    }

    if (stoToken) activeSto = stoToken.toUpperCase();

    if (woToken && scToken) {
      const others = rawTokens.filter(t => t !== stoToken && t !== woToken && t !== scToken);
      if (others.length > 0 && !explicitDigipos) {
        explicitDigipos = others[0];
      }
      validasiDanMasukkanOrder(activeSto || stoToken, scToken, woToken, labelBaris);
      continue;
    }

    if (rawTokens.length === 1) {
      const tok = bersihkanKodeOrder(rawTokens[0]);
      if (REGEX_RULES.CIRI_WO.test(tok)) {
        pendingWoList.push(tok);
      } else if (REGEX_RULES.CIRI_SC.test(tok) || REGEX_RULES.KODE_ORDER_AMAN.test(tok)) {
        pendingScList.push(tok);
      }
      if (activeSto && pendingScList.length > 0 && pendingWoList.length > 0 && pendingScList.length === pendingWoList.length) {
        flushPendingLabelOrders(labelBaris);
      }
      continue;
    }
  }

  if (pendingScList.length > 0 || pendingWoList.length > 0) {
    flushPendingLabelOrders("Akhir Pesan");
  }

  return {
    explicitDigipos: explicitDigipos,
    explicitNik: explicitNik,
    explicitNama: explicitNama,
    orders: validOrders,
    errors: errors
  };
}

// 7. PARSER REGISTRASI EKSPLISIT (/regist)
/**
 * Mem-parsing argumen perintah `/regist`, `/register`, `/daftar`, `/ubah`, `/ganti`, dan `/update`.
 * @param {string} text Teks perintah lengkap dari pengguna.
 * @param {Object|null} existingProfile Profil eksisting pengguna jika sudah terdaftar.
 * @return {Object} Hasil ekstraksi field registrasi atau indikator ketidaksesuaian format.
 */
function parseRegistrasi(text, existingProfile) {
  let cleanText = text
    .replace(/@\w+_bot\b/gi, "")
    .replace(/^\/(regist|register|daftar|update|ubah|ganti)\b/i, "")
    .trim();

  if (!cleanText) return { nik: "", nama: "", digipos: "", newTele: "" };

  const ubahMatch = cleanText.match(/^(digipos|nama|teknisi|tele|telegram|nik)\s*[:=]?\s*(.+)$/i);
  if (ubahMatch && existingProfile) {
    const tipe = ubahMatch[1].toLowerCase();
    const nilai = ubahMatch[2].trim();
    return {
      nik: tipe === "nik" ? nilai : existingProfile.nik,
      nama: (tipe === "nama" || tipe === "teknisi") ? nilai : existingProfile.nama,
      digipos: tipe === "digipos" ? nilai : existingProfile.digipos,
      newTele: (tipe === "tele" || tipe === "telegram") ? (nilai.startsWith("@") ? nilai : "@" + nilai) : ""
    };
  }

  const labelRegex = /\s+((?:NO\.?\s*NIK|NOMOR\s+INDUK|NIK|NAMA\s+TEKNISI|NAMA\s+LENGKAP|NAMA|USERNAME\s+AKUN\s+DIGIPOS|USERNAME\s+DIGIPOS|AKUN\s+DIGIPOS|USER\s+DIGIPOS|DIGIPOS|TELEGRAM|USER\s+TELE)\s*[:=])/gi;
  cleanText = cleanText.replace(labelRegex, function(m, p) { return "\n" + p; });

  let nik = "";
  let nama = "";
  let digipos = "";
  let newTele = "";

  const lines = cleanText.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  let foundLabel = false;
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([a-zA-Z\s_.#-]{2,30})\s*[:=]\s*(.+)$/);
    if (kv) {
      foundLabel = true;
      const k = kv[1].toLowerCase().replace(/\s+/g, " ").trim();
      const v = kv[2].trim().replace(/\s*\d{1,2}[:.]\d{2}\s*$/, "");
      if (k.includes("nik")) nik = v;
      else if (k.includes("nama") || k.includes("teknisi")) nama = v;
      else if (k.includes("digipos") || k.includes("user")) digipos = v;
      else if (k.includes("tele")) newTele = v.startsWith("@") ? v : "@" + v;
    }
  }

  if (foundLabel && (nik || nama || digipos || newTele)) {
    return {
      nik: nik || (existingProfile ? existingProfile.nik : ""),
      nama: nama || (existingProfile ? existingProfile.nama : ""),
      digipos: digipos || (existingProfile ? existingProfile.digipos : ""),
      newTele: newTele
    };
  }

  const hasDelimiter = /[|/;,]/.test(cleanText);
  if (hasDelimiter) {
    const parts = cleanText
      .split(/[|/;,]+/)
      .map(s => s.trim().replace(/\s*\d{1,2}[:.]\d{2}\s*$/, ""))
      .filter(Boolean);
    if (parts.length >= 3) {
      return {
        nik: parts[0],
        nama: parts[1],
        digipos: parts[2],
        newTele: parts[3] ? (parts[3].startsWith("@") ? parts[3] : "@" + parts[3]) : ""
      };
    } else if (parts.length === 2) {
      return {
        nik: parts[0],
        nama: parts[1],
        digipos: "-",
        newTele: ""
      };
    }
  }

  const flat = cleanText.replace(/[|/;,]+/g, " ").replace(/\s*\d{1,2}[:.]\d{2}\s*$/, "").trim();
  const tokens = flat.split(/\s+/).filter(Boolean);

  if (tokens.length === 1 && existingProfile) {
    return {
      nik: existingProfile.nik,
      nama: existingProfile.nama,
      digipos: tokens[0],
      newTele: ""
    };
  }

  if (tokens.length >= 3) {
    const nikIdx = tokens.findIndex(t => /^\d{5,20}$/.test(t));
    if (nikIdx !== -1) {
      nik = tokens[nikIdx];
      const sisa = tokens.filter((_, i) => i !== nikIdx);
      digipos = sisa[sisa.length - 1];
      nama = sisa.slice(0, sisa.length - 1).join(" ");
      return { nik: nik, nama: nama, digipos: digipos, newTele: "" };
    }
  }

  return { nik: nik, nama: nama, digipos: digipos, newTele: "" };
}

/**
 * Memvalidasi kelengkapan data registrasi dan menyimpan pembaruan profil ke sheet TABEL.
 * @param {number|string} chatId ID chat tujuan notifikasi.
 * @param {string} telegramId ID Telegram pengguna.
 * @param {string} tgUsername Username Telegram pengirim saat ini.
 * @param {string} rawNik Nomor Induk Karyawan.
 * @param {string} rawNama Nama lengkap teknisi.
 * @param {string} rawDigipos Username akun Digipos (opsional).
 * @param {number} messageId ID pesan referensi balasan.
 * @param {string} newTele Username Telegram baru jika diperbarui.
 */
function prosesRegistrasi(chatId, telegramId, tgUsername, rawNik, rawNama, rawDigipos, messageId, newTele) {
  if (!rawNik && !rawNama && !rawDigipos && !newTele) {
    return kirimPanduanRegist(chatId, telegramId, tgUsername);
  }

  const existing = ambilProfilTeknisi(telegramId, tgUsername);

  let finalNik = rawNik;
  let finalNama = rawNama;
  let finalDigipos = rawDigipos;
  let finalTele = newTele || tgUsername;

  if (existing) {
    if (!finalNik) finalNik = existing.nik;
    if (!finalNama) finalNama = existing.nama;
    if (finalDigipos === undefined || finalDigipos === "") finalDigipos = existing.digipos;
  }

  if (finalDigipos === "-") finalDigipos = "";

  if (!finalNik || !finalNama) {
    return kirimPesan(
      chatId,
      "Format Registrasi Kurang Lengkap:\n" +
      "NIK dan Nama wajib diisi.\n\n" +
      "Contoh:\n" +
      "/regist 26870001 / BUDI SANTOSO / budi_digipos\n" +
      "(Jika tanpa digipos: /regist 26870001 / BUDI SANTOSO)",
      messageId
    );
  }

  const profilBaru = simpanProfilTeknisi(
    telegramId,
    finalTele,
    finalNik,
    finalNama,
    finalDigipos,
    finalTele
  );

  if (!profilBaru) {
    return kirimPesan(chatId, "Gagal memperbarui profil di Sheet TABEL.", messageId);
  }

  const pesan =
    "Profil Berhasil Diperbarui di Sheet TABEL:\n" +
    "- NIK: " + profilBaru.nik + "\n" +
    "- Nama: " + profilBaru.nama + "\n" +
    "- Digipos: " + (profilBaru.digipos && profilBaru.digipos !== "-" ? profilBaru.digipos : "(Belum ada)") + "\n" +
    "- Telegram: " + profilBaru.tgUsername + "\n\n" +
    "Data siap digunakan untuk input order harian.";

  return kirimPesan(chatId, pesan, messageId);
}

// 8. CEK DUPLIKASI ORDER (Dioptimasi: Scan Hanya Kolom SC & WO)
/**
 * Memindai kolom SC dan WO pada sheet `DATA BOT` dan `DATA MANUAL` guna
 * menghasilkan struktur Set pencarian cepat untuk deteksi duplikasi order.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheetBot Objek sheet DATA BOT.
 * @param {GoogleAppsScript.Spreadsheet.Sheet|null} sheetManual Objek sheet DATA MANUAL.
 * @return {{scSet: Object, woSet: Object}} Kamus kode SC dan WO yang sudah terdaftar.
 */
function ambilDaftarKodeTerdaftar(sheetBot, sheetManual) {
  const existingSc = new Set();
  const existingWo = new Set();

  function scanSheetTarget(sheet) {
    if (!sheet) return;
    const lastRow = sheet.getLastRow();
    const lastCol = sheet.getLastColumn();
    if (lastRow < 2 || lastCol < 1) return;

    const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h || "").toLowerCase().trim());
    const colSc = headers.findIndex(h => h.includes("sc"));
    const colWo = headers.findIndex(h => h.includes("wo"));

    // Membaca hanya 1 kolom SC secara terfokus
    if (colSc !== -1) {
      const scValues = sheet.getRange(2, colSc + 1, lastRow - 1, 1).getValues();
      for (let i = 0; i < scValues.length; i++) {
        const sc = String(scValues[i][0] || "").replace(/^'/, "").trim().toUpperCase();
        if (sc) existingSc.add(sc);
      }
    }

    // Membaca hanya 1 kolom WO secara terfokus
    if (colWo !== -1) {
      const woValues = sheet.getRange(2, colWo + 1, lastRow - 1, 1).getValues();
      for (let i = 0; i < woValues.length; i++) {
        const wo = String(woValues[i][0] || "").replace(/^'/, "").trim().toUpperCase();
        if (wo) existingWo.add(wo);
      }
    }
  }

  scanSheetTarget(sheetBot);
  scanSheetTarget(sheetManual);

  return { scSet: existingSc, woSet: existingWo };
}

// 9. PENYIMPANAN KE SHEET DATA BOT (Dengan LockService & Auto-Timezone WIB)
/**
 * Menyimpan daftar order valid ke sheet `DATA BOT` menggunakan penguncian LockService,
 * pengecekan duplikasi SC/WO, dan pencatatan waktu lokal Asia/Jakarta (WIB).
 * @param {number|string} chatId ID chat tujuan konfirmasi.
 * @param {Object} profil Profil identitas pemilik order.
 * @param {Array} orders Daftar order hasil ekstraksi parser.
 * @param {Array} parseErrors Daftar kendala parsing per baris apabila ada.
 * @param {number} messageId ID pesan referensi balasan.
 */
function simpanOrderKeSheet(chatId, profil, orders, parseErrors, messageId) {
  if ((!orders || orders.length === 0) && (!parseErrors || parseErrors.length === 0)) {
    return kirimPesan(
      chatId,
      "Format order tidak terbaca.\n" +
      "Contoh format:\n" +
      "PWK DGPS260802120146323868795 WO060711936\n" +
      "Atau:\n" +
      "Digipos : misall\n" +
      "PWK DGPS260802120146323868795 WO060711936",
      messageId
    );
  }

  if (parseErrors && parseErrors.length > 0) {
    let errText = "Data order ditolak:\n" + parseErrors.join("\n");
    return kirimPesan(chatId, errText, messageId);
  }

  // Pengunci Antrean (LockService) - Menghindari tabrakan baris saat jam sibuk
  const lock = LockService.getScriptLock();
  let hasLock = false;
  try {
    hasLock = lock.tryLock(15000);
  } catch (errLock) {
    hasLock = false;
  }

  if (!hasLock) {
    return kirimPesan(
      chatId,
      "[PERINGATAN] Server sedang sibuk menerima banyak order serentak. Mohon kirim ulang dalam 5 detik.",
      messageId
    );
  }

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheetBot = getSheetBot(ss);
    const sheetManual = getSheetManual(ss);

    const existingCodes = ambilDaftarKodeTerdaftar(sheetBot, sheetManual);

    const ordersBaru = [];
    const ordersDuplikat = [];
    const batchSc = new Set();
    const batchWo = new Set();

    for (let i = 0; i < orders.length; i++) {
      const o = orders[i];
      let alasanDuplikat = "";

      if (existingCodes.scSet.has(o.sc) || batchSc.has(o.sc)) {
        alasanDuplikat = "SC " + o.sc;
      } else if (existingCodes.woSet.has(o.wo) || batchWo.has(o.wo)) {
        alasanDuplikat = "WO " + o.wo;
      }

      if (alasanDuplikat) {
        ordersDuplikat.push({
          sto: o.sto,
          sc: o.sc,
          wo: o.wo,
          alasan: alasanDuplikat
        });
      } else {
        ordersBaru.push(o);
        batchSc.add(o.sc);
        batchWo.add(o.wo);
      }
    }

    if (ordersBaru.length === 0) {
      let msgDup = "Ditolak (Data sudah pernah diinput sebelumnya):\n";
      for (let d of ordersDuplikat) {
        msgDup += "- [" + d.sto + "] SC: " + d.sc + " | WO: " + d.wo + "\n";
      }
      return kirimPesan(chatId, msgDup.trim(), messageId);
    }

    // Waktu Akurat 100% Mengikuti WIB (Asia/Jakarta)
    const now = new Date();
    const tanggalInput = Utilities.formatDate(now, "Asia/Jakarta", "dd/MM/yyyy");
    const bulanIndex = parseInt(Utilities.formatDate(now, "Asia/Jakarta", "M"), 10) - 1;
    const namaBulan = NAMA_BULAN[bulanIndex];

    const lastCol = sheetBot.getLastColumn();
    const headers = sheetBot.getRange(1, 1, 1, lastCol).getValues()[0];

    const rowsToAppend = [];
    for (let i = 0; i < ordersBaru.length; i++) {
      const o = ordersBaru[i];
      const row = new Array(headers.length).fill("");

      for (let c = 0; c < headers.length; c++) {
        const h = String(headers[c] || "").toLowerCase().trim();
        if (h.includes("tanggal") || h.includes("tgl")) {
          row[c] = tanggalInput;
        } else if (h.includes("nik")) {
          row[c] = "'" + profil.nik;
        } else if (h.includes("nama") || h.includes("teknisi")) {
          row[c] = profil.nama;
        } else if (h.includes("stream")) {
          row[c] = profil.stream || "-";
        } else if (h.includes("digipos")) {
          row[c] = profil.digipos && profil.digipos !== "-" ? profil.digipos : "-";
        } else if (h.includes("tele")) {
          row[c] = profil.tgUsername || "-";
        } else if (h.includes("sto") || h.includes("area")) {
          row[c] = o.sto;
        } else if (h.includes("sc")) {
          row[c] = "'" + o.sc;
        } else if (h.includes("wo")) {
          row[c] = "'" + o.wo;
        } else if (h.includes("bulan")) {
          row[c] = namaBulan;
        }
      }
      rowsToAppend.push(row);
    }

    const startRow = sheetBot.getLastRow() + 1;
    sheetBot.getRange(startRow, 1, rowsToAppend.length, headers.length).setValues(rowsToAppend);
    SpreadsheetApp.flush(); // Memastikan penulisan tuntas sebelum membuka kunci antrean

    let infoTeknisi = profil.nama;
    if (profil.diinputOleh) {
      infoTeknisi += " (diinput oleh " + profil.diinputOleh + ")";
    }

    let msg = "";
    if (ordersBaru.length === 1) {
      const o = ordersBaru[0];
      msg = "Tersimpan [" + o.sto + "]\n" +
            "SC: " + o.sc + "\n" +
            "WO: " + o.wo + "\n" +
            "Teknisi: " + infoTeknisi;
    } else {
      msg = "Tersimpan (" + ordersBaru.length + " Order - " + infoTeknisi + "):\n";
      for (let i = 0; i < ordersBaru.length; i++) {
        const o = ordersBaru[i];
        msg += (i + 1) + ". [" + o.sto + "] SC: " + o.sc + " | WO: " + o.wo + "\n";
      }
    }

    if (ordersDuplikat.length > 0) {
      msg += "\nPerhatian: " + ordersDuplikat.length + " Order dilewati karena sudah ada:\n";
      for (let d of ordersDuplikat) {
        msg += "- [" + d.sto + "] " + d.sc + "\n";
      }
    }

    return kirimPesan(chatId, msg.trim(), messageId);

  } finally {
    if (hasLock) {
      lock.releaseLock();
    }
  }
}

// 10. MANAJEMEN SHEET & DATABASE TEKNISI
/**
 * Mengambil objek sheet `DATA BOT` atau menginisialisasi sheet beserta header standarnya.
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss Objek Spreadsheet aktif.
 * @return {GoogleAppsScript.Spreadsheet.Sheet} Objek sheet DATA BOT.
 */
function getSheetBot(ss) {
  if (!ss) ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(NAMA_SHEET_BOT) || ss.getSheetByName("DATA_BOT") || ss.getSheetByName("Data Bot");
  if (!sheet) {
    sheet = ss.insertSheet(NAMA_SHEET_BOT);
  }

  if (sheet.getLastRow() === 0) {
    const sheetManual = getSheetManual(ss);
    if (sheetManual && sheetManual.getLastRow() >= 1) {
      const manualHeaders = sheetManual.getRange(1, 1, 1, sheetManual.getLastColumn()).getValues()[0];
      sheet.getRange(1, 1, 1, manualHeaders.length).setValues([manualHeaders]);
    } else {
      const defaultHeaders = [
        "TANGGAL INPUT",
        "NIK",
        "NAMA TEKNISI",
        "Username Akun Digipos",
        "Username Telegram",
        "STO",
        "NO SC",
        "NO WO",
        "BULAN"
      ];
      sheet.getRange(1, 1, 1, defaultHeaders.length).setValues([defaultHeaders]);
    }
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/**
 * Mengambil objek sheet `DATA MANUAL` jika tersedia pada Spreadsheet aktif.
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss Objek Spreadsheet aktif.
 * @return {GoogleAppsScript.Spreadsheet.Sheet|null} Objek sheet DATA MANUAL atau null.
 */
function getSheetManual(ss) {
  if (!ss) ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(NAMA_SHEET_MANUAL) ||
         ss.getSheetByName("DATA_MANUAL") ||
         ss.getSheetByName("Data Manual") ||
         ss.getSheetByName("MANUAL");
}

/**
 * Mengambil objek sheet `TABEL` atau membuat struktur master teknisi default jika belum ada.
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss Objek Spreadsheet aktif.
 * @return {GoogleAppsScript.Spreadsheet.Sheet} Objek sheet TABEL.
 */
function getSheetTabel(ss) {
  if (!ss) ss = SpreadsheetApp.getActiveSpreadsheet();
  const possibleNames = ["TABEL", "LABEL", "Tabel", "Label", "Sheet Label", "SHEET LABEL", "DATA TABEL"];
  for (let name of possibleNames) {
    const s = ss.getSheetByName(name);
    if (s) {
      if (s.getLastRow() === 0) {
        isiDefaultSheetTabel(s);
      }
      return s;
    }
  }

  const sheet = ss.insertSheet("TABEL");
  isiDefaultSheetTabel(sheet);
  return sheet;
}

/**
 * Mengisi sheet `TABEL` dengan data bawaan dari konstanta `DAFTAR_TEKNISI_DEFAULT` apabila tersedia.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet Objek sheet TABEL.
 */
function isiDefaultSheetTabel(sheet) {
  sheet.getRange(1, 1, 1, 7).setValues([[
    "NO", "NIK", "NAMA TEKNISI", "STREAM", "USER TELE", "USER DIGIPOS", "TELEGRAM ID"
  ]]);

  const rows = DAFTAR_TEKNISI_DEFAULT.map(t => [
    t.no,
    "'" + t.nik,
    t.nama,
    t.stream,
    t.tele,
    t.digipos,
    ""
  ]);

  if (rows.length > 0) {
    sheet.getRange(2, 1, rows.length, 7).setValues(rows);
  }
  sheet.setFrozenRows(1);
}

/**
 * Memetakan indeks kolom dinamis pada header sheet `TABEL` secara case-insensitive.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet Objek sheet TABEL.
 * @return {Object} Pemetaan indeks kolom beserta data baris pada sheet TABEL.
 */
function ambilInfoTabel(sheet) {
  if (!sheet) sheet = getSheetTabel();
  const lastRow = sheet.getLastRow();
  const lastCol = Math.max(sheet.getLastColumn(), 6);
  if (lastRow < 2) return null;

  const data = sheet.getRange(1, 1, lastRow, lastCol).getValues();

  let headerRowIdx = -1;
  for (let r = 0; r < Math.min(data.length, 6); r++) {
    const rowStr = data[r].map(c => String(c || "")).join(" ").toLowerCase();
    if (rowStr.includes("nik") && (rowStr.includes("nama") || rowStr.includes("tele") || rowStr.includes("stream"))) {
      headerRowIdx = r;
      break;
    }
  }

  if (headerRowIdx === -1) headerRowIdx = 0;

  const rawHeaders = data[headerRowIdx].map(h => String(h || "").toLowerCase().trim());
  let colNo = rawHeaders.findIndex(h => h === "no" || h === "nomor");
  let colNik = rawHeaders.findIndex(h => h.includes("nik"));
  let colNama = rawHeaders.findIndex(h => h.includes("nama"));
  let colStream = rawHeaders.findIndex(h => h.includes("stream"));
  let colTele = rawHeaders.findIndex(h => h.includes("tele") && !h.includes("id"));
  let colDigipos = rawHeaders.findIndex(h => h.includes("digipos"));
  let colTeleId = rawHeaders.findIndex(h => h.includes("id") || h.includes("chat"));

  if (colNo === -1) colNo = 0;
  if (colNik === -1) colNik = 1;
  if (colNama === -1) colNama = 2;
  if (colStream === -1) colStream = 3;
  if (colTele === -1) colTele = 4;
  if (colDigipos === -1) colDigipos = 5;

  return {
    sheet: sheet,
    data: data,
    lastRow: lastRow,
    lastCol: lastCol,
    headerRowIdx: headerRowIdx,
    colNo: colNo,
    colNik: colNik,
    colNama: colNama,
    colStream: colStream,
    colTele: colTele,
    colDigipos: colDigipos,
    colTeleId: colTeleId
  };
}

/**
 * Mencari profil teknisi pada sheet `TABEL` berdasarkan Telegram ID atau username Telegram.
 * @param {string} telegramId ID unik pengguna Telegram.
 * @param {string} tgUsername Username Telegram pengguna.
 * @return {Object|null} Objek profil teknisi atau null jika belum terdaftar.
 */
function ambilProfilTeknisi(telegramId, tgUsername) {
  const sheet = getSheetTabel();
  const info = ambilInfoTabel(sheet);
  if (!info) return null;

  const data = info.data;
  const cleanCurrentId = String(telegramId || "").replace(/['\s]/g, "");
  const cleanCurrentTgUser = String(tgUsername || "").replace(/[@\s]/g, "").toLowerCase();

  for (let i = info.headerRowIdx + 1; i < data.length; i++) {
    const row = data[i];
    const leftText = [row[0], row[1], row[2], row[3]].map(c => String(c || "").trim().toLowerCase());
    if (leftText.includes("total") || leftText.includes("jumlah")) continue;

    const rowNik = String(row[info.colNik] || "").replace(/^'/, "").trim();
    const rowNama = String(row[info.colNama] || "").trim();
    const rowStream = info.colStream !== -1 ? String(row[info.colStream] || "").trim() : "";
    const rawRowTele = info.colTele !== -1 ? String(row[info.colTele] || "").trim() : "";
    const rowTeleUser = rawRowTele.replace(/[@\s]/g, "").toLowerCase();
    const rowDigipos = info.colDigipos !== -1 ? String(row[info.colDigipos] || "").trim() : "";
    const rowTeleId = (info.colTeleId !== -1 && row[info.colTeleId]) ? String(row[info.colTeleId]).replace(/['\s]/g, "") : "";

    const matchUser = cleanCurrentTgUser && rowTeleUser && (rowTeleUser === cleanCurrentTgUser);
    const matchId = cleanCurrentId && rowTeleId && (rowTeleId === cleanCurrentId);

    if (matchUser || matchId) {
      if (cleanCurrentId && (!rowTeleId || rowTeleId !== cleanCurrentId) && info.colTeleId !== -1) {
        sheet.getRange(i + 1, info.colTeleId + 1).setValue("'" + cleanCurrentId);
      }
      return {
        row: i + 1,
        nik: rowNik,
        nama: rowNama,
        stream: rowStream,
        digipos: rowDigipos && rowDigipos !== "-" ? rowDigipos : "-",
        tgUsername: rawRowTele ? (rawRowTele.startsWith("@") ? rawRowTele : "@" + rawRowTele) : tgUsername,
        telegramId: cleanCurrentId || rowTeleId
      };
    }
  }

  return null;
}

/**
 * Mencari profil teknisi pada sheet `TABEL` berdasarkan kecocokan persis NIK atau kemiripan Nama.
 * @param {string} digipos Username Digipos (disimpan apa adanya).
 * @param {string} nik Nomor Induk Karyawan kandidat.
 * @param {string} nama Nama lengkap teknisi kandidat.
 * @return {Object|null} Objek profil teknisi yang cocok atau null.
 */
function cariTeknisiDiTabel(digipos, nik, nama) {
  const sheet = getSheetTabel();
  const info = ambilInfoTabel(sheet);
  if (!info) return null;

  const data = info.data;
  const cleanNik = String(nik || "").replace(/['\s]/g, "").toLowerCase();
  const cleanNama = String(nama || "").trim().toLowerCase();

  // Pencarian teknisi HANYA via NIK atau Nama agar Digipos bebas diisi apa saja
  for (let i = info.headerRowIdx + 1; i < data.length; i++) {
    const row = data[i];
    const leftText = [row[0], row[1], row[2], row[3]].map(c => String(c || "").trim().toLowerCase());
    if (leftText.includes("total") || leftText.includes("jumlah")) continue;

    const rowNik = String(row[info.colNik] || "").replace(/['\s]/g, "").toLowerCase();
    const rowNama = String(row[info.colNama] || "").trim().toLowerCase();
    const rowStream = info.colStream !== -1 ? String(row[info.colStream] || "").trim() : "";
    const rawRowTele = info.colTele !== -1 ? String(row[info.colTele] || "").trim() : "";

    const matchNik = cleanNik && rowNik && (rowNik === cleanNik);
    const matchNama = cleanNama && rowNama && (rowNama.includes(cleanNama) || cleanNama.includes(rowNama));

    if (matchNik || matchNama) {
      return {
        row: i + 1,
        nik: String(row[info.colNik] || "").replace(/^'/, "").trim(),
        nama: String(row[info.colNama] || "").trim(),
        stream: rowStream,
        digipos: digipos || String(row[info.colDigipos] || "").trim() || "-",
        tgUsername: rawRowTele ? (rawRowTele.startsWith("@") ? rawRowTele : "@" + rawRowTele) : ""
      };
    }
  }

  return null;
}

/**
 * Memperbarui baris profil teknisi yang sudah ada pada sheet `TABEL` atau menambahkan baris baru.
 * @param {string} telegramId ID unik pengguna Telegram.
 * @param {string} tgUsername Username Telegram aktif.
 * @param {string} nik Nomor Induk Karyawan.
 * @param {string} nama Nama lengkap teknisi.
 * @param {string} digipos Username akun Digipos.
 * @param {string} newTele Username Telegram baru (opsional).
 * @return {Object} Profil tersimpan hasil pembaruan.
 */
function simpanProfilTeknisi(telegramId, tgUsername, nik, nama, digipos, newTele) {
  const sheet = getSheetTabel();
  const info = ambilInfoTabel(sheet);
  if (!info) return null;

  const data = info.data;
  const cleanCurrentId = String(telegramId || "").replace(/['\s]/g, "");
  const cleanCurrentTgUser = String(tgUsername || "").replace(/[@\s]/g, "").toLowerCase();
  const cleanNewNik = String(nik || "").replace(/['\s]/g, "").toLowerCase();

  let foundRow = -1;
  let streamExisting = "";

  for (let i = info.headerRowIdx + 1; i < data.length; i++) {
    const row = data[i];
    const leftText = [row[0], row[1], row[2], row[3]].map(c => String(c || "").trim().toLowerCase());
    if (leftText.includes("total") || leftText.includes("jumlah")) continue;

    const rowNik = String(row[info.colNik] || "").replace(/['\s]/g, "").toLowerCase();
    const rowTeleUser = info.colTele !== -1 ? String(row[info.colTele] || "").replace(/[@\s]/g, "").toLowerCase() : "";
    const rowTeleId = (info.colTeleId !== -1 && row[info.colTeleId]) ? String(row[info.colTeleId]).replace(/['\s]/g, "") : "";

    const matchUser = cleanCurrentTgUser && rowTeleUser && (rowTeleUser === cleanCurrentTgUser);
    const matchId = cleanCurrentId && rowTeleId && (rowTeleId === cleanCurrentId);
    const matchNik = cleanNewNik && rowNik && (rowNik === cleanNewNik);

    if (matchUser || matchId || matchNik) {
      foundRow = i + 1;
      streamExisting = info.colStream !== -1 ? String(row[info.colStream] || "").trim() : "";
      break;
    }
  }

  const cleanNikVal = String(nik || "").replace(/^'/, "").trim();
  const cleanNamaVal = String(nama || "").trim().toUpperCase();
  const cleanDigiposVal = String(digipos || "").trim();
  const cleanTgUserVal = String(newTele || tgUsername || "").trim();

  if (foundRow !== -1) {
    if (cleanNikVal) sheet.getRange(foundRow, info.colNik + 1).setValue("'" + cleanNikVal);
    if (cleanNamaVal) sheet.getRange(foundRow, info.colNama + 1).setValue(cleanNamaVal);
    if (cleanDigiposVal) sheet.getRange(foundRow, info.colDigipos + 1).setValue(cleanDigiposVal);
    if (cleanTgUserVal && info.colTele !== -1) sheet.getRange(foundRow, info.colTele + 1).setValue(cleanTgUserVal);
    if (cleanCurrentId && info.colTeleId !== -1) sheet.getRange(foundRow, info.colTeleId + 1).setValue("'" + cleanCurrentId);
  } else {
    let totalRow = -1;
    for (let r = info.headerRowIdx + 1; r < data.length; r++) {
      const row = data[r];
      const leftText = [row[0], row[1], row[2], row[3]].map(c => String(c || "").trim().toLowerCase());
      if (leftText.includes("total") || leftText.includes("jumlah")) {
        totalRow = r + 1;
        break;
      }
    }

    const fullCols = Math.max(sheet.getLastColumn(), info.lastCol);

    if (totalRow !== -1) {
      sheet.insertRowBefore(totalRow);
      const targetRow = totalRow;

      const prevNo = Number(sheet.getRange(targetRow - 1, info.colNo + 1).getValue());
      const nextNo = (!isNaN(prevNo) && prevNo > 0) ? prevNo + 1 : (targetRow - info.headerRowIdx - 1);

      const newRow = new Array(fullCols).fill("");
      newRow[info.colNo] = nextNo;
      newRow[info.colNik] = "'" + cleanNikVal;
      newRow[info.colNama] = cleanNamaVal;
      if (info.colStream !== -1) newRow[info.colStream] = "Teknisi";
      if (info.colTele !== -1) newRow[info.colTele] = cleanTgUserVal;
      if (info.colDigipos !== -1) newRow[info.colDigipos] = cleanDigiposVal;
      if (info.colTeleId !== -1) newRow[info.colTeleId] = "'" + cleanCurrentId;

      sheet.getRange(targetRow, 1, 1, fullCols).setValues([newRow]);

      try {
        const rowAbove = sheet.getRange(targetRow - 1, 1, 1, fullCols);
        rowAbove.copyTo(sheet.getRange(targetRow, 1, 1, fullCols), SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
      } catch (e) {}

    } else {
      const targetRow = sheet.getLastRow() + 1;
      const prevNo = Number(sheet.getRange(targetRow - 1, info.colNo + 1).getValue());
      const nextNo = (!isNaN(prevNo) && prevNo > 0) ? prevNo + 1 : (targetRow - info.headerRowIdx - 1);

      const newRow = new Array(fullCols).fill("");
      newRow[info.colNo] = nextNo;
      newRow[info.colNik] = "'" + cleanNikVal;
      newRow[info.colNama] = cleanNamaVal;
      if (info.colStream !== -1) newRow[info.colStream] = "Teknisi";
      if (info.colTele !== -1) newRow[info.colTele] = cleanTgUserVal;
      if (info.colDigipos !== -1) newRow[info.colDigipos] = cleanDigiposVal;
      if (info.colTeleId !== -1) newRow[info.colTeleId] = "'" + cleanCurrentId;

      sheet.appendRow(newRow);
    }
  }

  return {
    nik: cleanNikVal,
    nama: cleanNamaVal,
    stream: streamExisting || "Teknisi",
    digipos: cleanDigiposVal || "-",
    tgUsername: cleanTgUserVal,
    telegramId: cleanCurrentId
  };
}

// 11. PANDUAN DAN PENGIRIMAN PESAN KE TELEGRAM
/**
 * Mengirimkan panduan tata cara input order, contoh format pesan, dan daftar perintah bot.
 * @param {number|string} chatId ID chat tujuan pengiriman panduan.
 * @param {string} telegramId ID pengguna Telegram.
 * @param {string} tgUsername Username pengguna Telegram.
 */
function kirimPanduan(chatId, telegramId, tgUsername) {
  const profil = ambilProfilTeknisi(telegramId, tgUsername);
  let pesan = "";

  if (profil) {
    pesan =
      "Halo " + profil.nama + "!\n\n" +
      "Status Profil Terhubung:\n" +
      "- NIK: " + profil.nik + "\n" +
      "- Stream: " + (profil.stream || "-") + "\n" +
      "- Digipos: " + (profil.digipos !== "-" ? profil.digipos : "Belum diisi") + "\n\n" +
      "Panduan Input Order:\n\n" +
      "1. Input Cepat (1 atau Banyak Baris Sekaligus):\n" +
      "PWK DGPS260802120146323868801 WO060711901\n" +
      "PWK DGPS260802120146323868802 WO060711902\n\n" +
      "2. Dengan Akun Digipos Lain (Bebas):\n" +
      "Digipos : CONTOH_DIGIPOS_01\n" +
      "STO : PWK\n" +
      "NO SC : DGPS261007113521346628010\n" +
      "NO WO : WO065923958\n\n" +
      "3. Bantu Inputkan Teman:\n" +
      "NAMA : ATA\n" +
      "PWK DGPS260802120146323868801 WO060711901\n\n" +
      "Perintah Lain:\n" +
      "- /profil - Cek data akun Anda\n" +
      "- /ubah - Panduan ganti Nama / Digipos / Tele";
  } else {
    pesan =
      "Akun Telegram Anda (" + tgUsername + ") belum terdaftar di Sheet TABEL.\n\n" +
      "Cara Mendaftar:\n" +
      "/regist NIK / NAMA / USERNAME_DIGIPOS\n" +
      "Contoh: /regist 26870001 / BUDI SANTOSO";
  }

  return kirimPesan(chatId, pesan);
}

/**
 * Mengirimkan panduan khusus cara registrasi baru maupun pembaruan data akun teknisi.
 * @param {number|string} chatId ID chat tujuan.
 * @param {string} telegramId ID pengguna Telegram.
 * @param {string} tgUsername Username pengguna Telegram.
 */
function kirimPanduanRegist(chatId, telegramId, tgUsername) {
  const profil = ambilProfilTeknisi(telegramId, tgUsername);
  let pesan = "";

  if (profil) {
    pesan =
      "Panduan Ubah Data:\n" +
      "Profil Anda (" + profil.nama + " | NIK: " + profil.nik + ") aktif di Sheet TABEL.\n\n" +
      "Pilihan Perintah:\n" +
      "- Ganti Nama: /ubah nama <nama_baru>\n" +
      "- Ganti Digipos: /ubah digipos <akun_baru>\n" +
      "- Ganti Telegram: /ubah tele <@user_tele>\n" +
      "- Update Lengkap: /update NIK / NAMA / DIGIPOS";
  } else {
    pesan =
      "Format Registrasi Baru:\n" +
      "/regist NIK / NAMA / USERNAME_DIGIPOS\n" +
      "Contoh: /regist 26870001 / BUDI SANTOSO / budi_digipos";
  }

  return kirimPesan(chatId, pesan);
}

/**
 * Mengirimkan detail informasi profil teknisi yang terdaftar di sistem melalui Telegram.
 * @param {number|string} chatId ID chat tujuan.
 * @param {string} telegramId ID pengguna Telegram.
 * @param {string} tgUsername Username pengguna Telegram.
 */
function cekProfilTeknisi(chatId, telegramId, tgUsername) {
  const profil = ambilProfilTeknisi(telegramId, tgUsername);
  if (!profil) {
    return kirimPesan(
      chatId,
      "Akun Anda (" + tgUsername + ") belum terdaftar di Sheet TABEL.\n" +
      "Ketik /regist untuk mendaftar."
    );
  }
  const pesan =
    "Profil Teknisi Terdaftar:\n\n" +
    "- NIK: " + profil.nik + "\n" +
    "- Nama: " + profil.nama + "\n" +
    "- Stream: " + (profil.stream || "-") + "\n" +
    "- Digipos: " + (profil.digipos !== "-" ? profil.digipos : "Belum diisi") + "\n" +
    "- Telegram: " + profil.tgUsername + "\n\n" +
    "Status: Terhubung aktif ke Sheet TABEL.";
  return kirimPesan(chatId, pesan);
}

/**
 * Mengirimkan pesan balasan teks melalui Telegram Bot API `sendMessage`.
 * @param {number|string} chatId ID chat tujuan.
 * @param {string} text Isi teks pesan.
 * @param {number} [replyToMsgId] ID pesan referensi apabila dikirim sebagai balasan.
 */
function kirimPesan(chatId, text, replyToMsgId) {
  const url = "https://api.telegram.org/bot" + BOT_TOKEN + "/sendMessage";
  const payload = {
    chat_id: String(chatId),
    text: text
  };
  if (replyToMsgId) {
    payload.reply_to_message_id = replyToMsgId;
  }
  const options = {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };
  return UrlFetchApp.fetch(url, options);
}