// Ubica en el mapa los avisos que no traen coordenadas (por ejemplo Mercado Libre),
// usando OpenStreetMap Nominatim. Respeta su política de uso: 1 pedido por segundo,
// identificación propia y todo queda guardado en collector/geocache.json para no repetir.

import { readFile, writeFile } from 'node:fs/promises';
import { sleep } from './util.mjs';

const UA = 'depto-app/1.0 (https://github.com/mauro-ezequiel/depto)';

function clean(s) {
  return String(s || '').replace(/\s+/g, ' ').replace(/\(.*?\)/g, '').trim();
}

async function query(q, box) {
  const u = new URL('https://nominatim.openstreetmap.org/search');
  u.searchParams.set('q', q);
  u.searchParams.set('format', 'jsonv2');
  u.searchParams.set('limit', '1');
  u.searchParams.set('countrycodes', 'ar');
  if (box) {
    u.searchParams.set('viewbox', `${box.oeste},${box.norte},${box.este},${box.sur}`);
    u.searchParams.set('bounded', '1');
  }
  const res = await fetch(u, { headers: { 'user-agent': UA, 'accept-language': 'es' } });
  if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
  const [hit] = await res.json();
  return hit ? [Number(hit.lat), Number(hit.lon)] : null;
}

export async function geocodeListings(listings, cfg, cachePath, log) {
  let cache = {};
  try { cache = JSON.parse(await readFile(cachePath, 'utf8')); } catch { /* primera vez */ }
  const max = cfg.geocodificar_max ?? 600;
  const city = cfg.zona.nombre;
  const box = cfg.zona.bbox;
  let asked = 0, found = 0;

  for (const l of listings) {
    // los que ya tienen ubicación exacta no se tocan; los aproximados se intentan mejorar
    if (l.lat != null && l.lng != null && !l.approx) continue;
    const street = clean(l.address);
    const hood = clean(l.neighborhood);
    // primero la dirección exacta; si no, el centro del barrio (aproximado)
    const tries = [];
    if (street && /\d/.test(street)) tries.push([`${street}, ${hood ? hood + ', ' : ''}${city}`, false]);
    if (hood && !l.approx) tries.push([`${hood}, ${city}`, true]);
    for (const [q, approx] of tries) {
      const key = q.toLowerCase();
      if (!(key in cache)) {
        if (asked >= max) continue;
        asked++;
        try { cache[key] = await query(q, box); } catch (e) { log(`  ${e.message}`); break; }
        await sleep(1100);
      }
      if (cache[key]) {
        [l.lat, l.lng] = cache[key];
        if (approx) l.approx = true; else delete l.approx;
        found++;
        break;
      }
    }
  }
  await writeFile(cachePath, JSON.stringify(cache));
  log(`  ubicados ${found} avisos (${asked} consultas nuevas, ${Object.keys(cache).length} en caché)`);
}
