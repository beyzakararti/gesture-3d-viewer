import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';

const canvas = document.querySelector('#scene');
const modelStatus = document.querySelector('#model-status');
const resetButton = document.querySelector('#reset-view');
const wireframeButton = document.querySelector('#toggle-wireframe');
const rotationButton = document.querySelector('#toggle-rotation');
const animationButton = document.querySelector('#toggle-animation');
const gestureButton = document.querySelector('#toggle-gestures');
const gestureStatus = document.querySelector('#gesture-status');
const videoElement = document.querySelector('#camera');

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
camera.position.set(2.5, 1.8, 3.5);

const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.screenSpacePanning = true;

scene.add(new THREE.HemisphereLight(0xffffff, 0x26324a, 2.2));
const keyLight = new THREE.DirectionalLight(0xffffff, 3.5);
keyLight.position.set(4, 6, 3);
scene.add(keyLight);
const rimLight = new THREE.DirectionalLight(0x7ea2ff, 2);
rimLight.position.set(-4, 2, -3);
scene.add(rimLight);

const loader = new GLTFLoader();
const objLoader = new OBJLoader();
const stlLoader = new STLLoader();
const clock = new THREE.Clock();
let model = null;
let mixer = null;
let animationAction = null;
let wireframeEnabled = false;
let autoRotateEnabled = false;
let gestureEnabled = false;
let gestureMode = 'idle';
let smoothedCenters = [];
let previousSingleCenter = null;
let previousTwoHandDistance = null;
let previousPinchCenter = null;
let pinchActive = false;
let pinchCandidateFrames = 0;
let pinchReleaseFrames = 0;
let baseModelQuaternion = null;
let baseModelPosition = null;
let modelRadius = 1;
const modelVelocity = new THREE.Vector3();
let blowFrames = 0;
let blowLatched = false;
let lastBlowAt = 0;
let presentationLocked = false;
let spockLatched = false;
let lockRestoreState = null;
let lockedModelDistanceMeters = null;
let lockedPersonDistanceMeters = null;
let smoothedPersonDistanceMeters = null;
let personIsInFront = false;
let spockReleasedAt = 0;
let spockEvidence = 0;
const raycaster = new THREE.Raycaster();

const GESTURE_SMOOTHING = 0.28;
const ROTATION_DEAD_ZONE = 0.0035;
const MAX_ROTATION_DELTA = 0.035;
const ROTATION_SPEED = 4.2;
const ZOOM_DEAD_ZONE = 0.012;
const MAX_ZOOM_LOG_DELTA = 0.09;
const PINCH_START_RATIO = 0.56;
const PINCH_RELEASE_RATIO = 0.78;
const PINCH_CONFIRM_FRAMES = 3;
const PINCH_RELEASE_FRAMES = 2;
const DRAG_DEAD_ZONE = 0.004;
const MAX_DRAG_DELTA = 0.025;
const BLOW_TRIGGER_SCORE = 0.72;
const BLOW_RELEASE_SCORE = 0.25;
const BLOW_REQUIRED_FRAMES = 6;
const BLOW_COOLDOWN_MS = 1500;
const SPOCK_REQUIRED_EVIDENCE = 6;
const SPOCK_RELEASE_MS = 450;

function disposeMaterial(material) {
  for (const value of Object.values(material)) {
    if (value?.isTexture) value.dispose();
  }
  material.dispose();
}

function removeCurrentModel() {
  if (!model) return;
  scene.remove(model);
  model.traverse((object) => {
    if (!object.isMesh) return;
    object.geometry?.dispose();
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    materials.filter(Boolean).forEach(disposeMaterial);
  });
  mixer = null;
  animationAction = null;
  baseModelQuaternion = null;
  baseModelPosition = null;
  modelVelocity.set(0, 0, 0);
  model = null;
}

function fitCameraToModel() {
  if (!model) return;
  const box = new THREE.Box3().setFromObject(model);
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  if (!Number.isFinite(sphere.radius) || sphere.radius === 0) return;
  modelRadius = sphere.radius;

  const distance = sphere.radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2));
  controls.target.copy(sphere.center);
  camera.position.copy(sphere.center).add(new THREE.Vector3(0.8, 0.55, 1).normalize().multiplyScalar(distance * 1.15));
  camera.near = Math.max(sphere.radius / 100, 0.001);
  camera.far = Math.max(sphere.radius * 100, 100);
  camera.updateProjectionMatrix();
  controls.minDistance = sphere.radius * 0.15;
  controls.maxDistance = sphere.radius * 12;
  controls.update();
  controls.saveState();
}

function setControlsEnabled(enabled, hasAnimation = false) {
  resetButton.disabled = !enabled;
  wireframeButton.disabled = !enabled;
  rotationButton.disabled = !enabled;
  animationButton.disabled = !enabled || !hasAnimation;
  gestureButton.disabled = !enabled;
  if (!enabled) {
    gestureEnabled = false;
    gestureButton.textContent = 'El kontrolü: kapalı';
    gestureStatus.textContent = 'Jest kontrolü için önce model yükleyin.';
    resetGestureState();
  } else {
    gestureStatus.textContent = 'El kontrolünü açarak jestleri etkinleştirin.';
  }
}

function resetGestureState() {
  gestureMode = 'idle';
  smoothedCenters = [];
  previousSingleCenter = null;
  previousTwoHandDistance = null;
  previousPinchCenter = null;
  pinchActive = false;
  pinchCandidateFrames = 0;
  pinchReleaseFrames = 0;
}

function palmCenter(hand) {
  const palmIndices = [0, 5, 9, 13, 17];
  const sum = palmIndices.reduce(
    (value, index) => ({
      x: value.x + hand.landmarks[index].x,
      y: value.y + hand.landmarks[index].y
    }),
    { x: 0, y: 0 }
  );
  return { x: sum.x / palmIndices.length, y: sum.y / palmIndices.length };
}

function smoothCenter(center, index) {
  const previous = smoothedCenters[index];
  if (!previous) {
    smoothedCenters[index] = center;
    return center;
  }
  const smoothed = {
    x: THREE.MathUtils.lerp(previous.x, center.x, GESTURE_SMOOTHING),
    y: THREE.MathUtils.lerp(previous.y, center.y, GESTURE_SMOOTHING)
  };
  smoothedCenters[index] = smoothed;
  return smoothed;
}

function distance2d(first, second) {
  return Math.hypot(second.x - first.x, second.y - first.y);
}

function pinchMeasurement(hand) {
  const thumbTip = hand.landmarks[4];
  const indexTip = hand.landmarks[8];
  const wrist = hand.landmarks[0];
  const middleMcp = hand.landmarks[9];
  const palmSize = Math.max(distance2d(wrist, middleMcp), 0.0001);
  return {
    ratio: distance2d(thumbTip, indexTip) / palmSize,
    center: {
      x: (thumbTip.x + indexTip.x) / 2,
      y: (thumbTip.y + indexTip.y) / 2
    }
  };
}

function landmarkToNdc(landmark) {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!videoElement.videoWidth || !videoElement.videoHeight || !width || !height) return null;
  const scale = Math.max(width / videoElement.videoWidth, height / videoElement.videoHeight);
  const renderedWidth = videoElement.videoWidth * scale;
  const renderedHeight = videoElement.videoHeight * scale;
  const pixelX = (width - renderedWidth) / 2 + landmark.x * renderedWidth;
  const pixelY = (height - renderedHeight) / 2 + landmark.y * renderedHeight;
  return new THREE.Vector2(pixelX / width * 2 - 1, 1 - pixelY / height * 2);
}

function pinchTouchesModel(center) {
  const ndc = landmarkToNdc(center);
  if (!ndc || !model) return false;
  const toleranceX = 34 / Math.max(canvas.clientWidth, 1) * 2;
  const toleranceY = 34 / Math.max(canvas.clientHeight, 1) * 2;
  const samples = [
    [0, 0], [toleranceX, 0], [-toleranceX, 0],
    [0, toleranceY], [0, -toleranceY]
  ];
  return samples.some(([offsetX, offsetY]) => {
    raycaster.setFromCamera(new THREE.Vector2(ndc.x + offsetX, ndc.y + offsetY), camera);
    return raycaster.intersectObject(model, true).length > 0;
  });
}

function isSpockGesture(hand) {
  const landmarks = hand.landmarks;
  const wrist = landmarks[0];
  const palmSize = Math.max(distance2d(wrist, landmarks[9]), 0.0001);
  const extended = (tip, pip) => distance2d(wrist, landmarks[tip]) > distance2d(wrist, landmarks[pip]) * 1.08;
  const fingersExtended = extended(8, 6) && extended(12, 10) && extended(16, 14) && extended(20, 18);
  const indexMiddleGap = distance2d(landmarks[8], landmarks[12]) / palmSize;
  const middleRingGap = distance2d(landmarks[12], landmarks[16]) / palmSize;
  const ringPinkyGap = distance2d(landmarks[16], landmarks[20]) / palmSize;
  const groupedPairs = indexMiddleGap < 0.9 && ringPinkyGap < 0.9;
  const splitCenter = middleRingGap > 0.42
    && middleRingGap > indexMiddleGap * 1.18
    && middleRingGap > ringPinkyGap * 1.18;
  return fingersExtended && groupedPairs && splitCenter;
}

function isOpenPalm(hand) {
  const landmarks = hand.landmarks;
  const wrist = landmarks[0];
  const extended = (tip, pip) => distance2d(wrist, landmarks[tip]) > distance2d(wrist, landmarks[pip]) * 1.12;
  return [extended(8, 6), extended(12, 10), extended(16, 14), extended(20, 18)]
    .filter(Boolean).length >= 3;
}

function setPresentationLock(locked) {
  presentationLocked = locked;
  resetGestureState();
  if (locked) {
    lockRestoreState = {
      autoRotate: autoRotateEnabled,
      animationRunning: Boolean(animationAction?.isRunning() && !animationAction.paused)
    };
    autoRotateEnabled = false;
    if (animationAction) animationAction.paused = true;
    modelVelocity.set(0, 0, 0);
    lockedModelDistanceMeters = null;
    lockedPersonDistanceMeters = null;
    controls.enabled = false;
    resetButton.disabled = true;
    wireframeButton.disabled = true;
    rotationButton.disabled = true;
    animationButton.disabled = true;
    gestureButton.disabled = true;
    gestureStatus.textContent = 'Spock kilidi: model ve kontroller sabitlendi';
  } else {
    controls.enabled = true;
    resetButton.disabled = false;
    wireframeButton.disabled = false;
    rotationButton.disabled = false;
    animationButton.disabled = !animationAction;
    gestureButton.disabled = false;
    autoRotateEnabled = Boolean(lockRestoreState?.autoRotate);
    if (animationAction && lockRestoreState?.animationRunning) animationAction.paused = false;
    gestureStatus.textContent = gestureEnabled ? 'Spock kilidi açıldı; jestler etkin.' : 'Spock kilidi açıldı.';
    lockRestoreState = null;
  }
}

function updateSpockLock(hands) {
  const candidate = hands.some(isSpockGesture);
  const now = performance.now();
  if (!candidate) {
    spockEvidence = Math.max(0, spockEvidence - 1);
    if (!spockReleasedAt) spockReleasedAt = now;
    if (now - spockReleasedAt >= SPOCK_RELEASE_MS) {
      spockLatched = false;
      spockEvidence = 0;
    }
    if (spockEvidence === 0 && gestureMode === 'idle') {
      gestureStatus.textContent = presentationLocked
        ? 'Sunum kilidi açık: model sabit, el kontrolleri kapalı.'
        : (gestureEnabled ? 'Jest: el bekleniyor' : 'Jest kontrolü kapalı.');
    }
    return false;
  }
  spockReleasedAt = 0;
  if (!spockLatched) spockEvidence = Math.min(SPOCK_REQUIRED_EVIDENCE, spockEvidence + 1);
  if (!spockLatched && spockEvidence >= SPOCK_REQUIRED_EVIDENCE && model) {
    spockLatched = true;
    setPresentationLock(!presentationLocked);
  } else if (!spockLatched) {
    gestureStatus.textContent = `Kilitleme hareketini sabit tutun… ${Math.round(spockEvidence / SPOCK_REQUIRED_EVIDENCE * 100)}%`;
  }
  return true;
}

function dragModel(deltaX, deltaY) {
  const cameraDistance = camera.position.distanceTo(controls.target);
  const viewHeight = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * cameraDistance;
  const viewWidth = viewHeight * camera.aspect;
  const cameraRight = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
  const cameraUp = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
  model.position.add(cameraRight.multiplyScalar(deltaX * viewWidth));
  model.position.add(cameraUp.multiplyScalar(-deltaY * viewHeight));
}

function applyBlowSignal(tracking) {
  if (!model || !tracking.facePresent || !tracking.pose?.[0]) {
    blowFrames = 0;
    return;
  }

  if (tracking.blowScore < BLOW_RELEASE_SCORE) blowLatched = false;
  blowFrames = tracking.blowScore >= BLOW_TRIGGER_SCORE ? blowFrames + 1 : 0;
  const now = performance.now();
  if (blowFrames < BLOW_REQUIRED_FRAMES || blowLatched || now - lastBlowAt < BLOW_COOLDOWN_MS) return;
  blowFrames = 0;
  blowLatched = true;

  const modelCenter = new THREE.Box3().setFromObject(model).getCenter(new THREE.Vector3());
  const projected = modelCenter.clone().project(camera);
  const modelScreen = { x: (projected.x + 1) / 2, y: (1 - projected.y) / 2 };
  const nose = tracking.pose[0];
  let deltaX = modelScreen.x - nose.x;
  let deltaY = modelScreen.y - nose.y;
  const screenDistance = Math.hypot(deltaX, deltaY);
  if (screenDistance > 0.42 || projected.z < -1 || projected.z > 1) {
    gestureStatus.textContent = 'Üfleme algılandı; model yüzünüze yeterince yakın değil.';
    return;
  }

  if (screenDistance < 0.03) {
    deltaX = 0.22;
    deltaY = -0.05;
  }
  const cameraRight = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
  const cameraUp = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
  const direction = cameraRight.multiplyScalar(deltaX)
    .add(cameraUp.multiplyScalar(-deltaY))
    .normalize();
  const impulse = Math.max(modelRadius, 0.1) * 2.1;
  modelVelocity.addScaledVector(direction, impulse);
  const maxSpeed = Math.max(modelRadius, 0.1) * 3.2;
  if (modelVelocity.length() > maxSpeed) modelVelocity.setLength(maxSpeed);
  lastBlowAt = now;
  gestureStatus.textContent = 'Üfleme algılandı: model itildi';
}

function applyGestureFrame(hands) {
  if (!gestureEnabled || !model) return;

  if (hands.length === 1) {
    const pinch = pinchMeasurement(hands[0]);
    const fingersPinching = pinchActive
      ? pinch.ratio < PINCH_RELEASE_RATIO
      : pinch.ratio < PINCH_START_RATIO;

    if (pinchActive && !fingersPinching) {
      pinchReleaseFrames += 1;
      if (pinchReleaseFrames >= PINCH_RELEASE_FRAMES) resetGestureState();
      return;
    } else if (!pinchActive && fingersPinching) {
      pinchCandidateFrames += 1;
      if (!pinchTouchesModel(pinch.center)) {
        pinchCandidateFrames = 0;
        gestureMode = 'idle';
        gestureStatus.textContent = 'Tutmak için modelin üzerinde pinch yapın.';
        return;
      }
      gestureStatus.textContent = `Model tutuluyor… ${Math.round(pinchCandidateFrames / PINCH_CONFIRM_FRAMES * 100)}%`;
      if (pinchCandidateFrames < PINCH_CONFIRM_FRAMES) return;
      pinchActive = true;
      pinchReleaseFrames = 0;
    } else if (!pinchActive) {
      pinchCandidateFrames = 0;
    }

    if (pinchActive) {
      pinchReleaseFrames = 0;
      const center = smoothCenter(pinch.center, 0);
      if (gestureMode !== 'drag') {
        resetGestureState();
        pinchActive = true;
        gestureMode = 'drag';
        smoothedCenters[0] = center;
        previousPinchCenter = center;
        gestureStatus.textContent = 'Jest: model tutuldu; sürükleyin';
        return;
      }

      let deltaX = center.x - previousPinchCenter.x;
      let deltaY = center.y - previousPinchCenter.y;
      previousPinchCenter = center;
      if (Math.abs(deltaX) < DRAG_DEAD_ZONE) deltaX = 0;
      if (Math.abs(deltaY) < DRAG_DEAD_ZONE) deltaY = 0;
      deltaX = THREE.MathUtils.clamp(deltaX, -MAX_DRAG_DELTA, MAX_DRAG_DELTA);
      deltaY = THREE.MathUtils.clamp(deltaY, -MAX_DRAG_DELTA, MAX_DRAG_DELTA);
      dragModel(deltaX, deltaY);
      return;
    }

    if (!isOpenPalm(hands[0])) {
      if (gestureMode !== 'idle') resetGestureState();
      gestureStatus.textContent = 'Jest: pinch ile tutun veya açık avuçla döndürün.';
      return;
    }

    const center = smoothCenter(palmCenter(hands[0]), 0);
    if (gestureMode !== 'rotate') {
      resetGestureState();
      gestureMode = 'rotate';
      smoothedCenters[0] = center;
      previousSingleCenter = center;
      gestureStatus.textContent = 'Jest: tek elle döndürme';
      return;
    }

    let deltaX = center.x - previousSingleCenter.x;
    let deltaY = center.y - previousSingleCenter.y;
    previousSingleCenter = center;
    if (Math.abs(deltaX) < ROTATION_DEAD_ZONE) deltaX = 0;
    if (Math.abs(deltaY) < ROTATION_DEAD_ZONE) deltaY = 0;
    deltaX = THREE.MathUtils.clamp(deltaX, -MAX_ROTATION_DELTA, MAX_ROTATION_DELTA);
    deltaY = THREE.MathUtils.clamp(deltaY, -MAX_ROTATION_DELTA, MAX_ROTATION_DELTA);
    model.rotateOnWorldAxis(new THREE.Vector3(0, 1, 0), deltaX * ROTATION_SPEED);
    model.rotateX(deltaY * ROTATION_SPEED);
    return;
  }

  if (hands.length >= 2) {
    const orderedHands = [...hands].sort((a, b) => a.handedness.localeCompare(b.handedness));
    const first = smoothCenter(palmCenter(orderedHands[0]), 0);
    const second = smoothCenter(palmCenter(orderedHands[1]), 1);
    const distance = Math.hypot(second.x - first.x, second.y - first.y);

    if (gestureMode !== 'zoom') {
      resetGestureState();
      gestureMode = 'zoom';
      smoothedCenters = [first, second];
      previousTwoHandDistance = distance;
      gestureStatus.textContent = 'Jest: iki elle yakınlaştırma';
      return;
    }

    if (previousTwoHandDistance > 0 && distance > 0) {
      let logDelta = Math.log(distance / previousTwoHandDistance);
      previousTwoHandDistance = distance;
      if (Math.abs(logDelta) < ZOOM_DEAD_ZONE) logDelta = 0;
      logDelta = THREE.MathUtils.clamp(logDelta, -MAX_ZOOM_LOG_DELTA, MAX_ZOOM_LOG_DELTA);

      const offset = camera.position.clone().sub(controls.target);
      const currentDistance = offset.length();
      const nextDistance = THREE.MathUtils.clamp(
        currentDistance * Math.exp(-logDelta * 2.2),
        controls.minDistance,
        controls.maxDistance
      );
      if (currentDistance > 0) {
        camera.position.copy(controls.target).add(offset.multiplyScalar(nextDistance / currentDistance));
        controls.update();
      }
    }
    return;
  }

  if (gestureMode !== 'idle') {
    resetGestureState();
    gestureStatus.textContent = 'Jest: el bekleniyor';
  }
}

function modelStats(root) {
  let meshes = 0;
  let triangles = 0;
  root.traverse((object) => {
    if (!object.isMesh) return;
    meshes += 1;
    const geometry = object.geometry;
    triangles += geometry.index ? geometry.index.count / 3 : geometry.attributes.position.count / 3;
  });
  return { meshes, triangles: Math.round(triangles) };
}

async function loadModelFile(file) {
  const extension = file.name.toLowerCase().split('.').pop();
  if (!['glb', 'stl', 'obj'].includes(extension)) {
    modelStatus.textContent = 'Desteklenen formatlar: GLB, STL ve tek dosyalı OBJ.';
    window.dispatchEvent(new Event('model-load-finished'));
    return;
  }

  modelStatus.textContent = `${file.name} yükleniyor…`;
  setControlsEnabled(false);
  const objectUrl = URL.createObjectURL(file);

  try {
    let loadedModel;
    let animations = [];

    if (extension === 'glb') {
      const gltf = await loader.loadAsync(objectUrl);
      loadedModel = gltf.scene;
      animations = gltf.animations;
    } else if (extension === 'stl') {
      const geometry = await stlLoader.loadAsync(objectUrl);
      geometry.computeBoundingBox();
      if (!geometry.attributes.position || geometry.attributes.position.count < 3 || geometry.boundingBox?.isEmpty()) {
        geometry.dispose();
        throw new Error('STL dosyasında görüntülenebilir üçgen geometrisi bulunamadı');
      }

      // CAD exports can use very large world coordinates. Centering avoids GPU
      // precision loss while preserving the part's dimensions and orientation.
      geometry.center();
      geometry.computeVertexNormals();
      loadedModel = new THREE.Mesh(
        geometry,
        new THREE.MeshStandardMaterial({
          color: 0xb8c2d8,
          metalness: 0.55,
          roughness: 0.38,
          side: THREE.DoubleSide,
          vertexColors: Boolean(geometry.hasColors),
          transparent: Boolean(geometry.hasColors && geometry.alpha < 1),
          opacity: geometry.hasColors ? geometry.alpha : 1
        })
      );
    } else {
      loadedModel = await objLoader.loadAsync(objectUrl);
    }

    removeCurrentModel();
    model = loadedModel;
    baseModelQuaternion = model.quaternion.clone();
    baseModelPosition = model.position.clone();
    scene.add(model);
    fitCameraToModel();

    if (animations.length > 0) {
      mixer = new THREE.AnimationMixer(model);
      animationAction = mixer.clipAction(animations[0]);
    }

    const stats = modelStats(model);
    const size = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3());
    const dimensions = [size.x, size.y, size.z].map((value) => Number(value.toPrecision(4))).join(' × ');
    modelStatus.textContent = `${file.name} · ${stats.meshes} parça · ${stats.triangles.toLocaleString('tr-TR')} üçgen · ${dimensions} birim`;
    setControlsEnabled(true, Boolean(animationAction));
  } catch (error) {
    removeCurrentModel();
    modelStatus.textContent = `Model yüklenemedi: ${error.message}`;
  } finally {
    URL.revokeObjectURL(objectUrl);
    window.dispatchEvent(new Event('model-load-finished'));
  }
}

function resize() {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (canvas.width !== width || canvas.height !== height) renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

function render() {
  resize();
  const delta = Math.min(clock.getDelta(), 0.1);
  mixer?.update(delta);
  if (model && modelVelocity.lengthSq() > 0.000001) {
    model.position.addScaledVector(modelVelocity, delta);
    modelVelocity.multiplyScalar(Math.exp(-1.8 * delta));
    if (modelVelocity.length() < modelRadius * 0.015) modelVelocity.set(0, 0, 0);
  }
  controls.autoRotate = autoRotateEnabled;
  controls.update(delta);
  renderer.render(scene, camera);
  requestAnimationFrame(render);
}

resetButton.addEventListener('click', () => {
  if (model && baseModelQuaternion) model.quaternion.copy(baseModelQuaternion);
  if (model && baseModelPosition) model.position.copy(baseModelPosition);
  modelVelocity.set(0, 0, 0);
  resetGestureState();
  if (gestureEnabled) gestureStatus.textContent = 'Jest: el bekleniyor';
  fitCameraToModel();
});
wireframeButton.addEventListener('click', () => {
  wireframeEnabled = !wireframeEnabled;
  model?.traverse((object) => {
    if (!object.isMesh) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    materials.forEach((material) => { material.wireframe = wireframeEnabled; });
  });
  wireframeButton.textContent = `Tel kafes: ${wireframeEnabled ? 'açık' : 'kapalı'}`;
});

rotationButton.addEventListener('click', () => {
  autoRotateEnabled = !autoRotateEnabled;
  rotationButton.textContent = `Otomatik döndür: ${autoRotateEnabled ? 'açık' : 'kapalı'}`;
});

animationButton.addEventListener('click', () => {
  if (!animationAction) return;
  if (animationAction.isRunning()) {
    animationAction.paused = true;
    animationButton.textContent = 'Animasyonu oynat';
  } else {
    animationAction.paused = false;
    animationAction.play();
    animationButton.textContent = 'Animasyonu duraklat';
  }
});

gestureButton.addEventListener('click', () => {
  gestureEnabled = !gestureEnabled;
  resetGestureState();
  gestureButton.textContent = `El kontrolü: ${gestureEnabled ? 'açık' : 'kapalı'}`;
  gestureStatus.textContent = gestureEnabled ? 'Jest: el bekleniyor' : 'Jest kontrolü kapalı.';
});

window.addEventListener('hand-landmarks', (event) => {
  const spockCandidate = updateSpockLock(event.detail.hands);
  if (Number.isFinite(event.detail.personDistanceMeters)) {
    smoothedPersonDistanceMeters = smoothedPersonDistanceMeters === null
      ? event.detail.personDistanceMeters
      : THREE.MathUtils.lerp(smoothedPersonDistanceMeters, event.detail.personDistanceMeters, 0.22);
  }
  if (presentationLocked && lockedModelDistanceMeters === null
      && Number.isFinite(smoothedPersonDistanceMeters)) {
    lockedPersonDistanceMeters = smoothedPersonDistanceMeters;
    lockedModelDistanceMeters = Math.max(0.12, smoothedPersonDistanceMeters - 0.3);
  }
  if (!presentationLocked) {
    personIsInFront = false;
  } else if (Number.isFinite(lockedModelDistanceMeters)
      && Number.isFinite(smoothedPersonDistanceMeters)) {
    const adaptiveThreshold = lockedPersonDistanceMeters * 0.86;
    const enterThreshold = Math.max(lockedModelDistanceMeters + 0.05, adaptiveThreshold);
    const leaveThreshold = enterThreshold + 0.09;
    personIsInFront = personIsInFront
      ? smoothedPersonDistanceMeters < leaveThreshold
      : smoothedPersonDistanceMeters < enterThreshold;
  }
  const personInFront = presentationLocked
    && Number.isFinite(lockedModelDistanceMeters)
    && personIsInFront;
  const pose = event.detail.pose ?? [];
  const shoulderDepth = pose.length > 12 ? (pose[11].z + pose[12].z) / 2 : null;
  const visibleWrists = [pose[15], pose[16]].filter((point) => point?.visibility > 0.45);
  const handInFront = presentationLocked && Number.isFinite(shoulderDepth)
    && visibleWrists.some((wrist) => wrist.z < shoulderDepth - 0.1);
  window.dispatchEvent(new CustomEvent('person-occlusion', {
    detail: {
      ...event.detail,
      personInFront,
      personDistanceMeters: smoothedPersonDistanceMeters,
      modelDistanceMeters: lockedModelDistanceMeters,
      handInFront
    }
  }));
  if (spockCandidate || presentationLocked) return;
  applyGestureFrame(event.detail.hands);
  applyBlowSignal(event.detail);
});

setControlsEnabled(false);
modelStatus.textContent = '3B yükleyici hazır. GLB, STL veya OBJ dosyası seçin.';
window.addEventListener('model-file-selected', (event) => {
  void loadModelFile(event.detail.file);
});
render();
