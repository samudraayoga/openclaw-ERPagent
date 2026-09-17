# RAIN OpenClaw — Instalasi VPS

Folder ini berisi setup OpenClaw untuk RAIN yang terhubung ke endpoint personal RAHO ERP. Setup bersifat read-only dan menyediakan enam tool:

1. `get_my_identity`
2. `get_my_daily_performance`
3. `get_my_performance`
4. `compare_my_performance`
5. `get_my_tasks`
6. `get_my_overdue_tasks`

Tidak ada token, cookie, atau credential OpenClaw di repository. Semua secret dikonfigurasi langsung pada VPS.

## Topologi yang didukung saat ini

Implementasi session bridge di `apps/api/src/modules/ai/ai.routes.ts` hanya menerima `X-RAIN-Session-Key` dari koneksi loopback. Karena itu, konfigurasi yang langsung didukung adalah:

```text
Browser -> RAHO Web/API -> OpenClaw Gateway -> RAIN plugin -> RAHO API
                         satu VPS dan satu network namespace
```

OpenClaw gateway dan RAHO API harus berjalan pada host/network namespace yang sama, menggunakan `127.0.0.1`. Jangan mengekspos port OpenClaw `18789` ke internet.

Jika RAHO API berjalan di container terpisah, request dari OpenClaw tidak akan terlihat sebagai loopback. Jangan mengatasi ini dengan mempercayai seluruh subnet Docker. Implementasikan autentikasi antarlayanan bertanda tangan atau mTLS terlebih dahulu.

## Prasyarat

- Repository RAHO_APPS sudah di-clone di VPS.
- RAHO API dapat berjalan pada VPS.
- Node.js dan OpenClaw terpasang. Versi yang diuji: Node.js `26.7.0`, OpenClaw `2026.6.11`.
- Model provider OpenClaw sudah dikonfigurasi dan agent utama dapat menjawab.
- Jalankan semua perintah OpenClaw sebagai user OS yang sama dengan service OpenClaw. Jangan menjalankan installer sebagai root jika gateway berjalan sebagai user aplikasi.

## 1. Siapkan OpenClaw

```bash
openclaw onboard
openclaw models status
openclaw gateway install
openclaw gateway status
```

Pastikan gateway bind ke loopback dan memiliki token autentikasi.

## 2. Preview perubahan

Dari root repository:

```bash
node integrations/openclaw/install-rain.mjs \
  --erp-url http://127.0.0.1:4000 \
  --dry-run
```

Preview tidak menulis konfigurasi.

## 3. Install RAIN

```bash
node integrations/openclaw/install-rain.mjs \
  --erp-url http://127.0.0.1:4000 \
  --timeout-ms 8000 \
  --restart
```

Installer bersifat idempotent dan melakukan hal berikut:

- membuat agent `rain` jika belum ada;
- mendaftarkan plugin dari path repository saat ini;
- menunjuk workspace RAIN ke path repository saat ini;
- membatasi agent ke enam tool read-only;
- mematikan skills dan heartbeat;
- mengaktifkan endpoint `/v1/chat/completions` pada gateway;
- membuat backup `openclaw.json`;
- memvalidasi konfigurasi;
- menjalankan test adapter;
- me-restart gateway hanya jika `--restart` diberikan.

Repository harus tetap berada pada path yang sama selama plugin aktif. Jika repository dipindahkan, jalankan installer lagi dari lokasi baru.

## 4. Konfigurasi RAHO API

Tambahkan ke `apps/api/.env` pada VPS:

```dotenv
OPENCLAW_GATEWAY_URL=http://127.0.0.1:18789
OPENCLAW_GATEWAY_TOKEN=isi-token-gateway-openclaw
OPENCLAW_AGENT_ID=rain
OPENCLAW_REQUEST_TIMEOUT_MS=120000
```

`OPENCLAW_GATEWAY_TOKEN` adalah secret. Jangan commit `.env`, jangan masukkan token ke prompt, dan jangan menaruhnya di workspace RAIN.

Pada production, API tidak akan membaca token langsung dari `~/.openclaw/openclaw.json`; environment variable tersebut wajib diisi.

## 5. Verifikasi

```bash
node integrations/openclaw/verify-rain.mjs
```

Verifier memeriksa konfigurasi agent/plugin, enam tool, endpoint chat completion, test adapter, dan status gateway. Pemeriksaan hanya konfigurasi dapat dijalankan dengan:

```bash
node integrations/openclaw/verify-rain.mjs --config-only
```

Kemudian restart RAHO API dan lakukan smoke test dari UI RAIN menggunakan dua akun ERP berbeda. Pastikan masing-masing hanya menerima datanya sendiri.

## 6. Firewall dan reverse proxy

- Ekspos hanya port web/API yang memang dibutuhkan publik.
- Pertahankan OpenClaw gateway pada `127.0.0.1:18789`.
- Jangan proxy endpoint OpenClaw langsung melalui Nginx/Cloudflare.
- Gunakan TLS pada endpoint ERP publik.
- Simpan `.openclaw` dengan permission user service yang ketat.

## Update

```bash
git pull --ff-only
node integrations/openclaw/install-rain.mjs \
  --erp-url http://127.0.0.1:4000 \
  --timeout-ms 8000 \
  --restart
node integrations/openclaw/verify-rain.mjs
```

Installer membuat backup config setiap kali dijalankan. Jangan menghapus backup terakhir sebelum smoke test selesai.

## Rollback

1. Pulihkan file backup `openclaw.json.backup-rain-*` yang disebut installer.
2. Jalankan `openclaw config validate`.
3. Jalankan `openclaw gateway restart --safe`.
4. Jika RAIN harus dinonaktifkan segera, nonaktifkan route/UI RAIN di ERP atau set `plugins.entries.raho-ai.enabled=false`, lalu restart gateway.

## Batas V1

- Read-only.
- Hanya data personal user ERP yang terikat ke conversation session.
- Session binding saat ini tersimpan di memory proses API selama lima menit. Restart API menghapus binding aktif; request berikutnya akan membuat binding baru.
- Tidak ada fallback ke data demo ketika ERP gagal.
- Tidak ada dukungan deployment API dan OpenClaw pada network namespace berbeda tanpa perubahan autentikasi internal.
