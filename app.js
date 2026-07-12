'use strict';

/* =====================================================================
   Piano — Grand Piano virtuel
   - Mapping clavier identique à virtualpiano.net (61 touches, C2 → C7)
   - Son : Salamander Grand Piano (Yamaha C5), 21 samples, interpolation
     de pitch par playbackRate (1 sample tous les 3 demi-tons)
   ===================================================================== */

/* ---------- Mapping virtualpiano.net ----------
   Index i = midi 36+i (C2..C7). Minuscules/chiffres = touches blanches,
   majuscules et symboles (Shift+chiffre) = dièses.
   Le mapping se fait par CARACTÈRE tapé (e.key), comme sur virtualpiano.net :
   la touche qui écrit « w » joue le w, sur QWERTY comme sur AZERTY.
   Le pavé numérique produit les caractères 1..0, donc il marche aussi. */
const VP_MAP = "1!2@34$5%6^78*9(0qQwWeErtTyYuiIoOpPasSdDfgGhHjJklLzZxcCvVbBnm";
const FIRST_MIDI = 36; // C2
const LAST_MIDI = 96;  // C7

const midiToVpChar = {};
const vpCharToMidi = {};
for (let i = 0; i < VP_MAP.length; i++) {
  midiToVpChar[FIRST_MIDI + i] = VP_MAP[i];
  vpCharToMidi[VP_MAP[i]] = FIRST_MIDI + i;
}

/* Variante avec/sans Maj d'un caractère du mapping ('w' ↔ 'W', '8' ↔ '*') */
const SHIFT_SYM = { '1': '!', '2': '@', '4': '$', '5': '%', '6': '^', '8': '*', '9': '(',
                    '!': '1', '@': '2', '$': '4', '%': '5', '^': '6', '*': '8', '(': '9' };
function siblingChar(ch) {
  if (/^[a-z]$/.test(ch)) return ch.toUpperCase();
  if (/^[A-Z]$/.test(ch)) return ch.toLowerCase();
  return SHIFT_SYM[ch];
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const BLACK_PCS = new Set([1, 3, 6, 8, 10]);
const noteName = midi => NOTE_NAMES[midi % 12] + (Math.floor(midi / 12) - 1);

/* ---------- Samples Salamander (nom fichier -> midi) ---------- */
const SAMPLE_FILES = [
  'C1', 'Ds1', 'Fs1', 'A1',
  'C2', 'Ds2', 'Fs2', 'A2', 'C3', 'Ds3', 'Fs3', 'A3', 'C4', 'Ds4', 'Fs4', 'A4',
  'C5', 'Ds5', 'Fs5', 'A5', 'C6', 'Ds6', 'Fs6', 'A6', 'C7',
  'Ds7', 'Fs7', 'A7', 'C8'
];
function sampleMidi(name) {
  const m = name.match(/^([A-G])(s?)(\d)$/);
  const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1]];
  return (parseInt(m[3], 10) + 1) * 12 + base + (m[2] ? 1 : 0);
}

/* ---------- Moteur audio ---------- */
const ctx = new (window.AudioContext || window.webkitAudioContext)();
const masterGain = ctx.createGain();
const compressor = ctx.createDynamicsCompressor();
compressor.threshold.value = -14;
compressor.knee.value = 20;
compressor.ratio.value = 3;
compressor.attack.value = 0.003;
compressor.release.value = 0.25;
/* Réverbération de salle : réponse impulsionnelle générée (bruit décroissant) */
function makeImpulse(seconds = 2.6, decay = 2.4) {
  const rate = ctx.sampleRate;
  const len = Math.floor(rate * seconds);
  const buf = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  return buf;
}
const convolver = ctx.createConvolver();
convolver.buffer = makeImpulse();
const dryGain = ctx.createGain();
const wetGain = ctx.createGain();
wetGain.gain.value = 0.22;

masterGain.connect(dryGain);
dryGain.connect(compressor);
masterGain.connect(convolver);
convolver.connect(wetGain);
wetGain.connect(compressor);
compressor.connect(ctx.destination);
masterGain.gain.value = 0.8;

function setReverb(pct) { // 0..100
  wetGain.gain.setTargetAtTime(pct / 100 * 0.9, ctx.currentTime, 0.05);
}

const buffers = [];            // [{ midi, buffer }] trié par midi
const activeVoices = new Map(); // midi -> voice
const sustainedVoices = new Set();
let pedalHeld = false;  // Espace maintenu
let pedalLocked = true; // bouton Sustain verrouillé — actif par défaut
const sustainOn = () => pedalHeld || pedalLocked;

function nearestSample(midi) {
  let best = buffers[0];
  for (const s of buffers) {
    if (Math.abs(s.midi - midi) < Math.abs(best.midi - midi)) best = s;
  }
  return best;
}

function resumeCtx() {
  if (ctx.state === 'suspended') ctx.resume();
}

let transpose = 0; // demi-tons, -12..+12 (comme virtualpiano.net)

function noteOn(midi, velocity = 0.85) {
  if (midi < FIRST_MIDI || midi > LAST_MIDI || !buffers.length) return;
  resumeCtx();
  const prev = activeVoices.get(midi);
  if (prev) releaseVoice(prev, 0.06); // ré-attaque : coupe court l'ancienne note

  const sounding = midi + transpose;
  const s = nearestSample(sounding);
  const src = ctx.createBufferSource();
  src.buffer = s.buffer;
  src.playbackRate.value = Math.pow(2, (sounding - s.midi) / 12);
  const gain = ctx.createGain();
  gain.gain.value = Math.max(0.05, Math.min(1, velocity));
  src.connect(gain);
  gain.connect(masterGain);
  src.start();
  src.onended = () => gain.disconnect();

  activeVoices.set(midi, { src, gain });
  setKeyDown(midi, true);
  showNote(midi);
  spawnNoteFx(midi);
  recCapture(midi);
  sheetNotePlayed(midi);
}

function noteOff(midi) {
  const voice = activeVoices.get(midi);
  setKeyDown(midi, false);
  if (!voice) return;
  activeVoices.delete(midi);
  if (sustainOn()) { sustainedVoices.add(voice); return; }
  releaseVoice(voice, 0.22);
}

function releaseVoice(voice, seconds) {
  const now = ctx.currentTime;
  voice.gain.gain.cancelScheduledValues(now);
  voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
  voice.gain.gain.setTargetAtTime(0, now, seconds / 3);
  try { voice.src.stop(now + seconds * 4); } catch (_) {}
}

function setPedal(held) {
  pedalHeld = held;
  updateSustainUi();
  if (!sustainOn()) {
    sustainedVoices.forEach(v => releaseVoice(v, 0.3));
    sustainedVoices.clear();
  }
}

/* ---------- Chargement des samples ---------- */
const loaderEl = document.getElementById('loader');
const loaderText = document.getElementById('loaderText');
const progressBar = document.getElementById('progressBar');

async function loadSamples() {
  let done = 0;
  await Promise.all(SAMPLE_FILES.map(async name => {
    const res = await fetch(`samples/${name}.mp3`);
    if (!res.ok) throw new Error(`sample ${name}: HTTP ${res.status}`);
    const buffer = await ctx.decodeAudioData(await res.arrayBuffer());
    buffers.push({ midi: sampleMidi(name), buffer });
    done++;
    progressBar.style.width = `${Math.round(done / SAMPLE_FILES.length * 100)}%`;
  }));
  buffers.sort((a, b) => a.midi - b.midi);
  loaderEl.classList.add('hidden');
}

loadSamples().catch(err => {
  loaderText.textContent = `Erreur de chargement : ${err.message}`;
  progressBar.style.background = '#dc2626';
});

/* ---------- Construction du clavier ---------- */
const pianoEl = document.getElementById('piano');
const keyEls = {}; // midi -> element
const WHITE_COUNT = 36;
const WHITE_W = 100 / WHITE_COUNT;
const BLACK_W = WHITE_W * 0.62;
const BLACK_SHIFT = { 1: -0.09, 3: 0.09, 6: -0.11, 8: 0, 10: 0.11 }; // décalage réaliste

(function buildKeyboard() {
  const blacks = [];
  let whiteIdx = 0;
  for (let midi = FIRST_MIDI; midi <= LAST_MIDI; midi++) {
    const pc = midi % 12;
    const el = document.createElement('div');
    el.dataset.midi = midi;
    const vp = midiToVpChar[midi];
    el.innerHTML = `<span class="lbl lbl-key">${vp === '<' ? '&lt;' : vp}</span><span class="lbl lbl-note">${noteName(midi)}</span>`;
    if (BLACK_PCS.has(pc)) {
      el.className = 'key black';
      el.style.left = `${whiteIdx * WHITE_W - BLACK_W / 2 + BLACK_SHIFT[pc] * WHITE_W}%`;
      el.style.width = `${BLACK_W}%`;
      blacks.push(el);
    } else {
      el.className = 'key white' + (midi === 60 ? ' c4' : '');
      el.style.left = `${whiteIdx * WHITE_W}%`;
      el.style.width = `${WHITE_W}%`;
      pianoEl.appendChild(el);
      whiteIdx++;
    }
    keyEls[midi] = el;
  }
  blacks.forEach(el => pianoEl.appendChild(el)); // au-dessus des blanches
})();

function setKeyDown(midi, down) {
  keyEls[midi]?.classList.toggle('down', down);
}

/* ---------- Affichage note courante ---------- */
const ndNote = document.getElementById('ndNote');
const ndKey = document.getElementById('ndKey');
function showNote(midi) {
  ndNote.textContent = noteName(midi + transpose);
  const vp = midiToVpChar[midi];
  ndKey.textContent = vp ? `touche ${vp}` : '';
}

/* ---------- Clavier physique ---------- */
const heldByCode = new Map(); // e.code -> midi joué

window.addEventListener('keydown', e => {
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  if (e.target.closest?.('input, textarea')) return; // saisie dans la partition

  if (e.code === 'Space') {
    e.preventDefault();
    if (!e.repeat) setPedal(true);
    return;
  }
  if (e.repeat) return;
  let midi = vpCharToMidi[e.key];
  /* Mode partition : tolérance sur Maj. Après un chiffre d'accord tapé avec
     Maj (AZERTY), Maj traîne souvent sur la note suivante ('w' devient 'W').
     Si la note jouée n'est pas attendue mais que sa variante avec/sans Maj
     l'est, on joue la note attendue. */
  if (sheetPos >= 0 && (midi === undefined || !sheetExpected.has(midi))) {
    const sib = siblingChar(e.key);
    const alt = sib === undefined ? undefined : vpCharToMidi[sib];
    if (alt !== undefined && sheetExpected.has(alt)) midi = alt;
  }
  if (midi === undefined) return;
  e.preventDefault();
  // keyup perdu (changement de focus, Alt+Tab…) : on relâche l'ancienne note
  const stuck = heldByCode.get(e.code);
  if (stuck !== undefined) noteOff(stuck);
  heldByCode.set(e.code, midi); // relâchement suivi par touche physique
  noteOn(midi);
});

window.addEventListener('keyup', e => {
  if (e.code === 'Space') { setPedal(false); return; }
  const midi = heldByCode.get(e.code);
  if (midi === undefined) return;
  heldByCode.delete(e.code);
  noteOff(midi);
});

window.addEventListener('blur', () => {
  heldByCode.forEach(midi => noteOff(midi));
  heldByCode.clear();
  setPedal(false);
});

/* ---------- Souris / tactile (glissando multi-doigts) ---------- */
const pointerNotes = new Map(); // pointerId -> midi

function keyFromPoint(x, y) {
  const el = document.elementFromPoint(x, y);
  const key = el?.closest?.('.key');
  return key ? parseInt(key.dataset.midi, 10) : null;
}

pianoEl.addEventListener('pointerdown', e => {
  e.preventDefault();
  resumeCtx();
  const midi = keyFromPoint(e.clientX, e.clientY);
  if (midi === null) return;
  const rect = keyEls[midi].getBoundingClientRect();
  const velocity = 0.45 + 0.55 * Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
  pointerNotes.set(e.pointerId, midi);
  noteOn(midi, velocity);
});

window.addEventListener('pointermove', e => {
  if (!pointerNotes.has(e.pointerId)) return;
  const midi = keyFromPoint(e.clientX, e.clientY);
  const current = pointerNotes.get(e.pointerId);
  if (midi === current) return;
  noteOff(current);
  if (midi !== null) {
    pointerNotes.set(e.pointerId, midi);
    noteOn(midi, 0.8);
  } else {
    pointerNotes.delete(e.pointerId);
  }
});

function endPointer(e) {
  const midi = pointerNotes.get(e.pointerId);
  if (midi === undefined) return;
  pointerNotes.delete(e.pointerId);
  noteOff(midi);
}
window.addEventListener('pointerup', endPointer);
window.addEventListener('pointercancel', endPointer);
pianoEl.addEventListener('contextmenu', e => e.preventDefault());

/* ---------- Contrôles ---------- */
const btnSustain = document.getElementById('btnSustain');
const btnLabels = document.getElementById('btnLabels');
const labelsText = document.getElementById('labelsText');
const volumeEl = document.getElementById('volume');

function updateSustainUi() {
  const on = sustainOn();
  btnSustain.classList.toggle('on', on);
  btnSustain.setAttribute('aria-pressed', String(pedalLocked));
}

updateSustainUi(); // sustain actif par défaut

btnSustain.addEventListener('click', () => {
  pedalLocked = !pedalLocked;
  updateSustainUi();
  if (!sustainOn()) {
    sustainedVoices.forEach(v => releaseVoice(v, 0.3));
    sustainedVoices.clear();
  }
});

const LABEL_MODES = [
  ['keys', 'Clavier'],
  ['notes', 'Notes'],
  ['none', 'Aucune'],
];
let labelIdx = 0;
btnLabels.addEventListener('click', () => {
  labelIdx = (labelIdx + 1) % LABEL_MODES.length;
  const [mode, text] = LABEL_MODES[labelIdx];
  document.body.dataset.labels = mode;
  labelsText.textContent = text;
});

volumeEl.addEventListener('input', () => {
  masterGain.gain.setTargetAtTime(volumeEl.value / 100, ctx.currentTime, 0.02);
});

/* ---------- Transposition (±12 demi-tons, comme virtualpiano.net) ---------- */
const trDown = document.getElementById('trDown');
const trUp = document.getElementById('trUp');
const trVal = document.getElementById('trVal');

function setTranspose(value) {
  transpose = Math.max(-12, Math.min(12, value));
  trVal.textContent = (transpose > 0 ? '+' : '') + transpose;
  trVal.classList.toggle('active', transpose !== 0);
  for (let midi = FIRST_MIDI; midi <= LAST_MIDI; midi++) {
    keyEls[midi].querySelector('.lbl-note').textContent = noteName(midi + transpose);
  }
}
trDown.addEventListener('click', () => setTranspose(transpose - 1));
trUp.addEventListener('click', () => setTranspose(transpose + 1));
trVal.addEventListener('click', () => setTranspose(0));

/* ---------- Partition Virtual Piano (Key Assist) ---------- */
const btnSheet = document.getElementById('btnSheet');
const sheetPanel = document.getElementById('sheetPanel');
const sheetInput = document.getElementById('sheetInput');
const sheetStart = document.getElementById('sheetStart');
const sheetStop = document.getElementById('sheetStop');
const sheetProgress = document.getElementById('sheetProgress');

let sheetSteps = [];        // [[midi, ...], ...] — un pas = note ou accord [xyz]
let sheetPos = -1;
let sheetExpected = new Set();

function parseSheet(text) {
  const steps = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '{') { // directive de vitesse {x2} : ignorée en mode Suivre
      const end = text.indexOf('}', i);
      i = end === -1 ? text.length : end + 1;
      continue;
    }
    if (c === '[') {
      const end = text.indexOf(']', i);
      const group = end === -1 ? text.slice(i + 1) : text.slice(i + 1, end);
      const notes = [...new Set([...group].map(ch => vpCharToMidi[ch]).filter(m => m !== undefined))];
      if (notes.length) steps.push(notes);
      i = end === -1 ? text.length : end + 1;
    } else {
      const midi = vpCharToMidi[c];
      if (midi !== undefined) steps.push([midi]);
      i++;
    }
  }
  return steps;
}

function clearHints() {
  sheetExpected.forEach(m => keyEls[m].classList.remove('hint'));
  sheetExpected = new Set();
}

function sheetNextStep() {
  clearHints();
  sheetPos++;
  if (sheetPos >= sheetSteps.length) {
    stopSheet(true);
    return;
  }
  sheetExpected = new Set(sheetSteps[sheetPos]);
  sheetExpected.forEach(m => keyEls[m].classList.add('hint'));
  sheetProgress.classList.remove('done');
  sheetProgress.textContent = `${sheetPos + 1} / ${sheetSteps.length}`;
}

function sheetNotePlayed(midi) {
  if (sheetPos < 0 || !sheetExpected.has(midi)) return;
  sheetExpected.delete(midi);
  keyEls[midi].classList.remove('hint');
  if (sheetExpected.size === 0) sheetNextStep();
}

function startSheet() {
  sheetSteps = parseSheet(sheetInput.value);
  if (!sheetSteps.length) {
    sheetProgress.classList.remove('done');
    sheetProgress.textContent = 'Aucune note reconnue dans la partition.';
    return;
  }
  sheetPos = -1;
  sheetStart.disabled = true;
  sheetStop.disabled = false;
  sheetNextStep();
}

function stopSheet(finished = false) {
  clearHints();
  sheetPos = -1;
  sheetStart.disabled = false;
  sheetStop.disabled = true;
  sheetProgress.classList.toggle('done', finished);
  sheetProgress.textContent = finished ? 'Partition terminée, bravo !' : '';
}

/* ---------- Lecture automatique de la partition ---------- */
const autoStart = document.getElementById('autoStart');
const tempoEl = document.getElementById('tempo');
const tempoDown = document.getElementById('tempoDown');
const tempoUp = document.getElementById('tempoUp');
const tempoVal = document.getElementById('tempoVal');

function updateTempoVal() {
  tempoVal.textContent = Number(tempoEl.value).toLocaleString('fr-FR');
}
function nudgeTempo(delta) {
  const step = Number(tempoEl.step) || 0.5;
  const next = Number(tempoEl.value) + delta * step;
  tempoEl.value = Math.min(Number(tempoEl.max), Math.max(Number(tempoEl.min), next));
  updateTempoVal();
}
tempoDown.addEventListener('click', () => nudgeTempo(-1));
tempoUp.addEventListener('click', () => nudgeTempo(1));
tempoEl.addEventListener('input', updateTempoVal);
updateTempoVal();

const autoPause = document.getElementById('autoPause');
const autoPauseText = document.getElementById('autoPauseText');
const autoPauseIcon = document.getElementById('autoPauseIcon');

let autoTimer = null;
let autoIdx = 0;
let autoSteps = [];
let autoPaused = false;
let autoMul = 1;      // multiplicateur de vitesse courant ({x2}, {x0.5}…)
let autoPlayed = 0;   // pas joués (hors directives)
let autoPlayable = 0; // total de pas jouables

function setPauseUi(paused) {
  autoPauseText.textContent = paused ? 'Reprendre' : 'Pause';
  autoPauseIcon.setAttribute('d', paused ? 'M8 5v14l11-7z' : 'M7 5h4v14H7zM13 5h4v14h-4z');
}

/* Comme parseSheet, mais conserve les silences (espace / retour ligne = un temps)
   et les directives de vitesse : {x2} = 2× plus vite, {x0.5} = 2× plus lent,
   {x1} = retour au tempo du curseur. */
function parseSheetTimed(text) {
  const steps = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '{') {
      const end = text.indexOf('}', i);
      const body = (end === -1 ? text.slice(i + 1) : text.slice(i + 1, end)).trim();
      const m = body.match(/^x?\s*(\d+(?:[.,]\d+)?)$/i);
      if (m) {
        const mul = parseFloat(m[1].replace(',', '.'));
        if (mul > 0) steps.push({ mul: Math.min(8, Math.max(0.1, mul)) });
      }
      i = end === -1 ? text.length : end + 1;
      continue;
    }
    if (c === '[') {
      const end = text.indexOf(']', i);
      const group = end === -1 ? text.slice(i + 1) : text.slice(i + 1, end);
      const notes = [...new Set([...group].map(ch => vpCharToMidi[ch]).filter(m => m !== undefined))];
      if (notes.length) steps.push({ notes });
      i = end === -1 ? text.length : end + 1;
    } else {
      if (vpCharToMidi[c] !== undefined) steps.push({ notes: [vpCharToMidi[c]] });
      else if (c === ' ') steps.push({ rest: true }); // retour à la ligne = simple mise en page
      i++;
    }
  }
  return steps;
}

function autoTick() {
  let step = autoSteps[autoIdx++];
  while (step && step.mul !== undefined) { // les directives ne consomment pas de temps
    autoMul = step.mul;
    step = autoSteps[autoIdx++];
  }
  if (!step) { stopAuto(true); return; }
  autoPlayed++;
  const tick = 1000 / (Number(tempoEl.value) * autoMul); // curseur × directive
  if (step.notes) {
    step.notes.forEach(m => noteOn(m, 0.85));
    setTimeout(() => step.notes.forEach(m => noteOff(m)), tick * 0.92);
    sheetProgress.textContent = `auto ${autoPlayed} / ${autoPlayable}` + (autoMul !== 1 ? ` ×${autoMul}` : '');
  }
  autoTimer = setTimeout(autoTick, tick);
}

function startAuto() {
  stopSheet(false);
  stopAuto(false);
  autoSteps = parseSheetTimed(sheetInput.value);
  if (!autoSteps.some(s => s.notes)) {
    sheetProgress.classList.remove('done');
    sheetProgress.textContent = 'Aucune note reconnue dans la partition.';
    return;
  }
  autoIdx = 0;
  autoMul = 1;
  autoPlayed = 0;
  autoPlayable = autoSteps.filter(s => s.mul === undefined).length;
  autoPaused = false;
  setPauseUi(false);
  sheetStart.disabled = true;
  autoStart.disabled = true;
  sheetStop.disabled = false;
  autoPause.disabled = false;
  resumeCtx();
  autoTick();
}

function stopAuto(finished = false) {
  if (autoTimer === null && !autoPaused && !finished) return;
  clearTimeout(autoTimer);
  autoTimer = null;
  autoPaused = false;
  setPauseUi(false);
  sheetStart.disabled = false;
  autoStart.disabled = false;
  sheetStop.disabled = true;
  autoPause.disabled = true;
  if (finished) {
    sheetProgress.classList.add('done');
    sheetProgress.textContent = 'Partition terminée.';
  }
}

autoPause.addEventListener('click', () => {
  if (autoPaused) {                 // reprendre là où on s'était arrêté
    autoPaused = false;
    setPauseUi(false);
    resumeCtx();
    autoTick();
  } else if (autoTimer !== null) {  // mettre en pause
    clearTimeout(autoTimer);
    autoTimer = null;
    autoPaused = true;
    setPauseUi(true);
    sheetProgress.textContent = `pause ${autoPlayed} / ${autoPlayable}`;
  }
});

sheetStart.addEventListener('click', () => { stopAuto(false); startSheet(); });
autoStart.addEventListener('click', startAuto);
sheetStop.addEventListener('click', () => { stopAuto(false); stopSheet(false); });

/* ---------- Bibliothèque de partitions ---------- */
const libSelect = document.getElementById('libSelect');
const libSave = document.getElementById('libSave');
const libDelete = document.getElementById('libDelete');
const libExport = document.getElementById('libExport');
const libImport = document.getElementById('libImport');
const libFile = document.getElementById('libFile');
const LIB_KEY = 'piano.library';

const LIB_SEED = {
  'Nocturne en Do': `8 w t u o u t w\n5 w y o d o y w\n6 e t u p u t e\n4 q t i p i t q\n\n[8w] t u o [ts] o u t\n[5w] y o d [yd] d o y\n[6e] t u p [tf] p u t\n[4q] t i p [ts] s i t\n\n[8ts] f d s d [5rd] s a\n[6ep] s d f d [4qs] d f\n[8ts] f g h g [5rd] f d\n[6ep] f d s d [4qp] a p\n\n[8w] [ts] [uf] [oh] [uf] [ts] [8w] t\n[5w] [yd] [oh] [dk] [oh] [yd] [5w] y\n[6e] [tf] [us] [pf] [us] [tf] [6e] t\n[4q] [is] [pd] [sf] [pd] [is] [4q] q\n\n8 w t u o u t w\n[4ip] o i [5od] o y\n[8tuo]  [1358t]`,
  'Lumière': `6 e t u p u t e\n4 q t i p i t q\n8 w t u o u t w\n5 w y o d o y w\n\n[6e] t u p s p u t\n[4q] t i p s p i t\n[8w] t u o s o u t\n[5w] y o a d a o y\n\n[6p] f f d s [4s] d f\n[8s] f h f d [5d] s a\n[6p] f f d s [4s] d f\n[8f] d s a p [5o] p a\n\n[6ps] f [ef] d [ps] s [4is] d\n[8ts] f [uf] h [os] f [5yd] d\n[6ps] f [ef] g [ps] h [4is] g\n[8os] f d s [5oa] a p o\n\n6 e t u p u t e\n[4qi] t i p [5wo] o y w\n[6etp]  [6ep]`,
  'Petite Valse': `8 [tuo] [tuo] 5 [yoa] [yoa]\n6 [tep] [tep] 4 [qti] [qti]\n8 [tuo] [tuo] 5 [yoa] [yoa]\n[4qt] [qti] [qti] [5wy] [yoa] [yoa]\n\n8 [uo] s 5 [oa] d\n6 [up] s 4 [ip] p\n8 [uo] f 5 [oa] d\n[8t] s a [5w] o y\n\n8 [uo] s 5 [oa] d\n6 [up] f 4 [ip] g\n[8t] f d [5r] d a\n[8tuos]  [8tuos]`,
  'Clair-Obscur': `[29] y i p y i p\n[29] y i p d p i\n[5E] o P d o P d\n[5E] o P d o P d\n[63] e T u e T u\n[63] e T u p u T\n[29] y i p y i p\n[29] y i p y i p\n\n[29] d d d [5E] d d\n[63] T u p [29] p i\n[29] f f f [5E] d d\n[63] u p y [29] y\n[29yip]`,
  'Canon en Ré (Pachelbel)': `{x0.5} 9 6 7 $ 5 2 5 6 {x1}\n[9yI] y [6Tu] u [7yI] r [$Te] e\n[5wr] w [2yI] y [5wr] r [6Tu] u\n\n[9IG] y [6Tf] u [7yd] r [$TS] e\n[5ra] w [2Ip] y [5ra] r [6TS] u\n[9Id] y [6TS] u [7ya] r [$Tp] e\n[5wo] w [2yI] 9 [5wo] r [6Tu] u\n\n{x2}\n[9y] I p d [6e] T u p\n[7r] y I a [$Q] e T I\n[5w] r y o [2y] I p d\n[5w] r y o [6e] T u p\n[9d] p I y [6p] u T e\n[7a] I y r [$I] T e Q\n[5o] y r w [2d] p I y\n[5o] y r w [6p] u T e\n\n{x1}\n[9IG] f [6Tf] d [7yd] S [$TS] a\n[5ra] o [2Ip] I [5ra] a [6TS] S\n{x0.5}\n[29yIpd]`,
};

function loadLib() {
  try {
    const raw = localStorage.getItem(LIB_KEY);
    if (raw === null) { saveLibData(LIB_SEED); return { ...LIB_SEED }; }
    return JSON.parse(raw) || {};
  } catch (_) { return {}; }
}
function saveLibData(lib) {
  try { localStorage.setItem(LIB_KEY, JSON.stringify(lib)); } catch (_) {}
}
function refreshLibSelect(selected = '') {
  const lib = loadLib();
  libSelect.innerHTML = '<option value="">— Bibliothèque —</option>' +
    Object.keys(lib).sort((a, b) => a.localeCompare(b, 'fr'))
      .map(n => `<option${n === selected ? ' selected' : ''}>${n.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</option>`)
      .join('');
}
refreshLibSelect();

libSelect.addEventListener('change', () => {
  const lib = loadLib();
  if (libSelect.value && lib[libSelect.value] !== undefined) {
    stopAuto(false); stopSheet(false);
    sheetInput.value = lib[libSelect.value];
  }
});
libSave.addEventListener('click', () => {
  if (!sheetInput.value.trim()) { sheetProgress.textContent = 'Rien à enregistrer.'; return; }
  const name = prompt('Nom de la partition :', libSelect.value || 'Ma partition');
  if (!name) return;
  const lib = loadLib();
  lib[name] = sheetInput.value;
  saveLibData(lib);
  refreshLibSelect(name);
  sheetProgress.classList.remove('done');
  sheetProgress.textContent = `« ${name} » enregistrée.`;
});
libDelete.addEventListener('click', () => {
  if (!libSelect.value) return;
  if (!confirm(`Supprimer « ${libSelect.value} » ?`)) return;
  const lib = loadLib();
  delete lib[libSelect.value];
  saveLibData(lib);
  refreshLibSelect();
  sheetProgress.textContent = 'Partition supprimée.';
});
libExport.addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(loadLib(), null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'piano-partitions.json';
  a.click();
  URL.revokeObjectURL(a.href);
});
libImport.addEventListener('click', () => libFile.click());
libFile.addEventListener('change', async () => {
  const file = libFile.files[0];
  libFile.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (typeof data !== 'object' || Array.isArray(data)) throw new Error('format');
    const lib = loadLib();
    let n = 0;
    for (const [name, text] of Object.entries(data)) {
      if (typeof text === 'string') { lib[name] = text; n++; }
    }
    saveLibData(lib);
    refreshLibSelect();
    sheetProgress.textContent = `${n} partition(s) importée(s).`;
  } catch (_) {
    sheetProgress.textContent = 'Fichier invalide (JSON { "nom": "partition" } attendu).';
  }
});

/* ---------- Partage par lien ---------- */
const shareBtn = document.getElementById('shareBtn');

function b64urlEncode(str) {
  return btoa(String.fromCharCode(...new TextEncoder().encode(str)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(b64) {
  const bin = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
}

shareBtn.addEventListener('click', async () => {
  const text = sheetInput.value.trim();
  if (!text) { sheetProgress.textContent = 'Rien à partager.'; return; }
  const url = `${location.origin}${location.pathname}#p=${b64urlEncode(text)}`;
  try {
    await navigator.clipboard.writeText(url);
    sheetProgress.classList.remove('done');
    sheetProgress.textContent = 'Lien copié dans le presse-papiers !';
  } catch (_) {
    prompt('Copiez le lien :', url);
  }
});

/* ---------- Enregistreur : jouer → générer la partition ---------- */
const recBtn = document.getElementById('recBtn');
let recording = false;
let recEvents = [];

function recCapture(midi) {
  if (recording) recEvents.push({ midi, t: performance.now() });
}

function eventsToSheet(events) {
  if (!events.length) return '';
  const tick = 1000 / Number(tempoEl.value); // grille = vitesse du curseur tempo
  const groups = [];
  for (const ev of events) {
    const g = groups[groups.length - 1];
    if (g && ev.t - g.t <= 80) { // notes quasi simultanées = accord
      if (!g.midis.includes(ev.midi)) g.midis.push(ev.midi);
    } else {
      groups.push({ t: ev.t, midis: [ev.midi] });
    }
  }
  let out = '';
  groups.forEach((g, i) => {
    if (i > 0) {
      const gap = Math.max(1, Math.round((g.t - groups[i - 1].t) / tick));
      out += ' '.repeat(Math.min(gap - 1, 8));
    }
    const chars = g.midis.map(m => midiToVpChar[m]).filter(Boolean);
    out += chars.length > 1 ? `[${chars.join('')}]` : (chars[0] || '');
  });
  return out;
}

recBtn.addEventListener('click', () => {
  if (!recording) {
    stopAuto(false); stopSheet(false);
    recording = true;
    recEvents = [];
    recBtn.classList.add('recording');
    sheetProgress.classList.remove('done');
    sheetProgress.textContent = '● Enregistrement… jouez, puis recliquez sur Rec.';
  } else {
    recording = false;
    recBtn.classList.remove('recording');
    const text = eventsToSheet(recEvents);
    if (text) {
      sheetInput.value = text;
      sheetProgress.textContent = `Partition générée — ${recEvents.length} notes (grille : curseur tempo).`;
    } else {
      sheetProgress.textContent = 'Rien enregistré.';
    }
  }
});

/* ---------- Agrandissement du panneau partition ---------- */
const sheetMax = document.getElementById('sheetMax');

function setSheetMax(on) {
  sheetPanel.classList.toggle('max', on);
  sheetMax.setAttribute('aria-pressed', String(on));
  sheetMax.title = on ? 'Réduire le panneau (Échap)' : 'Agrandir le panneau en plein écran (Échap pour réduire)';
}
sheetMax.addEventListener('click', () => setSheetMax(!sheetPanel.classList.contains('max')));
window.addEventListener('keydown', e => {
  if (e.key === 'Escape' && sheetPanel.classList.contains('max')) setSheetMax(false);
});

/* ---------- Position du panneau partition (dock) ---------- */
const arena = document.getElementById('arena');
const dockButtons = [...document.querySelectorAll('.dock [data-dock]')];

function setDock(dock) {
  arena.dataset.dock = dock;
  dockButtons.forEach(b => b.classList.toggle('active', b.dataset.dock === dock));
  try { localStorage.setItem('piano.dock', dock); } catch (_) {}
}
dockButtons.forEach(b => b.addEventListener('click', () => setDock(b.dataset.dock)));
setDock(localStorage.getItem('piano.dock') || 'bottom');

function setSheetVisible(show) {
  sheetPanel.hidden = !show;
  btnSheet.setAttribute('aria-pressed', String(show));
  if (!show) { stopAuto(false); stopSheet(false); }
  uiPrefs.sheet = show;
  saveUiPrefs();
  optSheet.checked = show;
}
btnSheet.addEventListener('click', () => setSheetVisible(sheetPanel.hidden));

/* ---------- Réglages d'affichage (afficher / masquer) ---------- */
const btnSettings = document.getElementById('btnSettings');
const settingsPop = document.getElementById('settingsPop');
const optSheet = document.getElementById('optSheet');
const optFx = document.getElementById('optFx');
const optHint = document.getElementById('optHint');
const optSig = document.getElementById('optSig');
const optReverb = document.getElementById('optReverb');
const hintLine = document.getElementById('hintLine');
const signatureEl = document.getElementById('signature');

let uiPrefs = { sheet: false, hint: true, sig: true, fx: true, reverb: 25 };
try { Object.assign(uiPrefs, JSON.parse(localStorage.getItem('piano.ui') || '{}')); } catch (_) {}
function saveUiPrefs() {
  try { localStorage.setItem('piano.ui', JSON.stringify(uiPrefs)); } catch (_) {}
}

function applyUiPrefs() {
  hintLine.hidden = !uiPrefs.hint;
  signatureEl.hidden = !uiPrefs.sig;
  sheetPanel.hidden = !uiPrefs.sheet;
  btnSheet.setAttribute('aria-pressed', String(uiPrefs.sheet));
  optHint.checked = uiPrefs.hint;
  optSig.checked = uiPrefs.sig;
  optSheet.checked = uiPrefs.sheet;
  optFx.checked = uiPrefs.fx;
  optReverb.value = uiPrefs.reverb;
  setReverb(uiPrefs.reverb);
}
applyUiPrefs();

optFx.addEventListener('change', () => { uiPrefs.fx = optFx.checked; saveUiPrefs(); });

/* ---------- Réverb ---------- */
optReverb.addEventListener('input', () => {
  uiPrefs.reverb = Number(optReverb.value);
  setReverb(uiPrefs.reverb);
  saveUiPrefs();
});

/* ---------- Métronome ---------- */
const optMetro = document.getElementById('optMetro');
const optMetroBpm = document.getElementById('optMetroBpm');
const metroBpmVal = document.getElementById('metroBpmVal');
let metroNext = 0;
let metroBeat = 0;

function metroClick(t, accent) {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.frequency.value = accent ? 1568 : 1047;
  g.gain.setValueAtTime(accent ? 0.4 : 0.22, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
  osc.connect(g);
  g.connect(compressor); // sec, sans réverb
  osc.start(t);
  osc.stop(t + 0.08);
}
setInterval(() => {
  if (!optMetro.checked) return;
  const spb = 60 / Number(optMetroBpm.value);
  if (metroNext < ctx.currentTime) { metroNext = ctx.currentTime + 0.06; metroBeat = 0; }
  while (metroNext < ctx.currentTime + 0.12) { // planification avec léger lookahead
    metroClick(metroNext, metroBeat % 4 === 0);
    metroNext += spb;
    metroBeat++;
  }
}, 30);
optMetro.addEventListener('change', () => { resumeCtx(); metroNext = 0; });
optMetroBpm.addEventListener('input', () => { metroBpmVal.textContent = optMetroBpm.value; });

/* Flèches de réinitialisation (réverb 25, BPM 100) */
document.getElementById('reverbReset').addEventListener('click', e => {
  e.preventDefault(); // ne pas transférer le clic au slider via le label
  optReverb.value = 25;
  optReverb.dispatchEvent(new Event('input'));
});
document.getElementById('metroBpmReset').addEventListener('click', e => {
  e.preventDefault();
  optMetroBpm.value = 100;
  optMetroBpm.dispatchEvent(new Event('input'));
  metroNext = 0;
});

optSheet.addEventListener('change', () => setSheetVisible(optSheet.checked));
optHint.addEventListener('change', () => { uiPrefs.hint = optHint.checked; saveUiPrefs(); applyUiPrefs(); });
optSig.addEventListener('change', () => { uiPrefs.sig = optSig.checked; saveUiPrefs(); applyUiPrefs(); });

btnSettings.addEventListener('click', () => {
  const open = settingsPop.hidden;
  settingsPop.hidden = !open;
  btnSettings.setAttribute('aria-expanded', String(open));
});
document.addEventListener('pointerdown', e => {
  if (!settingsPop.hidden && !e.target.closest('.settings-wrap')) {
    settingsPop.hidden = true;
    btnSettings.setAttribute('aria-expanded', 'false');
  }
});

/* Après un clic souris, on retire le focus des contrôles pour que le clavier
   reste entièrement dédié au piano (Espace = pédale, jamais un bouton). */
[btnSustain, btnLabels, volumeEl, trDown, trUp, trVal, btnSheet,
 sheetStart, sheetStop, autoStart, autoPause, tempoEl, tempoDown, tempoUp,
 recBtn, shareBtn, libSave, libDelete, libExport, libImport, sheetMax, ...dockButtons].forEach(el =>
  el.addEventListener('pointerup', () => el.blur())
);

/* ---------- Web MIDI (bonus : clavier maître) ---------- */
if (navigator.requestMIDIAccess) {
  navigator.requestMIDIAccess().then(access => {
    const badge = document.getElementById('midiBadge');
    const refresh = () => { badge.hidden = access.inputs.size === 0; };
    const attach = input => {
      input.onmidimessage = msg => {
        const [status, note, vel] = msg.data;
        const cmd = status & 0xf0;
        if (cmd === 0x90 && vel > 0) noteOn(note - transpose, vel / 127);
        else if (cmd === 0x80 || (cmd === 0x90 && vel === 0)) noteOff(note - transpose);
        else if (cmd === 0xb0 && note === 64) setPedal(vel >= 64); // CC64 sustain
      };
    };
    access.inputs.forEach(attach);
    access.onstatechange = e => {
      if (e.port.type === 'input' && e.port.state === 'connected') attach(e.port);
      refresh();
    };
    refresh();
  }).catch(() => {});
}

/* ---------- Feu d'artifice de notes (clé de sol, croches, étoiles) ---------- */
const fxCanvas = document.getElementById('fx');
const fxCtx = fxCanvas.getContext('2d');
const FX_GLYPHS = ['♪', '♫', '♬', '♩', '𝄞']; // ♪ ♫ ♬ ♩ 𝄞 (clé de sol)
const FX_STARS = ['✦', '✧', '⋆'];                            // ✦ ✧ ⋆
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
let fxParticles = [];
let fxRunning = false;
let fxLastTs = 0;

function fxResize() {
  const dpr = window.devicePixelRatio || 1;
  const r = fxCanvas.getBoundingClientRect();
  fxCanvas.width = Math.round(r.width * dpr);
  fxCanvas.height = Math.round(r.height * dpr);
  fxCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', fxResize);
new ResizeObserver(fxResize).observe(fxCanvas); // suit aussi les changements de dock/panneau
fxResize();

function spawnNoteFx(midi) {
  if (!uiPrefs.fx || reducedMotion) return;
  const key = keyEls[midi];
  if (!key) return;
  const kr = key.getBoundingClientRect();
  const cr = fxCanvas.getBoundingClientRect();
  const x = kr.left + kr.width / 2 - cr.left;
  const y = kr.top - cr.top - 4; // juste au-dessus de la touche
  // couleur selon la hauteur : ambre (graves) → bleu (aigus)
  const hue = 40 + ((midi - FIRST_MIDI) / (LAST_MIDI - FIRST_MIDI)) * 180;

  // le symbole musical principal, qui grandit en s'élevant
  fxParticles.push({
    x, y, glyph: FX_GLYPHS[Math.floor(Math.random() * FX_GLYPHS.length)],
    vx: (Math.random() - 0.5) * 40,
    vy: -(90 + Math.random() * 70),
    size0: 10, size1: 30 + Math.random() * 22,
    rot: (Math.random() - 0.5) * 0.5, vr: (Math.random() - 0.5) * 1.6,
    life: 1.5 + Math.random() * 0.7, t: 0, hue, star: false,
  });
  // la gerbe d'étoiles autour
  const n = 3 + Math.floor(Math.random() * 3);
  for (let i = 0; i < n; i++) {
    fxParticles.push({
      x: x + (Math.random() - 0.5) * 14, y,
      glyph: FX_STARS[Math.floor(Math.random() * FX_STARS.length)],
      vx: (Math.random() - 0.5) * 130,
      vy: -(50 + Math.random() * 130),
      size0: 6, size1: 10 + Math.random() * 10,
      rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 4,
      life: 0.8 + Math.random() * 0.7, t: 0,
      hue: hue + (Math.random() - 0.5) * 40, star: true,
    });
  }
  if (fxParticles.length > 400) fxParticles.splice(0, fxParticles.length - 400); // garde-fou perfs
  if (!fxRunning) {
    fxRunning = true;
    fxLastTs = performance.now();
    requestAnimationFrame(fxLoop);
  }
}

function fxLoop(ts) {
  const dt = Math.min(0.05, (ts - fxLastTs) / 1000);
  fxLastTs = ts;
  const r = fxCanvas.getBoundingClientRect();
  fxCtx.clearRect(0, 0, r.width, r.height);

  fxParticles = fxParticles.filter(p => (p.t += dt) < p.life);
  for (const p of fxParticles) {
    const k = p.t / p.life;                          // 0 → 1
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vy *= 1 - 0.5 * dt;                            // la montée ralentit doucement
    p.rot += p.vr * dt;
    const size = p.size0 + (p.size1 - p.size0) * Math.sin(k * Math.PI / 2); // petit → grand
    const alpha = p.star
      ? (1 - k) * (0.6 + 0.4 * Math.sin(p.t * 22))   // les étoiles scintillent
      : k < 0.85 ? 1 : (1 - k) / 0.15;               // la note s'éteint à la fin
    fxCtx.save();
    fxCtx.translate(p.x, p.y);
    fxCtx.rotate(p.rot);
    fxCtx.font = `${size}px "Segoe UI Symbol", serif`;
    fxCtx.textAlign = 'center';
    fxCtx.textBaseline = 'middle';
    fxCtx.shadowColor = `hsla(${p.hue}, 95%, 65%, ${alpha})`;
    fxCtx.shadowBlur = p.star ? 6 : 14;
    fxCtx.fillStyle = `hsla(${p.hue}, 90%, ${p.star ? 80 : 70}%, ${alpha})`;
    fxCtx.fillText(p.glyph, 0, 0);
    fxCtx.restore();
  }

  if (fxParticles.length) requestAnimationFrame(fxLoop);
  else { fxRunning = false; fxCtx.clearRect(0, 0, r.width, r.height); }
}

/* ---------- PWA : service worker + indicateur hors-ligne ---------- */
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
const offlineBadge = document.getElementById('offlineBadge');
function updateOnline() { offlineBadge.hidden = navigator.onLine; }
window.addEventListener('online', updateOnline);
window.addEventListener('offline', updateOnline);
updateOnline();

/* ---------- Partition reçue par lien (#p=…) ---------- */
if (location.hash.startsWith('#p=')) {
  try {
    const text = b64urlDecode(location.hash.slice(3));
    if (text.trim()) {
      sheetInput.value = text;
      setSheetVisible(true);
      sheetProgress.textContent = 'Partition reçue par lien.';
    }
  } catch (_) { /* lien invalide : ignoré */ }
}
