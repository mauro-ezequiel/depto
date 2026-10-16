// RE/MAX Argentina: la web pide los avisos a una API JSON propia.
// Probamos esa API y, si cambia, leemos el estado incrustado en la página.
import { dump, fetchJson, fetchText, sleep } from '../lib/util.mjs';
import { findListingObjects, listingsFromHtml, mapGeneric } from '../lib/embedded.mjs';

const OP_ID = { venta: 1, alquiler: 2, temporal: 3 };
const OP_PATH = { venta: 'buy', alquiler: 'rent', temporal: 'temporary-rent' };

function fromRemaxJson(data, ctx) {
  return findListingObjects(data).map((o) => {
    const l = mapGeneric({ ...o, url: o.url || (o.slug ? `https://www.remax.com.ar/listings/${o.slug}` : null) }, ctx);
    if (l && Array.isArray(o.photos) && !l.images.length) {
      l.images = o.photos.map((p) => (typeof p === 'string' ? p : p.value || p.url))
        .filter((p) => typeof p === 'string' && p.startsWith('http')).slice(0, 15);
    }
    return l;
  }).filter(Boolean);
}

export default {
  name: 'remax',
  label: 'RE/MAX',
  async collect(cfg, log) {
    const out = [];
    for (const op of cfg.operaciones) {
      if (!OP_ID[op]) continue;
      for (let page = 0; page < cfg.paginas_por_busqueda; page++) {
        const ctx = { source: 'remax', base: 'https://www.remax.com.ar/', operation: op };
        let items = [];
        try {
          const api = `https://api-ar.redremax.com/remaxweb-ar/api/listings/findAll?page=${page}&pageSize=48&sort=-createdAt&in:operationId=${OP_ID[op]}&locations=in::::${encodeURIComponent(cfg.zona.nombre)}@`;
          const data = await fetchJson(api, { headers: { accept: 'application/json', origin: 'https://www.remax.com.ar' } });
          if (page === 0) dump(`remax-${op}`, { api, keys: Object.keys(data || {}), data: JSON.stringify(data).slice(0, 8000) });
          items = fromRemaxJson(data, ctx);
        } catch (e) {
          log(`  API: ${e.message}`);
        }
        if (!items.length) {
          const url = `https://www.remax.com.ar/listings/${OP_PATH[op]}?page=${page}&pageSize=48&sort=-createdAt`;
          items = listingsFromHtml(await fetchText(url), { ...ctx, base: url });
        }
        log(`  ${op} p${page + 1}: ${items.length}`);
        out.push(...items);
        if (!items.length) break;
        await sleep(cfg.pausa_entre_pedidos_ms);
      }
    }
    return out;
  },
};
