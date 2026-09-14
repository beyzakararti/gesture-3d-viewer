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
const captureContext = captureCanvas.getContext('2d', { willReadFrequently: false });
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
const toolTabs = [...document.querySelectorAll('.tool-tab')];
const toolPages = [...document.querySelectorAll('.tool-page')];

const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]
];

// Frames sent for tracking. 640x360 keeps small fingers several pixels wide,
// which is what MediaPipe needs to keep a hand latched between frames.
const CAPTURE_WIDTH = 640;
const CAPTURE_HEIGHT = 360;
const CAPTURE_QUALITY = 0.8;
const CAPTURE_INTERVAL_MS = 80;
// Person cut-out resolution. The segmentation mask itself is coarser; this is
// the buffer the live video is masked into before it is scaled to the viewport.
const COMPOSITE_WIDTH = 640;
const COMPOSITE_HEIGHT = 360;
const OCCLUSION_FRAME_BUDGET_MS = 32;
const DEPTH_HYSTERESIS_METRES = 0.06;
// Horizontal extent of the view at distance d is d * 2 * tan(hfov/2); the
// backend assumes a 60 degree horizontal field of view for its distance maths,
// so reuse the same factor to turn normalised z into metres.
const VIEW_WIDTH_FACTOR = 2 * Math.tan((30 * Math.PI) / 180);

const sharedState = (window.__BYEZA__ = window.__BYEZA__ ?? {});

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

let maskBitmap = null;
let maskDecodeInFlight = false;
let latestPose = [];
let latestHands = [];
let lastOcclusionDraw = 0;
let occlusionPainted = false;
let personInFrontLatched = false;

captureCanvas.width = CAPTURE_WIDTH;
captureCanvas.height = CAPTURE_HEIGHT;
personFrameCanvas.width = COMPOSITE_WIDTH;
personFrameCanvas.height = COMPOSITE_HEIGHT;
handClipCanvas.width = COMPOSITE_WIDTH;
handClipCanvas.height = COMPOSITE_HEIGHT;
handClipContext.lineCap = 'round';
handClipContext.lineJoin = 'round';

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
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      audio: false
    });
    video.srcObject = mediaStream;
    await video.play();
    document.querySelector('#viewport').classList.add('camera-active');
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
  document.querySelector('#viewport').classList.remove('camera-active');
  cameraStatus.textContent = 'Kamera kapalı.';
  startButton.disabled = false;
  stopButton.disabled = true;
  handsContext.clearRect(0, 0, handsCanvas.width, handsCanvas.height);
  maskBitmap?.close();
  maskBitmap = null;
  latestHands = [];
  latestPose = [];
  clearPersonOcclusion();
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
  if (!occlusionPainted) return;
  personContext.setTransform(1, 0, 0, 1, 0, 0);
  personContext.clearRect(0, 0, personCanvas.width, personCanvas.height);
  occlusionPainted = false;
}

/* ------------------------------------------------------------------ *
 * Depth-aware person / hand occlusion
 * ------------------------------------------------------------------ */

function decodeMask(base64) {
  if (maskDecodeInFlight || !base64) return;
  maskDecodeInFlight = true;
  // atob + createImageBitmap keeps the PNG decode off the main thread; the old
  // `new Image()` with a data URL decoded synchronously on every frame.
  let bytes;
  try {
    const binary = atob(base64);
    bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  } catch {
    maskDecodeInFlight = false;
    return;
  }

  createImageBitmap(new Blob([bytes], { type: 'image/png' }))
    .then((bitmap) => {
      maskBitmap?.close();
      maskBitmap = bitmap;
    })
    .catch(() => {})
    .finally(() => { maskDecodeInFlight = false; });
}

/** Metres from the camera for one pose landmark, given the torso reference. */
function landmarkDepthMetres(landmark, shoulderZ, personDepth) {
  if (!landmark || !Number.isFinite(personDepth)) return null;
  return personDepth + (landmark.z - shoulderZ) * VIEW_WIDTH_FACTOR * personDepth;
}

function handsInFrontOfModel(modelDepth, personDepth) {
  if (latestPose.length < 17 || !Number.isFinite(personDepth)) return [];
  const shoulderZ = (latestPose[11].z + latestPose[12].z) / 2;
  const wristFor = { Left: latestPose[15], Right: latestPose[16] };
  return latestHands.filter((hand) => {
    const wrist = wristFor[hand.handedness];
    if (!wrist || wrist.visibility < 0.3) return false;
    const depth = landmarkDepthMetres(wrist, shoulderZ, personDepth);
    return Number.isFinite(depth) && depth < modelDepth - DEPTH_HYSTERESIS_METRES;
  });
}

function drawHandSilhouette(hands) {
  handClipContext.fillStyle = 'white';
  handClipContext.strokeStyle = 'white';

  for (const hand of hands) {
    if (!Array.isArray(hand.landmarks) || hand.landmarks.length < 21) continue;
    const point = (index) => ({
      x: hand.landmarks[index].x * COMPOSITE_WIDTH,
      y: hand.landmarks[index].y * COMPOSITE_HEIGHT
    });
    const wrist = point(0);
    const middleMcp = point(9);
    const palmSize = Math.max(14, Math.hypot(wrist.x - middleMcp.x, wrist.y - middleMcp.y));

    // Each finger is stroked separately so the gaps between them stay clear.
    handClipContext.lineWidth = Math.max(9, palmSize * 0.34);
    for (const finger of [[0, 1, 2, 3, 4], [0, 5, 6, 7, 8], [0, 9, 10, 11, 12], [0, 13, 14, 15, 16], [0, 17, 18, 19, 20]]) {
      handClipContext.beginPath();
      const first = point(finger[0]);
      handClipContext.moveTo(first.x, first.y);
      for (const index of finger.slice(1)) {
        const current = point(index);
        handClipContext.lineTo(current.x, current.y);
      }
      handClipContext.stroke();
    }

    const palm = [0, 1, 5, 9, 13, 17].map(point);
    handClipContext.beginPath();
    handClipContext.moveTo(palm[0].x, palm[0].y);
    for (const current of palm.slice(1)) handClipContext.lineTo(current.x, current.y);
    handClipContext.closePath();
    handClipContext.fill();
  }
}

function paintOcclusion() {
  const modelDepth = sharedState.modelDepthMeters;
  const personDepth = sharedState.personDepthMeters;
  if (!sharedState.anchored || !Number.isFinite(modelDepth) || !maskBitmap || !video.videoWidth) {
    clearPersonOcclusion();
    return;
  }

  // Hysteresis on the whole-body test stops the model flickering in and out when
  // the distance estimate jitters around the model plane.
  if (Number.isFinite(personDepth)) {
    personInFrontLatched = personInFrontLatched
      ? personDepth < modelDepth + DEPTH_HYSTERESIS_METRES
      : personDepth < modelDepth - DEPTH_HYSTERESIS_METRES;
  } else {
    personInFrontLatched = false;
  }

  const forwardHands = personInFrontLatched ? [] : handsInFrontOfModel(modelDepth, personDepth);
  if (!personInFrontLatched && forwardHands.length === 0) {
    clearPersonOcclusion();
    return;
  }

  handClipContext.clearRect(0, 0, COMPOSITE_WIDTH, COMPOSITE_HEIGHT);
  if (personInFrontLatched) {
    handClipContext.drawImage(maskBitmap, 0, 0, COMPOSITE_WIDTH, COMPOSITE_HEIGHT);
  } else {
    drawHandSilhouette(forwardHands);
  }

  personFrameContext.globalCompositeOperation = 'source-over';
  personFrameContext.clearRect(0, 0, COMPOSITE_WIDTH, COMPOSITE_HEIGHT);
  personFrameContext.save();
  personFrameContext.translate(COMPOSITE_WIDTH, 0);
  personFrameContext.scale(-1, 1);
  personFrameContext.drawImage(video, 0, 0, COMPOSITE_WIDTH, COMPOSITE_HEIGHT);
  personFrameContext.restore();
  personFrameContext.globalCompositeOperation = 'destination-in';
  personFrameContext.drawImage(handClipCanvas, 0, 0);
  personFrameContext.globalCompositeOperation = 'source-over';

  const ratio = Math.min(window.devicePixelRatio, 2);
  const width = personCanvas.clientWidth;
  const height = personCanvas.clientHeight;
  const targetWidth = Math.round(width * ratio);
  const targetHeight = Math.round(height * ratio);
  if (personCanvas.width !== targetWidth || personCanvas.height !== targetHeight) {
    personCanvas.width = targetWidth;
    personCanvas.height = targetHeight;
  }
  personContext.setTransform(ratio, 0, 0, ratio, 0, 0);
  personContext.clearRect(0, 0, width, height);
  const scale = Math.max(width / COMPOSITE_WIDTH, height / COMPOSITE_HEIGHT);
  const drawWidth = COMPOSITE_WIDTH * scale;
  const drawHeight = COMPOSITE_HEIGHT * scale;
  personContext.drawImage(
    personFrameCanvas,
    (width - drawWidth) / 2,
    (height - drawHeight) / 2,
    drawWidth,
    drawHeight
  );
  occlusionPainted = true;
}

function occlusionLoop() {
  requestAnimationFrame(occlusionLoop);
  const now = performance.now();
  if (now - lastOcclusionDraw < OCCLUSION_FRAME_BUDGET_MS) return;
  lastOcclusionDraw = now;
  paintOcclusion();
}

function describePresence() {
  const modelDepth = sharedState.modelDepthMeters;
  const personDepth = sharedState.personDepthMeters;
  if (!Number.isFinite(personDepth)) {
    personStatus.className = 'status person-searching';
    personStatus.textContent = 'Kişi aranıyor… Omuzlarınızı kamerada gösterin.';
    return;
  }
  if (!sharedState.anchored || !Number.isFinite(modelDepth)) {
    personStatus.className = 'status person-detected';
    personStatus.textContent = `Kişi algılandı · Yaklaşık mesafe: ${Math.round(personDepth * 100)} cm`;
    return;
  }
  const inFront = personDepth < modelDepth;
  personStatus.className = `status ${inFront ? 'person-foreground' : 'person-detected'}`;
  personStatus.textContent = `${inFront ? 'Modelin önündesiniz' : 'Modelin arkasındasınız'} · Siz: ${Math.round(personDepth * 100)} cm · Model: ${Math.round(modelDepth * 100)} cm`;
}

/* ------------------------------------------------------------------ *
 * Shoulder assets
 * ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ *
 * Recording
 * ------------------------------------------------------------------ */

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

  let recordingPhase = 'ekran görüntüsü izni';
  try {
    const sourceId = await window.desktopApi.getRecordingSourceId();
    displayStream = await navigator.mediaDevices.getUserMedia({
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId,
          maxFrameRate: 30
        }
      },
      audio: false
    });
    if (recordMicrophoneCheckbox.checked) {
      recordingPhase = 'mikrofon izni';
      try {
        microphoneStream = await navigator.mediaDevices.getUserMedia({
          video: false,
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          }
        });
      } catch (error) {
        microphoneStream = null;
        recordingStatus.textContent = `Mikrofon izni verilmedi (${error.message}); sessiz kayıt başlatılıyor…`;
      }
    }
    const recordingStream = new MediaStream([
      ...displayStream.getVideoTracks(),
      ...(microphoneStream?.getAudioTracks() ?? [])
    ]);
    recordingPhase = 'video kodlayıcı';
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
    recordingStatus.textContent = `Kayıt başlatılamadı (${recordingPhase}): ${error.name ? `${error.name}: ` : ''}${error.message}`;
  }
}

function stopRecording() {
  if (!mediaRecorder || mediaRecorder.state !== 'recording') return;
  const seconds = Math.max(1, Math.round((Date.now() - recordingStartedAt) / 1000));
  recordingStatus.textContent = `${seconds} saniyelik kayıt hazırlanıyor…`;
  stopRecordingButton.disabled = true;
  mediaRecorder.stop();
}

/* ------------------------------------------------------------------ *
 * Panel chrome
 * ------------------------------------------------------------------ */

togglePanelButton.addEventListener('click', () => {
  const collapsed = controlPanel.classList.toggle('collapsed');
  togglePanelButton.setAttribute('aria-expanded', String(!collapsed));
  togglePanelButton.title = collapsed ? 'Kontrol panelini aç' : 'Kontrol panelini daralt';
});

toolTabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    const target = tab.dataset.panel;
    toolTabs.forEach((candidate) => candidate.classList.toggle('active', candidate === tab));
    toolPages.forEach((page) => {
      const isActive = page.dataset.page === target;
      page.classList.toggle('active', isActive);
      page.hidden = !isActive;
    });
  });
});

/* ------------------------------------------------------------------ *
 * Backend stream
 * ------------------------------------------------------------------ */

async function connectBackend() {
  const { backendUrl } = await window.desktopApi.getRuntimeInfo();
  gestureSocket = new WebSocket(backendUrl);

  gestureSocket.addEventListener('open', () => {
    backendStatus.textContent = 'Backend: bağlandı';
    backendStatus.classList.add('connected');
  });
  gestureSocket.addEventListener('message', (event) => {
    try {
      const message = JSON.parse(event.data);
      if (message.type === 'hello') {
        backendStatus.textContent = `Backend: ${message.message}`;
      } else if (message.type === 'hands') {
        frameInFlight = false;
        latestHands = message.hands ?? [];
        latestPose = message.pose ?? [];
        drawHands(latestHands);
        updateShoulderAssets(latestPose);
        if (message.segmentationMask) decodeMask(message.segmentationMask);
        window.dispatchEvent(new CustomEvent('hand-landmarks', { detail: message }));
        describePresence();
        const boost = message.lowLightBoosted ? ' · ışık artırıldı' : '';
        backendStatus.textContent = `El takibi: ${latestHands.length} el · ${message.processingMs} ms${boost}`;
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
    backendStatus.classList.remove('connected');
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => void connectBackend(), 2000);
  });
  gestureSocket.addEventListener('error', () => {
    backendStatus.textContent = 'Backend: erişilemiyor';
    backendStatus.classList.remove('connected');
  });
}

function sendCameraFrame() {
  if (!mediaStream || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
  if (!gestureSocket || gestureSocket.readyState !== WebSocket.OPEN || frameInFlight) return;

  captureContext.save();
  captureContext.translate(CAPTURE_WIDTH, 0);
  captureContext.scale(-1, 1);
  captureContext.drawImage(video, 0, 0, CAPTURE_WIDTH, CAPTURE_HEIGHT);
  captureContext.restore();

  frameInFlight = true;
  captureCanvas.toBlob((blob) => {
    if (!blob || !gestureSocket || gestureSocket.readyState !== WebSocket.OPEN) {
      frameInFlight = false;
      return;
    }
    gestureSocket.send(blob);
  }, 'image/jpeg', CAPTURE_QUALITY);
}

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */

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
setInterval(sendCameraFrame, CAPTURE_INTERVAL_MS);
occlusionLoop();

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
