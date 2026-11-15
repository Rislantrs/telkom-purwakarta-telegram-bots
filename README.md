# Sistem Otomasi Pelaporan Operasional Telegram Berbasis Google Apps Script

Repositori ini berisi kumpulan skrip **Google Apps Script (.gs)** untuk otomasi pelaporan operasional lapangan berbasis **Bot Telegram**, **Google Sheets**, **Google Drive**, serta **Vision AI**. Sistem ini dikembangkan dan diimplementasikan dalam rangka kegiatan Program Penguatan Profesional Keahlian (P3Kh) di PT Telkom Indonesia (Datel Purwakarta dan Telkom Akses STO Purwakarta).

Seluruh kredensial sensitif (seperti Token Bot Telegram, API Key AI, Spreadsheet ID, Web App URL, dan daftar data personil) telah dikosongkan pada repositori publik ini dan dikelola menggunakan `PropertiesService.getScriptProperties()` agar aman diterapkan di lingkungan produksi maupun pengembangan.

---

## Daftar File Kode Sumber

| Nama File | Nama Layanan | Mode Integrasi Spreadsheet | Layanan Eksternal |
| :--- | :--- | :--- | :--- |
| `Bot_Rekap_Validasi_Tiang_Harian.gs` | Bot Rekap Validasi Tiang Harian | Container-Bound (`getActiveSpreadsheet`) | Telegram Bot API |
| `Code.gs` | Bot Rekap Order Teknisi as Sales | Container-Bound (`getActiveSpreadsheet`) | Telegram Bot API |
| `Bot_Rekap_Cat_Tiang.gs` | Bot Evidensi Pengecatan Tiang AI Vision | Standalone / Bound (`openById`) | Telegram Bot API, Google Drive, Gemini API, OpenRouter API |

---

## Ringkasan Fungsionalitas Modul

### 1. Bot Rekap Validasi Tiang Harian (`Bot_Rekap_Validasi_Tiang_Harian.gs`)
Skrip ini memantau grup Telegram operasional secara pasif maupun interaktif untuk mengekstrak kode identifikasi tiang jaringan resmi Telkom (`STO-SEGMEN-NOMOR[-PEMILIK]`, misalnya `PWK-FFK-012` atau `PWK-FFK-012-TLKM`).
- **Penapisan Cerdas:** Mengabaikan pesan laporan Valins / Expand ODP, kode ODP (`ODP-...`), tanggal berformat `YYYY-MM-DD`, serta nomor tiket gangguan (`INC...`).
- **Anti-Duplikasi & Antrean:** Menggunakan `LockService` serta himpunan pengecekan global sehingga kode tiang yang sudah dilaporkan sebelumnya tidak dicatat ganda.
- **Pelaporan Harian Otomatis:** Mendukung perintah manual `/rekap` dan pengiriman rekapitulasi kepatuhan target harian (`TARGET_HARIAN = 10` per teknisi) melalui Time-Driven Trigger pada pukul 12:00 WIB dan 15:00 WIB.

### 2. Bot Rekap Order Teknisi as Sales (`Code.gs`)
Skrip ini mengotomatiskan pencatatan order penjualan oleh teknisi (nomor Service Order / `SC` dan Work Order / `WO`) pada area STO yang didukung (`PWK`, `PLD`, `CBU`).
- **Parser Multi-Skenario:** Mengenali laporan dalam format terstruktur multi-baris, satu baris ringkas, maupun banyak order dalam satu pesan sekaligus.
- **Validasi Duplikasi Lintas Sheet:** Memeriksa kecocokan kode `SC` dan `WO` terhadap sheet `DATA BOT` dan arsip `DATA MANUAL` sebelum penyimpanan dilakukan.
- **Manajemen Profil Mandiri:** Teknisi dapat memeriksa data diri dan melakukan pendaftaran atau pembaruan akun melalui perintah `/start`, `/help`, `/panduan`, `/profil`, `/cek`, `/regist`, `/ubah`, dan `/update`.

### 3. Bot Evidensi Pengecatan Tiang Berbasis AI Vision (`Bot_Rekap_Cat_Tiang.gs`)
Skrip ini mengolah foto evidensi pekerjaan pengecatan tiang yang dikirim oleh teknisi ke Telegram untuk ditempatkan langsung ke dalam sel gambar berstruktur di Google Spreadsheet.
- **Google Drive Staging Terisolasi:** Setiap foto sementara ditampung pada subfolder `EVIDENSI_CAT_TIANG / STAGING_<userId>` agar pengiriman dari beberapa teknisi secara bersamaan tidak saling tertukar.
- **Klasifikasi Otomatis 4 Slot Foto (Cascading Vision AI):** Mengirimkan batch foto ke model Vision AI (Google Gemini API dan cadangan otomatis OpenRouter API) untuk memilih maksimal 4 foto terbaik ke kategori `SEBELUM`, `SESUDAH`, `ODP`, dan `MARKING_LABEL`.
- **Pembersihan Storage Otomatis:** Foto terpilih dipindahkan ke folder arsip tiang di Google Drive dan file staging sementara dibersihkan secara otomatis setelah proses selesai.

---

## Struktur Google Spreadsheet yang Diperlukan

Sebelum memasang skrip, siapkan tab sheet sesuai ketentuan masing-masing modul:

### A. Spreadsheet untuk `Bot_Rekap_Validasi_Tiang_Harian.gs`
1. Buat tab sheet bernama **`Raw Validasi Tiang`**.
2. Gunakan **baris 1 hingga baris 3** untuk judul tabel dan header kolom. Data pencatatan akan dimulai dari **baris ke-4**:
   - Kolom A: `No`
   - Kolom B: `Timestamp`
   - Kolom C: `Tanggal`
   - Kolom D: `Username Telegram`
   - Kolom E: `Label Tiang`

### B. Spreadsheet untuk `Code.gs` (Bot Order Teknisi)
Bot ini dapat menginisialisasi header otomatis jika tab belum ada, namun disarankan menyiapkan tiga tab berikut:
1. **`DATA BOT`** (Header pada baris 1):
   `TANGGAL INPUT` | `NIK` | `NAMA TEKNISI` | `Username Akun Digipos` | `Username Telegram` | `STO` | `NO SC` | `NO WO` | `BULAN`
2. **`DATA MANUAL`** (Opsional, header pada baris 1 menyertakan kolom `NO SC` dan `NO WO` sebagai referensi pengecekan duplikasi).
3. **`TABEL`** (Header pada baris 1):
   `NO` | `NIK` | `NAMA TEKNISI` | `STREAM` | `USER TELE` | `USER DIGIPOS` | `TELEGRAM ID`

### C. Spreadsheet untuk `Bot_Rekap_Cat_Tiang.gs`
1. Buat tab sheet bernama **`REKAPAN CAT TIANG`** dengan header pada **baris ke-1**:
   - Kolom A: `No`
   - Kolom B: `Sektor`
   - Kolom C: `Datek / ODP`
   - Kolom D: `Tiket`
   - Kolom E: `SEBELUM`
   - Kolom F: `SESUDAH`
   - Kolom G: `ODP`
   - Kolom H: `MARKING_LABEL`
   - Kolom I: `Validasi Tiang`
   - Kolom J: `Timestamp Close`
2. Setiap entri tiang dirancang menggunakan blok **4 baris tergabung (merged 4 rows)** mulai baris ke-2 agar thumbnail foto (`110 x 82 px`) tampil proporsional.

---

## Langkah Pemasangan dan Konfigurasi Singkat

### 1. Membuat Bot Telegram di `@BotFather`
1. Buka Telegram dan cari akun resmi `@BotFather`.
2. Jalankan perintah `/newbot`, lalu tentukan nama tampilan serta username bot (diakhiri kata `bot`).
3. Simpan **HTTP API Token** yang diberikan.
4. Khusus untuk bot pemantau grup (`Bot_Rekap_Validasi_Tiang_Harian.gs` dan `Code.gs`), jalankan perintah `/setprivacy` di `@BotFather`, pilih bot terkait, lalu ubah menjadi **`Disable`** agar bot dapat membaca pesan laporan teknisi di dalam grup.

### 2. Memasang Skrip ke Google Apps Script
1. Untuk bot yang bersifat container-bound (`Bot_Rekap_Validasi_Tiang_Harian.gs` dan `Code.gs`), buka file Google Spreadsheet terkait, lalu pilih menu **Ekstensi -> Apps Script**.
2. Untuk `Bot_Rekap_Cat_Tiang.gs`, dapat dibuat melalui menu **Ekstensi -> Apps Script** dari Spreadsheet maupun sebagai proyek mandiri di `https://script.google.com`.
3. Salin seluruh isi file `.gs` ke editor Apps Script, lalu simpan proyek.
4. Pada **`Bot_Rekap_Validasi_Tiang_Harian.gs`**, lengkapi array `DAFTAR_TEKNISI` dengan username Telegram teknisi resmi (contoh: `"@teknisi_01"`).

### 3. Mengatur Kredensial via Script Properties
Di editor Apps Script, buka menu **Project Settings (ikon roda gigi)** -> gulir ke bagian **Script Properties** -> klik **Add script property**, lalu tambahkan kunci sesuai skrip yang digunakan:

- **`Bot_Rekap_Validasi_Tiang_Harian.gs`**:
  - `BOT_TOKEN`: Token bot dari `@BotFather`
- **`Code.gs`**:
  - `BOT_TOKEN`: Token bot dari `@BotFather`
  - `WEBAPP_URL`: URL Web App (`/exec`) yang didapat setelah deployment
- **`Bot_Rekap_Cat_Tiang.gs`**:
  - `BOT_USERNAME`: Username bot (contoh: `@BotCatTiangAnda`)
  - `TELEGRAM_TOKEN`: Token bot dari `@BotFather`
  - `SPREADSHEET_ID`: ID Spreadsheet dari URL Google Sheets
  - `GEMINI_API_KEY`: API Key dari Google AI Studio
  - `OPENROUTER_API_KEY`: API Key cadangan dari OpenRouter (opsional)
  - `GROQ_API_KEY`: API Key cadangan Groq (opsional)

### 4. Deploy sebagai Web App dan Aktivasi Webhook
1. Klik tombol **Deploy -> New deployment** di kanan atas editor Apps Script.
2. Pilih tipe **Web app**, atur **Execute as** ke `Me` (akun Anda), dan **Who has access** ke `Anyone`.
3. Klik **Deploy**, lakukan otorisasi izin akses Google Sheets / Drive / External Request saat diminta, lalu salin **Web App URL** (`/exec`).
4. Daftarkan webhook Telegram:
   - Pada **`Code.gs`**, masukkan URL Web App ke Script Property `WEBAPP_URL`, lalu jalankan fungsi **`setWebhook()`** langsung dari editor Apps Script.
   - Pada **`Bot_Rekap_Validasi_Tiang_Harian.gs`** dan **`Bot_Rekap_Cat_Tiang.gs`**, akses tautan berikut melalui browser:
     `https://api.telegram.org/bot<TOKEN_BOT_ANDA>/setWebhook?url=<WEBAPP_URL_ANDA>`
5. Khusus **`Bot_Rekap_Validasi_Tiang_Harian.gs`**, jalankan fungsi **`pasangJadwalOtomatis()`** satu kali di editor Apps Script untuk mengaktifkan rekap otomatis pukul 12:00 dan 15:00 WIB.

---

## Panduan Operasional Perintah Bot

### Bot Rekap Validasi Tiang Harian
- Mengirimkan laporan berformat kode tiang resmi di grup (misal `PWK-FFK-012`) akan otomatis terekam.
- `/rekap` : Memicu pengiriman laporan rekapitulasi validasi tiang harian secara manual ke grup.

### Bot Rekap Order Teknisi as Sales
- `/start`, `/help`, `/panduan` : Menampilkan cara penulisan format order `SC` dan `WO` serta status akun pengirim.
- `/profil`, `/cek` : Menampilkan NIK, Nama, Stream, Username Digipos, dan Username Telegram pengirim.
- `/regist NIK / NAMA / DIGIPOS` : Mendaftarkan profil teknisi baru.
- `/ubah nama <nilai>`, `/ubah digipos <nilai>`, `/ubah tele <@username>` : Memperbarui sebagian atribut profil teknisi.

### Bot Evidensi Pengecatan Tiang AI Vision
- `/start`, `/help` : Menampilkan panduan format caption dan pengiriman foto.
- `/status` : Memeriksa jumlah foto yang sedang tertampung pada folder staging serta tiang aktif saat ini.
- `/batal`, `/reset` : Menghapus antrean foto staging dan menghentikan sesi tiang aktif.
- Kirim 1 hingga beberapa foto disertai caption metadata (berisi `Sektor`, `Datek/ODP`, `Tiket`, dan `Validasi Tiang`) dalam satu pengiriman atau secara bertahap.

---

## Dokumentasi Lengkap

Panduan langkah demi langkah secara mendetail mulai dari pembuatan Spreadsheet, penggunaan `@BotFather`, konfigurasi Google Apps Script, deployment, hingga penanganan kendala tersedia pada dokumen **Buku Panduan Operasional Bot Telegram Pelaporan Lapangan** yang menyertai laporan proyek akhir P3Kh.

## Penulis

**M Rislan Tristansyah**
Program Studi Teknik Telekomunikasi, Universitas Pendidikan Indonesia
Pelaksana Program P3Kh PT Telkom Indonesia (Datel Purwakarta dan Telkom Akses STO Purwakarta)
