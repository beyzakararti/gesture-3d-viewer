'use strict';

const cameraStatus = document.querySelector('#camera-status');
const personStatus = document.querySelector('#person-status');
const backendStatus = document.querySelector('#backend-status');
const video = document.querySelector('#camera');
const startButton = document.querySelector('#start-camera');
const stopButton = document.querySelector('#stop-camera');
const chooseModelButton = document.querySelector('#choose-model');
const modelFileInput = document.querySelector('#model-file');
const modelStatus = document.querySelector('#model-status');
const handsCanvas = document.querySelector('#hands');
const handsContext = handsCanvas.getContext('2d');
const personCanvas = document.querySelector('#person-occlusion');
const personContext = personCanvas.getContext('2d');
const personFrameCanvas = document.createElement('canvas');
const personFrameContext = personFrameCanvas.getContext('2d');
const handClipCanvas = document.createElement('canvas');
const handClipContext = handClipCanvas.getContext('2d');
const captureCanvas = document.createElement('canvas');
const captureContext = captureCanvas.getContext('2d');
const presentationStatus = document.querySelector('#presentation-status');
const leftShoulderAsset = document.querySelector('#left-shoulder-asset');
const rightShoulderAsset = document.querySelector('#right-shoulder-asset');
const leftImageInput = document.querySelector('#left-image-file');
const rightImageInput = document.querySelector('#right-image-file');
const chooseLeftImageButton = document.querySelector('#choose-left-image');
const chooseRightImageButton = document.querySelector('#choose-right-image');
const clearImagesButton = document.querySelector('#clear-images');
const recordingStatus = document.querySelector('#recording-status');
const startRecordingButton = document.querySelector('#start-recording');
const stopRecordingButton = document.querySelector('#stop-recording');
const recordMicrophoneCheckbox = document.querySelector('#record-microphone');
const controlPanel = document.querySelector('#control-panel');
const togglePanelButton = document.querySelector('#toggle-panel');
const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]
];
let mediaStream = null;
let gestureSocket = null;
let frameInFlight = false;
let reconnectTimer = null;
let isShuttingDown = false;
const shoulderAssetUrls = { left: null, right: null };
let displayStream = null;
let microphoneStream = null;
let mediaRecorder = null;
let recordingChunks = [];
let recordingStartedAt = 0;
let latestSegmentationFrame = 0;

window.addEventListener('error', (event) => {
  cameraStatus.textContent = `Arayüz hatası: ${event.message}`;
  if (event.filename?.includes('renderer.bundle.js')) {
    modelStatus.textContent = `3B yükleyici hatası: ${event.message}`;
  }
});

window.addEventListener('unhandledrejection', (event) => {
  const message = event.reason instanceof Error ? event.reason.message : String(event.reason);
  cameraStatus.textContent = `Arayüz hatası: ${message}`;
});

async function startCamera() {
  startButton.disabled = true;
  cameraStatus.textContent = 'Kamera izni bekleniyor…';

  try {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      throw new Error('Güvenli kamera API’si bu ortamda kullanılamıyor');
    }

    mediaStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    });
    video.srcObject = mediaStream;
    await video.play();
    cameraStatus.textContent = 'Kamera açık.';
    stopButton.disabled = false;
  } catch (error) {
    const name = error instanceof DOMException ? `${error.name}: ` : '';
    cameraStatus.textContent = `Kamera başlatılamadı: ${name}${error.message || 'Bilinmeyen hata'}`;
    startButton.disabled = false;
  }
}

function stopCamera() {
  mediaStream?.getTracks().forEach((track) => track.stop());
  mediaStream = null;
  video.srcObject = null;
  cameraStatus.textContent = 'Kamera kapalı.';
  startButton.disabled = false;
  stopButton.disabled = true;
  handsContext.clearRect(0, 0, handsCanvas.width, handsCanvas.height);
}

function resizeHandsCanvas() {
  const pixelRatio = Math.min(window.devicePixelRatio, 2);
  const width = Math.round(handsCanvas.clientWidth * pixelRatio);
  const height = Math.round(handsCanvas.clientHeight * pixelRatio);
  if (handsCanvas.width !== width || handsCanvas.height !== height) {
    handsCanvas.width = width;
    handsCanvas.height = height;
  }
  handsContext.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
}

function drawHands(hands) {
  resizeHandsCanvas();
  const width = handsCanvas.clientWidth;
  const height = handsCanvas.clientHeight;
  handsContext.clearRect(0, 0, width, height);
  if (!video.videoWidth || !video.videoHeight) return;

  const scale = Math.max(width / video.videoWidth, height / video.videoHeight);
  const renderedWidth = video.videoWidth * scale;
  const renderedHeight = video.videoHeight * scale;
  const offsetX = (width - renderedWidth) / 2;
  const offsetY = (height - renderedHeight) / 2;
  const point = (landmark) => ({
    x: offsetX + landmark.x * renderedWidth,
    y: offsetY + landmark.y * renderedHeight
  });

  for (const hand of hands) {
    const color = hand.handedness === 'Left' ? '#53e0ff' : '#ffcb57';
    handsContext.strokeStyle = color;
    handsContext.fillStyle = color;
    handsContext.lineWidth = 3;
    handsContext.beginPath();
    for (const [from, to] of HAND_CONNECTIONS) {
      const start = point(hand.landmarks[from]);
      const end = point(hand.landmarks[to]);
      handsContext.moveTo(start.x, start.y);
      handsContext.lineTo(end.x, end.y);
    }
    handsContext.stroke();

    for (const landmark of hand.landmarks) {
      const current = point(landmark);
      handsContext.beginPath();
      handsContext.arc(current.x, current.y, 4, 0, Math.PI * 2);
      handsContext.fill();
    }
  }
}

function clearPersonOcclusion() {
  personContext.clearRect(0, 0, personCanvas.width, personCanvas.height);
}

function drawPersonOcclusion(maskBase64, frameId, personInFront, handInFront, hands) {
  if (!maskBase64 || (!personInFront && !handInFront) || !video.videoWidth || !video.videoHeight) {
    clearPersonOcclusion();
    return;
  }
  const maskImage = new Image();
  maskImage.addEventListener('load', () => {
    if (frameId < latestSegmentationFrame) return;
    latestSegmentationFrame = frameId;
    personFrameCanvas.width = 480;
    personFrameCanvas.height = 270;
    personFrameContext.globalCompositeOperation = 'source-over';
    personFrameContext.clearRect(0, 0, 480, 270);
    personFrameContext.save();
    personFrameContext.translate(480, 0);
    personFrameContext.scale(-1, 1);
    personFrameContext.drawImage(video, 0, 0, 480, 270);
    personFrameContext.restore();
    personFrameContext.globalCompositeOperation = 'destination-in';
    personFrameContext.drawImage(maskImage, 0, 0, 480, 270);
    if (!personInFront && handInFront) {
      handClipCanvas.width = 480;
      handClipCanvas.height = 270;
      handClipContext.clearRect(0, 0, 480, 270);
      handClipContext.fillStyle = 'white';
      for (const hand of hands) {
        const palm = hand.landmarks[9];
        const palmSize = Math.hypot(
          (hand.landmarks[0].x - palm.x) * 480,
          (hand.landmarks[0].y - palm.y) * 270
        );
        handClipContext.beginPath();
        handClipContext.arc(palm.x * 480, palm.y * 270, Math.max(48, palmSize * 1.8), 0, Math.PI * 2);
        handClipContext.fill();
      }
      personFrameContext.drawImage(handClipCanvas, 0, 0);
    }
    personFrameContext.globalCompositeOperation = 'source-over';

    const ratio = Math.min(window.devicePixelRatio, 2);
    const width = personCanvas.clientWidth;
    const height = personCanvas.clientHeight;
    personCanvas.width = Math.round(width * ratio);
    personCanvas.height = Math.round(height * ratio);
    personContext.setTransform(ratio, 0, 0, ratio, 0, 0);
    const scale = Math.max(width / 480, height / 270);
    const drawWidth = 480 * scale;
    const drawHeight = 270 * scale;
    personContext.clearRect(0, 0, width, height);
    personContext.drawImage(
      personFrameCanvas,
      (width - drawWidth) / 2,
      (height - drawHeight) / 2,
      drawWidth,
      drawHeight
    );
  }, { once: true });
  maskImage.src = `data:image/png;base64,${maskBase64}`;
}

window.addEventListener('person-occlusion', (event) => {
  drawPersonOcclusion(
    event.detail.segmentationMask,
    event.detail.frameId,
    event.detail.personInFront,
    event.detail.handInFront,
    event.detail.hands ?? []
  );
  if (event.detail.personInFront) {
    personStatus.className = 'status person-foreground';
    personStatus.textContent = `Modelin önündesiniz · Siz: ${Math.round(event.detail.personDistanceMeters * 100)} cm · Model: ${Math.round(event.detail.modelDistanceMeters * 100)} cm`;
  } else if (Number.isFinite(event.detail.modelDistanceMeters)
      && Number.isFinite(event.detail.personDistanceMeters)) {
    personStatus.className = 'status person-detected';
    personStatus.textContent = `Modelin arkasındasınız · Siz: ${Math.round(event.detail.personDistanceMeters * 100)} cm · Model: ${Math.round(event.detail.modelDistanceMeters * 100)} cm`;
  }
});

function normalizedPointToViewport(landmark) {
  const width = handsCanvas.clientWidth;
  const height = handsCanvas.clientHeight;
  if (!video.videoWidth || !video.videoHeight) return null;
  const scale = Math.max(width / video.videoWidth, height / video.videoHeight);
  const renderedWidth = video.videoWidth * scale;
  const renderedHeight = video.videoHeight * scale;
  return {
    x: (width - renderedWidth) / 2 + landmark.x * renderedWidth,
    y: (height - renderedHeight) / 2 + landmark.y * renderedHeight
  };
}

function updateShoulderAssets(pose) {
  if (pose.length < 13 || pose[11].visibility < 0.45 || pose[12].visibility < 0.45) {
    leftShoulderAsset.style.opacity = '0';
    rightShoulderAsset.style.opacity = '0';
    return;
  }

  const shoulders = [normalizedPointToViewport(pose[11]), normalizedPointToViewport(pose[12])]
    .filter(Boolean)
    .sort((first, second) => first.x - second.x);
  if (shoulders.length !== 2) return;

  const [screenLeft, screenRight] = shoulders;
  const shoulderSpan = Math.abs(screenRight.x - screenLeft.x);
  const cardWidth = Math.max(150, Math.min(300, shoulderSpan * 0.82));
  const place = (element, point, side) => {
    if (!element.src) return;
    const aspect = element.naturalHeight / Math.max(element.naturalWidth, 1);
    const cardHeight = Math.min(cardWidth * aspect, window.innerHeight * 0.44);
    const x = side === 'left' ? point.x - cardWidth - 22 : point.x + 22;
    const y = point.y - cardHeight * 0.38;
    element.style.width = `${cardWidth}px`;
    element.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    element.style.opacity = '1';
  };

  place(leftShoulderAsset, screenLeft, 'left');
  place(rightShoulderAsset, screenRight, 'right');
}

function loadShoulderImage(side, file) {
  if (!file.type.startsWith('image/') || file.size > 20 * 1024 * 1024) {
    presentationStatus.textContent = 'Yalnızca 20 MB’tan küçük PNG, JPG veya WebP seçin.';
    return;
  }

  const element = side === 'left' ? leftShoulderAsset : rightShoulderAsset;
  if (shoulderAssetUrls[side]) URL.revokeObjectURL(shoulderAssetUrls[side]);
  shoulderAssetUrls[side] = URL.createObjectURL(file);
  element.addEventListener('load', () => {
    presentationStatus.textContent = `${file.name} ${side === 'left' ? 'sol' : 'sağ'} omuza hazır.`;
  }, { once: true });
  element.src = shoulderAssetUrls[side];
}

function clearShoulderImages() {
  for (const side of ['left', 'right']) {
    const element = side === 'left' ? leftShoulderAsset : rightShoulderAsset;
    element.removeAttribute('src');
    element.style.opacity = '0';
    if (shoulderAssetUrls[side]) URL.revokeObjectURL(shoulderAssetUrls[side]);
    shoulderAssetUrls[side] = null;
  }
  presentationStatus.textContent = 'Sunum görselleri kaldırıldı.';
}

function preferredRecordingMimeType() {
  return [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm'
  ].find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) ?? '';
}

async function saveFinishedRecording() {
  const blob = new Blob(recordingChunks, { type: mediaRecorder.mimeType || 'video/webm' });
  recordingChunks = [];
  displayStream?.getTracks().forEach((track) => track.stop());
  displayStream = null;
  microphoneStream?.getTracks().forEach((track) => track.stop());
  microphoneStream = null;

  try {
    recordingStatus.textContent = 'Video cihazın Videolar klasörüne kaydediliyor…';
    const result = await window.desktopApi.saveRecording(await blob.arrayBuffer());
    const megabytes = (result.bytes / 1024 / 1024).toFixed(1);
    recordingStatus.textContent = `Kayıt tamamlandı (${megabytes} MB): ${result.path}`;
  } catch (error) {
    recordingStatus.textContent = `Kayıt kaydedilemedi: ${error.message}`;
  } finally {
    mediaRecorder = null;
    recordingStatus.classList.remove('recording-active');
    startRecordingButton.disabled = false;
    stopRecordingButton.disabled = true;
    recordMicrophoneCheckbox.disabled = false;
  }
}

async function startRecording() {
  startRecordingButton.disabled = true;
  recordMicrophoneCheckbox.disabled = true;
  recordingStatus.textContent = recordMicrophoneCheckbox.checked
    ? 'Uygulama görüntüsü ve mikrofon izinleri isteniyor…'
    : 'Uygulama görüntüsü için kayıt izni isteniyor…';

  try {
    await window.desktopApi.authorizeRecording();
    displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30, max: 30 } },
      audio: false
    });
    if (recordMicrophoneCheckbox.checked) {
      microphoneStream = await navigator.mediaDevices.getUserMedia({
        video: false,
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
    }
    const recordingStream = new MediaStream([
      ...displayStream.getVideoTracks(),
      ...(microphoneStream?.getAudioTracks() ?? [])
    ]);
    const mimeType = preferredRecordingMimeType();
    mediaRecorder = new MediaRecorder(recordingStream, mimeType ? { mimeType } : undefined);
    recordingChunks = [];
    mediaRecorder.addEventListener('dataavailable', (event) => {
      if (event.data.size > 0) recordingChunks.push(event.data);
    });
    mediaRecorder.addEventListener('stop', () => { void saveFinishedRecording(); }, { once: true });
    displayStream.getVideoTracks()[0]?.addEventListener('ended', () => {
      if (mediaRecorder?.state === 'recording') mediaRecorder.stop();
    });
    mediaRecorder.start(1000);
    recordingStartedAt = Date.now();
    recordingStatus.textContent = microphoneStream
      ? 'Görüntü ve mikrofon kaydediliyor…'
      : 'Sessiz görüntü kaydediliyor…';
    recordingStatus.classList.add('recording-active');
    stopRecordingButton.disabled = false;
  } catch (error) {
    displayStream?.getTracks().forEach((track) => track.stop());
    displayStream = null;
    microphoneStream?.getTracks().forEach((track) => track.stop());
    microphoneStream = null;
    mediaRecorder = null;
    startRecordingButton.disabled = false;
    recordMicrophoneCheckbox.disabled = false;
    recordingStatus.textContent = `Kayıt başlatılamadı: ${error.message}`;
  }
}

togglePanelButton.addEventListener('click', () => {
  const collapsed = controlPanel.classList.toggle('collapsed');
  togglePanelButton.setAttribute('aria-expanded', String(!collapsed));
  togglePanelButton.title = collapsed ? 'Kontrol panelini aç' : 'Kontrol panelini daralt';
});

function stopRecording() {
  if (!mediaRecorder || mediaRecorder.state !== 'recording') return;
  const seconds = Math.max(1, Math.round((Date.now() - recordingStartedAt) / 1000));
  recordingStatus.textContent = `${seconds} saniyelik kayıt hazırlanıyor…`;
  stopRecordingButton.disabled = true;
  mediaRecorder.stop();
}

async function connectBackend() {
  const { backendUrl } = await window.desktopApi.getRuntimeInfo();
  gestureSocket = new WebSocket(backendUrl);

  gestureSocket.addEventListener('open', () => {
    backendStatus.textContent = 'Backend: bağlandı';
  });
  gestureSocket.addEventListener('message', (event) => {
    try {
      const message = JSON.parse(event.data);
      if (message.type === 'hello') {
        backendStatus.textContent = `Backend: ${message.message}`;
      } else if (message.type === 'hands') {
        frameInFlight = false;
        drawHands(message.hands);
        updateShoulderAssets(message.pose ?? []);
        const personDetected = Number.isFinite(message.personDistanceMeters);
        personStatus.className = `status ${personDetected ? 'person-detected' : 'person-searching'}`;
        personStatus.textContent = personDetected
          ? `Kişi algılandı · Yaklaşık mesafe: ${Math.round(message.personDistanceMeters * 100)} cm · ${message.segmentationMask ? 'Maske hazır' : 'Maske bekleniyor'}`
          : 'Kişi aranıyor… Omuzlarınızı kamerada gösterin.';
        window.dispatchEvent(new CustomEvent('hand-landmarks', { detail: message }));
        backendStatus.textContent = `El takibi: ${message.hands.length} el · ${message.processingMs} ms`;
      } else if (message.type === 'error') {
        frameInFlight = false;
        backendStatus.textContent = `Backend hatası: ${message.code}`;
      }
    } catch {
      backendStatus.textContent = 'Backend: geçersiz mesaj alındı';
    }
  });
  gestureSocket.addEventListener('close', () => {
    gestureSocket = null;
    frameInFlight = false;
    if (isShuttingDown) return;
    backendStatus.textContent = 'Backend: bağlantı kesildi; yeniden deneniyor…';
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => void connectBackend(), 2000);
  });
  gestureSocket.addEventListener('error', () => {
    backendStatus.textContent = 'Backend: erişilemiyor';
  });
}

function sendCameraFrame() {
  if (!mediaStream || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
  if (!gestureSocket || gestureSocket.readyState !== WebSocket.OPEN || frameInFlight) return;

  captureCanvas.width = 480;
  captureCanvas.height = 270;
  captureContext.save();
  captureContext.translate(captureCanvas.width, 0);
  captureContext.scale(-1, 1);
  captureContext.drawImage(video, 0, 0, captureCanvas.width, captureCanvas.height);
  captureContext.restore();

  frameInFlight = true;
  captureCanvas.toBlob((blob) => {
    if (!blob || !gestureSocket || gestureSocket.readyState !== WebSocket.OPEN) {
      frameInFlight = false;
      return;
    }
    gestureSocket.send(blob);
  }, 'image/jpeg', 0.68);
}

startButton.addEventListener('click', startCamera);
stopButton.addEventListener('click', stopCamera);
window.addEventListener('beforeunload', () => {
  isShuttingDown = true;
  clearTimeout(reconnectTimer);
  gestureSocket?.close();
  displayStream?.getTracks().forEach((track) => track.stop());
  microphoneStream?.getTracks().forEach((track) => track.stop());
  clearShoulderImages();
  stopCamera();
});

void connectBackend().catch(() => {
  backendStatus.textContent = 'Backend: bağlantı başlatılamadı';
});
setInterval(sendCameraFrame, 125);

chooseModelButton.addEventListener('click', () => {
  modelStatus.textContent = 'Dosya seçici açılıyor…';
  modelFileInput.click();
});

modelFileInput.addEventListener('cancel', () => {
  modelStatus.textContent = 'Dosya seçimi iptal edildi.';
});

modelFileInput.addEventListener('change', async () => {
  const [file] = modelFileInput.files;
  if (!file) {
    modelStatus.textContent = 'Dosya seçilmedi.';
    return;
  }

  modelStatus.textContent = `${file.name} seçildi; 3B yükleyici hazırlanıyor…`;
  chooseModelButton.disabled = true;
  try {
    window.dispatchEvent(new CustomEvent('model-file-selected', { detail: { file } }));
  } catch (error) {
    modelStatus.textContent = `3B yükleyici başlatılamadı: ${error.message}`;
  }
});

window.addEventListener('model-load-finished', () => {
  chooseModelButton.disabled = false;
  modelFileInput.value = '';
});

chooseLeftImageButton.addEventListener('click', () => leftImageInput.click());
chooseRightImageButton.addEventListener('click', () => rightImageInput.click());
leftImageInput.addEventListener('change', () => {
  const [file] = leftImageInput.files;
  if (file) loadShoulderImage('left', file);
  leftImageInput.value = '';
});
rightImageInput.addEventListener('change', () => {
  const [file] = rightImageInput.files;
  if (file) loadShoulderImage('right', file);
  rightImageInput.value = '';
});
clearImagesButton.addEventListener('click', clearShoulderImages);
startRecordingButton.addEventListener('click', () => { void startRecording(); });
stopRecordingButton.addEventListener('click', stopRecording);
