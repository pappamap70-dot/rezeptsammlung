'use strict';
(() => {

// ================= Hilfsfunktionen =================

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const app = $('#app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = name => `<svg><use href="#i-${name}"/></svg>`;
const fold = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss');
const uniq = arr => [...new Set(arr)];
const store = {
  get(k, d) { try { const v = localStorage.getItem('rz.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('rz.' + k, JSON.stringify(v)); } catch { /* egal */ } },
};
// Fassung ohne Server (z. B. auf GitHub Pages zum Weitergeben): alles bleibt nur auf dem Gerät, KI direkt beim Anbieter
const LOCAL = window.RZ_LOCAL === true;
const localImgs = new Map();   // Fotos auf dem Gerät ("local-….jpg"): unterwegs aufgenommen bzw. in der Fassung ohne Server
const imgUrl = f => localImgs.get(f) || 'images/' + encodeURIComponent(f);
const newId = () => [...crypto.getRandomValues(new Uint8Array(8))].map(b => b.toString(16).padStart(2, '0')).join('');
const today = () => new Date().toISOString().slice(0, 10);

const CATEGORIES = ['Frühstück', 'Vorspeise', 'Suppe', 'Salat', 'Hauptgericht', 'Beilage', 'Sauce & Dip', 'Dessert',
  'Kuchen & Torten', 'Gebäck', 'Brot', 'Snack', 'Getränk', 'Grundrezept'];
const CAT_EMOJI = [
  [/früh|brunch|müsli/, '🥐'], [/vorspeise|antipast/, '🥗'], [/suppe|eintopf/, '🍲'], [/salat/, '🥗'],
  [/beilage/, '🥔'], [/sauce|soße|dip|dressing/, '🫙'], [/dessert|nachtisch|eis/, '🍨'], [/kuchen|torte/, '🍰'],
  [/gebäck|plätzchen|keks/, '🍪'], [/brot|brötchen/, '🍞'], [/snack|fingerfood/, '🥨'], [/getränk|drink|cocktail/, '🍹'],
  [/pasta|nudel/, '🍝'], [/pizza/, '🍕'], [/fisch/, '🐟'], [/fleisch|braten/, '🥩'], [/vegan|vegetar|gemüse/, '🥦'],
];
const catEmoji = c => (CAT_EMOJI.find(([re]) => re.test(fold(c))) || [0, '🍽️'])[1];
const DIFFS = ['einfach', 'mittel', 'schwer'];

const state = {
  recipes: [], byId: new Map(), status: null, shopping: [], loadedAt: 0,
  filter: { q: '', cat: '', tags: [], diff: '', time: 0, rating: 0, fav: false, withIng: '', withoutIng: '' },
  sort: store.get('sort', 'title'), view: store.get('view', 'grid'), showFilters: false,
  draft: null, dirty: false, libScroll: 0, importTab: 'text', importResults: [], randomSeed: Math.random(),
};
const IDX = new WeakMap();

function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (err ? ' err' : '');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { t.className = 'toast'; }, err ? 5000 : 2500);
}

function download(name, text, type = 'application/json') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('In die Zwischenablage kopiert'); }
  catch {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast('In die Zwischenablage kopiert'); } catch { toast('Kopieren nicht möglich', true); }
    ta.remove();
  }
}

function modal(html, onMount) {
  const m = $('#modal');
  m.querySelector('.modal-box').innerHTML = html;
  m.hidden = false;
  if (onMount) onMount(m.querySelector('.modal-box'));
}
const closeModal = () => { $('#modal').hidden = true; };
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal' || e.target.closest('[data-close]')) closeModal(); });

function lightbox(src) {
  const lb = $('#lightbox');
  lb.querySelector('img').src = src;
  lb.hidden = false;
}
$('#lightbox').addEventListener('click', () => { $('#lightbox').hidden = true; });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { $('#lightbox').hidden = true; closeModal(); }
  if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) && $('#q')) { e.preventDefault(); $('#q').focus(); }
});

// ================= Server =================

async function api(action, { body, params, timeout } = {}) {
  const qs = new URLSearchParams({ action, ...(params || {}) });
  const opt = { credentials: 'same-origin' };
  if (body !== undefined) Object.assign(opt, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const ctl = timeout && new AbortController();
  if (ctl) { opt.signal = ctl.signal; setTimeout(() => ctl.abort(), timeout); }
  let res, data;
  try { res = await fetch('api.php?' + qs, opt); }
  catch {
    setOnline(false);
    throw Object.assign(new Error('Das NAS ist gerade nicht erreichbar – das geht nur im Heimnetz.'), { offline: true });
  }
  try { data = await res.json(); }
  catch { throw new Error(res.status === 404 ? 'api.php nicht gefunden.' : 'Ungültige Antwort vom Server – ist PHP im QNAP Web Server aktiviert?'); }
  if (res.status === 401) { renderLogin(); throw new Error(data.error || 'Bitte anmelden.'); }
  if (!data.ok) throw Object.assign(new Error(data.error || 'Unbekannter Fehler'), { conflict: !!data.conflict, data });
  return data;
}

// ================= Gerätespeicher & Abgleich mit dem NAS =================
// Alle Rezepte, die Einkaufsliste und unterwegs aufgenommene Fotos liegen zusätzlich auf dem Gerät (IndexedDB).
// Änderungen landen zuerst hier und in einer Warteschlange ("outbox"); sobald das NAS erreichbar ist, werden sie
// übertragen und Änderungen anderer Geräte abgeholt. Ohne IndexedDB (z. B. privates Fenster) bleibt alles im Speicher.

const local = (() => {
  const STORES = ['recipes', 'kv', 'outbox', 'images'];
  const mem = Object.fromEntries(STORES.map(s => [s, new Map()]));
  let dbp;
  const db = () => dbp || (dbp = new Promise(res => {
    try {
      const req = indexedDB.open('rezeptsammlung', 1);
      req.onupgradeneeded = () => STORES.forEach(s => req.result.createObjectStore(s));
      req.onsuccess = () => res(req.result);
      req.onerror = req.onblocked = () => res(null);
    } catch { res(null); }
  }));
  async function op(store, mode, idbFn, memFn) {
    const d = await db();
    if (!d) return memFn(mem[store]);
    return new Promise((res, rej) => {
      const t = d.transaction(store, mode);
      const r = idbFn(t.objectStore(store));
      t.oncomplete = () => res(r && r.result);
      t.onerror = t.onabort = () => rej(t.error || new Error('Speichern auf dem Gerät fehlgeschlagen.'));
    });
  }
  return {
    available: async () => !!(await db()),
    get: (st, k) => op(st, 'readonly', s => s.get(k), m => m.get(k)),
    set: (st, k, v) => op(st, 'readwrite', s => { s.put(v, k); }, m => { m.set(k, v); }),
    del: (st, k) => op(st, 'readwrite', s => { s.delete(k); }, m => { m.delete(k); }),
    replace: (st, map) => op(st, 'readwrite', s => { s.clear(); map.forEach((v, k) => s.put(v, k)); }, m => { m.clear(); map.forEach((v, k) => m.set(k, v)); }),
    async all(st) {
      const d = await db();
      if (!d) return new Map(mem[st]);
      return new Promise((res, rej) => {
        const out = new Map(), t = d.transaction(st);
        t.objectStore(st).openCursor().onsuccess = e => { const c = e.target.result; if (c) { out.set(c.key, c.value); c.continue(); } };
        t.oncomplete = () => res(out);
        t.onerror = () => rej(t.error);
      });
    },
  };
})();

const sync = {
  online: null, busy: null, again: false, timer: 0, pending: 0, lastSync: 0, rev: '', error: '', needLogin: false,
  shopBase: [], shopDirty: false, shopRev: '', imgMap: {}, imgCached: 0, warned: false,
};
const IMG_CACHE = 'rezepte-img-v1';

function setOnline(on) {
  if (sync.online === on) return;
  sync.online = on;
  drawSync();
}

function drawSync() {
  const b = $('#syncBtn');
  if (!b || LOCAL) return;
  b.hidden = false;
  const n = sync.pending + (sync.shopDirty ? 1 : 0);
  const [cls, label, title] =
    sync.running ? ['busy', '…', 'Wird mit dem NAS abgeglichen …'] :
    sync.online === false ? [n ? 'wait' : 'off', n ? `offline · ${n}` : 'offline', `NAS nicht erreichbar.${n ? ` ${n} Änderung(en) warten auf dem Gerät und werden zu Hause übertragen.` : ' Alle Rezepte sind auf dem Gerät gespeichert.'}`] :
    sync.error ? ['err', '!', 'Abgleich fehlgeschlagen: ' + sync.error] :
    n ? ['wait', String(n), `${n} Änderung(en) noch nicht übertragen`] :
    ['ok', '✓', 'Mit dem NAS abgeglichen' + (sync.lastSync ? ' (' + new Date(sync.lastSync).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) + ')' : '')];
  b.className = 'sync-btn ' + cls;
  b.title = title;
  b.querySelector('span').textContent = label;
}

async function countPending() {
  sync.pending = (await local.all('outbox')).size;
  drawSync();
}

function scheduleSync(ms = 300) {
  if (LOCAL) return;
  clearTimeout(sync.timer);
  sync.timer = setTimeout(() => runSync(), ms);
}

function runSync({ manual = false } = {}) {
  if (LOCAL) return Promise.resolve();
  if (sync.busy) { sync.again = true; return sync.busy; }
  sync.running = true;
  sync.busy = (async () => {
    drawSync();
    try {
      const st = await api('status', { timeout: 4000 });
      if (st.auth_required && !st.logged_in) { sync.needLogin = true; setOnline(true); renderLogin(); return; }
      sync.needLogin = false;
      state.status = st;
      await local.set('kv', 'status', st);
      setOnline(true);
      const pushed = await pushRecipes();
      await syncShopping(st.rev?.shopping);
      if (pushed || !sync.lastSync || st.rev?.recipes !== sync.rev) await pullRecipes();
      sync.lastSync = Date.now();
      await local.set('kv', 'lastSync', sync.lastSync);
      sync.error = '';
      if (!st.writable && !sync.warned) { sync.warned = true; toast('Achtung: Der Server kann nicht speichern – Ordnerrechte prüfen (siehe Anleitung).', true); }
      if (manual) toast('Mit dem NAS abgeglichen ✓');
      prefetchImages();
    } catch (e) {
      if (!e.offline) sync.error = e.message;
      if (manual || !e.offline) toast(e.offline ? 'NAS nicht erreichbar – deine Änderungen bleiben auf dem Gerät und werden zu Hause übertragen.' : 'Abgleich: ' + e.message, true);
    } finally {
      sync.busy = null;
      sync.running = false;
      await countPending().catch(() => {});
      if (sync.again) { sync.again = false; scheduleSync(100); }
      if (location.hash === '#/settings' && !$('#app :focus')) renderSettings();
    }
  })();
  return sync.busy;
}

// Rezept vom NAS übernehmen (nach dem Hochladen oder bei einem Konflikt)
async function storeServerRecipe(r) {
  await local.set('recipes', r.id, r);
  return upsert(r);
}

async function pushRecipes() {
  const box = await local.all('outbox');
  for (const [id, job] of box) {
    let result = null;
    if (job.op === 'save') {
      const recipe = await uploadLocalImages(job.recipe);
      try {
        result = (await api('save', { body: { recipe, base: job.base }, timeout: 30000 })).recipe;
      } catch (e) {
        if (!e.conflict) throw e;
        // Inzwischen woanders geändert: Fassung vom NAS behalten, die eigene als zweites Rezept daneben legen
        const copy = { ...recipe, id: newId(), title: recipe.title + ' (zweite Fassung)', created: undefined };
        const saved = (await api('save', { body: { recipe: copy, base: null }, timeout: 30000 })).recipe;
        await storeServerRecipe(saved);
        if (e.data.recipe) result = e.data.recipe;
        toast(`„${recipe.title}“ wurde zwischendurch auf einem anderen Gerät geändert. Deine Fassung ist als „${saved.title}“ gespeichert.`, true);
      }
    } else {
      try { await api('delete', { body: { id, base: job.base }, timeout: 30000 }); }
      catch (e) {
        if (!e.conflict) throw e;
        result = e.data.recipe;
        toast(`„${result.title}“ wurde zwischendurch auf einem anderen Gerät geändert und deshalb nicht gelöscht.`, true);
      }
    }
    const cur = await local.get('outbox', id);
    if (cur && cur.at !== job.at) {
      // Während des Hochladens erneut geändert: neue Fassung bleibt in der Warteschlange, beruht jetzt aber auf diesem Stand
      cur.base = result ? result.updated : null;
      await local.set('outbox', id, cur);
    } else {
      await local.del('outbox', id);
      if (result) await storeServerRecipe(result);
    }
  }
  return box.size > 0;
}

async function pullRecipes() {
  const { recipes, rev } = await api('list', { timeout: 30000 });
  const map = new Map(recipes.map(r => [r.id, r]));
  // Noch nicht übertragene eigene Änderungen haben Vorrang
  for (const [id, job] of await local.all('outbox')) { if (job.op === 'delete') map.delete(id); else map.set(id, job.recipe); }
  await local.replace('recipes', map);
  setRecipes([...map.values()]);
  sync.rev = rev;
  await local.set('kv', 'rev', rev);
  updateLibraryIfShown();
}

// Änderung auf dem Gerät speichern und zum Übertragen vormerken
async function queueChange(id, op, recipe) {
  if (LOCAL) {   // ohne Server gibt es nichts zu übertragen
    if (op === 'save') await local.set('recipes', id, recipe); else await local.del('recipes', id);
    return;
  }
  const old = await local.get('outbox', id);
  const base = old ? old.base : (state.byId.get(id)?.updated ?? null);
  if (op === 'delete' && old && old.base === null) await local.del('outbox', id);   // war noch gar nicht auf dem NAS
  else await local.set('outbox', id, { op, base, recipe, at: Date.now() + Math.random() });
  if (op === 'save') await local.set('recipes', id, recipe); else await local.del('recipes', id);
  await countPending();
  scheduleSync();
}

async function deleteRecipe(id) {
  const r = state.byId.get(id);
  await queueChange(id, 'delete', null);
  state.recipes = state.recipes.filter(x => x.id !== id);
  state.byId.delete(id);
  for (const f of r?.images || []) if (f.startsWith('local-')) dropLocalImage(f);
}

// ---------- Fotos ----------

function dataUrlToBlob(d) {
  const [head, b64] = d.split(',');
  const bin = atob(b64), u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return new Blob([u], { type: head.slice(5).split(';')[0] });
}

// Bild speichern: zu Hause direkt aufs NAS, unterwegs erst einmal auf dem Gerät
async function storeImage(data) {
  if (!LOCAL && sync.online !== false) {
    try { return (await api('upload_image', { body: { data }, timeout: 30000 })).file; }
    catch (e) { if (!e.offline) throw e; }
  }
  const ext = { jpeg: 'jpg', png: 'png', webp: 'webp', gif: 'gif' }[(data.match(/^data:image\/(\w+)/) || [])[1]] || 'jpg';
  const name = 'local-' + newId() + '.' + ext;
  await local.set('images', name, data);
  localImgs.set(name, URL.createObjectURL(dataUrlToBlob(data)));
  return name;
}

function dropLocalImage(name) {
  local.del('images', name).catch(() => {});
  delete sync.imgMap[name];
}

async function uploadLocalImages(r) {
  if (!r.images.some(f => f.startsWith('local-'))) return r;
  const images = [];
  for (const f of r.images) {
    if (!f.startsWith('local-')) { images.push(f); continue; }
    if (!sync.imgMap[f]) {
      const data = await local.get('images', f);
      if (!data) continue;   // Foto nicht mehr vorhanden
      const file = (await api('upload_image', { body: { data }, timeout: 60000 })).file;
      sync.imgMap[f] = file;
      await local.set('kv', 'imgmap', sync.imgMap);
      // gleich in den Bilder-Speicher legen, damit es nicht noch einmal vom NAS geladen werden muss
      if ('caches' in window) caches.open(IMG_CACHE).then(c => c.put(new URL('images/' + encodeURIComponent(file), location.href).href, new Response(dataUrlToBlob(data)))).catch(() => {});
    }
    images.push(sync.imgMap[f]);
  }
  return { ...r, images };
}

// Beim Start: übertragene oder verwaiste Fotos (z. B. aus abgebrochenen Bearbeitungen) vom Gerät löschen
async function cleanupLocalImages() {
  const used = new Set(state.recipes.flatMap(r => r.images));
  for (const job of (await local.all('outbox')).values()) (job.recipe?.images || []).forEach(f => used.add(f));
  for (const name of (await local.all('images')).keys()) {
    if (!used.has(name)) { dropLocalImage(name); URL.revokeObjectURL(localImgs.get(name)); localImgs.delete(name); }
  }
  for (const name of Object.keys(sync.imgMap)) if (!used.has(name)) delete sync.imgMap[name];
  await local.set('kv', 'imgmap', sync.imgMap);
}

// Alle Rezeptbilder für unterwegs auf dem Gerät speichern (nur mit HTTPS möglich)
async function prefetchImages() {
  if (!('caches' in window) || prefetchImages.running) return;
  prefetchImages.running = true;
  try {
    const c = await caches.open(IMG_CACHE);
    const want = new Set(state.recipes.flatMap(r => r.images).filter(f => !f.startsWith('local-')));
    const urlOf = f => new URL('images/' + encodeURIComponent(f), location.href).href;
    const have = new Set();
    for (const req of await c.keys()) {
      const f = decodeURIComponent(new URL(req.url).pathname.split('/').pop());
      if (want.has(f)) have.add(f); else await c.delete(req);   // Bild gehört zu keinem Rezept mehr
    }
    if (store.get('offlineImages', true)) {
      for (const f of want) {
        if (have.has(f)) continue;
        if (sync.online === false) break;
        try { const res = await fetch(urlOf(f)); if (res.ok) { await c.put(urlOf(f), res); have.add(f); } } catch { break; }
      }
    }
    sync.imgCached = have.size;
  } catch { /* Speicher voll o. Ä. – Bilder kommen dann eben vom NAS */ }
  finally { prefetchImages.running = false; }
}

// ---------- Einkaufsliste ----------

// Drei-Wege-Abgleich: eigene Änderungen seit dem letzten Abgleich (base → mine) auf den Stand des NAS anwenden
function mergeShopping(base, mine, theirs) {
  const b = new Map(base.map(i => [i.id, i])), m = new Map(mine.map(i => [i.id, i]));
  const out = theirs
    .filter(i => !(b.has(i.id) && !m.has(i.id)))   // hier gelöscht
    .map(i => {
      const mi = m.get(i.id), bi = b.get(i.id);
      return mi && bi && (mi.done !== bi.done || mi.text !== bi.text) ? { ...i, done: mi.done, text: mi.text } : i;
    });
  const have = new Set(out.map(i => i.id));
  return [...mine.filter(i => !b.has(i.id) && !have.has(i.id)), ...out];   // hier hinzugefügt
}

const persistShopping = () => local.set('kv', 'shop', { items: state.shopping, base: sync.shopBase, dirty: sync.shopDirty, rev: sync.shopRev }).catch(() => {});

async function syncShopping(rev) {
  if (!sync.shopDirty && rev === sync.shopRev) return;
  const snapshot = state.shopping.map(i => ({ ...i }));
  const { items: server, rev: r1 } = await api('shopping', { timeout: 15000 });
  let merged = server, newRev = r1;
  if (sync.shopDirty) {
    merged = mergeShopping(sync.shopBase, snapshot, server);
    newRev = (await api('shopping_save', { body: { items: merged }, timeout: 15000 })).rev;
  }
  // Wurde während des Abgleichs weiter getippt? Dann diese Änderungen obendrauf und beim nächsten Mal senden.
  const changedMeanwhile = JSON.stringify(state.shopping) !== JSON.stringify(snapshot);
  state.shopping = changedMeanwhile ? mergeShopping(snapshot, state.shopping, merged) : merged;
  sync.shopBase = structuredClone(merged);   // eigene Kopie – die Liste selbst wird beim Abhaken direkt verändert
  sync.shopRev = newRev;
  sync.shopDirty = changedMeanwhile;
  await persistShopping();
  updateShopBadge();
  if ($('#shopList') && shopDraw) shopDraw();
  if (changedMeanwhile) sync.again = true;
}

window.addEventListener('online', () => scheduleSync(500));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && Date.now() - sync.lastSync > 15000) scheduleSync(200);
});
setInterval(() => { if (document.visibilityState === 'visible') runSync(); }, 60000);
$('#syncBtn').onclick = () => runSync({ manual: true });

// ================= Datenmodell =================

function blankRecipe() {
  return {
    id: '', title: '', description: '', category: '', tags: [], servings: 4, servingsUnit: 'Portionen',
    prepTime: 0, cookTime: 0, restTime: 0, difficulty: '', rating: 0, favorite: false, source: '',
    ingredients: '', steps: '', notes: '', images: [], lastCooked: '', cookCount: 0,
  };
}

function normalize(r) {
  const o = { ...blankRecipe(), ...r };
  if (typeof o.tags === 'string') o.tags = o.tags.split(/[,;]/);
  o.tags = uniq((o.tags || []).map(t => String(t).trim()).filter(Boolean));
  for (const k of ['ingredients', 'steps']) if (Array.isArray(o[k])) o[k] = o[k].join('\n');
  for (const k of ['title', 'description', 'category', 'servingsUnit', 'difficulty', 'source', 'ingredients', 'steps', 'notes']) o[k] = String(o[k] ?? '').trim();
  for (const k of ['prepTime', 'cookTime', 'restTime', 'rating', 'cookCount']) o[k] = Math.max(0, Math.round(+o[k] || 0));
  o.servings = Math.max(0, +String(o.servings).replace(',', '.') || 0);
  o.rating = Math.min(5, o.rating);
  o.favorite = !!o.favorite;
  o.images = Array.isArray(o.images) ? o.images.filter(f => typeof f === 'string') : [];
  if (!o.servingsUnit) o.servingsUnit = 'Portionen';
  return o;
}

function indexRecipe(r) {
  IDX.set(r, {
    title: fold(r.title),
    tags: r.tags.map(fold),
    ing: fold(r.ingredients),
    all: fold([r.title, r.description, r.category, r.tags.join(' '), r.ingredients, r.steps, r.notes, r.source].join(' \n ')),
  });
}

function setRecipes(list) {
  state.recipes = list.map(normalize);
  state.recipes.forEach(indexRecipe);
  state.byId = new Map(state.recipes.map(r => [r.id, r]));
  state.loadedAt = Date.now();
}

function upsert(r) {
  r = normalize(r);
  indexRecipe(r);
  const i = state.recipes.findIndex(x => x.id === r.id);
  if (i >= 0) state.recipes[i] = r; else state.recipes.push(r);
  state.byId.set(r.id, r);
  return r;
}

// Speichert zuerst auf dem Gerät; der Abgleich bringt das Rezept aufs NAS (sofort, wenn es erreichbar ist)
async function saveRecipe(r) {
  const clean = normalize(r);
  for (const k of Object.keys(clean)) if (k.startsWith('_') || clean[k] === undefined) delete clean[k];
  if (!clean.title) throw new Error('Das Rezept braucht einen Titel.');
  if (!/^[a-z0-9][a-z0-9-]{2,80}$/.test(clean.id)) clean.id = newId();
  const now = new Date().toISOString();
  clean.created = clean.created || state.byId.get(clean.id)?.created || now;
  clean.updated = now;   // vorläufig – beim Übertragen setzt das NAS seinen eigenen Zeitstempel
  await queueChange(clean.id, 'save', clean);
  return upsert(clean);
}

const totalTime = r => r.prepTime + r.cookTime + r.restTime;
function fmtTime(min) {
  if (!min) return '';
  const h = Math.floor(min / 60), m = min % 60;
  return h ? `${h} Std.${m ? ' ' + m + ' Min.' : ''}` : `${m} Min.`;
}
const stars = n => `<span class="stars" title="${n} von 5">${'★'.repeat(n)}<span class="off">${'★'.repeat(5 - n)}</span></span>`;
const allTags = () => uniq(state.recipes.flatMap(r => r.tags)).sort((a, b) => a.localeCompare(b, 'de'));
const allCategories = () => uniq([...state.recipes.map(r => r.category).filter(Boolean)]).sort((a, b) => a.localeCompare(b, 'de'));

// ================= Mengen & Zeiten =================

const UNI = { '½': .5, '⅓': 1 / 3, '⅔': 2 / 3, '¼': .25, '¾': .75, '⅛': .125, '⅕': .2, '⅙': 1 / 6 };
const NUMPAT = '(?:\\d+\\s+\\d+/\\d+|\\d+/\\d+|\\d+(?:[.,]\\d+)?(?:\\s?[½⅓⅔¼¾⅛])?|[½⅓⅔¼¾⅛⅕⅙])';
const QTY_RE = new RegExp('^((?:ca\\.?|etwa|circa)\\s+)?(' + NUMPAT + ')(\\s*(?:-|–|bis)\\s*(' + NUMPAT + '))?');

function numVal(s) {
  s = s.trim();
  let m;
  if ((m = s.match(/^(\d+)\s+(\d+)\/(\d+)$/))) return +m[1] + m[2] / m[3];
  if ((m = s.match(/^(\d+)\/(\d+)$/))) return m[1] / m[2];
  if ((m = s.match(/^(\d+(?:[.,]\d+)?)\s?([½⅓⅔¼¾⅛])?$/))) return parseFloat(m[1].replace(',', '.')) + (UNI[m[2]] || 0);
  return UNI[s] ?? NaN;
}

function fmtNum(n) {
  if (n >= 100) return String(Math.round(n / 5) * 5);
  if (n >= 10) return String(Math.round(n));
  const whole = Math.floor(n), frac = n - whole;
  for (const [v, s] of [[0, ''], [.25, '¼'], [1 / 3, '⅓'], [.5, '½'], [2 / 3, '⅔'], [.75, '¾'], [1, '']]) {
    if (Math.abs(frac - v) < .04) {
      const w = v === 1 ? whole + 1 : whole;
      return ((w ? String(w) : '') + s) || '0';
    }
  }
  return String(Math.round(n * 10) / 10).replace('.', ',');
}

// Liefert {qty: HTML der Menge, rest} für eine Zutatenzeile, skaliert um factor
function scaleLine(line, factor) {
  const m = line.match(QTY_RE);
  if (!m) return { qty: '', rest: line };
  const rest = line.slice(m[0].length);
  if (factor === 1) return { qty: m[0], rest };
  const a = numVal(m[2]), b = m[4] ? numVal(m[4]) : NaN;
  if (isNaN(a)) return { qty: '', rest: line };
  return { qty: (m[1] || '') + fmtNum(a * factor) + (isNaN(b) ? '' : '–' + fmtNum(b * factor)), rest };
}

const lines = s => String(s || '').split('\n').map(l => l.trim()).filter(Boolean);
const isSection = l => /^#/.test(l);
const sectionText = l => l.replace(/^#+\s*/, '').replace(/:$/, '');

const TIME_RE = /(\d+(?:[.,]\d+)?)(?:\s*(?:-|–|bis)\s*(\d+(?:[.,]\d+)?))?\s*(Stunden|Stunde|Std\.?|Minuten|Minute|Min\.?|Sekunden|Sek\.?)(?![a-zäöü])/gi;
function linkTimers(escapedText) {
  return escapedText.replace(TIME_RE, (all, a, b, unit) => {
    const n = parseFloat(a.replace(',', '.'));
    const mult = /^st/i.test(unit) ? 3600 : /^se/i.test(unit) ? 1 : 60;
    return `<button type="button" class="timer-link" data-sec="${Math.round(n * mult)}">${all}</button>`;
  });
}

function parseDuration(s) {
  s = String(s || '').toLowerCase().replace(/(\d),(\d)/g, '$1.$2');
  let min = 0, found = false, m;
  if ((m = s.match(/(\d+(?:\.\d+)?)\s*(?:h\b|std|stunde)/))) { min += parseFloat(m[1]) * 60; found = true; }
  if ((m = s.match(/(\d+)\s*(?:min|m\b)/))) { min += +m[1]; found = true; }
  if (!found && (m = s.match(/(\d+)/))) min = +m[1];
  return Math.round(min);
}

function parseIsoDuration(s) {
  const m = String(s || '').match(/P(?:(\d+)D)?T?(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?/i);
  if (!m) return 0;
  return Math.round((+m[1] || 0) * 1440 + (+m[2] || 0) * 60 + (+m[3] || 0));
}

// ================= Timer =================

const timers = [];
let audioCtx = null, tickHandle = null;

function beep() {
  if (!audioCtx) return;
  [0, .3, .6].forEach(t => {
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.value = 880;
    g.gain.setValueAtTime(.25, audioCtx.currentTime + t);
    g.gain.exponentialRampToValueAtTime(.001, audioCtx.currentTime + t + .25);
    o.connect(g).connect(audioCtx.destination);
    o.start(audioCtx.currentTime + t);
    o.stop(audioCtx.currentTime + t + .26);
  });
}

function startTimer(sec, label) {
  try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume(); } catch { /* kein Ton */ }
  timers.push({ id: Date.now() + Math.random(), label, end: Date.now() + sec * 1000, ringing: false });
  toast(`Timer gestartet: ${fmtClock(sec)}`);
  if (!tickHandle) tickHandle = setInterval(tickTimers, 1000);
  tickTimers();
}

const fmtClock = sec => {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
};

function tickTimers() {
  const box = $('#timers');
  if (!timers.length) { box.hidden = true; clearInterval(tickHandle); tickHandle = null; return; }
  box.hidden = false;
  const now = Date.now();
  for (const t of timers) {
    const left = (t.end - now) / 1000;
    if (left <= 0 && !t.ringing) { t.ringing = true; if (navigator.vibrate) navigator.vibrate([400, 200, 400, 200, 400]); }
    if (t.ringing && Math.floor(now / 1000) % 3 === 0) beep();
  }
  box.innerHTML = timers.map(t => `<div class="timer ${t.ringing ? 'ring' : ''}" data-id="${t.id}">
    <div><div class="t">${t.ringing ? 'Fertig!' : fmtClock((t.end - now) / 1000)}</div><small>${esc(t.label)}</small></div>
    ${t.ringing ? '' : '<button data-act="plus">+1</button>'}<button data-act="stop" aria-label="Timer beenden">✕</button></div>`).join('');
}

$('#timers').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  const t = timers.find(x => String(x.id) === b.closest('.timer').dataset.id); if (!t) return;
  if (b.dataset.act === 'plus') t.end += 60000;
  else timers.splice(timers.indexOf(t), 1);
  tickTimers();
});

// ================= Kochmodus (Bildschirm bleibt an) =================

let wakeLock = null;
async function setCookMode(on) {
  document.body.classList.toggle('cook', on);
  try {
    if (on && 'wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
    else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch { /* nicht unterstützt (z. B. ohne HTTPS) */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (document.body.classList.contains('cook')) setCookMode(true);
});

// ================= Routing =================

let currentHash = location.hash, skipHash = false;

window.addEventListener('hashchange', () => {
  if (skipHash) { skipHash = false; return; }
  if (state.dirty && !confirm('Ungespeicherte Änderungen verwerfen?')) { skipHash = true; location.hash = currentHash; return; }
  state.dirty = false;
  if (/^#?\/?$/.test(currentHash)) state.libScroll = window.scrollY;
  currentHash = location.hash;
  route();
});
window.addEventListener('beforeunload', e => { if (state.dirty) { e.preventDefault(); e.returnValue = ''; } });

function route() {
  const [view, id] = location.hash.replace(/^#\/?/, '').split('/');
  setCookMode(false);
  closeModal();
  const navKey = { '': 'library', r: 'library', edit: 'new', new: 'new', ai: 'new', import: 'import', shopping: 'shopping', settings: 'settings' }[view || ''];
  $$('#nav a').forEach(a => a.classList.toggle('active', a.dataset.nav === navKey));
  window.scrollTo(0, 0);
  switch (view || '') {
    case '': return renderLibrary();
    case 'r': return renderRecipe(decodeURIComponent(id || ''));
    case 'edit': {
      const r = state.byId.get(decodeURIComponent(id || ''));
      return r ? renderEditor(structuredClone(r)) : renderNotFound();
    }
    case 'new': { const d = state.draft || blankRecipe(); state.draft = null; return renderEditor(d); }
    case 'import': if (id) state.importTab = id; return renderImport();
    case 'ai': return renderAi();
    case 'shopping': return renderShopping();
    case 'settings': return renderSettings();
    default: return renderNotFound();
  }
}

function renderNotFound() {
  app.innerHTML = `<div class="empty"><div class="big">🤷</div><p>Dieses Rezept gibt es nicht (mehr).</p><a class="btn" href="#/">Zur Übersicht</a></div>`;
}

// ================= Bibliothek =================

function parseQuery(q) {
  const out = [];
  String(q).replace(/(-?)"([^"]+)"|(-?)(\S+)/g, (m, n1, phrase, n2, word) => {
    const text = fold(phrase || word);
    if (text && text !== '-') out.push({ neg: !!(n1 || n2), text });
  });
  return out;
}
const splitList = s => String(s || '').split(/[,;]/).map(x => fold(x.trim())).filter(Boolean);

function activeFilterCount() {
  const f = state.filter;
  return [f.diff, f.time, f.rating, f.withIng, f.withoutIng].filter(Boolean).length + f.tags.length;
}

function filteredRecipes() {
  const f = state.filter, tokens = parseQuery(f.q), withI = splitList(f.withIng), without = splitList(f.withoutIng);
  const scores = new Map();
  const list = state.recipes.filter(r => {
    const ix = IDX.get(r);
    if (f.cat && r.category !== f.cat) return false;
    if (f.fav && !r.favorite) return false;
    if (f.diff && r.difficulty !== f.diff) return false;
    if (f.rating && r.rating < f.rating) return false;
    if (f.time && (!totalTime(r) || totalTime(r) > f.time)) return false;
    if (f.tags.length && !f.tags.every(t => r.tags.includes(t))) return false;
    if (withI.some(i => !ix.ing.includes(i))) return false;
    if (without.some(i => ix.ing.includes(i))) return false;
    let score = 0;
    for (const t of tokens) {
      const hit = ix.all.includes(t.text);
      if (t.neg ? hit : !hit) return false;
      if (t.neg) continue;
      if (ix.title.startsWith(t.text)) score += 15;
      else if (ix.title.includes(t.text)) score += 10;
      if (ix.tags.some(x => x.includes(t.text))) score += 5;
      if (ix.ing.includes(t.text)) score += 2;
      score += 1;
    }
    scores.set(r, score);
    return true;
  });
  const by = {
    title: (a, b) => a.title.localeCompare(b.title, 'de'),
    newest: (a, b) => String(b.created || '').localeCompare(String(a.created || '')),
    updated: (a, b) => String(b.updated || '').localeCompare(String(a.updated || '')),
    rating: (a, b) => b.rating - a.rating || a.title.localeCompare(b.title, 'de'),
    time: (a, b) => (totalTime(a) || 1e9) - (totalTime(b) || 1e9),
    cooked: (a, b) => String(b.lastCooked || '').localeCompare(String(a.lastCooked || '')) || b.cookCount - a.cookCount,
    random: (a, b) => hash(a.id) - hash(b.id),
  }[state.sort] || ((a, b) => a.title.localeCompare(b.title, 'de'));
  return list.sort((a, b) => (tokens.length ? scores.get(b) - scores.get(a) : 0) || by(a, b));
}
function hash(s) { let h = Math.floor(state.randomSeed * 1e9); for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 2654435761); return h >>> 0; }

function highlight(text) {
  const tokens = parseQuery(state.filter.q).filter(t => !t.neg);
  const f = fold(text);
  if (!tokens.length || f.length !== text.length) return esc(text);
  const marks = new Array(text.length).fill(false);
  for (const t of tokens) { let i = -1; while ((i = f.indexOf(t.text, i + 1)) >= 0) for (let k = i; k < i + t.text.length; k++) marks[k] = true; }
  let out = '', open = false;
  for (let i = 0; i < text.length; i++) {
    if (marks[i] !== open) { out += marks[i] ? '<mark>' : '</mark>'; open = marks[i]; }
    out += esc(text[i]);
  }
  return out + (open ? '</mark>' : '');
}

function cardHtml(r) {
  const t = totalTime(r);
  return `<a class="rcard" href="#/r/${encodeURIComponent(r.id)}">
    <div class="thumb">${r.images[0] ? `<img loading="lazy" src="${imgUrl(r.images[0])}" alt="" onerror="this.style.display='none'">` : catEmoji(r.category + ' ' + r.tags.join(' '))}
      ${r.favorite ? `<span class="fav">${icon('heart')}</span>` : ''}</div>
    <div class="body"><div class="title">${highlight(r.title)}</div>
      <div class="meta">${t ? `<span>${icon('clock')} ${fmtTime(t)}</span>` : ''}${r.rating ? stars(r.rating) : ''}${r.category ? `<span>${esc(r.category)}</span>` : ''}</div>
    </div></a>`;
}

// Ohne Server: alle 30 Tage an eine Sicherung erinnern (die Rezepte liegen sonst nur auf dem Handy)
function backupHint() {
  if (!LOCAL || state.recipes.length < 3 || sessionStorage.getItem('rz.bkHide')) return '';
  const last = store.get('lastBackup', 0);
  if (Date.now() - last < 30 * 864e5) return '';
  return `<div class="card backup-hint">💾 <span>${last ? 'Deine letzte Sicherung ist über einen Monat her.' : 'Du hast deine Rezepte noch nie gesichert.'} Sie liegen nur auf diesem Gerät.</span>
    <a class="btn small primary" href="#/settings">Jetzt sichern</a><button class="btn small" onclick="sessionStorage.setItem('rz.bkHide',1);this.parentNode.remove()">Später</button></div>`;
}

function renderLibrary() {
  if (!state.recipes.length) {
    app.innerHTML = `<div class="empty"><div class="big">📖</div><h2>Noch keine Rezepte</h2>
      <p>Lege dein erstes Rezept an oder importiere vorhandene Rezepte.</p>
      <div class="btn-row" style="justify-content:center"><a class="btn primary" href="#/new">${icon('plus')} Neues Rezept</a><a class="btn" href="#/import">${icon('import')} Importieren</a><a class="btn" href="#/ai">✨ Aus meinen Zutaten</a></div></div>`;
    return;
  }
  const f = state.filter;
  const opt = (v, label, cur) => `<option value="${v}" ${String(cur) === String(v) ? 'selected' : ''}>${label}</option>`;
  app.innerHTML = `${backupHint()}
    <div class="lib-head">
      <label class="search">${icon('search')}<input type="search" id="q" placeholder="Suchen – Titel, Zutat, Stichwort …" value="${esc(f.q)}" autocomplete="off" enterkeyhint="search"></label>
      <button class="btn icon" id="toggleFilters" title="Filter">${icon('filter')}<span id="fcount"></span></button>
      <button class="btn icon" id="random" title="Zufallsrezept">${icon('dice')}</button>
      <a class="btn ai-btn" href="#/ai" title="Rezept aus vorhandenen Zutaten erstellen">✨<span class="lbl">Was koche ich?</span></a>
    </div>
    <div class="cat-bar" id="catBar"></div>
    <div class="filters card" id="filters" ${state.showFilters ? '' : 'hidden'}>
      <div class="row">
        <label class="field"><span>Schwierigkeit</span><select id="fDiff">${opt('', 'alle', f.diff)}${DIFFS.map(d => opt(d, d, f.diff)).join('')}</select></label>
        <label class="field"><span>Gesamtzeit höchstens</span><select id="fTime">${opt(0, 'egal', f.time)}${[15, 30, 45, 60, 90, 120].map(m => opt(m, fmtTime(m), f.time)).join('')}</select></label>
        <label class="field"><span>Bewertung mindestens</span><select id="fRating">${opt(0, 'egal', f.rating)}${[1, 2, 3, 4, 5].map(n => opt(n, '★'.repeat(n), f.rating)).join('')}</select></label>
      </div>
      <div class="row">
        <label class="field"><span>Enthält Zutaten (mit Komma trennen)</span><input type="text" id="fWith" value="${esc(f.withIng)}" placeholder="z. B. Zucchini, Feta"></label>
        <label class="field"><span>Ohne Zutaten</span><input type="text" id="fWithout" value="${esc(f.withoutIng)}" placeholder="z. B. Nüsse, Sahne"></label>
      </div>
      <div><div class="filter-label">Stichworte</div><div class="chips" id="tagChips"></div></div>
      <div><button class="btn small" id="resetFilters">Alle Filter zurücksetzen</button></div>
    </div>
    <div class="result-bar"><span id="count"></span>
      <div class="btn-row">
        <select id="sort" aria-label="Sortierung">
          ${[['title', 'Name A–Z'], ['newest', 'Neueste zuerst'], ['updated', 'Zuletzt bearbeitet'], ['rating', 'Beste Bewertung'], ['time', 'Schnellste zuerst'], ['cooked', 'Zuletzt gekocht'], ['random', 'Zufällig']].map(([v, l]) => opt(v, l, state.sort)).join('')}
        </select>
        <button class="btn small" id="viewToggle">${state.view === 'grid' ? 'Liste' : 'Kacheln'}</button>
      </div>
    </div>
    <div id="results" class="${state.view === 'list' ? 'list-view' : ''}"></div>`;

  const bind = (sel, key, num) => $(sel).addEventListener('input', e => { f[key] = num ? +e.target.value : e.target.value; updateLibrary(); });
  bind('#q', 'q'); bind('#fDiff', 'diff'); bind('#fTime', 'time', true); bind('#fRating', 'rating', true);
  bind('#fWith', 'withIng'); bind('#fWithout', 'withoutIng');
  $('#q').addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });
  $('#toggleFilters').onclick = () => { state.showFilters = !state.showFilters; $('#filters').hidden = !state.showFilters; updateLibrary(); };
  $('#random').onclick = () => {
    const list = filteredRecipes();
    if (list.length) location.hash = '#/r/' + encodeURIComponent(list[Math.floor(Math.random() * list.length)].id);
  };
  $('#sort').onchange = e => { state.sort = e.target.value; store.set('sort', state.sort); state.randomSeed = Math.random(); updateLibrary(); };
  $('#viewToggle').onclick = () => { state.view = state.view === 'grid' ? 'list' : 'grid'; store.set('view', state.view); renderLibrary(); };
  $('#resetFilters').onclick = () => { Object.assign(f, { q: '', cat: '', tags: [], diff: '', time: 0, rating: 0, fav: false, withIng: '', withoutIng: '' }); renderLibrary(); };
  $('#catBar').addEventListener('click', e => {
    const c = e.target.closest('[data-cat]'); if (!c) return;
    if (c.dataset.cat === '♥') f.fav = !f.fav; else f.cat = c.dataset.cat;
    updateLibrary();
  });
  $('#tagChips').addEventListener('click', e => {
    const c = e.target.closest('[data-tag]'); if (!c) return;
    const t = c.dataset.tag;
    f.tags = f.tags.includes(t) ? f.tags.filter(x => x !== t) : [...f.tags, t];
    updateLibrary();
  });
  updateLibrary();
  requestAnimationFrame(() => window.scrollTo(0, state.libScroll));
}

function updateLibrary() {
  const f = state.filter, list = filteredRecipes();
  const counts = {};
  state.recipes.forEach(r => { if (r.category) counts[r.category] = (counts[r.category] || 0) + 1; });
  $('#catBar').innerHTML = `<button class="chip ${f.fav ? 'on' : ''}" data-cat="♥">♥ Favoriten</button>
    <button class="chip ${!f.cat ? 'on' : ''}" data-cat="">Alle</button>` +
    allCategories().map(c => `<button class="chip ${f.cat === c ? 'on' : ''}" data-cat="${esc(c)}">${esc(c)} <small>${counts[c]}</small></button>`).join('');
  const tags = allTags();
  $('#tagChips').innerHTML = tags.length ? tags.map(t => `<button class="chip ${f.tags.includes(t) ? 'on' : ''}" data-tag="${esc(t)}">${esc(t)}</button>`).join('') : '<span class="hint">Noch keine Stichworte vergeben.</span>';
  const n = activeFilterCount();
  $('#fcount').textContent = n ? ' ' + n : '';
  $('#toggleFilters').classList.toggle('on', state.showFilters || n > 0);
  $('#count').textContent = list.length === state.recipes.length ? `${list.length} Rezepte` : `${list.length} von ${state.recipes.length} Rezepten`;
  $('#results').innerHTML = list.length ? `<div class="grid">${list.map(cardHtml).join('')}</div>`
    : `<div class="empty"><div class="big">🔍</div><p>Nichts gefunden. Suchbegriff oder Filter ändern.</p></div>`;
}

// ================= Rezeptansicht =================

function renderRecipe(id) {
  const r = state.byId.get(id);
  if (!r) return renderNotFound();
  const v = { servings: r.servings || 0, img: 0 };
  const facts = [
    r.prepTime && ['Vorbereitung', fmtTime(r.prepTime)], r.cookTime && ['Koch-/Backzeit', fmtTime(r.cookTime)],
    r.restTime && ['Ruhezeit', fmtTime(r.restTime)], totalTime(r) && ['Gesamt', fmtTime(totalTime(r))],
    r.difficulty && ['Schwierigkeit', r.difficulty], r.lastCooked && ['Zuletzt gekocht', new Date(r.lastCooked).toLocaleDateString('de-DE') + (r.cookCount > 1 ? ` (${r.cookCount}×)` : '')],
  ].filter(Boolean);
  const isUrl = /^https?:\/\//i.test(r.source);

  app.innerHTML = `
    <div class="cook-bar"><span>${icon('chef')} Kochmodus</span><button class="btn small" id="exitCook">Beenden</button></div>
    <a class="back" href="#/">${icon('back')} Alle Rezepte</a>
    <div class="recipe-top">
      <div class="gallery">
        <div class="main" id="mainImg">${r.images.length ? `<img src="${imgUrl(r.images[0])}" alt="" onerror="this.style.display='none'">` : catEmoji(r.category + ' ' + r.tags.join(' '))}</div>
        ${r.images.length > 1 ? `<div class="thumbs">${r.images.map((f, i) => `<img src="${imgUrl(f)}" data-i="${i}" class="${i ? '' : 'on'}" alt="">`).join('')}</div>` : ''}
      </div>
      <div class="recipe-info">
        <h1>${esc(r.title)}</h1>
        ${r.description ? `<p class="desc">${esc(r.description)}</p>` : ''}
        <div class="rate-input" id="rate">${[1, 2, 3, 4, 5].map(n => `<button data-n="${n}" class="${n <= r.rating ? 'on' : ''}" aria-label="${n} Sterne">★</button>`).join('')}</div>
        ${facts.length ? `<div class="facts">${facts.map(([k, val]) => `<div class="fact"><small>${k}</small><b>${esc(val)}</b></div>`).join('')}</div>` : ''}
        <div class="chips">${r.category ? `<a class="chip" href="#/" data-fcat="${esc(r.category)}">${esc(r.category)}</a>` : ''}${r.tags.map(t => `<a class="chip" href="#/" data-ftag="${esc(t)}">#${esc(t)}</a>`).join('')}</div>
        ${r.source ? `<p class="hint source">Quelle: ${isUrl ? `<a href="${esc(r.source)}" target="_blank" rel="noopener noreferrer">${esc(r.source)}</a>` : esc(r.source)}</p>` : ''}
        <div class="actions">
          <a class="btn primary" href="#/edit/${encodeURIComponent(r.id)}">${icon('edit')} Bearbeiten</a>
          <button class="btn" id="cookBtn">${icon('chef')} Kochmodus</button>
          <button class="btn fav-btn ${r.favorite ? 'on' : ''}" id="favBtn" title="Favorit">${icon('heart')}</button>
          <button class="btn" id="shopBtn">${icon('cart')} Einkaufsliste</button>
          <button class="btn" id="cookedBtn" title="Heute gekocht markieren">${icon('check')} Gekocht</button>
          <button class="btn" id="moreBtn">… Mehr</button>
        </div>
      </div>
    </div>
    <div class="recipe-body">
      <section class="card ingredients">
        <h2>Zutaten</h2>
        ${r.servings ? `<div class="scaler"><button class="btn small icon" id="sMinus" aria-label="weniger">−</button><span class="num" id="sNum"></span><span>${esc(r.servingsUnit)}</span><button class="btn small icon" id="sPlus" aria-label="mehr">+</button><button class="btn small" id="sReset" hidden>Original</button></div>` : ''}
        <ul class="ing-list" id="ingList"></ul>
      </section>
      <section class="card">
        <h2>Zubereitung</h2>
        <ol class="step-list" id="stepList">${renderSteps(r)}</ol>
      </section>
    </div>
    ${r.notes ? `<section class="card notes-card" style="margin-top:24px"><h2>Notizen &amp; Tipps</h2><div class="notes">${linkTimers(esc(r.notes))}</div></section>` : ''}`;

  const drawIngredients = () => {
    const factor = r.servings ? v.servings / r.servings : 1;
    if ($('#sNum')) { $('#sNum').textContent = fmtNum(v.servings); $('#sReset').hidden = factor === 1; }
    $('#ingList').innerHTML = lines(r.ingredients).map(l => {
      if (isSection(l)) return `<li class="sec">${esc(sectionText(l))}</li>`;
      const { qty, rest } = scaleLine(l, factor);
      return `<li><span class="box"></span><span>${qty ? `<span class="q">${esc(qty)}</span>` : ''}${esc(rest)}</span></li>`;
    }).join('') || '<li class="hint">Keine Zutaten eingetragen.</li>';
  };
  drawIngredients();
  if ($('#sPlus')) {
    $('#sPlus').onclick = () => { v.servings = +(v.servings + (v.servings < 1 ? .5 : 1)).toFixed(2); drawIngredients(); };
    $('#sMinus').onclick = () => { v.servings = Math.max(.5, +(v.servings - (v.servings <= 1 ? .5 : 1)).toFixed(2)); drawIngredients(); };
    $('#sReset').onclick = () => { v.servings = r.servings; drawIngredients(); };
  }
  $('#ingList').addEventListener('click', e => { const li = e.target.closest('li:not(.sec)'); if (li) li.classList.toggle('done'); });
  $('#stepList').addEventListener('click', e => {
    const tb = e.target.closest('.timer-link');
    if (tb) { startTimer(+tb.dataset.sec, r.title); return; }
    const li = e.target.closest('li.step'); if (!li) return;
    li.classList.toggle('done');
    $$('#stepList li.step').forEach(x => x.classList.remove('current'));
    const next = $$('#stepList li.step:not(.done)')[0];
    if (next) next.classList.add('current');
  });
  const notes = $('.notes');
  if (notes) notes.addEventListener('click', e => { const tb = e.target.closest('.timer-link'); if (tb) startTimer(+tb.dataset.sec, r.title); });

  $('#mainImg').onclick = () => { if (r.images.length) lightbox(imgUrl(r.images[v.img])); };
  $$('.gallery .thumbs img').forEach(img => img.onclick = () => {
    v.img = +img.dataset.i;
    $('#mainImg img').src = img.src;
    $$('.gallery .thumbs img').forEach(x => x.classList.toggle('on', x === img));
  });
  $$('[data-fcat],[data-ftag]').forEach(a => a.addEventListener('click', () => {
    Object.assign(state.filter, { q: '', cat: a.dataset.fcat || '', tags: a.dataset.ftag ? [a.dataset.ftag] : [], fav: false });
    if (a.dataset.ftag) state.showFilters = true;
    state.libScroll = 0;
  }));

  const quickSave = async (patch, msg) => {
    try { const saved = await saveRecipe({ ...r, ...patch }); Object.assign(r, saved); if (msg) toast(msg); return true; }
    catch (e) { toast(e.message, true); return false; }
  };
  $('#rate').addEventListener('click', async e => {
    const b = e.target.closest('button'); if (!b) return;
    const n = +b.dataset.n === r.rating ? 0 : +b.dataset.n;
    if (await quickSave({ rating: n })) $$('#rate button').forEach(x => x.classList.toggle('on', +x.dataset.n <= n));
  });
  $('#favBtn').onclick = async () => {
    if (await quickSave({ favorite: !r.favorite }, !r.favorite ? 'Zu Favoriten hinzugefügt' : 'Aus Favoriten entfernt')) $('#favBtn').classList.toggle('on', r.favorite);
  };
  $('#cookedBtn').onclick = () => quickSave({ lastCooked: today(), cookCount: r.cookCount + 1 }, 'Als heute gekocht vermerkt 👩‍🍳');
  $('#cookBtn').onclick = () => { setCookMode(true); window.scrollTo(0, 0); };
  $('#exitCook').onclick = () => setCookMode(false);
  $('#shopBtn').onclick = () => addToShoppingDialog(r, r.servings ? v.servings / r.servings : 1);
  $('#moreBtn').onclick = () => moreDialog(r, v);
}

function renderSteps(r) {
  return lines(r.steps).map(l => isSection(l)
    ? `<li class="sec">${esc(sectionText(l))}</li>`
    : `<li class="step">${linkTimers(esc(l))}</li>`).join('') || '<li class="hint">Keine Zubereitungsschritte eingetragen.</li>';
}

function recipeAsText(r, factor = 1) {
  const out = [r.title, ''];
  if (r.description) out.push(r.description, '');
  const meta = [];
  if (r.servings) meta.push(`${r.servingsUnit}: ${fmtNum(r.servings * factor)}`);
  if (r.prepTime) meta.push(`Vorbereitung: ${fmtTime(r.prepTime)}`);
  if (r.cookTime) meta.push(`Kochzeit: ${fmtTime(r.cookTime)}`);
  if (r.restTime) meta.push(`Ruhezeit: ${fmtTime(r.restTime)}`);
  if (meta.length) out.push(...meta, '');
  out.push('Zutaten:');
  lines(r.ingredients).forEach(l => {
    if (isSection(l)) out.push('', sectionText(l) + ':');
    else { const { qty, rest } = scaleLine(l, factor); out.push('- ' + qty + rest); }
  });
  out.push('', 'Zubereitung:');
  let n = 0;
  lines(r.steps).forEach(l => out.push(isSection(l) ? '\n' + sectionText(l) + ':' : `${++n}. ${l}`));
  if (r.notes) out.push('', 'Tipps:', r.notes);
  if (r.source) out.push('', 'Quelle: ' + r.source);
  return out.join('\n');
}

function moreDialog(r, v) {
  const factor = r.servings ? v.servings / r.servings : 1;
  modal(`<h2>${esc(r.title)}</h2><div class="btn-row" style="flex-direction:column;align-items:stretch">
    <button class="btn" data-a="print">${icon('print')} Drucken</button>
    ${navigator.share ? `<button class="btn" data-a="share">${icon('share')} Teilen</button>` : ''}
    <button class="btn" data-a="copy">${icon('copy')} Als Text kopieren</button>
    <button class="btn" data-a="json">${icon('import')} Als Datei exportieren (mit Bildern)</button>
    <button class="btn" data-a="dup">${icon('copy')} Duplizieren</button>
    <button class="btn danger" data-a="del">${icon('trash')} Löschen</button>
    <button class="btn" data-close>Schließen</button></div>`, box => {
    box.addEventListener('click', async e => {
      const a = e.target.closest('[data-a]')?.dataset.a; if (!a) return;
      closeModal();
      if (a === 'print') setTimeout(() => window.print(), 100);
      if (a === 'share') navigator.share({ title: r.title, text: recipeAsText(r, factor) }).catch(() => {});
      if (a === 'copy') copyText(recipeAsText(r, factor));
      if (a === 'json') exportRecipes([r], true, safeName(r.title));
      if (a === 'dup') {
        state.draft = { ...structuredClone(r), id: '', title: r.title + ' (Kopie)', lastCooked: '', cookCount: 0, created: undefined };
        location.hash = '#/new';
      }
      if (a === 'del' && confirm(`„${r.title}“ wirklich löschen? Das kann nicht rückgängig gemacht werden.`)) {
        try {
          await deleteRecipe(r.id);
          toast('Rezept gelöscht');
          location.hash = '#/';
        } catch (err) { toast(err.message, true); }
      }
    });
  });
}

// ================= Editor =================

function renderEditor(r) {
  const e = normalize(r);
  const isNew = !e.id;
  const cats = uniq([...CATEGORIES, ...allCategories()]);
  const val = s => esc(s ?? '');
  app.innerHTML = `
    <a class="back" href="${isNew ? '#/' : '#/r/' + encodeURIComponent(e.id)}">${icon('back')} ${isNew ? 'Abbrechen' : 'Zurück zum Rezept'}</a>
    <h1>${isNew ? 'Neues Rezept' : 'Rezept bearbeiten'}</h1>
    ${isNew && !e.title ? `<a class="btn ai-btn" href="#/ai" style="margin-bottom:8px">✨ Oder: Rezept aus vorhandenen Zutaten von ${esc(aiName())} erstellen lassen</a>
      <a class="btn ai-btn" href="#/import/photo" style="margin-bottom:16px">📷 Oder: Rezept von einem Foto abschreiben lassen (Kochbuch, Rezeptkarte)</a>` : ''}
    <form class="editor" id="editor" autocomplete="off">
      <div class="card editor">
        <label class="field"><span>Titel *</span><input type="text" name="title" required value="${val(e.title)}" placeholder="z. B. Omas Apfelkuchen"></label>
        <label class="field"><span>Kurzbeschreibung</span><textarea name="description" rows="2" placeholder="Was macht das Rezept aus?">${val(e.description)}</textarea></label>
        <div class="grid2">
          <label class="field"><span>Kategorie</span><input type="text" name="category" list="catList" value="${val(e.category)}" placeholder="z. B. Hauptgericht">
            <datalist id="catList">${cats.map(c => `<option value="${esc(c)}">`).join('')}</datalist></label>
          <label class="field"><span>Schwierigkeit</span><select name="difficulty"><option value="">–</option>${DIFFS.map(d => `<option ${e.difficulty === d ? 'selected' : ''}>${d}</option>`).join('')}</select></label>
          <label class="field"><span>Bewertung</span><select name="rating">${[0, 1, 2, 3, 4, 5].map(n => `<option value="${n}" ${e.rating === n ? 'selected' : ''}>${n ? '★'.repeat(n) : '–'}</option>`).join('')}</select></label>
          <label class="field" style="align-self:end"><span class="check"><input type="checkbox" name="favorite" ${e.favorite ? 'checked' : ''}> ♥ Favorit</span></label>
        </div>
        <label class="field"><span>Stichworte (mit Komma trennen)</span><input type="text" name="tags" value="${val(e.tags.join(', '))}" placeholder="z. B. vegetarisch, schnell, Sommer"></label>
        <div class="chips" id="tagSuggest"></div>
        <div class="grid2">
          <label class="field"><span>Menge</span><input type="number" name="servings" min="0" step="0.5" value="${e.servings || ''}"></label>
          <label class="field"><span>Einheit</span><input type="text" name="servingsUnit" list="unitList" value="${val(e.servingsUnit)}">
            <datalist id="unitList"><option value="Portionen"><option value="Personen"><option value="Stück"><option value="Gläser"><option value="Bleche"></datalist></label>
          <label class="field"><span>Vorbereitung (Min.)</span><input type="number" name="prepTime" min="0" value="${e.prepTime || ''}"></label>
          <label class="field"><span>Koch-/Backzeit (Min.)</span><input type="number" name="cookTime" min="0" value="${e.cookTime || ''}"></label>
          <label class="field"><span>Ruhezeit (Min.)</span><input type="number" name="restTime" min="0" value="${e.restTime || ''}"></label>
        </div>
      </div>

      <div class="card"><h2>Bilder</h2>
        <div class="img-grid" id="imgGrid"></div>
        <p class="hint">Das erste Bild ist das Titelbild. Bilder werden automatisch verkleinert. Du kannst auch ein Bild mit Strg+V einfügen.</p>
        <input type="file" id="imgFile" accept="image/*" multiple hidden>
      </div>

      <div class="two">
        <div class="card"><h2>Zutaten</h2>
          <textarea name="ingredients" class="big" placeholder="500 g Mehl&#10;1 Pck. Trockenhefe&#10;1 TL Salz&#10;&#10;# Für den Belag&#10;2 Äpfel">${val(e.ingredients)}</textarea>
          <p class="hint">Eine Zutat pro Zeile, Menge vorne (dann lässt sie sich umrechnen). Zwischenüberschriften mit <b>#</b> beginnen, z. B. „# Für den Teig“.</p>
        </div>
        <div class="card"><h2>Zubereitung</h2>
          <textarea name="steps" class="big" placeholder="Mehl und Salz mischen.&#10;Hefe in lauwarmem Wasser auflösen …&#10;Im Ofen bei 200 °C ca. 25 Minuten backen.">${val(e.steps)}</textarea>
          <p class="hint">Ein Arbeitsschritt pro Zeile. Zeitangaben wie „25 Minuten“ werden in der Ansicht zu Timern.</p>
        </div>
      </div>

      <div class="card editor">
        <label class="field"><span>Notizen &amp; Tipps</span><textarea name="notes" rows="4" placeholder="Varianten, Beilagen, eigene Erfahrungen …">${val(e.notes)}</textarea></label>
        <label class="field"><span>Quelle</span><input type="text" name="source" value="${val(e.source)}" placeholder="z. B. Oma, Kochbuch S. 42 oder https://…"></label>
      </div>

      <div class="save-bar">
        <button type="button" class="btn" id="cancel">Abbrechen</button>
        <button type="submit" class="btn primary" id="saveBtn">${icon('check')} Speichern</button>
      </div>
    </form>`;

  const form = $('#editor');
  const drawImages = () => {
    $('#imgGrid').innerHTML = e.images.map((f, i) => `<div class="img-item">
        <img src="${imgUrl(f)}" alt="">${i === 0 ? '<span class="cover">Titelbild</span>' : ''}
        <div class="ctl">${i ? `<button type="button" data-cover="${i}">Titelbild</button>` : '<span></span>'}<button type="button" data-del="${i}">Entfernen</button></div>
      </div>`).join('') +
      `<button type="button" class="img-add" id="addImg">${icon('image')}<br>Foto hinzufügen</button>
       ${LOCAL ? '' : '<button type="button" class="img-add" id="addImgUrl">🔗<br>Bild von<br>Internetadresse</button>'}`;
  };
  drawImages();
  const drawTagSuggest = () => {
    const cur = form.tags.value.split(',').map(t => t.trim()).filter(Boolean);
    const rest = allTags().filter(t => !cur.includes(t)).slice(0, 30);
    $('#tagSuggest').innerHTML = rest.map(t => `<button type="button" class="chip" data-addtag="${esc(t)}">+ ${esc(t)}</button>`).join('');
  };
  drawTagSuggest();

  form.addEventListener('input', ev => { state.dirty = true; if (ev.target.name === 'tags') drawTagSuggest(); });
  $('#tagSuggest').addEventListener('click', ev => {
    const b = ev.target.closest('[data-addtag]'); if (!b) return;
    const cur = form.tags.value.split(',').map(t => t.trim()).filter(Boolean);
    form.tags.value = [...cur, b.dataset.addtag].join(', ');
    state.dirty = true; drawTagSuggest();
  });

  const uploadFiles = async files => {
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue;
      toast('Bild wird hinzugefügt …');
      try {
        const data = await resizeImage(file);
        const name = await storeImage(data);
        e.images.push(name); state.dirty = true; drawImages();
        toast('Bild hinzugefügt');
      } catch (err) { toast(err.message || 'Bild konnte nicht verarbeitet werden', true); }
    }
  };
  $('#imgGrid').addEventListener('click', async ev => {
    const t = ev.target.closest('button'); if (!t) return;
    if (t.id === 'addImg') return $('#imgFile').click();
    if (t.id === 'addImgUrl') {
      const url = prompt('Internetadresse des Bildes (https://…):');
      if (!url) return;
      try { toast('Bild wird geladen …'); const { file } = await api('import_image_url', { body: { url } }); e.images.push(file); state.dirty = true; drawImages(); toast('Bild hinzugefügt'); }
      catch (err) { toast(err.message, true); }
      return;
    }
    if (t.dataset.del) { e.images.splice(+t.dataset.del, 1); state.dirty = true; drawImages(); }
    if (t.dataset.cover) { const [img] = e.images.splice(+t.dataset.cover, 1); e.images.unshift(img); state.dirty = true; drawImages(); }
  });
  $('#imgFile').onchange = ev => { uploadFiles([...ev.target.files]); ev.target.value = ''; };
  form.addEventListener('paste', ev => {
    const files = [...(ev.clipboardData?.files || [])].filter(f => f.type.startsWith('image/'));
    if (files.length) { ev.preventDefault(); uploadFiles(files); }
  });

  $('#cancel').onclick = () => { location.hash = isNew ? '#/' : '#/r/' + encodeURIComponent(e.id); };
  form.onsubmit = async ev => {
    ev.preventDefault();
    const fd = new FormData(form);
    const data = {
      ...e,
      title: fd.get('title'), description: fd.get('description'), category: fd.get('category'),
      tags: fd.get('tags'), servings: fd.get('servings'), servingsUnit: fd.get('servingsUnit'),
      prepTime: fd.get('prepTime'), cookTime: fd.get('cookTime'), restTime: fd.get('restTime'),
      difficulty: fd.get('difficulty'), rating: fd.get('rating'), favorite: !!fd.get('favorite'),
      ingredients: fd.get('ingredients'), steps: fd.get('steps'), notes: fd.get('notes'), source: fd.get('source'),
    };
    $('#saveBtn').disabled = true;
    try {
      const saved = await saveRecipe(normalize(data));
      state.dirty = false;
      toast('Gespeichert');
      location.hash = '#/r/' + encodeURIComponent(saved.id);
    } catch (err) { toast(err.message, true); $('#saveBtn').disabled = false; }
  };
}

function resizeImage(file, max = 1600, quality = .85) {
  return new Promise((resolve, reject) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Bildformat wird vom Browser nicht unterstützt.')); };
    img.src = url;
  });
}

// ================= Einkaufsliste =================

let shopDraw = null;   // zeichnet die gerade offene Einkaufsliste neu (nach einem Abgleich)
function saveShopping() {
  updateShopBadge();
  sync.shopDirty = true;
  persistShopping();
  drawSync();
  scheduleSync(400);
}
function updateShopBadge() {
  const n = state.shopping.filter(i => !i.done).length;
  const b = $('#shopBadge'); b.hidden = !n; b.textContent = n;
}

// ---------- Bring! ----------

const BRING_UNITS = 'kg|mg|g|ml|cl|dl|l|Liter|EL|TL|Msp\\.?|Prisen?|Pck\\.?|Päckchen|Packungen?|Pkg\\.?|Stück|Stk\\.?|Dosen?|Bund|Zehen?|Becher|Tassen?|Scheiben?|Glas|Gläser|Handvoll|Beutel|Flaschen?|Tafeln?|Würfel|Zweige?|Blatt|Blätter|Kopf|Köpfe|Knollen?|Stangen?|cm|Schuss|Spritzer|Tropfen|Pakete?|Netz|Schalen?|Rollen?|Riegel|Portionen?|kleiner?|kleines|großer?|großes|mittelgroßer?|mittelgroßes';
const BRING_UNIT_RE = new RegExp('^(?:(?:' + BRING_UNITS + ')\\.?)(?=\\s|$)', 'i');

// "500 g Mehl (Type 405)" → { name: "Mehl", spec: "500 g Type 405" }
function bringSplit(text) {
  let t = String(text).trim();
  const spec = [];
  const m = t.match(QTY_RE);
  if (m) {
    spec.push(m[0].trim());
    t = t.slice(m[0].length).trim();
    for (let i = 0; i < 2; i++) { const u = t.match(BRING_UNIT_RE); if (!u) break; spec.push(u[0]); t = t.slice(u[0].length).trim(); }
  }
  const p = t.match(/^(.+?)\s*\(([^)]*)\)\s*(.*)$/);
  if (p) { t = (p[1] + ' ' + p[3]).trim(); spec.push(p[2]); }
  const c = t.match(/^([^,]+),\s*([a-zäöüß].*)$/);   // "Zwiebel, fein gewürfelt" – aber nicht "Salz, Pfeffer"
  if (c) { t = c[1].trim(); spec.push(c[2]); }
  t = t.replace(/^(?:von|vom)\s+/i, '');
  return { name: t ? t[0].toUpperCase() + t.slice(1) : String(text).trim(), spec: spec.join(' ').trim() };
}

async function sendToBring(texts) {
  const items = texts.map(bringSplit).filter(i => i.name);
  if (!items.length) { toast('Nichts zum Senden', true); return false; }
  toast('Wird an Bring! gesendet …');
  try {
    const { count, list } = await api('bring_send', { body: { items } });
    toast(`${count} ${count === 1 ? 'Artikel' : 'Artikel'} an Bring!${list ? ' („' + list + '“)' : ''} gesendet ✓`);
    return true;
  } catch (e) { toast(e.message, true); return false; }
}

function addToShoppingDialog(r, factor) {
  const items = lines(r.ingredients).filter(l => !isSection(l)).map(l => { const { qty, rest } = scaleLine(l, factor); return qty + rest; });
  if (!items.length) return toast('Keine Zutaten vorhanden', true);
  modal(`<h2>Auf die Einkaufsliste</h2><p class="hint">Was du schon zu Hause hast, einfach abwählen.</p>
    <ul class="ing-pick">${items.map((t, i) => `<li><label class="check"><input type="checkbox" checked data-i="${i}"> ${esc(t)}</label></li>`).join('')}</ul>
    <div class="btn-row">${state.status?.bring ? `<button class="btn primary" id="doBring">🛒 An Bring! senden</button>` : ''}<button class="btn ${state.status?.bring ? '' : 'primary'}" id="doAdd">${icon('cart')} Auf Liste hier</button><button class="btn" data-close>Abbrechen</button></div>`, box => {
    if ($('#doBring', box)) $('#doBring', box).onclick = async e => {
      const picked = $$('input:checked', box).map(c => items[+c.dataset.i]);
      e.target.disabled = true;
      if (await sendToBring(picked)) closeModal(); else e.target.disabled = false;
    };
    $('#doAdd', box).onclick = () => {
      const picked = $$('input:checked', box).map(c => items[+c.dataset.i]);
      picked.forEach(text => state.shopping.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), text, done: false, from: r.title }));
      saveShopping(); closeModal();
      toast(`${picked.length} Zutaten zur Einkaufsliste hinzugefügt`);
    };
  });
}

async function renderShopping() {
  updateShopBadge();
  const draw = shopDraw = () => {
    const open = state.shopping.filter(i => !i.done), done = state.shopping.filter(i => i.done);
    const li = i => `<li class="${i.done ? 'done' : ''}" data-id="${esc(i.id)}"><label><input type="checkbox" ${i.done ? 'checked' : ''}><span>${esc(i.text)}${i.from ? `<small>${esc(i.from)}</small>` : ''}</span></label><button class="del" aria-label="Entfernen">✕</button></li>`;
    $('#shopList').innerHTML = (open.map(li).join('') + done.map(li).join('')) || '<li class="hint">Die Liste ist leer. Füge Zutaten direkt aus einem Rezept hinzu oder tippe oben etwas ein.</li>';
  };
  app.innerHTML = `<h1>Einkaufsliste</h1>
    <form class="shop-add" id="shopAdd"><input type="text" id="shopText" placeholder="Artikel hinzufügen …" enterkeyhint="done"><button class="btn primary" type="submit">${icon('plus')}</button></form>
    ${state.status?.bring ? `<button class="btn primary bring-btn" id="shopBring">🛒 Offene Artikel an Bring! senden</button>` : ''}
    <div class="card"><ul class="shop-list" id="shopList"></ul></div>
    <div class="btn-row" style="margin-top:14px">
      <button class="btn" id="shopClearDone">Erledigte entfernen</button>
      <button class="btn" id="shopCopy">${icon('copy')} Als Text kopieren</button>
      ${navigator.share ? `<button class="btn" id="shopShare">${icon('share')} Teilen</button>` : ''}
      <button class="btn danger" id="shopClear">Alles löschen</button>
    </div>`;
  draw();
  scheduleSync(100);
  $('#shopAdd').onsubmit = e => {
    e.preventDefault();
    const t = $('#shopText').value.trim(); if (!t) return;
    state.shopping.unshift({ id: Date.now().toString(36), text: t, done: false, from: '' });
    $('#shopText').value = ''; saveShopping(); draw();
  };
  $('#shopList').addEventListener('change', e => {
    const it = state.shopping.find(i => i.id === e.target.closest('li').dataset.id);
    if (it) { it.done = e.target.checked; saveShopping(); draw(); }
  });
  $('#shopList').addEventListener('click', e => {
    if (!e.target.closest('.del')) return;
    const id = e.target.closest('li').dataset.id;
    state.shopping = state.shopping.filter(i => i.id !== id); saveShopping(); draw();
  });
  const asText = () => state.shopping.filter(i => !i.done).map(i => '☐ ' + i.text).join('\n');
  if ($('#shopBring')) $('#shopBring').onclick = async e => {
    const open = state.shopping.filter(i => !i.done);
    if (!open.length) return toast('Keine offenen Artikel');
    e.target.disabled = true;
    if (await sendToBring(open.map(i => i.text))) { open.forEach(i => { i.done = true; }); saveShopping(); draw(); }
    e.target.disabled = false;
  };
  $('#shopClearDone').onclick = () => { state.shopping = state.shopping.filter(i => !i.done); saveShopping(); draw(); };
  $('#shopClear').onclick = () => { if (confirm('Ganze Einkaufsliste löschen?')) { state.shopping = []; saveShopping(); draw(); } };
  $('#shopCopy').onclick = () => copyText(asText());
  if ($('#shopShare')) $('#shopShare').onclick = () => navigator.share({ title: 'Einkaufsliste', text: asText() }).catch(() => {});
}

// ================= Import: Text-Erkennung =================

const SEC_ING = /^(zutaten|zutatenliste|ingredients|einkaufsliste|du brauchst|ihr braucht|man braucht|was du brauchst|benötigt)/i;
const SEC_STEP = /^(zubereitung|anleitung|so geht'?s|so wird'?s gemacht|und so geht'?s|arbeitsschritte|schritte|schritt-für-schritt|vorgehen|instructions|directions|method|preparation|zubereitungsschritte)/i;
const SEC_NOTE = /^(tipps?|hinweise?|notizen|anmerkungen?|varianten?|variationen?|notes|tip|serviervorschlag|servieren|dazu passt|aufbewahrung|nährwerte|naehrwerte|nutrition|lagerung|meal ?prep)/i;
const SEC_INTRO = /^(beschreibung|einleitung|über das rezept|info)/i;
const CHATTER = /^(guten appetit|viel spa(ß|ss)|lass (es )?mich wissen|möchtest du|soll ich|wenn du (magst|willst|möchtest)|ich hoffe|hier (ist|sind|kommt)|gerne!?$|klar!?$|natürlich!?$)/i;
const META_LABELS = [
  [/^(titel|rezeptname|rezept|name)$/i, (r, v) => { r.title = v; }],
  [/^(beschreibung)$/i, (r, v) => { r.description = v; }],
  [/^(zubereitungszeit|vorbereitungszeit|vorbereitung|arbeitszeit|aktive zeit|prep(aration)? time)$/i, (r, v) => { r.prepTime = parseDuration(v); }],
  [/^(kochzeit|backzeit|garzeit|bratzeit|cook(ing)? time|bake time)$/i, (r, v) => { r.cookTime = parseDuration(v); }],
  [/^(ruhezeit|gehzeit|kühlzeit|wartezeit|marinierzeit|rest(ing)? time)$/i, (r, v) => { r.restTime = parseDuration(v); }],
  [/^(gesamtzeit|dauer|zeit|zeitaufwand|total time)$/i, (r, v) => { r._total = parseDuration(v); }],
  [/^(portionen|personen|servings|menge|ergibt|für|yield|anzahl)$/i, (r, v) => setServings(r, v)],
  [/^(schwierigkeit|schwierigkeitsgrad|level|difficulty|aufwand)$/i, (r, v) => { r.difficulty = mapDifficulty(v); }],
  [/^(kategorie|category|gang)$/i, (r, v) => { r.category = v; }],
  [/^(tags|schlagworte|stichworte|keywords|stichwörter)$/i, (r, v) => { r.tags.push(...v.split(/[,;#]/)); }],
  [/^(küche|cuisine|herkunft|land)$/i, (r, v) => { r.tags.push(v); }],
  [/^(quelle|source)$/i, (r, v) => { r.source = v; }],
];

function setServings(r, v) {
  const m = String(v).match(/(\d+(?:[.,]\d+)?)/);
  if (!m) return false;
  r.servings = parseFloat(m[1].replace(',', '.'));
  const unit = String(v).match(/\d\s*(portionen|personen|stück|stk|gläser|bleche?|muffins|kekse|brötchen)/i);
  if (unit) r.servingsUnit = unit[1][0].toUpperCase() + unit[1].slice(1).toLowerCase();
  return true;
}
const mapDifficulty = v => /schwer|anspruchs|aufwendig|hard|difficult|profi/i.test(v) ? 'schwer' : /mittel|normal|medium/i.test(v) ? 'mittel' : /einfach|leicht|easy|simpel|anfänger/i.test(v) ? 'einfach' : '';

function stripMd(s) {
  return s.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__|`/g, '').replace(/(^|\s)\*(\S[^*]*)\*/g, '$1$2').replace(/^#+\s*/, '').trim();
}
const stripLead = s => s.replace(/^[^\p{L}\p{N}"„(]+/u, '').trim(); // Emojis, Aufzählungszeichen
const stripBullet = s => s.replace(/^\s*(?:[-*•–·▪◦►✓✔☐□]|\[\s?\])\s+/, '');
const stripNumber = s => s.replace(/^\s*(?:schritt\s*\d+\s*[:.)-]?|\d+\s*[.):]|\d+\s+-)\s*/i, '');

function parseRecipeText(text) {
  const r = { ...blankRecipe(), servings: 0, tags: [] };
  const ing = [], steps = [], notes = [], desc = [];
  let raw = String(text).replace(/\r/g, '').replace(/\t/g, ' ').split('\n');

  // Einleitendes Geplauder vor der ersten Überschrift überspringen
  const firstHeading = raw.findIndex(l => /^#{1,6}\s/.test(l.trim()));
  const firstSection = raw.findIndex(l => { const t = stripLead(stripMd(l.trim())); return t.length < 60 && (SEC_ING.test(t) || SEC_STEP.test(t)); });
  if (firstHeading >= 0 && (firstSection < 0 || firstHeading < firstSection)) {
    const t = stripLead(stripMd(raw[firstHeading].trim()));
    if (!SEC_ING.test(t) && !SEC_STEP.test(t) && !SEC_NOTE.test(t)) raw = raw.slice(firstHeading);
  }

  let section = 'intro', prevList = false, blank = true;
  for (const line of raw) {
    let l = line.trim();
    if (!l || /^([-*_=]\s*){3,}$/.test(l)) { blank = true; continue; }
    if (/^\|/.test(l)) {   // Markdown-Tabelle
      if (/^\|?\s*:?-{2,}/.test(l)) continue;
      l = l.split('|').map(c => c.trim()).filter(Boolean).join(' ');
      if (/^(menge|zutat|anzahl|amount|ingredient)\b/i.test(l)) continue;
    }
    const headingish = /^#{1,6}\s/.test(l) || /^(\*\*|__)[^*_]+(\*\*|__):?$/.test(l) || (/:$/.test(stripMd(l)) && stripMd(l).length < 50 && !/^\d/.test(stripMd(l)));
    const isList = /^\s*(?:[-*•–·▪◦►✓✔☐□]|\d+[.)])\s+/.test(l);
    let t = stripMd(l);
    const key = stripLead(t).replace(/:$/, '');

    if (CHATTER.test(stripLead(t)) && section !== 'ingredients') { blank = false; continue; }

    if (!r.title) {
      if (!SEC_ING.test(key) && !SEC_STEP.test(key)) {
        const m = key.match(/^(titel|rezeptname|rezept|name)\s*:\s*(.+)$/i);
        r.title = (m ? m[2] : key).replace(/:$/, '').trim();
        continue;
      }
      r.title = 'Unbenanntes Rezept';
    }

    // Abschnitts-Überschriften
    const km = key.match(/^([^:]{2,40}):\s*(.+)$/);   // z. B. "Tipp: Mit Zitrone servieren"
    const head = km ? km[1].trim() : key, after = km ? km[2].trim() : '';
    if (head.length < 70 && (headingish || (head.length < 40 && !/[.!?]$/.test(head)))) {
      let sec = SEC_ING.test(head) ? 'ingredients' : SEC_STEP.test(head) ? 'steps' : SEC_NOTE.test(head) ? 'notes' : SEC_INTRO.test(head) ? 'intro' : null;
      // "Zubereitung: 30 Min." ist eine Zeitangabe, keine Überschrift
      if (sec === 'steps' && after && after.length < 25 && /\d.*(min|std|stunde)/i.test(after)) { r.prepTime = parseDuration(after); blank = false; continue; }
      if (sec) {
        section = sec; prevList = false; blank = true;
        if (sec === 'ingredients' && !r.servings) {
          const m = head.match(/(\d+(?:[.,]\d+)?)\s*(portionen|personen|stück|stk|gläser|bleche?)/i);
          if (m) setServings(r, m[0]);
        }
        if (sec === 'notes' && !/^(tipps?|notizen|hinweise?|notes|anmerkungen?)$/i.test(head)) notes.push((notes.length ? '\n' : '') + head + ':');
        if (after) (sec === 'ingredients' ? ing : sec === 'steps' ? steps : sec === 'notes' ? notes : desc).push(after);
        continue;
      }
    }

    // Meta-Angaben "Label: Wert" (mehrere pro Zeile möglich)
    if (section !== 'steps') {
      const parts = stripLead(stripBullet(t)).split(/\s+[|·•]\s+|\s{3,}/);
      let used = false;
      for (const p of parts) {
        const m = p.match(/^([\p{L} .()-]{3,30}?)\s*:\s*(.+)$/u);
        if (!m) continue;
        const label = m[1].replace(/\(.*\)/, '').trim(), value = m[2].trim();
        const h = META_LABELS.find(([re]) => re.test(label));
        if (h && h[1](r, value) !== false) used = true;
      }
      if (used) { blank = false; continue; }
      if (section === 'intro' && desc.length < 3) {
        const m = stripLead(t).match(/^(?:für\s+|ergibt\s+)?(\d+(?:[.,]\d+)?)\s*(portionen|personen|stück|stk\.?|gläser|bleche?)\b/i);
        if (m && stripLead(t).length < 40) { setServings(r, m[0]); blank = false; continue; }
      }
    }

    if (section === 'intro') { if (!headingish) desc.push(t); }
    else if (section === 'ingredients') {
      const s = stripBullet(t).trim();
      if (headingish && !QTY_RE.test(s)) ing.push('# ' + stripLead(s).replace(/:$/, ''));
      else if (s) ing.push(s);
    } else if (section === 'steps') {
      const s = stripNumber(stripBullet(t)).trim();
      if (!s) continue;
      if (headingish && !isList && s.length < 50) steps.push('# ' + stripLead(s).replace(/:$/, ''));
      else if (!isList && prevList && !blank && steps.length) steps[steps.length - 1] += ' ' + s;
      else steps.push(s);
    } else if (section === 'notes') {
      notes.push(isList ? '• ' + stripBullet(t) : t);
    }
    prevList = isList;
    blank = false;
  }

  // Ohne erkennbare Abschnitte: Zeilen mit Mengen als Zutaten, Rest als Schritte
  if (!ing.length && !steps.length && desc.length) {
    for (const d of desc.splice(0)) {
      const s = stripBullet(d);
      (QTY_RE.test(s) && s.length < 70 ? ing : steps).push(stripNumber(s));
    }
  }
  if (r._total && !r.prepTime && !r.cookTime) r.prepTime = r._total;
  delete r._total;
  r.description = desc.join('\n');
  r.ingredients = ing.join('\n');
  r.steps = steps.join('\n');
  r.notes = notes.join('\n').trim();
  r.title = r.title || 'Unbenanntes Rezept';
  if (!r.servings) r.servings = 4;
  return normalize(r);
}

// ================= Import: JSON / schema.org / HTML =================

const decodeHtml = s => { const t = document.createElement('textarea'); t.innerHTML = String(s ?? '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' '); return t.value.replace(/[ \t]+/g, ' ').trim(); };

let ldIds = new Map();   // @id → Knoten, um Verweise wie "image": {"@id": …} aufzulösen
function collectLdIds(node) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach(collectLdIds); return; }
  if (node['@id'] && Object.keys(node).length > 1) ldIds.set(node['@id'], node);
  Object.values(node).forEach(collectLdIds);
}
const ldResolve = v => (v && typeof v === 'object' && !Array.isArray(v) && v['@id'] && Object.keys(v).length === 1 && ldIds.get(v['@id'])) || v;

function findLdRecipes(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach(n => findLdRecipes(n, out)); return out; }
  collectLdIds(node);
  const type = [].concat(node['@type'] || []);
  if (type.some(t => /recipe/i.test(t))) out.push(node);
  if (node['@graph']) findLdRecipes(node['@graph'], out);
  if (node.mainEntity) findLdRecipes(node.mainEntity, out);
  return out;
}

function fromSchema(s, pageUrl) {
  const first = v => Array.isArray(v) ? v[0] : v;
  const r = { ...blankRecipe(), tags: [] };
  r.title = decodeHtml(s.name || s.headline);
  r.description = decodeHtml(s.description);
  const y = [].concat(s.recipeYield || []).map(String);
  if (y.length) setServings(r, y.find(x => /\D/.test(x)) || y[0]);
  r.prepTime = parseIsoDuration(s.prepTime);
  r.cookTime = parseIsoDuration(s.cookTime);
  if (!r.prepTime && !r.cookTime) r.prepTime = parseIsoDuration(s.totalTime);
  r.ingredients = [].concat(s.recipeIngredient || s.ingredients || []).map(decodeHtml).filter(Boolean).join('\n');
  const steps = [];
  const walk = ins => {
    if (!ins) return;
    if (typeof ins === 'string') { decodeHtml(ins).split(/\n+/).forEach(x => x.trim() && steps.push(stripNumber(x.trim()))); return; }
    if (Array.isArray(ins)) { ins.forEach(walk); return; }
    if (/HowToSection/i.test([].concat(ins['@type']).join())) { if (ins.name) steps.push('# ' + decodeHtml(ins.name)); walk(ins.itemListElement); return; }
    walk(ins.text || ins.name || '');
  };
  walk(s.recipeInstructions);
  const heads = steps.filter(isSection);
  if (heads.length === 1 && steps[0] === heads[0]) steps.shift();   // einzelne Überschrift "Zubereitung" weglassen
  r.steps = steps.join('\n');
  r.category = decodeHtml(first(s.recipeCategory) || '');
  const kw = s.keywords ? (Array.isArray(s.keywords) ? s.keywords : String(s.keywords).split(',')) : [];
  r.tags = uniq([...[].concat(s.recipeCuisine || []), ...kw].map(decodeHtml).filter(t => t && t.length < 30)).slice(0, 12);
  const img = ldResolve(first(ldResolve(s.image)));
  const imgSrc = typeof img === 'string' ? img : first(img?.url || img?.contentUrl);
  if (imgSrc) r._imageUrls = [new URL(imgSrc, pageUrl || location.href).href];
  r.source = pageUrl || s.url || '';
  return normalize({ ...r, _imageUrls: r._imageUrls });
}

function recipesFromJson(data) {
  ldIds = new Map();
  if (data && data.app === 'rezeptsammlung' && Array.isArray(data.recipes)) return data.recipes.map(x => ({ ...normalize(x), _imageData: x._imageData, _own: true }));
  const ld = findLdRecipes(data);
  if (ld.length) return ld.map(s => fromSchema(s));
  const arr = [].concat(data || []).filter(x => x && typeof x === 'object' && (x.title || x.name));
  return arr.map(x => {
    const r = normalize({ ...x, title: x.title || x.name });
    if (Array.isArray(x.ingredients)) r.ingredients = x.ingredients.map(i => typeof i === 'string' ? i : [i.amount, i.unit, i.name].filter(Boolean).join(' ')).join('\n');
    if (Array.isArray(x.steps || x.instructions)) r.steps = (x.steps || x.instructions).map(i => typeof i === 'string' ? i : i.text).join('\n');
    return { ...r, _imageData: x._imageData, _own: !!x.id };
  });
}

function recipesFromHtml(html, pageUrl) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const found = [];
  ldIds = new Map();
  $$('script[type="application/ld+json"]', doc).forEach(s => {
    try { findLdRecipes(JSON.parse(s.textContent.trim())).forEach(x => found.push(x)); } catch { /* ungültiges JSON-LD */ }
  });
  if (found.length) return found.map(s => fromSchema(s, pageUrl));
  // Fallback: Mikrodaten (itemprop)
  const md = $('[itemtype*="schema.org/Recipe"]', doc);
  if (md) {
    const get = p => $$(`[itemprop="${p}"]`, md).map(e => (e.getAttribute('content') || e.textContent).trim());
    return [fromSchema({ name: get('name')[0], description: get('description')[0], recipeIngredient: get('recipeIngredient').concat(get('ingredients')),
      recipeInstructions: get('recipeInstructions').join('\n'), recipeYield: get('recipeYield')[0], prepTime: get('prepTime')[0], cookTime: get('cookTime')[0],
      image: $('[itemprop="image"]', md)?.getAttribute('src') || $('[itemprop="image"]', md)?.getAttribute('content') }, pageUrl)];
  }
  return [];
}

function recipesFromAnyText(text, name = '') {
  const t = String(text).trim();
  if (!t) return [];
  if (/^[[{]/.test(t)) { try { return recipesFromJson(JSON.parse(t)); } catch { /* doch kein JSON */ } }
  if (/\.html?$/i.test(name) || /^<!doctype|<html|<script/i.test(t)) {
    const r = recipesFromHtml(t);
    if (r.length) return r;
    const doc = new DOMParser().parseFromString(t, 'text/html');
    return [parseRecipeText(doc.body.innerText || doc.body.textContent || '')];
  }
  return t.split(/^\s*={3,}\s*$/m).map(s => s.trim()).filter(Boolean).map(parseRecipeText);
}

async function materializeImages(r) {
  const out = { ...r, images: [...(r.images || [])] };
  for (const data of r._imageData || []) {
    try { out.images.push(await storeImage(data)); } catch (e) { toast('Bild übersprungen: ' + e.message, true); }
  }
  for (const url of r._imageUrls || []) {
    try {
      // Ohne Server direkt laden – klappt nur, wenn die Bildquelle das erlaubt (CORS)
      if (LOCAL) out.images.push(await storeImage(await blobToDataUrl(url).catch(() => { throw new Error('Die Webseite erlaubt das Laden des Bildes nicht.'); })));
      else out.images.push((await api('import_image_url', { body: { url } })).file);
    } catch (e) { toast('Bild übersprungen: ' + e.message, true); }
  }
  out.images = uniq(out.images);
  delete out._imageData; delete out._imageUrls; delete out._own;
  return out;
}

// ================= Import-Ansicht =================

const CLAUDE_PROMPT = `Bitte schreibe das Rezept genau in diesem Format, damit ich es in meine Rezeptsammlung importieren kann (ohne Einleitung, ohne Tabelle):

# Rezeptname
Kurze Beschreibung in ein bis zwei Sätzen.

Kategorie: Hauptgericht
Stichworte: vegetarisch, schnell
Portionen: 4
Vorbereitung: 15 Min.
Kochzeit: 30 Min.
Schwierigkeit: einfach

## Zutaten
- 500 g Zutat
### Für die Sauce
- 200 ml Zutat

## Zubereitung
1. Erster Schritt.
2. Zweiter Schritt.

## Tipps
- Tipp oder Variante

Wenn es mehrere Rezepte sind, trenne sie jeweils durch eine Zeile mit ===`;

function renderImport() {
  const tab = state.importTab;
  app.innerHTML = `<h1>Rezepte importieren</h1>
    <div class="tabs" id="tabs">
      ${[['text', 'Text einfügen'], ['photo', '📷 Foto'], ['file', 'Datei'], ['url', 'Webseite'], ['claude', 'Tipp: Rezepte von Claude']].filter(([k]) => !(LOCAL && k === 'url')).map(([k, l]) => `<button data-tab="${k}" class="${tab === k ? 'on' : ''}">${l}</button>`).join('')}
    </div>
    <div class="card" id="tabBody"></div>
    <div id="importResults"></div>`;
  $('#tabs').onclick = e => { const b = e.target.closest('[data-tab]'); if (b) { state.importTab = b.dataset.tab; renderImport(); } };
  const body = $('#tabBody');

  if (tab === 'text') {
    body.innerHTML = `<p class="hint" style="margin-top:0">Rezepttext einfügen – z. B. aus einem Chat mit Claude, einer E-Mail, einem Word-Dokument oder einer Webseite. Titel, Zutaten, Zubereitung, Portionen und Zeiten werden automatisch erkannt. Mehrere Rezepte durch eine Zeile mit <b>===</b> trennen.</p>
      <textarea id="impText" rows="14" placeholder="# Spaghetti Carbonara&#10;&#10;Portionen: 2&#10;&#10;## Zutaten&#10;- 200 g Spaghetti&#10;- 100 g Guanciale&#10;…&#10;&#10;## Zubereitung&#10;1. Nudeln kochen …"></textarea>
      <div class="btn-row" style="margin-top:12px"><button class="btn primary" id="impParse">Rezept erkennen</button></div>`;
    $('#impParse').onclick = () => showImportResults(recipesFromAnyText($('#impText').value));
  }
  if (tab === 'file') {
    body.innerHTML = `<p class="hint" style="margin-top:0">Unterstützt: Sicherungen dieser App (.json), Rezeptdateien im schema.org-Format (.json), gespeicherte Webseiten (.html) und Textdateien (.txt, .md).</p>
      <input type="file" id="impFile" multiple accept=".json,.txt,.md,.markdown,.html,.htm,application/json,text/*">
      <label class="check" style="margin-top:12px"><input type="checkbox" id="impOverwrite" checked> Rezepte aus einer Sicherung dieser App überschreiben vorhandene mit gleicher ID (Wiederherstellung)</label>`;
    $('#impFile').onchange = async e => {
      const all = [];
      for (const f of e.target.files) {
        try { all.push(...recipesFromAnyText(await f.text(), f.name)); } catch (err) { toast(`${f.name}: ${err.message}`, true); }
      }
      showImportResults(all);
    };
  }
  if (tab === 'url') {
    body.innerHTML = `<p class="hint" style="margin-top:0">Adresse einer Rezeptseite eingeben (z. B. Chefkoch, Lecker, Essen & Trinken, BBC Good Food …). Funktioniert bei allen Seiten, die ihre Rezepte maschinenlesbar anbieten – das sind die meisten großen Rezeptseiten. Das NAS braucht dafür Internetzugang.</p>
      <form id="urlForm" style="display:flex;gap:8px"><input type="url" id="impUrl" placeholder="https://www.chefkoch.de/rezepte/…" required><button class="btn primary">Laden</button></form>`;
    $('#urlForm').onsubmit = async e => {
      e.preventDefault();
      const url = $('#impUrl').value.trim();
      $('#importResults').innerHTML = '<div class="loading">Seite wird geladen …</div>';
      try {
        const { html } = await api('fetch_url', { params: { url } });
        const found = recipesFromHtml(html, url);
        if (!found.length) throw new Error('Auf dieser Seite wurde kein Rezept erkannt. Tipp: Rezepttext markieren, kopieren und unter „Text einfügen“ einfügen.');
        showImportResults(found);
      } catch (err) { $('#importResults').innerHTML = ''; toast(err.message, true); }
    };
  }
  if (tab === 'photo') renderPhotoImport(body);
  if (tab === 'claude') {
    body.innerHTML = `<p style="margin-top:0">Rezepte, die du mit Claude erstellt hast, kannst du einfach aus dem Chat kopieren und unter <b>„Text einfügen“</b> einfügen – die übliche Darstellung mit Überschriften, Zutatenliste und nummerierten Schritten wird erkannt.</p>
      <p>Am zuverlässigsten klappt es, wenn du Claude bittest, das Rezept in diesem Format auszugeben:</p>
      <pre class="code">${esc(CLAUDE_PROMPT)}</pre>
      <button class="btn" id="copyPrompt">${icon('copy')} Anweisung kopieren</button>`;
    $('#copyPrompt').onclick = () => copyText(CLAUDE_PROMPT);
  }
  if (state.importResults.length) drawImportResults();
}

// ---------- Rezept vom Foto (Claude liest Kochbuchseite, Rezeptkarte, Screenshot) ----------

const photoState = { images: [] };   // verkleinerte Fotos als data-URL

function renderPhotoImport(body) {
  const problem = state.status?.ai;
  body.innerHTML = `<p class="hint" style="margin-top:0">Kochbuchseite, Zeitschrift, handgeschriebene Rezeptkarte oder Screenshot fotografieren – ${esc(aiName())} liest das Rezept ab und gliedert es in Titel, Zutaten und Schritte. Geht das Rezept über mehrere Seiten, einfach mehrere Fotos aufnehmen (bis zu 5).</p>
    ${problem ? `<p class="status-bad">${esc(problem)}${LOCAL ? ' <a href="#/settings">Einrichten →</a>' : ''}</p>` : ''}
    <div class="img-grid" id="photoGrid"></div>
    <input type="file" id="photoCam" accept="image/*" capture="environment" hidden>
    <input type="file" id="photoPick" accept="image/*" multiple hidden>
    <label class="field" style="margin-top:12px"><span>Hinweis (optional)</span><input type="text" id="photoHint" placeholder="z. B. nur das Rezept unten rechts · Mengen für 4 Personen"></label>
    <label class="check" style="margin:8px 0 12px"><input type="checkbox" id="photoKeep"> Erstes Foto als Rezeptbild übernehmen</label>
    <div class="btn-row"><button class="btn primary" id="photoGo" ${problem ? 'disabled' : ''}>✨ Rezept erkennen</button></div>
    <p class="hint">Dauert meist 20–60 Sekunden${LOCAL ? '' : ' und kostet je nach Fotoanzahl wenige Cent. Funktioniert nur zu Hause (über das NAS)'}. Tipp: Seite gerade, formatfüllend und hell fotografieren.</p>`;
  const draw = () => {
    $('#photoGrid').innerHTML = photoState.images.map((d, i) => `<div class="img-item"><img src="${d}" alt=""><div class="ctl"><span>Seite ${i + 1}</span><button type="button" data-del="${i}">Entfernen</button></div></div>`).join('') +
      (photoState.images.length < 5 ? `<button type="button" class="img-add" id="photoCamBtn">📷<br>Foto aufnehmen</button><button type="button" class="img-add" id="photoPickBtn">${icon('image')}<br>Aus Galerie</button>` : '');
  };
  draw();
  const add = async files => {
    for (const f of files) {
      if (!f.type.startsWith('image/') || photoState.images.length >= 5) continue;
      try { photoState.images.push(await resizeImage(f, 2000, .85)); } catch (e) { toast(e.message, true); }
    }
    draw();
  };
  $('#photoGrid').onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.id === 'photoCamBtn') $('#photoCam').click();
    if (b.id === 'photoPickBtn') $('#photoPick').click();
    if (b.dataset.del) { photoState.images.splice(+b.dataset.del, 1); draw(); }
  };
  $('#photoCam').onchange = $('#photoPick').onchange = e => { add([...e.target.files]); e.target.value = ''; };
  $('#photoGo').onclick = async e => {
    if (!photoState.images.length) return toast('Bitte zuerst ein Foto aufnehmen oder auswählen', true);
    e.target.disabled = true;
    $('#importResults').innerHTML = `<div class="loading">${esc(aiName())} liest das Rezept … (20–60 Sekunden)</div>`;
    try {
      const { recipe } = await aiRequest('photo', { images: photoState.images, hint: $('#photoHint').value });
      const r = normalize({ ...recipe, tags: recipe.tags || [] });
      if (!r.source) r.source = 'Foto';
      if ($('#photoKeep').checked) r._imageData = [photoState.images[0]];
      photoState.images = [];
      showImportResults([r]);
      draw();
    } catch (err) { $('#importResults').innerHTML = ''; toast(err.message, true); }
    e.target.disabled = false;
  };
}

function showImportResults(list) {
  if (!list.length) { toast('Kein Rezept erkannt', true); return; }
  state.importResults = list.map(r => ({ r, saved: false }));
  drawImportResults();
  $('#importResults').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function drawImportResults() {
  const box = $('#importResults');
  const existing = new Set(state.recipes.map(r => fold(r.title)));
  const items = state.importResults;
  box.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;margin-top:24px;gap:8px;flex-wrap:wrap">
      <h2 style="margin:0">${items.length} ${items.length === 1 ? 'Rezept' : 'Rezepte'} erkannt</h2>
      ${items.length > 1 ? `<button class="btn primary" id="saveAll">${icon('check')} Alle speichern</button>` : ''}
    </div>
    <div class="preview-list">${items.map(({ r, saved }, i) => `
      <div class="card preview ${saved ? 'saved' : ''}">
        <div class="info"><b>${esc(r.title)}</b>
          <small>${lines(r.ingredients).filter(l => !isSection(l)).length} Zutaten · ${lines(r.steps).filter(l => !isSection(l)).length} Schritte${r.servings ? ` · ${fmtNum(r.servings)} ${esc(r.servingsUnit)}` : ''}${totalTime(r) ? ' · ' + fmtTime(totalTime(r)) : ''}${(r._imageUrls || r._imageData || []).length ? ' · mit Bild' : ''}</small>
          ${!saved && existing.has(fold(r.title)) && !r._own ? '<small class="status-bad">Ein Rezept mit diesem Namen gibt es schon.</small>' : ''}
        </div>
        <div class="btn-row">${saved ? `<a class="btn small" href="#/r/${encodeURIComponent(saved)}">Ansehen</a>` :
          `<button class="btn small" data-edit="${i}">${icon('edit')} Prüfen &amp; bearbeiten</button><button class="btn small primary" data-save="${i}">Direkt speichern</button>`}</div>
      </div>`).join('')}</div>`;

  const saveOne = async i => {
    const item = items[i];
    let r = await materializeImages(item.r);
    const overwrite = $('#impOverwrite') ? $('#impOverwrite').checked : true;
    if (!(item.r._own && overwrite)) r.id = '';
    const saved = await saveRecipe(r);
    item.saved = saved.id;
  };
  box.onclick = async e => {
    const b = e.target.closest('button'); if (!b) return;
    b.disabled = true;
    try {
      if (b.dataset.save) { await saveOne(+b.dataset.save); toast('Gespeichert'); }
      if (b.dataset.edit) {
        const item = items[+b.dataset.edit];
        toast('Wird vorbereitet …');
        const r = await materializeImages(item.r);
        r.id = '';
        state.draft = r;
        item.saved = 'pending';
        state.importResults = items.filter(x => x !== item);
        location.hash = '#/new';
        return;
      }
      if (b.id === 'saveAll') {
        let n = 0;
        for (let i = 0; i < items.length; i++) if (!items[i].saved) { b.textContent = `Speichere ${++n} …`; await saveOne(i); }
        toast(`${n} Rezepte gespeichert`);
      }
    } catch (err) { toast(err.message, true); }
    drawImportResults();
  };
}

// ================= Export =================

const safeName = s => fold(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'rezept';

async function blobToDataUrl(url) {
  const blob = await (await fetch(url)).blob();
  return new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(blob); });
}

async function exportRecipes(list, withImages, name) {
  toast('Export wird erstellt …');
  const recipes = [];
  for (const r of list) {
    const c = { ...r };
    if (withImages && r.images.length) {
      c._imageData = [];
      for (const f of r.images) { try { c._imageData.push(await blobToDataUrl(imgUrl(f))); } catch { /* fehlendes Bild */ } }
    }
    recipes.push(c);
  }
  download(`${name}.json`, JSON.stringify({ app: 'rezeptsammlung', version: 1, exported: new Date().toISOString(), recipes }, null, 1));
  toast('Export fertig');
}

// ================= KI direkt beim Anbieter (Fassung ohne Server) =================
// Ohne NAS ruft die App Claude, Gemini oder ChatGPT selbst auf – mit dem Schlüssel, den der Nutzer unter
// „Mehr → KI-Assistent“ einträgt. Er bleibt nur auf diesem Gerät (localStorage).

const AI_PROVIDERS = {
  gemini: { name: 'Gemini', company: 'Google', keyUrl: 'https://aistudio.google.com/apikey', model: 'gemini-2.5-flash',
    note: 'Kostenlose Stufe mit Tageslimit. Achtung: In der kostenlosen Stufe darf Google Eingaben zur Verbesserung seiner Dienste verwenden.' },
  claude: { name: 'Claude', company: 'Anthropic', keyUrl: 'https://console.anthropic.com/settings/keys', model: 'claude-sonnet-5-5',
    note: 'Kostenpflichtig (Guthaben aufladen), meist wenige Cent pro Rezept.' },
  openai: { name: 'ChatGPT', company: 'OpenAI', keyUrl: 'https://platform.openai.com/api-keys', model: '',
    note: 'Kostenpflichtig (Guthaben aufladen), meist wenige Cent pro Rezept.' },
};
const aiCfg = () => ({ provider: 'gemini', key: '', model: '', ...store.get('ai', {}) });
const aiName = () => LOCAL ? AI_PROVIDERS[aiCfg().provider]?.name || 'KI' : 'Claude';
const localStatus = () => ({ writable: true, bring: false, ai: aiCfg().key ? '' : 'Noch kein KI-Schlüssel eingetragen – unter „Mehr → KI-Assistent“ einrichten.' });

const CATS_AI = ['Frühstück', 'Vorspeise', 'Suppe', 'Salat', 'Hauptgericht', 'Beilage', 'Sauce & Dip', 'Dessert', 'Kuchen & Torten', 'Gebäck', 'Brot', 'Snack', 'Getränk', 'Grundrezept'];
function aiSchema(photo) {
  const p = {
    title: { type: 'string', description: 'Appetitlicher Rezeptname' },
    description: { type: 'string', description: 'Ein bis zwei Sätze, was das Gericht ausmacht' },
    category: { type: 'string', enum: CATS_AI },
    tags: { type: 'array', items: { type: 'string' }, description: '2 bis 5 kurze Stichworte, z. B. vegetarisch, schnell' },
    servings: { type: 'integer' },
    servingsUnit: { type: 'string', description: 'Meist "Portionen", bei Gebäck z. B. "Stück"' },
    prepTime: { type: 'integer', description: 'Aktive Vorbereitungszeit in Minuten' },
    cookTime: { type: 'integer', description: 'Koch- oder Backzeit in Minuten' },
    restTime: { type: 'integer', description: 'Ruhe-/Wartezeit in Minuten, sonst 0' },
    difficulty: { type: 'string', enum: ['einfach', 'mittel', 'schwer'] },
    ingredients: { type: 'array', items: { type: 'string' }, description: 'Eine Zutat pro Eintrag, Menge und Einheit vorne ("200 g Spaghetti"). Zwischenüberschriften als "# Für die Sauce".' },
    steps: { type: 'array', items: { type: 'string' }, description: 'Ein Arbeitsschritt pro Eintrag, ohne Nummerierung, mit konkreten Zeiten und Temperaturen' },
    notes: { type: 'string', description: 'Tipps, Varianten, passende Beilagen' },
  };
  if (photo) {
    p.found = { type: 'boolean', description: 'false, wenn auf den Bildern kein Rezept zu erkennen ist' };
    p.source = { type: 'string', description: 'Quelle, falls auf dem Bild erkennbar (Buchtitel, Autor, Seitenzahl), sonst leer' };
  } else {
    p.missing = { type: 'array', items: { type: 'string' }, description: 'Zutaten, die NICHT in der Liste des Nutzers stehen und keine Grundvorräte sind (zum Einkaufen). Leer, wenn nichts fehlt.' };
  }
  return { type: 'object', properties: p, required: Object.keys(p), additionalProperties: false };
}

const AI_SYSTEM_RECIPE = 'Du bist ein erfahrener, kreativer Koch und schreibst alltagstaugliche Rezepte für eine private deutsche Rezeptsammlung. '
  + 'Du bekommst eine Liste von Zutaten, die im Haushalt vorhanden sind, und entwickelst daraus EIN stimmiges, wirklich leckeres Gericht. '
  + 'Nutze möglichst viele der vorhandenen Zutaten sinnvoll, aber erzwinge keine Kombinationen, die nicht zusammenpassen – lieber eine Zutat weglassen. '
  + 'Schreibe auf Deutsch, mit metrischen Mengen (g, ml, EL, TL, Stück) und realistischen Zeiten. '
  + 'Die Schritte sind klar und so konkret, dass auch ungeübte Köche sie umsetzen können (Hitzestufe, Garzeit, woran man erkennt, dass etwas fertig ist).';
const AI_SYSTEM_PHOTO = 'Du überträgst Rezepte von Fotos (Kochbuchseiten, handgeschriebene Rezeptkarten, Zeitschriften, Screenshots) in eine private deutsche Rezeptsammlung. '
  + 'Gib das Rezept so originalgetreu wie möglich wieder: Mengen, Zutaten, Reihenfolge und Arbeitsschritte nicht verändern und nichts erfinden. '
  + 'Erlaubt sind nur: Handschrift und Abkürzungen sauber ausschreiben, offensichtliche Lesefehler korrigieren, Zutaten im Format "Menge Einheit Zutat" schreiben, '
  + 'lange Absätze in einzelne Arbeitsschritte aufteilen und fremdsprachige Rezepte ins Deutsche übersetzen. '
  + 'Unleserliche Stellen mit [?] kennzeichnen. Fehlende Angaben (Portionen, Zeiten, Schwierigkeit, Kategorie, Stichworte) sinnvoll schätzen. '
  + 'Steht ein Rezept auf mehreren Bildern, füge es zu einem Rezept zusammen. Sind mehrere Rezepte zu sehen, nimm das vollständigste bzw. das, auf das der Hinweis des Nutzers passt. '
  + 'Unter "notes" gehören Tipps und Varianten aus der Vorlage; ergänze dort keine eigenen.';

// Gleicher Inhalt wie ai_recipe() in ai.php
function aiRecipePrompt(f) {
  const p = ['Vorhandene Zutaten:\n' + String(f.ingredients).slice(0, 2000), '', 'Portionen: ' + Math.max(1, Math.min(20, +f.servings || 2))];
  if (+f.maxTime) p.push(`Gesamtzeit höchstens: ${+f.maxTime} Minuten`);
  if (f.diet) p.push('Ernährungsweise: ' + f.diet);
  if (f.course) p.push('Art des Gerichts: ' + f.course);
  if (f.difficulty) p.push('Schwierigkeit: ' + f.difficulty);
  p.push(f.pantry !== false
    ? 'Grundvorräte sind vorhanden und dürfen frei verwendet werden: Salz, Pfeffer, Zucker, Öl, Butter, Mehl, Essig, Senf, Brühe, gängige getrocknete Kräuter und Gewürze.'
    : 'Es sind keine Grundvorräte vorhanden außer Salz und Pfeffer.');
  p.push(f.strict
    ? 'Verwende ausschließlich die vorhandenen Zutaten (plus erlaubte Grundvorräte). Nichts zusätzlich einkaufen.'
    : 'Höchstens zwei bis drei kleine Zutaten dürfen zusätzlich nötig sein, wenn das Gericht dadurch deutlich besser wird – trage sie dann unter "missing" ein.');
  if (f.wishes) p.push('Besondere Wünsche: ' + String(f.wishes).slice(0, 600));
  if ((f.avoid || []).length) p.push('Bereits vorgeschlagen (bitte etwas deutlich anderes): ' + f.avoid.slice(0, 10).join('; '));
  return p.join('\n');
}

// Antworttext → JSON (auch wenn ein Modell ```json … ``` drumherum schreibt)
function parseAiJson(text) {
  const t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { const d = JSON.parse(t); if (d && typeof d === 'object') return d; } catch { /* unten */ }
  const m = t.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* unten */ } }
  throw new Error('Die KI hat kein lesbares Rezept geliefert – bitte erneut versuchen.');
}

async function aiFetch(url, opt, provider) {
  let res, data;
  try { res = await fetch(url, opt); }
  catch { throw new Error('Keine Internetverbindung zur KI.'); }
  try { data = await res.json(); } catch { data = {}; }
  if (!res.ok) {
    const msg = data.error?.message || data.message || '';
    if (res.status === 401 || res.status === 403 || /api key|api_key|unauthori[sz]ed|permission/i.test(msg) && res.status === 400)
      throw new Error(`Der ${AI_PROVIDERS[provider].name}-Schlüssel ist ungültig (Mehr → KI-Assistent).`);
    if (res.status === 429) throw new Error(`Limit von ${AI_PROVIDERS[provider].name} erreicht (zu viele Anfragen oder Guthaben aufgebraucht). Bitte später erneut versuchen.`);
    if (res.status === 404) throw new Error(`Das Modell „${aiCfg().model}“ gibt es bei ${AI_PROVIDERS[provider].name} nicht (mehr) – unter Mehr → KI-Assistent ein anderes wählen.`);
    throw new Error(`${AI_PROVIDERS[provider].name}-Fehler: ${msg || 'HTTP ' + res.status}`);
  }
  return data;
}

// Ein Aufruf mit System-Anweisung, Text, optional Bildern (data-URLs) – liefert das Rezept-Objekt
async function aiDirect(system, text, images, schema) {
  const { provider, key, model: m } = aiCfg();
  const P = AI_PROVIDERS[provider];
  if (!key) throw new Error(localStatus().ai);
  const model = m || P.model;
  const imgs = (images || []).map(d => { const [, type, data] = d.match(/^data:([^;]+);base64,(.*)$/) || []; return { d, type, data }; });
  // Gemini/ChatGPT bekommen das Schema als Text (robust über alle Modelle), Claude als echte Strukturvorgabe
  const withSchema = system + '\n\nAntworte ausschließlich mit einem einzigen JSON-Objekt nach diesem JSON-Schema, ohne weiteren Text:\n' + JSON.stringify(schema);
  if (provider === 'claude') {
    const d = await aiFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
      body: JSON.stringify({
        model, max_tokens: 16000, system,
        messages: [{ role: 'user', content: [...imgs.map(i => ({ type: 'image', source: { type: 'base64', media_type: i.type, data: i.data } })), { type: 'text', text }] }],
        output_config: { format: { type: 'json_schema', schema } },
      }),
    }, provider);
    if (d.stop_reason === 'refusal') throw new Error('Claude hat diese Anfrage abgelehnt.');
    if (d.stop_reason === 'max_tokens') throw new Error('Die Antwort wurde zu lang und abgeschnitten – bitte erneut versuchen.');
    return parseAiJson((d.content || []).find(b => b.type === 'text')?.text);
  }
  if (provider === 'gemini') {
    const d = await aiFetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model.replace(/^models\//, ''))}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: withSchema }] },
        contents: [{ role: 'user', parts: [...imgs.map(i => ({ inline_data: { mime_type: i.type, data: i.data } })), { text }] }],
        generationConfig: { responseMimeType: 'application/json' },
      }),
    }, provider);
    const c = d.candidates?.[0];
    if (!c) throw new Error('Gemini hat die Anfrage abgelehnt' + (d.promptFeedback?.blockReason ? ` (${d.promptFeedback.blockReason})` : '') + '.');
    if (c.finishReason === 'MAX_TOKENS') throw new Error('Die Antwort wurde zu lang und abgeschnitten – bitte erneut versuchen.');
    return parseAiJson((c.content?.parts || []).map(p => p.text || '').join(''));
  }
  const d = await aiFetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: withSchema },
        { role: 'user', content: [{ type: 'text', text }, ...imgs.map(i => ({ type: 'image_url', image_url: { url: i.d } }))] }],
      response_format: { type: 'json_object' },
    }),
  }, provider);
  const msg = d.choices?.[0]?.message;
  if (msg?.refusal) throw new Error('ChatGPT hat diese Anfrage abgelehnt.');
  return parseAiJson(msg?.content);
}

// Verfügbare Modelle beim Anbieter abfragen (kostenlos) und ein passendes vorschlagen
async function aiListModels(provider, key) {
  const ver = id => (id.match(/(\d+(?:[.-]\d+)?)/) || [0, '0'])[1].replace('-', '.');
  const newest = list => list.sort((a, b) => parseFloat(ver(b)) - parseFloat(ver(a)) || a.length - b.length);
  if (provider === 'gemini') {
    const d = await aiFetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': key } }, provider);
    const ids = (d.models || []).filter(m => (m.supportedGenerationMethods || []).includes('generateContent')).map(m => m.name.replace(/^models\//, ''))
      .filter(id => /^gemini-/.test(id) && !/tts|image|embedding|live|audio|thinking|exp/i.test(id));
    const flash = newest(ids.filter(id => /^gemini-[\d.]+-flash$/.test(id)));
    return { ids, pick: flash[0] || newest(ids.filter(id => /flash/.test(id) && !/lite/.test(id)))[0] || ids[0] };
  }
  if (provider === 'openai') {
    const d = await aiFetch('https://api.openai.com/v1/models', { headers: { authorization: 'Bearer ' + key } }, provider);
    const ids = (d.data || []).map(m => m.id).filter(id => /^(gpt-|o\d)/.test(id) && !/audio|realtime|transcribe|tts|image|search|codex|instruct|\d{4}-\d{2}-\d{2}/.test(id));
    const mini = newest(ids.filter(id => /^gpt-[\d.]+-mini$/.test(id)));
    return { ids, pick: mini[0] || newest(ids.filter(id => /^gpt-[\d.]+$/.test(id)))[0] || ids[0] };
  }
  const d = await aiFetch('https://api.anthropic.com/v1/models?limit=100', { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' } }, provider);
  const ids = (d.data || []).map(m => m.id);
  return { ids, pick: ids.find(id => /sonnet/.test(id)) || ids[0] };
}

// Einheitlicher Einstieg: mit NAS über den Server (Claude), ohne Server direkt beim gewählten Anbieter
async function aiRequest(kind, body) {
  if (!LOCAL) return api(kind === 'photo' ? 'ai_photo' : 'ai_recipe', { body });
  if (kind === 'photo') {
    const recipe = await aiDirect(AI_SYSTEM_PHOTO,
      `Bitte übertrage das Rezept von ${body.images.length > 1 ? `diesen ${body.images.length} Bildern` : 'diesem Bild'}.` + (body.hint ? '\nHinweis: ' + String(body.hint).slice(0, 300) : ''),
      body.images.slice(0, 5), aiSchema(true));
    if (recipe.found === false || !String(recipe.title || '').trim()) throw new Error('Auf dem Foto wurde kein Rezept erkannt. Tipp: Seite gerade und gut beleuchtet fotografieren.');
    delete recipe.found;
    return { recipe };
  }
  const recipe = await aiDirect(AI_SYSTEM_RECIPE, aiRecipePrompt(body), [], aiSchema(false));
  if (!String(recipe.title || '').trim()) throw new Error('Die KI hat kein lesbares Rezept geliefert – bitte erneut versuchen.');
  return { recipe };
}

// ================= Rezept aus vorhandenen Zutaten (Claude API) =================

const aiState = { form: store.get('aiForm', { ingredients: '', servings: 2, maxTime: 0, diet: '', course: '', difficulty: '', pantry: true, strict: false, wishes: '' }), recipe: null, seen: [], savedId: '', busy: false };

function aiToRecipe(d, form) {
  return normalize({
    title: d.title, description: d.description, category: d.category,
    tags: uniq([...(d.tags || []), 'KI-Rezept']), servings: d.servings, servingsUnit: d.servingsUnit,
    prepTime: d.prepTime, cookTime: d.cookTime, restTime: d.restTime, difficulty: d.difficulty,
    ingredients: (d.ingredients || []).map(l => stripBullet(String(l))).join('\n'),
    steps: (d.steps || []).map(l => stripNumber(String(l))).join('\n'),
    notes: [d.notes, (d.missing || []).length ? 'Zusätzlich benötigt: ' + d.missing.join(', ') : ''].filter(Boolean).join('\n\n'),
    source: `Mit ${aiName()} erstellt aus: ` + form.ingredients.replace(/\s*\n\s*/g, ', ').slice(0, 300),
  });
}

function renderAi() {
  const f = aiState.form, problem = state.status?.ai;
  const opt = (v, label, cur) => `<option value="${esc(v)}" ${String(cur) === String(v) ? 'selected' : ''}>${esc(label)}</option>`;
  app.innerHTML = `<h1>✨ Was koche ich heute?</h1>
    <p class="hint" style="margin-top:-6px">Gib ein, was du im Kühlschrank und Vorrat hast – ${esc(aiName())} erstellt daraus ein passendes Rezept, das du in deine Sammlung übernehmen kannst.</p>
    ${problem ? `<div class="card ai-warn"><b>Noch nicht eingerichtet:</b> ${esc(problem)}<br><span class="hint">${LOCAL ? '<a href="#/settings">Jetzt einrichten →</a>' : 'Siehe Anleitung, Abschnitt „Rezept aus Zutaten (Claude)“.'}</span></div>` : ''}
    <form class="card editor" id="aiForm" autocomplete="off">
      <label class="field"><span>Vorhandene Zutaten</span>
        <textarea name="ingredients" rows="4" required placeholder="z. B. 2 Zucchini, 200 g Feta, Reste vom Reis, 3 Eier, Dose Tomaten, Frühlingszwiebeln">${esc(f.ingredients)}</textarea></label>
      <div class="grid2">
        <label class="field"><span>Portionen</span><input type="number" name="servings" min="1" max="20" value="${esc(f.servings)}"></label>
        <label class="field"><span>Zeit höchstens</span><select name="maxTime">${opt(0, 'egal', f.maxTime)}${[20, 30, 45, 60, 90].map(m => opt(m, fmtTime(m), f.maxTime)).join('')}</select></label>
        <label class="field"><span>Ernährung</span><select name="diet">${['', 'vegetarisch', 'vegan', 'glutenfrei', 'laktosefrei', 'Low Carb', 'mit Fleisch oder Fisch'].map(v => opt(v, v || 'egal', f.diet)).join('')}</select></label>
        <label class="field"><span>Art</span><select name="course">${['', 'Frühstück', 'Hauptgericht', 'Suppe', 'Salat', 'Snack', 'Dessert', 'Kuchen / Gebäck'].map(v => opt(v, v || 'egal', f.course)).join('')}</select></label>
        <label class="field"><span>Schwierigkeit</span><select name="difficulty">${['', 'einfach', 'mittel'].map(v => opt(v, v || 'egal', f.difficulty)).join('')}</select></label>
      </div>
      <label class="check"><input type="checkbox" name="pantry" ${f.pantry ? 'checked' : ''}> Grundvorräte vorhanden (Salz, Pfeffer, Öl, Butter, Mehl, Zucker, Gewürze, Brühe)</label>
      <label class="check"><input type="checkbox" name="strict" ${f.strict ? 'checked' : ''}> Nur diese Zutaten verwenden – nichts dazukaufen</label>
      <label class="field"><span>Besondere Wünsche (optional)</span><input type="text" name="wishes" value="${esc(f.wishes)}" placeholder="z. B. etwas Asiatisches, kindertauglich, ohne Backofen"></label>
      <div class="btn-row"><button class="btn primary" id="aiGo" ${problem ? 'disabled' : ''}>✨ Rezept erstellen</button></div>
    </form>
    <div id="aiOut"></div>`;

  const form = $('#aiForm');
  const readForm = () => {
    const fd = new FormData(form);
    aiState.form = {
      ingredients: String(fd.get('ingredients') || '').trim(), servings: +fd.get('servings') || 2, maxTime: +fd.get('maxTime') || 0,
      diet: fd.get('diet'), course: fd.get('course'), difficulty: fd.get('difficulty'),
      pantry: !!fd.get('pantry'), strict: !!fd.get('strict'), wishes: String(fd.get('wishes') || '').trim(),
    };
    store.set('aiForm', aiState.form);
  };
  form.addEventListener('change', readForm);
  form.onsubmit = e => { e.preventDefault(); readForm(); aiState.seen = []; aiGenerate(); };
  if (aiState.recipe) drawAiResult();
}

async function aiGenerate() {
  if (aiState.busy) return;
  if (!aiState.form.ingredients) return toast('Bitte zuerst Zutaten eingeben', true);
  aiState.busy = true;
  const out = $('#aiOut');
  out.innerHTML = `<div class="card ai-loading"><div class="spinner"></div><div><b>${esc(aiName())} überlegt sich ein Rezept …</b><br><span class="hint">Das dauert meist 20–60 Sekunden.</span></div></div>`;
  out.scrollIntoView({ behavior: 'smooth', block: 'start' });
  $$('#aiGo, #aiAgain').forEach(b => { b.disabled = true; });
  try {
    const { recipe } = await aiRequest('recipe', { ...aiState.form, avoid: aiState.seen });
    aiState.recipe = recipe;
    aiState.savedId = '';
    aiState.seen.push(recipe.title);
  } catch (e) {
    out.innerHTML = '';
    toast(e.message, true);
  }
  aiState.busy = false;
  if ($('#aiGo')) $('#aiGo').disabled = !!state.status?.ai;
  if (aiState.recipe && $('#aiOut')) drawAiResult();
}

function drawAiResult() {
  const d = aiState.recipe, r = aiToRecipe(d, aiState.form);
  const missing = d.missing || [];
  const facts = [totalTime(r) && ['Zeit', fmtTime(totalTime(r))], r.servings && [r.servingsUnit, fmtNum(r.servings)], r.difficulty && ['Schwierigkeit', r.difficulty]].filter(Boolean);
  $('#aiOut').innerHTML = `<div class="card ai-result">
      <div class="chips" style="margin-bottom:8px">${r.tags.map(t => `<span class="tag">${esc(t)}</span>`).join(' ')}</div>
      <h2>${esc(r.title)}</h2>
      ${r.description ? `<p class="desc">${esc(r.description)}</p>` : ''}
      ${facts.length ? `<div class="facts">${facts.map(([k, v]) => `<div class="fact"><small>${esc(k)}</small><b>${esc(v)}</b></div>`).join('')}</div>` : ''}
      ${missing.length ? `<p class="ai-missing">🛒 <b>Noch besorgen:</b> ${missing.map(esc).join(', ')}</p>` : '<p class="status-ok">✓ Alles da – nichts einzukaufen.</p>'}
      <div class="recipe-body" style="margin-top:12px">
        <section><h3>Zutaten</h3><ul class="ing-list">${lines(r.ingredients).map(l => isSection(l) ? `<li class="sec">${esc(sectionText(l))}</li>`
          : (({ qty, rest }) => `<li><span class="box"></span><span>${qty ? `<span class="q">${esc(qty)}</span>` : ''}${esc(rest)}</span></li>`)(scaleLine(l, 1))).join('')}</ul></section>
        <section><h3>Zubereitung</h3><ol class="step-list">${renderSteps(r)}</ol></section>
      </div>
      ${d.notes ? `<h3>Tipps</h3><p class="notes">${esc(d.notes)}</p>` : ''}
      <div class="actions">
        ${aiState.savedId ? `<a class="btn primary" href="#/r/${encodeURIComponent(aiState.savedId)}">${icon('check')} Gespeichert – ansehen</a>`
          : `<button class="btn primary" id="aiSave">${icon('check')} In Sammlung speichern</button><button class="btn" id="aiEdit">${icon('edit')} Bearbeiten &amp; speichern</button>`}
        <button class="btn" id="aiAgain">🔄 Anderer Vorschlag</button>
        ${missing.length && state.status?.bring ? `<button class="btn" id="aiBring">🛒 Fehlendes an Bring!</button>` : ''}
        ${missing.length && !state.status?.bring ? `<button class="btn" id="aiShop">${icon('cart')} Fehlendes auf Einkaufsliste</button>` : ''}
      </div>
      <p class="hint">Von ${esc(aiName())} erstellt – Mengen und Garzeiten beim Kochen kurz prüfen.</p>
    </div>`;
  const ai = $('#aiOut');
  ai.onclick = async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.id === 'aiAgain') return aiGenerate();
    if (b.id === 'aiEdit') { state.draft = r; location.hash = '#/new'; return; }
    if (b.id === 'aiBring') { b.disabled = true; if (!(await sendToBring(missing))) b.disabled = false; return; }
    if (b.id === 'aiShop') {
      missing.forEach(text => state.shopping.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), text, done: false, from: r.title }));
      saveShopping(); b.disabled = true; toast(`${missing.length} Zutaten auf die Einkaufsliste gesetzt`);
    }
    if (b.id === 'aiSave') {
      b.disabled = true;
      try { aiState.savedId = (await saveRecipe(r)).id; toast('In der Sammlung gespeichert'); drawAiResult(); }
      catch (err) { toast(err.message, true); b.disabled = false; }
    }
  };
}

// ================= Einstellungen =================

function renderSettings() {
  const s = state.status || {};
  const theme = store.get('theme', 'auto');
  const imgCount = state.recipes.reduce((n, r) => n + r.images.length, 0);
  app.innerHTML = `<h1>Einstellungen &amp; Sicherung</h1><div class="settings">
    <div class="card"><h2>Übersicht</h2>
      <p>${state.recipes.length} Rezepte · ${imgCount} Bilder · ${allCategories().length} Kategorien · ${allTags().length} Stichworte · ${state.recipes.filter(r => r.favorite).length} Favoriten</p>
      ${LOCAL ? `<p>Gespeichert <b>nur auf diesem Gerät</b>. Letzte Sicherung: ${lastBackupText()}</p>` : `<p>Speicher auf dem NAS: ${s.writable ? '<span class="status-ok">beschreibbar ✓</span>' : '<span class="status-bad">nicht beschreibbar – Ordnerrechte von „data“ und „images“ prüfen (siehe Anleitung)</span>'}<br>
      Bring!: ${s.bring ? '<span class="status-ok">eingerichtet ✓</span>' : '<span class="hint">nicht eingerichtet (Zugangsdaten in config.php)</span>'}<br>
      Rezepte aus Zutaten (Claude): ${s.ai ? `<span class="status-bad">${esc(s.ai)}</span>` : '<span class="status-ok">eingerichtet ✓</span>'}<br>
      <small class="hint">PHP ${esc(s.php || '?')} · Webseiten-Import ${s.curl ? 'mit cURL' : 'ohne cURL'}</small></p>`}
    </div>
    ${LOCAL ? `<div class="card"><h2>KI-Assistent</h2>${aiSettingsHtml()}</div>` : `<div class="card"><h2>Offline &amp; Abgleich</h2>${syncInfo()}</div>`}
    <div class="card"><h2>Darstellung</h2>
      <label class="field"><span>Farbschema</span><select id="theme">${[['auto', 'Wie Gerät'], ['light', 'Hell'], ['dark', 'Dunkel']].map(([v, l]) => `<option value="${v}" ${theme === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    </div>
    <div class="card"><h2>Datensicherung</h2>
      ${LOCAL ? '<p class="status-bad" style="margin-top:0">Deine Rezepte liegen nur auf diesem Gerät. Wird die App gelöscht oder geht das Handy verloren, sind sie weg – speichere deshalb regelmäßig eine Sicherung, z. B. in Google Drive oder per Mail an dich selbst.</p>' : ''}
      <p class="hint" style="margin-top:0">Lädt alle Rezepte als eine Datei herunter. Die Datei kann unter „Import → Datei“ wieder eingelesen werden – auch auf einem anderen Gerät oder von Freunden.${LOCAL ? '' : ' Zusätzlich empfiehlt sich, den Ordner der App auf dem NAS regelmäßig mit Hybrid Backup Sync zu sichern.'}</p>
      <div class="btn-row"><button class="btn primary" id="expImg">Sicherung mit Bildern</button><button class="btn" id="expNoImg">Sicherung ohne Bilder (klein)</button></div>
    </div>
    ${LOCAL ? '' : `<div class="card"><h2>Wartung</h2>
      <p class="hint" style="margin-top:0">Entfernt Bilddateien, die zu keinem Rezept mehr gehören (z. B. nach abgebrochenen Bearbeitungen).</p>
      <button class="btn" id="cleanup">Unbenutzte Bilder aufräumen</button>
    </div>`}
    <div class="card"><h2>Tipps</h2>
      <ul class="hint" style="margin:0;padding-left:18px">
        <li>Handy: Seite im Browser öffnen und „Zum Startbildschirm hinzufügen“ – dann startet die Sammlung wie eine App.</li>
        <li>Suche: mehrere Wörter grenzen ein, <b>-wort</b> schließt aus, <b>"genaue Phrase"</b> in Anführungszeichen. Umlaute sind egal (kase findet Käse).</li>
        <li>Am PC springt die Taste <b>/</b> direkt ins Suchfeld.</li>
        <li>Zeitangaben in der Zubereitung („10 Minuten“) antippen startet einen Timer.</li>
      </ul>
    </div>
    <div class="card"><h2>Als App installieren</h2>${installInfo()}</div>
    ${s.auth_required ? `<div class="card"><button class="btn" id="logout">Abmelden</button></div>` : ''}
  </div>`;
  $('#theme').onchange = e => { store.set('theme', e.target.value); applyTheme(); };
  if ($('#syncNow')) $('#syncNow').onclick = () => runSync({ manual: true });
  if ($('#offImg')) $('#offImg').onchange = e => { store.set('offlineImages', e.target.checked); if (e.target.checked) prefetchImages().then(() => renderSettings()); };
  if (LOCAL) bindAiSettings();
  $('#expImg').onclick = async () => { await exportRecipes(state.recipes, true, 'rezepte-sicherung-' + today()); store.set('lastBackup', Date.now()); };
  $('#expNoImg').onclick = () => exportRecipes(state.recipes, false, 'rezepte-sicherung-ohne-bilder-' + today());
  if ($('#cleanup')) $('#cleanup').onclick = async () => {
    try { const { removed } = await api('cleanup_images', { body: {} }); toast(`${removed} unbenutzte Bilder entfernt`); } catch (e) { toast(e.message, true); }
  };
  if ($('#installHere')) $('#installHere').onclick = installApp;
  if ($('#logout')) $('#logout').onclick = async () => { await api('logout', { body: {} }).catch(() => {}); location.reload(); };
}

function lastBackupText() {
  const t = store.get('lastBackup', 0);
  return t ? new Date(t).toLocaleDateString('de-DE') : '<span class="status-bad">noch nie</span>';
}

function modelOpts(c) {
  const known = store.get('aiModels', {});
  const ids = known.provider === c.provider && known.ids?.length ? known.ids : [];
  if (!ids.length) return `<option value="${esc(c.model)}">${esc(c.model || 'automatisch wählen (nach dem Prüfen)')}</option>`;
  return uniq([c.model, ...ids].filter(Boolean)).map(id => `<option ${id === c.model ? 'selected' : ''}>${esc(id)}</option>`).join('');
}

function aiSettingsHtml() {
  const c = aiCfg(), P = AI_PROVIDERS[c.provider];
  return `<p class="hint" style="margin-top:0">Für „✨ Was koche ich?“ und „📷 Rezept vom Foto“ braucht die App einen eigenen Zugang zu einer KI. Der Schlüssel bleibt nur auf diesem Gerät und wird ausschließlich an den gewählten Anbieter geschickt.</p>
    <label class="field"><span>Anbieter</span><select id="aiProv">${Object.entries(AI_PROVIDERS).map(([k, p]) => `<option value="${k}" ${k === c.provider ? 'selected' : ''}>${p.name} (${p.company})</option>`).join('')}</select></label>
    <p class="hint" id="aiNote">${esc(P.note)} Schlüssel erstellen: <a href="${P.keyUrl}" target="_blank" rel="noopener">${P.keyUrl.replace('https://', '')}</a></p>
    <label class="field"><span>API-Schlüssel</span><input type="password" id="aiKey" value="${esc(c.key)}" placeholder="Schlüssel hier einfügen" autocomplete="off" spellcheck="false"></label>
    <label class="field"><span>Modell</span><select id="aiModel">${modelOpts(c)}</select></label>
    <div class="btn-row"><button class="btn primary" id="aiCheck">Prüfen &amp; speichern</button>${c.key ? '<button class="btn" id="aiRemove">Schlüssel entfernen</button>' : ''}</div>
    <p class="hint" id="aiState">${c.key ? '<span class="status-ok">Eingerichtet ✓</span> ' + esc(P.name) + (c.model ? ' · ' + esc(c.model) : '') : 'Noch nicht eingerichtet.'}</p>
    <p class="hint">Tipp: Beim Anbieter ein monatliches Ausgabenlimit festlegen. Wer dein entsperrtes Handy hat, könnte den Schlüssel auslesen.</p>`;
}

function bindAiSettings() {
  $('#aiProv').onchange = e => {
    const P = AI_PROVIDERS[e.target.value];
    $('#aiNote').innerHTML = `${esc(P.note)} Schlüssel erstellen: <a href="${P.keyUrl}" target="_blank" rel="noopener">${P.keyUrl.replace('https://', '')}</a>`;
    $('#aiModel').innerHTML = '<option value="">automatisch wählen</option>';
  };
  $('#aiCheck').onclick = async e => {
    const provider = $('#aiProv').value, key = $('#aiKey').value.trim();
    if (!key) return toast('Bitte zuerst einen Schlüssel einfügen', true);
    e.target.disabled = true;
    $('#aiState').textContent = 'Wird geprüft …';
    try {
      const { ids, pick } = await aiListModels(provider, key);   // kostet nichts
      const chosen = ids.includes($('#aiModel').value) ? $('#aiModel').value : pick || AI_PROVIDERS[provider].model;
      store.set('ai', { provider, key, model: chosen });
      store.set('aiModels', { provider, ids });
      state.status = localStatus();
      toast(`${AI_PROVIDERS[provider].name} eingerichtet ✓`);
      renderSettings();
    } catch (err) {
      $('#aiState').innerHTML = `<span class="status-bad">${esc(err.message)}</span>`;
      e.target.disabled = false;
    }
  };
  $('#aiModel').onchange = ev => {
    if (!aiCfg().key || $('#aiProv').value !== aiCfg().provider) return;   // erst „Prüfen & speichern“
    store.set('ai', { ...aiCfg(), model: ev.target.value }); toast('Modell gespeichert'); renderSettings();
  };
  if ($('#aiRemove')) $('#aiRemove').onclick = () => { store.set('ai', { provider: aiCfg().provider }); state.status = localStatus(); toast('Schlüssel entfernt'); renderSettings(); };
}

function syncInfo() {
  const n = sync.pending + (sync.shopDirty ? 1 : 0);
  const imgTotal = new Set(state.recipes.flatMap(r => r.images)).size;
  const when = sync.lastSync ? new Date(sync.lastSync).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) : 'noch nie';
  return `<p class="hint" style="margin-top:0">Alle Rezepte und die Einkaufsliste liegen auch auf diesem Gerät. Unterwegs kannst du alles ansehen, neue Rezepte anlegen, bearbeiten und Fotos hinzufügen – sobald du wieder zu Hause bist, gleicht sich die App automatisch mit dem NAS ab.</p>
    <table class="sync-info">
      <tr><td>NAS</td><td>${sync.online === false ? '<span class="status-bad">nicht erreichbar</span>' : sync.online ? '<span class="status-ok">erreichbar ✓</span>' : '–'}</td></tr>
      <tr><td>Letzter Abgleich</td><td>${when}</td></tr>
      <tr><td>Wartende Änderungen</td><td>${n ? `<b>${n}</b>` : 'keine'}</td></tr>
      ${sync.error ? `<tr><td>Fehler</td><td class="status-bad">${esc(sync.error)}</td></tr>` : ''}
      <tr><td>Bilder auf dem Gerät</td><td>${'caches' in window ? `${Math.min(sync.imgCached, imgTotal)} von ${imgTotal}` : 'nur mit https:// möglich'}</td></tr>
    </table>
    <label class="check" style="margin:10px 0"><input type="checkbox" id="offImg" ${store.get('offlineImages', true) ? 'checked' : ''}> Alle Bilder für unterwegs speichern</label>
    ${window.isSecureContext ? '' : '<p class="hint">Damit die App unterwegs auch <b>startet</b>, muss sie über <b>https://</b> geöffnet und installiert sein (siehe „Als App installieren“).</p>'}
    <button class="btn" id="syncNow">Jetzt abgleichen</button>`;
}

// ================= Installation als App (PWA) =================

let installPrompt = null, alreadyInstalled = false;
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function installInfo() {
  if (isStandalone()) return '<p class="status-ok" style="margin:0">Läuft bereits als installierte App ✓</p>';
  if (alreadyInstalled) return '<p class="status-ok" style="margin:0">Auf diesem Gerät bereits als App installiert ✓</p><p class="hint" style="margin-bottom:0">Du bist gerade im Browser. Öffne die Sammlung am besten über das Symbol auf dem Startbildschirm – dann läuft sie ohne Adresszeile und auch unterwegs.</p>';
  if (installPrompt) return `<p class="hint" style="margin-top:0">Die Rezeptsammlung kann wie eine normale App installiert werden – mit eigenem Symbol, ohne Adresszeile.</p><button class="btn primary" id="installHere">📲 Jetzt installieren</button>`;
  if (isIOS) return '<p class="hint" style="margin:0">iPhone/iPad: In Safari unten auf das Teilen-Symbol tippen → <b>„Zum Home-Bildschirm“</b>. Die Sammlung startet dann wie eine App ohne Adresszeile.</p>';
  if (!window.isSecureContext) return `<p class="hint" style="margin:0">Die Installation als App ist nur über eine sichere Verbindung (<b>https://</b>) möglich. Die Seite ist gerade über <b>${esc(location.origin)}</b> geöffnet. Wie du das einrichtest, steht in der Anleitung unter „Als App installieren“.<br>Bis dahin: Browser-Menü ⋮ → „Zum Startbildschirm hinzufügen“ legt eine Verknüpfung an.</p>`;
  return '<p class="hint" style="margin:0">Browser-Menü ⋮ → <b>„App installieren“</b> bzw. „Zum Startbildschirm hinzufügen“. Falls der Eintrag fehlt, die Seite einmal neu laden.</p>';
}

async function installApp() {
  if (!installPrompt) return;
  installPrompt.prompt();
  const { outcome } = await installPrompt.userChoice;
  installPrompt = null;
  $('#installBtn').hidden = true;
  if (outcome === 'accepted') toast('Wird installiert …');
  if (location.hash === '#/settings') renderSettings();
}

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  installPrompt = e;
  if (isStandalone() || alreadyInstalled) return;   // läuft schon als App bzw. ist schon installiert
  $('#installBtn').hidden = false;
  if (location.hash === '#/settings') renderSettings();
});
window.addEventListener('appinstalled', () => { installPrompt = null; alreadyInstalled = true; $('#installBtn').hidden = true; toast('Als App installiert ✓'); });
$('#installBtn').onclick = installApp;
// Im Browser-Tab erkennen, ob die App auf diesem Gerät schon installiert ist (Chrome/Android, siehe related_applications im Manifest)
navigator.getInstalledRelatedApps?.().then(apps => {
  if (!apps.length) return;
  alreadyInstalled = true;
  $('#installBtn').hidden = true;
  if (location.hash === '#/settings') renderSettings();
}).catch(() => {});

if ('serviceWorker' in navigator && window.isSecureContext) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(reg => {
    // Die App startet aus dem Speicher – deshalb nach dem Start selbst beim NAS nach einer neuen Version fragen
    setTimeout(() => reg.update().catch(() => {}), 3000);
    // Beim Zurückholen der App aus dem Hintergrund nach einer neuen Version sehen
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
  }).catch(() => { /* ohne Offline-Funktion weiter */ });
  // Neue Version wurde aktiv: neu laden, sobald nichts verloren gehen kann
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) return;
    const safe = () => !state.dirty && !document.body.classList.contains('cook') && !/^#\/(edit|new|ai|import)/.test(location.hash) && $('#modal').hidden;
    if (safe()) location.reload();
    else {
      toast('Neue Version verfügbar – wird beim nächsten Wechsel der Seite geladen');
      window.addEventListener('hashchange', () => { if (safe()) location.reload(); });
    }
  });
}

function applyTheme() {
  const t = store.get('theme', 'auto');
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.dataset.theme = t;
}

// ================= Login & Start =================

function renderLogin() {
  app.innerHTML = `<div class="login card"><img src="icon.svg" alt="" style="width:64px;margin:0 auto 12px"><h2>Rezeptsammlung</h2>
    <form id="login"><input type="password" id="pw" placeholder="Passwort" autocomplete="current-password" required><button class="btn primary">Anmelden</button></form></div>`;
  $('#pw').focus();
  $('#login').onsubmit = async e => {
    e.preventDefault();
    try { await api('login', { body: { password: $('#pw').value } }); init(); } catch (err) { toast(err.message, true); }
  };
}

function updateLibraryIfShown() { if ($('#results') && !document.activeElement?.closest?.('.lib-head, .filters')) updateLibrary(); }

let started = false;
async function init() {
  applyTheme();
  if (!started) {
    started = true;
    navigator.storage?.persist?.().catch(() => {});   // Gerätespeicher nicht vom Browser aufräumen lassen
    const empty = () => new Map();
    const [recs, kv, imgs] = await Promise.all([local.all('recipes'), local.all('kv'), local.all('images')])
      .catch(() => [empty(), empty(), empty()]);
    state.status = kv.get('status') || null;
    sync.lastSync = kv.get('lastSync') || 0;
    sync.rev = kv.get('rev') || '';
    sync.imgMap = kv.get('imgmap') || {};
    const shop = kv.get('shop');
    if (shop) {
      state.shopping = shop.items || [];
      Object.assign(sync, { shopBase: shop.base || [], shopDirty: !!shop.dirty, shopRev: shop.rev || '' });
    }
    imgs.forEach((data, name) => { try { localImgs.set(name, URL.createObjectURL(dataUrlToBlob(data))); } catch { /* defekt */ } });
    await countPending().catch(() => {});
    if (LOCAL) {
      state.status = localStatus();
      setRecipes([...recs.values()]);
      updateShopBadge();
      route();
      cleanupLocalImages().catch(() => {});
      return;
    }
    if (sync.lastSync) {
      // Kopie auf dem Gerät vorhanden: sofort anzeigen, im Hintergrund mit dem NAS abgleichen
      setRecipes([...recs.values()]);
      updateShopBadge();
      route();
      cleanupLocalImages().catch(() => {});
      runSync();
      return;
    }
  }
  // Erster Start auf diesem Gerät (oder nach der Anmeldung): alles vom NAS holen
  await runSync();
  if (sync.needLogin) return;
  if (!sync.lastSync) {
    app.innerHTML = `<div class="empty"><div class="big">⚠️</div><h2>Verbindung zum NAS fehlgeschlagen</h2><p>${esc(sync.error || 'Das NAS ist nicht erreichbar. Beim ersten Start muss das Gerät im Heimnetz sein, danach funktioniert die Sammlung auch unterwegs.')}</p><button class="btn" onclick="location.reload()">Erneut versuchen</button></div>`;
    return;
  }
  updateShopBadge();
  route();
}

init();
})();
