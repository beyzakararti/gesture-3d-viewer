# Gesture 3D Viewer

Gesture 3D Viewer, webcam görüntüsüne yerel 3B modeller ve sunum görselleri yerleştiren,
bunları el hareketleriyle kontrol etmeyi amaçlayan deneysel bir masaüstü uygulamasıdır.
Proje [beyzakararti](https://github.com/beyzakararti) byeza <3 tarafından geliştirilmektedir.

Electron ve Three.js arayüzü, Python tarafındaki MediaPipe Holistic takibiyle yalnızca
`localhost` üzerinden haberleşir. Kamera kareleri ve yüklenen modeller uzak servislere gönderilmez.

!!! Daha tam bitmedi ama şimdilik işlevini yerine getiriyor, üzerine çalışılıp en optimum hale getirilecektir !!!

## Ne için kullanılabilir?

- GLB, STL ve OBJ mekanik parçalarını kamera görüntüsü üzerinde incelemek
- Teknik eğitimlerde modelleri hareketlerle döndürmek, taşımak ve yakınlaştırmak
- Modeli sunum konumunda kilitleyip parçalarını elle işaret etmek
- Makale sayfalarını veya şemaları iki omuz yanına sabitlemek
- Ders, bilim iletişimi, video içeriği ve çevrim içi toplantılar hazırlamak
- Uygulama penceresini anlatım sesiyle WebM video olarak kaydetmek
- Jest tabanlı insan–bilgisayar etkileşimi deneyleri geliştirmek

Bu sürüm bir prototiptir; tıbbi, endüstriyel veya güvenlik-kritik ölçüm aracı değildir.
Standart tek kameralı mesafe ve derinlik hesapları yaklaşıktır.

## Özellikler

- Yerel `.glb`, `.stl` ve tek dosyalı `.obj` yükleme
- Fareyle orbit, pan ve zoom; tel kafes ve otomatik dönüş
- GLB içindeki ilk animasyonu oynatma/duraklatma
- Pinch ile modelin üzerinden tutup sürükleme
- Açık avuçla döndürme ve iki elle zoom
- Spock/Vulcan hareketiyle sunum kilidi
- Yüz, el, pose ve kişi segmentasyonu
- Yaklaşık kamera mesafesi ve kişi/model örtüşmesi
- Dudak hareketinden görsel üfleme etkisi
- Omuzlara PNG, JPG veya WebP sunum görseli yerleştirme
- Mikrofonlu veya sessiz uygulama videosu kaydı
- Daraltılabilir kontrol paneli

## Kullanım

1. Backend ve frontend'i aşağıdaki iki ayrı terminalde başlatın.
2. `Kameraya izin ver ve başlat` düğmesine basıp Windows kamera iznini verin.
3. `Kişi algılandı`, yaklaşık mesafe ve `Maske hazır` bilgisini kontrol edin.
4. `3B model yükle` ile desteklenen yerel bir model seçin ve `El kontrolü`nü açın.
5. Modelin üzerinde başparmak–işaret pinch hareketini kısa süre tutup sürükleyin.
6. Spock/Vulcan hareketini ilerleme tamamlanana kadar tutarak modeli sabitleyin. Yeniden
   tetiklemek için önce elinizi kısa süre indirin.
7. Video için mikrofon tercihini belirleyip `Kaydı başlat` düğmesine basın. Video, işletim
   sisteminin Videolar klasöründeki `Gesture 3D Viewer` dizinine yazılır.

STL yalnızca yüzey geometrisi taşır; renk, malzeme, montaj ağacı ve animasyon içermez.
OBJ için harici `.mtl` ve dokular henüz yüklenmez. STEP, IGES ve native CAD formatları
henüz desteklenmez.

## Gereksinimler

- Windows 10/11
- Node.js 20 veya üzeri
- Python 3.11 veya üzeri
- Webcam; sesli kayıt için mikrofon

## Kurulum

Backend için PowerShell'de:

```powershell
cd backend
py -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
.venv\Scripts\python.exe run.py
```

Yeni bir terminalde frontend için:

```powershell
cd frontend
npm.cmd ci
npm.cmd start
```

`backend/models/holistic_landmarker.task` yerel MediaPipe modelidir. Kamera, mikrofon ve ekran
kaydı izinleri yalnızca ilgili kullanıcı düğmesine basıldıktan sonra istenir.

## Proje yapısı

```text
frontend/  Electron, Three.js, kamera, modeller, jest kontrolleri ve kayıt
backend/   FastAPI WebSocket ve MediaPipe Holistic işleme
shared/    Sürümlenmiş WebSocket mesaj şemaları
docs/      Mimari ve teknik notlar
```

## Güvenlik

- Electron `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` ile çalışır.
- Preload yalnızca sabit ve tek amaçlı IPC kanallarını dışarı açar.
- Python WebSocket sunucusu yalnızca `127.0.0.1:8765` adresinde dinler.
- CSP uzak script, stil, frame, object ve plugin yüklemeyi engeller.
- Kamera ve kayıt otomatik başlamaz; açık kullanıcı eylemi gerekir.
- npm ve Python bağımlılıkları sabit sürümlerle tanımlanmıştır.

## Geliştirme fikirleri

- Jest kalibrasyon sihirbazı ve kişiye özel hassasiyet profilleri
- Depth kamera desteğiyle gerçek metrik konum ve daha doğru örtüşme
- STEP/IGES dönüştürme ve CAD montaj ağacı
- Kesit düzlemleri, ölçüm ve parça etiketleme araçları
- Mekanik eklem, motor, dişli ve patlatılmış montaj simülasyonları
- Birden fazla model, sahne kaydetme ve tekrar açma
- MP4 dışa aktarma, sistem sesi ve kayıt kalite ayarları
- Otomatik testler, performans profilleme ve GPU optimizasyonu
- Erişilebilirlik, yerelleştirme ve paketlenmiş Windows kurulumu

Katkı yapmak isteyenler issue açabilir veya amaç ve test adımları belirtilmiş bir pull request
gönderebilir. Mimari ayrıntılar için [docs/architecture.md](docs/architecture.md) dosyasına bakın.

## Mevcut sınırlamalar

- Tek webcam ile 30 cm ve ön/arka hesapları yaklaşıktır.
- Jest başarımı ışık, kamera açısı, arka plan ve model boyutundan etkilenir.
- Mekanik simülasyon ve kesit alma henüz uygulanmamıştır.
- Kayıt WebM biçimindedir ve sistem sesi içermez.
