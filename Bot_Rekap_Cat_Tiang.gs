/**
 * ============================================================================
 * BOT TELEGRAM EVIDENSI CAT TIANG BERBASIS AI VISION (GOOGLE APPS SCRIPT)
 * ============================================================================
 * @file        Bot_Rekap_Cat_Tiang.gs
 * @author      M Rislan Tristansyah
 * @platform    Google Apps Script, Google Drive, Google Sheets, Telegram Bot API
 * @version     13.0 (Drive Staging Architecture & Cascading Vision AI)
 * @description Sistem otomasi pelaporan evidensi pengecatan tiang jaringan
 *              melalui bot Telegram dengan dukungan penyimpanan sementara
 *              (staging) per pengguna di Google Drive, klasifikasi 4 kategori
 *              foto menggunakan Multi-Provider Vision AI (Gemini & OpenRouter),
 *              serta penyusunan bukti gambar langsung ke Google Spreadsheet.
 *
 * Arsitektur Utama:
 * 1. Isolasi Staging per Pengguna di Google Drive:
 *    - Foto yang dikirimkan disimpan sementara pada subfolder terisolasi
 *      `EVIDENSI_CAT_TIANG / STAGING_<userId>` agar antar teknisi tidak tertukar.
 * 2. Mekanisme Multi-Posisi Caption:
 *    - Caption validasi dapat diletakkan pada foto awal, foto akhir, atau
 *      pesan teks terpisah sebelum maupun sesudah pengiriman foto album.
 * 3. Seleksi Otomatis 4 Slot Foto Terbaik (2-Pass Allocation):
 *    - Model Vision AI mengklasifikasikan foto menjadi:
 *      * SEBELUM (Kondisi awal / tangga / tampak jauh)
 *      * SESUDAH (Kondisi tiang setelah pengecatan)
 *      * ODP (Kotak Optical Distribution Point)
 *      * MARKING_LABEL (Penandaan / stensil label tiang)
 * 4. Pembersihan Storage Otomatis & Tata Letak Grid Presisi:
 *    - Maksimal 4 foto terpilih dipindahkan ke folder arsip tiang, sedangkan
 *      folder staging dibersihkan otomatis setelah pemrosesan selesai.
 * ============================================================================
 */

// ----------------------------------------------------------------------------
// KONFIGURASI SISTEM DAN KREDENSIAL
// ----------------------------------------------------------------------------

/**
 * Objek konfigurasi utama. Seluruh nilai sensitif dibaca melalui
 * `PropertiesService.getScriptProperties()` dengan nilai bawaan string kosong
 * demi keamanan saat dipublikasikan ke repositori kode sumber.
 */
var CONFIG = {
  /** @type {string} Versi sistem saat ini. */
  VERSION: "13.0",

  /** @type {string} Username referensi bot Telegram (opsional untuk tampilan). */
  BOT_USERNAME: PropertiesService.getScriptProperties().getProperty("BOT_USERNAME") || "@BotEvidensiAnda",

  /** @type {string} Token Bot Telegram dari @BotFather. */
  TELEGRAM_TOKEN: PropertiesService.getScriptProperties().getProperty("TELEGRAM_TOKEN") || "",

  /** @type {string} API Key Google AI Studio (Gemini) sebagai provider utama. */
  GEMINI_API_KEY: PropertiesService.getScriptProperties().getProperty("GEMINI_API_KEY") || "",

  /** @type {string} API Key OpenRouter sebagai jalur cadangan (fallback). */
  OPENROUTER_API_KEY: PropertiesService.getScriptProperties().getProperty("OPENROUTER_API_KEY") || "",

  /** @type {string} API Key Groq untuk cadangan tambahan di masa mendatang. */
  GROQ_API_KEY: PropertiesService.getScriptProperties().getProperty("GROQ_API_KEY") || "",

  /** @type {string} ID Google Spreadsheet target rekapan evidensi cat tiang. */
  SPREADSHEET_ID: PropertiesService.getScriptProperties().getProperty("SPREADSHEET_ID") || "",

  /** @type {string} Nama tab sheet pada Spreadsheet target. */
  SHEET_NAME: "REKAPAN CAT TIANG",

  /** @type {string} Nama folder induk di Google Drive untuk arsip dan staging foto. */
  DRIVE_ROOT_FOLDER: "EVIDENSI_CAT_TIANG"
};

/**
 * Daftar model Vision AI yang dipanggil secara beruntun (cascading fallback)
 * apabila model utama mengalami batas kuota atau gangguan layanan.
 * @type {Array<{provider: string, model: string}>}
 */
var AI_MODEL_CHAIN = [
  { provider: "GEMINI", model: "gemini-3.5-flash-lite" },
  { provider: "GEMINI", model: "gemini-2.5-flash-lite" },
  { provider: "GEMINI", model: "gemini-3.5-flash" },
  { provider: "GEMINI", model: "gemini-2.5-flash" },
  { provider: "GEMINI", model: "gemini-flash-latest" },
  { provider: "OPENROUTER", model: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free" },
  { provider: "OPENROUTER", model: "google/gemma-4-26b-a4b-it:free" },
  { provider: "OPENROUTER", model: "google/gemma-4-31b-it:free" }
];


// ================= MANAJEMEN SESI & CAPTION SEMENTARA =================
var SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 Menit

/**
 * Mengambil status sesi aktif pengiriman foto milik pengguna dari CacheService.
 * @param {number|string} userId ID unik pengguna Telegram.
 * @return {Object|null} Objek sesi aktif atau null apabila tidak ada sesi.
 */
function getUserSession(userId) {
  try {
    var raw = PropertiesService.getScriptProperties().getProperty("ACTIVE_TIANG_" + userId);
    if (!raw) return null;
    var sess = JSON.parse(raw);
    if (Date.now() - (sess.updatedAt || 0) < SESSION_TIMEOUT_MS) {
      return sess;
    }
  } catch (e) {}
  return null;
}

/**
 * Menyimpan objek sesi aktif pengguna ke CacheService selama 1 jam.
 * @param {number|string} userId ID unik pengguna Telegram.
 * @param {Object} session Data metadata dan baris target spreadsheet.
 */
function saveUserSession(userId, session) {
  try {
    session.updatedAt = Date.now();
    PropertiesService.getScriptProperties().setProperty("ACTIVE_TIANG_" + userId, JSON.stringify(session));
  } catch (e) {}
}

/**
 * Menghapus sesi aktif pengguna dari CacheService.
 * @param {number|string} userId ID unik pengguna Telegram.
 */
function clearUserSession(userId) {
  try {
    PropertiesService.getScriptProperties().deleteProperty("ACTIVE_TIANG_" + userId);
  } catch (e) {}
}

/**
 * Mengambil caption validasi tertunda milik pengguna dari CacheService.
 * @param {number|string} userId ID unik pengguna Telegram.
 * @return {string|null} Teks caption atau null jika tidak tersedia.
 */
function getPendingCaption(userId) {
  try {
    return PropertiesService.getScriptProperties().getProperty("PENDING_CAP_" + userId) || "";
  } catch (e) {
    return "";
  }
}

/**
 * Menyimpan sementara teks caption validasi ke CacheService selama 3 menit.
 * @param {number|string} userId ID unik pengguna Telegram.
 * @param {string} cap Teks caption validasi tiang.
 */
function setPendingCaption(userId, cap) {
  try {
    PropertiesService.getScriptProperties().setProperty("PENDING_CAP_" + userId, cap);
  } catch (e) {}
}

/**
 * Menghapus caption validasi tertunda dari CacheService.
 * @param {number|string} userId ID unik pengguna Telegram.
 */
function clearPendingCaption(userId) {
  try {
    PropertiesService.getScriptProperties().deleteProperty("PENDING_CAP_" + userId);
  } catch (e) {}
}

// ================= DETEKSI LAPORAN VALINS / EXPAND ODP =================
/**
 * Memeriksa apakah pesan termasuk laporan Valins atau Expand ODP yang harus diabaikan.
 * @param {string} text Teks pesan atau caption Telegram.
 * @return {boolean} Bernilai true apabila pesan merupakan laporan Valins/Expand ODP.
 */
function isValinsOrExpand(text) {
  if (!text) return false;
  var t = text.toUpperCase();
  var keywords = [
    "EXPAND", "VALINS", "PORT_ODP", "IP OLT", "ONU_ID", "ONU_SN", 
    "ONU RX", "POWER CHECKING", "DROPCORE", "QR-CODE", "SUMMARY ODP", 
    "PANEL01", "PORT_ODP|ONU_ID"
  ];
  return keywords.some(function(k) { return t.indexOf(k) !== -1; });
}

// ================= DETEKSI CAPTION VALIDASI =================
/**
 * Menentukan apakah sebuah string mengandung pola metadata validasi tiang atau ODP.
 * @param {string} str Teks pesan kandidat caption.
 * @return {boolean} Bernilai true apabila mengandung kata kunci validasi yang valid.
 */
function isValidationCaption(str) {
  if (!str) return false;
  if (isValinsOrExpand(str)) return false; // Abaikan jika ini laporan Expand / Valins
  var s = str.toUpperCase();
  if (s.indexOf("VALIDASI") !== -1 || s.indexOf("TIANG") !== -1 || s.indexOf("ODP") !== -1 || s.indexOf("INC") !== -1) {
    return true;
  }
  if (/\b[A-Z0-9]{2,5}-[A-Z0-9]{2,5}-\d{1,5}\b/i.test(str)) return true;
  if (/\bODP-[A-Z0-9\-\/]+\b/i.test(str)) return true;
  if (/\bINC\d{6,12}\b/i.test(str)) return true;
  return false;
}

// ================= ENDPOINT DIAGNOSTIK BROWSER (doGet) =================
/**
 * Endpoint HTTP GET untuk pemeriksaan diagnostik koneksi Spreadsheet dan Bot.
 * @param {GoogleAppsScript.Events.DoGet} e Objek event permintaan GET.
 * @return {GoogleAppsScript.Content.TextOutput} Respons JSON diagnostik sistem.
 */
function doGet(e) {
  var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  var output = {
    status: "ONLINE",
    version: CONFIG.VERSION,
    architecture: "Drive Staging & Auto-Clean",
    botUsername: CONFIG.BOT_USERNAME,
    spreadsheet: ss.getName(),
    timestamp: new Date().toISOString()
  };

  return ContentService.createTextOutput(JSON.stringify(output, null, 2))
    .setMimeType(ContentService.MimeType.JSON);
}

// ================= WEBHOOK TELEGRAM (doPost) =================
/**
 * Handler webhook utama Telegram (HTTP POST) untuk mengelola perintah bot,
 * penyimpanan foto ke folder staging Drive, sinkronisasi album asinkron,
 * serta penguncian konkurensi melalui LockService.
 * @param {GoogleAppsScript.Events.DoPost} e Objek event payload JSON dari Telegram.
 */
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return HtmlService.createHtmlOutput("OK");
    }

    var update = JSON.parse(e.postData.contents);
    var msg = update.message;
    if (!msg) {
      return HtmlService.createHtmlOutput("OK");
    }

    var chatId = String(msg.chat.id);
    var userId = String(msg.from ? msg.from.id : msg.chat.id);
    var text = (msg.text || "").trim();
    var caption = (msg.caption || "").trim();

    // Abaikan pesan jika ini adalah laporan Valins / Expand ODP
    if (isValinsOrExpand(text || caption)) {
      return HtmlService.createHtmlOutput("OK");
    }

    // 1. Command /start atau /help
    if (text === "/start" || text === "/help") {
      var welcome = "[SISTEM] *BOT EVIDENSI CAT TIANG TELKOM* (" + CONFIG.BOT_USERNAME + ")\n\n" +
                    "Versi " + CONFIG.VERSION + " (Drive Staging & Auto-Clean Engine).\n\n" +
                    "[PANDUAN] *Cara Penggunaan Fleksibel & Terstruktur:*\n" +
                    "1. Kirim album foto evidensi (caption bebas di *foto pertama* atau *foto terakhir*):\n" +
                    "```\n" +
                    "VALIDASI TIANG\n" +
                    "PWK-FFK-116-TLKM\n" +
                    "ODP-PWK-FFK/016\n" +
                    "INC52639826\n" +
                    "PWK-1\n" +
                    "```\n" +
                    "2. Atau kirim teks di atas lebih dahulu, lalu kirim foto-fotonya langsung (tanpa caption).\n" +
                    "3. Jika kirim banyak foto (misal 5-10 foto), AI otomatis memilih 4 foto terbaik dan membersihkan foto sisa agar Google Drive tidak penuh.\n\n" +
                    "[INFO] *Perintah Bantuan:*\n" +
                    "- `/status` : Cek progres slot foto tiang aktif saat ini.\n" +
                    "- `/batal`  : Hapus antrean / reset sesi tiang aktif.";
      sendTelegramMessage(chatId, welcome);
      return HtmlService.createHtmlOutput("OK");
    }

    // 2. Command /batal atau /reset
    if (text === "/batal" || text === "/reset") {
      cleanStagingFolder(userId);
      clearUserSession(userId);
      clearPendingCaption(userId);
      sendTelegramMessage(chatId, "[RESET] *Sesi & folder sementara telah direset.*\nSeluruh file staging di Google Drive telah dibersihkan.");
      return HtmlService.createHtmlOutput("OK");
    }

    // 3. Command /status
    if (text === "/status") {
      var curSess = getUserSession(userId);
      var staging = getStagingPhotos(userId);
      var msgStatus = "[STATUS] *Status Sistem Saat Ini:*\n" +
                      "- Foto di Staging Drive: *" + staging.blobs.length + " foto*\n";
      if (curSess) {
        msgStatus += "- Tiang Aktif: `" + curSess.meta.validasiTiang + "` (Baris " + curSess.targetRow + ")\n" +
                     "- Datek: `" + (curSess.meta.datek || "-") + "`\n";
      } else {
        msgStatus += "- Sesi Tiang: _Belum aktif (menunggu caption)_\n";
      }
      sendTelegramMessage(chatId, msgStatus);
      return HtmlService.createHtmlOutput("OK");
    }

    var contentStr = caption || text;
    var hasValCaption = isValidationCaption(contentStr);

    if (hasValCaption) {
      setPendingCaption(userId, contentStr);
    }

    // KASUS A: PESAN TEKS SAJA (TANPA FOTO)
    if (!msg.photo && text) {
      if (hasValCaption) {
        var textMeta = parseMetadata(text);
        if (textMeta.validasiTiang) {
          // Cek apakah sudah ada foto yang menunggu di folder staging
          var waitingStaging = getStagingPhotos(userId);
          if (waitingStaging.blobs.length > 0) {
            // Langsung eksekusi foto yang menunggu dengan caption teks ini!
            processStagingSubmission(chatId, userId, text, waitingStaging);
            return HtmlService.createHtmlOutput("OK");
          } else {
            // Belum ada foto, inisialisasi sesi aktif tiang dan siapkan baris sheet
            var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
            var sheetTarget = CONFIG.SHEET_NAME ? ss.getSheetByName(CONFIG.SHEET_NAME) : ss.getSheets()[0];
            var tRow = findTargetRow(sheetTarget, textMeta);
            formatRowForEvidence(sheetTarget, tRow);
            writeTextDataToRow(sheetTarget, tRow, textMeta);
            saveUserSession(userId, {
              targetRow: tRow,
              meta: textMeta,
              slots: { SEBELUM: null, SESUDAH: null, ODP: null, MARKING_LABEL: null }
            });
            var initMsg = "[STATUS] *Validasi Tiang Diaktifkan!*\n\n" +
                          "- *Tiang:* `" + textMeta.validasiTiang + "` (Baris " + tRow + ")\n" +
                          "- *Datek:* `" + (textMeta.datek || "-") + "`\n" +
                          "- *Tiket:* `" + (textMeta.tiket || "-") + "`\n\n" +
                          "[EVIDENSI] *Silakan kirim foto-foto evidensi tiang* (Bisa sekaligus atau bertahap TANPA PERLU KETIK CAPTION LAGI).\n" +
                          "AI akan otomatis memilih 4 foto terbaik dan memasukkannya ke spreadsheet!";
            sendTelegramMessage(chatId, initMsg);
            return HtmlService.createHtmlOutput("OK");
          }
        }
      }
      return HtmlService.createHtmlOutput("OK");
    }

    // KASUS B: PESAN ADALAH FOTO
    if (msg.photo && msg.photo.length > 0) {
      var highestPhoto = msg.photo[msg.photo.length - 1];
      var blob = getTelegramFileBlob(CONFIG.TELEGRAM_TOKEN, highestPhoto.file_id);
      if (blob) {
        savePhotoToStaging(userId, highestPhoto.file_id, blob);
      }

      // Dynamic Asynchronous Wait:
      // - Jika foto membawa caption validasi: tidur 6 detik (menunggu sibling album mendarat di staging)
      // - Jika foto tanpa caption:
      //   * Ada sesi aktif: tidur 6 detik
      //   * Belum ada sesi aktif: tidur 14 detik (menunggu foto terakhir yang membawa caption mendarat)
      var activeSessionCheck = getUserSession(userId);
      var sleepTime = 14;
      if (hasValCaption) {
        sleepTime = 6;
      } else if (activeSessionCheck) {
        sleepTime = 6;
      }

      Utilities.sleep(sleepTime * 1000);

      // KUNCI SCRIPT ATOMIC AGAR HANYA SATU THREAD YANG MEMPROSES FOLDER STAGING
      var lock = LockService.getScriptLock();
      lock.waitLock(30000);

      var staging = getStagingPhotos(userId);

      // Jika folder staging sudah kosong (sudah diproses oleh thread lain), langsung keluar hening
      if (staging.blobs.length === 0) {
        lock.releaseLock();
        return HtmlService.createHtmlOutput("OK");
      }

      var finalCaption = getPendingCaption(userId);
      var activeSession = getUserSession(userId);

      // KONDISI 1: ADA CAPTION VALIDASI (di foto awal, akhir, atau teks)
      if (finalCaption) {
        processStagingSubmission(chatId, userId, finalCaption, staging);
        lock.releaseLock();
        return HtmlService.createHtmlOutput("OK");
      }

      // KONDISI 2: ADA SESI AKTIF (FOTO SUSULAN)
      if (activeSession) {
        processStagingSubsequent(chatId, userId, activeSession, staging);
        lock.releaseLock();
        return HtmlService.createHtmlOutput("OK");
      }

      // KONDISI 3: TIDAK ADA CAPTION & TIDAK ADA SESI AKTIF
      // Bersihkan staging dan kirim 1 pengingat ramah
      cleanStagingFolder(userId);
      clearPendingCaption(userId);
      lock.releaseLock();

      var warnMsg = "[PERINGATAN] *Keterangan Tiang/Datek Belum Ditemukan!*\n\n" +
                    "Bot menerima *" + staging.blobs.length + " foto*, tetapi belum mendeteksi teks caption validasi.\n\n" +
                    "Harap sertakan teks caption pada salah satu foto (bisa foto pertama atau terakhir), contoh:\n```\n" +
                    "VALIDASI TIANG\n" +
                    "PWK-FFK-116-TLKM\n" +
                    "ODP-PWK-FFK/016\n" +
                    "INC52639826\n" +
                    "PWK-1\n```\n" +
                    "_(Bisa juga dikirim sebagai pesan teks sebelum atau sesudah kirim foto)_";
      sendTelegramMessage(chatId, warnMsg);
      return HtmlService.createHtmlOutput("OK");
    }

    return HtmlService.createHtmlOutput("OK");

  } catch (err) {
    Logger.log("Error in doPost: " + err);
    return HtmlService.createHtmlOutput("OK");
  }
}

// ================= PROSES SUBMISSION DARI STAGING (DENGAN CAPTION) =================
/**
 * Memproses kumpulan foto dari folder staging menggunakan Vision AI untuk
 * pengiriman awal yang disertai caption metadata validasi tiang lengkap.
 * @param {number|string} chatId ID chat Telegram tujuan notifikasi.
 * @param {number|string} userId ID pengguna pengirim laporan.
 * @param {string} rawCaption Teks caption metadata tiang.
 * @param {Object} stagingData Objek berisi daftar Blob foto dan File Drive staging.
 */
function processStagingSubmission(chatId, userId, rawCaption, stagingData) {
  var staging = stagingData || getStagingPhotos(userId);
  var photoBlobs = staging.blobs;

  if (photoBlobs.length === 0) {
    sendTelegramMessage(chatId, "[GAGAL] Foto tidak ditemukan di staging. Silakan kirim ulang.");
    return;
  }

  sendTelegramMessage(chatId, "[PROSES] *Sedang menganalisis " + photoBlobs.length + " foto dengan AI Vision...*\nMemilih 4 foto evidensi terbaik...");

  try {
    var aiResult = callCascadingVisionAI(rawCaption, photoBlobs);
    var meta = parseMetadata(rawCaption);

    if (!meta.validasiTiang && aiResult.metadata && aiResult.metadata.validasi_tiang) {
      meta.validasiTiang = aiResult.metadata.validasi_tiang;
    }
    if (!meta.datek && aiResult.metadata && aiResult.metadata.datek) {
      meta.datek = aiResult.metadata.datek;
    }
    if (!meta.tiket && aiResult.metadata && aiResult.metadata.tiket) {
      meta.tiket = aiResult.metadata.tiket;
    }
    if (!meta.sektor && aiResult.metadata && aiResult.metadata.sektor) {
      meta.sektor = aiResult.metadata.sektor;
    }

    if (!meta.validasiTiang && !meta.datek) {
      sendTelegramMessage(chatId, "[PERINGATAN] *Keterangan Tiang/Datek Tidak Ditemukan!*\n\nHarap sertakan teks caption, contoh:\n```\nVALIDASI TIANG\nPWK-FFK-116-TLKM\nODP-PWK-FFK/016\nINC52639826\nPWK-1\n```");
      return;
    }

    var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    var sheet = CONFIG.SHEET_NAME ? ss.getSheetByName(CONFIG.SHEET_NAME) : ss.getSheets()[0];
    var targetRow = findTargetRow(sheet, meta);

    // Format ukuran baris dan kolom agar gambar presisi
    formatRowForEvidence(sheet, targetRow);
    writeTextDataToRow(sheet, targetRow, meta);

    // ================= 2-PASS ALLOCATION (PILIH 4 FOTO TERBAIK) =================
    var slots = {
      SEBELUM: null,
      SESUDAH: null,
      ODP: null,
      MARKING_LABEL: null
    };

    var assignedIndices = [];
    var imageClassifications = aiResult.images || [];

    // PASS 1: Pasangkan berdasarkan hasil analisis AI Vision
    for (var j = 0; j < imageClassifications.length; j++) {
      var item = imageClassifications[j];
      var idx = item.image_index - 1;
      if (idx < 0 || idx >= photoBlobs.length) continue;

      var rawCat = item.category ? item.category.toUpperCase().trim() : "";
      var cat = "";
      if (rawCat.indexOf("MARKING") !== -1 || rawCat.indexOf("LABEL") !== -1 || rawCat.indexOf("STENSIL") !== -1) {
        cat = "MARKING_LABEL";
      } else if (rawCat.indexOf("ODP") !== -1 || rawCat.indexOf("BOX") !== -1) {
        cat = "ODP";
      } else if (rawCat.indexOf("SEBELUM") !== -1 || rawCat.indexOf("TANGGA") !== -1) {
        cat = "SEBELUM";
      } else if (rawCat.indexOf("SESUDAH") !== -1 || rawCat.indexOf("SETELAH") !== -1) {
        cat = "SESUDAH";
      }

      if (cat && slots[cat] === null && assignedIndices.indexOf(idx) === -1) {
        slots[cat] = { blob: photoBlobs[idx], fileIndex: idx, catName: cat };
        assignedIndices.push(idx);
      }
    }

    // PASS 2: Jika masih ada slot kosong dan ada foto yang belum terpasang, pasangkan secara berurutan
    var categoryOrder = ["SEBELUM", "SESUDAH", "ODP", "MARKING_LABEL"];
    for (var p = 0; p < photoBlobs.length; p++) {
      if (assignedIndices.indexOf(p) === -1) {
        for (var c = 0; c < categoryOrder.length; c++) {
          var targetCat = categoryOrder[c];
          if (slots[targetCat] === null) {
            slots[targetCat] = { blob: photoBlobs[p], fileIndex: p, catName: targetCat };
            assignedIndices.push(p);
            break;
          }
        }
      }
    }

    // ================= SIMPAN 4 FOTO KE FOLDER ARSIP & SPREADSHEET =================
    var timestampStr = Utilities.formatDate(new Date(), "GMT+7", "yyyyMMdd_HHmmss");
    var poleLabel = meta.validasiTiang || "TIANG_" + timestampStr;
    var archiveFolderName = poleLabel + "_" + timestampStr;
    var archiveFolder = createPoleArchiveFolder(archiveFolderName);

    var savedUrls = { SEBELUM: null, SESUDAH: null, ODP: null, MARKING_LABEL: null };

    for (var k = 0; k < categoryOrder.length; k++) {
      var catKey = categoryOrder[k];
      if (slots[catKey] && slots[catKey].blob) {
        var colIdx = (catKey === "SEBELUM" ? 5 : (catKey === "SESUDAH" ? 6 : (catKey === "ODP" ? 7 : 8)));
        var fileName = poleLabel + "_" + catKey + ".jpg";
        var driveFile = archiveFolder.createFile(slots[catKey].blob.setName(fileName));
        driveFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
        var driveUrl = "https://drive.google.com/uc?export=view&id=" + driveFile.getId();

        insertImageToEvidenceCell(sheet, targetRow, colIdx, slots[catKey].blob, driveUrl);
        savedUrls[catKey] = driveUrl;
      }
    }

    var rowCloseDate = Utilities.formatDate(new Date(), "GMT+7", "yyyy-MM-dd HH:mm:ss");
    sheet.getRange(targetRow, 10).setValue(rowCloseDate);
    SpreadsheetApp.flush();

    // ================= BERSIHKAN FOLDER STAGING (ANTI DRIVE PENUH) =================
    cleanStagingFolder(userId);
    clearPendingCaption(userId);

    var filledCount = 0;
    if (savedUrls.SEBELUM) filledCount++;
    if (savedUrls.SESUDAH) filledCount++;
    if (savedUrls.ODP) filledCount++;
    if (savedUrls.MARKING_LABEL) filledCount++;

    if (filledCount >= 4) {
      clearUserSession(userId); // Selesai 100%!
      var reportFull = "[TERSIMPAN] *REKAPAN CAT TIANG LENGKAP (4/4 FOTO)!*\n\n" +
                       "[STATUS] *Detail Validasi:*\n" +
                       "- *Sektor:* " + (meta.sektor || "-") + "\n" +
                       "- *Datek:* `" + (meta.datek || "-") + "`\n" +
                       "- *Tiket:* `" + (meta.tiket || "-") + "`\n" +
                       "- *Validasi Tiang:* `" + (meta.validasiTiang || "-") + "`\n" +
                       "- *Baris Sheet:* " + targetRow + "\n\n" +
                       "[EVIDENSI] *Seluruh Slot Selesai Terisi:*\n" +
                       "1. SEBELUM (Tangga/Jauh) : [TERSIMPAN] Tersimpan (Kolom E)\n" +
                       "2. SESUDAH (Cat Tiang)  : [TERSIMPAN] Tersimpan (Kolom F)\n" +
                       "3. ODP (Box ODP)         : [TERSIMPAN] Tersimpan (Kolom G)\n" +
                       "4. MARKING (Stensil)     : [TERSIMPAN] Tersimpan (Kolom H)\n\n" +
                       "[ARSIP] *Folder Arsip:* `" + archiveFolderName + "`\n" +
                       "[SELESAI] _Tabel di Spreadsheet telah FULL terisi rapi & file sementara telah dibersihkan dari Google Drive!_";
      sendTelegramMessage(chatId, reportFull);
    } else {
      // Simpan session agar foto susulan langsung melengkapi baris tiang ini
      saveUserSession(userId, {
        targetRow: targetRow,
        meta: meta,
        slots: savedUrls,
        archiveFolderId: archiveFolder.getId()
      });

      var missingSlots = [];
      if (!savedUrls.SEBELUM) missingSlots.push("1. SEBELUM (Tangga/Jauh)");
      if (!savedUrls.SESUDAH) missingSlots.push("2. SESUDAH (Cat Tiang)");
      if (!savedUrls.ODP) missingSlots.push("3. ODP (Box ODP)");
      if (!savedUrls.MARKING_LABEL) missingSlots.push("4. MARKING (Stensil)");

      var reportPartial = "[EVIDENSI] *PROGRES VALIDASI TIANG AKTIF*\n\n" +
                          "[STATUS] *Tiang:* `" + meta.validasiTiang + "` (Baris " + targetRow + ")\n" +
                          "- *Foto Berhasil Masuk:* " + filledCount + "/4 Foto\n\n" +
                          "[TERSIMPAN] *Sudah Ada:*\n" +
                          (savedUrls.SEBELUM ? "- SEBELUM : [TERSIMPAN] Tersimpan\n" : "") +
                          (savedUrls.SESUDAH ? "- SESUDAH : [TERSIMPAN] Tersimpan\n" : "") +
                          (savedUrls.ODP ? "- ODP : [TERSIMPAN] Tersimpan\n" : "") +
                          (savedUrls.MARKING_LABEL ? "- MARKING : [TERSIMPAN] Tersimpan\n" : "") +
                          "\n[PROSES] *Slot yang Belum Ada:*\n-> " + missingSlots.join("\n-> ") + "\n\n" +
                          "[INFO] *Silakan langsung kirim foto sisanya*\n_(LANGSUNG KIRIM FOTO, TIDAK PERLU KETIK CAPTION LAGI!)_";
      sendTelegramMessage(chatId, reportPartial);
    }

  } catch (e) {
    Logger.log("Error in processStagingSubmission: " + e);
    sendTelegramMessage(chatId, "[GAGAL] Terjadi kendala saat memproses: " + e.message);
  }
}

// ================= PROSES FOTO SUSULAN DARI STAGING =================
/**
 * Memproses foto susulan dari folder staging untuk melengkapi slot gambar
 * yang masih kosong pada sesi tiang aktif.
 * @param {number|string} chatId ID chat Telegram tujuan notifikasi.
 * @param {number|string} userId ID pengguna pengirim laporan.
 * @param {Object} session Data sesi aktif tiang beserta URL yang sudah tersimpan.
 * @param {Object} stagingData Objek berisi daftar Blob foto dan File Drive staging.
 */
function processStagingSubsequent(chatId, userId, session, stagingData) {
  var staging = stagingData || getStagingPhotos(userId);
  var photoBlobs = staging.blobs;

  if (photoBlobs.length === 0) return;

  sendTelegramMessage(chatId, "[PROSES] *Menganalisis " + photoBlobs.length + " foto susulan untuk Tiang `" + session.meta.validasiTiang + "`...*");

  try {
    var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    var sheet = CONFIG.SHEET_NAME ? ss.getSheetByName(CONFIG.SHEET_NAME) : ss.getSheets()[0];
    var poleLabel = session.meta.validasiTiang || "TIANG";

    var archiveFolder = session.archiveFolderId ? DriveApp.getFolderById(session.archiveFolderId) : createPoleArchiveFolder(poleLabel);

    var aiResult = callCascadingVisionAI("", photoBlobs);
    var imageClassifications = aiResult.images || [];

    var newlyAdded = [];
    var assignedIndices = [];
    var categoryOrder = ["SEBELUM", "SESUDAH", "ODP", "MARKING_LABEL"];

    // PASS 1: Pasangkan ke slot kosong berdasarkan AI
    for (var j = 0; j < imageClassifications.length; j++) {
      var item = imageClassifications[j];
      var idx = item.image_index - 1;
      if (idx < 0 || idx >= photoBlobs.length) continue;

      var rawCat = item.category ? item.category.toUpperCase().trim() : "";
      var cat = "";
      if (rawCat.indexOf("MARKING") !== -1 || rawCat.indexOf("LABEL") !== -1 || rawCat.indexOf("STENSIL") !== -1) {
        cat = "MARKING_LABEL";
      } else if (rawCat.indexOf("ODP") !== -1 || rawCat.indexOf("BOX") !== -1) {
        cat = "ODP";
      } else if (rawCat.indexOf("SEBELUM") !== -1 || rawCat.indexOf("TANGGA") !== -1) {
        cat = "SEBELUM";
      } else if (rawCat.indexOf("SESUDAH") !== -1 || rawCat.indexOf("SETELAH") !== -1) {
        cat = "SESUDAH";
      }

      if (cat && !session.slots[cat] && assignedIndices.indexOf(idx) === -1) {
        var colIdx = (cat === "SEBELUM" ? 5 : (cat === "SESUDAH" ? 6 : (cat === "ODP" ? 7 : 8)));
        var fileName = poleLabel + "_" + cat + ".jpg";
        var driveFile = archiveFolder.createFile(photoBlobs[idx].setName(fileName));
        driveFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
        var driveUrl = "https://drive.google.com/uc?export=view&id=" + driveFile.getId();

        formatRowForEvidence(sheet, session.targetRow);
        insertImageToEvidenceCell(sheet, session.targetRow, colIdx, photoBlobs[idx], driveUrl);

        session.slots[cat] = driveUrl;
        newlyAdded.push(cat);
        assignedIndices.push(idx);
      }
    }

    // PASS 2: Pasangkan foto sisa ke slot yang masih belum terisi
    for (var p = 0; p < photoBlobs.length; p++) {
      if (assignedIndices.indexOf(p) === -1) {
        for (var c = 0; c < categoryOrder.length; c++) {
          var targetCat = categoryOrder[c];
          if (!session.slots[targetCat]) {
            var colIdx2 = (targetCat === "SEBELUM" ? 5 : (targetCat === "SESUDAH" ? 6 : (targetCat === "ODP" ? 7 : 8)));
            var fileName2 = poleLabel + "_" + targetCat + ".jpg";
            var driveFile2 = archiveFolder.createFile(photoBlobs[p].setName(fileName2));
            driveFile2.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
            var driveUrl2 = "https://drive.google.com/uc?export=view&id=" + driveFile2.getId();

            formatRowForEvidence(sheet, session.targetRow);
            insertImageToEvidenceCell(sheet, session.targetRow, colIdx2, photoBlobs[p], driveUrl2);

            session.slots[targetCat] = driveUrl2;
            newlyAdded.push(targetCat);
            assignedIndices.push(p);
            break;
          }
        }
      }
    }

    var rowCloseDate = Utilities.formatDate(new Date(), "GMT+7", "yyyy-MM-dd HH:mm:ss");
    sheet.getRange(session.targetRow, 10).setValue(rowCloseDate);
    SpreadsheetApp.flush();

    // Bersihkan staging Drive
    cleanStagingFolder(userId);

    var filledCount = 0;
    if (session.slots.SEBELUM) filledCount++;
    if (session.slots.SESUDAH) filledCount++;
    if (session.slots.ODP) filledCount++;
    if (session.slots.MARKING_LABEL) filledCount++;

    if (filledCount >= 4) {
      clearUserSession(userId); // Selesai 100%!
      var finishMsg = "[SELESAI] *SEMPURNA! REKAPAN LENGKAP 4/4 FOTO!*\n\n" +
                      "[STATUS] *Tiang:* `" + session.meta.validasiTiang + "` (Baris " + session.targetRow + ")\n" +
                      "- *Datek:* `" + (session.meta.datek || "-") + "`\n" +
                      "- *Tiket:* `" + (session.meta.tiket || "-") + "`\n\n" +
                      "[EVIDENSI] *Semua Slot Selesai Terisi:*\n" +
                      "1. SEBELUM : [TERSIMPAN] Tersimpan (Kolom E)\n" +
                      "2. SESUDAH : [TERSIMPAN] Tersimpan (Kolom F)\n" +
                      "3. ODP     : [TERSIMPAN] Tersimpan (Kolom G)\n" +
                      "4. MARKING : [TERSIMPAN] Tersimpan (Kolom H)\n\n" +
                      "[SELESAI] _Tabel di Spreadsheet kini sudah FULL terisi sesuai standar format tabel pelaporan._";
      sendTelegramMessage(chatId, finishMsg);
    } else {
      saveUserSession(userId, session);

      var missing = [];
      if (!session.slots.SEBELUM) missing.push("1. SEBELUM (Tangga/Jauh)");
      if (!session.slots.SESUDAH) missing.push("2. SESUDAH (Cat Tiang)");
      if (!session.slots.ODP) missing.push("3. ODP (Box ODP)");
      if (!session.slots.MARKING_LABEL) missing.push("4. MARKING (Stensil)");

      var progMsg = "[EVIDENSI] *Foto Susulan Berhasil Ditambahkan!*\n\n" +
                    "[STATUS] *Tiang Aktif:* `" + session.meta.validasiTiang + "` (Baris " + session.targetRow + ")\n" +
                    "- *Foto Baru:* " + newlyAdded.join(", ") + "\n" +
                    "- *Progres:* " + filledCount + "/4 Foto Terisi\n\n" +
                    "[PROSES] *Sisa Slot yang Belum Ada:*\n" +
                    "-> " + missing.join("\n-> ") + "\n\n" +
                    "[INFO] _Silakan langsung kirim foto berikutnya (TANPA CAPTION)_";
      sendTelegramMessage(chatId, progMsg);
    }

  } catch (err) {
    Logger.log("Error in processStagingSubsequent: " + err);
    sendTelegramMessage(chatId, "[GAGAL] Gagal memproses foto susulan: " + err.message);
  }
}

// ================= CASCADING MULTI-PROVIDER AI ENGINE =================
/**
 * Memanggil layanan Vision AI secara beruntun berdasarkan daftar AI_MODEL_CHAIN
 * hingga memperoleh klasifikasi JSON yang valid.
 * @param {string} captionText Teks metadata tiang sebagai konteks tambahan model.
 * @param {GoogleAppsScript.Base.Blob[]} blobs Array blob gambar yang akan dianalisis.
 * @return {Object} Hasil parsing klasifikasi foto beserta status keberhasilan.
 */
function callCascadingVisionAI(captionText, blobs) {
  var prompt = buildPolePrompt(blobs.length, captionText);

  for (var i = 0; i < AI_MODEL_CHAIN.length; i++) {
    var item = AI_MODEL_CHAIN[i];
    Logger.log("Mencoba AI Model [" + (i + 1) + "/" + AI_MODEL_CHAIN.length + "]: " + item.provider + " -> " + item.model);

    try {
      var result = null;
      if (item.provider === "GEMINI") {
        result = tryGeminiModel(CONFIG.GEMINI_API_KEY, item.model, prompt, blobs);
      } else if (item.provider === "OPENROUTER") {
        result = tryOpenRouterModel(CONFIG.OPENROUTER_API_KEY, item.model, prompt, blobs);
      }

      if (result && !result.error && result.images && result.images.length > 0) {
        Logger.log("[TERSIMPAN] Berhasil diproses oleh model: " + item.model);
        result.activeModel = item.provider + " (" + item.model + ")";
        return result;
      }

      Logger.log("[PERINGATAN] Model " + item.model + " gagal/sibuk (" + (result ? result.error : "null") + "). Mencoba model cadangan berikutnya...");
      Utilities.sleep(1000);
    } catch (err) {
      Logger.log("Exception pada model " + item.model + ": " + err);
      Utilities.sleep(1000);
    }
  }

  return { error: "Seluruh model AI cadangan sedang mengalami antrean. Silakan coba beberapa saat lagi.", metadata: {}, images: [] };
}

/**
 * Mengirimkan permintaan analisis multimodal ke endpoint Google Gemini API.
 * @param {string} apiKey Kunci API Google AI Studio.
 * @param {string} model Nama identifikasi model Gemini.
 * @param {string} prompt Teks instruksi klasifikasi.
 * @param {GoogleAppsScript.Base.Blob[]} blobs Array blob gambar.
 * @return {Object} Objek status keberhasilan beserta respons JSON model.
 */
function tryGeminiModel(apiKey, model, prompt, blobs) {
  var url = "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent?key=" + apiKey;

  var parts = [{ text: prompt }];
  for (var i = 0; i < blobs.length; i++) {
    var b64 = Utilities.base64Encode(blobs[i].getBytes());
    parts.push({ text: "Foto " + (i + 1) + ":" });
    parts.push({
      inline_data: {
        mime_type: "image/jpeg",
        data: b64
      }
    });
  }

  var payload = {
    contents: [{ parts: parts }],
    generationConfig: { temperature: 0.1 }
  };

  var options = {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  var res = UrlFetchApp.fetch(url, options);
  var statusCode = res.getResponseCode();
  var resText = res.getContentText();

  if (statusCode !== 200) {
    return { error: "HTTP " + statusCode + " - " + resText.substring(0, 100) };
  }

  var json = JSON.parse(resText);
  if (!json.candidates || !json.candidates[0] || !json.candidates[0].content) {
    return { error: "No content candidate: " + resText.substring(0, 100) };
  }

  var rawResponse = json.candidates[0].content.parts[0].text;
  var cleanJson = rawResponse.replace(/```json/gi, "").replace(/```/g, "").trim();
  return JSON.parse(cleanJson);
}

/**
 * Mengirimkan permintaan analisis multimodal ke endpoint OpenRouter API.
 * @param {string} apiKey Kunci API OpenRouter.
 * @param {string} model Identifier model Vision di OpenRouter.
 * @param {string} prompt Teks instruksi klasifikasi.
 * @param {GoogleAppsScript.Base.Blob[]} blobs Array blob gambar.
 * @return {Object} Objek status keberhasilan beserta respons JSON model.
 */
function tryOpenRouterModel(apiKey, model, prompt, blobs) {
  var url = "https://openrouter.ai/api/v1/chat/completions";

  var contents = [{ type: "text", text: prompt }];
  for (var i = 0; i < blobs.length; i++) {
    var b64 = Utilities.base64Encode(blobs[i].getBytes());
    contents.push({ type: "text", text: "Foto " + (i + 1) + ":" });
    contents.push({
      type: "image_url",
      image_url: { url: "data:image/jpeg;base64," + b64 }
    });
  }

  var payload = {
    model: model,
    messages: [{ role: "user", content: contents }]
  };

  var options = {
    method: "post",
    contentType: "application/json",
    headers: {
      "Authorization": "Bearer " + apiKey,
      "HTTP-Referer": "https://script.google.com",
      "X-Title": "Bot Rekap Tiang"
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  var res = UrlFetchApp.fetch(url, options);
  var statusCode = res.getResponseCode();
  var resText = res.getContentText();

  if (statusCode !== 200) {
    return { error: "HTTP " + statusCode + " - " + resText.substring(0, 100) };
  }

  var json = JSON.parse(resText);
  if (!json.choices || !json.choices[0] || !json.choices[0].message) {
    return { error: "No choices returned from OpenRouter: " + resText.substring(0, 100) };
  }

  var rawResponse = json.choices[0].message.content;
  var cleanJson = rawResponse.replace(/```json/gi, "").replace(/```/g, "").trim();
  return JSON.parse(cleanJson);
}

/**
 * Menyusun prompt terstruktur untuk meminta Vision AI mengklasifikasikan setiap foto
 * ke dalam kategori SEBELUM, SESUDAH, ODP, MARKING_LABEL, atau OTHER.
 * @param {number} numPhotos Jumlah foto yang dikirimkan dalam satu batch.
 * @param {string} captionText Teks metadata laporan teknisi.
 * @return {string} Teks prompt lengkap dengan skema keluaran JSON ketat.
 */
function buildPolePrompt(numPhotos, captionText) {
  return "Kamu adalah AI validator foto evidensi pengerjaan tiang cat teknisi Telkom Indonesia.\n" +
    "Terdapat " + numPhotos + " foto yang dikirim oleh teknisi.\n" +
    "Tugasmu:\n" +
    "1. Ekstrak data teks caption jika ada:\n" +
    "   - sektor (contoh: PWK-1)\n" +
    "   - datek (nama ODP, contoh: ODP-PWK-FFK/016)\n" +
    "   - tiket (nomor tiket, contoh: INC52639826)\n" +
    "   - validasi_tiang (label tiang, contoh: PWK-FFK-116-TLKM atau PWK-FFK-186-TLKM)\n" +
    "Caption:\n\"\"\"\n" + (captionText || "") + "\n\"\"\"\n\n" +
    "2. Analisis seluruh " + numPhotos + " foto dan PILIH TEPAT 1 FOTO TERBAIK untuk masing-masing 4 kategori wajib berikut:\n\n" +
    "   - SEBELUM :\n" +
    "     Foto tiang tampak utuh dari kejauhan bersama lingkungan jalan/sekitar, ATAU terlihat TANGGA (ladder bambu/aluminium) yang menyandar/terpasang pada tiang untuk persiapan pengerjaan.\n\n" +
    "   - SESUDAH :\n" +
    "     Foto tiang fokus pada hasil CAT MERAH-PUTIH (tiang doang, cat merah di atas dan putih di bawah terlihat baru dan bersih, foto tampak sedang/dekat, TANPA tangga yang menghalangi tiang).\n\n" +
    "   - ODP :\n" +
    "     Foto kotak/box ODP Telkom (kotak fiber/plastik putih/abu-abu terpasang di tiang, terlihat tulisan ODP dan kode STO).\n\n" +
    "   - MARKING_LABEL :\n" +
    "     Foto close-up tulisan cat stensil identitas tiang (cat putih di atas tiang hitam/gelap, contoh: PWK FFK 116 TLKM atau PLD FAM 189 TLKM).\n\n" +
    "   - LAINNYA :\n" +
    "     Foto lain yang berlebih / duplikat / buram / tidak terpilih untuk 4 kategori di atas.\n\n" +
    "ATURAN PEMILIHAN SANGAT KETAT:\n" +
    "- Dari seluruh foto yang ada, pilih MAKSIMAL 1 foto untuk SEBELUM, 1 foto untuk SESUDAH, 1 foto untuk ODP, dan 1 foto untuk MARKING_LABEL.\n" +
    "- Foto bertangga HARUS diklasifikasikan sebagai SEBELUM.\n" +
    "- Foto tiang doang cat merah putih bersih HARUS diklasifikasikan sebagai SESUDAH.\n" +
    "- Foto kotak ODP HARUS diklasifikasikan sebagai ODP (JANGAN PERNAH MASUKKAN KOTAK ODP KE SEBELUM ATAU SESUDAH!).\n" +
    "- Foto tulisan stensil tiang HARUS diklasifikasikan sebagai MARKING_LABEL.\n" +
    "- Sisa foto lainnya wajib dikelompokkan ke LAINNYA.\n\n" +
    "Berikan balasan HANYA dalam format JSON valid persis seperti ini:\n" +
    "{\n" +
    "  \"metadata\": {\n" +
    "    \"sektor\": \"...\",\n" +
    "    \"datek\": \"...\",\n" +
    "    \"tiket\": \"...\",\n" +
    "    \"validasi_tiang\": \"...\"\n" +
    "  },\n" +
    "  \"images\": [\n" +
    "    {\"image_index\": 1, \"category\": \"...\"},\n" +
    "    {\"image_index\": 2, \"category\": \"...\"}\n" +
    "  ]\n" +
    "}";
}

// ================= PARSER METADATA CAPTION =================
/**
 * Mengekstrak informasi Sektor, Datek/ODP, Nomor Tiket, dan Kode Validasi Tiang
 * dari teks caption laporan menggunakan pencocokan baris berlabel dan regex.
 * @param {string} caption Teks mentah caption dari teknisi.
 * @return {{sektor: string, datek: string, tiket: string, validasiTiang: string}} Objek metadata terstruktur.
 */
function parseMetadata(caption) {
  var data = {
    validasiTiang: "",
    datek: "",
    tiket: "",
    sektor: ""
  };

  if (!caption) return data;
  var lines = caption.split("\n");

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line) continue;

    if (!data.tiket) {
      var matchTiket = line.match(/\b(INC\d{6,12})\b/i);
      if (matchTiket) {
        data.tiket = matchTiket[1].toUpperCase();
        continue;
      }
    }

    if (!data.datek) {
      var matchDatek = line.match(/\b(ODP-[A-Z0-9\-\/]+)\b/i);
      if (matchDatek) {
        data.datek = matchDatek[1].toUpperCase();
        continue;
      }
    }

    if (!data.validasiTiang) {
      var matchTiang = line.match(/\b([A-Z0-9]{2,5}-[A-Z0-9]{2,5}-\d{1,5}(?:-[A-Z0-9]+)?)\b/i);
      if (matchTiang && line.indexOf("ODP") === -1) {
        data.validasiTiang = matchTiang[1].toUpperCase();
        continue;
      }
    }

    if (!data.sektor) {
      var matchSektor = line.match(/\b([A-Z]{2,4}-[1-9]\d?)\b/i);
      if (matchSektor && line.indexOf("TLKM") === -1 && line.indexOf("ODP") === -1) {
        data.sektor = matchSektor[1].toUpperCase();
        continue;
      }
    }
  }

  // Fallback pencarian teks penuh
  if (!data.tiket) {
    var mTik = caption.match(/\b(INC\d{6,12})\b/i);
    if (mTik) data.tiket = mTik[1].toUpperCase();
  }
  if (!data.datek) {
    var mDat = caption.match(/\b(ODP-[A-Z0-9\-\/]+)\b/i);
    if (mDat) data.datek = mDat[1].toUpperCase();
  }
  if (!data.validasiTiang) {
    var mTiang = caption.match(/\b([A-Z0-9]{2,5}-[A-Z0-9]{2,5}-\d{1,5}(?:-[A-Z0-9]+)?)\b/i);
    if (mTiang && mTiang[1].toUpperCase().indexOf("ODP") === -1) data.validasiTiang = mTiang[1].toUpperCase();
  }
  if (!data.sektor) {
    var mSek = caption.match(/\b([A-Z]{2,4}-[1-9]\d?)\b/i);
    if (mSek && mSek[1].toUpperCase().indexOf("TLKM") === -1 && mSek[1].toUpperCase().indexOf("ODP") === -1) {
      data.sektor = mSek[1].toUpperCase();
    }
  }

  return data;
}

// ================= FORMAT & OPERASI SPREADSHEET =================
/**
 * Menyesuaikan tinggi baris, lebar kolom, perataan teks, dan pembungkusan teks
 * pada blok 4 baris spreadsheet agar gambar evidensi tampil proporsional.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet Objek sheet target.
 * @param {number} targetRow Indeks baris awal blok (1-based).
 */
function formatRowForEvidence(sheet, targetRow) {
  try {
    for (var r = 0; r < 4; r++) {
      sheet.setRowHeight(targetRow + r, 24);
    }
    sheet.setColumnWidth(5, 115);
    sheet.setColumnWidth(6, 115);
    sheet.setColumnWidth(7, 115);
    sheet.setColumnWidth(8, 115);
  } catch (e) {
    Logger.log("Error formatRowForEvidence: " + e);
  }
}

/**
 * Menuliskan metadata teks (Sektor, Datek, Tiket, Validasi Tiang, Timestamp)
 * ke kolom-kolom terkait pada blok baris target.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet Objek sheet target.
 * @param {number} targetRow Indeks baris awal blok.
 * @param {Object} meta Objek metadata hasil parsing caption.
 */
function writeTextDataToRow(sheet, targetRow, meta) {
  if (meta.sektor) sheet.getRange(targetRow, 2).setValue(meta.sektor);
  if (meta.datek) sheet.getRange(targetRow, 3).setValue(meta.datek);
  if (meta.tiket) sheet.getRange(targetRow, 4).setValue(meta.tiket);
  if (meta.validasiTiang) sheet.getRange(targetRow, 9).setValue(meta.validasiTiang);

  var rowBlockRange = sheet.getRange(targetRow, 1, 4, 10);
  rowBlockRange.setVerticalAlignment("middle");
  rowBlockRange.setHorizontalAlignment("center");
}

/**
 * Menyisipkan gambar evidensi ke atas grid sel spreadsheet serta mencatat
 * tautan arsip Google Drive pada Cell Note sebagai referensi permanen.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet Objek sheet target.
 * @param {number} targetRow Indeks baris awal blok.
 * @param {number} col Indeks kolom slot foto (5=SEBELUM, 6=SESUDAH, 7=ODP, 8=MARKING).
 * @param {GoogleAppsScript.Base.Blob} blob Data biner gambar.
 * @param {string} driveUrl Tautan file gambar di Google Drive.
 */
function insertImageToEvidenceCell(sheet, targetRow, col, blob, driveUrl) {
  if (!blob && !driveUrl) return;
  try {
    // 1. Bersihkan floating image lama di rentang sel baris ini secara aman
    try {
      var allImages = sheet.getImages();
      for (var i = 0; i < allImages.length; i++) {
        try {
          var anchor = allImages[i].getAnchorCell();
          if (anchor && anchor.getColumn() === col && anchor.getRow() >= targetRow && anchor.getRow() <= targetRow + 3) {
            allImages[i].remove();
          }
        } catch (eAnchor) {}
      }
    } catch (eList) {}

    // 2. Format sel: kosongkan teks di sel dan simpan link Google Drive sebagai Note (tooltip)
    sheet.getRange(targetRow, col).setValue("");
    if (driveUrl) {
      try {
        sheet.getRange(targetRow, col).setNote("Link Drive: " + driveUrl);
      } catch (eNote) {}
    }

    // 3. Sisipkan gambar beresolusi tinggi (110x82 px) persis seperti template contoh baris 34
    var imageInserted = false;
    if (blob) {
      try {
        var newImg = sheet.insertImage(blob, col, targetRow, 2, 2);
        newImg.setWidth(110);
        newImg.setHeight(82);
        imageInserted = true;
      } catch (eInsert) {
        Logger.log("insertImage OverGrid gagal: " + eInsert);
      }
    }

    // 4. Jika insertImage gagal, fallback ke modern In-Cell Image
    if (!imageInserted && driveUrl) {
      try {
        var cellImage = SpreadsheetApp.newCellImage().setSourceUrl(driveUrl).setAltTextTitle("Foto Evidensi").build();
        sheet.getRange(targetRow, col).setValue(cellImage);
      } catch (eCellImg) {
        sheet.getRange(targetRow, col).setValue(driveUrl);
      }
    }
  } catch (err) {
    Logger.log("Error insertImageToEvidenceCell: " + err);
  }
}

/**
 * Mencari baris yang sesuai pada sheet berdasarkan kesamaan kode Validasi Tiang,
 * baris bernomor kosong berikutnya, atau membuat blok merge 4 baris baru.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet Objek sheet target.
 * @param {Object} meta Objek metadata tiang.
 * @return {number} Nomor baris awal blok (1-based).
 */
function findTargetRow(sheet, meta) {
  var maxRows = Math.min(sheet.getLastRow() + 30, 500);
  if (maxRows < 2) return 2;

  var colA = sheet.getRange(2, 1, maxRows - 1, 1).getValues();
  var colC = sheet.getRange(2, 3, maxRows - 1, 1).getValues();
  var colI = sheet.getRange(2, 9, maxRows - 1, 1).getValues();

  // 1. Cek apakah baris dengan validasiTiang yang sama sudah ada -> perbarui baris yang sama!
  if (meta && meta.validasiTiang) {
    for (var m = 0; m < colI.length; m++) {
      var existTiang = colI[m][0] ? colI[m][0].toString().trim() : "";
      if (existTiang === meta.validasiTiang) {
        return m + 2;
      }
    }
  }

  // 2. Cari baris bernomor yang masih kosong
  for (var r = 0; r < colC.length; r++) {
    var rowNum = r + 2;
    var valA = colA[r][0];
    var valC = colC[r][0] ? colC[r][0].toString().trim() : "";
    var valI = colI[r][0] ? colI[r][0].toString().trim() : "";

    if (valA !== "" && valC === "" && valI === "") {
      return rowNum;
    }
  }

  // 3. Jika seluruh baris template habis, buat baris gabungan baru
  var lastRow = sheet.getLastRow();
  var nextRow = lastRow + 1;

  var lastNo = 1;
  for (var k = lastRow; k >= 2; k--) {
    var num = parseInt(sheet.getRange(k, 1).getValue(), 10);
    if (!isNaN(num) && num > 0) {
      lastNo = num + 1;
      break;
    }
  }

  sheet.insertRowsAfter(lastRow, 4);
  for (var c = 1; c <= 10; c++) {
    sheet.getRange(nextRow, c, 4, 1).merge();
  }
  sheet.getRange(nextRow, 1).setValue(lastNo);
  SpreadsheetApp.flush();
  return nextRow;
}

// ================= DRIVE STAGING & STORAGE ENGINE =================
/**
 * Mencari folder berdasarkan nama pada direktori induk atau membuatnya jika belum ada.
 * @param {string} folderName Nama folder tujuan.
 * @param {GoogleAppsScript.Drive.Folder} [parentFolder] Folder induk (opsional, default root Drive).
 * @return {GoogleAppsScript.Drive.Folder} Objek folder Google Drive.
 */
function getOrCreateFolder(folderName, parentFolder) {
  var root = parentFolder || DriveApp;
  var folders = root.getFoldersByName(folderName);
  if (folders.hasNext()) {
    return folders.next();
  }
  var newFolder = root.createFolder(folderName);
  newFolder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return newFolder;
}

/**
 * Mengambil atau membuat folder staging terisolasi untuk satu pengguna Telegram.
 * @param {number|string} userId ID pengguna Telegram.
 * @return {GoogleAppsScript.Drive.Folder} Folder staging milik pengguna.
 */
function getUserStagingFolder(userId) {
  var rootFolder = getOrCreateFolder(CONFIG.DRIVE_ROOT_FOLDER);
  return getOrCreateFolder("STAGING_" + userId, rootFolder);
}

/**
 * Menyimpan sementara file gambar yang dikirim pengguna ke dalam folder staging Drive.
 * @param {number|string} userId ID pengguna Telegram.
 * @param {string} fileId File ID unik dari Telegram.
 * @param {GoogleAppsScript.Base.Blob} blob Objek Blob gambar.
 */
function savePhotoToStaging(userId, fileId, blob) {
  var stagingFolder = getUserStagingFolder(userId);
  var fileName = "TEMP_" + Date.now() + "_" + fileId.substring(0, 8) + ".jpg";
  return stagingFolder.createFile(blob.setName(fileName));
}

/**
 * Mengambil seluruh daftar file foto dari folder staging pengguna secara berurutan.
 * @param {number|string} userId ID pengguna Telegram.
 * @return {{blobs: GoogleAppsScript.Base.Blob[], files: GoogleAppsScript.Drive.File[]}} Daftar blob dan file staging.
 */
function getStagingPhotos(userId) {
  var stagingFolder = getUserStagingFolder(userId);
  var files = stagingFolder.getFiles();
  var blobs = [];
  var fileObjects = [];

  while (files.hasNext()) {
    var f = files.next();
    blobs.push(f.getBlob());
    fileObjects.push(f);
  }
  return { blobs: blobs, files: fileObjects };
}

/**
 * Menghapus (memindahkan ke Trash) seluruh file sementara di folder staging pengguna
 * setelah proses analisis dan pengarsipan selesai.
 * @param {number|string} userId ID pengguna Telegram.
 */
function cleanStagingFolder(userId) {
  try {
    var rootFolder = getOrCreateFolder(CONFIG.DRIVE_ROOT_FOLDER);
    var folders = rootFolder.getFoldersByName("STAGING_" + userId);
    while (folders.hasNext()) {
      var folder = folders.next();
      var files = folder.getFiles();
      while (files.hasNext()) {
        files.next().setTrashed(true);
      }
      folder.setTrashed(true);
    }
  } catch (e) {
    Logger.log("Error cleanStagingFolder: " + e);
  }
}

/**
 * Membuat folder arsip permanen di bawah direktori induk Drive untuk menyimpan
 * 4 foto terbaik hasil seleksi suatu laporan tiang.
 * @param {string} folderName Nama folder arsip tiang.
 * @return {GoogleAppsScript.Drive.Folder} Objek folder arsip tiang.
 */
function createPoleArchiveFolder(folderName) {
  var rootFolder = getOrCreateFolder(CONFIG.DRIVE_ROOT_FOLDER);
  return getOrCreateFolder(folderName, rootFolder);
}

// ================= TELEGRAM HELPER =================
/**
 * Mengunduh file foto dari server Telegram menggunakan metode `getFile`.
 * @param {string} token Token Bot Telegram.
 * @param {string} fileId Identitas file pada payload Telegram.
 * @return {GoogleAppsScript.Base.Blob} Objek Blob gambar siap olah.
 */
function getTelegramFileBlob(token, fileId) {
  try {
    var getFileUrl = "https://api.telegram.org/bot" + token + "/getFile?file_id=" + fileId;
    var res = UrlFetchApp.fetch(getFileUrl, { muteHttpExceptions: true });
    var data = JSON.parse(res.getContentText());
    if (data.ok && data.result && data.result.file_path) {
      var downloadUrl = "https://api.telegram.org/file/bot" + token + "/" + data.result.file_path;
      return UrlFetchApp.fetch(downloadUrl, { muteHttpExceptions: true }).getBlob();
    }
  } catch (e) {
    Logger.log("Error getTelegramFileBlob: " + e);
  }
  return null;
}

/**
 * Mengirimkan pesan balasan ke chat Telegram melalui Bot API `sendMessage`.
 * @param {number|string} chatId ID chat tujuan.
 * @param {string} text Teks pesan berformat Markdown.
 */
function sendTelegramMessage(chatId, text) {
  try {
    var url = "https://api.telegram.org/bot" + CONFIG.TELEGRAM_TOKEN + "/sendMessage";
    var payload = {
      chat_id: chatId,
      text: text,
      parse_mode: "Markdown"
    };
    var options = {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    };
    var res = UrlFetchApp.fetch(url, options);
    var data = JSON.parse(res.getContentText());
    return data.ok && data.result ? data.result.message_id : null;
  } catch (e) {
    Logger.log("Error sendTelegramMessage: " + e);
    return null;
  }
}
