<div align="center">

# OneView

**Türkiye Kamera Ağı — Keşif & İzleme Konsolu**

`Electron` · `React` · `TypeScript` · `Vite` · `MapLibre` · `hls.js`

</div>

---

## Genel Bakış

**OneView**, Türkiye IP uzayındaki açık görüntü kaynaklarını (IP kamera, DVR, NVR) keşfeden, kimlik doğrulamasını yapan, coğrafi olarak konumlandıran ve harita üzerinde canlı izleten bir masaüstü konsoludur.

Tek bir motor çalıştırır: **RIPE tabanlı ülke taraması → servis parmak izi → kimlik doğrulama → exploit zinciri → canlı akış**. Tüm süreç otomatiktir; operatör yalnızca izler.

> Kapsam bilinçli olarak **Türkiye** ile sınırlıdır. Tarama kuyruğu yalnızca RIPE `country-resource-list(TR)` kayıtlarından üretilir; bu listenin dışındaki adresler taranmaz.

---

## Özellikler

### 🔎 Keşif (Discovery)
- **RIPE tabanlı, ülke-kapsamlı kuyruk** — TR IPv4 uzayı, kalıcı imleç (cursor) ile kesintisiz tarama.
- **Çok portlu RTSP taraması** — `554`, `8554`, `10554`, `1554`.
- **HTTP/Web arayüz taraması** — `80`, `8080`, `81`, `8081`.
- **Proprietary portlar** — `37777` (Dahua), `8000` (Hikvision SDK).
- **Banner parmak izi** — `Server` başlığı, `WWW-Authenticate` realm, sayfa başlığı.
- **RTSP banner parmak izi** — `Server` + `realm` ile üretici tespiti (Dahua, Hikvision, Axis, Amcrest, Foscam, Reolink, Vivotek, Uniview …).
- **InternetDB (anahtarsız)** — bulunan IP'nin tüm açık portlarını ücretsiz sorgular; kaçırılan kamera portlarını yakalar.
- **ONVIF** — WS-Discovery + `GetProfiles` / `GetStreamUri` (WS-Security UsernameToken Digest); üreticiden bağımsız doğrudan RTSP adresi.

### 🔐 Kimlik Doğrulama (Auth)
- **RTSP** — `OPTIONS` + `DESCRIBE` tabanlı gerçek doğrulama; Basic ve Digest şemaları.
- **500+ kimlik havuzu** — yaygın/var olan cihaz şifreleri, olasılık sırasına göre.
- **Hız sınırı (token-bucket)** — toplam ~80 deneme/sn; cihazları kilitlemez.
- **Kilit koruması** — cihaz başına üst sınır + ardışık yanıtsızlıkta geri çekilme.
- **HTTP vendor auth** — Hikvision `ISAPI` (Digest/Basic), Dahua `RPC2_Login` + `magicBox`.

### 💥 Exploit Zinciri
- `CVE-2017-7921` — Hikvision kimlik atlama.
- `CVE-2021-36260` — Hikvision komut enjeksiyonu.
- `CVE-2021-33044` — Dahua kimlik atlama.
- DVR path-traversal ve Dahua `magicBox` yardımcı yolları.

### 📺 Akış (Streaming)
- **HLS proxy** — `ffmpeg` ile RTSP → HLS dönüşümü, yerel proxy sunucusu.
- **Oturum paylaşımı** (`refCount`) — aynı kamera için tek RTSP bağlantısı.
- **Watchdog** — çöken transcode süreçlerini yeniden başlatır.
- **verifyStream** — yayını gerçekten doğrular (≥3 kare), “sahte LIVE” üretmez.

### ☁️ Cloud & Yerel
- **Ezviz cloud** — `featureCode` tabanlı oturum açma, cihaz listesi, RTSP adresi.
- **Tuya IoT** — HMAC-SHA256 imzalı token, cihaz listesi.
- **Yerel ağ** — ARP, SSDP, SADP (`Hikvision`), Dahua discovery.

### 🗺️ Arayüz
- **MapLibre GL** karanlık harita + kümeleme.
- **Liste + detay paneli** (il/ilçe, koordinat, protokol, kaynak).
- **Canlı önizleme** (`hls.js`) + tam ekran katman.
- **HUD** — toplam / aktif / çevrimdışı / taranan IP / açık RTSP sayaçları.

---

## Mimari

```
┌─────────────────────────────────────────────────────────────────────┐
│                        OneView (Electron)                            │
│                                                                     │
│  ┌─────────────────────────── MAIN ──────────────────────────────┐  │
│  │  index.ts        Uygulama girişi · IPC köprüsü · pencere      │  │
│  │  scheduler.ts    Görev kaydı · tek setTimeout döngüsü         │  │
│  │  pipeline.ts     Motor orkestrasyonu · tarama · sağlık        │  │
│  ├───────────────────────────────────────────────────────────────┤  │
│  │  KAYNAK          recon · targets · massscan · proprietary     │  │
│  │  SIZMA           intrusion · exploits · vendor-auth ·          │  │
│  │                  credentials · auth                            │  │
│  │  AKIŞ            stream · channels · liveness · webcams       │  │
│  │  VERİ            db · registry · fstore · geoip · geocode     │  │
│  │  BULUT           cloud · shodan · sources · public-scrapers   │  │
│  │  YEREL           discovery · netscan · validate               │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                              │ IPC                                  │
│  ┌──────────────────────── RENDERER ─────────────────────────────┐  │
│  │  App.tsx   Sidebar · CameraListPanel · Map · DetailPanel       │  │
│  │  components/  TopBar · HudBar · LivePreview · StreamOverlay    │  │
│  │  hooks/  useStream   map/  cluster · darkStyle                 │  │
│  └───────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

### Modül Sorumlulukları

| Katman | Modül | Sorumluluk |
|---|---|---|
| **Kaynak** | `targets.ts` | RIPE TR IPv4 kuyruğu, kalıcı imleç, CIDR aritmetiği |
| | `recon.ts` | TCP tarama, banner toplama, vendor doğrulama |
| | `massscan.ts` | Yüksek eşzamanlı port tarama, RTSP auth, kimlik havuzu, hız sınırı |
| | `proprietary.ts` | Dahua `37777` · Hikvision `8000` özel protokoller |
| | `onvif.ts` | WS-Discovery · `GetProfiles` · `GetStreamUri` (WS-Security Digest) |
| | `internetdb.ts` | Ücretsiz (anahtarsız) per-IP port/zafiyet zenginleştirme |
| **Sızma** | `intrusion.ts` | Parser/auth akışları, yerel keşif (SADP/SSDP), path brute |
| | `exploits.ts` | CVE zincirleri, DVR traversal, `magicBox` |
| | `vendor-auth.ts` | Hikvision ISAPI · Dahua RPC2 |
| | `credentials.ts` / `auth.ts` | Kimlik havuzu · Basic/Digest/WS-Security |
| **Akış** | `stream.ts` | HLS motoru, oturum paylaşımı, watchdog, yerel proxy |
| | `channels.ts` | NVR kanal keşfi |
| **Veri** | `db.ts` | SQLite/JSON cihaz deposu, meta, erişim logu |
| | `registry.ts` | Yayın kaydı (haritada gösterilen küme) |
| | `geoip.ts` / `geocode.ts` | Çok-sağlayıcılı konumlandırma |
| **Bulut** | `cloud.ts` | Ezviz · Tuya cihaz listesi + akış adresi |
| **Orkestra** | `pipeline.ts` | Tarama → sızma → doğrulama → kayıt |
| | `scheduler.ts` | Görev takvimi |

Detaylı tasarım için: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)

---

## Teknoloji Yığını

| Alan | Teknoloji |
|---|---|
| Çalışma ortamı | Electron 32 |
| Arayüz | React 18 · TypeScript 5 · Tailwind CSS 3 |
| Derleme | Vite 5 · `vite-plugin-electron` |
| Harita | MapLibre GL 4 |
| Video | hls.js |
| Medya işleme | ffmpeg (HLS / transcode) |
| Paketleme | electron-builder (Windows `portable`) |

---

## Başlarken

### Gereksinimler
- Node.js 20+
- `ffmpeg` (PATH'te olmalı) — canlı akış ve doğrulama için

### Kurulum

```bash
git clone https://github.com/enesworks/OneView.git
cd OneView
npm install
```

### Geliştirme

```bash
npm run dev          # Vite + Electron (HMR)
```

### Üretim / Paketleme

```bash
npm run build        # tsc + vite build
npm run package      # + electron-builder → release/OneView.exe
```

---

## Yapılandırma

`config.json` (`%APPDATA%/OneView/`) — tümü **opsiyonel**; yalnızca kullanılan anahtarlar gerekir.

| Anahtar | Açıklama |
|---|---|
| `shodanKey` | Shodan API anahtarı (geniş kaynak taraması) |
| `censysToken` | Censys token |
| `ezvizAccount` / `ezvizPassword` | Ezviz cloud hesabı |
| `ezvizCreds` | `["eposta:sifre", ...]` cloud kimlik listesi |
| `ezvizCredsFile` | Satır satır `eposta:sifre` içeren dosya |
| `tuyaClientId` / `tuyaClientSecret` | Tuya IoT geliştirici anahtarları |

Ortam değişkenleri de desteklenir (`ONEVIEW_*`).

---

## Veri Modeli

| Depo | Dosya | İçerik |
|---|---|---|
| **Registry** | `cameras.json` | Haritada gösterilen yayın kümesi (yalnızca doğrulanmış kameralar) |
| **Store** | `oneview-v2.json` | Cihaz kayıtları, meta (imleç/sayaç), erişim logu |

### Cihaz Durumları

| Durum | Anlamı |
|---|---|
| `LIVE` | Yayın doğrulandı — **≥3 kare** alındı |
| `ACCESSIBLE` | Kimlik doğrulandı, akış doğrulanamadı |
| `DISCOVERED` | Servis yanıt verdi, kimlik bulunamadı |
| `INACCESSIBLE` · `OFFLINE` · `DEAD` | Erişilemez · çevrimdışı |

> Registry’ye **yalnızca `LIVE`** cihazlar girer; bulunamayan/doğrulanamayan adresler
> kaydedilmez ve bir sonraki döngüde **tekrar taranır**.

---

## Zamanlanmış Görevler

| Görev | Aralık | İş |
|---|---|---|
| `mass-scan` | 15 sn | Ülke-kapsamlı tarama döngüsü |
| `health-check` | 30 sn | Kayıtlı yayınların canlılık denetimi |
| `exploit-pass` | 5 dk | CVE zinciri + vendor auth |
| `thumbnail-gen` | 5 dk | Snapshot üretimi |
| `cloud-scan` | 20 dk | Ezviz / Tuya cihaz listesi |
| `public-scrape` | 6 sa | Açık kaynak kazıma |
| `cleanup` | 1 sa | Çalışmayan/eskimiş kayıt temizliği |

---

## Yasal Uyarı

OneView yalnızca **yetkili güvenlik araştırması**, **varlık envanteri** ve
**eğitim** amacıyla geliştirilmiştir. Kullanıcı; taradığı sistemlere erişim
yetkisinin bulunduğunu ve yürürlükteki mevzuatı (KVKK, TCK 243–245 vb.) ihlal
etmediğini garanti etmekle yükümlüdür. **Yetkisiz erişim suç teşkil eder.**

---

## Lisans

[MIT](LICENSE)

