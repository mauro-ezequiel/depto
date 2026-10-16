// RE/MAX Argentina: la web pide los avisos a una API JSON propia.
// El filtro de zona de esa API usa ids internos, así que pedimos lo último
// publicado en todo el país y filtramos por el recuadro de la zona (config.zona.bbox).
import { dump, fetchJson, guessType, sleep, toNumber, uniq } from '../lib/util.mjs';

const API = 'https://api-ar.redremax.com/remaxweb-ar/api/listings/findAll';
const IMG = 'https://d1acdg20u0pmxj.cloudfront.net/';
const OP_ID = { venta: 1, alquiler: 2, temporal: 3 };
const OP_FROM = { sale: 'venta', rent: 'alquiler', temporary_rent: 'temporal' };
const TYPE_FROM = {
  apartment: 'departamento', departamento: 'departamento', ph: 'ph', house: 'casa', casa: 'casa',
  local: 'local', office: 'oficina', oficina: 'oficina', land: 'terreno', terreno: 'terreno', lote: 'terreno',
  garage: 'cochera', cochera: 'cochera', warehouse: 'galpon', galpon: 'galpon',
};

export function mapRemax(x, op) {
  if (!x?.slug) return null;
  const [lng, lat] = x.location?.coordinates || [];
  const info = (x.addressInfo || '').split(',').map((s) => s.trim()).filter(Boolean);
  const t = String(x.type?.value || '').toLowerCase();
  return {
    source: 'remax',
    id: `remax:${x.id}`,
    url: `https://www.remax.com.ar/listings/${x.slug}`,
    title: x.title || null,
    operation: OP_FROM[x.operation?.value] || op || null,
    type: TYPE_FROM[t] || guessType(t, x.title),
    price: x.priceExposure === false ? null : toNumber(x.price),
    currency: x.currency?.value || null,
    expenses: toNumber(x.expensesPrice),
    address: x.displayAddress || null,
    neighborhood: info[0] || null,
    city: info.slice(1).join(', ') || null,
    lat: toNumber(lat),
    lng: toNumber(lng),
    area_total: toNumber(x.dimensionTotalBuilt) || toNumber(x.dimensionLand) || null,
    area_covered: toNumber(x.dimensionCovered) || null,
    rooms: toNumber(x.totalRooms) || null,
    bedrooms: toNumber(x.bedrooms) || null,
    bathrooms: toNumber(x.bathrooms) || null,
    images: uniq((x.photos || []).sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
      .map((p) => p.value && (p.value.startsWith('http') ? p.value : IMG + p.value))).slice(0, 15),
  };
}

function inBox(l, box) {
  if (!box) return true;
  if (l.lat == null || l.lng == null) return false;
  return l.lat >= box.sur && l.lat <= box.norte && l.lng >= box.oeste && l.lng <= box.este;
}

export default {
  name: 'remax',
  label: 'RE/MAX',
  async collect(cfg, log) {
    const out = [];
    const pages = cfg.remax_paginas ?? 10;
    for (const op of cfg.operaciones) {
      if (!OP_ID[op]) continue;
      let kept = 0;
      for (let page = 0; page < pages; page++) {
        const data = await fetchJson(`${API}?page=${page}&pageSize=100&sort=-createdAt&in:operationId=${OP_ID[op]}`, {
          headers: { accept: 'application/json', origin: 'https://www.remax.com.ar' },
        });
        const rows = data?.data?.data || [];
        const items = rows.map((x) => mapRemax(x, op)).filter(Boolean).filter((l) => inBox(l, cfg.zona.bbox));
        if (page === 0 && process.env.DEBUG_DUMP && items[0]?.images[0]) {
          const r = await fetch(items[0].images[0], { method: 'HEAD' }).catch((e) => ({ status: e.message }));
          dump('remax-imagen', { url: items[0].images[0], status: r.status, type: r.headers?.get?.('content-type') });
        }
        kept += items.length;
        out.push(...items);
        if (rows.length < 100) break;
        await sleep(1500);
      }
      log(`  ${op}: ${kept} en la zona`);
    }
    return out;
  },
};
