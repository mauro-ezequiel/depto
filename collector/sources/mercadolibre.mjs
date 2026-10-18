// Mercado Libre Inmuebles, por la API oficial (developers.mercadolibre.com.ar).
// La búsqueda pública pide un token: creá una app gratis en
// https://developers.mercadolibre.com.ar/devcenter y guardá ML_CLIENT_ID y
// ML_CLIENT_SECRET como secrets del repositorio. Si no hay token, se intenta
// leer la página pública de resultados.

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dumpRaw, fetchJson, fetchText, guessOperation, guessType, sleep, toNumber, uniq } from '../lib/util.mjs';
import { extractJsonBlobs } from '../lib/embedded.mjs';

const CATEGORY = 'MLA1459'; // Inmuebles
const OP_SLUG = { venta: 'venta', alquiler: 'alquiler', temporal: 'alquiler-temporal' };
const ACCENTS = { agronomia: 'Agronomía', constitucion: 'Constitución', nunez: 'Núñez', 'parque-chacabuco': 'Parque Chacabuco', 'villa-gral-mitre': 'Villa General Mitre', 'san-nicolas': 'San Nicolás', 'villa-pueyrredon': 'Villa Pueyrredón' };
const barrioName = (slug) => ACCENTS[slug] || slug.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
const PER = 100; // avisos por página en la vista de mapa
const TYPE_SLUG = { departamento: 'departamentos', ph: 'ph', casa: 'casas', local: 'locales', oficina: 'oficinas', terreno: 'terrenos-lotes' };

async function getToken() {
  if (process.env.ML_ACCESS_TOKEN) return process.env.ML_ACCESS_TOKEN;
  const id = process.env.ML_CLIENT_ID, secret = process.env.ML_CLIENT_SECRET;
  if (!id || !secret) return null;
  const res = await fetch('https://api.mercadolibre.com/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }),
  });
  if (!res.ok) throw new Error(`No se pudo obtener token de Mercado Libre (HTTP ${res.status})`);
  return (await res.json()).access_token;
}

function attr(item, id) {
  const a = (item.attributes || []).find((x) => x.id === id);
  return a ? a.value_name ?? a.value_struct?.number ?? null : null;
}

function mapItem(it) {
  const loc = it.location || {};
  const opText = attr(it, 'OPERATION');
  const typeText = attr(it, 'PROPERTY_TYPE');
  const pics = (it.pictures || []).map((p) => p.secure_url || p.url);
  const thumb = it.thumbnail ? it.thumbnail.replace(/^http:/, 'https:').replace(/-I\.(jpg|webp)$/, '-O.$1') : null;
  return {
    source: 'mercadolibre',
    id: `mercadolibre:${it.id}`,
    url: it.permalink,
    title: it.title,
    operation: guessOperation(opText, it.permalink) || null,
    type: guessType(typeText, it.title) || null,
    price: toNumber(it.price),
    currency: it.currency_id === 'USD' ? 'USD' : it.currency_id === 'ARS' ? 'ARS' : it.currency_id,
    expenses: toNumber(attr(it, 'MAINTENANCE_FEE')),
    address: loc.address_line || null,
    neighborhood: loc.neighborhood?.name || null,
    city: loc.city?.name || loc.state?.name || null,
    lat: toNumber(loc.latitude),
    lng: toNumber(loc.longitude),
    area_total: toNumber(attr(it, 'TOTAL_AREA')),
    area_covered: toNumber(attr(it, 'COVERED_AREA')),
    rooms: toNumber(attr(it, 'ROOMS')),
    bedrooms: toNumber(attr(it, 'BEDROOMS')),
    bathrooms: toNumber(attr(it, 'FULL_BATHROOMS')),
    images: uniq([...pics, thumb]).slice(0, 15),
    published_at: it.date_created || it.stop_time || null,
  };
}

// La página pública trae las tarjetas ("polycard") en el estado incrustado.
const OP_WORDS = { venta: /venta/i, alquiler: /alquiler(?! temporal)/i, temporal: /temporal/i };

export function parsePolycards(html, { operation, type } = {}) {
  const out = new Map();
  const seen = new Set();
  const walk = (v) => {
    if (!v || typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    if (v.polycard?.metadata?.id) {
      const pc = v.polycard;
      const md = pc.metadata;
      const comp = Object.fromEntries((pc.components || []).map((c) => [c.type, c[c.type]]));
      const texts = comp.attributes_list?.texts || [];
      const num = (re) => { const t = texts.find((x) => re.test(x)); return t ? toNumber(t.match(/\d[\d.,]*/)?.[0]) : null; };
      const headline = comp.headline?.text || '';
      const loc = comp.location?.text || '';
      const parts = loc.split(',').map((x) => x.trim()).filter(Boolean);
      const url = md.url ? 'https://' + md.url.replace(/^https?:\/\//, '') : null;
      if (!url) return;
      out.set(md.id, {
        source: 'mercadolibre',
        id: `mercadolibre:${md.id}`,
        url,
        title: comp.title?.text || null,
        operation: Object.keys(OP_WORDS).find((k) => OP_WORDS[k].test(headline)) || operation || null,
        type: guessType(headline, md.domain_id) || type || null,
        price: toNumber(comp.price?.current_price?.value ?? md.signal?.price),
        currency: comp.price?.current_price?.currency || md.signal?.currency || null,
        address: parts.length > 2 ? parts.slice(0, -2).join(', ') : null,
        neighborhood: parts.length > 1 ? parts[parts.length - 2] : null,
        city: parts[parts.length - 1] || null,
        // la vista de mapa trae las coordenadas de cada aviso
        lat: Number(md.latitude) || null,
        lng: Number(md.longitude) || null,
        area_total: num(/m².*tot/i),
        area_covered: num(/m².*cub/i) ?? num(/m²/),
        rooms: num(/amb/i),
        bedrooms: num(/dorm/i),
        bathrooms: num(/baño/i),
        images: uniq((pc.pictures?.pictures || []).map((p) => p.id && `https://http2.mlstatic.com/D_NQ_NP_${p.id}-O.webp`)),
      });
      return;
    }
    for (const k in v) walk(v[k]);
  };
  extractJsonBlobs(html).forEach(walk);
  return [...out.values()];
}

// Pide las fotos completas en lotes de 20 (la búsqueda trae solo la miniatura).
async function addPictures(listings, headers) {
  const byId = new Map(listings.map((l) => [l.id.split(':')[1], l]));
  const ids = [...byId.keys()];
  for (let i = 0; i < ids.length; i += 20) {
    try {
      const batch = await fetchJson(`https://api.mercadolibre.com/items?ids=${ids.slice(i, i + 20).join(',')}&attributes=id,pictures`, { headers });
      for (const r of batch) {
        const l = byId.get(r.body?.id);
        const pics = (r.body?.pictures || []).map((p) => p.secure_url || p.url);
        if (l && pics.length) l.images = uniq(pics).slice(0, 15);
      }
    } catch { /* nos quedamos con la miniatura */ }
    await sleep(300);
  }
}

export default {
  name: 'mercadolibre',
  label: 'Mercado Libre',
  async collect(cfg, log) {
    const token = await getToken();
    const out = [];
    if (token) {
      const headers = { authorization: `Bearer ${token}`, accept: 'application/json' };
      const pages = cfg.paginas_por_busqueda * 4; // 50 por página
      for (let p = 0; p < pages; p++) {
        const u = new URL(`https://api.mercadolibre.com/sites/MLA/search`);
        u.searchParams.set('category', CATEGORY);
        if (cfg.zona.mercadolibre_state_id) u.searchParams.set('state', cfg.zona.mercadolibre_state_id);
        u.searchParams.set('sort', 'date_desc');
        u.searchParams.set('limit', '50');
        u.searchParams.set('offset', String(p * 50));
        const data = await fetchJson(u.href, { headers });
        const items = (data.results || []).map(mapItem);
        out.push(...items);
        log(`  página ${p + 1}: ${items.length}`);
        if (items.length < 50) break;
        await sleep(500);
      }
      await addPictures(out, headers);
      return out.filter((l) => !l.operation || cfg.operaciones.includes(l.operation));
    }

    log('  sin token de API: leo la página pública');
    const zona = cfg.zona.mercadolibre || cfg.zona.argenprop;
    const maxPages = cfg.mercadolibre_paginas ?? 40; // ML muestra hasta 2000 resultados por búsqueda
    const pause = cfg.pausa_mercadolibre_ms ?? 800;
    const seen = new Map();

    // Lee una búsqueda completa (hasta maxPages). Devuelve el total que informa ML.
    const stats = [];
    // Rangos de precio para partir búsquedas que siguen pasando el límite de ML
    const RANGES = {
      venta: [[0, 60000], [60000, 90000], [90000, 120000], [120000, 160000], [160000, 220000], [220000, 320000], [320000, 500000], [500000, 1000000], [1000000, 100000000]].map(([a, b]) => `_PriceRange_${a}USD-${b}USD`),
      alquiler: [[0, 400000], [400000, 550000], [550000, 700000], [700000, 900000], [900000, 1200000], [1200000, 1800000], [1800000, 100000000000]].map(([a, b]) => `_PriceRange_${a}ARS-${b}ARS`),
    };
    const crawlSearch = async (base, op, type, label, filter = '', barrio = null, feat = null) => {
      let total = null, n = 0, raw = 0;
      // Vista de mapa: 100 avisos por página y con las coordenadas de cada uno
      for (let p = 0; p < maxPages * 50 / PER; p++) {
        const url = p ? `${base}_Desde_${p * PER + 1}${filter}_DisplayType_M_NoIndex_True` : `${base}${filter}_DisplayType_M`;
        let html;
        try { html = await fetchText(url); } catch (e) {
          log(`  ${label} p${p + 1}: ${e.message}`);
          if (e.status === 403 || e.status === 429) throw e;
          if (!p) return null; // no se pudo leer: no sabemos si hay más
          break;
        }
        if (!p) {
          total = toNumber(html.match(/<title>\s*([\d.]+)/)?.[1]);
          if (type === cfg.tipos[0] && op === cfg.operaciones[0] && !label.includes('/')) dumpRaw('mercadolibre.html', html);
        }
        const page = parsePolycards(html, { operation: op, type });
        if (barrio) for (const l of page) l.neighborhood ||= barrioName(barrio);
        const items = page.filter((l) => !seen.has(l.id));
        // los que ya vinieron en la búsqueda general se enteran acá de su barrio
        if (barrio) for (const l of page) { const o = seen.get(l.id); if (o && !o.neighborhood) o.neighborhood = l.neighborhood; }
        // búsquedas con filtro de ML (apto crédito, cochera, patio): marcan esa característica
        if (feat) for (const l of page) { l[feat] = true; const o = seen.get(l.id); if (o) o[feat] = true; }
        items.forEach((l) => seen.set(l.id, l));
        out.push(...items);
        n += items.length;
        raw += page.length;
        if (!page.length || (total != null && (p + 1) * PER >= total)) break;
        await sleep(pause);
      }
      log(`  ${label}: ${n} (ML informa ${total ?? '?'})`);
      stats.push(`${label}:${n}/${raw}`);
      // si ML no dice el total, llegar al tope de páginas indica que hay más
      return total ?? (raw >= maxPages * 50 * 0.95 ? Infinity : raw);
    };

    // Todas las búsquedas no entran en una sola corrida: hay un tiempo máximo y la próxima
    // sigue donde quedó (progreso guardado en state/mercadolibre.json).
    const progPath = cfg._state ? join(cfg._state, 'mercadolibre.json') : null;
    let prog = { capped: [], next: null };
    try { if (progPath) prog = { ...prog, ...JSON.parse(await readFile(progPath, 'utf8')) }; } catch { /* primera vez */ }
    const capped = new Set(prog.capped);
    const cap = maxPages * 50;
    // Características que ML deja filtrar: cada búsqueda filtrada marca a sus avisos
    const FEATURES = {
      credito: { path: 'apto-credito/', filter: '' },
      cochera: { path: '', filter: '_PARKING*LOTS_1-*' },
      patio: { path: '', filter: '_HAS*GARDEN_242085' },
    };
    const FEATURE_TYPES = ['departamento', 'ph', 'casa'];
    const tasks = () => {
      const t = [];
      const add = (op, type, feat) => {
        const f = feat ? FEATURES[feat] : { path: '', filter: '' };
        const base = `https://inmuebles.mercadolibre.com.ar/${TYPE_SLUG[type]}/${OP_SLUG[op]}/${f.path}${zona}/`;
        const main = `${feat ? feat + ':' : ''}${type}/${op}`;
        t.push({ label: main, base, filter: f.filter, op, type, feat });
        // Si hay más de lo que ML deja ver en una búsqueda, se parte por barrio y después por precio
        if (!capped.has(main)) return;
        for (const barrio of cfg.zona.barrios || []) {
          const lb = `${main}/${barrio}`;
          t.push({ label: lb, base: `${base}${barrio}/`, filter: f.filter, op, type, barrio, feat });
          if (!capped.has(lb)) continue;
          for (const r of RANGES[op] || []) t.push({ label: `${lb}${r.replace('_PriceRange', '')}`, base: `${base}${barrio}/`, filter: f.filter + r, op, type, barrio, feat });
        }
      };
      for (const op of cfg.operaciones) for (const type of cfg.tipos) if (TYPE_SLUG[type]) add(op, type);
      for (const feat of Object.keys(FEATURES)) {
        for (const op of cfg.operaciones) for (const type of FEATURE_TYPES) if (cfg.tipos.includes(type)) add(op, type, feat);
      }
      return t;
    };
    const deadline = Date.now() + (cfg.mercadolibre_minutos ?? 150) * 60000;
    let list = tasks();
    let i = Math.max(0, list.findIndex((x) => x.label === prog.next));
    let done = 0;
    while (done < list.length && Date.now() < deadline) {
      const t = list[i % list.length];
      const total = await crawlSearch(t.base, t.op, t.type, t.label, t.filter, t.barrio, t.feat);
      const was = capped.has(t.label);
      if (total == null) { /* error suelto: se deja como estaba */ } else if (total > cap) capped.add(t.label); else capped.delete(t.label);
      done++;
      if (was !== capped.has(t.label)) {
        // cambió la lista de búsquedas: seguimos justo después de la actual
        list = tasks();
        i = list.findIndex((x) => x.label === t.label);
      }
      i = (i + 1) % list.length;
    }
    const next = done < list.length ? list[i % list.length].label : null;
    log(`  ${done} búsquedas de ${list.length}${next ? `, la próxima corrida sigue en ${next}` : ', vuelta completa'}`);
    if (progPath) await writeFile(progPath, JSON.stringify({ capped: [...capped], next }));
    if (process.env.GITHUB_ACTIONS) console.log(`::notice title=Mercado Libre::${stats.join(' ')}`);
    return out;
  },
};
