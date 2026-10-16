// Mercado Libre Inmuebles, por la API oficial (developers.mercadolibre.com.ar).
// La búsqueda pública pide un token: creá una app gratis en
// https://developers.mercadolibre.com.ar/devcenter y guardá ML_CLIENT_ID y
// ML_CLIENT_SECRET como secrets del repositorio. Si no hay token, se intenta
// leer la página pública de resultados.

import { dumpRaw, fetchJson, fetchText, guessOperation, guessType, sleep, toNumber, uniq } from '../lib/util.mjs';
import { extractJsonBlobs } from '../lib/embedded.mjs';

const CATEGORY = 'MLA1459'; // Inmuebles
const OP_SLUG = { venta: 'venta', alquiler: 'alquiler', temporal: 'alquiler-temporal' };
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

    log('  sin token de API: intento con la página pública');
    const zona = cfg.zona.mercadolibre || cfg.zona.argenprop;
    for (const op of cfg.operaciones) {
      for (const type of cfg.tipos) {
        if (!TYPE_SLUG[type]) continue;
        for (let p = 0; p < cfg.paginas_por_busqueda; p++) {
          const desde = p ? `_Desde_${p * 50 + 1}` : '';
          const url = `https://inmuebles.mercadolibre.com.ar/${TYPE_SLUG[type]}/${OP_SLUG[op]}/${zona}/${desde}`;
          const html = await fetchText(url);
          if (!p && type === cfg.tipos[0] && op === cfg.operaciones[0]) dumpRaw('mercadolibre.html', html);
          const items = parsePolycards(html, { operation: op, type });
          out.push(...items);
          log(`  ${type}/${op} p${p + 1}: ${items.length}`);
          if (!items.length) break;
          await sleep(cfg.pausa_entre_pedidos_ms);
        }
      }
    }
    return out;
  },
};
