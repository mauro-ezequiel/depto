// Recolector: lee cada portal, normaliza, mezcla con lo que ya teníamos
// y escribe web/data/listings.json + web/data/status.json.
// Uso: node collector/collect.mjs [fuente1,fuente2]

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import mercadolibre from './sources/mercadolibre.mjs';
import argenprop from './sources/argenprop.mjs';
import zonaprop from './sources/zonaprop.mjs';
import properati from './sources/properati.mjs';
import remax from './sources/remax.mjs';
import { geocodeListings } from './lib/geocode.mjs';

const ALL = [mercadolibre, argenprop, zonaprop, properati, remax];
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'web', 'data');

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

export async function run(only) {
  const cfg = await readJson(join(ROOT, 'collector', 'config.json'), null);
  if (!cfg) throw new Error('Falta collector/config.json');
  const prev = await readJson(join(DATA, 'listings.json'), { listings: [] });
  const prevStatus = await readJson(join(DATA, 'status.json'), { sources: {} });
  const now = new Date().toISOString();

  const byId = new Map(prev.listings.map((l) => [l.id, l]));
  const status = { updated_at: now, zona: cfg.zona.nombre, sources: {} };

  for (const src of ALL) {
    if (!cfg.fuentes[src.name] || (only && !only.includes(src.name))) {
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
        byId.set(it.id, compact({
          ...old, ...it,
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

  if (cfg.geocodificar !== false && !only) {
    const log = (m) => console.log(`[mapa] ${m}`);
    try { await geocodeListings(listings, cfg, join(ROOT, 'collector', 'geocache.json'), log); } catch (e) { log(`ERROR: ${e.message}`); }
  }
  status.with_location = listings.filter((l) => l.lat != null).length;

  await mkdir(DATA, { recursive: true });
  await writeFile(join(DATA, 'listings.json'), JSON.stringify({ updated_at: now, listings }));
  await writeFile(join(DATA, 'status.json'), JSON.stringify(status, null, 2));
  console.log(`Total guardado: ${listings.length}`);
  return status;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const only = process.argv[2]?.split(',');
  run(only).catch((e) => { console.error(e); process.exit(1); });
}
