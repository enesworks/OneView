# OneView — Mimari

Bu belge, OneView motorunun katmanlarını, veri akışını ve tasarım kararlarını açıklar.

---

## 1. Genel Akış

```
   buildScanQueue()          scanPort() / rtspAlive / quickRtsp
        │                            │
        ▼                            ▼
 ┌──────────────┐   IP          ┌──────────────┐  hit   ┌──────────────┐
 │  TARGETS     │──────────────▶│  RECON       │───────▶│  AUTH        │
 │  RIPE TR     │               │  TCP + fingerprint    │  RTSP/HTTP   │
 │  cursor      │               └──────────────┘        └──────┬───────┘
 └──────────────┘                                              │ cred
                                                               ▼
 ┌──────────────┐  url          ┌──────────────┐  device ┌──────────────┐
 │  REGISTRY    │◀──────────────│  STREAM      │◀────────│  PIPELINE    │
 │  (LIVE only) │               │  HLS + verify│         │  orkestra    │
 └──────────────┘               └──────────────┘         └──────────────┘
        │                                                       │
        ▼                                                       ▼
   Renderer (harita)                                    STORE (db)
```

Her döngü şu sırayı izler:

1. **Hedef üretimi** — `ScanQueue` ülke prefix'lerinden sıradaki IP bloğunu verir.
2. **Port taraması** — RTSP (`554/8554/10554/1554`), Web (`80/8080`), proprietary (`37777/8000`).
3. **Doğrulama** — `rtspAlive` (RTSP konuşuyor mu?), `verifyStream` (≥3 kare).
4. **Kimlik doğrulama** — kimlik havuzu + hız sınırı + kilit koruması.
5. **Kayıt** — yalnızca `LIVE` cihazlar **registry**'ye; çalışan cred'i olanlar **store**'a.
6. **İmleç** — kuyruk sonuna gelince **başa sarar**, IP'ler tekrar taranır.

---

## 2. Katmanlar

### 2.1 Kaynak (Discovery)

| Modül | Not |
|---|---|
| `targets.ts` | `country-resource-list(TR)` çeker, **büyük prefix'ler önce** (ISP/residential yoğun). `ScanQueue` CIDR'ları tembel genişletir; kalıcı `(rangeIdx, cursor)` ile ilerler; `reset()` ile başa sarar. |
| `recon.ts` | `activeScan` (çok-hedefli TCP), `grabBanner`, `fingerprint`, `confirmVendor` (`/ISAPI/…`, `/cgi-bin/magicbox.cgi`, `/axis-cgi/…`). |
| `massscan.ts` | Yüksek eşzamanlı `scanPort`, `rtspAlive`, `rtspBanner`/`rtspVendor`, `quickRtsp`, kimlik havuzu (`MASS_CREDS`), hız sınırı, kilit koruması. |
| `proprietary.ts` | Dahua `37777` (RPC2 `global.login`), Hikvision `8000` (NetSDK). |

### 2.2 Sızma (Intrusion)

| Modül | Not |
|---|---|
| `intrusion.ts` | Auth akışları, RTSP/MJPEG path brute, yerel keşif: `sadpDiscover` (Hikvision), `dahuaDiscover`, `ssdpDiscover`. |
| `exploits.ts` | `CVE-2017-7921`, `CVE-2021-36260` (Hikvision), `CVE-2021-33044` (Dahua), DVR traversal. |
| `vendor-auth.ts` | `hikvisionAuth` (ISAPI Digest/Basic), `dahuaLogin` (RPC2 + CGI), kanal sayımı. |
| `credentials.ts` / `auth.ts` | Vendor bazlı kimlik havuzu; `basicAuth`, `digestAuth`, `wsSecurity`. |

### 2.3 Akış (Streaming)

| Modül | Not |
|---|---|
| `stream.ts` | RTSP → HLS dönüşümü (`ffmpeg`), yerel HTTP proxy, `refCount` oturum paylaşımı, watchdog (çöken süreç yeniden başlatılır), `probeRtsp`. |
| `channels.ts` | NVR kanal yollarını üretir (Hikvision `/Streaming/Channels/{ch}0{sub}`). |
| `liveness.ts` | Kayıtlı yayınların periyodik canlılık denetimi. |

### 2.4 Veri (Data)

| Modül | Not |
|---|---|
| `db.ts` | `CameraStore` — SQLite (`node:sqlite`) ya da JSON fallback; tablolar: `devices`, `creds`, `tasks`, `access_log`, `meta`. |
| `registry.ts` | `CameraRegistry` — `cameras.json`; haritada gösterilen küme. |
| `geoip.ts` / `geocode.ts` | Çok sağlayıcılı konumlandırma; **TR dışı adresler konumlandırılmaz**. |

### 2.5 Bulut & Orkestra

| Modül | Not |
|---|---|
| `cloud.ts` | Ezviz (`featureCode` + MD5 parola) ve Tuya (HMAC-SHA256) cihaz listeleri. |
| `pipeline.ts` | `runMassScan`, `runExploitPass`, `runHealthCheck`, `runThumbnails`, `runCloudScan`, `runCleanup`. |
| `scheduler.ts` | Tek `setTimeout` döngüsü + görev kaydı; çakışan görevler sırayla koşar. |

---

## 3. Tasarım Kararları

**Ülke sınırı.** Tarama yalnızca RIPE TR kayıtlarıyla sınırlıdır. ASN bazlı genişletme
kaldırılmıştır; zira Türk ASN'lerin yurt dışı ilanları yabancı adresleri kuyruğa sokuyordu.

**“Sahte LIVE” engeli.** Bir cihaz yalnızca `LIVE` sayılır; bunun için `ffmpeg` ile
**en az 3 kare** alınması gerekir. Tek kare/statik yanıtlar `ACCESSIBLE` kalır.

**Kimlik doğrulama.** `OPTIONS` birçok cihazda kimliksiz `200` döndüğü için tek başına
güvenilir değildir; doğrulama `DESCRIBE` üzerinden yapılır.

**Kilit koruması.** Kimlik denemeleri global token-bucket (~80/sn) ile sınırlanır;
cihaz başına üst sınır uygulanır ve **ardışık yanıtsızlık** hâlinde cihaz bırakılır.

**Eşzamanlılık tavanı.** Çok yüksek eşzamanlılık (≥3000 socket) bazı ortamlarda
bağlantıları düşürür; tarama **1500** eşzamanlılıkla güvenilir çalışır.

**Kalıcılık.** Yalnızca çalışan kameralar kalıcıdır. Doğrulanamayan adresler
kaydedilmez ve sonraki döngüde tekrar denenir; imleç kuyruk sonunda başa sarar.

---

## 4. IPC Yüzeyi (özet)

| Kanal | İş |
|---|---|
| `registry:list` / `registry:stats` | Yayın listesi / istatistik |
| `store:stats` / `store:scan` | Cihaz istatistikleri / tarama sayaçları |
| `store:thumbnails` | Snapshot listesi |
| `stream:acquire` / `stream:release` / `stream:touch` | HLS oturum yönetimi |
| `liveness:check` | Elle canlılık denetimi |
