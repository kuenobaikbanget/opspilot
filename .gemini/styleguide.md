# Panduan Review Kode — OpsPilot (Gemini Code Assist)

Dokumen ini menjadi acuan wajib bagi Gemini Code Assist saat meninjau Pull Request pada repositori `opspilot`.

## 1. Bahasa Wajib

- **Seluruh** ringkasan PR (*PR summary*), komentar review inline, dan saran perbaikan **WAJIB ditulis dalam Bahasa Indonesia** yang jelas, ringkas, langsung ke inti masalah, dan sopan.
- Istilah teknis, nama simbol, path file, tipe data, perintah CLI, dan potongan kode tetap dipertahankan dalam nama aslinya (misalnya `Bun.serve`, `Bun.SQL`, `SKIP LOCKED`, `Origin`, `WebSocket`, `exec.CommandContext`, `Next.js App Router`).

## 2. Label Keparahan Wajib

Awali **setiap** komentar review inline dengan salah satu label berikut agar tim mudah memprioritaskan perbaikan:

- `[KRITIS]` — Kerentanan keamanan, kebocoran kredensial/secret, eksekusi shell/URL sembarangan, SSRF, bypass otentikasi/otorisasi, kerusakan data, atau pelanggaran batasan arsitektur inti.
- `[TINGGI]` — Bug logika nyata, *race condition*, *goroutine/memory leak*, *error handling* yang hilang atau ditelan diam-diam, kegagalan validasi input di *trust boundary*, atau ketidaksinkronan kontrak protokol.
- `[SEDANG]` — *Edge case* yang terlewat, potensi degradasi performa (N+1 query, polling/re-render berlebih, alokasi besar), inkonsistensi tipe data (`any`, tipe kontrak tidak selaras), atau kurangnya *test* positif/negatif.
- `[RENDAH]` — Perbaikan kejelasan logika lokal, penanganan kasus batas minor, atau saran penyederhanaan kode yang berdampak nyata pada pemeliharaan.

## 3. Standar Review Ketat (Mulai dari `LOW` / `[RENDAH]`)

Lakukan tinjauan ketat dari tingkat keparahan `LOW` ke atas dengan memeriksa seluruh aspek berikut:

1. **Bug Logika & Edge Cases:** kondisi batas (`null`, `undefined`, string kosong, angka negatif/NaN, array kosong), *off-by-one*, *timeout*, *idempotency*, transisi status insiden/pekerjaan yang tidak valid, serta urutan pesan yang datang terlambat (*stale/out-of-order*).
2. **Concurrency & Race Conditions:** mutasi *in-memory map* atau status koneksi bersama di Hub tanpa sinkronisasi, konflik antrean `SKIP LOCKED` di Worker, pesan dari sesi WebSocket agen yang sudah *superseded*, serta *goroutine leak*, channel tidak ditutup, atau `context.Context` yang tidak dibatalkan di Go agent.
3. **Error Handling:** larang `catch` kosong atau pengabaian error (`_ = ...`) yang menyembunyikan kegagalan; pastikan kondisi error/timeout/izin ditolak tidak dipetakan menjadi status normal (misalnya kegagalan `systemctl` tidak boleh dianggap sebagai unit `stopped`); dan pastikan pesan error ke klien/log/DB tidak membocorkan rahasia atau *stack trace* sensitif.
4. **Keamanan:**
   - **Otentikasi & Otorisasi:** sesi cookie admin (`HttpOnly`, `SameSite=Strict`), pemeriksaan header `Origin` pada mutasi (`POST`/`PATCH`/`DELETE`), serta penjagaan ketat agar `DISABLE_AUTH=true` tidak pernah aktif saat `NODE_ENV=production`.
   - **SQL & Injection:** seluruh query `Bun.SQL` wajib berparameter; cegah string interpolation SQL, XSS, dan *command/argument injection*.
   - **SSRF & Egress:** validasi skema HTTPS, port, DNS pinning, pemblokiran IP privat/loopback/link-local/metadata, penolakan redirect/proxy tidak sah pada koneksi ke penyedia LLM maupun *endpoint probe*.
   - **Secret Exposure:** pastikan API key BYOK, `AI_PROVIDER_ENCRYPTION_KEY`, `SESSION_SECRET`, `DATABASE_URL`, token enrollment sekali pakai, dan `agent_secret` tidak pernah bocor ke Next.js Client Components, URL/query string, `localStorage`, log, atau *fixture* yang tidak semestinya.
5. **Performa:** deteksi query N+1 ke PostgreSQL, query/tabel tanpa batas (`LIMIT`) atau strategi retensi, pembacaan file/stdout tanpa batas ukuran di Go agent, serta polling/re-render React yang tidak perlu atau *listener/timer* tanpa *cleanup*.
6. **Konsistensi Tipe Data:** proyek memakai TypeScript `strict: true`; hindari penambahan `any` baru, type assertion tidak aman (`as`), atau duplikasi tipe yang seharusnya berada di `packages/contracts`.
7. **Kecukupan Test:** setiap tool diagnostik baru, jalur otentikasi/otorisasi, validasi keamanan, skrip instalasi, atau perubahan protokol wajib disertai **test positif dan test negatif** (`bun test` / `go test`).

## 4. Aturan Khusus Arsitektur & Tech Stack `opspilot`

Sesuaikan seluruh penilaian dengan arsitektur nyata `opspilot` (Bun workspaces monorepo + Go agent + PostgreSQL):

- **Larangan Mutlak Remote Shell & Arbitrary Fetch:** Jangan pernah mengizinkan tool diagnostik shell generik (`sh -c`, `bash -c`, `eval`) atau pengambilan URL bebas oleh agen/AI. Semua aksi diagnostik harus terenumerasi eksplisit, bersifat *read-only*, divalidasi ulang secara lokal di `agent/`, dibatasi *timeout* dan ukuran output, serta diaudit.
- **Batas Modul (`docs/ARCHITECTURE.md`):**
  - `apps/web` (Next.js 16 App Router + React 19): hanya berinteraksi lewat `/api/*` rewrite ke Hub. Tidak boleh mengakses PostgreSQL, master encryption key, atau API LLM secara langsung. Rute terproteksi di `apps/web/app/(workspace)` wajib menghormati gerbang sesi `/api/auth/me` (status `503`/jaringan gagal tidak boleh dianggap terautentikasi; `401` harus membersihkan state sensitif). Rute publik `/design-system` hanya boleh memakai data sintetis lokal tanpa request `/api`.
  - `apps/hub` (`Bun.serve` HTTP/WSS + `Bun.SQL`): menangani auth, validasi payload masuk, manajemen sesi agen, dan mutasi state; tidak memanggil API LLM secara langsung.
  - `apps/worker`: mengklaim pekerjaan lewat `SKIP LOCKED` di PostgreSQL dan memanggil adapter di `packages/ai`; tidak boleh mengakses sesi WebSocket agen secara langsung.
  - `packages/contracts`: sumber kebenaran tipe wire dan validator bersama; cegah *circular dependency*. Perubahan protokol agen wajib menyelaraskan `packages/contracts`, `agent/`, `docs/API.md`, dan test interoperabilitas.
  - `packages/ai`: menangani adapter OpenAI/Anthropic/Gemini, enkripsi kredensial `AES-256-GCM`, redaksi, dan validasi skema/sitasi `evidence.id`; tidak boleh mengimpor internal HTTP server.
- **Pembedaan Bukti vs Hipotesis AI:** Jaga pembedaan tegas antara sinyal terukur (telemetri/hash/status unit), hipotesis AI (harus mengutip `evidence.id` yang valid dari server dan jujur melaporkan bukti yang kurang), dan resolusi terkonfirmasi manusia.
- **Go Agent (`agent/`, Go 1.23 + `gorilla/websocket`):**
  - Pastikan pemanggilan perintah sistem menggunakan `exec.CommandContext` dengan path/argumen tetap (tanpa shell), `--` pemisah opsi bila menerima nama unit/argumen, batas baca pipe/stdout, dan pembersihan proses anak saat timeout.
  - Pastikan izin file sensitif seperti `identity.json` disimpan dengan mode `0600` dalam direktori `0700`, dan koneksi WebSocket menangani *concurrent write*, *deadline*, serta *graceful shutdown*.
- **Skema PostgreSQL (`infra/db/*.sql`) & Skrip (`infra/install/*.sh`, `tools/*.ts`):**
  - Periksa keamanan skrip bash (penanganan `curl`, verifikasi checksum `SHA-256`, `trap` pembersihan file temporer, validasi argumen, pencegahan kebocoran token di proses/file unit) serta penjagaan mode dev (`NODE_ENV !== "production"` dan *loopback check* pada alat mock/seed).
- **Dokumentasi Keamanan & API:** Jika PR mengubah alur auth, penanganan log, prompt LLM, diagnostik, eksposur jaringan, atau retensi data, ingatkan bila dokumentasi terkait (`docs/SECURITY.md`, `docs/API.md`) belum diperbarui.

## 5. Fokus pada Hal Bermakna (Hindari Nitpicking Format)

- **Jangan** memberi komentar tentang gaya penulisan atau formatting semata (spasi, indentasi, trailing comma, tanda kutip, pengurutan import, atau konvensi yang menjadi ranah `gofmt`/editor), kecuali jika menyebabkan kesalahan sintaks, pelanggaran akhir baris LF (`.gitattributes`), atau bug nyata.
- Fokuskan setiap komentar pada kebenaran logika, keamanan, konkurensi, kontrak tipe/protokol, reliabilitas, performa, dan kualitas pengujian.
