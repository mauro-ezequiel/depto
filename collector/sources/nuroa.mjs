// Nuroa: buscador que junta avisos de muchos portales e inmobiliarias chicas.
// Cada tarjeta trae título, precio, fotos y la inmobiliaria; el JSON-LD de la
// página agrega coordenadas, dormitorios, baños y m².
import * as cheerio from 'cheerio';
import { cleanText, fetchText, guessType, sleep, toNumber, uniq } from '../lib/util.mjs';

const TYPES = { departamento: 'departamentos', ph: 'ph', casa: 'casas', local: 'locales', oficina: 'oficinas', terreno: 'terrenos' };
const OPS = { venta: 'venta', alquiler: 'alquiler' };

function ldItems(html) {
  const items = [];
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try {
      const j = JSON.parse(m[1]);
      if (j['@type'] === 'SearchResultsPage' && Array.isArray(j.about)) items.push(...j.about);
    } catch { /* bloque roto, se ignora */ }
  }
  return items;
}

function inBox(lat, lng, box) {
  if (!box || lat == null || lng == null) return true;
  return lat >= box.sur && lat <= box.norte && lng >= box.oeste && lng <= box.este;
}

export function parseNuroa(html, { operation, type, box } = {}) {
  const $ = cheerio.load(html);
  const ld = ldItems(html);
  const byImg = new Map(ld.filter((x) => x.image).map((x) => [x.image, x]));
  const out = [];
  $('.listing-card').each((i, el) => {
    const card = $(el);
    const row = card.closest('[id^="nu_flat_"]');
    const id = row.attr('id')?.replace('nu_flat_', '');
    const a = card.find('.listing-card__title a').first();
    const url = a.attr('href');
    if (!id || !url) return;
    const images = uniq(card.find('img.listing-img').map((_, img) => $(img).attr('data-src') || $(img).attr('src')).get()
      .filter((s) => s && s.startsWith('http')));
    const meta = byImg.get(images[0]) || ld[i] || {};
    const props = card.find('.listing-card__property span').map((_, s) => cleanText($(s).text())).get();
    const prop = (re) => { const t = props.find((x) => re.test(x)); return t ? toNumber(t.match(/\d[\d.,]*/)?.[0]) : null; };
    const lat = toNumber(meta.geo?.latitude), lng = toNumber(meta.geo?.longitude);
    if (!inBox(lat, lng, box)) return;
    const title = cleanText(a.text());
    const partner = cleanText(card.find('.partner').text());
    out.push({
      source: 'nuroa',
      id: `nuroa:${id}`,
      url,
      title,
      operation,
      type: guessType(title) || type,
      price: toNumber(card.find('[itemprop="price"]').attr('content')),
      currency: card.find('[itemprop="priceCurrency"]').attr('content') || null,
      neighborhood: null,
      city: null,
      lat, lng,
      area_total: toNumber(meta.floorSize?.value) ?? prop(/m²/),
      rooms: prop(/amb/i),
      bedrooms: toNumber(meta.numberOfBedrooms) ?? prop(/dorm/i),
      bathrooms: toNumber(meta.numberOfBathroomsTotal) ?? prop(/baño/i),
      images: images.slice(0, 15),
      publisher: partner || null,
    });
  });
  return out;
}

// Nuroa devuelve una página mínima (~1 KB) cuando vamos muy rápido: esperamos y reintentamos una vez
async function getPage(url) {
  let html = await fetchText(url);
  if (html.length < 5000) {
    await sleep(90000);
    html = await fetchText(url);
    if (html.length < 5000) { const e = new Error('Nuroa frenó los pedidos (página vacía)'); e.status = 429; throw e; }
  }
  return html;
}

export default {
  name: 'nuroa',
  label: 'Nuroa',
  async collect(cfg, log) {
    const out = [];
    const zona = cfg.zona.nuroa || 'capital-federal';
    const pages = cfg.nuroa_paginas ?? 4;
    let stopped = false;
    // Terrenos: Capital y Gran Buenos Aires (hay pocos baldíos en Capital)
    const t = cfg.terrenos;
    if (t?.nuroa?.length) {
      for (const slug of t.nuroa) {
        if (stopped) break;
        let n = 0;
        for (let page = 1; page <= (t.nuroa_paginas ?? 100); page++) {
          const url = `https://www.nuroa.com.ar/venta/${slug}${page > 1 ? `?page=${page}` : ''}`;
          let items;
          try {
            const html = await getPage(url);
            const all = parseNuroa(html, { operation: 'venta', type: 'terreno' });
            items = parseNuroa(html, { operation: 'venta', type: 'terreno', box: t.bbox }).map((l) => ({ ...l, type: 'terreno' }));
            if (page === 1 && process.env.GITHUB_ACTIONS) {
              console.log(`::notice title=Terrenos::${slug} p1: html ${html.length}, ${html.match(/<title>[^<]*/)?.[0]?.slice(7, 90)}, avisos ${all.length}, en zona ${items.length}, ej ${all[0]?.lat},${all[0]?.lng}`);
            }
          } catch (e) {
            log(`  ${slug} p${page}: ${e.message}`);
            if (process.env.GITHUB_ACTIONS) console.log(`::notice title=Terrenos::${slug} p${page}: ${e.message.slice(0, 200)}`);
            if (e.status === 403 || e.status === 429) stopped = true; // se guarda lo leído hasta acá
            break;
          }
          n += items.length;
          out.push(...items);
          if (!items.length && page > 3) break;
          await sleep(cfg.pausa_entre_pedidos_ms);
        }
        log(`  ${slug}: ${n}`);
        if (process.env.GITHUB_ACTIONS) console.log(`::notice title=Terrenos::${slug}: ${n} terrenos`);
      }
    }
    for (const op of cfg.operaciones) {
      if (!OPS[op]) continue;
      for (const type of cfg.tipos) {
        if (!TYPES[type]) continue;
        if (stopped) break;
        let n = 0;
        for (let page = 1; page <= pages; page++) {
          const url = `https://www.nuroa.com.ar/${OPS[op]}/${TYPES[type]}-${zona}${page > 1 ? `?page=${page}` : ''}`;
          let items;
          try {
            items = parseNuroa(await getPage(url), { operation: op, type, box: cfg.zona.bbox });
          } catch (e) {
            log(`  ${type}/${op} p${page}: ${e.message}`);
            if ((e.status === 403 || e.status === 429) && !out.length) throw e;
            if (e.status === 403 || e.status === 429) stopped = true;
            break; // un error suelto (ej. 500) no frena las demás búsquedas
          }
          n += items.length;
          out.push(...items);
          if (!items.length) break;
          await sleep(cfg.pausa_entre_pedidos_ms);
        }
        log(`  ${type}/${op}: ${n}`);
      }
    }
    return out;
  },
};
