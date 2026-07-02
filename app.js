/* Carousel Studio — editor de carrossel estilo SCRL
   Canvas horizontal contínuo: elementos podem atravessar slides.
   Exporta cada slide como PNG (1080x1350 ou 1080x1080). */

'use strict';

// ---------------------------------------------------------------- state

const LS_KEY = 'carousel-studio-v1';

let state = {
  W: 1080,
  H: 1350,
  slides: 3,
  bg: '#ffffff',
  elements: [], // {id, type:'image'|'text', x,y,w,h,z, ...}
};

// detecção mobile: toque + tela estreita → layout adaptado (barra inferior, gaveta)
const IS_MOBILE = matchMedia('(pointer: coarse)').matches || window.innerWidth < 700;
const MARGIN = IS_MOBILE ? 12 : 40; // respiro em volta da tira
if (IS_MOBILE) document.body.classList.add('mobile');

let zoom = 0.35;
let selectedId = null;
let cropId = null; // imagem em modo "reposicionar" (pan do crop)
let undoStack = [];
let redoStack = [];
let idSeq = 1;

const imgCache = new Map(); // src -> HTMLImageElement

const $ = (s) => document.querySelector(s);
const viewport = $('#viewport');
const stripBox = $('#stripBox');
const strip = $('#strip');
const panel = $('#panel');
const panelContent = $('#panelContent');
const fileInput = $('#fileInput');

const FONTS = [
  ['Inter', 'Inter'],
  ['Playfair Display', 'Playfair Display'],
  ['Bebas Neue', 'Bebas Neue'],
  ['Space Grotesk', 'Space Grotesk'],
  ['Caveat', 'Caveat'],
  ['Georgia', 'Georgia'],
];

const PRESETS = {
  none:  ['Nenhum', ''],
  mono:  ['P&B', 'grayscale(1)'],
  sepia: ['Sépia', 'sepia(.75)'],
  vivid: ['Vívido', 'saturate(1.45) contrast(1.12)'],
  fade:  ['Fade', 'saturate(.72) contrast(.88) brightness(1.06)'],
  cool:  ['Frio', 'saturate(.95) hue-rotate(-10deg) brightness(1.02)'],
  warm:  ['Quente', 'sepia(.28) saturate(1.25)'],
};

function filterCSS(el) {
  const parts = [];
  const p = PRESETS[el.preset || 'none'];
  if (p && p[1]) parts.push(p[1]);
  if ((el.bright ?? 100) !== 100) parts.push(`brightness(${(el.bright ?? 100) / 100})`);
  if ((el.contrast ?? 100) !== 100) parts.push(`contrast(${(el.contrast ?? 100) / 100})`);
  if ((el.sat ?? 100) !== 100) parts.push(`saturate(${(el.sat ?? 100) / 100})`);
  return parts.join(' ');
}

// quanto da foto fica escondido pelo crop cover (0 = nada para reposicionar)
function panRoom(el) {
  if (!el.src || !imgCache.has(el.src)) return { x: 0, y: 0 };
  const img = imgCache.get(el.src);
  const s = Math.max(el.w / img.width, el.h / img.height);
  return { x: img.width * s - el.w, y: img.height * s - el.h };
}
function isPannable(el) {
  const r = panRoom(el);
  return r.x > 1 || r.y > 1;
}

const measureCtx = document.createElement('canvas').getContext('2d');

// ---------------------------------------------------------------- helpers

const uid = () => 'el' + (idSeq++);
const worldW = () => state.slides * state.W;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const sortedEls = () => [...state.elements].sort((a, b) => a.z - b.z);
const getEl = (id) => state.elements.find(e => e.id === id);
const maxZ = () => state.elements.reduce((m, e) => Math.max(m, e.z), 0);

function pushUndo() {
  undoStack.push(JSON.stringify(state));
  if (undoStack.length > 60) undoStack.shift();
  redoStack = [];
}

function undo() {
  if (!undoStack.length) return;
  redoStack.push(JSON.stringify(state));
  state = JSON.parse(undoStack.pop());
  if (selectedId && !getEl(selectedId)) selectedId = null;
  fullRender(); save();
}

function redo() {
  if (!redoStack.length) return;
  undoStack.push(JSON.stringify(state));
  state = JSON.parse(redoStack.pop());
  if (selectedId && !getEl(selectedId)) selectedId = null;
  fullRender(); save();
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(LS_KEY, JSON.stringify(state)); }
    catch (e) { /* quota — segue sem persistir */ }
  }, 400);
}

function restore() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const s = JSON.parse(raw);
    if (s && s.W && Array.isArray(s.elements)) {
      state = s;
      idSeq = state.elements.length
        ? Math.max(...state.elements.map(e => parseInt(e.id.slice(2)) || 0)) + 1
        : 1;
    }
  } catch (e) { /* estado corrompido — começa limpo */ }
}

function loadImage(src) {
  if (imgCache.has(src)) return Promise.resolve(imgCache.get(src));
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => { imgCache.set(src, img); res(img); };
    img.onerror = rej;
    img.src = src;
  });
}

// lê arquivo, reduz para no máx 2200px e devolve dataURL
function fileToDataURL(file) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => {
      const img = new Image();
      img.onload = () => {
        const MAX = 2200;
        const sc = Math.min(1, MAX / Math.max(img.width, img.height));
        if (sc === 1) { imgCache.set(fr.result, img); return res({ src: fr.result, w: img.width, h: img.height }); }
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * sc);
        c.height = Math.round(img.height * sc);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        const url = c.toDataURL('image/jpeg', 0.92);
        res({ src: url, w: c.width, h: c.height });
      };
      img.onerror = rej;
      img.src = fr.result;
    };
    fr.onerror = rej;
    fr.readAsDataURL(file);
  });
}

function pickFile() {
  return new Promise((res) => {
    fileInput.onchange = () => {
      const f = fileInput.files[0];
      fileInput.value = '';
      res(f || null);
    };
    fileInput.click();
  });
}

// quebra texto em linhas usando measureText (mesma lógica no DOM e no export)
function wrapText(el) {
  measureCtx.font = `${el.fontWeight} ${el.fontSize}px "${el.fontFamily}"`;
  const out = [];
  for (const para of String(el.text).split('\n')) {
    const words = para.split(' ');
    let line = '';
    for (const w of words) {
      const test = line ? line + ' ' + w : w;
      if (measureCtx.measureText(test).width <= el.w || !line) line = test;
      else { out.push(line); line = w; }
    }
    out.push(line);
  }
  return out;
}

function textHeight(el) {
  return wrapText(el).length * el.fontSize * 1.25;
}

// ---------------------------------------------------------------- element factories

function centerOfViewportWorldX() {
  const rect = viewport.getBoundingClientRect();
  return clamp((viewport.scrollLeft + rect.width / 2) / zoom, 0, worldW());
}

function currentSlideIndex() {
  return clamp(Math.floor(centerOfViewportWorldX() / state.W), 0, state.slides - 1);
}

async function addFreeImage() {
  const f = await pickFile();
  if (!f) return;
  const { src, w, h } = await fileToDataURL(f);
  await loadImage(src);
  pushUndo();
  const targetW = state.W * 0.7;
  const el = {
    id: uid(), type: 'image', src, natW: w, natH: h,
    w: targetW, h: targetW * (h / w),
    x: 0, y: 0, z: maxZ() + 1,
    radius: 0, opacity: 1, freeAspect: false,
    panX: 0.5, panY: 0.5, preset: 'none',
    bright: 100, contrast: 100, sat: 100,
    borderW: 0, borderColor: '#ffffff',
  };
  el.x = centerOfViewportWorldX() - el.w / 2;
  el.y = (state.H - el.h) / 2;
  state.elements.push(el);
  selectedId = el.id;
  fullRender(); save();
}

function addText() {
  pushUndo();
  const el = {
    id: uid(), type: 'text',
    text: 'Toque duas vezes\npara editar',
    fontFamily: 'Inter', fontWeight: '700', fontSize: 64,
    color: '#111111', align: 'center',
    w: 620, h: 0, x: 0, y: 0, z: maxZ() + 1,
  };
  el.h = textHeight(el);
  el.x = centerOfViewportWorldX() - el.w / 2;
  el.y = (state.H - el.h) / 2;
  state.elements.push(el);
  selectedId = el.id;
  fullRender(); save();
}

function addPlaceholder(x, y, w, h) {
  state.elements.push({
    id: uid(), type: 'image', src: null, natW: 0, natH: 0,
    x, y, w, h, z: maxZ() + 1,
    radius: 0, opacity: 1, freeAspect: true,
    panX: 0.5, panY: 0.5, preset: 'none',
    bright: 100, contrast: 100, sat: 100,
    borderW: 0, borderColor: '#ffffff',
  });
}

// ---------------------------------------------------------------- layouts

const LAYOUTS = [
  { name: 'Cheio', rects: [[0, 0, 1, 1]] },
  { name: 'Moldura', rects: [[.1, .1, .8, .8]] },
  { name: '2 colunas', rects: [[0, 0, .5, 1], [.5, 0, .5, 1]] },
  { name: 'Herói + 2', rects: [[.05, .05, .9, .52], [.05, .59, .435, .36], [.515, .59, .435, .36]] },
  { name: '3 colunas', rects: [[.03, .1, .3, .8], [.35, .1, .3, .8], [.67, .1, .3, .8]] },
  { name: 'Grade 2×2', rects: [[.04, .04, .45, .45], [.51, .04, .45, .45], [.04, .51, .45, .45], [.51, .51, .45, .45]] },
];

function openLayouts() {
  const grid = $('#layoutGrid');
  grid.innerHTML = '';
  LAYOUTS.forEach((ly, i) => {
    const item = document.createElement('div');
    item.className = 'layout-item';
    const rects = ly.rects.map(([x, y, w, h]) =>
      `<rect class="rect" x="${x * 100 + 2}" y="${y * 125 + 2}" width="${w * 100 - 4}" height="${h * 125 - 4}" rx="3"/>`
    ).join('');
    item.innerHTML = `<svg viewBox="0 0 104 129">${rects}</svg><div class="name">${ly.name}</div>`;
    item.onclick = () => { applyLayout(i); closeModal('layoutModal'); };
    grid.appendChild(item);
  });
  $('#layoutModal').classList.remove('hidden');
}

function applyLayout(i) {
  pushUndo();
  const slide = currentSlideIndex();
  const ox = slide * state.W;
  const GAP = 18;
  for (const [rx, ry, rw, rh] of LAYOUTS[i].rects) {
    addPlaceholder(
      ox + rx * state.W + GAP / 2,
      ry * state.H + GAP / 2,
      rw * state.W - GAP,
      rh * state.H - GAP
    );
  }
  fullRender(); save();
}

// ---------------------------------------------------------------- render

function fullRender() {
  const W = worldW(), H = state.H;
  stripBox.style.width = (W * zoom) + 'px';
  stripBox.style.height = (H * zoom) + 'px';
  stripBox.style.margin = MARGIN + 'px';
  strip.style.width = W + 'px';
  strip.style.height = H + 'px';
  strip.style.transform = `scale(${zoom})`;
  strip.style.background = state.bg;

  fullRenderStrip();
  renderPanel();
  $('#slideCount').textContent = `${state.slides} slide${state.slides > 1 ? 's' : ''}`;
  $('#mbSlideCount').textContent = `${state.slides} slide${state.slides > 1 ? 's' : ''}`;
  $('#zoomLabel').textContent = Math.round(zoom * 100) + '%';
  $('#bgColor').value = state.bg;
  $('#formatSelect').value = `${state.W}x${state.H}`;
  $('#btnUndo').disabled = !undoStack.length;
  $('#btnRedo').disabled = !redoStack.length;
}

function renderElement(el) {
  const d = document.createElement('div');
  d.className = 'el ' + el.type;
  d.dataset.id = el.id;
  d.style.left = el.x + 'px';
  d.style.top = el.y + 'px';
  d.style.width = el.w + 'px';
  d.style.zIndex = el.z;

  if (el.type === 'image') {
    d.style.height = el.h + 'px';
    d.style.borderRadius = (el.radius || 0) + 'px';
    d.style.opacity = el.opacity ?? 1;
    if (el.src) {
      const inner = document.createElement('div');
      inner.className = 'el-img';
      inner.style.backgroundImage = `url("${el.src}")`;
      inner.style.backgroundPosition = `${(el.panX ?? 0.5) * 100}% ${(el.panY ?? 0.5) * 100}%`;
      const f = filterCSS(el);
      if (f) inner.style.filter = f;
      d.appendChild(inner);
      if (el.borderW > 0) {
        const b = document.createElement('div');
        b.className = 'el-border';
        b.style.boxShadow = `inset 0 0 0 ${el.borderW}px ${el.borderColor || '#ffffff'}`;
        d.appendChild(b);
      }
      if (el.id === cropId) d.classList.add('cropping');
    } else {
      d.classList.add('placeholder');
      const btn = document.createElement('button');
      btn.className = 'ph-add';
      btn.textContent = '+';
      btn.title = 'Adicionar foto';
      btn.onpointerdown = (e) => e.stopPropagation();
      btn.onclick = async (e) => {
        e.stopPropagation();
        const f = await pickFile();
        if (!f) return;
        const { src, w, h } = await fileToDataURL(f);
        await loadImage(src);
        pushUndo();
        el.src = src; el.natW = w; el.natH = h;
        fullRender(); save();
      };
      d.appendChild(btn);
    }
  } else {
    const lines = wrapText(el);
    el.h = lines.length * el.fontSize * 1.25;
    d.style.height = el.h + 'px';
    d.style.font = `${el.fontWeight} ${el.fontSize}px "${el.fontFamily}"`;
    d.style.lineHeight = '1.25';
    d.style.color = el.color;
    d.style.textAlign = el.align;
    d.textContent = lines.join('\n');
  }
  return d;
}

function renderSelection() {
  strip.querySelectorAll('.sel-box, .handle').forEach(n => n.remove());
  const el = selectedId && getEl(selectedId);
  if (!el) return;

  const box = document.createElement('div');
  box.className = 'sel-box';
  box.style.left = el.x + 'px';
  box.style.top = el.y + 'px';
  box.style.width = el.w + 'px';
  box.style.height = el.h + 'px';
  const bw = Math.max(1.5, 2.5 / zoom);
  box.style.borderWidth = bw + 'px';
  strip.appendChild(box);

  const handles = el.type === 'text'
    ? ['e', 'w']
    : ['nw', 'ne', 'sw', 'se', 'n', 's', 'e', 'w'];

  // alvos de toque maiores no celular
  const HB = IS_MOBILE ? 40 : 26;
  const EL = IS_MOBILE ? 60 : 44;
  const ES = IS_MOBILE ? 20 : 14;
  const hs = HB / zoom;
  for (const pos of handles) {
    const h = document.createElement('div');
    const isEdge = pos.length === 1;
    h.className = 'handle ' + pos + (isEdge ? (pos === 'n' || pos === 's' ? ' edge-h' : ' edge-v') : '');
    // tamanho compensado pelo zoom
    if (!isEdge) {
      h.style.width = h.style.height = hs + 'px';
      h.style.margin = `${-hs / 2}px 0 0 ${-hs / 2}px`;
    } else if (pos === 'n' || pos === 's') {
      h.style.width = (EL / zoom) + 'px'; h.style.height = (ES / zoom) + 'px';
      h.style.margin = `${-ES / 2 / zoom}px 0 0 ${-EL / 2 / zoom}px`;
    } else {
      h.style.width = (ES / zoom) + 'px'; h.style.height = (EL / zoom) + 'px';
      h.style.margin = `${-EL / 2 / zoom}px 0 0 ${-ES / 2 / zoom}px`;
    }
    const cx = pos.includes('w') ? el.x : pos.includes('e') ? el.x + el.w : el.x + el.w / 2;
    const cy = pos.includes('n') ? el.y : pos.includes('s') ? el.y + el.h : el.y + el.h / 2;
    h.style.left = cx + 'px';
    h.style.top = cy + 'px';
    h.dataset.pos = pos;
    strip.appendChild(h);
  }
}

function showGuides(gx, gy) {
  strip.querySelectorAll('.guide').forEach(n => n.remove());
  const gw = Math.max(1, 2 / zoom);
  if (gx != null) {
    const g = document.createElement('div');
    g.className = 'guide v';
    g.style.left = gx + 'px';
    g.style.width = gw + 'px';
    strip.appendChild(g);
  }
  if (gy != null) {
    const g = document.createElement('div');
    g.className = 'guide h';
    g.style.top = gy + 'px';
    g.style.height = gw + 'px';
    strip.appendChild(g);
  }
}

// ---------------------------------------------------------------- properties panel

// alinha o elemento dentro do slide onde ele está (menos arraste fino)
function alignSelected(axis, pos) {
  const el = selectedId && getEl(selectedId);
  if (!el) return;
  pushUndo();
  const slide = clamp(Math.floor((el.x + el.w / 2) / state.W), 0, state.slides - 1);
  const ox = slide * state.W;
  const M = 40; // margem das bordas
  if (axis === 'h') {
    if (pos === 0) el.x = ox + M;
    if (pos === 1) el.x = ox + (state.W - el.w) / 2;
    if (pos === 2) el.x = ox + state.W - el.w - M;
  } else {
    if (pos === 0) el.y = M;
    if (pos === 1) el.y = (state.H - el.h) / 2;
    if (pos === 2) el.y = state.H - el.h - M;
  }
  fullRender(); save();
}

const POS_SECTION = `
  <div class="p-title" style="margin-top:14px">Posição no slide</div>
  <div class="p-row" style="display:block">
    <div class="seg" id="pAlignH">
      <button data-p="0">⇤ Esq</button><button data-p="1">Centro</button><button data-p="2">Dir ⇥</button>
    </div>
  </div>
  <div class="p-row" style="display:block">
    <div class="seg" id="pAlignV">
      <button data-p="0">⤒ Topo</button><button data-p="1">Meio</button><button data-p="2">Base ⤓</button>
    </div>
  </div>`;

const SHEET_CLOSE = `<button class="sheet-close" id="pSheetClose">✕</button>`;

function renderPanel() {
  const el = selectedId && getEl(selectedId);
  if (!el) { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');

  if (el.type === 'image') {
    const presetOpts = Object.entries(PRESETS).map(([k, [name]]) =>
      `<option value="${k}" ${(el.preset || 'none') === k ? 'selected' : ''}>${name}</option>`).join('');
    panelContent.innerHTML = `
      ${SHEET_CLOSE}
      <div class="p-title">Imagem</div>
      ${el.src && isPannable(el) ? `<div class="p-btns" style="margin-top:0">
        <button class="p-btn accent" id="pCrop" style="flex:1 1 100%">${cropId === el.id ? '✓ Concluir reposição' : '✥ Reposicionar foto'}</button>
      </div>` : ''}
      ${POS_SECTION}
      <div class="p-title" style="margin-top:14px">Filtro</div>
      <div class="p-row"><label>Preset</label>
        <select id="pPreset">${presetOpts}</select>
      </div>
      <div class="p-row">
        <label>Brilho</label>
        <input type="range" id="pBright" min="50" max="150" value="${el.bright ?? 100}">
        <span class="p-val">${el.bright ?? 100}</span>
      </div>
      <div class="p-row">
        <label>Contraste</label>
        <input type="range" id="pContrast" min="50" max="150" value="${el.contrast ?? 100}">
        <span class="p-val">${el.contrast ?? 100}</span>
      </div>
      <div class="p-row">
        <label>Saturação</label>
        <input type="range" id="pSat" min="0" max="200" value="${el.sat ?? 100}">
        <span class="p-val">${el.sat ?? 100}</span>
      </div>
      <div class="p-title" style="margin-top:14px">Moldura</div>
      <div class="p-row">
        <label>Borda</label>
        <input type="range" id="pBorderW" min="0" max="60" value="${el.borderW ?? 0}">
        <span class="p-val">${el.borderW ?? 0}</span>
      </div>
      <div class="p-row">
        <label>Cor da borda</label>
        <input type="color" id="pBorderColor" value="${el.borderColor || '#ffffff'}">
      </div>
      <div class="p-row">
        <label>Cantos</label>
        <input type="range" id="pRadius" min="0" max="200" value="${el.radius || 0}">
        <span class="p-val">${el.radius || 0}</span>
      </div>
      <div class="p-row">
        <label>Opacidade</label>
        <input type="range" id="pOpacity" min="10" max="100" value="${Math.round((el.opacity ?? 1) * 100)}">
        <span class="p-val">${Math.round((el.opacity ?? 1) * 100)}%</span>
      </div>
      <div class="p-btns">
        <button class="p-btn" id="pReplace">Trocar foto</button>
        <button class="p-btn" id="pFill">Preencher slide</button>
        <button class="p-btn" id="pFront">Trazer p/ frente</button>
        <button class="p-btn" id="pBack">Enviar p/ trás</button>
        <button class="p-btn" id="pDup">Duplicar</button>
        <button class="p-btn danger" id="pDel">Apagar</button>
      </div>`;
    const pCrop = $('#pCrop');
    if (pCrop) {
      pCrop.onclick = () => {
        cropId = (cropId === el.id) ? null : el.id;
        fullRender();
      };
    }
    $('#pPreset').onchange = (e) => { pushUndo(); el.preset = e.target.value; fullRender(); save(); };
    bindRange('#pBright', v => { el.bright = +v; }, v => v);
    bindRange('#pContrast', v => { el.contrast = +v; }, v => v);
    bindRange('#pSat', v => { el.sat = +v; }, v => v);
    bindRange('#pBorderW', v => { el.borderW = +v; }, v => v);
    $('#pBorderColor').oninput = (e) => { el.borderColor = e.target.value; renderStripOnly(); save(); };
    bindRange('#pRadius', v => { el.radius = +v; }, v => v);
    bindRange('#pOpacity', v => { el.opacity = +v / 100; }, v => v + '%');
    $('#pReplace').onclick = async () => {
      const f = await pickFile();
      if (!f) return;
      const { src, w, h } = await fileToDataURL(f);
      await loadImage(src);
      pushUndo();
      el.src = src; el.natW = w; el.natH = h;
      el.panX = 0.5; el.panY = 0.5; // foto nova recomeça centralizada
      fullRender(); save();
    };
    $('#pFill').onclick = () => {
      pushUndo();
      const slide = clamp(Math.floor((el.x + el.w / 2) / state.W), 0, state.slides - 1);
      el.x = slide * state.W; el.y = 0; el.w = state.W; el.h = state.H;
      el.freeAspect = true;
      fullRender(); save();
    };
  } else {
    const fontOpts = FONTS.map(([v, n]) =>
      `<option value="${v}" ${el.fontFamily === v ? 'selected' : ''} style="font-family:'${v}'">${n}</option>`).join('');
    panelContent.innerHTML = `
      ${SHEET_CLOSE}
      <div class="p-title">Texto</div>
      ${POS_SECTION}
      <div class="p-row"><label>Fonte</label>
        <select id="pFont">${fontOpts}</select>
      </div>
      <div class="p-row"><label>Tamanho</label>
        <input type="range" id="pSize" min="18" max="260" value="${el.fontSize}">
        <span class="p-val">${el.fontSize}</span>
      </div>
      <div class="p-row"><label>Peso</label>
        <select id="pWeight">
          <option value="400" ${el.fontWeight === '400' ? 'selected' : ''}>Regular</option>
          <option value="700" ${el.fontWeight === '700' ? 'selected' : ''}>Bold</option>
        </select>
      </div>
      <div class="p-row"><label>Cor</label>
        <input type="color" id="pColor" value="${el.color}">
      </div>
      <div class="p-row" style="display:block">
        <div class="seg" id="pAlign">
          <button data-a="left" class="${el.align === 'left' ? 'on' : ''}">Esq</button>
          <button data-a="center" class="${el.align === 'center' ? 'on' : ''}">Centro</button>
          <button data-a="right" class="${el.align === 'right' ? 'on' : ''}">Dir</button>
        </div>
      </div>
      <div class="p-btns">
        <button class="p-btn" id="pFront">Trazer p/ frente</button>
        <button class="p-btn" id="pBack">Enviar p/ trás</button>
        <button class="p-btn" id="pDup">Duplicar</button>
        <button class="p-btn danger" id="pDel">Apagar</button>
      </div>`;
    $('#pFont').onchange = (e) => { pushUndo(); el.fontFamily = e.target.value; fullRender(); save(); };
    bindRange('#pSize', v => { el.fontSize = +v; }, v => v);
    $('#pWeight').onchange = (e) => { pushUndo(); el.fontWeight = e.target.value; fullRender(); save(); };
    $('#pColor').oninput = (e) => { el.color = e.target.value; fullRender(); save(); };
    $('#pAlign').querySelectorAll('button').forEach(b => {
      b.onclick = () => { pushUndo(); el.align = b.dataset.a; fullRender(); save(); };
    });
  }

  panelContent.querySelectorAll('#pAlignH button').forEach(b => {
    b.onclick = () => alignSelected('h', +b.dataset.p);
  });
  panelContent.querySelectorAll('#pAlignV button').forEach(b => {
    b.onclick = () => alignSelected('v', +b.dataset.p);
  });
  $('#pSheetClose').onclick = () => { selectedId = null; cropId = null; fullRender(); };

  $('#pFront').onclick = () => { pushUndo(); getEl(selectedId).z = maxZ() + 1; fullRender(); save(); };
  $('#pBack').onclick = () => {
    pushUndo();
    const minZ = state.elements.reduce((m, e) => Math.min(m, e.z), 1);
    getEl(selectedId).z = minZ - 1;
    fullRender(); save();
  };
  $('#pDup').onclick = duplicateSelected;
  $('#pDel').onclick = deleteSelected;

  function bindRange(sel, apply, fmt) {
    const input = $(sel);
    let undoPushed = false;
    input.oninput = () => {
      if (!undoPushed) { pushUndo(); undoPushed = true; }
      apply(input.value);
      input.nextElementSibling.textContent = fmt(input.value);
      // atualização leve sem reconstruir o painel (senão o slider perde o foco)
      renderStripOnly();
      save();
    };
    input.onchange = () => { undoPushed = false; };
  }
}

// re-renderiza a tira sem tocar no painel (para sliders não perderem o foco)
function renderStripOnly() {
  fullRenderStrip();
}

function fullRenderStrip() {
  // reconstrói apenas #strip (elementos, divisores, seleção)
  const scrollL = viewport.scrollLeft, scrollT = viewport.scrollTop;
  const focusSel = document.activeElement;
  strip.innerHTML = '';
  for (const el of sortedEls()) strip.appendChild(renderElement(el));
  for (let i = 1; i < state.slides; i++) {
    const d = document.createElement('div');
    d.className = 'slide-divider';
    d.style.left = (i * state.W) + 'px';
    strip.appendChild(d);
  }
  for (let i = 0; i < state.slides; i++) {
    const n = document.createElement('div');
    n.className = 'slide-num';
    n.textContent = i + 1;
    n.style.left = (i * state.W + 20) + 'px';
    strip.appendChild(n);
  }
  renderCropGhost();
  renderSelection();
  viewport.scrollLeft = scrollL; viewport.scrollTop = scrollT;
  if (focusSel && focusSel.focus) focusSel.focus();
}

// no modo "reposicionar": mostra a foto inteira translúcida atrás da moldura
function renderCropGhost() {
  const el = cropId && getEl(cropId);
  if (!el || !el.src || !imgCache.has(el.src)) return;
  const img = imgCache.get(el.src);
  const s = Math.max(el.w / img.width, el.h / img.height);
  const dw = img.width * s, dh = img.height * s;
  const g = document.createElement('div');
  g.className = 'crop-ghost';
  g.style.left = (el.x - (dw - el.w) * (el.panX ?? 0.5)) + 'px';
  g.style.top = (el.y - (dh - el.h) * (el.panY ?? 0.5)) + 'px';
  g.style.width = dw + 'px';
  g.style.height = dh + 'px';
  g.style.backgroundImage = `url("${el.src}")`;
  strip.appendChild(g);
}

// ---------------------------------------------------------------- selection ops

function duplicateSelected() {
  const el = selectedId && getEl(selectedId);
  if (!el) return;
  pushUndo();
  const copy = JSON.parse(JSON.stringify(el));
  copy.id = uid();
  copy.x += 60; copy.y += 60;
  copy.z = maxZ() + 1;
  state.elements.push(copy);
  selectedId = copy.id;
  fullRender(); save();
}

function deleteSelected() {
  if (!selectedId) return;
  pushUndo();
  state.elements = state.elements.filter(e => e.id !== selectedId);
  selectedId = null;
  fullRender(); save();
}

// ---------------------------------------------------------------- pointer interaction

let drag = null; // {mode:'move'|'resize', id, pos, startX, startY, orig:{...}, moved, undoPushed}

function worldPoint(e) {
  const r = strip.getBoundingClientRect();
  return { x: (e.clientX - r.left) / zoom, y: (e.clientY - r.top) / zoom };
}

strip.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const handle = e.target.closest('.handle');
  const elNode = e.target.closest('.el');
  const p = worldPoint(e);

  if (handle && selectedId) {
    const el = getEl(selectedId);
    drag = {
      mode: 'resize', id: selectedId, pos: handle.dataset.pos,
      startX: p.x, startY: p.y,
      orig: { x: el.x, y: el.y, w: el.w, h: el.h, fontSize: el.fontSize },
      undoPushed: false,
    };
    e.preventDefault();
    return;
  }

  if (elNode) {
    const id = elNode.dataset.id;
    if (cropId && cropId !== id) cropId = null; // clicar em outro elemento sai do modo crop
    selectedId = id;
    const el = getEl(id);
    if (cropId === id && el.src) {
      // modo reposicionar: arrastar move a foto dentro da moldura
      drag = {
        mode: 'pan', id,
        startX: p.x, startY: p.y,
        orig: { panX: el.panX ?? 0.5, panY: el.panY ?? 0.5 },
        undoPushed: false,
      };
    } else {
      drag = {
        mode: 'move', id,
        startX: p.x, startY: p.y,
        orig: { x: el.x, y: el.y },
        moved: false, undoPushed: false,
      };
    }
    fullRender();
    e.preventDefault();
    return;
  }

  // clique no fundo → deseleciona e sai do modo crop
  selectedId = null;
  cropId = null;
  fullRender();
});

document.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const el = getEl(drag.id);
  if (!el) { drag = null; return; }
  const p = worldPoint(e);
  const dx = p.x - drag.startX;
  const dy = p.y - drag.startY;
  if (!drag.undoPushed && (Math.abs(dx) > 2 || Math.abs(dy) > 2)) {
    pushUndo(); drag.undoPushed = true;
  }

  if (drag.mode === 'move') {
    let nx = drag.orig.x + dx;
    let ny = drag.orig.y + dy;
    // snap
    const thr = (IS_MOBILE ? 16 : 10) / zoom;
    const xTargets = [];
    for (let i = 0; i <= state.slides; i++) xTargets.push(i * state.W);
    for (let i = 0; i < state.slides; i++) xTargets.push(i * state.W + state.W / 2);
    const yTargets = [0, state.H / 2, state.H];
    let gx = null, gy = null;
    for (const t of xTargets) {
      if (Math.abs(nx - t) < thr) { nx = t; gx = t; break; }
      if (Math.abs(nx + el.w - t) < thr) { nx = t - el.w; gx = t; break; }
      if (Math.abs(nx + el.w / 2 - t) < thr) { nx = t - el.w / 2; gx = t; break; }
    }
    for (const t of yTargets) {
      if (Math.abs(ny - t) < thr) { ny = t; gy = t; break; }
      if (Math.abs(ny + el.h - t) < thr) { ny = t - el.h; gy = t; break; }
      if (Math.abs(ny + el.h / 2 - t) < thr) { ny = t - el.h / 2; gy = t; break; }
    }
    el.x = nx; el.y = ny;
    drag.moved = true;
    fullRenderStrip();
    showGuides(gx, gy);
  } else if (drag.mode === 'pan') {
    const img = imgCache.get(el.src);
    if (img) {
      const s = Math.max(el.w / img.width, el.h / img.height);
      const hiddenX = img.width * s - el.w;
      const hiddenY = img.height * s - el.h;
      if (hiddenX > 1) el.panX = clamp(drag.orig.panX - dx / hiddenX, 0, 1);
      if (hiddenY > 1) el.panY = clamp(drag.orig.panY - dy / hiddenY, 0, 1);
    }
    fullRenderStrip();
  } else {
    resizeElement(el, drag, dx, dy);
    fullRenderStrip();
  }
});

document.addEventListener('pointerup', () => {
  if (!drag) return;
  strip.querySelectorAll('.guide').forEach(n => n.remove());
  drag = null;
  fullRender(); save();
});

function resizeElement(el, drag, dx, dy) {
  const o = drag.orig;
  const pos = drag.pos;
  const MIN = 40;

  if (el.type === 'text') {
    // texto: só largura; altura recalculada pelo wrap
    if (pos === 'e') el.w = Math.max(80, o.w + dx);
    if (pos === 'w') { el.w = Math.max(80, o.w - dx); el.x = o.x + (o.w - el.w); }
    el.h = textHeight(el);
    return;
  }

  const keepAspect = !el.freeAspect && el.src;
  const aspect = o.w / o.h;

  let x = o.x, y = o.y, w = o.w, h = o.h;

  if (pos.includes('e')) w = o.w + dx;
  if (pos.includes('w')) { w = o.w - dx; x = o.x + dx; }
  if (pos.includes('s')) h = o.h + dy;
  if (pos.includes('n')) { h = o.h - dy; y = o.y + dy; }

  if (keepAspect && pos.length === 2) {
    // cantos: mantém proporção pela maior variação
    if (Math.abs(w - o.w) / o.w > Math.abs(h - o.h) / o.h) h = w / aspect;
    else w = h * aspect;
    if (pos.includes('w')) x = o.x + (o.w - w);
    if (pos.includes('n')) y = o.y + (o.h - h);
  }

  el.w = Math.max(MIN, w);
  el.h = Math.max(MIN, h);
  el.x = (el.w === w) ? x : (pos.includes('w') ? o.x + o.w - el.w : x);
  el.y = (el.h === h) ? y : (pos.includes('n') ? o.y + o.h - el.h : y);
}

// ---------------------------------------------------------------- inline text edit

strip.addEventListener('dblclick', (e) => {
  const imgNode = e.target.closest('.el.image');
  if (imgNode) {
    const el = getEl(imgNode.dataset.id);
    if (el && el.src && isPannable(el)) {
      cropId = (cropId === el.id) ? null : el.id; // alterna modo reposicionar
      selectedId = el.id;
      fullRender();
    }
    return;
  }
  const node = e.target.closest('.el.text');
  if (!node) return;
  const el = getEl(node.dataset.id);
  if (!el) return;
  startTextEdit(el);
});

function startTextEdit(el) {
  const ta = document.createElement('textarea');
  ta.className = 'text-editor';
  ta.value = el.text;
  ta.style.left = el.x + 'px';
  ta.style.top = el.y + 'px';
  ta.style.width = (el.w + 20) + 'px';
  ta.style.height = (el.h + el.fontSize * 2) + 'px';
  ta.style.font = `${el.fontWeight} ${el.fontSize}px "${el.fontFamily}"`;
  ta.style.lineHeight = '1.25';
  ta.style.color = el.color;
  ta.style.textAlign = el.align;
  strip.appendChild(ta);
  // esconde o original enquanto edita
  const orig = strip.querySelector(`.el[data-id="${el.id}"]`);
  if (orig) orig.style.visibility = 'hidden';
  ta.focus();
  ta.select();

  const commit = () => {
    pushUndo();
    el.text = ta.value.trim() || 'Texto';
    el.h = textHeight(el);
    ta.remove();
    fullRender(); save();
  };
  ta.addEventListener('blur', commit);
  ta.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { ta.value = el.text; ta.blur(); }
  });
}

// ---------------------------------------------------------------- zoom / scroll

function setZoom(z, cx, cy) {
  const rect = viewport.getBoundingClientRect();
  cx = cx ?? rect.width / 2;
  cy = cy ?? rect.height / 2;
  const wx = (viewport.scrollLeft + cx - MARGIN) / zoom;
  const wy = (viewport.scrollTop + cy - MARGIN) / zoom;
  zoom = clamp(z, 0.05, 2);
  fullRender();
  viewport.scrollLeft = wx * zoom + MARGIN - cx;
  viewport.scrollTop = wy * zoom + MARGIN - cy;
}

function zoomFit() {
  const rect = viewport.getBoundingClientRect();
  let z;
  if (IS_MOBILE) {
    // celular: 1 slide preenchendo a largura; swipe navega entre slides
    z = Math.min((rect.width - MARGIN * 2) / state.W, (rect.height - MARGIN * 2) / state.H);
  } else {
    z = Math.min(
      (rect.height - 120) / state.H,
      (rect.width - 120) / (state.W * Math.min(state.slides, 2.5))
    );
  }
  setZoom(z);
  viewport.scrollLeft = 0;
}

viewport.addEventListener('wheel', (e) => {
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    const rect = viewport.getBoundingClientRect();
    const factor = Math.exp(-e.deltaY * 0.002);
    setZoom(zoom * factor, e.clientX - rect.left, e.clientY - rect.top);
  } else if (
    Math.abs(e.deltaY) > Math.abs(e.deltaX) &&
    stripBox.offsetHeight + 80 <= viewport.clientHeight
  ) {
    // roda vertical navega horizontalmente pela tira (quando não há scroll vertical)
    e.preventDefault();
    viewport.scrollLeft += e.deltaY;
  }
}, { passive: false });

// ---------------------------------------------------------------- keyboard

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  const mod = e.metaKey || e.ctrlKey;

  if (e.key === 'Escape' && cropId) {
    cropId = null;
    fullRender();
    return;
  }
  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    e.shiftKey ? redo() : undo();
    return;
  }
  if (mod && e.key.toLowerCase() === 'd') {
    e.preventDefault();
    duplicateSelected();
    return;
  }
  if ((e.key === 'Backspace' || e.key === 'Delete') && selectedId) {
    e.preventDefault();
    deleteSelected();
    return;
  }
  if (selectedId && e.key.startsWith('Arrow')) {
    e.preventDefault();
    const el = getEl(selectedId);
    const step = e.shiftKey ? 40 : 8;
    if (e.key === 'ArrowLeft') el.x -= step;
    if (e.key === 'ArrowRight') el.x += step;
    if (e.key === 'ArrowUp') el.y -= step;
    if (e.key === 'ArrowDown') el.y += step;
    fullRenderStrip(); save();
  }
});

// ---------------------------------------------------------------- export

async function renderSlideCanvas(slideIdx, scale) {
  const c = document.createElement('canvas');
  c.width = Math.round(state.W * scale);
  c.height = Math.round(state.H * scale);
  const ctx = c.getContext('2d');
  ctx.scale(scale, scale);
  ctx.translate(-slideIdx * state.W, 0);

  ctx.fillStyle = state.bg;
  ctx.fillRect(slideIdx * state.W, 0, state.W, state.H);

  for (const el of sortedEls()) {
    // pula elementos fora deste slide
    if (el.x + el.w < slideIdx * state.W || el.x > (slideIdx + 1) * state.W) continue;

    if (el.type === 'image' && el.src) {
      const img = await loadImage(el.src);
      ctx.save();
      ctx.globalAlpha = el.opacity ?? 1;
      roundRectPath(ctx, el.x, el.y, el.w, el.h, el.radius || 0);
      ctx.clip();
      // cover crop com pan
      const f = filterCSS(el);
      if (f) ctx.filter = f;
      const s = Math.max(el.w / img.width, el.h / img.height);
      const sw = el.w / s, sh = el.h / s;
      const sx = (img.width - sw) * (el.panX ?? 0.5);
      const sy = (img.height - sh) * (el.panY ?? 0.5);
      ctx.drawImage(img, sx, sy, sw, sh, el.x, el.y, el.w, el.h);
      ctx.filter = 'none';
      if (el.borderW > 0) {
        // metade do traço cai fora do clip → borda visível = borderW, igual ao box-shadow inset
        ctx.lineWidth = el.borderW * 2;
        ctx.strokeStyle = el.borderColor || '#ffffff';
        roundRectPath(ctx, el.x, el.y, el.w, el.h, el.radius || 0);
        ctx.stroke();
      }
      ctx.restore();
    } else if (el.type === 'text') {
      ctx.save();
      ctx.font = `${el.fontWeight} ${el.fontSize}px "${el.fontFamily}"`;
      ctx.fillStyle = el.color;
      ctx.textBaseline = 'top';
      const lines = wrapText(el);
      const lh = el.fontSize * 1.25;
      lines.forEach((line, i) => {
        let tx = el.x;
        if (el.align === 'center') tx = el.x + (el.w - ctx.measureText(line).width) / 2;
        if (el.align === 'right') tx = el.x + el.w - ctx.measureText(line).width;
        // pequeno ajuste vertical para casar com line-height do DOM
        ctx.fillText(line, tx, el.y + i * lh + el.fontSize * 0.125);
      });
      ctx.restore();
    }
  }
  return c;
}

function roundRectPath(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

let jszipPromise = null;
function loadJSZip() {
  if (window.JSZip) return Promise.resolve(window.JSZip);
  if (!jszipPromise) {
    jszipPromise = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
      s.onload = () => res(window.JSZip);
      s.onerror = () => { jszipPromise = null; rej(new Error('JSZip indisponível')); };
      document.head.appendChild(s);
    });
  }
  return jszipPromise;
}

function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function exportAll() {
  const btn = $('#btnExport');
  btn.disabled = true;
  const oldLabel = btn.textContent;
  try {
    await document.fonts.ready;
    const blobs = [];
    for (let i = 0; i < state.slides; i++) {
      btn.textContent = `Renderizando ${i + 1}/${state.slides}…`;
      const c = await renderSlideCanvas(i, 1);
      blobs.push(await new Promise(res => c.toBlob(res, 'image/png')));
    }
    let zipped = false;
    try {
      btn.textContent = 'Compactando…';
      const JSZip = await loadJSZip();
      const zip = new JSZip();
      blobs.forEach((b, i) => zip.file(`carrossel-slide-${String(i + 1).padStart(2, '0')}.png`, b));
      const zipBlob = await zip.generateAsync({ type: 'blob' });
      downloadBlob(zipBlob, 'carrossel.zip');
      zipped = true;
    } catch (e) {
      // sem rede/CDN bloqueado: baixa os PNGs um a um
      for (let i = 0; i < blobs.length; i++) {
        downloadBlob(blobs[i], `carrossel-slide-${String(i + 1).padStart(2, '0')}.png`);
        await new Promise(r => setTimeout(r, 350)); // evita bloqueio de multi-download
      }
    }
    btn.textContent = zipped ? 'ZIP baixado ✓' : 'Exportado ✓';
    setTimeout(() => { btn.textContent = oldLabel; }, 1800);
  } catch (e) {
    btn.textContent = oldLabel;
    throw e;
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------- preview

async function openPreview() {
  await document.fonts.ready;
  const scroller = $('#previewScroller');
  const dots = $('#previewDots');
  scroller.innerHTML = '';
  dots.innerHTML = '';
  for (let i = 0; i < state.slides; i++) {
    const c = await renderSlideCanvas(i, 0.4);
    const img = new Image();
    img.src = c.toDataURL('image/jpeg', 0.85);
    scroller.appendChild(img);
    const dot = document.createElement('span');
    if (i === 0) dot.classList.add('on');
    dots.appendChild(dot);
  }
  scroller.onscroll = () => {
    const idx = Math.round(scroller.scrollLeft / scroller.clientWidth);
    dots.querySelectorAll('span').forEach((d, i) => d.classList.toggle('on', i === idx));
  };
  scroller.scrollLeft = 0;
  $('#previewModal').classList.remove('hidden');
}

// ---------------------------------------------------------------- modals

function closeModal(id) { $('#' + id).classList.add('hidden'); }
document.querySelectorAll('.modal-close').forEach(b => {
  b.onclick = () => closeModal(b.dataset.close);
});
document.querySelectorAll('.modal').forEach(m => {
  m.addEventListener('pointerdown', (e) => { if (e.target === m) m.classList.add('hidden'); });
});

// ---------------------------------------------------------------- topbar wiring

$('#btnAddImage').onclick = addFreeImage;
$('#btnAddText').onclick = addText;
$('#btnLayouts').onclick = openLayouts;
$('#btnSlidePlus').onclick = () => {
  if (state.slides >= 10) return;
  pushUndo(); state.slides++; fullRender(); save();
};
$('#btnSlideMinus').onclick = () => {
  if (state.slides <= 1) return;
  pushUndo(); state.slides--; fullRender(); save();
};
$('#formatSelect').onchange = (e) => {
  pushUndo();
  const [w, h] = e.target.value.split('x').map(Number);
  state.W = w; state.H = h;
  fullRender(); save();
  zoomFit();
};
$('#bgColor').oninput = (e) => { state.bg = e.target.value; fullRender(); save(); };
$('#btnUndo').onclick = undo;
$('#btnRedo').onclick = redo;
$('#btnZoomIn').onclick = () => setZoom(zoom * 1.25);
$('#btnZoomOut').onclick = () => setZoom(zoom / 1.25);
$('#btnZoomFit').onclick = zoomFit;
$('#btnPreview').onclick = openPreview;
$('#btnExport').onclick = exportAll;

// barra inferior mobile (mesmas ações)
$('#mbImage').onclick = addFreeImage;
$('#mbText').onclick = addText;
$('#mbLayouts').onclick = openLayouts;
$('#mbSlidePlus').onclick = () => $('#btnSlidePlus').onclick();
$('#mbSlideMinus').onclick = () => $('#btnSlideMinus').onclick();
$('#mbPreview').onclick = openPreview;

// ---------------------------------------------------------------- boot

restore();

// pré-carrega imagens persistidas antes do primeiro render
Promise.all(
  state.elements.filter(e => e.type === 'image' && e.src).map(e => loadImage(e.src).catch(() => null))
).then(() => {
  document.fonts.ready.then(() => fullRender());
  fullRender();
  zoomFit();
});
