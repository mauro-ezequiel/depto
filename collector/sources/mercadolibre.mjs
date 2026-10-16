// Mercado Libre Inmuebles, por la API oficial (developers.mercadolibre.com.ar).
// La búsqueda pública pide un token: creá una app gratis en
// https://developers.mercadolibre.com.ar/devcenter y guardá ML_CLIENT_ID y
// ML_CLIENT_SECRET como secrets del repositorio. Si no hay token, se intenta
// leer la página pública de resultados.

import { fetchJson, fetchText, guessOperation, guessType, sleep, toNumber, uniq } from '../lib/util.mjs';
import { listingsFromHtml } from '../lib/embedded.mjs';

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
    const zona = cfg.zona.argenprop; // mismo slug: capital-federal
    for (const op of cfg.operaciones) {
      for (const type of cfg.tipos) {
        if (!TYPE_SLUG[type]) continue;
        for (let p = 0; p < cfg.paginas_por_busqueda; p++) {
          const desde = p ? `_Desde_${p * 48 + 1}` : '';
          const url = `https://inmuebles.mercadolibre.com.ar/${TYPE_SLUG[type]}/${OP_SLUG[op]}/${zona}/${desde}`;
          const html = await fetchText(url);
          const items = listingsFromHtml(html, { source: 'mercadolibre', base: url, operation: op, type });
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
