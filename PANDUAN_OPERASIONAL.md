# BUKU PANDUAN TEKNIS DAN OPERASIONAL SISTEM OTOMASI BOT TELEGRAM TERINTEGRASI GOOGLE SPREADSHEET DAN GOOGLE APPS SCRIPT

**Disusun oleh:** M Rislan Tristansyah (NIM. 2307874)  
**Program Studi:** Sistem Telekomunikasi, Universitas Pendidikan Indonesia Kampus di Purwakarta  
**Lokasi Implementasi:** PT Telkom Indonesia (Datel Purwakarta dan Telkom Akses STO Purwakarta)  
**Repositori Resmi:** https://github.com/Rislantrs/telkom-purwakarta-telegram-bots

---

## DAFTAR ISI

1. [BAB I - Pendahuluan dan Arsitektur Sistem](#bab-i-pendahuluan-dan-arsitektur-sistem)
2. [BAB II - Pembuatan Akun Bot Telegram melalui BotFather](#bab-ii-pembuatan-akun-bot-telegram-melalui-botfather)
3. [BAB III - Persiapan Google Spreadsheet dan Google Drive](#bab-iii-persiapan-google-spreadsheet-dan-google-drive)
4. [BAB IV - Pemasangan Kode ke Google Apps Script dan Konfigurasi](#bab-iv-pemasangan-kode-ke-google-apps-script-dan-konfigurasi)
5. [BAB V - Deployment Web App, Webhook, dan Trigger Otomatis](#bab-v-deployment-web-app-webhook-dan-trigger-otomatis)
6. [BAB VI - Panduan Penggunaan Operasional dan Format Pesan](#bab-vi-panduan-penggunaan-operasional-dan-format-pesan)
7. [BAB VII - Pemecahan Masalah dan Pemeliharaan Sistem](#bab-vii-pemecahan-masalah-dan-pemeliharaan-sistem)

---

## BAB I PENDAHULUAN DAN ARSITEKTUR SISTEM

### 1.1 Latar Belakang dan Tujuan Panduan
Operasional pemeliharaan jaringan akses fiber optik dan aktivitas penjualan oleh teknisi lapangan di Telkom Akses STO Purwakarta dan Datel Purwakarta menghasilkan volume laporan harian yang tinggi melalui aplikasi pesan instan Telegram. Tanpa sistem otomasi terstruktur, staf administrasi harus menyalin laporan kode tiang, nomor Service Order (`SC`), nomor Work Order (`WO`), serta gambar bukti pekerjaan satu per satu ke dalam lembar kerja Google Spreadsheet.

Panduan ini disusun sebagai rujukan operasional standar agar pengguna dan pengelola sistem mampu memasang, mengonfigurasi, serta mengoperasikan ketiga bot Telegram secara mandiri di atas Google Apps Script, Google Sheets, dan Google Drive.

### 1.2 Ringkasan Ketiga Modul Bot

| No | Nama Modul & File Skrip | Fungsi Utama | Integrasi Spreadsheet & API |
| :--- | :--- | :--- | :--- |
| 1 | **Bot Rekap Validasi Tiang Harian** (`Bot_Rekap_Validasi_Tiang_Harian.gs`) | Menangkap laporan kode validasi tiang dari grup Telegram, menapis pesan Valins/Expand ODP, mencegah duplikasi harian, dan mengirim rekap otomatis terjadwal. | Tab `Raw Validasi Tiang` (Container-Bound), Telegram Bot API, Time-Driven Trigger (12:00 & 15:00 WIB). |
| 2 | **Bot Order Teknisi as Sales** (`Bot_Rekap_Order_Teknisi_as_Sales.gs`) | Mengekstrak laporan order penjualan teknisi (`STO`, `NO SC`, `NO WO`) dalam berbagai format penulisan, mengecek duplikasi lintas sheet, serta menyediakan manajemen profil mandiri. | Tab `DATA BOT`, `DATA MANUAL`, `TABEL` (Container-Bound), Telegram Bot API, `LockService` & `CacheService`. |
| 3 | **Bot Evidensi Cat Tiang AI Vision** (`Bot_Rekap_Cat_Tiang.gs`) | Menampung foto evidensi pengecatan tiang sementara di Google Drive, mengklasifikasikan 4 foto terbaik menggunakan Vision AI, menyisipkan gambar ke sel tabel, dan membersihkan staging. | Tab `REKAPAN CAT TIANG` (`openById`), Google Drive folder `EVIDENSI_CAT_TIANG`, Gemini API & OpenRouter API. |

### 1.3 Arsitektur Alur Kerja dan Keamanan Kredensial
Ketiga bot menerapkan arsitektur Webhook Berbasis Event (`doPost`). Setiap pesan masuk dikirim oleh server Telegram via HTTPS POST ke Web App Google Apps Script, dikunci menggunakan `LockService` untuk mencegah tabrakan baris serentak, lalu ditulis ke Google Spreadsheet. Seluruh rahasia (Token Bot, API Key, Spreadsheet ID, Web App URL) dikelola melalui `PropertiesService.getScriptProperties()` agar tidak tertulis langsung di repositori kode sumber.

### 1.4 Persyaratan Akun dan Layanan
- **Akun Google Workspace / Gmail:** Akses Google Sheets, Google Drive, dan Google Apps Script.
- **Akun Telegram:** Untuk membuat bot di `@BotFather` dan operasional grup.
- **Akun Google AI Studio (Khusus Bot Cat Tiang):** Untuk memperoleh `GEMINI_API_KEY`.
- **Akun OpenRouter (Opsional):** Untuk `OPENROUTER_API_KEY` sebagai jalur cadangan Vision AI.

---

## BAB II PEMBUATAN AKUN BOT TELEGRAM MELALUI BOTFATHER

### 2.1 Registrasi Bot Baru dan Pengambilan Token
Setiap modul skrip memerlukan satu akun bot Telegram terpisah agar webhook tidak saling menimpa:
1. Buka aplikasi Telegram, cari akun resmi **`@BotFather`** (bercentang biru).
2. Kirim perintah `/start` lalu `/newbot`.
3. Masukkan **Display Name** bot (misalnya `Bot Validasi Tiang PWK`).
4. Masukkan **Username** unik berakhiran `bot` atau `_bot` (misalnya `validasitiang_pwk_bot`).
5. Simpan **HTTP API Token** (`1234567890:AAF...`) untuk diisi ke `Script Properties`.

### 2.2 Menonaktifkan Mode Privasi Grup (`/setprivacy`)
Bot di dalam grup secara bawaan tidak dapat membaca pesan biasa (kecuali perintah `/...`). Untuk **Bot Validasi Tiang** dan **Bot Order Teknisi**, nonaktifkan mode privasi:
1. Kirim `/setprivacy` di `@BotFather`.
2. Pilih username bot yang bersangkutan.
3. Pilih **`Disable`** hingga muncul `Success! The new status is: DISABLED`.

> **Catatan:** Jika bot sudah berada di grup sebelum mode privasi diubah menjadi `Disable`, keluarkan bot terlebih dahulu dari grup lalu undang ulang (atau jadikan Admin grup) agar hak akses baru berlaku.

### 2.3 Menambahkan Bot ke Grup Operasional
1. Buka grup Telegram operasional, pilih **Add Members**, lalu masukkan bot.
2. Untuk **Bot Validasi Tiang**, setelah webhook aktif, kirim satu pesan atau `/rekap` di dalam grup agar skrip menyimpan `GROUP_CHAT_ID` untuk jadwal rekap pukul 12:00 dan 15:00 WIB.

---

## BAB III PERSIAPAN GOOGLE SPREADSHEET DAN GOOGLE DRIVE

### 3.1 Spreadsheet Bot Rekap Validasi Tiang Harian (`Bot_Rekap_Validasi_Tiang_Harian.gs`)
Skrip bersifat Container-Bound (`getActiveSpreadsheet()`).
1. Buat Google Spreadsheet baru, ubah nama tab pertama menjadi **`Raw Validasi Tiang`** (persis kapital dan spasi).
2. Gunakan **Baris 1 hingga Baris 3** sebagai area judul dan header tabel karena skrip membaca data mulai indeks ke-3 (**Baris ke-4**):

| Kolom | Indeks Kode | Nama Header (Baris 3) | Tipe / Format Data | Contoh Nilai Otomatis |
| :---: | :---: | :--- | :--- | :--- |
| A | 0 | `No` | Angka bulat urut | `1` |
| B | 1 | `Timestamp` | Teks tanggal & jam WIB | `2026-10-08 09:15:30` |
| C | 2 | `Tanggal` | Date (`yyyy-MM-dd`) | `2026-10-08` |
| D | 3 | `Username Telegram` | Teks diawali `@` | `@teknisi_01` |
| E | 4 | `Label Tiang` | Teks huruf kapital | `PWK-FFK-116-TLKM` |

### 3.2 Spreadsheet Bot Order Teknisi as Sales (`Bot_Rekap_Order_Teknisi_as_Sales.gs`)
Skrip ini juga bersifat Container-Bound (`getActiveSpreadsheet()`) dan menggunakan 3 tab sheet:
1. **`DATA BOT`** (Header pada Baris 1): `TANGGAL INPUT` | `NIK` | `NAMA TEKNISI` | `Username Akun Digipos` | `Username Telegram` | `STO` | `NO SC` | `NO WO` | `BULAN` (dibuat otomatis jika belum ada).
2. **`DATA MANUAL`** (Opsional): Arsip data order lama berisi kolom `NO SC` dan `NO WO` untuk validasi anti-duplikasi.
3. **`TABEL`** (Header pada Baris 1): `NO` | `NIK` | `NAMA TEKNISI` | `STREAM` | `USER TELE` | `USER DIGIPOS` | `TELEGRAM ID`. Awali NIK dengan tanda petik tunggal (`'`) jika berawalan nol.

### 3.3 Spreadsheet dan Google Drive Bot Evidensi Cat Tiang (`Bot_Rekap_Cat_Tiang.gs`)
Skrip membuka file lewat `SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID)`:
1. Salin `SPREADSHEET_ID` dari URL Google Sheets (string di antara `/d/` dan `/edit`).
2. Buat tab sheet bernama **`REKAPAN CAT TIANG`** dengan header Baris 1:
   - Kolom A (`No`), Kolom B (`Sektor`), Kolom C (`Datek / ODP`), Kolom D (`Tiket`), Kolom E (`SEBELUM`), Kolom F (`SESUDAH`), Kolom G (`ODP`), Kolom H (`MARKING_LABEL`), Kolom I (`Validasi Tiang`), Kolom J (`Timestamp Close`).
3. Mulai **Baris ke-2**, susun blok **4 baris tergabung (merged 4 rows)** per nomor urut tiang pada Kolom A sampai J agar thumbnail foto (`110x82 px`) tampil rapi.
4. Di Google Drive, skrip otomatis membuat folder induk `EVIDENSI_CAT_TIANG`, subfolder `STAGING_<userId>`, dan folder arsip per tiang.

---

## BAB IV PEMASANGAN KODE KE GOOGLE APPS SCRIPT DAN KONFIGURASI

### 4.1 Memasang Skrip ke Editor Apps Script
1. Buka Google Spreadsheet yang disiapkan pada Bab III, lalu klik menu **Ekstensi -> Apps Script**.
2. Hapus kode bawaan pada file tab default **`Code.gs`** di editor Apps Script.
3. Salin seluruh kode dari file `.gs` terkait di repositori ini, lalu tempelkan ke tab `Code.gs` editor Apps Script dan simpan (**Ctrl + S**).
4. Khusus **`Bot_Rekap_Validasi_Tiang_Harian.gs`**, isi daftar username Telegram teknisi resmi ke dalam array `DAFTAR_TEKNISI`.

### 4.2 Memperoleh API Key AI Vision (Khusus `Bot_Rekap_Cat_Tiang.gs`)
1. **Google AI Studio:** Buka `https://aistudio.google.com/` -> **Get API key -> Create API key** -> salin sebagai `GEMINI_API_KEY`.
2. **OpenRouter (Opsional Cadangan):** Buka `https://openrouter.ai/` -> **Keys -> Create Key** -> salin sebagai `OPENROUTER_API_KEY`.

### 4.3 Konfigurasi Kredensial pada Script Properties
Di editor Apps Script, buka **Project Settings (ikon roda gigi)** -> **Script Properties -> Add script property**, lalu isi kunci berikut:

| Modul Skrip | Key (Property) | Keterangan Nilai (Value) |
| :--- | :--- | :--- |
| `Bot_Rekap_Validasi_Tiang_Harian.gs` | `BOT_TOKEN` | Token Bot Telegram Validasi Tiang |
| `Bot_Rekap_Order_Teknisi_as_Sales.gs` | `BOT_TOKEN` | Token Bot Telegram Order Teknisi |
| `Bot_Rekap_Order_Teknisi_as_Sales.gs` | `WEBAPP_URL` | URL Deployment Web App (`/exec`) |
| `Bot_Rekap_Cat_Tiang.gs` | `BOT_USERNAME` | Username bot (contoh `@BotCatTiangPWK_bot`) |
| `Bot_Rekap_Cat_Tiang.gs` | `TELEGRAM_TOKEN` | Token Bot Telegram Cat Tiang |
| `Bot_Rekap_Cat_Tiang.gs` | `SPREADSHEET_ID` | ID Google Spreadsheet target |
| `Bot_Rekap_Cat_Tiang.gs` | `GEMINI_API_KEY` | API Key dari Google AI Studio |
| `Bot_Rekap_Cat_Tiang.gs` | `OPENROUTER_API_KEY` | API Key OpenRouter (opsional) |
| `Bot_Rekap_Cat_Tiang.gs` | `GROQ_API_KEY` | API Key Groq (opsional) |

---

## BAB V DEPLOYMENT WEB APP, WEBHOOK, DAN TRIGGER OTOMATIS

### 5.1 Deploy Web App
1. Klik **Deploy -> New deployment** -> pilih tipe **Web app**.
2. Atur **Execute as:** `Me`, dan **Who has access:** `Anyone`.
3. Klik **Deploy**, berikan izin akses Google saat diminta (*Advanced -> Go to ... -> Allow*), lalu salin **Web App URL** (`/exec`).

### 5.2 Verifikasi `doGet` dan Registrasi Webhook
1. Buka Web App URL di browser untuk memastikan muncul pesan status aktif (`Siap!` / `Aktif 24/7` / JSON `"status": "ONLINE"`).
2. Daftarkan webhook Telegram:
   - Pada **`Bot_Rekap_Order_Teknisi_as_Sales.gs`**, simpan URL ke Script Property `WEBAPP_URL`, lalu jalankan fungsi `setWebhook()` di editor Apps Script.
   - Pada dua bot lainnya, buka URL berikut di browser:
     `https://api.telegram.org/bot<TOKEN_BOT_ANDA>/setWebhook?url=<WEBAPP_URL_ANDA>&drop_pending_updates=true`
3. Setiap mengubah kode setelah deploy, wajib klik **Deploy -> Manage deployments -> Edit -> Version: New version -> Deploy**.

### 5.3 Mengaktifkan Trigger Rekap Otomatis (`Bot_Rekap_Validasi_Tiang_Harian.gs`)
Pilih fungsi `pasangJadwalOtomatis` di dropdown toolbar editor Apps Script lalu klik **Run** satu kali untuk mengaktifkan pengiriman rekap harian otomatis pukul 12:00 dan 15:00 WIB.

---

## BAB VI PANDUAN PENGGUNAAN OPERASIONAL DAN FORMAT PESAN

### 6.1 Bot Rekap Validasi Tiang Harian
- Kirim kode tiang resmi di grup (contoh: `PWK-FFK-116-TLKM`, `PLD-FAM-089`) agar otomatis direkap ke `Raw Validasi Tiang`. Laporan Valins, Expand ODP, `ODP-...`, tanggal `YYYY-MM-DD`, dan tiket `INC...` diabaikan otomatis.
- Perintah manual: `/rekap` untuk memicu rekap harian ke grup.

### 6.2 Bot Order Teknisi as Sales
- **Perintah Profil:** `/start`, `/help`, `/panduan`, `/profil`, `/cek`, `/regist NIK / NAMA / DIGIPOS`, `/ubah nama <baru>`, `/ubah digipos <baru>`, `/ubah tele <@user>`, `/update NIK / NAMA / DIGIPOS`.
- **Contoh Input Order:**
```text
PWK DGPS260802120146323868801 WO060711901

Digipos : CONTOH_DIGIPOS_01
STO : PWK
NO SC : DGPS261007113521346628010
NO WO : WO065923958
```

### 6.3 Bot Evidensi Pengecatan Tiang AI Vision
- Kirim 4 hingga 10 foto sekaligus dengan caption metadata (`VALIDASI TIANG`, kode tiang, ODP, tiket, sektor), atau kirim teks metadata dahulu baru disusul foto secara bertahap tanpa caption.
- Perintah: `/status` (cek antrean staging dan progres 4 slot) dan `/batal` (reset sesi & hapus file sementara).

---

## BAB VII PEMECAHAN MASALAH DAN PEMELIHARAAN SISTEM

| Gejala Masalah | Penyebab Umum | Solusi |
| :--- | :--- | :--- |
| Bot diam di grup Telegram | Privacy Mode masih `Enabled` | Jalankan `/setprivacy` di `@BotFather` -> `Disable`, lalu keluarkan dan masukkan kembali bot ke grup. |
| Perubahan kode tidak berefek | Lupa membuat versi deployment baru | Gunakan **Deploy -> Manage deployments -> Edit -> New version -> Deploy**. |
| Error `302` / `401` pada `getWebhookInfo` | Akses Web App belum publik | Ubah **Who has access** menjadi `Anyone`. |
| Rekap otomatis tidak terkirim | `pasangJadwalOtomatis()` belum dijalankan atau `GROUP_CHAT_ID` kosong | Jalankan `pasangJadwalOtomatis()` di editor, lalu kirim `/rekap` sekali di grup target. |
| Bot Cat Tiang lambat / gagal analisis | Rate limit API Gemini | Pastikan `OPENROUTER_API_KEY` diisi sebagai cadangan otomatis. |

### Pemeliharaan Rutin
Periksa tab **Executions** secara berkala, kosongkan **Trash** Google Drive bila penuh, lakukan `/revoke` token di `@BotFather` jika terjadi pergantian pengelola, dan buat salinan cadangan Spreadsheet setiap bulan.