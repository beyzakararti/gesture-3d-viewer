import * as THREE from 'three';

/**
 * Contour slicer for the viewer's scaled meshes.
 *
 * This produces single-wall (outline) G-code: every layer is the true silhouette
 * of the mesh at that height, extruded once. That is enough to print the part as
 * a shell and to check real dimensions on a printer, but it is not a full
 * slicer - there is no infill, no solid top/bottom layers and no supports.
 */

const WELD_EPSILON = 1e-4;
const MIN_LOOP_POINTS = 3;

export const DEFAULT_PRINT_SETTINGS = Object.freeze({
  layerHeight: 0.2,
  firstLayerHeight: 0.28,
  extrusionWidth: 0.42,
  nozzleDiameter: 0.4,
  filamentDiameter: 1.75,
  nozzleTemperature: 210,
  bedTemperature: 60,
  printSpeed: 40,
  firstLayerSpeed: 20,
  travelSpeed: 120,
  retractionDistance: 1.2,
  retractionSpeed: 35,
  bedWidth: 220,
  bedDepth: 220,
  bedHeight: 250,
  extrusionMultiplier: 1
});

function keyOf(x, y) {
  return `${Math.round(x / WELD_EPSILON)}:${Math.round(y / WELD_EPSILON)}`;
}

/** Intersect one triangle with the plane z = height, returning a segment or null. */
function sliceTriangle(a, b, c, height) {
  const points = [];
  for (const [start, end] of [[a, b], [b, c], [c, a]]) {
    if ((start.z > height) === (end.z > height)) continue;
    const t = (height - start.z) / (end.z - start.z);
    points.push({ x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t });
  }
  if (points.length < 2) return null;
  const [first, second] = points;
  if (Math.hypot(second.x - first.x, second.y - first.y) < WELD_EPSILON) return null;
  return [first, second];
}

/** Chain unordered segments into closed (or open, if the mesh leaks) polylines. */
function linkSegments(segments) {
  const buckets = new Map();
  segments.forEach((segment, index) => {
    for (const endpoint of [0, 1]) {
      const key = keyOf(segment[endpoint].x, segment[endpoint].y);
      const bucket = buckets.get(key);
      if (bucket) bucket.push({ index, endpoint });
      else buckets.set(key, [{ index, endpoint }]);
    }
  });

  const consumed = new Uint8Array(segments.length);
  const loops = [];

  for (let seed = 0; seed < segments.length; seed += 1) {
    if (consumed[seed]) continue;
    consumed[seed] = 1;
    const loop = [segments[seed][0], segments[seed][1]];

    for (let guard = 0; guard < segments.length; guard += 1) {
      const tail = loop[loop.length - 1];
      const candidates = buckets.get(keyOf(tail.x, tail.y)) ?? [];
      const next = candidates.find((candidate) => !consumed[candidate.index]);
      if (!next) break;
      consumed[next.index] = 1;
      loop.push(segments[next.index][next.endpoint === 0 ? 1 : 0]);
      const head = loop[0];
      const newTail = loop[loop.length - 1];
      if (Math.hypot(newTail.x - head.x, newTail.y - head.y) < WELD_EPSILON) break;
    }

    if (loop.length >= MIN_LOOP_POINTS) loops.push(loop);
  }

  return loops;
}

/** Hand control back to the browser so the viewport keeps drawing mid-slice. */
const breathe = () => new Promise((resolve) => setTimeout(resolve, 0));
const YIELD_EVERY_TRIANGLES = 20000;

/** World-space triangles of every visible mesh, in millimetres and Z-up. */
export async function collectTriangles(objects, millimetresPerUnit, onStage = null) {
  const triangles = [];
  const vertex = new THREE.Vector3();
  const meshes = [];

  for (const root of objects) {
    root.updateMatrixWorld(true);
    root.traverse((object) => {
      if (object.isMesh && object.visible && object.geometry?.attributes?.position) meshes.push(object);
    });
  }

  for (const object of meshes) {
    const geometry = object.geometry;
    const position = geometry.attributes.position;
    const index = geometry.index;
    const count = index ? index.count : position.count;
    for (let cursor = 0; cursor + 2 < count; cursor += 3) {
      const corners = [];
      for (let corner = 0; corner < 3; corner += 1) {
        const vertexIndex = index ? index.getX(cursor + corner) : cursor + corner;
        vertex.fromBufferAttribute(position, vertexIndex).applyMatrix4(object.matrixWorld);
        // Three.js is Y-up; printers are Z-up.
        corners.push({
          x: vertex.x * millimetresPerUnit,
          y: -vertex.z * millimetresPerUnit,
          z: vertex.y * millimetresPerUnit
        });
      }
      triangles.push(corners);
      if (triangles.length % YIELD_EVERY_TRIANGLES === 0) {
        onStage?.('geometri', triangles.length);
        await breathe();
      }
    }
  }

  return triangles;
}

export function boundsOf(triangles) {
  const bounds = {
    minX: Infinity, minY: Infinity, minZ: Infinity,
    maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity
  };
  for (const triangle of triangles) {
    for (const corner of triangle) {
      bounds.minX = Math.min(bounds.minX, corner.x);
      bounds.minY = Math.min(bounds.minY, corner.y);
      bounds.minZ = Math.min(bounds.minZ, corner.z);
      bounds.maxX = Math.max(bounds.maxX, corner.x);
      bounds.maxY = Math.max(bounds.maxY, corner.y);
      bounds.maxZ = Math.max(bounds.maxZ, corner.z);
    }
  }
  return bounds;
}

function extrusionPerMillimetre(settings, layerHeight) {
  const filamentArea = Math.PI * (settings.filamentDiameter / 2) ** 2;
  // Rounded-rectangle cross-section, the same model PrusaSlicer and Cura use.
  const pathArea = settings.extrusionWidth * layerHeight - (layerHeight ** 2) * (1 - Math.PI / 4);
  return (pathArea / filamentArea) * settings.extrusionMultiplier;
}

/**
 * Slice the given roots into G-code. `onProgress` is awaited between layers so
 * the caller can keep the UI responsive on large meshes.
 */
export async function sliceToGcode({
  objects,
  millimetresPerUnit,
  settings,
  metadata = {},
  onProgress = null,
  onStage = null,
  shouldCancel = null
}) {
  const config = { ...DEFAULT_PRINT_SETTINGS, ...settings };
  const triangles = await collectTriangles(objects, millimetresPerUnit, onStage);
  if (triangles.length === 0) throw new Error('Dilimlenecek görünür üçgen bulunamadı');

  const bounds = boundsOf(triangles);
  const width = bounds.maxX - bounds.minX;
  const depth = bounds.maxY - bounds.minY;
  const height = bounds.maxZ - bounds.minZ;
  if (!(height > 0)) throw new Error('Model yüksekliği sıfır; dilimlenemez');

  const offsetX = config.bedWidth / 2 - (bounds.minX + width / 2);
  const offsetY = config.bedDepth / 2 - (bounds.minY + depth / 2);
  const offsetZ = -bounds.minZ;

  // Bucket triangles by the layer range they span so each layer only tests the
  // triangles that can actually cross it.
  const layerCount = Math.max(
    1,
    Math.ceil((height - config.firstLayerHeight) / config.layerHeight) + 1
  );
  const buckets = Array.from({ length: layerCount }, () => []);
  const sampleZ = (layer) => (layer === 0
    ? config.firstLayerHeight / 2
    : config.firstLayerHeight + (layer - 0.5) * config.layerHeight);
  const nozzleZ = (layer) => (layer === 0
    ? config.firstLayerHeight
    : config.firstLayerHeight + layer * config.layerHeight);
  const layerIndexAt = (z) => {
    if (z <= config.firstLayerHeight) return 0;
    return Math.min(
      layerCount - 1,
      Math.floor((z - config.firstLayerHeight) / config.layerHeight) + 1
    );
  };

  for (let cursor = 0; cursor < triangles.length; cursor += 1) {
    const triangle = triangles[cursor];
    const shifted = triangle.map((corner) => ({
      x: corner.x + offsetX,
      y: corner.y + offsetY,
      z: corner.z + offsetZ
    }));
    const minZ = Math.min(shifted[0].z, shifted[1].z, shifted[2].z);
    const maxZ = Math.max(shifted[0].z, shifted[1].z, shifted[2].z);
    for (let layer = layerIndexAt(minZ); layer <= layerIndexAt(maxZ); layer += 1) {
      buckets[layer].push(shifted);
    }
    if (cursor > 0 && cursor % YIELD_EVERY_TRIANGLES === 0) {
      onStage?.('katman haritası', cursor / triangles.length);
      await breathe();
    }
  }

  const lines = [];
  lines.push(
    '; Byeza Studio - tek duvar (outline) G-code',
    `; Olusturma: ${new Date().toISOString()}`,
    `; Model: ${metadata.name ?? 'model'}`,
    `; Olcek: %${(metadata.scalePercent ?? 100).toFixed(1)}`,
    `; Boyut (mm): ${width.toFixed(2)} x ${depth.toFixed(2)} x ${height.toFixed(2)}`,
    `; Katman yuksekligi: ${config.layerHeight} mm / ilk katman ${config.firstLayerHeight} mm`,
    `; Ekstruzyon genisligi: ${config.extrusionWidth} mm, nozul ${config.nozzleDiameter} mm`,
    `; Filament: ${config.filamentDiameter} mm`,
    '; NOT: Bu dosya sadece dis konturu basar - dolgu, ust/alt yuzey ve destek icermez.',
    'M82 ; mutlak ekstruzyon',
    'G21 ; birim mm',
    'G90 ; mutlak konum',
    `M140 S${config.bedTemperature} ; tabla isinmaya baslasin`,
    `M104 S${config.nozzleTemperature} ; nozul isinmaya baslasin`,
    `M190 S${config.bedTemperature} ; tabla sicakligini bekle`,
    `M109 S${config.nozzleTemperature} ; nozul sicakligini bekle`,
    'G28 ; tum eksenleri sifirla',
    'G92 E0 ; ekstruder sayacini sifirla',
    'M107 ; fan kapali'
  );

  let extruded = 0;
  let retracted = false;
  let emittedLayers = 0;
  let totalPathLength = 0;

  const retract = () => {
    if (retracted || config.retractionDistance <= 0) return;
    extruded -= config.retractionDistance;
    lines.push(`G1 E${extruded.toFixed(5)} F${Math.round(config.retractionSpeed * 60)}`);
    retracted = true;
  };
  const unretract = () => {
    if (!retracted) return;
    extruded += config.retractionDistance;
    lines.push(`G1 E${extruded.toFixed(5)} F${Math.round(config.retractionSpeed * 60)}`);
    retracted = false;
  };

  for (let layer = 0; layer < layerCount; layer += 1) {
    if (shouldCancel?.()) throw new Error('Dilimleme iptal edildi');

    const z = sampleZ(layer);
    const thickness = layer === 0 ? config.firstLayerHeight : config.layerHeight;
    const topZ = nozzleZ(layer);
    const segments = [];
    for (const triangle of buckets[layer]) {
      const segment = sliceTriangle(triangle[0], triangle[1], triangle[2], z);
      if (segment) segments.push(segment);
    }

    const loops = linkSegments(segments);
    if (loops.length > 0) {
      emittedLayers += 1;
      const feed = Math.round((layer === 0 ? config.firstLayerSpeed : config.printSpeed) * 60);
      const ePerMm = extrusionPerMillimetre(config, thickness);
      lines.push(`;LAYER:${layer}`, `;Z:${topZ.toFixed(3)}`);
      if (layer === 1) lines.push('M106 S255 ; katman fanini ac');

      for (const loop of loops) {
        retract();
        lines.push(
          `G0 F${Math.round(config.travelSpeed * 60)} X${loop[0].x.toFixed(3)} Y${loop[0].y.toFixed(3)} Z${topZ.toFixed(3)}`
        );
        unretract();
        let previous = loop[0];
        for (const point of loop.slice(1)) {
          const length = Math.hypot(point.x - previous.x, point.y - previous.y);
          if (length < WELD_EPSILON) continue;
          extruded += length * ePerMm;
          totalPathLength += length;
          lines.push(`G1 F${feed} X${point.x.toFixed(3)} Y${point.y.toFixed(3)} E${extruded.toFixed(5)}`);
          previous = point;
        }
      }
    }

    if (onProgress) await onProgress((layer + 1) / layerCount, layer + 1, layerCount);
  }

  retract();
  lines.push(
    'M107 ; fan kapat',
    `G1 Z${Math.min(config.bedHeight, height + 12).toFixed(3)} F${Math.round(config.travelSpeed * 60)}`,
    'M104 S0 ; nozulu kapat',
    'M140 S0 ; tablayi kapat',
    'M84 ; motorlari serbest birak',
    `; toplam katman: ${emittedLayers}`,
    `; tahmini filament: ${Math.max(0, extruded).toFixed(2)} mm`,
    `; toplam yol: ${(totalPathLength / 1000).toFixed(2)} m`
  );

  return {
    text: `${lines.join('\n')}\n`,
    layers: emittedLayers,
    filamentMillimetres: Math.max(0, extruded),
    dimensions: { width, depth, height },
    bedFits: width <= config.bedWidth && depth <= config.bedDepth && height <= config.bedHeight
  };
}
