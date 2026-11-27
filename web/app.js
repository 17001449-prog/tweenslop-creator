/* TweenSlop Studio — local-first, dependency-free video editor prototype. */
'use strict';

const DB_NAME = 'tweenslop-studio';
const DB_VERSION = 1;
const AUTO_SAVE_DELAY = 700;
const MAX_HISTORY = 60;
const TRACKS = [
  { id: 0, name: 'ВИДЕО', kind: 'video' },
  { id: 1, name: 'ГРАФИКА', kind: 'graphics' },
  { id: 2, name: 'АУДИО', kind: 'audio' },
];
const VALID_RATIOS = new Set(['9:16', '16:9', '1:1', '4:5']);
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

let db = null;
let project = defaultProject();
let selectedClipId = null;
let activePanel = 'media';
let timelineScale = 64;
let currentTime = 0;
let isPlaying = false;
let playbackOrigin = 0;
let frameRequest = 0;
let lastDrawAt = 0;
let saveTimer = 0;
let historyStack = [];
let redoStack = [];
let mediaUrls = new Map();
let mediaElements = new Map();
let imageElements = new Map();
let pluginEffects = new Map();
let pluginActions = new Map();
let pluginLoadErrors = new Set();
let audioGraph = null;
let recorder = null;
let recorderChunks = [];
let exportCancelled = false;
let isExporting = false;
let exportStartedAt = 0;
let exportMimeType = 'video/webm';

const canvas = $('#previewCanvas');
const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
let effectCanvas = document.createElement('canvas');
let effectCtx = effectCanvas.getContext('2d', { willReadFrequently: true });

function defaultProject() {
  return {
    id: 'active',
    name: 'Первый монтаж',
    ratio: '9:16',
    background: '#11120f',
    fps: 30,
    assets: [],
    clips: [],
    updatedAt: Date.now(),
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function uuid() {
  return globalThis.crypto?.randomUUID?.() || `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function formatTime(seconds, frames = false) {
  const safe = Math.max(0, Number(seconds) || 0);
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  if (frames) {
    const whole = Math.floor(safe);
    const frame = Math.floor((safe - whole) * (project.fps || 30));
    return `${String(Math.floor(whole / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}:${String(frame).padStart(2, '0')}`;
  }
  return `${String(mins).padStart(2, '0')}:${secs.toFixed(2).padStart(5, '0')}`;
}

function projectDuration() {
  if (!project.clips.length) return 10;
  return Math.max(0.5, ...project.clips.map(clip => (Number(clip.start) || 0) + (Number(clip.duration) || 0)));
}

function timelineVisibleDuration() {
  return Math.max(15, projectDuration() + 4);
}

function getSelectedClip() {
  return project.clips.find(clip => clip.id === selectedClipId) || null;
}

function getAsset(id) {
  return project.assets.find(asset => asset.id === id) || null;
}

function readRatio(ratio) {
  switch (ratio) {
    case '16:9': return { width: 1920, height: 1080 };
    case '1:1': return { width: 1080, height: 1080 };
    case '4:5': return { width: 1080, height: 1350 };
    default: return { width: 1080, height: 1920 };
  }
}

function normalizeClip(clip) {
  const type = ['video', 'image', 'audio', 'text', 'sticker'].includes(clip.type) ? clip.type : 'video';
  const base = {
    id: clip.id || uuid(),
    type,
    assetId: clip.assetId || null,
    name: String(clip.name || (type === 'text' ? 'Текстовый слой' : 'Новый слой')),
    start: Math.max(0, Number(clip.start) || 0),
    duration: Math.max(0.2, Number(clip.duration) || 3),
    inPoint: Math.max(0, Number(clip.inPoint) || 0),
    track: clamp(Number.isFinite(Number(clip.track)) ? Math.floor(Number(clip.track)) : (type === 'audio' ? 2 : (type === 'text' || type === 'sticker' ? 1 : 0)), 0, 2),
    x: Number(clip.x) || 0,
    y: Number(clip.y) || 0,
    scale: Number(clip.scale) || 1,
    opacity: Number.isFinite(Number(clip.opacity)) ? Number(clip.opacity) : 1,
    fit: clip.fit === 'contain' ? 'contain' : 'cover',
    volume: Number.isFinite(Number(clip.volume)) ? Number(clip.volume) : 1,
    brightness: Number.isFinite(Number(clip.brightness)) ? Number(clip.brightness) : 100,
    saturation: Number.isFinite(Number(clip.saturation)) ? Number(clip.saturation) : 100,
    contrast: Number.isFinite(Number(clip.contrast)) ? Number(clip.contrast) : 100,
    blur: Number(clip.blur) || 0,
    text: String(clip.text ?? (type === 'sticker' ? '✨' : 'Твой текст здесь')),
    fontSize: Number(clip.fontSize) || 76,
    fontWeight: Number(clip.fontWeight) || 800,
    fontFamily: clip.fontFamily || 'Arial, sans-serif',
    color: clip.color || '#ffffff',
    align: ['left', 'center', 'right'].includes(clip.align) ? clip.align : 'center',
    animation: ['none', 'fade', 'pop', 'bounce'].includes(clip.animation) ? clip.animation : 'pop',
    backgroundEnabled: Boolean(clip.backgroundEnabled),
    backgroundColor: clip.backgroundColor || '#151515',
    stroke: Number(clip.stroke) || 4,
    effects: Array.isArray(clip.effects) ? clip.effects : [],
  };
  return base;
}

function normalizeProject(raw) {
  const fresh = defaultProject();
  if (!raw || typeof raw !== 'object') return fresh;
  return {
    ...fresh,
    ...raw,
    id: 'active',
    name: String(raw.name || fresh.name).slice(0, 60),
    ratio: VALID_RATIOS.has(raw.ratio) ? raw.ratio : '9:16',
    background: /^#[0-9a-f]{6}$/i.test(raw.background || '') ? raw.background : fresh.background,
    fps: [24, 25, 30, 50, 60].includes(Number(raw.fps)) ? Number(raw.fps) : 30,
    assets: Array.isArray(raw.assets) ? raw.assets.filter(asset => asset && asset.id).map(asset => ({
      id: String(asset.id),
      name: String(asset.name || 'Медиа'),
      type: ['video', 'audio', 'image'].includes(asset.type) ? asset.type : 'video',
      mime: String(asset.mime || ''),
      size: Number(asset.size) || 0,
      duration: Math.max(0.2, Number(asset.duration) || 5),
      missing: false,
    })) : [],
    clips: Array.isArray(raw.clips) ? raw.clips.map(normalizeClip) : [],
    updatedAt: Number(raw.updatedAt) || Date.now(),
  };
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      resolve(null);
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('assets')) database.createObjectStore('assets', { keyPath: 'id' });
      if (!database.objectStoreNames.contains('projects')) database.createObjectStore('projects', { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB не открылся'));
  });
}

function dbOperation(storeName, mode, operation) {
  return new Promise((resolve, reject) => {
    if (!db) return reject(new Error('Хранилище браузера недоступно'));
    const transaction = db.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    let request;
    try {
      request = operation(store);
    } catch (error) {
      reject(error);
      return;
    }
    transaction.oncomplete = () => resolve(request?.result);
    transaction.onerror = () => reject(transaction.error || request?.error || new Error('Ошибка хранилища'));
    transaction.onabort = () => reject(transaction.error || new Error('Операция отменена'));
  });
}

function dbGet(storeName, key) {
  return dbOperation(storeName, 'readonly', store => store.get(key));
}

function dbPut(storeName, value) {
  return dbOperation(storeName, 'readwrite', store => store.put(value));
}

function dbDelete(storeName, key) {
  return dbOperation(storeName, 'readwrite', store => store.delete(key));
}

async function loadInitialProject() {
  let localProject = null;
  let serverProject = null;
  if (db) {
    try {
      const saved = await dbGet('projects', 'active');
      localProject = saved?.project || null;
    } catch (error) {
      console.warn('Could not read local project', error);
    }
  }
  try {
    const response = await fetch('/api/project', { cache: 'no-store' });
    if (response.ok) serverProject = (await response.json()).project || null;
  } catch (_) {
    // The editor still works from IndexedDB if the optional Python API is offline.
  }
  const winner = [localProject, serverProject]
    .filter(Boolean)
    .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))[0];
  project = normalizeProject(winner || defaultProject());
  $('#projectName').value = project.name;
  $('#ratioSelect').value = project.ratio;
  for (const asset of project.assets) {
    try {
      const record = db ? await dbGet('assets', asset.id) : null;
      if (record?.blob) await mountAsset(asset, record.blob);
      else asset.missing = true;
    } catch (error) {
      console.warn('Could not load media', asset.name, error);
      asset.missing = true;
    }
  }
  renderAll();
  setSaveState('saved', 'Все изменения сохранены');
}

function setSaveState(mode, label) {
  const node = $('#saveState');
  node.classList.toggle('saving', mode === 'saving');
  node.classList.toggle('error', mode === 'error');
  node.innerHTML = `<i></i>${escapeHTML(label)}`;
}

function checkpoint() {
  historyStack.push(clone(project));
  if (historyStack.length > MAX_HISTORY) historyStack.shift();
  redoStack = [];
  updateHistoryButtons();
}

function updateHistoryButtons() {
  $('#undoBtn').disabled = historyStack.length === 0;
  $('#redoBtn').disabled = redoStack.length === 0;
}

async function restoreProject(snapshot) {
  project = normalizeProject(snapshot);
  selectedClipId = project.clips.some(clip => clip.id === selectedClipId) ? selectedClipId : null;
  currentTime = clamp(currentTime, 0, projectDuration());
  $('#projectName').value = project.name;
  $('#ratioSelect').value = project.ratio;
  await ensureAssetsMounted();
  renderAll();
  scheduleSave();
}

function undo() {
  if (!historyStack.length) return;
  redoStack.push(clone(project));
  const snapshot = historyStack.pop();
  updateHistoryButtons();
  restoreProject(snapshot);
}

function redo() {
  if (!redoStack.length) return;
  historyStack.push(clone(project));
  const snapshot = redoStack.pop();
  updateHistoryButtons();
  restoreProject(snapshot);
}

function scheduleSave() {
  project.updatedAt = Date.now();
  setSaveState('saving', 'Сохраняем…');
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(persistProject, AUTO_SAVE_DELAY);
}

async function persistProject() {
  const snapshot = clone(project);
  const results = await Promise.allSettled([
    db ? dbPut('projects', { id: 'active', project: snapshot }) : Promise.reject(new Error('IndexedDB недоступен')),
    fetch('/api/project', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(snapshot),
    }).then(response => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    }),
  ]);
  const success = results.some(result => result.status === 'fulfilled');
  if (success) setSaveState('saved', 'Все изменения сохранены');
  else setSaveState('error', 'Не удалось сохранить');
}

function showToast(message, type = '') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  $('#toastRegion').appendChild(toast);
  window.setTimeout(() => toast.remove(), 3400);
}

function setCanvasSize() {
  const { width, height } = readRatio(project.ratio);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  if (effectCanvas.width !== width || effectCanvas.height !== height) {
    effectCanvas.width = width;
    effectCanvas.height = height;
  }
  $('#stageRatio').textContent = project.ratio;
  $('#resolutionLabel').textContent = `${width} × ${height} · ${project.fps} FPS`;
  $('#timelineFpsLabel')?.replaceChildren();
  const surface = $('#previewSurface');
  surface.style.aspectRatio = `${width} / ${height}`;
  resizePreviewSurface();
}

function resizePreviewSurface() {
  const zone = $('.preview-zone');
  const surface = $('#previewSurface');
  if (!zone || !surface) return;
  const { width: frameWidth, height: frameHeight } = readRatio(project.ratio);
  const availableWidth = Math.max(90, zone.clientWidth - 28);
  const availableHeight = Math.max(100, zone.clientHeight - 56);
  const aspect = frameWidth / frameHeight;
  let height = Math.min(availableHeight, availableWidth / aspect);
  let width = height * aspect;
  if (width > availableWidth) {
    width = availableWidth;
    height = width / aspect;
  }
  surface.style.width = `${Math.floor(width)}px`;
  surface.style.height = `${Math.floor(height)}px`;
}

function renderAll() {
  setCanvasSize();
  renderLibrary();
  renderInspector();
  renderTimeline();
  updateHeader();
  drawComposition(currentTime);
  updateTimeLabels();
  updateHistoryButtons();
}

function updateHeader() {
  if ($('#projectName').value !== project.name) $('#projectName').value = project.name;
  if ($('#ratioSelect').value !== project.ratio) $('#ratioSelect').value = project.ratio;
  $('#clipCount').textContent = `${project.clips.length} ${project.clips.length === 1 ? 'СЛОЙ' : 'СЛОЁВ'}`;
  $('#timelineFpsLabel')?.replaceChildren();
}

function renderLibrary() {
  const panel = $('#panelContent');
  if (activePanel === 'media') panel.innerHTML = mediaPanelHTML();
  else if (activePanel === 'text') panel.innerHTML = textPanelHTML();
  else if (activePanel === 'effects') panel.innerHTML = effectsPanelHTML();
  else panel.innerHTML = pluginsPanelHTML();
}

function mediaPanelHTML() {
  const assetCards = project.assets.map(asset => {
    const missing = asset.missing ? ' missing' : '';
    const symbol = asset.type === 'audio' ? 'audio' : asset.type === 'video' ? 'video' : 'image';
    const glyph = asset.type === 'audio'
      ? '<svg viewBox="0 0 24 24"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>'
      : asset.type === 'video'
        ? '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="14" height="14" rx="3"></rect><path d="m10 9 4 3-4 3zM17 10l4-3v10l-4-3"></path></svg>'
        : '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="3"></rect><circle cx="9" cy="10" r="2"></circle><path d="m21 15-5-5L5 19"></path></svg>';
    const thumb = asset.type === 'image' && imageElements.has(asset.id)
      ? `<img src="${escapeHTML(mediaUrls.get(asset.id) || '')}" alt="">`
      : glyph;
    return `<div class="asset-card${missing}" title="${missing ? 'Файл не найден в хранилище этого браузера' : escapeHTML(asset.name)}">
      <div class="asset-thumb ${symbol}">${thumb}</div>
      <div class="asset-info"><div class="asset-name">${escapeHTML(asset.name)}</div><div class="asset-meta">${missing ? 'Файл не найден' : `${symbol === 'audio' ? 'АУДИО' : symbol === 'video' ? 'ВИДЕО' : 'ИЗОБРАЖЕНИЕ'} · ${symbol === 'image' ? '5.0 с' : formatTime(asset.duration)}`}</div></div>
      <div class="asset-actions"><button class="asset-remove" data-action="remove-asset" data-asset="${escapeHTML(asset.id)}" title="Убрать из библиотеки" aria-label="Убрать ${escapeHTML(asset.name)}">×</button><button class="asset-add" data-action="add-asset" data-asset="${escapeHTML(asset.id)}" title="Добавить на таймлайн" aria-label="Добавить ${escapeHTML(asset.name)}">+</button></div>
    </div>`;
  }).join('');

  return `<div class="panel-heading"><div><span class="eyebrow">01 / БИБЛИОТЕКА</span><h2>Медиа</h2><p>Твои исходники для следующего хита.</p></div><span class="panel-number">${String(project.assets.length).padStart(2, '0')}</span></div>
    <div id="dropZone" class="drop-zone">
      <div class="drop-icon"><svg viewBox="0 0 24 24"><path d="M12 16V4m0 0L8 8m4-4 4 4"></path><path d="M5 14v5h14v-5"></path></svg></div>
      <strong>Перетащи файлы сюда</strong><small>MP4, MOV, PNG, JPG, MP3 и другие</small>
      <button class="button-outline" data-action="import">Импортировать медиа</button>
    </div>
    <div class="section-head"><span>МОЯ БИБЛИОТЕКА</span><b>${project.assets.length}</b></div>
    <div class="asset-list">${assetCards || '<div class="empty-library">Пока пусто. Импортируй клип или изображение — они останутся в браузере на этом устройстве.</div>'}</div>
    <div class="panel-tip"><b>↳</b><span>Нажми <strong>+</strong>, чтобы поставить медиа в конец видеодорожки. Аудио появится на дорожке звука.</span></div>`;
}

function textPanelHTML() {
  return `<div class="panel-heading"><div><span class="eyebrow">02 / ДИЗАЙН</span><h2>Текст и стикеры</h2><p>Добавь заголовок, субтитр или немного вайба.</p></div></div>
    <div class="section-head"><span>ТЕКСТОВЫЕ СТИЛИ</span><b>03</b></div>
    <div class="tool-card-list">
      <div class="text-style-card" data-action="add-text" data-style="title"><div><div class="text-style-preview" style="font-size:16px;letter-spacing:-.5px">БОЛЬШОЙ ТЕКСТ</div><div class="text-style-desc">Жирный заголовок · появление pop</div></div><span class="text-style-plus">+</span></div>
      <div class="text-style-card" data-action="add-text" data-style="caption"><div><div class="text-style-preview" style="font-size:12px">Тут важная мысль</div><div class="text-style-desc">Читаемая подпись · мягкое появление</div></div><span class="text-style-plus">+</span></div>
      <div class="text-style-card" data-action="add-text" data-style="lower"><div><div class="text-style-preview" style="font-size:11px;color:#c7fa72">МИКРО-ИСТОРИЯ</div><div class="text-style-desc">Нижний титр · простой и чистый</div></div><span class="text-style-plus">+</span></div>
    </div>
    <div class="section-head"><span>ЭМОДЗИ-СТИКЕРЫ</span><b>04</b></div>
    <div class="sticker-grid">
      ${['✨', '💥', '🌀', '💚', '⭐', '👀', '⚡', '🎈'].map(emoji => `<button class="sticker-button" data-action="add-sticker" data-emoji="${emoji}" title="Добавить стикер ${emoji}">${emoji}</button>`).join('')}
    </div>
    <div class="panel-tip"><b>↳</b><span>Выбери слой на таймлайне, чтобы менять текст, шрифт, цвет и анимацию.</span></div>`;
}

function effectsPanelHTML() {
  const cards = [...pluginEffects.values()].map(effect => `<div class="tool-card">
    <div class="tool-card-head"><span class="tool-glyph">${escapeHTML(effect.glyph || '✳')}</span><div><h3>${escapeHTML(effect.name)}</h3></div></div>
    <p>${escapeHTML(effect.description || 'Добавь творческий эффект к выбранному слою.')}</p>
    <button data-action="add-effect" data-effect="${escapeHTML(effect.id)}">Добавить эффект</button>
  </div>`).join('');
  return `<div class="panel-heading"><div><span class="eyebrow">03 / ОБРАБОТКА</span><h2>Эффекты</h2><p>Собери свой визуальный рецепт.</p></div></div>
    <div class="section-head"><span>ЭФФЕКТЫ СЛОЯ</span><b>${pluginEffects.size}</b></div>
    <div class="tool-card-list">${cards || '<div class="empty-library">Эффекты не зарегистрированы.</div>'}</div>
    <div class="panel-tip"><b>↳</b><span>Сначала выбери видео или изображение на таймлайне, затем добавь эффект.</span></div>`;
}

function pluginsPanelHTML() {
  const builtInCards = [...pluginEffects.values()].map(effect => `<div class="plugin-card"><div class="plugin-card-top"><h3>${escapeHTML(effect.name)}</h3><span class="plugin-tag">${effect.external ? 'JS PLUGIN' : 'ВСТРОЕННЫЙ'}</span></div><p>${escapeHTML(effect.description || '')}</p><button data-action="add-effect" data-effect="${escapeHTML(effect.id)}">${effect.external ? 'Применить к слою' : 'Добавить к выбранному'}</button></div>`).join('');
  const actionCards = [...pluginActions.values()].map(action => `<div class="plugin-card"><div class="plugin-card-top"><h3>${escapeHTML(action.name)}</h3><span class="plugin-tag">ДЕЙСТВИЕ</span></div><p>${escapeHTML(action.description || 'Пользовательское действие')}</p><button data-action="run-plugin" data-plugin="${escapeHTML(action.id)}">Запустить</button></div>`).join('');
  return `<div class="panel-heading"><div><span class="eyebrow">04 / РАСШИРЕНИЯ</span><h2>Плагины</h2><p>Добавляй свои инструменты и эффекты.</p></div></div>
    <div class="drop-zone" style="min-height:118px">
      <div class="drop-icon"><svg viewBox="0 0 24 24"><path d="M9 4v4M15 4v4M8 8h8v4a4 4 0 0 1-4 4v4M8 8H5a2 2 0 0 0-2 2v2a2 2 0 0 0 2 2h3"></path><path d="M16 12h3a2 2 0 0 1 2 2v2"></path></svg></div>
      <strong>Подключить JS-плагин</strong><small>Модуль .js или .mjs с default export</small>
      <button class="button-outline" data-action="import-plugin">Выбрать файл</button>
    </div>
    <div class="plugin-warning">⚠ Плагин выполняет JavaScript в этой вкладке. Загружай только доверенный код.</div>
    <div class="section-head"><span>УСТАНОВЛЕННЫЕ ЭФФЕКТЫ</span><b>${pluginEffects.size}</b></div>
    <div class="tool-card-list">${builtInCards}</div>
    ${actionCards ? `<div class="section-head"><span>ДЕЙСТВИЯ</span><b>${pluginActions.size}</b></div><div class="tool-card-list">${actionCards}</div>` : ''}
    <div class="section-head"><span>ПРИМЕР ПЛАГИНА</span></div><div class="panel-tip"><b>↗</b><span>Файл <strong>web/plugins/pulse-zoom.js</strong> показывает минимальную структуру расширения.</span></div>`;
}

function renderInspector() {
  const clip = getSelectedClip();
  const content = $('#inspectorContent');
  if (!clip) {
    $('#inspectorTitle').textContent = 'Проект';
    content.innerHTML = `<div class="inspector-section"><div class="inspector-section-head"><span>ХОЛСТ</span></div>
      <div class="control-row"><label class="control-label" for="projectBg">Цвет фона</label><input id="projectBg" class="text-input" type="color" value="${escapeHTML(project.background)}" data-editable="true" data-project-field="background"></div>
      <div class="control-row"><label class="control-label">Формат кадра <span class="control-value">${escapeHTML(project.ratio)}</span></label></div>
      <div class="project-info-card"><strong>Локальный монтаж</strong>Исходные файлы хранятся в IndexedDB браузера. Проект и таймлайн сохраняются автоматически.</div>
      </div>
      <div class="inspector-section"><div class="inspector-section-head"><span>ПРОЕКТНЫЙ ФАЙЛ</span></div>
        <button class="tool-card-button" data-action="download-project">Скачать монтаж JSON</button>
        <button class="tool-card-button" data-action="load-project">Загрузить монтаж JSON</button>
        <p class="mini-note">JSON содержит таймлайн, но не видео- и аудиофайлы. Сохрани медиа отдельно.</p>
      </div>
      <div class="project-info-card"><strong>Творческие права</strong>Используй музыку, видео и изображения, на которые у тебя есть разрешение.</div>`;
    return;
  }

  const typeLabel = { video: 'Видеоклип', image: 'Изображение', audio: 'Аудио', text: 'Текстовый слой', sticker: 'Стикер' }[clip.type] || 'Слой';
  $('#inspectorTitle').textContent = clip.name || typeLabel;
  const range = (label, field, value, min, max, step, display, extra = '') => `<div class="control-row"><label class="control-label" for="field-${field}">${label}<output>${display ?? value}</output></label><input id="field-${field}" class="range-input" type="range" min="${min}" max="${max}" step="${step}" value="${value}" data-editable="true" data-field="${field}" ${extra}></div>`;
  const select = (label, field, value, options) => `<div class="control-row"><label class="control-label" for="field-${field}">${label}</label><select id="field-${field}" class="select-input" data-editable="true" data-field="${field}">${options.map(option => `<option value="${escapeHTML(option.value)}" ${option.value === value ? 'selected' : ''}>${escapeHTML(option.label)}</option>`).join('')}</select></div>`;
  const posScale = `<div class="inspector-section"><div class="inspector-section-head"><span>ТРАНСФОРМАЦИЯ</span><button title="Сбросить положение" data-action="reset-transform">↺</button></div>
    <div class="two-col"><div class="control-row"><label class="control-label" for="field-x">Позиция X</label><input id="field-x" class="text-input" type="number" min="-100" max="100" step="1" value="${clip.x}" data-editable="true" data-field="x"></div><div class="control-row"><label class="control-label" for="field-y">Позиция Y</label><input id="field-y" class="text-input" type="number" min="-100" max="100" step="1" value="${clip.y}" data-editable="true" data-field="y"></div></div>
    ${range('Масштаб', 'scale', clip.scale, 0.25, 3, 0.01, `${Math.round(clip.scale * 100)}%`)}
    ${range('Непрозрачность', 'opacity', clip.opacity, 0, 1, 0.01, `${Math.round(clip.opacity * 100)}%`)}</div>`;

  let typeFields = '';
  if (clip.type === 'text' || clip.type === 'sticker') {
    typeFields = `<div class="inspector-section"><div class="inspector-section-head"><span>ТЕКСТ И СТИЛЬ</span></div>
      <div class="control-row"><label class="control-label" for="field-text">Содержание</label><textarea id="field-text" class="textarea-input" maxlength="180" data-editable="true" data-field="text">${escapeHTML(clip.text)}</textarea></div>
      <div class="two-col"><div class="control-row"><label class="control-label" for="field-color">Цвет текста</label><input id="field-color" class="text-input" type="color" value="${escapeHTML(clip.color)}" data-editable="true" data-field="color"></div><div class="control-row"><label class="control-label" for="field-fontSize">Размер</label><input id="field-fontSize" class="text-input" type="number" min="16" max="240" value="${clip.fontSize}" data-editable="true" data-field="fontSize"></div></div>
      <div class="two-col">${select('Выравнивание', 'align', clip.align, [{ value: 'left', label: 'Слева' }, { value: 'center', label: 'По центру' }, { value: 'right', label: 'Справа' }])}${select('Анимация', 'animation', clip.animation, [{ value: 'none', label: 'Без анимации' }, { value: 'fade', label: 'Плавное появление' }, { value: 'pop', label: 'Pop' }, { value: 'bounce', label: 'Пружина' }])}</div>
      ${range('Обводка', 'stroke', clip.stroke, 0, 14, 1, `${clip.stroke}px`)}
      <label class="check-row">Подложка текста <span class="toggle"><input type="checkbox" data-editable="true" data-field="backgroundEnabled" ${clip.backgroundEnabled ? 'checked' : ''}><span></span></span></label>
      ${clip.backgroundEnabled ? `<div class="control-row"><label class="control-label" for="field-backgroundColor">Цвет подложки</label><input id="field-backgroundColor" class="text-input" type="color" value="${escapeHTML(clip.backgroundColor)}" data-editable="true" data-field="backgroundColor"></div>` : ''}
      </div>`;
  } else if (clip.type === 'video' || clip.type === 'image') {
    typeFields = `<div class="inspector-section"><div class="inspector-section-head"><span>ИЗОБРАЖЕНИЕ</span></div>
      ${select('Вписать кадр', 'fit', clip.fit, [{ value: 'cover', label: 'Заполнить (обрезать)' }, { value: 'contain', label: 'Вписать целиком' }])}
      ${range('Яркость', 'brightness', clip.brightness, 0, 200, 1, `${Math.round(clip.brightness)}%`)}
      ${range('Насыщенность', 'saturation', clip.saturation, 0, 200, 1, `${Math.round(clip.saturation)}%`)}
      ${range('Контраст', 'contrast', clip.contrast, 0, 200, 1, `${Math.round(clip.contrast)}%`)}
      ${range('Размытие', 'blur', clip.blur, 0, 18, 0.5, `${clip.blur}px`)}
      ${clip.type === 'video' ? range('Громкость', 'volume', clip.volume, 0, 1, 0.01, `${Math.round(clip.volume * 100)}%`) : ''}
      </div>`;
  } else if (clip.type === 'audio') {
    typeFields = `<div class="inspector-section"><div class="inspector-section-head"><span>ЗВУК</span></div>${range('Громкость', 'volume', clip.volume, 0, 1, 0.01, `${Math.round(clip.volume * 100)}%`)}<div class="project-info-card">Звук воспроизводится только в пределах этого аудиоклипа.</div></div>`;
  }

  const effectsHTML = (clip.effects || []).map((instance, index) => {
    const effect = pluginEffects.get(instance.id);
    if (!effect) return `<div class="effect-setting"><div class="effect-chip"><span>Неизвестный эффект · ${escapeHTML(instance.id)}</span><button data-action="remove-effect" data-index="${index}" title="Удалить эффект">×</button></div></div>`;
    const controls = (effect.controls || []).map(control => {
      const value = instance.settings?.[control.key] ?? effect.defaults?.[control.key] ?? control.default;
      const dataAttrs = `data-editable="true" data-effect-id="${escapeHTML(effect.id)}" data-setting="${escapeHTML(control.key)}"`;
      if (control.type === 'color') return `<div class="control-row"><label class="control-label">${escapeHTML(control.label)}</label><input class="text-input" type="color" value="${escapeHTML(value || '#ffffff')}" ${dataAttrs}></div>`;
      if (control.type === 'toggle') return `<label class="check-row">${escapeHTML(control.label)}<span class="toggle"><input type="checkbox" ${value ? 'checked' : ''} ${dataAttrs}><span></span></span></label>`;
      if (control.type === 'select') return `<div class="control-row"><label class="control-label">${escapeHTML(control.label)}</label><select class="select-input" ${dataAttrs}>${(control.options || []).map(option => `<option value="${escapeHTML(option.value)}" ${String(option.value) === String(value) ? 'selected' : ''}>${escapeHTML(option.label)}</option>`).join('')}</select></div>`;
      return `<div class="control-row"><label class="control-label">${escapeHTML(control.label)}<output>${control.unit === '%' ? `${Math.round(Number(value) * 100)}%` : escapeHTML(value)}</output></label><input class="range-input" type="range" min="${control.min ?? 0}" max="${control.max ?? 1}" step="${control.step ?? 0.01}" value="${Number(value) || 0}" ${dataAttrs}></div>`;
    }).join('');
    return `<div class="effect-setting"><div class="effect-chip"><span>${escapeHTML(effect.name)}</span><button data-action="remove-effect" data-index="${index}" title="Удалить эффект">×</button></div>${controls}</div>`;
  }).join('');
  const effectsSection = clip.type === 'video' || clip.type === 'image'
    ? `<div class="inspector-section"><div class="inspector-section-head"><span>ЭФФЕКТЫ СЛОЯ</span><button data-action="go-effects" title="Открыть эффекты">+</button></div>${effectsHTML || '<div class="effect-empty">Добавь цветовой ключ, монохром или VHS.</div>'}</div>`
    : '';

  content.innerHTML = `<div class="inspector-section"><div class="inspector-section-head"><span>${escapeHTML(typeLabel.toUpperCase())}</span></div>
      <div class="control-row"><label class="control-label" for="field-name">Имя слоя</label><input id="field-name" class="text-input" type="text" maxlength="60" value="${escapeHTML(clip.name)}" data-editable="true" data-field="name"></div>
      <div class="two-col"><div class="control-row"><label class="control-label" for="field-start">Начало · сек</label><input id="field-start" class="text-input" type="number" min="0" step="0.1" value="${clip.start.toFixed(2)}" data-editable="true" data-field="start"></div><div class="control-row"><label class="control-label" for="field-duration">Длина · сек</label><input id="field-duration" class="text-input" type="number" min="0.2" step="0.1" value="${clip.duration.toFixed(2)}" data-editable="true" data-field="duration"></div></div>
      </div>${typeFields}${clip.type !== 'audio' ? posScale : ''}${effectsSection}`;
}

function renderTimeline() {
  const duration = timelineVisibleDuration();
  const width = Math.ceil(100 + duration * timelineScale);
  const inner = $('#timelineInner');
  inner.style.width = `${width}px`;
  inner.style.height = `${28 + TRACKS.length * 54}px`;
  const ruler = $('#timelineRuler');
  ruler.style.width = `${width}px`;
  const rulerParts = ['<div class="ruler-origin"></div>'];
  for (let second = 0; second <= Math.ceil(duration); second += 1) {
    const left = 100 + second * timelineScale;
    if (second % 5 === 0 || second === 0) {
      const label = `${String(Math.floor(second / 60)).padStart(2, '0')}:${String(second % 60).padStart(2, '0')}`;
      rulerParts.push(`<div class="ruler-mark" style="left:${left}px"><small>${label}</small></div>`);
    } else {
      rulerParts.push(`<div class="ruler-mark minor" style="left:${left}px"></div>`);
    }
  }
  ruler.innerHTML = rulerParts.join('');
  const tracks = $('#timelineTracks');
  tracks.style.width = `${width}px`;
  tracks.innerHTML = TRACKS.map(track => {
    const clips = project.clips.filter(clip => clip.track === track.id).map(clip => {
      const left = Math.round(clip.start * timelineScale);
      const clipWidth = Math.max(28, Math.round(clip.duration * timelineScale));
      const selected = selectedClipId === clip.id ? ' selected' : '';
      const icon = clip.type === 'text' ? 'T' : clip.type === 'sticker' ? '✦' : clip.type === 'audio' ? '♫' : clip.type === 'image' ? '▧' : '▶';
      return `<div class="timeline-clip type-${escapeHTML(clip.type)}${selected}" data-clip-id="${escapeHTML(clip.id)}" style="left:${left}px;width:${clipWidth}px" title="${escapeHTML(clip.name)} · ${clip.duration.toFixed(2)} сек">
        <div class="trim-handle left" data-edge="left"></div><div class="clip-title"><span class="clip-kind">${icon}</span>${escapeHTML(clip.name)}</div><div class="trim-handle right" data-edge="right"></div>
      </div>`;
    }).join('');
    return `<div class="track-row" data-track="${track.id}"><div class="track-label"><i></i>${track.name}</div><div class="track-lane" data-track="${track.id}" style="width:${width - 100}px">${clips}</div></div>`;
  }).join('');
  $$('.track-lane', tracks).forEach(lane => {
    lane.addEventListener('click', event => {
      if (event.target.closest('.timeline-clip')) return;
      const rect = lane.getBoundingClientRect();
      seekTo((event.clientX - rect.left) / timelineScale);
    });
  });
  $$('.timeline-clip', tracks).forEach(clipElement => setupClipPointer(clipElement));
  $('#zoomFill').style.width = `${Math.round(((timelineScale - 36) / (130 - 36)) * 100)}%`;
  updatePlayhead();
  updateSelectionUI();
}

function setupClipPointer(element) {
  element.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const id = element.dataset.clipId;
    const clip = project.clips.find(item => item.id === id);
    if (!clip) return;
    if (selectedClipId !== id) {
      selectedClipId = id;
      updateSelectionUI();
      renderInspector();
    }
    checkpoint();
    const handle = event.target.closest('.trim-handle');
    const edge = handle?.dataset.edge || 'move';
    const original = { start: clip.start, duration: clip.duration, inPoint: clip.inPoint };
    const pointerX = event.clientX;
    element.setPointerCapture(event.pointerId);
    const onMove = moveEvent => {
      const delta = (moveEvent.clientX - pointerX) / timelineScale;
      if (edge === 'left') {
        const nextStart = Math.max(0, original.start + delta);
        const actualDelta = nextStart - original.start;
        clip.start = nextStart;
        clip.duration = Math.max(0.2, original.duration - actualDelta);
        if (clip.assetId) clip.inPoint = Math.max(0, original.inPoint + actualDelta);
      } else if (edge === 'right') {
        const asset = clip.assetId ? getAsset(clip.assetId) : null;
        const maxDuration = asset ? Math.max(0.2, asset.duration - clip.inPoint) : 9999;
        clip.duration = clamp(original.duration + delta, 0.2, maxDuration);
      } else {
        clip.start = Math.max(0, original.start + delta);
      }
      element.style.left = `${Math.round(clip.start * timelineScale)}px`;
      element.style.width = `${Math.max(28, Math.round(clip.duration * timelineScale))}px`;
      element.title = `${clip.name} · ${clip.duration.toFixed(2)} сек`;
      updateActionButtons();
      drawComposition(currentTime);
      scheduleSave();
    };
    const onUp = () => {
      element.removeEventListener('pointermove', onMove);
      element.removeEventListener('pointerup', onUp);
      element.removeEventListener('pointercancel', onUp);
      renderTimeline();
      renderInspector();
      drawComposition(currentTime);
    };
    element.addEventListener('pointermove', onMove);
    element.addEventListener('pointerup', onUp);
    element.addEventListener('pointercancel', onUp);
  });
}

function updatePlayhead() {
  $('#playhead').style.left = `${100 + currentTime * timelineScale}px`;
}

function updateTimeLabels() {
  $('#currentTimeLabel').textContent = formatTime(currentTime);
  $('#durationLabel').textContent = formatTime(projectDuration());
  updatePlayhead();
}

function updateSelectionUI() {
  $$('.timeline-clip').forEach(element => element.classList.toggle('selected', element.dataset.clipId === selectedClipId));
  updateActionButtons();
}

function updateActionButtons() {
  const clip = getSelectedClip();
  $('#splitBtn').disabled = !clip || currentTime <= clip.start + 0.05 || currentTime >= clip.start + clip.duration - 0.05;
  $('#duplicateBtn').disabled = !clip;
  $('#deleteBtn').disabled = !clip;
}

function seekTo(time) {
  currentTime = clamp(Number(time) || 0, 0, projectDuration());
  if (isPlaying) playbackOrigin = performance.now() - currentTime * 1000;
  syncMedia(currentTime, isPlaying);
  drawComposition(currentTime);
  updateTimeLabels();
}

function togglePlayback() {
  if (isPlaying) pausePlayback();
  else startPlayback();
}

function updatePlayButton() {
  const button = $('#playBtn');
  button.disabled = isExporting;
  if (isPlaying) {
    button.setAttribute('aria-label', 'Пауза');
    $('#playIcon').innerHTML = '<path d="M7 5h4v14H7zM14 5h4v14h-4z"></path>';
  } else {
    button.setAttribute('aria-label', 'Воспроизвести');
    $('#playIcon').innerHTML = '<path d="m8 5 11 7-11 7z"></path>';
  }
}

function startPlayback(fromExport = false) {
  if (isPlaying) return;
  if (currentTime >= projectDuration() - 0.02) currentTime = 0;
  isPlaying = true;
  playbackOrigin = performance.now() - currentTime * 1000;
  updatePlayButton();
  syncMedia(currentTime, true);
  drawComposition(currentTime);
  frameRequest = requestAnimationFrame(playFrame);
}

function pausePlayback() {
  isPlaying = false;
  cancelAnimationFrame(frameRequest);
  updatePlayButton();
  syncMedia(currentTime, false);
  drawComposition(currentTime);
  if (isExporting && recorder && recorder.state === 'recording') recorder.stop();
}

function playFrame(now) {
  if (!isPlaying) return;
  currentTime = Math.min(projectDuration(), Math.max(0, (now - playbackOrigin) / 1000));
  syncMedia(currentTime, true);
  const drawInterval = 1000 / clamp(project.fps || 30, 12, 60);
  if (!lastDrawAt || now - lastDrawAt >= drawInterval) {
    drawComposition(currentTime);
    lastDrawAt = now;
  }
  updateTimeLabels();
  if (isExporting) updateExportProgress();
  if (currentTime >= projectDuration()) {
    isPlaying = false;
    updatePlayButton();
    syncMedia(currentTime, false);
    if (isExporting && recorder && recorder.state === 'recording') recorder.stop();
    return;
  }
  frameRequest = requestAnimationFrame(playFrame);
}

function syncMedia(time, playing) {
  const activeByAsset = new Map();
  for (const clip of project.clips) {
    if (!clip.assetId || !mediaElements.has(clip.assetId)) continue;
    const active = time >= clip.start && time < clip.start + clip.duration;
    if (active) {
      const existing = activeByAsset.get(clip.assetId);
      if (!existing || clip.track > existing.track) activeByAsset.set(clip.assetId, clip);
    }
  }
  for (const [assetId, element] of mediaElements) {
    const clip = activeByAsset.get(assetId);
    if (!clip) {
      if (!element.paused) element.pause();
      continue;
    }
    const mediaDuration = Number.isFinite(element.duration) ? element.duration : clip.duration + clip.inPoint;
    const desired = clamp(clip.inPoint + (time - clip.start), 0, Math.max(0, mediaDuration - 0.02));
    const drift = Math.abs((element.currentTime || 0) - desired);
    if (drift > (playing ? 0.75 : 0.035)) {
      try { element.currentTime = desired; } catch (_) { /* wait for metadata */ }
    }
    element.volume = clamp(Number(clip.volume) || 0, 0, 1);
    if (playing) {
      if (element.paused) {
        const playPromise = element.play();
        if (playPromise?.catch) playPromise.catch(() => {});
      }
    } else if (!element.paused) {
      element.pause();
    }
  }
}

function activeEffects(clip) {
  return (clip.effects || []).filter(instance => instance && instance.enabled !== false && pluginEffects.has(instance.id));
}

function getSourceForClip(clip) {
  if (clip.type === 'image') return imageElements.get(clip.assetId) || null;
  if (clip.type === 'video') return mediaElements.get(clip.assetId) || null;
  return null;
}

function fitSource(source, width, height, fit) {
  const sourceWidth = source.videoWidth || source.naturalWidth || source.width || width;
  const sourceHeight = source.videoHeight || source.naturalHeight || source.height || height;
  if (!sourceWidth || !sourceHeight) return { sx: 0, sy: 0, sw: width, sh: height, dx: 0, dy: 0, dw: width, dh: height };
  const scale = fit === 'contain' ? Math.min(width / sourceWidth, height / sourceHeight) : Math.max(width / sourceWidth, height / sourceHeight);
  const dw = sourceWidth * scale;
  const dh = sourceHeight * scale;
  return { sx: 0, sy: 0, sw: sourceWidth, sh: sourceHeight, dx: (width - dw) / 2, dy: (height - dh) / 2, dw, dh };
}

function drawVisualClip(clip, time) {
  const source = getSourceForClip(clip);
  if (!source) return;
  if (clip.type === 'video' && source.readyState < 2) return;
  if (clip.type === 'image' && !source.complete) return;
  const width = canvas.width;
  const height = canvas.height;
  effectCtx.save();
  effectCtx.clearRect(0, 0, width, height);
  effectCtx.filter = `brightness(${clamp(clip.brightness, 0, 200)}%) saturate(${clamp(clip.saturation, 0, 200)}%) contrast(${clamp(clip.contrast, 0, 200)}%) blur(${clamp(clip.blur, 0, 18)}px)`;
  const fit = fitSource(source, width, height, clip.fit);
  try {
    effectCtx.drawImage(source, fit.sx, fit.sy, fit.sw, fit.sh, fit.dx, fit.dy, fit.dw, fit.dh);
  } catch (_) {
    effectCtx.restore();
    return;
  }
  effectCtx.filter = 'none';
  const localTime = clamp(time - clip.start, 0, clip.duration);
  const instances = activeEffects(clip);
  for (const instance of instances) {
    const effect = pluginEffects.get(instance.id);
    if (typeof effect.apply === 'function') {
      try {
        effect.apply({ ctx: effectCtx, canvas: effectCanvas, time: localTime, duration: clip.duration, settings: { ...effect.defaults, ...instance.settings }, clip: clone(clip) });
      } catch (error) {
        if (!pluginLoadErrors.has(effect.id)) {
          pluginLoadErrors.add(effect.id);
          console.error(`Effect ${effect.id} failed`, error);
          showToast(`Эффект «${effect.name}» завершился с ошибкой`, 'error');
        }
      }
    }
  }
  effectCtx.restore();

  let animationScale = 1;
  for (const instance of instances) {
    const effect = pluginEffects.get(instance.id);
    if (typeof effect.transformScale === 'function') {
      try {
        animationScale *= Number(effect.transformScale({ time: localTime, duration: clip.duration, settings: { ...effect.defaults, ...instance.settings }, clip: clone(clip) })) || 1;
      } catch (error) {
        console.warn('Plugin transform failed', error);
      }
    }
  }
  ctx.save();
  ctx.globalAlpha = clamp(clip.opacity, 0, 1);
  ctx.translate(width / 2 + (Number(clip.x) / 100) * width, height / 2 + (Number(clip.y) / 100) * height);
  ctx.scale(clamp(clip.scale * animationScale, 0.1, 5), clamp(clip.scale * animationScale, 0.1, 5));
  ctx.drawImage(effectCanvas, -width / 2, -height / 2, width, height);
  ctx.restore();
  for (const instance of instances) {
    const effect = pluginEffects.get(instance.id);
    if (typeof effect.overlay === 'function') {
      try {
        effect.overlay({ ctx, width, height, time: localTime, duration: clip.duration, settings: { ...effect.defaults, ...instance.settings }, clip: clone(clip) });
      } catch (error) {
        console.warn('Plugin overlay failed', error);
      }
    }
  }
}

function textAnimation(clip, localTime) {
  let alpha = 1;
  let scale = 1;
  if (clip.animation === 'fade') {
    alpha = Math.min(1, localTime / 0.3, (clip.duration - localTime) / 0.25);
    alpha = clamp(alpha, 0, 1);
  } else if (clip.animation === 'pop') {
    if (localTime < 0.22) scale = 0.72 + 0.28 * (localTime / 0.22);
    else if (localTime < 0.34) scale = 1 + 0.045 * Math.sin(((localTime - 0.22) / 0.12) * Math.PI);
    const fadeOut = clip.duration - localTime;
    if (fadeOut < 0.16) alpha = clamp(fadeOut / 0.16, 0, 1);
  } else if (clip.animation === 'bounce') {
    if (localTime < 0.5) scale = 0.82 + 0.18 * (1 - Math.pow(1 - localTime / 0.5, 2));
    if (clip.duration - localTime < 0.16) alpha = clamp((clip.duration - localTime) / 0.16, 0, 1);
  }
  return { alpha, scale };
}

function wrapTextLines(text, maxWidth, context) {
  const paragraphs = String(text || '').split('\n');
  const lines = [];
  for (const paragraph of paragraphs) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (!words.length) {
      lines.push('');
      continue;
    }
    let line = '';
    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (line && context.measureText(test).width > maxWidth) {
        lines.push(line);
        line = word;
      } else line = test;
    }
    lines.push(line);
  }
  return lines.slice(0, 8);
}

function drawTextClip(clip, time) {
  const local = time - clip.start;
  const { alpha, scale } = textAnimation(clip, local);
  if (alpha <= 0) return;
  const width = canvas.width;
  const height = canvas.height;
  const fontSize = clip.type === 'sticker' ? Math.max(60, clip.fontSize) : clamp(clip.fontSize, 16, 240);
  const text = clip.text || (clip.type === 'sticker' ? '✨' : '');
  ctx.save();
  ctx.globalAlpha = alpha * clamp(clip.opacity, 0, 1);
  ctx.translate(width / 2 + (clip.x / 100) * width, height / 2 + (clip.y / 100) * height);
  ctx.scale(scale * clip.scale, scale * clip.scale);
  ctx.textAlign = clip.align;
  ctx.textBaseline = 'middle';
  ctx.font = `${clip.fontWeight} ${fontSize}px ${clip.fontFamily}`;
  ctx.lineJoin = 'round';
  ctx.lineWidth = clip.stroke;
  ctx.strokeStyle = 'rgba(0,0,0,.82)';
  ctx.fillStyle = clip.color;
  ctx.shadowColor = 'rgba(0,0,0,.35)';
  ctx.shadowBlur = Math.max(0, fontSize * 0.13);
  ctx.shadowOffsetY = fontSize * 0.045;
  const maxWidth = width * 0.84;
  const lines = wrapTextLines(text, maxWidth, ctx);
  const lineHeight = fontSize * 1.18;
  const widest = Math.min(maxWidth, Math.max(0, ...lines.map(line => ctx.measureText(line).width)));
  const anchorX = clip.align === 'left' ? -maxWidth / 2 : clip.align === 'right' ? maxWidth / 2 : 0;
  const boxPaddingX = fontSize * 0.22;
  const boxPaddingY = fontSize * 0.13;
  const blockHeight = lineHeight * lines.length;
  if (clip.backgroundEnabled) {
    ctx.save();
    ctx.shadowColor = 'transparent';
    ctx.fillStyle = clip.backgroundColor;
    ctx.globalAlpha *= 0.76;
    const boxX = clip.align === 'left' ? anchorX - boxPaddingX : clip.align === 'right' ? anchorX - widest - boxPaddingX : -widest / 2 - boxPaddingX;
    ctx.beginPath();
    roundedRect(ctx, boxX, -blockHeight / 2 - boxPaddingY, widest + boxPaddingX * 2, blockHeight + boxPaddingY * 2, fontSize * 0.12);
    ctx.fill();
    ctx.restore();
    ctx.globalAlpha = alpha * clamp(clip.opacity, 0, 1);
  }
  lines.forEach((line, index) => {
    const y = (index - (lines.length - 1) / 2) * lineHeight;
    if (clip.stroke > 0) ctx.strokeText(line, anchorX, y, maxWidth);
    ctx.fillText(line, anchorX, y, maxWidth);
  });
  ctx.restore();
}

function roundedRect(context, x, y, width, height, radius) {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
}

function drawComposition(time) {
  if (!ctx) return;
  const width = canvas.width;
  const height = canvas.height;
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.filter = 'none';
  ctx.fillStyle = project.background || '#11120f';
  ctx.fillRect(0, 0, width, height);
  const active = project.clips
    .filter(clip => clip.track !== 2 && clip.type !== 'audio' && time >= clip.start && time < clip.start + clip.duration)
    .sort((a, b) => a.track - b.track || project.clips.indexOf(a) - project.clips.indexOf(b));
  for (const clip of active) {
    if (clip.type === 'text' || clip.type === 'sticker') drawTextClip(clip, time);
    else drawVisualClip(clip, time);
  }
  ctx.restore();
}

function registerEffect(effect, external = false) {
  if (!effect || typeof effect !== 'object' || !/^[a-z0-9][a-z0-9._-]{1,63}$/i.test(effect.id || '') || !effect.name) {
    throw new Error('У эффекта должны быть корректные id и name.');
  }
  pluginEffects.set(effect.id, {
    ...effect,
    external: external || Boolean(effect.external),
    controls: Array.isArray(effect.controls) ? effect.controls : [],
    defaults: effect.defaults || {},
  });
  renderLibrary();
  if (getSelectedClip()) renderInspector();
}

function registerAction(action, external = false) {
  if (!action || typeof action !== 'object' || !/^[a-z0-9][a-z0-9._-]{1,63}$/i.test(action.id || '') || !action.name || typeof action.run !== 'function') {
    throw new Error('У действия должны быть id, name и функция run(api).');
  }
  pluginActions.set(action.id, { ...action, external: external || Boolean(action.external) });
  renderLibrary();
}

const PluginAPI = Object.freeze({
  registerEffect: effect => registerEffect(effect, true),
  registerAction: action => registerAction(action, true),
  addEffect: id => addEffectToSelected(id),
  addText: text => addText({ text: String(text || 'Новый текст') }),
  getSelectedClip: () => {
    const clip = getSelectedClip();
    return clip ? { id: clip.id, type: clip.type, name: clip.name, start: clip.start, duration: clip.duration } : null;
  },
  toast: message => showToast(String(message)),
});

function registerBuiltins() {
  registerEffect({
    id: 'chroma-key', name: 'Цветовой ключ', glyph: '◌',
    description: 'Удаляет однотонный фон. Лучше всего работает с равномерным зелёным экраном.',
    defaults: { color: '#21c66b', threshold: 0.2, softness: 0.13 },
    controls: [
      { key: 'color', label: 'Цвет фона', type: 'color', default: '#21c66b' },
      { key: 'threshold', label: 'Порог', type: 'range', min: 0.03, max: 0.55, step: 0.01, default: 0.2 },
      { key: 'softness', label: 'Мягкий край', type: 'range', min: 0, max: 0.45, step: 0.01, default: 0.13 },
    ],
    apply({ ctx: effectContext, canvas: effectSurface, settings }) {
      const image = effectContext.getImageData(0, 0, effectSurface.width, effectSurface.height);
      const data = image.data;
      const hex = String(settings.color || '#21c66b').replace('#', '');
      const target = [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
      const threshold = clamp(Number(settings.threshold) || 0.2, 0, 1) * 441.67;
      const softness = Math.max(0.001, (Number(settings.softness) || 0.01) * 441.67);
      for (let index = 0; index < data.length; index += 4) {
        const dr = data[index] - target[0];
        const dg = data[index + 1] - target[1];
        const db = data[index + 2] - target[2];
        const distance = Math.sqrt(dr * dr + dg * dg + db * db);
        if (distance < threshold) data[index + 3] = 0;
        else if (distance < threshold + softness) data[index + 3] = Math.round(data[index + 3] * ((distance - threshold) / softness));
      }
      effectContext.putImageData(image, 0, 0);
    },
  });
  registerEffect({
    id: 'mono', name: 'Монохром', glyph: '◑',
    description: 'Сдержанный чёрно-белый тон с регулируемой интенсивностью.',
    defaults: { amount: 1 },
    controls: [{ key: 'amount', label: 'Интенсивность', type: 'range', min: 0, max: 1, step: 0.01, default: 1 }],
    apply({ ctx: effectContext, canvas: effectSurface, settings }) {
      const amount = clamp(Number(settings.amount) || 0, 0, 1);
      const image = effectContext.getImageData(0, 0, effectSurface.width, effectSurface.height);
      const data = image.data;
      for (let index = 0; index < data.length; index += 4) {
        const gray = data[index] * 0.2126 + data[index + 1] * 0.7152 + data[index + 2] * 0.0722;
        data[index] += (gray - data[index]) * amount;
        data[index + 1] += (gray - data[index + 1]) * amount;
        data[index + 2] += (gray - data[index + 2]) * amount;
      }
      effectContext.putImageData(image, 0, 0);
    },
  });
  registerEffect({
    id: 'vhs-lines', name: 'VHS-сканирование', glyph: '▤',
    description: 'Добавляет тонкие аналоговые строки поверх клипа.',
    defaults: { intensity: 0.2, spacing: 5 },
    controls: [
      { key: 'intensity', label: 'Интенсивность', type: 'range', min: 0.03, max: 0.65, step: 0.01, default: 0.2 },
      { key: 'spacing', label: 'Шаг строк', type: 'range', min: 2, max: 12, step: 1, default: 5 },
    ],
    apply({ ctx: effectContext, canvas: effectSurface, settings }) {
      effectContext.save();
      effectContext.globalCompositeOperation = 'source-atop';
      effectContext.fillStyle = `rgba(0,0,0,${clamp(Number(settings.intensity) || 0, 0, 0.8)})`;
      const spacing = clamp(Number(settings.spacing) || 5, 2, 16);
      for (let y = 0; y < effectSurface.height; y += spacing) effectContext.fillRect(0, y, effectSurface.width, 1);
      effectContext.restore();
    },
  });
  registerEffect({
    id: 'pulse-zoom', name: 'Пульс-зум', glyph: '↗',
    description: 'Лёгкое ритмичное масштабирование выбранного слоя.',
    defaults: { amount: 0.035, speed: 2 },
    controls: [
      { key: 'amount', label: 'Амплитуда', type: 'range', min: 0, max: 0.18, step: 0.005, default: 0.035 },
      { key: 'speed', label: 'Скорость', type: 'range', min: 0.5, max: 8, step: 0.1, default: 2 },
    ],
    transformScale({ time, settings }) {
      return 1 + clamp(Number(settings.amount) || 0, 0, 0.2) * Math.sin(time * (Number(settings.speed) || 2) * Math.PI * 2);
    },
  });
}

function addEffectToSelected(id) {
  const clip = getSelectedClip();
  const effect = pluginEffects.get(id);
  if (!clip) {
    showToast('Сначала выбери слой на таймлайне.');
    return;
  }
  if (clip.type !== 'video' && clip.type !== 'image') {
    showToast('Эффекты можно добавить к видеоклипу или изображению.');
    return;
  }
  if (!effect) {
    showToast('Эффект не найден.', 'error');
    return;
  }
  if (clip.effects.some(item => item.id === id)) {
    showToast('Этот эффект уже добавлен к слою.');
    return;
  }
  checkpoint();
  const defaults = { ...effect.defaults };
  for (const control of effect.controls || []) {
    if (!(control.key in defaults)) defaults[control.key] = control.default;
  }
  clip.effects.push({ id, enabled: true, settings: defaults });
  renderInspector();
  renderTimeline();
  drawComposition(currentTime);
  scheduleSave();
  showToast(`Эффект «${effect.name}» добавлен`);
}

function addText(options = {}) {
  checkpoint();
  const preset = options.preset || 'title';
  const style = preset === 'caption'
    ? { text: 'Тут важная мысль', fontSize: 52, fontWeight: 750, color: '#ffffff', y: 26, animation: 'fade', stroke: 3 }
    : preset === 'lower'
      ? { text: 'МИКРО-ИСТОРИЯ', fontSize: 42, fontWeight: 900, color: '#c7fa72', y: 32, animation: 'fade', stroke: 2 }
      : { text: 'БОЛЬШОЙ ТЕКСТ', fontSize: 82, fontWeight: 900, color: '#ffffff', y: 10, animation: 'pop', stroke: 5 };
  const clip = normalizeClip({
    id: uuid(), type: 'text', name: options.name || (preset === 'lower' ? 'Нижний титр' : 'Текст'),
    text: options.text ?? style.text, start: currentTime, duration: 3.5, track: 1,
    ...style,
    ...options,
    effects: [],
  });
  project.clips.push(clip);
  selectedClipId = clip.id;
  renderAll();
  scheduleSave();
  showToast('Текстовый слой добавлен');
}

function addSticker(emoji) {
  checkpoint();
  const clip = normalizeClip({ id: uuid(), type: 'sticker', name: `Стикер ${emoji}`, text: emoji, start: currentTime, duration: 3, track: 1, fontSize: 160, x: 0, y: 0, animation: 'pop', stroke: 0, effects: [] });
  project.clips.push(clip);
  selectedClipId = clip.id;
  renderAll();
  scheduleSave();
  showToast('Стикер добавлен');
}

function nextVisualStart() {
  return Math.max(0, ...project.clips.filter(clip => clip.track === 0).map(clip => clip.start + clip.duration));
}

function addAssetToTimeline(assetId, makeCheckpoint = true) {
  const asset = getAsset(assetId);
  if (!asset || asset.missing) {
    showToast('Файл недоступен. Импортируй его заново.', 'error');
    return;
  }
  if (makeCheckpoint) checkpoint();
  const type = asset.type;
  const start = type === 'audio' ? currentTime : nextVisualStart();
  const clip = normalizeClip({
    id: uuid(), type, assetId: asset.id, name: asset.name.replace(/\.[^.]+$/, ''),
    start, duration: asset.duration || 5, inPoint: 0,
    track: type === 'audio' ? 2 : 0,
    effects: [],
  });
  project.clips.push(clip);
  selectedClipId = clip.id;
  renderAll();
  scheduleSave();
  showToast(type === 'audio' ? 'Аудио добавлено на дорожку звука' : 'Клип добавлен в конец видеодорожки');
}

function splitSelectedClip() {
  const clip = getSelectedClip();
  if (!clip || currentTime <= clip.start + 0.05 || currentTime >= clip.start + clip.duration - 0.05) return;
  checkpoint();
  const originalDuration = clip.duration;
  const offset = currentTime - clip.start;
  const right = normalizeClip({ ...clone(clip), id: uuid(), name: `${clip.name} · 2`, start: currentTime, duration: originalDuration - offset, inPoint: clip.inPoint + (clip.assetId ? offset : 0), effects: clone(clip.effects) });
  clip.duration = offset;
  project.clips.push(right);
  selectedClipId = right.id;
  renderAll();
  scheduleSave();
  showToast('Клип разделён');
}

function duplicateSelectedClip() {
  const clip = getSelectedClip();
  if (!clip) return;
  checkpoint();
  const duplicate = normalizeClip({ ...clone(clip), id: uuid(), name: `${clip.name} · копия`, start: clip.start + clip.duration + 0.12, effects: clone(clip.effects) });
  project.clips.push(duplicate);
  selectedClipId = duplicate.id;
  renderAll();
  scheduleSave();
  showToast('Слой дублирован');
}

function deleteSelectedClip() {
  const clip = getSelectedClip();
  if (!clip) return;
  checkpoint();
  project.clips = project.clips.filter(item => item.id !== clip.id);
  selectedClipId = null;
  renderAll();
  scheduleSave();
  showToast('Слой удалён');
}

function removeAsset(id) {
  const asset = getAsset(id);
  if (!asset) return;
  checkpoint();
  project.assets = project.assets.filter(item => item.id !== id);
  project.clips = project.clips.filter(clip => clip.assetId !== id);
  if (selectedClipId && !project.clips.some(clip => clip.id === selectedClipId)) selectedClipId = null;
  // Keep the Blob in IndexedDB until the editor closes so undo can restore the asset.
  renderAll();
  scheduleSave();
  showToast('Медиа убрано из проекта');
}

async function inspectFile(file) {
  const mime = file.type || '';
  let type = mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : mime.startsWith('image/') ? 'image' : null;
  if (!type) {
    const extension = file.name.split('.').pop().toLowerCase();
    if (['mp4', 'mov', 'webm', 'm4v', 'ogv', 'avi'].includes(extension)) type = 'video';
    else if (['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'].includes(extension)) type = 'audio';
    else if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif'].includes(extension)) type = 'image';
  }
  if (!type) return null;
  if (type === 'image') return { type, duration: 5 };
  const url = URL.createObjectURL(file);
  const element = document.createElement(type === 'video' ? 'video' : 'audio');
  element.preload = 'metadata';
  try {
    const duration = await new Promise(resolve => {
      const timer = setTimeout(() => resolve(5), 5000);
      element.addEventListener('loadedmetadata', () => {
        clearTimeout(timer);
        resolve(Number.isFinite(element.duration) && element.duration > 0 ? element.duration : 5);
      }, { once: true });
      element.addEventListener('error', () => {
        clearTimeout(timer);
        resolve(5);
      }, { once: true });
      element.src = url;
    });
    return { type, duration };
  } finally {
    element.removeAttribute('src');
    element.load?.();
    URL.revokeObjectURL(url);
  }
}

async function handleFiles(fileList, addDroppedToTimeline = false) {
  const files = [...fileList].filter(file => file instanceof File);
  if (!files.length) return;
  checkpoint();
  let accepted = 0;
  for (const file of files) {
    try {
      const info = await inspectFile(file);
      if (!info) {
        showToast(`Формат «${file.name}» не поддерживается.`, 'error');
        continue;
      }
      const asset = {
        id: uuid(), name: file.name, type: info.type, mime: file.type || '', size: file.size,
        duration: info.type === 'image' ? 5 : info.duration,
        missing: false,
      };
      project.assets.push(asset);
      if (db) {
        try {
          await dbPut('assets', { id: asset.id, name: asset.name, blob: file });
        } catch (storageError) {
          console.warn('Media could not be persisted in IndexedDB', storageError);
          showToast('Браузер не сохранил файл надолго; текущая вкладка продолжит работать.', 'error');
        }
      }
      await mountAsset(asset, file);
      if (addDroppedToTimeline) addAssetToTimeline(asset.id, false);
      accepted += 1;
    } catch (error) {
      console.error('Import error', error);
      showToast(`Не удалось импортировать ${file.name}`, 'error');
    }
  }
  renderAll();
  scheduleSave();
  if (accepted) showToast(`${accepted} файл${accepted === 1 ? '' : 'а'} добавлено в медиатеку`);
}

async function mountAsset(asset, blob) {
  const oldUrl = mediaUrls.get(asset.id);
  if (oldUrl) URL.revokeObjectURL(oldUrl);
  const url = URL.createObjectURL(blob);
  mediaUrls.set(asset.id, url);
  asset.missing = false;
  if (asset.type === 'image') {
    const image = new Image();
    image.decoding = 'async';
    image.addEventListener('load', () => drawComposition(currentTime), { once: true });
    image.src = url;
    imageElements.set(asset.id, image);
  } else {
    const element = document.createElement(asset.type === 'video' ? 'video' : 'audio');
    element.preload = 'auto';
    element.playsInline = true;
    element.controls = false;
    element.addEventListener('loadedmetadata', () => {
      if (Number.isFinite(element.duration) && element.duration > 0) {
        asset.duration = element.duration;
        for (const clip of project.clips) {
          if (clip.assetId === asset.id && clip.start === 0 && clip.inPoint === 0 && clip.duration === 5) clip.duration = element.duration;
        }
        renderTimeline();
      }
    });
    element.addEventListener('loadeddata', () => drawComposition(currentTime));
    element.addEventListener('seeked', () => {
      if (!isPlaying) drawComposition(currentTime);
    });
    $('#mediaBin').appendChild(element);
    mediaElements.set(asset.id, element);
    element.src = url;
  }
}

async function ensureAssetsMounted() {
  for (const asset of project.assets) {
    if (mediaUrls.has(asset.id)) {
      asset.missing = false;
      continue;
    }
    try {
      const record = db ? await dbGet('assets', asset.id) : null;
      if (record?.blob) await mountAsset(asset, record.blob);
      else asset.missing = true;
    } catch (_) {
      asset.missing = true;
    }
  }
}

function addProjectBackgroundInput(value) {
  project.background = /^#[0-9a-f]{6}$/i.test(value) ? value : '#11120f';
  drawComposition(currentTime);
  scheduleSave();
}

function updateInspectorValue(target) {
  const clip = getSelectedClip();
  const projectField = target.dataset.projectField;
  const field = target.dataset.field;
  const effectId = target.dataset.effectId;
  const setting = target.dataset.setting;
  const value = target.type === 'checkbox' ? target.checked : (target.type === 'number' || target.type === 'range' ? Number(target.value) : target.value);
  if (projectField) {
    if (projectField === 'background') addProjectBackgroundInput(value);
    return;
  }
  if (!clip) return;
  if (effectId && setting) {
    const instance = clip.effects.find(item => item.id === effectId);
    if (!instance) return;
    instance.settings = instance.settings || {};
    instance.settings[setting] = value;
  } else if (field) {
    if (field === 'start') clip.start = Math.max(0, Number(value) || 0);
    else if (field === 'duration') clip.duration = Math.max(0.2, Number(value) || 0.2);
    else if (field === 'scale') clip.scale = clamp(Number(value) || 1, 0.25, 3);
    else if (field === 'opacity') clip.opacity = clamp(Number(value) || 0, 0, 1);
    else if (field === 'x' || field === 'y') clip[field] = clamp(Number(value) || 0, -100, 100);
    else if (field === 'volume') clip.volume = clamp(Number(value) || 0, 0, 1);
    else if (field === 'brightness' || field === 'saturation' || field === 'contrast') clip[field] = clamp(Number(value) || 0, 0, 200);
    else if (field === 'blur') clip.blur = clamp(Number(value) || 0, 0, 18);
    else if (field === 'fontSize') clip.fontSize = clamp(Number(value) || 76, 16, 240);
    else if (field === 'stroke') clip.stroke = clamp(Number(value) || 0, 0, 14);
    else if (field === 'fontWeight') clip.fontWeight = clamp(Number(value) || 800, 100, 900);
    else clip[field] = value;
  }
  if (field === 'name') {
    const header = $('#inspectorTitle');
    if (header) header.textContent = clip.name || 'Слой';
  }
  if (field === 'text') {
    const timelineClip = $(`.timeline-clip[data-clip-id="${CSS.escape(clip.id)}"] .clip-title`);
    if (timelineClip) timelineClip.innerHTML = `<span class="clip-kind">${clip.type === 'sticker' ? '✦' : 'T'}</span>${escapeHTML(clip.name)}`;
  }
  if (field === 'start' || field === 'duration') {
    currentTime = clamp(currentTime, 0, projectDuration());
    renderTimeline();
    updateTimeLabels();
  }
  syncMedia(currentTime, isPlaying);
  drawComposition(currentTime);
  scheduleSave();
}

function renderEffectControl(instance, effect, control) {
  const value = instance.settings?.[control.key] ?? effect.defaults?.[control.key] ?? control.default;
  const attrs = `data-editable="true" data-effect-id="${escapeHTML(effect.id)}" data-setting="${escapeHTML(control.key)}"`;
  if (control.type === 'color') return `<div class="control-row"><label class="control-label">${escapeHTML(control.label)}</label><input class="text-input" type="color" value="${escapeHTML(value || '#ffffff')}" ${attrs}></div>`;
  if (control.type === 'toggle') return `<label class="check-row">${escapeHTML(control.label)}<span class="toggle"><input type="checkbox" ${value ? 'checked' : ''} ${attrs}><span></span></span></label>`;
  return `<div class="control-row"><label class="control-label">${escapeHTML(control.label)}<output>${control.unit === '%' ? `${Math.round(Number(value) * 100)}%` : escapeHTML(value)}</output></label><input class="range-input" type="range" min="${control.min ?? 0}" max="${control.max ?? 1}" step="${control.step ?? 0.01}" value="${Number(value) || 0}" ${attrs}></div>`;
}

function beginFieldEdit(target) {
  if (!target?.matches('[data-editable="true"]') || target.dataset.historyStarted) return;
  target.dataset.historyStarted = 'yes';
  checkpoint();
}

function handleInspectorInput(event) {
  const target = event.target;
  if (!target.matches('[data-editable="true"]')) return;
  beginFieldEdit(target);
  updateInspectorValue(target);
  const output = target.closest('.control-row')?.querySelector('output');
  if (output) {
    if (target.dataset.setting) {
      const effect = pluginEffects.get(target.dataset.effectId);
      const control = effect?.controls?.find(item => item.key === target.dataset.setting);
      output.textContent = control?.unit === '%' ? `${Math.round(Number(target.value) * 100)}%` : target.value;
    } else if (target.type === 'range') {
      const field = target.dataset.field;
      output.textContent = field === 'opacity' || field === 'volume' ? `${Math.round(Number(target.value) * 100)}%` : field === 'scale' ? `${Math.round(Number(target.value) * 100)}%` : field === 'stroke' || field === 'blur' ? `${target.value}px` : `${Math.round(Number(target.value))}%`;
    }
  }
}

function renderInspectorAfterChange(event) {
  const target = event.target;
  if (!target.matches('[data-editable="true"]')) return;
  updateInspectorValue(target);
  delete target.dataset.historyStarted;
  renderInspector();
  renderTimeline();
  updateTimeLabels();
}

function downloadProjectJSON() {
  const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${(project.name || 'tweenslop-project').replace(/[^\p{L}\p{N}_-]+/gu, '_')}.json`;
  link.click();
  URL.revokeObjectURL(url);
  showToast('JSON-монтаж скачан. Медиа в него не включены.');
}

async function loadProjectJSON(file) {
  try {
    const raw = JSON.parse(await file.text());
    if (!raw || !Array.isArray(raw.clips)) throw new Error('В файле нет массива clips.');
    checkpoint();
    project = normalizeProject(raw);
    selectedClipId = null;
    await ensureAssetsMounted();
    renderAll();
    scheduleSave();
    showToast('Монтаж загружен. Если файлы медиа не отображаются — импортируй их снова.');
  } catch (error) {
    showToast(`Не удалось загрузить JSON: ${error.message}`, 'error');
  }
}

async function importPlugin(file) {
  try {
    const source = await file.text();
    const pluginUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    try {
      const module = await import(pluginUrl);
      const plugin = module.default || module;
      if (typeof plugin.install === 'function') {
        await plugin.install(PluginAPI);
      } else if (plugin.type === 'effect') {
        registerEffect(plugin, true);
      } else if (plugin.type === 'action') {
        registerAction(plugin, true);
      } else {
        throw new Error('Нужен default export с type: "effect"/"action" или install(api).');
      }
      showToast(`Плагин «${plugin.name || file.name}» подключён`);
      renderLibrary();
    } finally {
      URL.revokeObjectURL(pluginUrl);
    }
  } catch (error) {
    console.error('Plugin load error', error);
    showToast(`Ошибка плагина: ${error.message}`, 'error');
  }
}

async function runPluginAction(id) {
  const action = pluginActions.get(id);
  if (!action) return;
  checkpoint();
  try {
    await action.run(PluginAPI);
    renderAll();
    scheduleSave();
  } catch (error) {
    console.error('Plugin action failed', error);
    showToast(`Действие «${action.name}» завершилось с ошибкой`, 'error');
  }
}

function handlePanelClick(event) {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  if (action === 'import') $('#fileInput').click();
  else if (action === 'add-asset') addAssetToTimeline(target.dataset.asset);
  else if (action === 'remove-asset') removeAsset(target.dataset.asset);
  else if (action === 'add-text') addText({ preset: target.dataset.style || 'title' });
  else if (action === 'add-sticker') addSticker(target.dataset.emoji || '✨');
  else if (action === 'add-effect') addEffectToSelected(target.dataset.effect);
  else if (action === 'import-plugin') $('#pluginInput').click();
  else if (action === 'run-plugin') runPluginAction(target.dataset.plugin);
}

function handleInspectorClick(event) {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  if (action === 'go-effects') {
    switchPanel('effects');
    return;
  }
  if (action === 'reset-transform') {
    const clip = getSelectedClip();
    if (!clip) return;
    checkpoint();
    clip.x = 0; clip.y = 0; clip.scale = 1; clip.opacity = 1;
    renderInspector(); drawComposition(currentTime); scheduleSave();
  } else if (action === 'remove-effect') {
    const clip = getSelectedClip();
    if (!clip) return;
    checkpoint();
    clip.effects.splice(Number(target.dataset.index), 1);
    renderInspector(); drawComposition(currentTime); scheduleSave();
  } else if (action === 'download-project') downloadProjectJSON();
  else if (action === 'load-project') $('#projectInput').click();
}

function switchPanel(panel) {
  activePanel = panel;
  $$('.rail-button').forEach(button => button.classList.toggle('active', button.dataset.panel === panel));
  renderLibrary();
}

function openExportModal() {
  if (!project.clips.length) {
    showToast('Добавь хотя бы один слой перед экспортом.');
    return;
  }
  $('#exportDuration').textContent = formatTime(projectDuration());
  $('#exportProgressWrap').hidden = true;
  $('#startExportBtn').disabled = false;
  $('#startExportBtn').innerHTML = 'Начать экспорт <span>↗</span>';
  $('#cancelExportBtn').textContent = 'Отмена';
  $('#exportModal').hidden = false;
}

function chooseRecorderMime() {
  const choices = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  return choices.find(type => window.MediaRecorder?.isTypeSupported?.(type)) || '';
}

async function prepareAudioCapture() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass || !mediaElements.size) return null;
  if (!audioGraph) audioGraph = { context: new AudioContextClass(), nodes: new Map(), capture: null, connectedCapture: new Set() };
  await audioGraph.context.resume();
  if (audioGraph.capture) {
    for (const node of audioGraph.connectedCapture) {
      try { node.disconnect(audioGraph.capture); } catch (_) { /* already disconnected */ }
    }
    audioGraph.connectedCapture.clear();
  }
  audioGraph.capture = audioGraph.context.createMediaStreamDestination();
  for (const element of mediaElements.values()) {
    let source = audioGraph.nodes.get(element);
    if (!source) {
      source = audioGraph.context.createMediaElementSource(element);
      source.connect(audioGraph.context.destination);
      audioGraph.nodes.set(element, source);
    }
    source.connect(audioGraph.capture);
    audioGraph.connectedCapture.add(source);
  }
  return audioGraph.capture.stream;
}

async function startExport() {
  if (isExporting) return;
  if (!('MediaRecorder' in window) || !canvas.captureStream) {
    showToast('Браузер не поддерживает экспорт записи холста.', 'error');
    return;
  }
  exportMimeType = chooseRecorderMime();
  if (!exportMimeType) {
    showToast('Этот браузер не умеет записывать WebM. Попробуй Chrome или Firefox.', 'error');
    return;
  }
  const startButton = $('#startExportBtn');
  startButton.disabled = true;
  $('#exportProgressWrap').hidden = false;
  $('#exportProgressLabel').textContent = 'Подготовка композиции…';
  $('#exportProgress').style.width = '0%';
  exportCancelled = false;
  try {
    const audioStream = await prepareAudioCapture();
    const stream = canvas.captureStream(project.fps || 30);
    audioStream?.getAudioTracks().forEach(track => stream.addTrack(track));
    recorderChunks = [];
    recorder = new MediaRecorder(stream, { mimeType: exportMimeType, videoBitsPerSecond: 8_000_000 });
    recorder.ondataavailable = event => {
      if (event.data && event.data.size) recorderChunks.push(event.data);
    };
    recorder.onerror = event => {
      console.error('Recorder error', event.error);
      showToast('Ошибка кодирования видео.', 'error');
      if (recorder?.state === 'recording') recorder.stop();
    };
    recorder.onstop = finishExport;
    isExporting = true;
    exportStartedAt = performance.now();
    recorder.start(300);
    currentTime = 0;
    $('#exportProgressLabel').textContent = 'Рендерим кадры…';
    $('#startExportBtn').innerHTML = 'Экспорт…';
    $('#cancelExportBtn').textContent = 'Прервать';
    startPlayback(true);
  } catch (error) {
    console.error('Export setup failed', error);
    isExporting = false;
    startButton.disabled = false;
    $('#exportProgressWrap').hidden = true;
    showToast(`Не удалось начать экспорт: ${error.message}`, 'error');
  }
}

function updateExportProgress() {
  const duration = Math.max(0.1, projectDuration());
  const progress = clamp(currentTime / duration, 0, 1);
  $('#exportProgress').style.width = `${Math.round(progress * 100)}%`;
  const elapsed = (performance.now() - exportStartedAt) / 1000;
  const remaining = progress > 0.02 ? elapsed * (1 - progress) / progress : null;
  $('#exportProgressLabel').textContent = remaining === null
    ? `Кадр ${formatTime(currentTime)} из ${formatTime(duration)}`
    : `Готово ${Math.round(progress * 100)}% · ещё около ${formatTime(remaining)}`;
}

function finishExport() {
  const wasCancelled = exportCancelled;
  isExporting = false;
  isPlaying = false;
  updatePlayButton();
  syncMedia(currentTime, false);
  recorder?.stream?.getTracks().forEach(track => track.stop());
  recorder = null;
  const modal = $('#exportModal');
  $('#cancelExportBtn').textContent = 'Закрыть';
  $('#startExportBtn').disabled = false;
  $('#startExportBtn').textContent = 'Готово';
  $('#exportProgress').style.width = wasCancelled ? '0%' : '100%';
  if (wasCancelled) {
    $('#exportProgressLabel').textContent = 'Экспорт прерван';
    recorderChunks = [];
    showToast('Экспорт прерван');
    return;
  }
  if (!recorderChunks.length) {
    $('#exportProgressLabel').textContent = 'Не удалось получить видеоданные';
    showToast('Видеофайл не создан. Проверь поддержку WebM в браузере.', 'error');
    return;
  }
  const blob = new Blob(recorderChunks, { type: exportMimeType || 'video/webm' });
  recorderChunks = [];
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const safeName = (project.name || 'tweenslop-video').replace(/[^\p{L}\p{N}_-]+/gu, '_');
  link.href = url;
  link.download = `${safeName || 'tweenslop-video'}.webm`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  $('#exportProgressLabel').textContent = `Готово · ${(blob.size / (1024 * 1024)).toFixed(1)} МБ · файл скачивается`;
  showToast('Экспорт завершён — файл WebM скачивается');
  if (modal.hidden) return;
}

function cancelExport() {
  if (isExporting) {
    exportCancelled = true;
    if (recorder && recorder.state === 'recording') recorder.stop();
    isPlaying = false;
    cancelAnimationFrame(frameRequest);
    syncMedia(currentTime, false);
    updatePlayButton();
  } else {
    $('#exportModal').hidden = true;
  }
}

function attachEventHandlers() {
  $$('.rail-button').forEach(button => button.addEventListener('click', () => switchPanel(button.dataset.panel)));
  $('#panelContent').addEventListener('click', handlePanelClick);
  $('#panelContent').addEventListener('dragover', event => {
    if ([...event.dataTransfer.types].includes('Files')) {
      event.preventDefault();
      $('#dropZone')?.classList.add('drag-over');
    }
  });
  $('#panelContent').addEventListener('dragleave', event => {
    if (!event.relatedTarget || !$('#dropZone')?.contains(event.relatedTarget)) $('#dropZone')?.classList.remove('drag-over');
  });
  $('#panelContent').addEventListener('drop', event => {
    if (![...event.dataTransfer.types].includes('Files')) return;
    event.preventDefault();
    $('#dropZone')?.classList.remove('drag-over');
    handleFiles(event.dataTransfer.files, true);
  });
  $('#inspectorContent').addEventListener('click', handleInspectorClick);
  $('#inspectorContent').addEventListener('focusin', event => beginFieldEdit(event.target));
  $('#inspectorContent').addEventListener('pointerdown', event => beginFieldEdit(event.target));
  $('#inspectorContent').addEventListener('input', handleInspectorInput);
  $('#inspectorContent').addEventListener('change', renderInspectorAfterChange);
  $('#inspectorContent').addEventListener('focusout', event => { delete event.target.dataset.historyStarted; });

  $('#fileInput').addEventListener('change', event => {
    handleFiles(event.target.files, false);
    event.target.value = '';
  });
  $('#pluginInput').addEventListener('change', event => {
    const file = event.target.files?.[0];
    if (file) importPlugin(file);
    event.target.value = '';
  });
  $('#projectInput').addEventListener('change', event => {
    const file = event.target.files?.[0];
    if (file) loadProjectJSON(file);
    event.target.value = '';
  });
  $('#projectName').addEventListener('focus', () => checkpoint());
  $('#projectName').addEventListener('input', event => {
    project.name = event.target.value.slice(0, 60);
    scheduleSave();
  });
  $('#projectName').addEventListener('change', () => renderTimeline());
  $('#ratioSelect').addEventListener('change', event => {
    checkpoint();
    project.ratio = VALID_RATIOS.has(event.target.value) ? event.target.value : '9:16';
    renderAll();
    scheduleSave();
  });
  $('#saveBtn').addEventListener('click', async () => {
    clearTimeout(saveTimer);
    await persistProject();
    showToast('Проект сохранён');
  });
  $('#undoBtn').addEventListener('click', undo);
  $('#redoBtn').addEventListener('click', redo);
  $('#playBtn').addEventListener('click', togglePlayback);
  $('#splitBtn').addEventListener('click', splitSelectedClip);
  $('#duplicateBtn').addEventListener('click', duplicateSelectedClip);
  $('#deleteBtn').addEventListener('click', deleteSelectedClip);
  $('#zoomOutBtn').addEventListener('click', () => {
    timelineScale = clamp(timelineScale - 10, 36, 130);
    renderTimeline();
  });
  $('#zoomInBtn').addEventListener('click', () => {
    timelineScale = clamp(timelineScale + 10, 36, 130);
    renderTimeline();
  });
  $('#fitPreviewBtn').addEventListener('click', () => {
    resizePreviewSurface();
    showToast('Предпросмотр вписан в окно');
  });
  $('#exportBtn').addEventListener('click', openExportModal);
  $('#closeExportModal').addEventListener('click', () => {
    if (isExporting) showToast('Сначала дождись экспорта или нажми «Прервать».');
    else $('#exportModal').hidden = true;
  });
  $('#cancelExportBtn').addEventListener('click', cancelExport);
  $('#startExportBtn').addEventListener('click', () => {
    if (isExporting) return;
    if ($('#startExportBtn').textContent.trim() === 'Готово') {
      $('#exportModal').hidden = true;
      return;
    }
    startExport();
  });
  $('#timelineRuler').addEventListener('click', event => {
    const rect = event.currentTarget.getBoundingClientRect();
    seekTo((event.clientX - rect.left - 100) / timelineScale);
  });
  window.addEventListener('resize', resizePreviewSurface);
  document.addEventListener('dragover', event => {
    if ([...event.dataTransfer.types].includes('Files')) event.preventDefault();
  });
  document.addEventListener('drop', event => {
    if (![...event.dataTransfer.types].includes('Files')) return;
    if (event.target.closest('#dropZone')) return;
    event.preventDefault();
    handleFiles(event.dataTransfer.files, true);
  });
  document.addEventListener('keydown', event => {
    const target = event.target;
    const editing = target && (target.matches('input, textarea, select, [contenteditable="true"]'));
    const meta = event.metaKey || event.ctrlKey;
    if (meta && event.key.toLowerCase() === 'z' && !editing) {
      event.preventDefault();
      if (event.shiftKey) redo(); else undo();
      return;
    }
    if (meta && event.key.toLowerCase() === 's') {
      event.preventDefault();
      clearTimeout(saveTimer);
      persistProject();
      showToast('Проект сохранён');
      return;
    }
    if (!editing && event.code === 'Space') {
      event.preventDefault();
      togglePlayback();
    } else if (!editing && event.key.toLowerCase() === 's') {
      splitSelectedClip();
    } else if (!editing && (event.key === 'Delete' || event.key === 'Backspace')) {
      deleteSelectedClip();
    } else if (meta && event.key.toLowerCase() === 'd' && !editing) {
      event.preventDefault();
      duplicateSelectedClip();
    } else if (event.key === 'ArrowLeft' && !editing) {
      seekTo(currentTime - (event.shiftKey ? 1 : 1 / project.fps));
    } else if (event.key === 'ArrowRight' && !editing) {
      seekTo(currentTime + (event.shiftKey ? 1 : 1 / project.fps));
    }
  });
}

async function init() {
  registerBuiltins();
  attachEventHandlers();
  try {
    db = await openDatabase();
  } catch (error) {
    console.warn('IndexedDB unavailable', error);
    db = null;
  }
  await loadInitialProject();
  setCanvasSize();
  drawComposition(0);
}

init();
