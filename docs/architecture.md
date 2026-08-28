# Mimari notları

Electron ana süreci pencereyi ve izin sınırlarını yönetir. Sandbox içindeki renderer Node.js
API'lerine doğrudan erişemez; yalnızca preload tarafından sunulan küçük ve sabit API'yi görür.
Three.js, paketlenmiş yerel bağımlılıktan yüklenir. Uzak script, stil veya frame yüklenmez.

Renderer, kullanıcı düğmeye bastıktan sonra kamerayı açar ve video elemanını arka plan olarak
gösterir. Saydam Three.js canvas aynı alanın üzerinde yer alır. GLB dosyaları tarayıcı File API
ve geçici bir `blob:` URL ile yalnızca bellekte yüklenir; dosya yolu preload veya IPC üzerinden
açığa çıkarılmaz. GLTFLoader GLB, STLLoader STL, OBJLoader ise tek dosyalı OBJ verisini işler.
OrbitControls model incelemesini, AnimationMixer ise GLB modelde gömülü ilk animasyonun
oynatılmasını sağlar.

Three.js ve yükleyici eklentileri sabitlenmiş npm paketinden esbuild ile tek bir yerel renderer
bundle'ına derlenir. `npm start` bundle'ı her açılıştan önce yeniden üretir. Bu, özel `app://`
protokolünde çalışma zamanı modül çözümlemesine veya uzak koda ihtiyaç bırakmaz.

Python süreci yalnızca `127.0.0.1:8765` üzerinde `/ws` endpoint'ini açar. Bu aşamada bağlantı
kurulduğunda sürümlenmiş bir `hello` mesajı yollar. Kamera yalnızca Electron renderer tarafından,
kullanıcı izninden sonra açılır. Renderer 480×270 JPEG kareleri en fazla 8 FPS hızında ve aynı
anda yalnızca bir kare beklemede olacak şekilde localhost WebSocket'e gönderir. Backend 2 MB
kare sınırı uygular, MediaPipe Hand Landmarker ile en fazla iki eli işler ve 21 landmark'ı
`hands` mesajıyla geri yollar. Ham kareler diske yazılmaz.

Renderer jest kontrolünü kullanıcı ayrıca etkinleştirdiğinde landmark'ları modele bağlar. Tek
elde avuç merkezi hareketi model rotasyonuna, iki elde avuç merkezleri arasındaki logaritmik
mesafe değişimi kamera zoom'una çevrilir. EMA smoothing, dead-zone, delta clamp ve el sayısı
değişiminde durum sıfırlama titreşim ile ani sıçramaları sınırlar.
Başparmak ve işaret parmağı uçları arasındaki mesafe avuç boyutuna oranlanır. Pinch aktifken
tek-el rotasyonu bastırılır ve parmakların orta noktası kameranın sağ/yukarı düzleminde model
ötelemesine dönüştürülür. Ayrı tutma ve bırakma eşikleri sınır çevresindeki titreşimi önler.

Holistic Landmarker ellerin yanında pose verisini aynı inference içinde üretir. Omuz
landmark'ları iki yerel sunum görselini video üzerine sabitler. Pinch başlangıcı, parmak
orta noktasından Three.js modeline
raycast isabeti gerektirir. Spock hareketi parmak açıklık oranlarından tanınır ve ardışık kare
onayından sonra sunum kilidini toggle eder.

Sunum kilidi kare sayısı yerine yaklaşık 900 ms kesintisiz Spock pozu ister ve tekrar
tetiklenebilmek için 450 ms nötr poz bekler. Kilit anındaki omuz açıklığı, 38 cm ortalama
omuz genişliği ve 60° yatay kamera görüş alanı varsayımıyla kişi mesafesine çevrilir. Model
bu mesafenin 30 cm önüne yerleştirilmiş kabul edilir. Holistic Landmarker'ın yumuşatılmış,
düşük çözünürlüklü segmentasyon maskesi yalnızca kişi bu eşiğin önüne geldiğinde
Three.js katmanını örter. Bu, monoküler kamerada metrik derinlik sensörü olmadığı için yaklaşık
bir görsel derinlik modelidir.

Video kaydı Electron ana sürecinden alınan uygulama pencere kaynak kimliğiyle `getUserMedia`
ve `MediaRecorder` kullanarak mevcut Electron penceresini WebM olarak yakalar. Kullanıcı
mikrofon kaydını seçtiyse ayrı bir `getUserMedia` izni istenir;
mikrofon kanalı ekran video iziyle birleştirilir. Echo cancellation, noise suppression ve automatic
gain control talep edilir. Electron ana süreci bu kaynakları yalnızca güvenilir `app://viewer`
origin'inden gelen açık kullanıcı hareketinde verir. Sistem sesi kaydedilmez. Renderer
dosya sistemine erişemez. Tamamlanan kayıt, preload'daki tek amaçlı `recording:save` kanalıyla
500 MB sınırı ve gönderen origin kontrolü uygulanarak işletim sisteminin Videolar klasörüne yazılır.
