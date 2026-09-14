import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { DEFAULT_PRINT_SETTINGS, sliceToGcode } from './gcode.js';
import { describeAction, interpretLocally } from './ai-commands.js';

const canvas = document.querySelector('#scene');
const modelStatus = document.querySelector('#model-status');
const resetButton = document.querySelector('#reset-view');
const wireframeButton = document.querySelector('#toggle-wireframe');
const rotationButton = document.querySelector('#toggle-rotation');
const animationButton = document.querySelector('#toggle-animation');
const gestureButton = document.querySelector('#toggle-gestures');
const gestureStatus = document.querySelector('#gesture-status');
const videoElement = document.querySelector('#camera');
const modelList = document.querySelector('#model-list');
const modelCount = document.querySelector('#model-count');

const sizePill = document.querySelector('#model-size-pill');
const scalePill = document.querySelector('#model-scale-pill');
const depthPill = document.querySelector('#model-depth-pill');
const unitSelect = document.querySelector('#model-unit');
const scaleInput = document.querySelector('#scale-input');
const scaleDownButton = document.querySelector('#scale-down');
const scaleUpButton = document.querySelector('#scale-up');
const scaleResetButton = document.querySelector('#scale-reset');
const twoHandModeButton = document.querySelector('#two-hand-mode');
const dimensionReadout = document.querySelector('#dimension-readout');

const explodeSlider = document.querySelector('#explode-slider');
const explodeValue = document.querySelector('#explode-value');
const assembleButton = document.querySelector('#assemble-model');

const gcodeButton = document.querySelector('#export-gcode');
const gcodeStatus = document.querySelector('#gcode-status');
const gcodeLayerHeight = document.querySelector('#gcode-layer-height');
const gcodeNozzle = document.querySelector('#gcode-nozzle');
const gcodeFilament = document.querySelector('#gcode-filament');
const gcodeNozzleTemp = document.querySelector('#gcode-nozzle-temp');
const gcodeBedTemp = document.querySelector('#gcode-bed-temp');
const gcodeBedWidth = document.querySelector('#gcode-bed-width');
const gcodeBedDepth = document.querySelector('#gcode-bed-depth');
const gcodeBedHeight = document.querySelector('#gcode-bed-height');
const gcodeSpeed = document.querySelector('#gcode-speed');

const aiLog = document.querySelector('#ai-log');
const aiInput = document.querySelector('#ai-input');
const aiSend = document.querySelector('#ai-send');
const aiStatus = document.querySelector('#ai-status');
const aiChips = [...document.querySelectorAll('.ai-chip')];

// Shared with boot.js so the occlusion compositor can read live depth without a
// DOM event per animation frame.
const sharedState = (window.__BYEZA__ = window.__BYEZA__ ?? {});
sharedState.modelDepthMeters = null;
sharedState.personDepthMeters = null;
sharedState.anchored = false;

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
const models = [];
const modelStates = new WeakMap();
const modelMixers = [];
let mixer = null;
let animationAction = null;
let wireframeEnabled = false;
let autoRotateEnabled = false;
let gestureEnabled = false;
let gestureMode = 'idle';
let smoothedCenters = [];
let previousPalmQuaternion = null;
let smoothedPalmQuaternion = null;
let previousTwoHandDistance = null;
let previousPinchCenter = null;
const grabPlane = new THREE.Plane();
const grabWorldPoint = new THREE.Vector3();
const grabOffset = new THREE.Vector3();
let pinchActive = false;
let pinchCandidateFrames = 0;
let pinchReleaseFrames = 0;
let pinchCandidateOnModel = false;
let missingHandFrames = 0;
let smoothedPinchRatio = null;
let baseModelQuaternion = null;
let baseModelPosition = null;
let modelRadius = 1;
const modelVelocity = new THREE.Vector3();
let spockLatched = false;
let smoothedPersonDistanceMeters = null;
let spockReleasedAt = 0;
let spockEvidence = 0;
let fistEvidence = 0;
let fistArmedAt = 0;
let openAfterFistEvidence = 0;
let dustEffect = null;
const hiddenModels = new Set();
let clapEvidence = 0;
let clapLatched = false;
const raycaster = new THREE.Raycaster();

// Spatial anchor ("4B evren"): the model gets a real-world depth and, while
// auto-rotate is on, orbits through that depth so it can pass behind the user.
let anchored = false;
const anchorCenter = new THREE.Vector3();
let anchorDepthMeters = 1.2;
let anchorOrbitRadius = 0;
let metresPerSceneUnit = 1;
let orbitPhase = 0;
let anchorRestoreState = null;

let twoHandMode = 'scale';
let heldHands = [];
let heldHandFrames = 0;
let assistantAvailable = false;
let slicingInProgress = false;

const GESTURE_SMOOTHING = 0.28;
const ZOOM_DEAD_ZONE = 0.008;
const MAX_ZOOM_LOG_DELTA = 0.09;
const PINCH_START_RATIO = 0.62;
const PINCH_RELEASE_RATIO = 0.95;
const PINCH_CONFIRM_FRAMES = 2;
const PINCH_RELEASE_FRAMES = 5;
const HAND_LOST_GRACE_FRAMES = 6;
const HAND_HOLD_FRAMES = 4;
const SPOCK_REQUIRED_EVIDENCE = 5;
const SPOCK_RELEASE_MS = 450;
const FIST_REQUIRED_EVIDENCE = 3;
const OPEN_AFTER_FIST_FRAMES = 2;
const FIST_SEQUENCE_TIMEOUT_MS = 2200;
const CLAP_REQUIRED_EVIDENCE = 2;
const CLAP_DISTANCE_RATIO = 1.45;
const MIN_USER_SCALE = 0.02;
const MAX_USER_SCALE = 50;
const ORBIT_ANGULAR_SPEED = 0.55;
const DEPTH_HYSTERESIS_METRES = 0.06;

const MILLIMETRES_PER_UNIT = new Map([
  ['mm', 1], ['cm', 10], ['m', 1000], ['in', 25.4]
]);

function disposeMaterial(material) {
  for (const value of Object.values(material)) {
    if (value?.isTexture) value.dispose();
  }
  material.dispose();
}

function disposeModel(targetModel) {
  scene.remove(targetModel);
  targetModel.traverse((object) => {
    if (!object.isMesh) return;
    object.geometry?.dispose();
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    materials.filter(Boolean).forEach(disposeMaterial);
  });
}

/* ------------------------------------------------------------------ *
 * Measurements: real-world size and scale percentage
 * ------------------------------------------------------------------ */

function millimetresPerUnitFor(targetModel) {
  const state = modelStates.get(targetModel);
  return MILLIMETRES_PER_UNIT.get(state?.unit ?? 'mm') ?? 1;
}

function formatLength(millimetres) {
  if (!Number.isFinite(millimetres)) return '—';
  if (millimetres >= 1000) return `${(millimetres / 1000).toFixed(3)} m`;
  if (millimetres >= 10) return `${(millimetres / 10).toFixed(2)} cm`;
  return `${millimetres.toFixed(2)} mm`;
}

function currentDimensions(targetModel = model) {
  const state = modelStates.get(targetModel);
  if (!state?.baseSize) return null;
  const factor = state.userScale * millimetresPerUnitFor(targetModel);
  return {
    x: state.baseSize.x * factor,
    y: state.baseSize.y * factor,
    z: state.baseSize.z * factor,
    percent: state.userScale * 100
  };
}

function updateDimensionReadout() {
  const dimensions = currentDimensions();
  const state = modelStates.get(model);
  if (!dimensions || !state) {
    sizePill.hidden = true;
    scalePill.hidden = true;
    if (dimensionReadout) dimensionReadout.textContent = 'Model yüklenince ölçüler burada görünür.';
    return;
  }

  const asText = `${formatLength(dimensions.x)} × ${formatLength(dimensions.y)} × ${formatLength(dimensions.z)}`;

  sizePill.hidden = false;
  sizePill.textContent = asText;
  sizePill.title = `${state.name} · G × Y × D`;
  scalePill.hidden = false;
  scalePill.textContent = `%${dimensions.percent.toFixed(1)}`;
  scalePill.classList.toggle('scale-changed', Math.abs(dimensions.percent - 100) > 0.5);
  scalePill.title = `Orijinal boyutun %${dimensions.percent.toFixed(1)}'i`;

  if (scaleInput && document.activeElement !== scaleInput) {
    scaleInput.value = dimensions.percent.toFixed(1);
  }
  if (unitSelect && unitSelect.value !== state.unit) unitSelect.value = state.unit;

  if (dimensionReadout) {
    const original = {
      x: state.baseSize.x * millimetresPerUnitFor(model),
      y: state.baseSize.y * millimetresPerUnitFor(model),
      z: state.baseSize.z * millimetresPerUnitFor(model)
    };
    const volume = (dimensions.x * dimensions.y * dimensions.z) / 1000;
    dimensionReadout.replaceChildren();
    const rows = [
      ['Genişlik (X)', formatLength(dimensions.x), formatLength(original.x)],
      ['Yükseklik (Y)', formatLength(dimensions.y), formatLength(original.y)],
      ['Derinlik (Z)', formatLength(dimensions.z), formatLength(original.z)],
      ['Kutu hacmi', `${volume.toFixed(1)} cm³`, `${((original.x * original.y * original.z) / 1000).toFixed(1)} cm³`]
    ];
    for (const [label, value, base] of rows) {
      const row = document.createElement('div');
      row.className = 'dimension-row';
      const key = document.createElement('span');
      key.textContent = label;
      const now = document.createElement('strong');
      now.textContent = value;
      const before = document.createElement('small');
      before.textContent = `orijinal ${base}`;
      row.append(key, now, before);
      dimensionReadout.append(row);
    }
  }
}

function applyUserScale(targetModel, nextScale) {
  const state = modelStates.get(targetModel);
  if (!state) return;
  state.userScale = THREE.MathUtils.clamp(nextScale, MIN_USER_SCALE, MAX_USER_SCALE);
  targetModel.scale.copy(state.baseScale).multiplyScalar(state.userScale);
  targetModel.updateMatrixWorld(true);
  const sphere = new THREE.Box3().setFromObject(targetModel).getBoundingSphere(new THREE.Sphere());
  if (Number.isFinite(sphere.radius) && sphere.radius > 0 && targetModel === model) {
    modelRadius = sphere.radius;
  }
  if (targetModel === model) updateDimensionReadout();
}

function setModelScale(nextScale, { announce = true } = {}) {
  if (!model) return;
  applyUserScale(model, nextScale);
  const dimensions = currentDimensions();
  if (announce && dimensions) {
    modelStatus.textContent = `Ölçek %${dimensions.percent.toFixed(1)} · ${formatLength(dimensions.x)} × ${formatLength(dimensions.y)} × ${formatLength(dimensions.z)}`;
  }
}

function multiplyModelScale(factor, options) {
  const state = modelStates.get(model);
  if (!state) return;
  setModelScale(state.userScale * factor, options);
}

/* ------------------------------------------------------------------ *
 * Exploded view
 * ------------------------------------------------------------------ */

function prepareExplodeData(targetModel) {
  targetModel.updateMatrixWorld(true);
  const centre = new THREE.Box3().setFromObject(targetModel).getCenter(new THREE.Vector3());
  const parts = [];
  targetModel.traverse((object) => {
    if (!object.isMesh || !object.geometry) return;
    object.geometry.computeBoundingBox();
    const partCentre = object.geometry.boundingBox.getCenter(new THREE.Vector3())
      .applyMatrix4(object.matrixWorld);
    const direction = partCentre.clone().sub(centre);
    if (direction.lengthSq() < 1e-8) direction.set(0, 1, 0);
    direction.normalize();
    const parent = object.parent ?? targetModel;
    // Express the world-space push direction in the mesh's own parent space so
    // nested rigs explode outwards rather than along the parent's axes.
    const localFrom = parent.worldToLocal(partCentre.clone());
    const localTo = parent.worldToLocal(partCentre.clone().add(direction));
    const localDirection = localTo.sub(localFrom);
    object.userData.explodeBasePosition = object.position.clone();
    object.userData.explodeDirection = localDirection;
    parts.push(object);
  });
  // Spread is measured once, while the model is still assembled, and stored in
  // local units so it neither drifts as parts move nor changes with user scale.
  const worldDiagonal = new THREE.Box3().setFromObject(targetModel)
    .getSize(new THREE.Vector3()).length();
  const worldScale = targetModel.getWorldScale(new THREE.Vector3());
  const largestAxis = Math.max(Math.abs(worldScale.x), Math.abs(worldScale.y), Math.abs(worldScale.z), 1e-6);
  return { parts, spread: (worldDiagonal / largestAxis) * 0.45 };
}

function applyExplode(factor) {
  const state = modelStates.get(model);
  if (!state?.parts?.length) return;
  const spread = state.explodeSpread ?? 0;
  for (const part of state.parts) {
    const base = part.userData.explodeBasePosition;
    const direction = part.userData.explodeDirection;
    if (!base || !direction) continue;
    part.position.copy(base).addScaledVector(direction, spread * factor);
  }
  state.explode = factor;
  if (explodeSlider) explodeSlider.value = String(Math.round(factor * 100));
  if (explodeValue) explodeValue.textContent = `%${Math.round(factor * 100)}`;
}

function setExplode(factor) {
  const state = modelStates.get(model);
  if (!state) return;
  if (!state.parts?.length || state.parts.length < 2) {
    if (explodeSlider) explodeSlider.value = '0';
    if (explodeValue) explodeValue.textContent = 'tek parça';
    modelStatus.textContent = `${state.name} tek gövdeli bir mesh; ayrılabilecek parça yok.`;
    return;
  }
  applyExplode(THREE.MathUtils.clamp(factor, 0, 1));
}

/* ------------------------------------------------------------------ *
 * Model lifecycle
 * ------------------------------------------------------------------ */

function activateModel(nextModel) {
  if (!nextModel) return;
  model = nextModel;
  const state = modelStates.get(model);
  baseModelQuaternion = state?.quaternion?.clone() ?? model.quaternion.clone();
  baseModelPosition = state?.position?.clone() ?? model.position.clone();
  mixer = state?.mixer ?? null;
  animationAction = state?.animationAction ?? null;
  const sphere = new THREE.Box3().setFromObject(model).getBoundingSphere(new THREE.Sphere());
  if (Number.isFinite(sphere.radius) && sphere.radius > 0) modelRadius = sphere.radius;
  if (explodeSlider) explodeSlider.value = String(Math.round((state?.explode ?? 0) * 100));
  if (explodeValue) explodeValue.textContent = `%${Math.round((state?.explode ?? 0) * 100)}`;
  updateDimensionReadout();
  renderModelList();
}

function describeModel(targetModel) {
  const state = modelStates.get(targetModel);
  const parts = state?.stats?.meshes ?? 0;
  const triangles = state?.stats?.triangles ?? 0;
  const percent = state?.userScale ? ` · %${(state.userScale * 100).toFixed(0)}` : '';
  return `${parts} parça · ${triangles.toLocaleString('tr-TR')} üçgen${percent}`;
}

function renderModelList() {
  modelCount.textContent = String(models.length);
  modelList.replaceChildren();
  if (models.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-list';
    empty.textContent = 'Eklediğin modeller burada listelenecek.';
    modelList.append(empty);
    return;
  }

  models.forEach((candidate) => {
    const state = modelStates.get(candidate);
    const row = document.createElement('div');
    row.className = 'model-row';

    const selectButton = document.createElement('button');
    selectButton.type = 'button';
    selectButton.className = `model-select${candidate === model ? ' active' : ''}`;
    selectButton.setAttribute('aria-pressed', String(candidate === model));
    selectButton.title = `${state?.name ?? 'Model'} modelini etkinleştir`;
    const thumbnail = document.createElement('span');
    thumbnail.className = 'model-thumbnail';
    thumbnail.textContent = (state?.extension ?? '3d').toUpperCase();
    const copy = document.createElement('span');
    copy.className = 'model-copy';
    const name = document.createElement('strong');
    name.textContent = state?.name ?? 'İsimsiz model';
    const details = document.createElement('small');
    details.textContent = describeModel(candidate);
    copy.append(name, details);
    selectButton.append(thumbnail, copy);
    selectButton.addEventListener('click', () => selectModel(candidate));

    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'model-remove';
    removeButton.textContent = '×';
    removeButton.title = `${state?.name ?? 'Model'} modelini sahneden kaldır`;
    removeButton.setAttribute('aria-label', `${state?.name ?? 'Model'} modelini kaldır`);
    removeButton.addEventListener('click', () => removeModel(candidate));
    row.append(selectButton, removeButton);
    modelList.append(row);
  });
}

function selectModel(nextModel) {
  if (!models.includes(nextModel)) return;
  if (anchored) setSpatialAnchor(false);
  activateModel(nextModel);
  resetGestureState();
  setControlsEnabled(true, Boolean(animationAction));
  fitCameraToModel();
  const state = modelStates.get(nextModel);
  modelStatus.textContent = `${state?.name ?? 'Model'} etkin · ${models.length} model sahnede`;
}

function removeModel(targetModel) {
  const removalIndex = models.indexOf(targetModel);
  if (removalIndex < 0) return;
  const state = modelStates.get(targetModel);
  const wasActive = targetModel === model;
  if (wasActive && anchored) setSpatialAnchor(false);
  if (wasActive) clearDustEffect();
  hiddenModels.delete(targetModel);
  if (state?.mixer) {
    state.mixer.stopAllAction();
    const mixerIndex = modelMixers.indexOf(state.mixer);
    if (mixerIndex >= 0) modelMixers.splice(mixerIndex, 1);
  }
  disposeModel(targetModel);
  models.splice(removalIndex, 1);
  modelStates.delete(targetModel);

  if (models.length === 0) {
    model = null;
    mixer = null;
    animationAction = null;
    baseModelQuaternion = null;
    baseModelPosition = null;
    modelVelocity.set(0, 0, 0);
    document.querySelector('#viewport').classList.remove('model-active');
    setControlsEnabled(false);
    updateDimensionReadout();
    modelStatus.textContent = `${state?.name ?? 'Model'} kaldırıldı. Sahne boş.`;
  } else {
    if (wasActive) activateModel(models[Math.min(removalIndex, models.length - 1)]);
    setControlsEnabled(true, Boolean(animationAction));
    resetGestureState();
    fitCameraToModels();
    modelStatus.textContent = `${state?.name ?? 'Model'} kaldırıldı · ${models.length} model kaldı`;
  }
  renderModelList();
}

function fitCameraToModels() {
  const visibleModels = models.filter((candidate) => candidate.visible);
  if (visibleModels.length === 0) return;
  const box = visibleModels.reduce(
    (combined, candidate) => combined.union(new THREE.Box3().setFromObject(candidate)),
    new THREE.Box3()
  );
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  if (!Number.isFinite(sphere.radius) || sphere.radius === 0) return;
  const distance = sphere.radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2));
  controls.target.copy(sphere.center);
  camera.position.copy(sphere.center).add(new THREE.Vector3(0.25, 0.18, 1).normalize().multiplyScalar(distance * 1.12));
  camera.near = Math.max(sphere.radius / 100, 0.001);
  camera.far = Math.max(sphere.radius * 100, 100);
  camera.updateProjectionMatrix();
  controls.minDistance = sphere.radius * 0.12;
  controls.maxDistance = sphere.radius * 14;
  controls.update();
  controls.saveState();
}

function placeModelBesideExisting(nextModel) {
  if (models.length === 0) return;
  const existingBox = models.reduce(
    (combined, candidate) => combined.union(new THREE.Box3().setFromObject(candidate)),
    new THREE.Box3()
  );
  const nextBox = new THREE.Box3().setFromObject(nextModel);
  const nextSize = nextBox.getSize(new THREE.Vector3());
  const gap = Math.max(existingBox.getSize(new THREE.Vector3()).y, nextSize.y) * 0.18;
  nextModel.position.x += existingBox.max.x - nextBox.min.x + gap;
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
  for (const element of [scaleInput, scaleDownButton, scaleUpButton, scaleResetButton, unitSelect, explodeSlider, assembleButton, gcodeButton]) {
    if (element) element.disabled = !enabled;
  }
  if (gcodeButton && slicingInProgress) gcodeButton.disabled = true;
  if (!enabled) {
    gestureEnabled = false;
    gestureButton.classList.remove('is-on');
    gestureButton.setAttribute('aria-pressed', 'false');
    gestureStatus.textContent = 'Jest kontrolü için önce model yükleyin.';
    resetGestureState();
  } else {
    gestureStatus.textContent = gestureEnabled ? 'Jest: el bekleniyor' : 'El kontrolünü açarak jestleri etkinleştirin.';
  }
}

function resetGestureState() {
  gestureMode = 'idle';
  smoothedCenters = [];
  previousPalmQuaternion = null;
  smoothedPalmQuaternion = null;
  previousTwoHandDistance = null;
  previousPinchCenter = null;
  pinchActive = false;
  pinchCandidateFrames = 0;
  pinchReleaseFrames = 0;
  pinchCandidateOnModel = false;
  missingHandFrames = 0;
  smoothedPinchRatio = null;
}

/* ------------------------------------------------------------------ *
 * Hand analysis
 * ------------------------------------------------------------------ */

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

/**
 * Carry the last good hands forward for a few frames. MediaPipe occasionally
 * drops a hand that is plainly visible, and without this the gesture state
 * machine resets mid-motion.
 */
function holdHands(hands) {
  if (hands.length > 0) {
    heldHands = hands;
    heldHandFrames = 0;
    return hands;
  }
  if (heldHands.length > 0 && heldHandFrames < HAND_HOLD_FRAMES) {
    heldHandFrames += 1;
    return heldHands;
  }
  heldHands = [];
  return hands;
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

function pinchHitModel(center) {
  const ndc = landmarkToNdc(center);
  if (!ndc || models.length === 0) return null;
  const toleranceX = 42 / Math.max(canvas.clientWidth, 1) * 2;
  const toleranceY = 42 / Math.max(canvas.clientHeight, 1) * 2;
  const samples = [
    [0, 0], [toleranceX, 0], [-toleranceX, 0],
    [0, toleranceY], [0, -toleranceY],
    [toleranceX * 0.7, toleranceY * 0.7], [-toleranceX * 0.7, -toleranceY * 0.7]
  ];
  const visible = models.filter((candidate) => candidate.visible);
  for (const [offsetX, offsetY] of samples) {
    raycaster.setFromCamera(new THREE.Vector2(ndc.x + offsetX, ndc.y + offsetY), camera);
    const hit = raycaster.intersectObjects(visible, true)[0];
    if (!hit) continue;
    let root = hit.object;
    while (root.parent && !models.includes(root)) root = root.parent;
    if (models.includes(root)) return { ...hit, root };
  }
  return null;
}

function beginModelGrab(hit, center) {
  activateModel(hit.root);
  grabPlane.setFromNormalAndCoplanarPoint(camera.getWorldDirection(new THREE.Vector3()), hit.point);
  const ndc = landmarkToNdc(center);
  if (!ndc) return false;
  raycaster.setFromCamera(ndc, camera);
  if (!raycaster.ray.intersectPlane(grabPlane, grabWorldPoint)) return false;
  grabOffset.copy(model.position).sub(grabWorldPoint);
  return true;
}

function isSpockGesture(hand) {
  const landmarks = hand.landmarks;
  const wrist = landmarks[0];
  const palmSize = Math.max(distance2d(wrist, landmarks[9]), 0.0001);
  const extended = (tip, pip) => distance2d(wrist, landmarks[tip]) > distance2d(wrist, landmarks[pip]) * 1.06;
  const fingersExtended = extended(8, 6) && extended(12, 10) && extended(16, 14) && extended(20, 18);
  const indexMiddleGap = distance2d(landmarks[8], landmarks[12]) / palmSize;
  const middleRingGap = distance2d(landmarks[12], landmarks[16]) / palmSize;
  const ringPinkyGap = distance2d(landmarks[16], landmarks[20]) / palmSize;
  const groupedPairs = indexMiddleGap < 0.95 && ringPinkyGap < 0.95;
  const splitCenter = middleRingGap > 0.4
    && middleRingGap > indexMiddleGap * 1.15
    && middleRingGap > ringPinkyGap * 1.15;
  return fingersExtended && groupedPairs && splitCenter;
}

function isOpenPalm(hand) {
  const landmarks = hand.landmarks;
  const wrist = landmarks[0];
  const extended = (tip, pip) => distance2d(wrist, landmarks[tip]) > distance2d(wrist, landmarks[pip]) * 1.1;
  return [extended(8, 6), extended(12, 10), extended(16, 14), extended(20, 18)]
    .filter(Boolean).length >= 3;
}

function palmOrientation(hand) {
  const point = (index) => new THREE.Vector3(
    hand.landmarks[index].x,
    -hand.landmarks[index].y,
    -hand.landmarks[index].z * 0.7
  );
  const wrist = point(0);
  const acrossPalm = point(5).sub(point(17)).normalize();
  const towardFingers = point(9).sub(wrist).normalize();
  const palmNormal = new THREE.Vector3().crossVectors(acrossPalm, towardFingers).normalize();
  if (acrossPalm.lengthSq() < 0.5 || towardFingers.lengthSq() < 0.5 || palmNormal.lengthSq() < 0.5) return null;
  const correctedAcross = new THREE.Vector3().crossVectors(towardFingers, palmNormal).normalize();
  return new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().makeBasis(correctedAcross, towardFingers, palmNormal)
  );
}

function isFistGesture(hand) {
  const landmarks = hand.landmarks;
  const wrist = landmarks[0];
  const curled = [[8, 6], [12, 10], [16, 14], [20, 18]].filter(([tip, pip]) =>
    distance2d(wrist, landmarks[tip]) < distance2d(wrist, landmarks[pip]) * 1.08
  ).length;
  const thumbFolded = distance2d(landmarks[4], landmarks[9])
    < distance2d(landmarks[2], landmarks[9]) * 1.15;
  return curled >= 4 && thumbFolded;
}

/* ------------------------------------------------------------------ *
 * Dust / restore effects
 * ------------------------------------------------------------------ */

function clearDustEffect() {
  if (!dustEffect) return;
  scene.remove(dustEffect.points);
  dustEffect.points.geometry.dispose();
  dustEffect.points.material.dispose();
  dustEffect = null;
}

function disintegrateModel() {
  if (!model || !model.visible || dustEffect) return;
  model.updateMatrixWorld(true);
  const samples = [];
  model.traverse((object) => {
    const positions = object.isMesh ? object.geometry?.attributes?.position : null;
    if (!positions) return;
    const stride = Math.max(1, Math.floor(positions.count / 450));
    for (let index = 0; index < positions.count && samples.length < 1800; index += stride) {
      samples.push(new THREE.Vector3().fromBufferAttribute(positions, index).applyMatrix4(object.matrixWorld));
    }
  });
  if (samples.length === 0) return;

  const positionData = new Float32Array(samples.length * 3);
  const velocities = [];
  const center = new THREE.Box3().setFromObject(model).getCenter(new THREE.Vector3());
  samples.forEach((point, index) => {
    positionData.set([point.x, point.y, point.z], index * 3);
    const outward = point.clone().sub(center).normalize();
    velocities.push(outward.multiplyScalar(modelRadius * (0.35 + Math.random() * 0.8)).add(
      new THREE.Vector3((Math.random() - 0.5) * modelRadius * 0.35, Math.random() * modelRadius * 0.7, (Math.random() - 0.5) * modelRadius * 0.35)
    ));
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positionData, 3));
  const material = new THREE.PointsMaterial({
    color: 0xc7d5ff,
    size: Math.max(modelRadius * 0.018, 0.006),
    transparent: true,
    opacity: 1,
    depthWrite: false,
    sizeAttenuation: true
  });
  const points = new THREE.Points(geometry, material);
  scene.add(points);
  model.visible = false;
  hiddenModels.add(model);
  dustEffect = { points, velocities, elapsed: 0, radius: modelRadius };
  gestureStatus.textContent = 'Yumruk açıldı: model toza dönüştü';
}

function restoreHiddenModels() {
  if (hiddenModels.size === 0) return;
  clearDustEffect();
  for (const hiddenModel of hiddenModels) hiddenModel.visible = true;
  const restoredCount = hiddenModels.size;
  hiddenModels.clear();
  fitCameraToModels();
  gestureStatus.textContent = restoredCount > 1
    ? `${restoredCount} model iki el hareketiyle geri geldi`
    : 'Model iki el hareketiyle geri geldi';
}

function updateClapRestore(hands) {
  if (hands.length < 2 || hiddenModels.size === 0) {
    clapEvidence = 0;
    if (hands.length < 2) clapLatched = false;
    return false;
  }
  const firstPalm = palmCenter(hands[0]);
  const secondPalm = palmCenter(hands[1]);
  const firstPalmSize = distance2d(hands[0].landmarks[0], hands[0].landmarks[9]);
  const secondPalmSize = distance2d(hands[1].landmarks[0], hands[1].landmarks[9]);
  const closeTogether = distance2d(firstPalm, secondPalm)
    < Math.max(firstPalmSize, secondPalmSize) * CLAP_DISTANCE_RATIO;
  clapEvidence = closeTogether ? clapEvidence + 1 : 0;
  if (!clapLatched && clapEvidence >= CLAP_REQUIRED_EVIDENCE) {
    clapLatched = true;
    clapEvidence = 0;
    restoreHiddenModels();
    return true;
  }
  return closeTogether;
}

function updateFistSequence(hands) {
  const hand = hands[0];
  const now = performance.now();
  if (!hand || hands.length !== 1 || !model?.visible) {
    fistEvidence = Math.max(0, fistEvidence - 1);
    openAfterFistEvidence = 0;
    return false;
  }
  if (fistArmedAt && now - fistArmedAt > FIST_SEQUENCE_TIMEOUT_MS) fistArmedAt = 0;
  if (!fistArmedAt) {
    fistEvidence = isFistGesture(hand) ? fistEvidence + 1 : Math.max(0, fistEvidence - 1);
    if (fistEvidence >= FIST_REQUIRED_EVIDENCE) {
      fistArmedAt = now;
      fistEvidence = 0;
      gestureStatus.textContent = 'Yumruk algılandı; modeli yok etmek için elinizi açın';
    }
    return isFistGesture(hand);
  }
  openAfterFistEvidence = isOpenPalm(hand) ? openAfterFistEvidence + 1 : 0;
  if (openAfterFistEvidence >= OPEN_AFTER_FIST_FRAMES) {
    fistArmedAt = 0;
    openAfterFistEvidence = 0;
    disintegrateModel();
    return true;
  }
  return true;
}

/* ------------------------------------------------------------------ *
 * Spatial anchor (Spock)
 * ------------------------------------------------------------------ */

function modelDepthMetres() {
  if (!model || !anchored) return null;
  const centre = new THREE.Box3().setFromObject(model).getCenter(new THREE.Vector3());
  return camera.position.distanceTo(centre) * metresPerSceneUnit;
}

function setSpatialAnchor(active) {
  anchored = active;
  sharedState.anchored = active;
  resetGestureState();

  if (active && model) {
    model.updateMatrixWorld(true);
    const centre = new THREE.Box3().setFromObject(model).getCenter(new THREE.Vector3());
    const sceneDistance = Math.max(camera.position.distanceTo(centre), 1e-4);
    // Park the model just in front of where the user is standing so stepping
    // forward genuinely puts them between the camera and the model.
    anchorDepthMeters = Number.isFinite(smoothedPersonDistanceMeters)
      ? THREE.MathUtils.clamp(smoothedPersonDistanceMeters - 0.25, 0.3, 6)
      : 1.2;
    metresPerSceneUnit = anchorDepthMeters / sceneDistance;
    anchorCenter.copy(model.position);
    anchorOrbitRadius = modelRadius * 1.35;
    orbitPhase = 0;
    anchorRestoreState = {
      position: model.position.clone(),
      quaternion: model.quaternion.clone()
    };
    modelVelocity.set(0, 0, 0);
    gestureStatus.textContent = `Uzamsal kilit açık · model ${Math.round(anchorDepthMeters * 100)} cm ötede`;
    if (depthPill) depthPill.hidden = false;
  } else {
    if (anchorRestoreState && model) {
      model.position.copy(anchorRestoreState.position);
      model.quaternion.copy(anchorRestoreState.quaternion);
    }
    anchorRestoreState = null;
    sharedState.modelDepthMeters = null;
    if (depthPill) depthPill.hidden = true;
    gestureStatus.textContent = gestureEnabled ? 'Uzamsal kilit kapandı; jestler etkin.' : 'Uzamsal kilit kapandı.';
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
      gestureStatus.textContent = anchored
        ? `Uzamsal kilit açık · model ${Math.round(anchorDepthMeters * 100)} cm ötede`
        : (gestureEnabled ? 'Jest: el bekleniyor' : 'Jest kontrolü kapalı.');
    }
    return false;
  }
  spockReleasedAt = 0;
  if (!spockLatched) spockEvidence = Math.min(SPOCK_REQUIRED_EVIDENCE, spockEvidence + 1);
  if (!spockLatched && spockEvidence >= SPOCK_REQUIRED_EVIDENCE && model) {
    spockLatched = true;
    setSpatialAnchor(!anchored);
  } else if (!spockLatched) {
    gestureStatus.textContent = `Uzamsal kilit… ${Math.round(spockEvidence / SPOCK_REQUIRED_EVIDENCE * 100)}%`;
  }
  return true;
}

function dragModelTo(center) {
  const ndc = landmarkToNdc(center);
  if (!ndc) return;
  raycaster.setFromCamera(ndc, camera);
  if (raycaster.ray.intersectPlane(grabPlane, grabWorldPoint)) {
    model.position.copy(grabWorldPoint).add(grabOffset);
  }
}

/* ------------------------------------------------------------------ *
 * Gesture frame
 * ------------------------------------------------------------------ */

function applyGestureFrame(rawHands) {
  if (!gestureEnabled || !model) return;
  const hands = holdHands(rawHands);

  if (hands.length === 0) {
    missingHandFrames += 1;
    if (missingHandFrames <= HAND_LOST_GRACE_FRAMES) return;
  } else {
    missingHandFrames = 0;
  }

  if (hands.length === 1) {
    const pinch = pinchMeasurement(hands[0]);
    smoothedPinchRatio = smoothedPinchRatio === null
      ? pinch.ratio
      : THREE.MathUtils.lerp(smoothedPinchRatio, pinch.ratio, 0.45);
    const fingersPinching = pinchActive
      ? smoothedPinchRatio < PINCH_RELEASE_RATIO
      : smoothedPinchRatio < PINCH_START_RATIO;

    if (pinchActive && !fingersPinching) {
      pinchReleaseFrames += 1;
      if (pinchReleaseFrames >= PINCH_RELEASE_FRAMES) resetGestureState();
      return;
    } else if (!pinchActive && fingersPinching) {
      pinchCandidateFrames += 1;
      if (pinchCandidateFrames === 1) {
        const hit = pinchHitModel(pinch.center);
        pinchCandidateOnModel = Boolean(hit && beginModelGrab(hit, pinch.center));
      }
      if (!pinchCandidateOnModel) {
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
      pinchCandidateOnModel = false;
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

      previousPinchCenter = center;
      dragModelTo(center);
      return;
    }

    if (!isOpenPalm(hands[0])) {
      if (gestureMode !== 'idle') resetGestureState();
      gestureStatus.textContent = 'Jest: pinch ile tutun veya açık avuçla döndürün.';
      return;
    }

    const orientation = palmOrientation(hands[0]);
    if (!orientation) return;
    if (gestureMode !== 'rotate') {
      resetGestureState();
      gestureMode = 'rotate';
      previousPalmQuaternion = orientation.clone();
      smoothedPalmQuaternion = orientation.clone();
      gestureStatus.textContent = hands[0].handedness === 'Left'
        ? 'Jest: sol elle hızlı 3 eksenli döndürme'
        : 'Jest: sağ elle hassas 3 eksenli döndürme';
      return;
    }

    smoothedPalmQuaternion.slerp(orientation, 0.34);
    const deltaQuaternion = smoothedPalmQuaternion.clone()
      .multiply(previousPalmQuaternion.clone().invert())
      .normalize();
    previousPalmQuaternion.copy(smoothedPalmQuaternion);
    const deltaEuler = new THREE.Euler().setFromQuaternion(deltaQuaternion, 'XYZ');
    const limit = hands[0].handedness === 'Left' ? 0.095 : 0.045;
    const gain = hands[0].handedness === 'Left' ? 1.65 : 0.58;
    const pitch = THREE.MathUtils.clamp(deltaEuler.x, -limit, limit) * gain;
    const yaw = THREE.MathUtils.clamp(deltaEuler.y, -limit, limit) * gain;
    const roll = THREE.MathUtils.clamp(deltaEuler.z, -limit, limit) * gain;
    const cameraRight = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    const cameraUp = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    const cameraForward = camera.getWorldDirection(new THREE.Vector3());
    model.rotateOnWorldAxis(cameraRight, pitch);
    model.rotateOnWorldAxis(cameraUp, yaw);
    model.rotateOnWorldAxis(cameraForward, roll);
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
      gestureStatus.textContent = twoHandMode === 'scale'
        ? 'Jest: iki elle model boyutu'
        : 'Jest: iki elle kamera yakınlaştırma';
      return;
    }

    if (previousTwoHandDistance > 0 && distance > 0) {
      let logDelta = Math.log(distance / previousTwoHandDistance);
      previousTwoHandDistance = distance;
      if (Math.abs(logDelta) < ZOOM_DEAD_ZONE) logDelta = 0;
      logDelta = THREE.MathUtils.clamp(logDelta, -MAX_ZOOM_LOG_DELTA, MAX_ZOOM_LOG_DELTA);
      if (logDelta === 0) return;

      if (twoHandMode === 'scale') {
        multiplyModelScale(Math.exp(logDelta * 1.8), { announce: false });
        const dimensions = currentDimensions();
        if (dimensions) {
          gestureStatus.textContent = `Boyut %${dimensions.percent.toFixed(0)} · ${formatLength(dimensions.x)} × ${formatLength(dimensions.y)} × ${formatLength(dimensions.z)}`;
        }
      } else {
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
    }
    return;
  }

  if (gestureMode !== 'idle') {
    resetGestureState();
    gestureStatus.textContent = 'Jest: el bekleniyor';
  }
}

/* ------------------------------------------------------------------ *
 * Loading
 * ------------------------------------------------------------------ */

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
  if (models.length === 0) setControlsEnabled(false);
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

    placeModelBesideExisting(loadedModel);
    scene.add(loadedModel);
    document.querySelector('#viewport').classList.add('model-active');
    models.push(loadedModel);
    const stats = modelStats(loadedModel);

    loadedModel.updateMatrixWorld(true);
    const baseSize = new THREE.Box3().setFromObject(loadedModel).getSize(new THREE.Vector3());
    modelStates.set(loadedModel, {
      name: file.name,
      extension,
      stats,
      quaternion: loadedModel.quaternion.clone(),
      position: loadedModel.position.clone(),
      baseScale: loadedModel.scale.clone(),
      baseSize,
      // glTF is metres by convention; STL and OBJ come out of CAD in millimetres.
      unit: extension === 'glb' ? 'm' : 'mm',
      userScale: 1,
      explode: 0,
      ...(() => {
        const { parts, spread } = prepareExplodeData(loadedModel);
        return { parts, explodeSpread: spread };
      })()
    });
    activateModel(loadedModel);
    fitCameraToModels();

    if (animations.length > 0) {
      mixer = new THREE.AnimationMixer(model);
      animationAction = mixer.clipAction(animations[0]);
      modelMixers.push(mixer);
      modelStates.get(model).mixer = mixer;
      modelStates.get(model).animationAction = animationAction;
    } else {
      mixer = null;
      animationAction = null;
    }

    const dimensions = currentDimensions();
    modelStatus.textContent = `${file.name} · ${stats.meshes} parça · ${stats.triangles.toLocaleString('tr-TR')} üçgen · ${formatLength(dimensions.x)} × ${formatLength(dimensions.y)} × ${formatLength(dimensions.z)}`;
    setControlsEnabled(true, Boolean(animationAction));
    renderModelList();
  } catch (error) {
    if (models.length > 0) setControlsEnabled(true, Boolean(animationAction));
    modelStatus.textContent = `Model yüklenemedi: ${error.message}`;
  } finally {
    URL.revokeObjectURL(objectUrl);
    window.dispatchEvent(new Event('model-load-finished'));
  }
}

/* ------------------------------------------------------------------ *
 * Render loop
 * ------------------------------------------------------------------ */

let lastCanvasWidth = 0;
let lastCanvasHeight = 0;
let lastPixelRatio = 0;

function resize() {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const pixelRatio = Math.min(window.devicePixelRatio, 2);
  if (!width || !height) return;
  // Compare against the CSS size we last applied. Comparing canvas.width (device
  // pixels) to clientWidth (CSS pixels) made this call setSize on every single
  // frame at any devicePixelRatio above 1, which is what caused the stutter.
  if (width === lastCanvasWidth && height === lastCanvasHeight && pixelRatio === lastPixelRatio) return;
  lastCanvasWidth = width;
  lastCanvasHeight = height;
  lastPixelRatio = pixelRatio;
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

function updateAnchorOrbit(delta) {
  if (!anchored || !model) {
    if (!anchored) sharedState.modelDepthMeters = null;
    return;
  }

  if (autoRotateEnabled) {
    orbitPhase += delta * ORBIT_ANGULAR_SPEED;
    const forward = camera.getWorldDirection(new THREE.Vector3());
    const right = new THREE.Vector3().crossVectors(forward, camera.up).normalize();
    model.position.copy(anchorCenter)
      .addScaledVector(right, Math.sin(orbitPhase) * anchorOrbitRadius)
      .addScaledVector(forward, Math.cos(orbitPhase) * anchorOrbitRadius);
    model.rotateOnWorldAxis(camera.up, delta * 0.7);
  }

  const depth = modelDepthMetres();
  sharedState.modelDepthMeters = depth;
  if (depthPill && Number.isFinite(depth)) {
    const person = Number.isFinite(smoothedPersonDistanceMeters)
      ? ` · siz ${Math.round(smoothedPersonDistanceMeters * 100)} cm`
      : '';
    depthPill.textContent = `Model ${Math.round(depth * 100)} cm${person}`;
    depthPill.classList.toggle('behind', Number.isFinite(smoothedPersonDistanceMeters)
      && depth > smoothedPersonDistanceMeters + DEPTH_HYSTERESIS_METRES);
  }
}

function render() {
  resize();
  const delta = Math.min(clock.getDelta(), 0.1);
  modelMixers.forEach((currentMixer) => currentMixer.update(delta));
  if (dustEffect) {
    dustEffect.elapsed += delta;
    const positions = dustEffect.points.geometry.attributes.position;
    for (let index = 0; index < positions.count; index += 1) {
      const velocity = dustEffect.velocities[index];
      velocity.y -= dustEffect.radius * 0.32 * delta;
      positions.setXYZ(index, positions.getX(index) + velocity.x * delta, positions.getY(index) + velocity.y * delta, positions.getZ(index) + velocity.z * delta);
    }
    positions.needsUpdate = true;
    dustEffect.points.material.opacity = Math.max(0, 1 - dustEffect.elapsed / 1.8);
    if (dustEffect.elapsed >= 1.8) clearDustEffect();
  }
  if (model && !anchored && modelVelocity.lengthSq() > 0.000001) {
    model.position.addScaledVector(modelVelocity, delta);
    modelVelocity.multiplyScalar(Math.exp(-1.8 * delta));
    if (modelVelocity.length() < modelRadius * 0.015) modelVelocity.set(0, 0, 0);
  }
  updateAnchorOrbit(delta);
  // While anchored, auto-rotate drives the model's orbit instead of the camera.
  controls.autoRotate = autoRotateEnabled && !anchored;
  controls.update(delta);
  renderer.render(scene, camera);
  requestAnimationFrame(render);
}

/* ------------------------------------------------------------------ *
 * G-code export
 * ------------------------------------------------------------------ */

function readPrintSettings() {
  const number = (element, fallback) => {
    const value = Number.parseFloat(element?.value ?? '');
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  const nozzle = number(gcodeNozzle, DEFAULT_PRINT_SETTINGS.nozzleDiameter);
  const layerHeight = number(gcodeLayerHeight, DEFAULT_PRINT_SETTINGS.layerHeight);
  return {
    ...DEFAULT_PRINT_SETTINGS,
    nozzleDiameter: nozzle,
    extrusionWidth: nozzle * 1.05,
    layerHeight,
    firstLayerHeight: Math.min(nozzle * 0.75, layerHeight * 1.4),
    filamentDiameter: number(gcodeFilament, DEFAULT_PRINT_SETTINGS.filamentDiameter),
    nozzleTemperature: Math.round(number(gcodeNozzleTemp, DEFAULT_PRINT_SETTINGS.nozzleTemperature)),
    bedTemperature: Math.round(number(gcodeBedTemp, DEFAULT_PRINT_SETTINGS.bedTemperature)),
    printSpeed: number(gcodeSpeed, DEFAULT_PRINT_SETTINGS.printSpeed),
    firstLayerSpeed: Math.max(10, number(gcodeSpeed, DEFAULT_PRINT_SETTINGS.printSpeed) * 0.5),
    bedWidth: number(gcodeBedWidth, DEFAULT_PRINT_SETTINGS.bedWidth),
    bedDepth: number(gcodeBedDepth, DEFAULT_PRINT_SETTINGS.bedDepth),
    bedHeight: number(gcodeBedHeight, DEFAULT_PRINT_SETTINGS.bedHeight)
  };
}

async function exportGcode() {
  const state = modelStates.get(model);
  if (!model || !state) {
    gcodeStatus.textContent = 'Önce bir model seçin.';
    return;
  }
  if (slicingInProgress) return;

  slicingInProgress = true;
  gcodeButton.disabled = true;
  gcodeStatus.textContent = 'Dilimleniyor… %0';

  // The exploded offsets would be baked into the print, so slice the assembled
  // shape and put the explode factor back afterwards.
  const explodeBefore = state.explode ?? 0;
  if (explodeBefore > 0) applyExplode(0);

  let lastYield = performance.now();
  try {
    const settings = readPrintSettings();
    const result = await sliceToGcode({
      objects: [model],
      millimetresPerUnit: millimetresPerUnitFor(model),
      settings,
      metadata: { name: state.name, scalePercent: state.userScale * 100 },
      onStage: (label) => { gcodeStatus.textContent = `Hazırlanıyor (${label})…`; },
      onProgress: async (ratio) => {
        const now = performance.now();
        if (now - lastYield < 60) return;
        lastYield = now;
        gcodeStatus.textContent = `Dilimleniyor… %${Math.round(ratio * 100)}`;
        // Yield to the compositor so the viewport keeps drawing during a slice.
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    });

    const baseName = state.name.replace(/\.[^.]+$/, '');
    const fileName = `${baseName}-%${Math.round(state.userScale * 100)}.gcode`;
    const saved = await window.desktopApi.saveGcode(result.text, fileName);
    const { width, depth, height } = result.dimensions;
    const fitWarning = result.bedFits ? '' : ' ⚠ Model tablaya sığmıyor.';
    gcodeStatus.textContent = `${result.layers} katman · ${width.toFixed(1)} × ${depth.toFixed(1)} × ${height.toFixed(1)} mm · ${(result.filamentMillimetres / 1000).toFixed(2)} m filament${fitWarning}\nKaydedildi: ${saved.path}`;
  } catch (error) {
    gcodeStatus.textContent = `G-code üretilemedi: ${error.message}`;
  } finally {
    if (explodeBefore > 0) applyExplode(explodeBefore);
    slicingInProgress = false;
    gcodeButton.disabled = !model;
  }
}

/* ------------------------------------------------------------------ *
 * Assistant
 * ------------------------------------------------------------------ */

function eachMaterial(callback, partName = null) {
  if (!model) return 0;
  let touched = 0;
  model.traverse((object) => {
    if (!object.isMesh) return;
    if (partName && !object.name.toLocaleLowerCase('tr').includes(partName.toLocaleLowerCase('tr'))) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    materials.filter(Boolean).forEach((material) => {
      callback(material, object);
      material.needsUpdate = true;
      touched += 1;
    });
  });
  return touched;
}

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * Coerce one action into a shape runAction can trust. Actions can arrive from
 * the Claude bridge, so nothing here may assume well-formed numbers or enums.
 */
function sanitizeAction(raw) {
  if (!raw || typeof raw.type !== 'string') return null;
  const clampedNumber = (value, min, max, fallback = null) => {
    const parsed = typeof value === 'number' ? value : Number.parseFloat(value);
    if (!Number.isFinite(parsed)) return fallback;
    return THREE.MathUtils.clamp(parsed, min, max);
  };
  const axis = ['x', 'y', 'z'].includes(raw.axis) ? raw.axis : 'y';

  switch (raw.type) {
    case 'color':
      return HEX_COLOR.test(String(raw.value ?? ''))
        ? { type: 'color', value: String(raw.value), part: raw.part ? String(raw.part) : null }
        : null;
    case 'scalePercent': {
      const value = clampedNumber(raw.value, MIN_USER_SCALE * 100, MAX_USER_SCALE * 100);
      return value === null ? null : { type: 'scalePercent', value };
    }
    case 'scaleMultiply': {
      const value = clampedNumber(raw.value, 0.05, 20);
      return value === null || value <= 0 ? null : { type: 'scaleMultiply', value };
    }
    case 'position': {
      const value = clampedNumber(raw.value, -1e4, 1e4);
      return value === null ? null : { type: 'position', axis, value, relative: raw.relative !== false };
    }
    case 'rotate': {
      const degrees = clampedNumber(raw.degrees, -3600, 3600);
      return degrees === null ? null : { type: 'rotate', axis, degrees };
    }
    case 'explode':
      return { type: 'explode', value: clampedNumber(raw.value, 0, 1, 1) };
    case 'opacity':
      return { type: 'opacity', value: clampedNumber(raw.value, 0, 1, 0.5) };
    case 'metallic':
      return { type: 'metallic', value: clampedNumber(raw.value, 0, 1, 0.9) };
    case 'roughness':
      return { type: 'roughness', value: clampedNumber(raw.value, 0, 1, 0.5) };
    case 'wireframe':
    case 'autoRotate':
      return { type: raw.type, value: Boolean(raw.value) };
    case 'assemble':
    case 'reset':
    case 'fit':
      return { type: raw.type };
    default:
      return null;
  }
}

function runAction(action) {
  if (!model) return 'Sahnede model yok.';
  switch (action.type) {
    case 'color': {
      const color = new THREE.Color(action.value);
      const touched = eachMaterial((material) => { material.color?.copy(color); }, action.part);
      if (touched === 0) return `"${action.part}" adlı parça bulunamadı.`;
      break;
    }
    case 'scalePercent':
      setModelScale(action.value / 100, { announce: false });
      break;
    case 'scaleMultiply':
      multiplyModelScale(action.value, { announce: false });
      break;
    case 'position': {
      const delta = new THREE.Vector3(
        action.axis === 'x' ? action.value : 0,
        action.axis === 'y' ? action.value : 0,
        action.axis === 'z' ? -action.value : 0
      );
      if (action.relative) model.position.add(delta);
      else model.position[action.axis] = action.axis === 'z' ? -action.value : action.value;
      if (anchored) anchorCenter.copy(model.position);
      break;
    }
    case 'rotate': {
      const axis = new THREE.Vector3(
        action.axis === 'x' ? 1 : 0,
        action.axis === 'y' ? 1 : 0,
        action.axis === 'z' ? 1 : 0
      );
      model.rotateOnWorldAxis(axis, THREE.MathUtils.degToRad(action.degrees));
      break;
    }
    case 'explode':
      setExplode(action.value);
      break;
    case 'assemble':
      setExplode(0);
      break;
    case 'wireframe':
      wireframeEnabled = action.value;
      eachMaterial((material) => { material.wireframe = wireframeEnabled; });
      wireframeButton.textContent = `Tel kafes: ${wireframeEnabled ? 'açık' : 'kapalı'}`;
      break;
    case 'opacity':
      eachMaterial((material) => {
        material.transparent = action.value < 1;
        material.opacity = action.value;
        material.depthWrite = action.value >= 1;
      });
      break;
    case 'metallic':
      eachMaterial((material) => {
        if (material.metalness !== undefined) material.metalness = action.value;
      });
      break;
    case 'roughness':
      eachMaterial((material) => {
        if (material.roughness !== undefined) material.roughness = action.value;
      });
      break;
    case 'autoRotate':
      autoRotateEnabled = action.value;
      rotationButton.textContent = `Otomatik döndür: ${autoRotateEnabled ? 'açık' : 'kapalı'}`;
      break;
    case 'reset':
      if (baseModelQuaternion) model.quaternion.copy(baseModelQuaternion);
      if (baseModelPosition) model.position.copy(baseModelPosition);
      setModelScale(1, { announce: false });
      setExplode(0);
      fitCameraToModels();
      break;
    case 'fit':
      fitCameraToModel();
      break;
    default:
      return `Bilinmeyen eylem: ${action.type}`;
  }
  return null;
}

function appendAiMessage(role, text) {
  const bubble = document.createElement('div');
  bubble.className = `ai-message ai-${role}`;
  for (const line of String(text).split('\n')) {
    const paragraph = document.createElement('p');
    paragraph.textContent = line;
    bubble.append(paragraph);
  }
  aiLog.append(bubble);
  aiLog.scrollTop = aiLog.scrollHeight;
}

function sceneSummary() {
  const state = modelStates.get(model);
  if (!state) return 'Sahnede model yok.';
  const dimensions = currentDimensions();
  const partNames = (state.parts ?? []).map((part) => part.name).filter(Boolean).slice(0, 25);
  return [
    `Etkin model: ${state.name} (${state.extension})`,
    `Parça sayısı: ${state.stats.meshes}, üçgen: ${state.stats.triangles}`,
    `Ölçek: %${(state.userScale * 100).toFixed(1)}`,
    `Boyut: ${dimensions.x.toFixed(2)} x ${dimensions.y.toFixed(2)} x ${dimensions.z.toFixed(2)} mm`,
    `Patlatma: %${Math.round((state.explode ?? 0) * 100)}`,
    partNames.length ? `Parça adları: ${partNames.join(', ')}` : 'Parça adları yok.'
  ].join('\n');
}

async function askAssistantBridge(prompt) {
  const response = await fetch('http://127.0.0.1:8765/ai/command', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt, scene: sceneSummary() })
  });
  if (!response.ok) throw new Error(`bridge-${response.status}`);
  const payload = await response.json();
  if (!payload.available) throw new Error(payload.message ?? 'bridge-unavailable');
  return payload;
}

async function submitAssistantPrompt(rawPrompt) {
  const prompt = rawPrompt.trim();
  if (!prompt) return;
  appendAiMessage('user', prompt);
  aiInput.value = '';
  aiSend.disabled = true;
  aiStatus.textContent = assistantAvailable ? 'Claude düşünüyor…' : 'Komut çözümleniyor…';

  let result = null;
  let source = 'yerel';
  if (assistantAvailable) {
    try {
      result = await askAssistantBridge(prompt);
      source = 'Claude';
    } catch {
      assistantAvailable = false;
      aiStatus.textContent = 'Claude köprüsüne ulaşılamadı; yerel yorumlayıcıya geçildi.';
    }
  }
  if (!result) {
    result = interpretLocally(prompt, { radius: modelRadius });
  }

  const actions = Array.isArray(result.actions) ? result.actions : [];
  if (actions.length === 0) {
    appendAiMessage('assistant', result.reply ?? 'Bu komutu uygulayamadım.');
  } else if (!model) {
    appendAiMessage('assistant', 'Önce bir 3B model yükle, sonra tekrar dene.');
  } else {
    const notes = [];
    let rejected = 0;
    for (const raw of actions) {
      const action = sanitizeAction(raw);
      if (!action) {
        rejected += 1;
        continue;
      }
      const problem = runAction(action);
      notes.push(problem ?? describeAction(action));
    }
    if (rejected > 0) notes.push(`${rejected} eylem anlaşılamadığı için atlandı.`);
    renderModelList();
    updateDimensionReadout();
    appendAiMessage(
      'assistant',
      [result.reply, ...notes].filter(Boolean).join('\n')
        || 'Bu komuttan uygulanabilir bir değişiklik çıkaramadım.'
    );
  }

  aiStatus.textContent = `Kaynak: ${source}`;
  aiSend.disabled = false;
  aiInput.focus();
}

async function probeAssistantBridge() {
  try {
    const response = await fetch('http://127.0.0.1:8765/ai/status');
    const payload = await response.json();
    assistantAvailable = Boolean(payload.configured);
    aiStatus.textContent = assistantAvailable
      ? `Claude köprüsü hazır (${payload.model}).`
      : 'Yerel komut yorumlayıcısı etkin. Claude için ANTHROPIC_API_KEY tanımlayın.';
  } catch {
    assistantAvailable = false;
    aiStatus.textContent = 'Yerel komut yorumlayıcısı etkin (backend köprüsü kapalı).';
  }
}

/* ------------------------------------------------------------------ *
 * UI wiring
 * ------------------------------------------------------------------ */

resetButton.addEventListener('click', () => {
  if (model && baseModelQuaternion) model.quaternion.copy(baseModelQuaternion);
  if (model && baseModelPosition) model.position.copy(baseModelPosition);
  modelVelocity.set(0, 0, 0);
  if (anchored) setSpatialAnchor(false);
  setModelScale(1, { announce: false });
  setExplode(0);
  resetGestureState();
  if (gestureEnabled) gestureStatus.textContent = 'Jest: el bekleniyor';
  fitCameraToModels();
});

wireframeButton.addEventListener('click', () => {
  wireframeEnabled = !wireframeEnabled;
  eachMaterial((material) => { material.wireframe = wireframeEnabled; });
  wireframeButton.textContent = `Tel kafes: ${wireframeEnabled ? 'açık' : 'kapalı'}`;
});

rotationButton.addEventListener('click', () => {
  autoRotateEnabled = !autoRotateEnabled;
  rotationButton.textContent = `Otomatik döndür: ${autoRotateEnabled ? 'açık' : 'kapalı'}`;
  if (anchored && autoRotateEnabled) {
    gestureStatus.textContent = 'Model yörüngeye girdi; arkanızdan geçebilir.';
  }
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
  gestureButton.classList.toggle('is-on', gestureEnabled);
  gestureButton.setAttribute('aria-pressed', String(gestureEnabled));
  gestureStatus.textContent = gestureEnabled ? 'Jest: el bekleniyor' : 'Jest kontrolü kapalı.';
});

unitSelect?.addEventListener('change', () => {
  const state = modelStates.get(model);
  if (!state) return;
  state.unit = unitSelect.value;
  updateDimensionReadout();
  renderModelList();
});

scaleInput?.addEventListener('change', () => {
  const percent = Number.parseFloat(scaleInput.value.replace(',', '.'));
  if (Number.isFinite(percent) && percent > 0) setModelScale(percent / 100);
  else updateDimensionReadout();
});

scaleUpButton?.addEventListener('click', () => multiplyModelScale(1.1));
scaleDownButton?.addEventListener('click', () => multiplyModelScale(1 / 1.1));
scaleResetButton?.addEventListener('click', () => setModelScale(1));

twoHandModeButton?.addEventListener('click', () => {
  twoHandMode = twoHandMode === 'scale' ? 'zoom' : 'scale';
  twoHandModeButton.textContent = twoHandMode === 'scale'
    ? 'İki el: model boyutu'
    : 'İki el: kamera zoom';
  twoHandModeButton.classList.toggle('is-on', twoHandMode === 'scale');
});

explodeSlider?.addEventListener('input', () => {
  setExplode(Number.parseInt(explodeSlider.value, 10) / 100);
});
assembleButton?.addEventListener('click', () => setExplode(0));
gcodeButton?.addEventListener('click', () => { void exportGcode(); });

aiSend?.addEventListener('click', () => { void submitAssistantPrompt(aiInput.value); });
aiInput?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    void submitAssistantPrompt(aiInput.value);
  }
});
aiChips.forEach((chip) => {
  chip.addEventListener('click', () => { void submitAssistantPrompt(chip.dataset.prompt ?? chip.textContent); });
});

/* ------------------------------------------------------------------ *
 * Landmark stream
 * ------------------------------------------------------------------ */

window.addEventListener('hand-landmarks', (event) => {
  const hands = event.detail.hands ?? [];
  const clapRestoreActive = gestureEnabled && updateClapRestore(hands);
  const fistSequenceActive = gestureEnabled && updateFistSequence(hands);
  const spockCandidate = updateSpockLock(hands);

  if (Number.isFinite(event.detail.personDistanceMeters)) {
    smoothedPersonDistanceMeters = smoothedPersonDistanceMeters === null
      ? event.detail.personDistanceMeters
      : THREE.MathUtils.lerp(smoothedPersonDistanceMeters, event.detail.personDistanceMeters, 0.22);
    sharedState.personDepthMeters = smoothedPersonDistanceMeters;
  }

  if (clapRestoreActive || fistSequenceActive || spockCandidate || anchored || !model?.visible) return;
  applyGestureFrame(hands);
});

setControlsEnabled(false);
renderModelList();
updateDimensionReadout();
modelStatus.textContent = '3B yükleyici hazır. GLB, STL veya OBJ dosyası seçin.';
window.addEventListener('model-file-selected', (event) => {
  void loadModelFile(event.detail.file);
});
void probeAssistantBridge();
render();
