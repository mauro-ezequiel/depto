// Webs de inmobiliarias que publican sus avisos con datos estándar (schema.org
// RealEstateListing), como las hechas con Brokian (Coldwell Banker, LJ Ramos...).
// Para sumar otra inmobiliaria, agregala en config.json -> "inmobiliarias".
import { cleanText, fetchText, guessOperation, guessType, sleep, toNumber, uniq } from '../lib/util.mjs';

function listingsFromLd(html) {
  const out = [];
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try {
      const j = JSON.parse(m[1]);
      for (const x of [].concat(j['@graph'] || j)) if (x?.['@type'] === 'RealEstateListing') out.push(x);
    } catch { /* bloque roto */ }
  }
  return out;
}

function inBox(lat, lng, box) {
  if (!box) return true;
  if (lat == null || lng == null) return false;
  return lat >= box.sur && lat <= box.norte && lng >= box.oeste && lng <= box.este;
}

export function mapRealEstateListing(x, site) {
  const about = x.about || {};
  const addr = about.address || {};
  const offer = [].concat(x.offers || [])[0] || {};
  const url = x.url || offer.url;
  if (!url) return null;
  const lease = /Lease|Rent/i.test(`${offer['@type']} ${offer.businessFunction}`);
  return {
    source: 'inmobiliarias',
    id: `inmo:${url.replace(/^https?:\/\//, '')}`,
    url,
    title: cleanText(x.name),
    operation: lease ? 'alquiler' : guessOperation(x.name, url) || 'venta',
    type: guessType(about['@type'] === 'Apartment' ? 'departamento' : about['@type'] === 'House' || about['@type'] === 'SingleFamilyResidence' ? 'casa' : '', x.name, url),
    price: toNumber(offer.price),
    currency: offer.priceCurrency || null,
    address: cleanText(addr.streetAddress),
    neighborhood: cleanText(addr.addressLocality),
    city: cleanText(addr.addressRegion),
    lat: toNumber(about.geo?.latitude),
    lng: toNumber(about.geo?.longitude),
    area_total: toNumber(about.floorSize?.value),
    rooms: toNumber(about.numberOfRooms),
    bedrooms: toNumber(about.numberOfBedrooms),
    bathrooms: toNumber(about.numberOfBathroomsTotal),
    images: uniq([].concat(x.image || [], about.image || []).map((i) => (typeof i === 'string' ? i : i?.url))).slice(0, 15),
    publisher: site.nombre,
  };
}

export default {
  name: 'inmobiliarias',
  label: 'Inmobiliarias',
  async collect(cfg, log) {
    const out = [];
    let failed = 0;
    for (const site of cfg.inmobiliarias || []) {
      let n = 0;
      try {
        for (let page = 1; page <= (site.paginas ?? 5); page++) {
          const u = new URL(site.url);
          if (page > 1) u.searchParams.set('page', String(page));
          const items = listingsFromLd(await fetchText(u.href)).map((x) => mapRealEstateListing(x, site)).filter(Boolean);
          const inZone = items.filter((l) => inBox(l.lat, l.lng, cfg.zona.bbox));
          n += inZone.length;
          out.push(...inZone);
          if (!items.length) break;
          await sleep(cfg.pausa_entre_pedidos_ms);
        }
      } catch (e) {
        failed++;
        log(`  ${site.nombre}: ${e.message}`);
      }
      log(`  ${site.nombre}: ${n} en la zona`);
    }
    if (!out.length && failed) throw new Error('No se pudo leer ninguna inmobiliaria');
    return out;
  },
};
