/**
 * Offline natural-language command interpreter for the scene assistant.
 *
 * The renderer tries the Claude bridge on the local backend first; this parser
 * is the always-available fallback, so it has to stand on its own for the
 * command vocabulary the panel advertises. It emits the exact same action
 * objects the bridge does.
 */

const COLOR_WORDS = new Map([
  ['kirmizi', '#e5484d'], ['kırmızı', '#e5484d'], ['red', '#e5484d'],
  ['mavi', '#3b82f6'], ['blue', '#3b82f6'],
  ['lacivert', '#1e3a8a'], ['navy', '#1e3a8a'],
  ['yesil', '#22c55e'], ['yeşil', '#22c55e'], ['green', '#22c55e'],
  ['sari', '#eab308'], ['sarı', '#eab308'], ['yellow', '#eab308'],
  ['turuncu', '#f97316'], ['orange', '#f97316'],
  ['mor', '#a855f7'], ['purple', '#a855f7'], ['violet', '#a855f7'],
  ['pembe', '#ec4899'], ['pink', '#ec4899'],
  ['beyaz', '#f5f5f5'], ['white', '#f5f5f5'],
  ['siyah', '#141414'], ['black', '#141414'],
  ['gri', '#8b949e'], ['gray', '#8b949e'], ['grey', '#8b949e'],
  ['kahverengi', '#8b5a2b'], ['brown', '#8b5a2b'],
  ['turkuaz', '#14b8a6'], ['teal', '#14b8a6'], ['cyan', '#06b6d4'],
  ['altin', '#d4af37'], ['altın', '#d4af37'], ['gold', '#d4af37'],
  ['gumus', '#c0c0c0'], ['gümüş', '#c0c0c0'], ['silver', '#c0c0c0'],
  ['bakir', '#b87333'], ['bakır', '#b87333'], ['copper', '#b87333'],
  ['bordo', '#7f1d1d'], ['lime', '#b8f04a']
]);

const AXIS_WORDS = new Map([
  ['x', 'x'], ['y', 'y'], ['z', 'z'],
  ['sag', 'x'], ['sağ', 'x'], ['right', 'x'],
  ['sol', 'x'], ['left', 'x'],
  ['yukari', 'y'], ['yukarı', 'y'], ['up', 'y'], ['yukariya', 'y'], ['yukarıya', 'y'],
  ['asagi', 'y'], ['aşağı', 'y'], ['down', 'y'], ['asagiya', 'y'], ['aşağıya', 'y'],
  ['ileri', 'z'], ['forward', 'z'], ['one', 'z'], ['öne', 'z'],
  ['geri', 'z'], ['back', 'z'], ['arkaya', 'z'], ['backward', 'z']
]);

const NEGATIVE_DIRECTIONS = new Set([
  'sol', 'left', 'asagi', 'aşağı', 'down', 'asagiya', 'aşağıya', 'geri', 'back', 'arkaya', 'backward'
]);

const WORD_NUMBERS = new Map([
  ['bir', 1], ['iki', 2], ['uc', 3], ['üç', 3], ['dort', 4], ['dört', 4], ['bes', 5], ['beş', 5],
  ['alti', 6], ['altı', 6], ['yedi', 7], ['sekiz', 8], ['dokuz', 9], ['on', 10], ['yirmi', 20],
  ['otuz', 30], ['kirk', 40], ['kırk', 40], ['elli', 50], ['altmis', 60], ['altmış', 60],
  ['yetmis', 70], ['yetmiş', 70], ['seksen', 80], ['doksan', 90], ['yuz', 100], ['yüz', 100],
  ['yarim', 0.5], ['yarım', 0.5], ['half', 0.5], ['iki katina', 2], ['one', 1], ['two', 2], ['three', 3]
]);

function normalise(text) {
  return text
    .toLocaleLowerCase('tr')
    .replace(/[^\p{L}\p{N}#.,%+\-/ ]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstNumber(text, fallback = null) {
  const match = text.match(/-?\d+(?:[.,]\d+)?/);
  if (match) return Number.parseFloat(match[0].replace(',', '.'));
  for (const [word, value] of WORD_NUMBERS) {
    if (new RegExp(`(^| )${word}( |$)`).test(text)) return value;
  }
  return fallback;
}

function findColor(text) {
  const hex = text.match(/#[0-9a-f]{6}\b|#[0-9a-f]{3}\b/i);
  if (hex) return hex[0];
  for (const [word, hexValue] of COLOR_WORDS) {
    if (text.includes(word)) return hexValue;
  }
  return null;
}

function findAxis(text) {
  const explicit = text.match(/\b([xyz])\s*(?:ekseni|axis)?\b/);
  if (explicit && /ekseni|axis|\b[xyz]\b/.test(explicit[0])) return explicit[1];
  for (const [word, axis] of AXIS_WORDS) {
    if (new RegExp(`(^| )${word}( |$)`).test(text)) return axis;
  }
  return null;
}

function directionSign(text) {
  for (const word of NEGATIVE_DIRECTIONS) {
    if (new RegExp(`(^| )${word}`).test(text)) return -1;
  }
  return 1;
}

/** Split "kırmızı yap ve %40 büyüt" into independently parsed clauses. */
function clausesOf(text) {
  return text
    .split(/\s+(?:ve|sonra|ayrica|ayrıca|and|then|,|;)\s+/)
    .map((clause) => clause.trim())
    .filter(Boolean);
}

function parseClause(clause, scene) {
  const actions = [];
  const has = (...words) => words.some((word) => clause.includes(word));

  if (has('patlat', 'parcalara ayir', 'parçalara ayır', 'ayir', 'ayır', 'explode', 'exploded', 'dagit', 'dağıt')) {
    const percent = clause.includes('%') || /yuzde|yüzde/.test(clause) ? firstNumber(clause) : null;
    actions.push({ type: 'explode', value: percent === null ? 1 : Math.max(0, Math.min(1, percent / 100)) });
    return actions;
  }
  if (has('birlestir', 'birleştir', 'topla', 'assemble', 'geri getir', 'birlesik', 'birleşik', 'kapat parcalari')) {
    actions.push({ type: 'assemble' });
    return actions;
  }
  if (has('sifirla', 'sıfırla', 'reset', 'basa don', 'başa dön', 'eski haline')) {
    actions.push({ type: 'reset' });
    return actions;
  }
  if (has('sigdir', 'sığdır', 'ortala', 'fit', 'kadraja', 'ekrana sigdir')) {
    actions.push({ type: 'fit' });
    return actions;
  }
  if (has('tel kafes', 'wireframe', 'kafes')) {
    actions.push({ type: 'wireframe', value: !has('kapat', 'kaldir', 'kaldır', 'off', 'iptal') });
    return actions;
  }
  if (has('otomatik don', 'otomatik dön', 'kendi etrafinda', 'auto rotate', 'autorotate', 'surekli don', 'sürekli dön')) {
    actions.push({ type: 'autoRotate', value: !has('kapat', 'durdur', 'off', 'stop') });
    return actions;
  }
  if (has('seffaf', 'şeffaf', 'saydam', 'opacity', 'transparan')) {
    const percent = firstNumber(clause, 50);
    const opacity = has('kapat', 'kaldir', 'kaldır', 'opak') ? 1 : Math.max(0, Math.min(1, percent / 100));
    actions.push({ type: 'opacity', value: opacity });
    return actions;
  }
  if (has('metalik', 'metallic', 'metal')) {
    actions.push({ type: 'metallic', value: Math.max(0, Math.min(1, (firstNumber(clause, 90) ?? 90) / 100)) });
    return actions;
  }
  if (has('puruz', 'pürüz', 'mat', 'roughness', 'parlak')) {
    const glossy = has('parlak', 'gloss');
    const value = firstNumber(clause, null);
    actions.push({
      type: 'roughness',
      value: value === null ? (glossy ? 0.12 : 0.85) : Math.max(0, Math.min(1, value / 100))
    });
    return actions;
  }

  if (has('dondur', 'döndür', 'cevir', 'çevir', 'rotate', 'derece')) {
    const degrees = firstNumber(clause, 90) ?? 90;
    const axis = findAxis(clause) ?? 'y';
    actions.push({ type: 'rotate', axis, degrees: degrees * directionSign(clause) });
    return actions;
  }

  const wantsMove = has('tasi', 'taşı', 'kaydir', 'kaydır', 'move', 'gotur', 'götür', 'konumlandir', 'konumlandır', 'yerlestir', 'yerleştir');
  const wantsScale = has('buyut', 'büyüt', 'kucult', 'küçült', 'olcek', 'ölçek', 'scale', 'boyut', 'boyutu', 'buyuklugu', 'büyüklüğü', 'kat');

  if (wantsScale && !wantsMove) {
    const number = firstNumber(clause, null);
    const percentish = clause.includes('%') || /yuzde|yüzde/.test(clause);
    const shrink = has('kucult', 'küçült', 'kucuk', 'küçük', 'smaller', 'azalt');
    // Whole-word only: `includes('x')` would fire on any clause with an x in it.
    const multiplierWord = /(^|\s)(kat|katina|katına|times|x)(\s|$)/.test(clause);
    if (number !== null && multiplierWord && !percentish) {
      actions.push({ type: 'scaleMultiply', value: shrink ? 1 / number : number });
    } else if (number !== null && percentish && has('olsun', 'yap', 'ol', 'set', 'sabitle', 'olarak')) {
      // "boyutu yüzde 40 olsun" sets an absolute scale; "yüzde 40 büyüt" is relative.
      const relative = has('buyut', 'büyüt', 'kucult', 'küçült', 'artir', 'artır', 'azalt');
      if (relative) actions.push({ type: 'scaleMultiply', value: shrink ? 1 - number / 100 : 1 + number / 100 });
      else actions.push({ type: 'scalePercent', value: number });
    } else if (number !== null) {
      actions.push(percentish
        ? { type: 'scaleMultiply', value: shrink ? Math.max(0.05, 1 - number / 100) : 1 + number / 100 }
        : { type: 'scalePercent', value: number });
    } else {
      actions.push({ type: 'scaleMultiply', value: shrink ? 0.8 : 1.25 });
    }
    return actions;
  }

  if (wantsMove) {
    const axis = findAxis(clause) ?? 'x';
    const amount = firstNumber(clause, null);
    const radius = Number.isFinite(scene?.radius) ? scene.radius : 1;
    const value = (amount === null ? radius * 0.6 : amount) * directionSign(clause);
    actions.push({ type: 'position', axis, value, relative: !has('konumu', 'noktasina', 'noktasına') });
    return actions;
  }

  const color = findColor(clause);
  if (color) {
    const partMatch = clause.match(/(?:parca|parça|part|mesh)\s+([\p{L}\p{N}_-]+)/u);
    actions.push({ type: 'color', value: color, part: partMatch ? partMatch[1] : null });
    return actions;
  }

  return actions;
}

const HELP_REPLY = [
  'Şunları deneyebilirsin:',
  '· "modeli kırmızı yap"',
  '· "yüzde 40 büyüt" / "boyutu yüzde 150 olsun"',
  '· "sağa 2 birim taşı", "y ekseninde 90 derece döndür"',
  '· "parçalara ayır" / "birleştir"',
  '· "yarı saydam yap", "tel kafes aç", "otomatik döndür"'
].join('\n');

export function interpretLocally(prompt, scene = {}) {
  const text = normalise(prompt);
  if (!text) return { actions: [], reply: 'Ne yapmamı istediğini yazar mısın?' };
  if (/^(yardim|yardım|help|ne yapabilirsin|komutlar)\b/.test(text)) {
    return { actions: [], reply: HELP_REPLY };
  }

  const actions = clausesOf(text).flatMap((clause) => parseClause(clause, scene));
  if (actions.length === 0) {
    return {
      actions: [],
      reply: `"${prompt.trim()}" komutunu çözemedim.\n\n${HELP_REPLY}`
    };
  }
  return { actions, reply: null };
}

export function describeAction(action) {
  switch (action.type) {
    case 'color': return action.part ? `${action.part} parçası ${action.value} rengine boyandı` : `Renk ${action.value} yapıldı`;
    case 'scalePercent': return `Ölçek %${action.value.toFixed(0)} olarak ayarlandı`;
    case 'scaleMultiply': return `Ölçek ${action.value.toFixed(2)}× değiştirildi`;
    case 'position': return `${action.axis.toUpperCase()} ekseninde ${action.value.toFixed(2)} birim taşındı`;
    case 'rotate': return `${action.axis.toUpperCase()} ekseninde ${action.degrees.toFixed(0)}° döndürüldü`;
    case 'explode': return `Parçalara ayırma %${Math.round(action.value * 100)}`;
    case 'assemble': return 'Parçalar birleştirildi';
    case 'wireframe': return `Tel kafes ${action.value ? 'açıldı' : 'kapandı'}`;
    case 'opacity': return `Saydamlık %${Math.round((1 - action.value) * 100)}`;
    case 'autoRotate': return `Otomatik döndürme ${action.value ? 'açıldı' : 'kapandı'}`;
    case 'metallic': return `Metaliklik ${action.value.toFixed(2)}`;
    case 'roughness': return `Pürüzlülük ${action.value.toFixed(2)}`;
    case 'reset': return 'Model sıfırlandı';
    case 'fit': return 'Kamera modele sığdırıldı';
    default: return `Bilinmeyen eylem: ${action.type}`;
  }
}
