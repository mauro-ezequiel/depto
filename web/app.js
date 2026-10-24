// Depto: muestra los avisos que junta el recolector (data/listings.json).

const PAGE = 30;
const REFRESH_MS = 15 * 60 * 1000;
const TYPES = {
  departamento: 'Departamento', ph: 'PH', casa: 'Casa', local: 'Local', oficina: 'Oficina',
  terreno: 'Terreno', cochera: 'Cochera', galpon: 'Galpón', quinta: 'Quinta',
};
const OPS = { venta: 'Venta', alquiler: 'Alquiler', temporal: 'Alquiler temporal' };

const $ = (s, el = document) => el.querySelector(s);
const store = {
  get(k, d) { try { const v = localStorage.getItem('depto:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('depto:' + k, JSON.stringify(v)); } catch { /* sin almacenamiento */ } },
};

const state = {
  all: [],
  status: null,
  updatedAt: null,
  view: [],
  shown: 0,
  favs: new Set(store.get('favs', [])),
  favData: store.get('favData', {}),
  hidden: new Set(store.get('hidden', [])),
  lastVisit: store.get('lastVisit', null),
  f: Object.assign(
    {
      q: '', op: 'venta', types: [], sources: [], feats: [], estado: ['usado', 'nuevo'], rooms: '', beds: '', baths: '', atmin: '', atmax: '', acmin: '', acmax: '', sort: 'new', photos: false, showHidden: false,
      // precio aparte para comprar y para alquilar
      price: { venta: { cur: 'USD', min: '', max: '' }, alquiler: { cur: 'ARS', min: '', max: '' } },
    },
    store.get('filters', {}),
  ),
  mode: store.get('mode', 'list'),
};
if (!['venta', 'alquiler', 'best', 'fav'].includes(state.f.op)) state.f.op = 'venta';
if (!Array.isArray(state.f.estado)) state.f.estado = ['usado', 'nuevo']; // de entrada, sin pozo
state.f.best = Object.assign({ op: 'venta', beds: '1' }, state.f.best || {});
state.f.price = Object.assign(
  { venta: { cur: 'USD', min: '', max: '' }, alquiler: { cur: 'ARS', min: '', max: '' } }, state.f.price || {},
);

// ---------- formato ----------
const nf = new Intl.NumberFormat('es-AR');
function money(l) {
  if (!l.price) return 'Consultar precio';
  return (l.currency === 'USD' ? 'USD ' : l.currency === 'ARS' ? '$ ' : (l.currency || '') + ' ') + nf.format(l.price);
}
function ago(iso) {
  if (!iso) return '';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 90) return 'recién';
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  if (s < 86400) return `hace ${Math.round(s / 3600)} h`;
  return `hace ${Math.round(s / 86400)} d`;
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const srcLabel = (s) => state.status?.sources?.[s]?.label || s;
// Características que se marcan en cada aviso (vienen del portal o del título)
const FEATS = { credito: 'Apto crédito', cochera: 'Cochera', balcon: 'Balcón', patio: 'Patio' };
const featList = (l) => Object.keys(FEATS).filter((k) => l[k] === true);
function feats(l) {
  const f = [];
  if (l.area_total) f.push(`${nf.format(l.area_total)} m² tot.`);
  if (l.area_covered && l.area_covered !== l.area_total) f.push(`${nf.format(l.area_covered)} m² cub.`);
  if (l.rooms) f.push(`${l.rooms} amb.`);
  if (l.bedrooms) f.push(`${l.bedrooms} dorm.`);
  if (l.bathrooms) f.push(`${l.bathrooms} baño${l.bathrooms > 1 ? 's' : ''}`);
  return f;
}
const CHIP_FILTERS = [['roomChips', 'rooms'], ['bedChips', 'beds'], ['bathChips', 'baths']];
const AREA_FIELDS = ['atmin', 'atmax', 'acmin', 'acmax'];
const NUM_FILTERS = ['rooms', 'beds', 'baths', ...AREA_FIELDS];
// Si el aviso no dice dormitorios, se estima como ambientes - 1 (convención en Argentina).
const bedrooms = (l) => l.bedrooms ?? (l.rooms > 1 ? l.rooms - 1 : null);
const place = (l) => [l.address, l.neighborhood, l.city].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(', ');
const isNew = (l) => state.lastVisit && l.first_seen && l.first_seen > state.lastVisit;
const pricePerM2 = (l) => (l.price && (l.area_total || l.area_covered) ? l.price / (l.area_total || l.area_covered) : null);

// ---------- datos ----------
// Los avisos vienen en dos archivos (venta y alquiler); primero el de la pestaña actual.
const parts = { venta: [], alquiler: [] };
// Los avisos vienen en archivos por operación y tramo de precio (ver status.files):
// solo se bajan los que el filtro de precio necesita, así carga rápido aunque haya muchísimos.
const loaded = new Map(); // archivo -> avisos
const pending = new Set();
let loading = null;

// Mejores precios: piso para descartar precios que no son el valor real (cocheras, anticipos, errores)
const BEST = { venta: { cur: 'USD', floor: 20000, upTo: 130000 }, alquiler: { cur: 'ARS', floor: 150000, upTo: 800000 } };
const NOT_REAL_PRICE = /anticipo|cuota|financ|desde\s+u?\$?s?\s*\d|pozo/i;

// Usado / a estrenar / en pozo
function estado(l) {
  if (l.pozo) return 'pozo';
  if (l.nuevo || l.antiguedad === 0) return 'nuevo';
  return 'usado';
}

function neededFiles() {
  const files = state.status?.files;
  if (!files) return [];
  if (state.f.op === 'fav') return [];
  if (state.f.op === 'best') {
    const b = BEST[state.f.best.op];
    return (files[state.f.best.op] || []).filter((x) => x.cur === b.cur && x.min < b.upTo);
  }
  const list = files[state.f.op] || [];
  const pr = state.f.price[state.f.op];
  const min = +pr?.min || 0, max = +pr?.max || 0;
  if (!min && !max) return list;
  // con precio cargado solo sirven los avisos en esa moneda (los demás se descartan igual)
  return list.filter((x) => x.cur === pr.cur && (!max || x.min <= max) && (!min || x.max == null || x.max > min));
}

function rebuild() {
  const seen = new Set();
  state.all = [];
  for (const items of loaded.values()) for (const l of items) { seen.add(l.id); state.all.push(l); }
  // los guardados se ven siempre, aunque su tramo de precio no esté bajado
  for (const [id, l] of Object.entries(state.favData)) if (!seen.has(id)) state.all.push(l);
}

async function ensureData() {
  const want = neededFiles().filter((x) => !loaded.has(x.f) && !pending.has(x.f));
  if (!want.length) return loading;
  want.forEach((x) => pending.add(x.f));
  const run = (async () => {
    $('#meta').classList.add('loading');
    // primero el tramo más chico, para mostrar algo enseguida; el resto en paralelo
    const [first, ...rest] = [...want].sort((a, b) => a.n - b.n);
    const get = (x) => fetch(`data/${x.f}`, { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : { listings: [] }))
      .then((d) => { loaded.set(x.f, d.listings || []); }).finally(() => pending.delete(x.f));
    await get(first);
    rebuild(); apply({ keep: true });
    if (rest.length) { await Promise.all(rest.map(get)); rebuild(); buildFilterChips(); apply({ keep: true }); }
    $('#meta').classList.remove('loading');
  })();
  run.catch(() => { $('#meta').classList.remove('loading'); });
  loading = run;
  try { await run; } finally { if (loading === run) { loading = null; if (!state.view.length) apply({ keep: true }); } }
}

async function load({ quiet = false } = {}) {
  try {
    const s = await fetch('data/status.json', { cache: 'no-cache' }).then((r) => r.json()).catch(() => null);
    if (quiet && s && s.updated_at === state.updatedAt) return;
    const before = state.updatedAt;
    const prevIds = quiet ? new Set(state.all.map((l) => l.id)) : null;
    state.status = s;
    state.updatedAt = s?.updated_at || null;
    loaded.clear();
    if (!quiet) { rebuild(); buildFilterChips(); apply({ keep: true }); }
    await ensureData();
    if (!quiet) { buildFilterChips(); apply({ keep: true }); }
    if (quiet && before && before !== state.updatedAt) {
      const n = state.all.filter((l) => !prevIds.has(l.id)).length;
      buildFilterChips(); apply();
      toast(n ? `${nf.format(n)} aviso${n > 1 ? 's' : ''} nuevo${n > 1 ? 's' : ''}` : 'Avisos actualizados', 'Ver', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
    }
  } catch (e) {
    if (!state.all.length) showEmpty('No se pudieron cargar los avisos', 'Revisá tu conexión y volvé a intentar.');
  }
}

// ---------- filtros ----------
function apply({ keep = false } = {}) {
  const f = state.f;
  if (!keep && neededFiles().some((x) => !loaded.has(x.f))) ensureData();
  const q = f.q.trim().toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
  let v = state.all.filter((l) => {
    if (f.op === 'fav') { if (!state.favs.has(l.id)) return false; }
    else if (f.op === 'best') {
      const b = BEST[f.best.op];
      if (l.operation !== f.best.op || l.type !== 'departamento' || l.currency !== b.cur) return false;
      if (!(l.price >= b.floor) || bedrooms(l) !== +f.best.beds) return false;
      if (l.pozo || NOT_REAL_PRICE.test(l.title || '')) return false;
      if (l.city && !/capital|caba|ciudad/i.test(l.city)) return false; // solo Capital
    } else {
      if (l.operation !== f.op) return false;
      const pr = f.price[f.op];
      if (pr) {
        if ((pr.min || pr.max) && l.currency !== pr.cur) return false;
        if (pr.min && !(l.price >= +pr.min)) return false;
        if (pr.max && !(l.price && l.price <= +pr.max)) return false;
      }
    }
    if (!f.showHidden && f.op !== 'fav' && state.hidden.has(l.id)) return false;
    if (f.op !== 'best' && f.types.length && !f.types.includes(l.type)) return false;
    if (f.sources.length && !f.sources.includes(l.source)) return false;
    if (f.feats?.length && !f.feats.every((k) => l[k] === true)) return false;
    if (f.op !== 'best' && f.op !== 'fav' && f.estado?.length && !f.estado.includes(estado(l))) return false;
    if (f.rooms && !(l.rooms >= +f.rooms)) return false;
    if (f.beds && !(bedrooms(l) >= +f.beds)) return false;
    if (f.baths && !(l.bathrooms >= +f.baths)) return false;
    const at = l.area_total || l.area_covered, ac = l.area_covered || l.area_total;
    if (f.atmin && !(at >= +f.atmin)) return false;
    if (f.atmax && !(at && at <= +f.atmax)) return false;
    if (f.acmin && !(ac >= +f.acmin)) return false;
    if (f.acmax && !(ac && ac <= +f.acmax)) return false;
    if (f.photos && !l.images?.length) return false;
    if (q) {
      const hay = [l.title, l.address, l.neighborhood, l.city, TYPES[l.type], srcLabel(l.source), l.publisher].join(' ')
        .toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
      if (!q.split(/\s+/).every((w) => hay.includes(w))) return false;
    }
    return true;
  });
  const num = (x) => (x == null ? Infinity : x);
  const sorts = {
    new: (a, b) => (b.first_seen || '').localeCompare(a.first_seen || ''),
    price_asc: (a, b) => num(a.price) - num(b.price),
    price_desc: (a, b) => (b.price || 0) - (a.price || 0),
    m2_asc: (a, b) => num(pricePerM2(a)) - num(pricePerM2(b)),
    area_desc: (a, b) => (b.area_total || b.area_covered || 0) - (a.area_total || a.area_covered || 0),
  };
  v.sort(f.op === 'best' ? sorts.price_asc : sorts[f.sort] || sorts.new);
  state.view = v;
  // al sumar avisos de otro tramo no se pierde lo que ya estabas mirando
  const shown = keep ? Math.max(state.shown, PAGE) : PAGE;
  state.shown = 0;
  $('#grid').innerHTML = '';
  renderMeta();
  syncPriceBar();
  if (state.mode === 'map') renderMap(); else renderMore(shown);
  store.set('filters', { ...f, q: f.q });
  const active = ['types', 'sources', 'feats', 'estado'].reduce((n, k) => n + (f[k]?.length ? 1 : 0), 0)
    + NUM_FILTERS.filter((k) => f[k]).length + (f.photos ? 1 : 0) + (f.sort !== 'new' ? 1 : 0);
  $('#filterCount').textContent = active;
  $('#filterCount').classList.toggle('hidden', !active);
  document.querySelectorAll('#opChips .chip[data-op]').forEach((b) => b.classList.toggle('on', b.dataset.op === f.op));
  $('#bestbar').classList.toggle('hidden', f.op !== 'best');
  document.querySelectorAll('#bestOp .chip[data-v]').forEach((b) => b.classList.toggle('on', b.dataset.v === f.best.op));
  document.querySelectorAll('#bestOp .chip[data-b]').forEach((b) => b.classList.toggle('on', b.dataset.b === f.best.beds));

  if (!v.length) {
    if (loading || pending.size) showEmpty('Cargando avisos…', 'Un momento.');
    else if (!state.all.length) {
      showEmpty('Todavía no hay avisos',
        'El recolector todavía no corrió o no pudo leer los portales. Tocá “Estado de portales” arriba para ver qué pasó.');
    } else if (f.op === 'fav') showEmpty('No guardaste avisos todavía', 'Tocá ♡ en cualquier aviso para guardarlo acá.');
    else showEmpty('Nada coincide con estos filtros', 'Probá aflojando algún filtro.');
  } else $('#empty').classList.add('hidden');
}

function showEmpty(t, d) {
  $('#empty').innerHTML = `<h3>${esc(t)}</h3><p>${esc(d)}</p>`;
  $('#empty').classList.remove('hidden');
}

function renderMeta() {
  const s = state.status;
  const bad = s ? Object.values(s.sources || {}).filter((x) => x.ok === false).length : 0;
  $('#meta').innerHTML = `
    <span>${nf.format(state.view.length)} avisos</span>
    ${pending.size ? '<span>· cargando más…</span>' : state.updatedAt ? `<span>· actualizado ${ago(state.updatedAt)}</span>` : ''}
    <button type="button" id="srcBtn">Estado de portales${bad ? ` (${bad} con problemas)` : ''}</button>`;
  $('#srcBtn').onclick = openSources;
}

function card(l) {
  const imgs = (l.images || []).slice(0, 6);
  const el = document.createElement('article');
  el.className = 'card' + (state.hidden.has(l.id) ? ' dim' : '');
  el.innerHTML = `
    <div class="photos">${imgs.length
      ? imgs.map((u, i) => `<img src="${esc(u)}" alt="" loading="${i ? 'lazy' : 'lazy'}" decoding="async" referrerpolicy="no-referrer">`).join('')
      : '<div class="nophoto">Sin fotos</div>'}</div>
    <span class="src">${esc(srcLabel(l.source))}${l.publisher ? ` · ${esc(l.publisher)}` : ''}</span>
    ${isNew(l) ? '<span class="src tag-new" style="left:auto;right:10px">Nuevo</span>' : (l.images?.length > 1 ? `<span class="count">${l.images.length} fotos</span>` : '')}
    <div class="body">
      <div class="price">${esc(money(l))}${l.expenses ? `<small>+ $ ${nf.format(l.expenses)} expensas</small>` : l.expenses === 0 ? '<small>sin expensas</small>' : ''}${l.price_prev && l.price < l.price_prev ? '<span class="drop">▼ bajó</span>' : ''}</div>
      <div class="feats">${[TYPES[l.type], OPS[l.operation], ...feats(l)].filter(Boolean).map((x) => `<span>${esc(x)}</span>`).join('')}${featList(l).map((k) => `<span class="hl">${esc(FEATS[k])}</span>`).join('')}</div>
      ${place(l) ? `<div class="place">${esc(place(l))}</div>` : ''}
      ${l.title ? `<div class="title">${esc(l.title)}</div>` : ''}
      <div class="cardfoot">
        <button class="ibtn" data-act="fav" aria-label="Guardar">${state.favs.has(l.id) ? '♥' : '♡'}</button>
        ${l.lat != null || place(l) ? '<button class="ibtn" data-act="map">📍 Mapa</button>' : ''}
        <a class="go" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">Ver fotos y agendar ↗</a>
      </div>
    </div>`;
  el.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'fav') { e.stopPropagation(); toggleFav(l, e.target.closest('button'), true); return; }
    if (act === 'map') { e.stopPropagation(); showOnMap(l); return; }
    if (e.target.closest('a')) return;
    openDetail(l);
  });
  el.querySelectorAll('img').forEach((img) => img.addEventListener('error', () => img.remove(), { once: true }));
  return el;
}

function renderMore(n = PAGE) {
  const next = state.view.slice(state.shown, state.shown + n);
  const frag = document.createDocumentFragment();
  next.forEach((l) => frag.appendChild(card(l)));
  $('#grid').appendChild(frag);
  state.shown += next.length;
}

function toggleFav(l, btn, short) {
  if (state.favs.has(l.id)) { state.favs.delete(l.id); delete state.favData[l.id]; } else { state.favs.add(l.id); state.favData[l.id] = l; }
  store.set('favs', [...state.favs]);
  store.set('favData', state.favData);
  const on = state.favs.has(l.id);
  if (btn) btn.textContent = short ? (on ? '♥' : '♡') : (on ? '♥ Guardado' : '♡ Guardar');
}

// Botón "Mapa" de cada aviso: lo muestra en nuestro mapa; si no tiene coordenadas, en Google Maps.
function showOnMap(l) {
  if (!hasPoint(l)) {
    window.open(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place(l))}`, '_blank', 'noopener');
    return;
  }
  renderMap.fitted = true;
  setMode('map');
  map.setView([l.lat, l.lng], l.approx ? 15 : 17);
  L.popup({ offset: [0, -24] }).setLatLng([l.lat, l.lng])
    .setContent(`<b>${esc(money(l))}</b><br>${esc(place(l))}${l.approx ? '<br><small>Ubicación aproximada</small>' : ''}`)
    .openOn(map);
}

function toggleHidden(l) {
  if (state.hidden.has(l.id)) state.hidden.delete(l.id); else state.hidden.add(l.id);
  store.set('hidden', [...state.hidden]);
}

// ---------- detalle ----------
function openDetail(l) {
  const d = $('#detail');
  const rows = [
    ['Operación', OPS[l.operation]],
    ['Tipo', TYPES[l.type]],
    ['Precio', money(l)],
    ['Expensas', l.expenses ? `$ ${nf.format(l.expenses)}` : l.expenses === 0 ? 'No tiene' : 'El aviso no lo dice'],
    ['Estado', { usado: 'Usado', nuevo: 'A estrenar', pozo: 'En pozo / en construcción' }[estado(l)] + (l.pozo || l.nuevo || l.antiguedad != null ? '' : ' (no dice lo contrario)')],
    ['Antigüedad', l.antiguedad != null ? `${l.antiguedad} años` : null],
    ...Object.entries(FEATS).map(([k, name]) => [name, l[k] === true ? 'Sí' : l[k] === false ? 'No' : null]),
    ['Precio anterior', l.price_prev ? `${l.currency === 'USD' ? 'USD' : '$'} ${nf.format(l.price_prev)}` : null],
    ['Precio por m²', pricePerM2(l) ? `${l.currency === 'USD' ? 'USD' : '$'} ${nf.format(Math.round(pricePerM2(l)))}` : null],
    ['Superficie total', l.area_total ? `${nf.format(l.area_total)} m²` : null],
    ['Superficie cubierta', l.area_covered ? `${nf.format(l.area_covered)} m²` : null],
    ['Ambientes', l.rooms],
    ['Dormitorios', l.bedrooms],
    ['Baños', l.bathrooms],
    ['Dirección', l.address],
    ['Barrio', l.neighborhood],
    ['Localidad', l.city],
    ['Ubicación en el mapa', hasPoint(l) ? 'Exacta' : 'Sin ubicación exacta (se busca por dirección en Google Maps)'],
    ['Portal', srcLabel(l.source)],
    ['Publica', l.publisher],
    ['Visto por primera vez', l.first_seen ? new Date(l.first_seen).toLocaleDateString('es-AR') : null],
  ].filter(([, v]) => v != null && v !== '');
  const map = l.lat && l.lng ? `https://www.google.com/maps/search/?api=1&query=${l.lat},${l.lng}`
    : place(l) ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place(l))}` : null;
  d.innerHTML = `
    <button class="close" aria-label="Cerrar">×</button>
    <div class="photos">${(l.images || []).length
      ? l.images.map((u) => `<img src="${esc(u)}" alt="" loading="lazy" referrerpolicy="no-referrer">`).join('')
      : '<div class="nophoto">Sin fotos</div>'}</div>
    <div class="sheetbody">
      <div class="price">${esc(money(l))}</div>
      ${l.title ? `<h2 style="margin-top:6px">${esc(l.title)}</h2>` : ''}
      <table>${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>
      <div class="actions">
        <button type="button" class="ghost" data-act="fav">${state.favs.has(l.id) ? '♥ Guardado' : '♡ Guardar'}</button>
        <button type="button" class="ghost" data-act="hide">${state.hidden.has(l.id) ? 'Recuperar' : 'Descartar'}</button>
      </div>
      <div class="actions" style="position:static">
        ${map ? `<button type="button" class="ghost" style="flex:1" data-act="map">📍 Mapa</button>` : ''}
        <a class="primary" style="flex:2;height:46px;border-radius:12px;font-weight:700" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">Ver fotos y agendar visita en ${esc(srcLabel(l.source))} ↗</a>
      </div>
      ${navigator.share ? '<div class="actions" style="position:static"><button type="button" class="ghost" data-act="share">Compartir</button></div>' : ''}
    </div>`;
  d.onclick = (e) => {
    if (e.target === d) return d.close();
    const act = e.target.closest('[data-act], .close');
    if (!act) return;
    if (act.classList.contains('close')) return d.close();
    const a = act.dataset.act;
    if (a === 'fav') { toggleFav(l, act); apply(); }
    if (a === 'hide') { toggleHidden(l); d.close(); apply(); toast(state.hidden.has(l.id) ? 'Aviso descartado' : 'Aviso recuperado'); }
    if (a === 'map') { d.close(); showOnMap(l); }
    if (a === 'share') navigator.share({ title: l.title || 'Aviso', url: l.url }).catch(() => {});
  };
  d.showModal();
  d.scrollTop = 0;
}

// ---------- estado de portales ----------
function openSources() {
  const s = state.status;
  const d = $('#sources');
  const list = s ? Object.entries(s.sources || {}) : [];
  d.innerHTML = `<div class="sheetbody">
    <h2>Estado de portales</h2>
    <p style="color:var(--muted);margin:0">Zona: ${esc(s?.zona || '—')}. Última corrida: ${s?.updated_at ? new Date(s.updated_at).toLocaleString('es-AR') : 'nunca'}.</p>
    <ul class="srclist">${list.map(([, x]) => `
      <li><span class="dot ${x.ok ? 'ok' : x.ok === false ? 'err' : ''}"></span>
        <div><b>${esc(x.label)}</b>
        <small>${x.ok ? `${nf.format(x.count)} avisos leídos${x.new ? ` · ${x.new} nuevos` : ''}` : x.ok === false ? `No se pudo leer: ${esc(x.message || '')}` : esc(x.message || 'sin datos')}</small></div></li>`).join('') || '<li>Sin información todavía.</li>'}
    </ul>
    <div class="actions"><button class="primary" type="button">Cerrar</button></div></div>`;
  d.querySelector('button').onclick = () => d.close();
  d.onclick = (e) => { if (e.target === d) d.close(); };
  d.showModal();
}

// ---------- hoja de filtros ----------
function buildFilterChips() {
  const types = [...new Set(state.all.map((l) => l.type).filter(Boolean))];
  const order = Object.keys(TYPES);
  types.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  $('#typeChips').innerHTML = (types.length ? types : order.slice(0, 6))
    .map((t) => `<button type="button" class="chip${state.f.types.includes(t) ? ' on' : ''}" data-v="${t}">${TYPES[t] || t}</button>`).join('');
  const sources = Object.keys(state.status?.sources || {});
  $('#sourceChips').innerHTML = sources
    .map((s) => `<button type="button" class="chip${state.f.sources.includes(s) ? ' on' : ''}" data-v="${s}">${esc(srcLabel(s))}</button>`).join('');
}

function syncForm() {
  const fm = $('#filterForm');
  for (const k of [...AREA_FIELDS, 'sort']) fm.elements[k].value = state.f[k];
  fm.elements.photos.checked = state.f.photos;
  fm.elements.showHidden.checked = state.f.showHidden;
  document.querySelectorAll('#featChips .chip').forEach((b) => b.classList.toggle('on', (state.f.feats || []).includes(b.dataset.v)));
  document.querySelectorAll('#estadoChips .chip').forEach((b) => b.classList.toggle('on', (state.f.estado || []).includes(b.dataset.v)));
  for (const [id, k] of CHIP_FILTERS) document.querySelectorAll(`#${id} .chip`).forEach((b) => b.classList.toggle('on', b.dataset.v === String(state.f[k])));
}

function readForm() {
  const fm = $('#filterForm');
  for (const k of [...AREA_FIELDS, 'sort']) state.f[k] = fm.elements[k].value;
  state.f.photos = fm.elements.photos.checked;
  state.f.showHidden = fm.elements.showHidden.checked;
  state.f.types = [...document.querySelectorAll('#typeChips .chip.on')].map((b) => b.dataset.v);
  state.f.sources = [...document.querySelectorAll('#sourceChips .chip.on')].map((b) => b.dataset.v);
  state.f.feats = [...document.querySelectorAll('#featChips .chip.on')].map((b) => b.dataset.v);
  state.f.estado = [...document.querySelectorAll('#estadoChips .chip.on')].map((b) => b.dataset.v);
  for (const [id, k] of CHIP_FILTERS) state.f[k] = document.querySelector(`#${id} .chip.on`)?.dataset.v || '';
}

// ---------- precio (barra rápida) ----------
function syncPriceBar() {
  const pr = state.f.price[state.f.op];
  $('#pricebar').classList.toggle('hidden', !pr);
  if (!pr) return;
  if (document.activeElement?.closest?.('#pricebar')) return;
  $('#pcur').value = pr.cur;
  $('#pmin').value = pr.min;
  $('#pmax').value = pr.max;
  const word = state.f.op === 'venta' ? 'Precio' : 'Alquiler';
  $('#pmin').placeholder = `${word} mín.`;
  $('#pmax').placeholder = `${word} máx.`;
}

// ---------- mapa ----------
const SRC_COLORS = { mercadolibre: '#e5b800', remax: '#d6262b', nuroa: '#14b8a6', inmobiliarias: '#64748b', argenprop: '#1f6feb', zonaprop: '#f26b1d', properati: '#7b3fe4' };
let map, cluster;

function setMode(mode, initial) {
  state.mode = mode;
  store.set('mode', mode);
  const isMap = mode === 'map';
  document.body.classList.toggle('mapmode', isMap);
  $('#mapView').classList.toggle('hidden', !isMap);
  $('#viewBtn').textContent = isMap ? '☰ Lista' : '🗺 Mapa';
  $('#viewBtn').setAttribute('aria-pressed', String(isMap));
  if (!initial) apply();
}

function priceShort(l) {
  if (!l.price) return '?';
  const p = l.price;
  const n = p >= 1e6 ? `${+(p / 1e6).toFixed(p >= 1e7 ? 0 : 1)}M` : p >= 1e3 ? `${Math.round(p / 1e3)}k` : String(p);
  return (l.currency === 'USD' ? 'US$' : '$') + n;
}

// solo ubicaciones exactas: el centro del barrio apilaba avisos distintos en un mismo punto
const hasPoint = (l) => l.lat != null && l.lng != null && !l.approx;

function renderMap() {
  if (!window.L) { $('#mapNote').textContent = 'No se pudo cargar el mapa.'; return; }
  if (!map) {
    map = L.map('map', { zoomControl: true, attributionControl: true }).setView([-34.61, -58.44], 12);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; OpenStreetMap',
    }).addTo(map);
    cluster = L.markerClusterGroup({ showCoverageOnHover: false, maxClusterRadius: 45, chunkedLoading: true });
    map.addLayer(cluster);
  }
  setTimeout(() => map.invalidateSize(), 0);
  cluster.clearLayers();
  const pts = state.view.filter(hasPoint);
  const markers = pts.map((l) => {
    const icon = L.divIcon({
      className: 'pin' + (l.approx ? ' approx' : ''),
      html: `<span style="--c:${SRC_COLORS[l.source] || '#0f766e'}">${esc(priceShort(l))}</span>`,
      iconSize: null,
    });
    const m = L.marker([l.lat, l.lng], { icon, title: l.title || '' });
    m.on('click', () => openDetail(l));
    return m;
  });
  cluster.addLayers(markers);
  const missing = state.view.length - pts.length;
  $('#mapNote').textContent = `${nf.format(pts.length)} en el mapa` + (missing ? ` · ${nf.format(missing)} sin ubicación exacta todavía` : '');
  if (pts.length && !renderMap.fitted) {
    map.fitBounds(L.latLngBounds(pts.map((l) => [l.lat, l.lng])), { padding: [30, 30], maxZoom: 14 });
    renderMap.fitted = true;
  }
}

// ---------- avisos emergentes ----------
let toastTimer;
function toast(msg, action, fn) {
  const t = $('#toast');
  t.innerHTML = esc(msg) + (action ? ` <button type="button">${esc(action)}</button>` : '');
  if (action) t.querySelector('button').onclick = () => { t.classList.add('hidden'); fn?.(); };
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 6000);
}

// ---------- arranque ----------
function init() {
  $('#q').value = state.f.q;
  let qt;
  $('#q').addEventListener('input', (e) => { clearTimeout(qt); qt = setTimeout(() => { state.f.q = e.target.value; apply(); }, 200); });
  $('#opChips').addEventListener('click', (e) => {
    const b = e.target.closest('.chip[data-op]'); if (!b) return;
    state.f.op = b.dataset.op; apply();
  });
  $('#bestOp').addEventListener('click', (e) => {
    const b = e.target.closest('.chip'); if (!b) return;
    if (b.dataset.v) state.f.best.op = b.dataset.v;
    if (b.dataset.b) state.f.best.beds = b.dataset.b;
    apply(); window.scrollTo({ top: 0 });
  });
  let pt;
  const onPrice = () => {
    const pr = state.f.price[state.f.op]; if (!pr) return;
    pr.cur = $('#pcur').value; pr.min = $('#pmin').value; pr.max = $('#pmax').value;
    clearTimeout(pt); pt = setTimeout(apply, 300);
  };
  ['#pcur', '#pmin', '#pmax'].forEach((s) => $(s).addEventListener('input', onPrice));
  $('#viewBtn').onclick = () => setMode(state.mode === 'map' ? 'list' : 'map');
  setMode(state.mode, true);
  const topH = () => document.documentElement.style.setProperty('--top-h', `${$('.top').offsetHeight}px`);
  new ResizeObserver(topH).observe($('.top'));
  topH();
  $('#filtersBtn').onclick = () => { syncForm(); $('#filters').showModal(); };
  $('#filters').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (chip) {
      if (CHIP_FILTERS.some(([id]) => id === chip.parentElement.id)) chip.parentElement.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c === chip));
      else chip.classList.toggle('on');
    }
    if (e.target === $('#filters')) $('#filters').close();
  });
  $('#filterForm').addEventListener('submit', () => { readForm(); apply(); window.scrollTo({ top: 0 }); });
  $('#resetFilters').onclick = () => {
    Object.assign(state.f, { types: [], sources: [], feats: [], estado: [], sort: 'new', photos: false, showHidden: false }, Object.fromEntries(NUM_FILTERS.map((k) => [k, ''])));
    buildFilterChips(); syncForm();
  };

  new IntersectionObserver((ents) => {
    if (ents[0].isIntersecting && state.shown < state.view.length) renderMore();
  }, { rootMargin: '800px' }).observe($('#more'));

  // "Nuevo" = apareció después de tu visita anterior
  addEventListener('pagehide', () => store.set('lastVisit', state.updatedAt || new Date().toISOString()));

  // Se actualiza solo: al volver a la app y cada 15 minutos
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load({ quiet: true }); });
  setInterval(() => { if (!document.hidden) load({ quiet: true }); }, REFRESH_MS);

  // Instalar como app
  let deferred;
  addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; $('#installBtn').classList.remove('hidden'); });
  $('#installBtn').onclick = async () => { $('#installBtn').classList.add('hidden'); deferred?.prompt(); deferred = null; };

  if ('serviceWorker' in navigator) {
    // Cuando se publica una versión nueva, la app se recarga sola
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController && !reloaded) { reloaded = true; location.reload(); }
    });
    navigator.serviceWorker.register('sw.js').then((reg) => {
      setInterval(() => reg.update(), REFRESH_MS);
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        w?.addEventListener('statechange', () => {
          if (w.state === 'installed' && navigator.serviceWorker.controller) toast('Hay una versión nueva de la app', 'Actualizar', () => location.reload());
        });
      });
    }).catch(() => {});
  }

  load();
}

init();
