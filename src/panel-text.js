// Editable wording for panels and the guide. Officers change text from
// Discord (/panel-text); nothing here touches code or config.json.
//   data/panel-text.json    flat map: dotted config path -> text
//   data/guide-content.json copy of the bundled guide with sections replaced
// This file must not require ./config (config.js loads it).
const fs = require('node:fs');
const path = require('node:path');

const MAX_LEN = 4000;
const ROOT = path.join(__dirname, '..');
const PANEL_ROOTS = ['rules', 'strikeSystem', 'rankInfo'];
const PANEL_FLAT = ['tickets.title', 'tickets.description', 'tickets.buttonLabel',
  'tickets.introMessage', 'welcome.title', 'welcome.message'];

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

const atomicWrite = (file, data) => require('./store').atomicWrite(file, data);

// Dotted-path helpers. Numeric parts index arrays.
function getPath(obj, dotted) {
  let cur = obj;
  for (const k of dotted.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  return cur;
}
function setPath(obj, dotted, value) {
  const parts = dotted.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') return false;
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
  return true;
}

function createPanelText(opts = {}) {
  const dataDir = opts.dataDir || path.join(ROOT, 'data');
  const configFile = opts.configFile || path.join(ROOT, 'config.json');
  const bundledGuideFile = opts.bundledGuideFile || path.join(__dirname, 'guide-content.json');
  const overridesFile = path.join(dataDir, 'panel-text.json');
  const guideFile = path.join(dataDir, 'guide-content.json');
  const write = opts.atomicWrite || atomicWrite;

  const baked = readJson(configFile) || {};
  const bundledGuide = readJson(bundledGuideFile) || { pages: [] };

  // ---- registry ----
  const panelKeys = [];
  const addIf = (p) => { if (typeof getPath(baked, p) === 'string') panelKeys.push(p); };
  for (const root of PANEL_ROOTS) {
    addIf(`${root}.title`); addIf(`${root}.intro`); addIf(`${root}.footer`);
    for (const list of ['sections', 'levels']) {
      (getPath(baked, `${root}.${list}`) || []).forEach((_, i) => {
        addIf(`${root}.${list}.${i}.heading`); addIf(`${root}.${list}.${i}.body`);
      });
    }
  }
  PANEL_FLAT.forEach(addIf);
  const guideKeys = (bundledGuide.pages || []).filter((p) => p.slug).map((p) => `guide.${p.slug}`);
  const bakedValues = new Map(panelKeys.map((k) => [k, getPath(baked, k)]));

  const isPanel = (k) => bakedValues.has(k);
  const isGuide = (k) => guideKeys.includes(k);
  const registry = () => ({ panels: [...panelKeys], guide: [...guideKeys] });

  function validate(key, value) {
    if (typeof key !== 'string' || !(isPanel(key) || isGuide(key))) {
      return 'That is not a text you can change. Use list to see the options.';
    }
    if (typeof value !== 'string' || !value.trim()) return 'The text cannot be empty.';
    if (value.length > MAX_LEN) return `That text is too long. The limit is ${MAX_LEN} characters.`;
    return null;
  }

  // ---- overrides file (flat map) ----
  let warned = false;
  function loadOverrides() {
    if (!fs.existsSync(overridesFile)) return {};
    const j = readJson(overridesFile);
    if (!j || typeof j !== 'object' || Array.isArray(j)) {
      if (!warned) { warned = true; console.error('[panel-text] panel-text.json is missing or invalid; using the built-in wording.'); }
      return {};
    }
    return j;
  }

  // Reset registry paths to baked wording, then apply valid overrides.
  function applyTo(cfg) {
    const o = loadOverrides();
    for (const [k, v] of bakedValues) setPath(cfg, k, v);
    for (const [k, v] of Object.entries(o)) {
      if (isPanel(k) && validate(k, v) === null) setPath(cfg, k, v);
    }
  }
  let lastMtime = -1;
  function refresh(cfg) {
    let m = 0;
    try { m = fs.statSync(overridesFile).mtimeMs; } catch { m = 0; }
    if (m === lastMtime) return false;
    lastMtime = m;
    applyTo(cfg);
    return true;
  }

  // ---- guide ----
  const guideDoc = () => readJson(guideFile) || bundledGuide;
  const pageOf = (doc, key) => (doc.pages || []).find((p) => `guide.${p.slug}` === key);

  // ---- public API ----
  function get(key, cfg) {
    if (isGuide(key)) return (pageOf(guideDoc(), key).short || []).join('\n');
    if (isPanel(key)) return String(getPath(cfg || baked, key) ?? '');
    return null;
  }
  function isOverridden(key) {
    if (isGuide(key)) return get(key) !== (pageOf(bundledGuide, key).short || []).join('\n');
    return Object.prototype.hasOwnProperty.call(loadOverrides(), key);
  }
  function set(key, value, cfg) {
    const bad = validate(key, value);
    if (bad) return { ok: false, message: bad };
    try {
      if (isGuide(key)) {
        const doc = readJson(guideFile) || JSON.parse(JSON.stringify(bundledGuide));
        const page = pageOf(doc, key);
        if (!page) return { ok: false, message: 'That guide section is missing from the guide file.' };
        page.short = value.split('\n').map((l) => l.replace(/\s+$/, ''));
        write(guideFile, doc);
      } else {
        const o = loadOverrides();
        o[key] = value;
        write(overridesFile, o);
        if (cfg) { lastMtime = -1; refresh(cfg); }
      }
    } catch (e) {
      console.error('[panel-text] save failed:', e.message);
      return { ok: false, message: 'Could not save that. Try again.' };
    }
    return { ok: true };
  }
  function clear(key, cfg) {
    if (!(isPanel(key) || isGuide(key))) return { ok: false, message: validate(key, 'x') };
    try {
      if (isGuide(key)) {
        const doc = readJson(guideFile);
        if (doc) {
          const page = pageOf(doc, key);
          if (page) { page.short = JSON.parse(JSON.stringify(pageOf(bundledGuide, key).short || [])); write(guideFile, doc); }
        }
      } else {
        const o = loadOverrides();
        delete o[key];
        write(overridesFile, o);
        if (cfg) { lastMtime = -1; refresh(cfg); }
      }
    } catch (e) {
      console.error('[panel-text] clear failed:', e.message);
      return { ok: false, message: 'Could not clear that. Try again.' };
    }
    return { ok: true };
  }

  return { MAX_LEN, registry, validate, get, set, clear, isOverridden, applyTo, refresh };
}

module.exports = { createPanelText, getPath, setPath, MAX_LEN };
