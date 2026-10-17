// Recolector: lee cada portal, normaliza y mezcla con lo que ya teníamos.
// La base completa vive en state/ (fuera de git, se guarda en la caché de GitHub Actions);
// la app recibe web/data/venta.json, web/data/alquiler.json y web/data/status.json.
// Uso: node collector/collect.mjs [fuente1,fuente2]

import { readFile, writeFile, mkdir, copyFile, access, rm, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import mercadolibre from './sources/mercadolibre.mjs';
import argenprop from './sources/argenprop.mjs';
import zonaprop from './sources/zonaprop.mjs';
import properati from './sources/properati.mjs';
import remax from './sources/remax.mjs';
import nuroa from './sources/nuroa.mjs';
import inmobiliarias from './sources/inmobiliarias.mjs';
import { geocodeListings } from './lib/geocode.mjs';
import { enrichMercadoLibre } from './lib/details.mjs';

const ALL = [mercadolibre, remax, nuroa, inmobiliarias, argenprop, zonaprop, properati];
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'web', 'data');
const STATE = process.env.DEPTO_STATE || join(ROOT, 'state');

// Tramos de precio de los archivos publicados
const BUCKETS = {
  venta: { cur: 'USD', cuts: [60000, 80000, 100000, 130000, 180000, 250000, 400000] },
  alquiler: { cur: 'ARS', cuts: [400000, 600000, 800000, 1100000, 1600000] },
};

const exists = (p) => access(p).then(() => true, () => false);

// Lo que se publica para la app: sin campos internos y con menos decimales.
function forApp(l) {
  const { last_seen, detail_at, detail_v, ...o } = l;
  if (o.city === 'Capital Federal') delete o.city;
  if (o.lat != null) { o.lat = +o.lat.toFixed(5); o.lng = +o.lng.toFixed(5); }
  if (o.images?.length > 8) o.images = o.images.slice(0, 8);
  return o;
}

async function readJson(p, fallback) {
  try { return JSON.parse(await readFile(p, 'utf8')); } catch { return fallback; }
}

function valid(l) {
  return l && l.url && /^https?:\/\//.test(l.url) && (l.title || l.address || l.images?.length);
}

function compact(l) {
  const o = {};
  for (const [k, v] of Object.entries(l)) if (v != null && v !== '' && !(Array.isArray(v) && !v.length)) o[k] = v;
  return o;
}

export async function run(only, mode = {}) {
  const cfg = await readJson(join(ROOT, 'collector', 'config.json'), null);
  if (!cfg) throw new Error('Falta collector/config.json');
  cfg._state = STATE;
  await mkdir(STATE, { recursive: true });
  // Primera vez: arrancamos desde lo que había publicado antes
  const prev = await readJson(join(STATE, 'listings.json'), null)
    || await readJson(join(DATA, 'listings.json'), { listings: [] });
  const geocache = join(STATE, 'geocache.json');
  if (!(await exists(geocache)) && (await exists(join(ROOT, 'collector', 'geocache.json')))) {
    await copyFile(join(ROOT, 'collector', 'geocache.json'), geocache);
  }
  const prevStatus = await readJson(join(STATE, 'status.json'), null)
    || await readJson(join(DATA, 'status.json'), { sources: {} });
  // "solo publicar": no lee portales, solo arma los archivos de la app desde la base guardada
  const publishOnly = Array.isArray(only) && !only.length && !mode.soloFichas;
  const saveState = !publishOnly;
  const now = new Date().toISOString();

  const byId = new Map(prev.listings.map((l) => [l.id, l]));
  const status = publishOnly ? { ...prevStatus, sources: { ...prevStatus.sources } }
    : { updated_at: now, zona: cfg.zona.nombre, sources: {} };

  for (const src of ALL) {
    if (cfg.fuentes[src.name] === false || (only && !only.includes(src.name))) {
      status.sources[src.name] = prevStatus.sources?.[src.name] || { label: src.label, ok: null, count: 0, message: 'desactivada' };
      continue;
    }
    const log = (m) => console.log(`[${src.name}] ${m}`);
    log('empezando');
    const t0 = Date.now();
    try {
      const items = (await src.collect(cfg, log)).filter(valid);
      let nuevos = 0;
      for (const it of items) {
        const old = byId.get(it.id);
        if (!old) nuevos++;
        // si ahora vino con ubicación exacta, deja de ser aproximada
        if (old && it.lat != null && !it.approx) delete old.approx;
        byId.set(it.id, compact({
          ...old, ...compact(it), // lo que no vino esta vez (ej. la dirección) se conserva
          // la página del aviso trae más fotos que el listado: no las pisamos
          images: (old?.images?.length || 0) > (it.images?.length || 0) ? old.images : it.images,
          first_seen: old?.first_seen || now,
          last_seen: now,
          price_prev: old && old.price && it.price && old.price !== it.price ? old.price : old?.price_prev,
        }));
      }
      status.sources[src.name] = { label: src.label, ok: true, count: items.length, new: nuevos, at: now, secs: Math.round((Date.now() - t0) / 1000) };
      log(`listo: ${items.length} avisos (${nuevos} nuevos)`);
    } catch (e) {
      const blocked = [401, 403, 405, 429].includes(e.status);
      status.sources[src.name] = { label: src.label, ok: false, count: 0, at: now, message: blocked ? 'El portal bloquea la lectura automática (protección anti-bots)' : e.message.slice(0, 200) };
      log(`ERROR: ${e.message}`);
    }
  }

  // Sacamos lo que no se vio hace muchos días (seguramente se dio de baja).
  const cutoff = Date.now() - cfg.dias_para_borrar_no_vistos * 86400000;
  let listings = [...byId.values()].filter((l) => Date.parse(l.last_seen || l.first_seen || now) >= cutoff);
  listings.sort((a, b) => (b.first_seen || '').localeCompare(a.first_seen || ''));
  listings = listings.slice(0, cfg.maximo_avisos);
  status.total = listings.length;

  // Coordenadas fuera de la zona (ej. el centro de Argentina que ponen por defecto) no sirven
  const box = cfg.zona.bbox;
  if (box) {
    for (const l of listings) {
      if (l.lat != null && !(l.lat >= box.sur && l.lat <= box.norte && l.lng >= box.oeste && l.lng <= box.este)) {
        delete l.lat; delete l.lng; delete l.approx;
      }
    }
  }

  const mem = (where) => {
    const m = `${where}: ${listings.length} avisos, memoria ${Math.round(process.memoryUsage().rss / 1e6)} MB`;
    console.log(process.env.GITHUB_ACTIONS ? `::notice title=Avance::${m}` : m);
  };
  // punto de guardado: si algo falla más adelante, lo leído de los portales no se pierde
  const checkpoint = () => writeFile(join(STATE, 'listings.json'), JSON.stringify({ updated_at: now, listings }));
  if (saveState && !mode.soloFichas) await checkpoint();
  mem('portales leídos');

  // Las fichas corren en un paso aparte (--solo-fichas) para que un corte no frene lo demás
  if (cfg.detalles !== false && !mode.sinFichas && (mode.soloFichas || !only || only.includes('mercadolibre'))) {
    const log = (m) => console.log(`[detalles] ${m}`);
    try { await enrichMercadoLibre(listings, cfg, log, checkpoint); } catch (e) { log(`ERROR: ${e.message}`); }
  }

  if (cfg.geocodificar !== false && !only) {
    const log = (m) => console.log(`[mapa] ${m}`);
    try { await geocodeListings(listings, cfg, geocache, log); } catch (e) { log(`ERROR: ${e.message}`); }
  }
  status.with_location = listings.filter((l) => l.lat != null).length;
  mem('fichas y mapa listos');
  // detalle por portal: cuántos tienen ubicación exacta, aproximada y más de una foto
  const per = {};
  for (const l of listings) {
    const p = (per[`${l.source}/${l.operation}`] ||= { n: 0, exacta: 0, aprox: 0, fotos: 0 });
    p.n++;
    if (l.lat != null) l.approx ? p.aprox++ : p.exacta++;
    if (l.images?.length > 1) p.fotos++;
  }
  const line = Object.entries(per).map(([k, v]) => `${k} n=${v.n} exacta=${v.exacta} aprox=${v.aprox} fotos>1=${v.fotos}`).join(' | ');
  console.log(process.env.GITHUB_ACTIONS ? `::notice title=Calidad::${line}` : line);

  if (saveState) await checkpoint();

  // La app baja solo los tramos de precio que necesita (ej. hasta USD 100.000), así carga rápido
  await mkdir(DATA, { recursive: true });
  for (const f of await readdir(DATA)) if (/^(venta|alquiler)(-\d+)?\.json$/.test(f)) await rm(join(DATA, f));
  status.files = {};
  for (const [op, { cur, cuts }] of Object.entries(BUCKETS)) {
    const list = listings.filter((l) => (op === 'venta' ? l.operation === 'venta' : l.operation !== 'venta'));
    const edges = [0, ...cuts, null];
    const groups = edges.slice(0, -1).map((min, i) => ({ cur, min, max: edges[i + 1], items: [] }));
    const other = { cur: null, min: null, max: null, items: [] }; // otra moneda o sin precio
    for (const l of list) {
      const g = l.currency === cur && l.price ? groups.find((x) => x.max == null || l.price < x.max) : other;
      g.items.push(forApp(l));
    }
    status.files[op] = [];
    for (const [i, g] of [...groups, other].entries()) {
      const f = `${op}-${i}.json`;
      await writeFile(join(DATA, f), JSON.stringify({ updated_at: status.updated_at, listings: g.items }));
      status.files[op].push({ f, cur: g.cur, min: g.min, max: g.max, n: g.items.length });
    }
    status[`total_${op}`] = list.length;
  }
  await rm(join(DATA, 'listings.json'), { force: true });
  await writeFile(join(DATA, 'status.json'), JSON.stringify(status, null, 2));
  if (saveState) await writeFile(join(STATE, 'status.json'), JSON.stringify(status, null, 2));
  console.log(`Total guardado: ${listings.length}`);
  return status;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = process.argv[2];
  const mode = { sinFichas: arg === '--sin-fichas', soloFichas: arg === '--solo-fichas' };
  const only = arg === '--solo-publicar' || mode.soloFichas ? [] : arg?.startsWith('--') ? undefined : arg?.split(',');
  run(only, mode).catch((e) => { console.error(e); process.exit(1); });
}
