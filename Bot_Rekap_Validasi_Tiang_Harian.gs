/**
 * ============================================================================
 * BOT TELEGRAM REKAP VALIDASI TIANG HARIAN (GOOGLE APPS SCRIPT)
 * ============================================================================
 * @file        Bot_Rekap_Validasi_Tiang_Harian.gs
 * @author      M Rislan Tristansyah
 * @platform    Google Apps Script (Serverless Webhook & Time-Driven Trigger)
 * @description Sistem otomasi pencatatan laporan validasi tiang harian dari
 *              grup Telegram operasional ke Google Spreadsheet serta penyusunan
 *              rekapitulasi kepatuhan target harian teknisi secara terjadwal.
 *
 * Prasyarat Konfigurasi (Script Properties / Konstanta):
 * 1. Simpan Token Bot Telegram pada Script Properties dengan kunci `BOT_TOKEN`
 *    (atau isi nilai konstanta `BOT_TOKEN` secara lokal sebelum deployment).
 * 2. Pastikan sheet target bernama sesuai konstanta `NAMA_SHEET`
 *    (default: "Raw Validasi Tiang") dengan header pada baris 1 sampai 3
 *    dan data pencatatan dimulai pada baris ke-4.
 * 3. Daftarkan username Telegram resmi teknisi ke dalam array `DAFTAR_TEKNISI`.
 * ============================================================================
 */

// ----------------------------------------------------------------------------
// KONFIGURASI SISTEM DAN PARAMETER OPERASIONAL
// ----------------------------------------------------------------------------

/**
 * Token autentikasi Bot Telegram yang diperoleh dari @BotFather.
 * Demi keamanan informasi, kosongkan nilai fallback sebelum publikasi kode.
 * @type {string}
 */
const BOT_TOKEN = PropertiesService.getScriptProperties().getProperty("BOT_TOKEN") || "";

/** @type {number} Target minimum validasi tiang per teknisi setiap hari. */
const TARGET_HARIAN = 10;

/** @type {string} Nama tab sheet target untuk penyimpanan data mentah validasi. */
const NAMA_SHEET = "Raw Validasi Tiang";

/**
 * Pengaturan mode notifikasi balasan pada grup Telegram:
 * - false : Mode hening (bot mencatat data di latar belakang untuk mencegah
 *           kepadatan pesan / spam pada grup operasional).
 * - true  : Mode interaktif (bot membalas setiap laporan yang masuk).
 * @type {boolean}
 */
const BALAS_CHAT_LAPORAN = false;

/**
 * Daftar username Telegram resmi teknisi yang dipantau dalam rekap harian.
 * Kosongkan pada repositori publik untuk menjaga privasi personil operasional.
 *
 * Contoh format pengisian:
 * const DAFTAR_TEKNISI = [
 *   "@username_teknisi_01",
 *   "@username_teknisi_02"
 * ];
 * @type {string[]}
 */
const DAFTAR_TEKNISI = [
  // Tambahkan username Telegram teknisi secara berurutan, contoh: "@teknisi_01"
];

/**
 * Endpoint HTTP GET untuk verifikasi status aktif Web App melalui browser.
 * @param {GoogleAppsScript.Events.DoGet} e Objek event permintaan GET.
 * @return {GoogleAppsScript.Content.TextOutput} Pesan status layanan aktif.
 */
function doGet(e) {
  return ContentService.createTextOutput("Bot Rekap Tiang Produksi Siap!");
}

// Penapis laporan Valins / Expand ODP agar tidak tercatat sebagai validasi tiang
/**
 * Mendeteksi apakah teks pesan merupakan laporan Valins atau Expand ODP
 * yang tidak termasuk cakupan pencatatan validasi tiang harian.
 * @param {string} text Teks pesan atau caption dari Telegram.
 * @return {boolean} Bernilai true apabila pesan terdeteksi sebagai laporan Valins/Expand ODP.
 */
function isValinsOrExpand(text) {
  if (!text) return false;
  const t = text.toUpperCase();
  const keywords = [
    "EXPAND", "VALINS", "PORT_ODP", "IP OLT", "ONU_ID", "ONU_SN", 
    "ONU RX", "POWER CHECKING", "DROPCORE", "QR-CODE", "SUMMARY ODP", 
    "PANEL01", "PORT_ODP|ONU_ID"
  ];
  return keywords.some(k => t.indexOf(k) !== -1);
}

/**
 * Handler utama webhook Telegram (HTTP POST) untuk memproses pesan masuk,
 * mengekstrak kode identifikasi tiang resmi, mencegah duplikasi harian,
 * serta mencatat laporan ke Google Spreadsheet.
 * @param {GoogleAppsScript.Events.DoPost} e Objek event payload JSON dari Telegram.
 */
function doPost(e) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;

  try {
    if (!e || !e.postData || !e.postData.contents) return;
    const data = JSON.parse(e.postData.contents);
    const message = data.message;
    if (!message) return;

    const chatId = message.chat.id;
    const messageId = message.message_id;
    const rawText = message.text || message.caption || "";
    const fromUser = message.from;
    const username = fromUser.username ? "@" + fromUser.username : (fromUser.first_name || "Tanpa_Username");

    // Simpan Chat ID grup tempat pesan dikirim
    PropertiesService.getScriptProperties().setProperty("GROUP_CHAT_ID", String(chatId));

    // 1. Perintah Manual /rekap
    if (rawText.trim().toLowerCase().startsWith("/rekap")) {
      kirimRekap(chatId);
      return;
    }

    // 2. CEK & ABAIKAN TOTAL LAPORAN EXPAND / VALINS ODP
    if (isValinsOrExpand(rawText)) {
      return; // Langsung keluar! Pesan Expand/Valins tidak boleh masuk ke rekap tiang
    }

    // 3. Filter Laporan Validasi Tiang (Mendukung semua STO: PWK, CBU, PLD, dll)
    const cleanedText = rawText.replace(/\s*-\s*/g, "-");
    // Format tiang Telkom resmi: Kode STO (2-5 huruf) - Segmen (2-5 karakter) - Nomor Tiang (1-5 digit) - Opsional Kepemilikan (TLKM/TLKO/dll)
    const labelPattern = /\b[A-Za-z]{2,5}-[A-Za-z0-9]{2,5}-\d{1,5}(?:-[A-Za-z0-9]+)?\b/g;
    const rawMatches = cleanedText.match(labelPattern) || [];

    // Filter ketat: Buang jika itu ODP, tanggal YYYY-MM-DD, atau nomor tiket INC
    const foundMatches = rawMatches.filter(lbl => {
      const u = lbl.toUpperCase();
      if (u.startsWith("ODP-")) return false; // Abaikan ODP
      if (/^\d{4}-\d{2}-\d{2}$/.test(lbl)) return false; // Abaikan tanggal YYYY-MM-DD (seperti 2026-10-08)
      if (u.startsWith("INC")) return false; // Abaikan tiket
      return true;
    });

    if (foundMatches.length === 0) return;

    // Bersihkan duplikat di dalam pesan yang sama
    const uniqueLabelsInChat = [...new Set(foundMatches.map(l => l.toUpperCase().trim()))];

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const rawSheet = ss.getSheetByName(NAMA_SHEET) || ss.getActiveSheet();

    const existingData = rawSheet.getDataRange().getValues();
    const existingLabels = new Set();
    for (let i = 3; i < existingData.length; i++) {
      if (existingData[i][4]) {
        existingLabels.add(String(existingData[i][4]).toUpperCase().trim());
      }
    }

    const now = new Date();
    const timeStampStr = Utilities.formatDate(now, "Asia/Jakarta", "yyyy-MM-dd HH:mm:ss");
    const todayDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const berhasilList = [];
    const duplikatList = [];

    uniqueLabelsInChat.forEach(lbl => {
      if (existingLabels.has(lbl)) {
        duplikatList.push(lbl);
      } else {
        const lastRow = rawSheet.getLastRow();
        const nextNo = lastRow >= 3 ? (lastRow - 3 + 1) : 1;

        rawSheet.appendRow([nextNo, timeStampStr, todayDate, username, lbl]);
        existingLabels.add(lbl);
        berhasilList.push(lbl);
      }
    });

    // 4. Respon Balasan (Hanya dikirim jika BALAS_CHAT_LAPORAN = true)
    if (BALAS_CHAT_LAPORAN && berhasilList.length > 0) {
      const dateStr = Utilities.formatDate(now, "Asia/Jakarta", "yyyy-MM-dd");
      let totalHariIni = 0;
      const updatedData = rawSheet.getDataRange().getValues();
      for (let i = 3; i < updatedData.length; i++) {
        const rawDate = updatedData[i][2];
        let rowDateStr = (rawDate instanceof Date) 
          ? Utilities.formatDate(rawDate, "Asia/Jakarta", "yyyy-MM-dd")
          : String(rawDate).trim();

        const rowUser = String(updatedData[i][3]).toLowerCase().trim();
        if (rowDateStr === dateStr && rowUser === username.toLowerCase()) {
          totalHariIni++;
        }
      }

      let reply = "LAPORAN VALIDASI TIANG\nTeknisi: " + username + "\n";
      reply += "Berhasil Direkap: +" + berhasilList.length + " Tiang\n";
      reply += "Capaian Hari Ini: " + totalHariIni + "/" + TARGET_HARIAN + " Tiang";
      kirimPesan(chatId, reply, messageId);
    }

  } catch (err) {
    Logger.log("Error: " + err.toString());
  } finally {
    lock.releaseLock();
  }
}

/**
 * Menghitung realisasi validasi tiang harian setiap teknisi berdasarkan
 * catatan pada sheet target dan mengirimkan laporan rekapitulasi ke grup Telegram.
 * @param {number|string} chatId ID chat grup atau pengguna tujuan pengiriman rekap.
 */
function kirimRekap(chatId) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const rawSheet = ss.getSheetByName(NAMA_SHEET) || ss.getActiveSheet();
  if (!rawSheet) return;

  const now = new Date();
  const dateStr = Utilities.formatDate(now, "Asia/Jakarta", "yyyy-MM-dd");
  const dateDisplay = Utilities.formatDate(now, "Asia/Jakarta", "dd/MM/yyyy");

  const data = rawSheet.getDataRange().getValues();
  const counter = {};
  
  // Inisialisasi penghitung untuk seluruh teknisi resmi pada DAFTAR_TEKNISI
  DAFTAR_TEKNISI.forEach(tek => counter[tek.toLowerCase()] = 0);

  for (let i = 3; i < data.length; i++) {
    const rawDate = data[i][2];
    let rowDateStr = (rawDate instanceof Date)
      ? Utilities.formatDate(rawDate, "Asia/Jakarta", "yyyy-MM-dd")
      : String(rawDate).trim();

    const rowUser = String(data[i][3]).toLowerCase().trim();

    if (rowDateStr === dateStr) {
      if (counter.hasOwnProperty(rowUser)) {
        counter[rowUser]++;
      }
    }
  }

  let text = "REKAP VALIDASI TIANG\n";
  text += "Tanggal: " + dateDisplay + "\n";
  text += "Target: " + TARGET_HARIAN + " Tiang / Teknisi\n\n";
  text += "Nama / Close:\n";

  let totalSemua = 0;
  // Susun ringkasan capaian hanya untuk teknisi resmi pada DAFTAR_TEKNISI
  DAFTAR_TEKNISI.forEach((tek, index) => {
    const close = counter[tek.toLowerCase()] || 0;
    totalSemua += close;
    text += (index + 1) + ". " + tek + " / " + close + "\n";
  });

  text += "\nTotal Validasi: " + totalSemua + " Tiang";
  kirimPesan(chatId, text);
}

/**
 * Fungsi callback yang dieksekusi oleh Time-Driven Trigger untuk mengirimkan
 * rekapitulasi validasi tiang secara otomatis pada jam operasional yang ditentukan.
 */
function kirimRekapJadwal() {
  const chatId = PropertiesService.getScriptProperties().getProperty("GROUP_CHAT_ID");
  if (chatId) {
    kirimRekap(chatId);
  }
}

/**
 * Mendaftarkan pemicu waktu (Time-Driven Triggers) secara terprogram untuk
 * menjalankan fungsi `kirimRekapJadwal` setiap hari pukul 12:00 dan 15:00 WIB.
 * Jalankan fungsi ini satu kali melalui editor Google Apps Script.
 */
function pasangJadwalOtomatis() {
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(t => {
    if (t.getHandlerFunction() === "kirimRekapJadwal") ScriptApp.deleteTrigger(t);
  });

  // Jam 12 Siang
  ScriptApp.newTrigger("kirimRekapJadwal")
    .timeBased()
    .atHour(12)
    .everyDays(1)
    .inTimezone("Asia/Jakarta")
    .create();

  // Jam 15 (3 Sore)
  ScriptApp.newTrigger("kirimRekapJadwal")
    .timeBased()
    .atHour(15)
    .everyDays(1)
    .inTimezone("Asia/Jakarta")
    .create();
}

/**
 * Mengirimkan pesan teks berformat Markdown ke Telegram melalui Bot API `sendMessage`.
 * @param {number|string} chatId ID chat tujuan.
 * @param {string} text Isi pesan yang akan dikirimkan.
 * @param {number} [replyToMessageId] ID pesan referensi apabila dikirim sebagai balasan.
 */
function kirimPesan(chatId, text, replyToMessageId) {
  const url = "https://api.telegram.org/bot" + BOT_TOKEN + "/sendMessage";
  const payload = {
    chat_id: chatId,
    text: text
  };
  if (replyToMessageId) {
    payload.reply_to_message_id = replyToMessageId;
  }
  UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
}
