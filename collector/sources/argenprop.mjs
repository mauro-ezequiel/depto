// Argenprop: el listado viene armado en el HTML.
import * as cheerio from 'cheerio';
import { crawl } from '../lib/crawl.mjs';
import { absUrl, cleanText, parsePrice, toNumber, uniq } from '../lib/util.mjs';

const TYPES = { departamento: 'departamentos', ph: 'ph', casa: 'casas', local: 'locales', oficina: 'oficinas', terreno: 'terrenos' };
const OPS = { venta: 'venta', alquiler: 'alquiler', temporal: 'alquiler-temporal' };

export function parseArgenprop(html, { base, operation, type }) {
  const $ = cheerio.load(html);
  const out = [];
  $('.listing__item a.card, a.card[href]').each((_, el) => {
    const card = $(el);
    const url = absUrl(card.attr('href'), base);
    if (!url || !/argenprop\.com\/.+--\d+/.test(url)) return;
    const priceText = cleanText(card.find('.card__price').first().text());
    const { price, currency } = parsePrice(priceText);
    const expText = cleanText(card.find('.card__expenses').first().text());
    const feats = card.find('.card__main-features li, .card__common-data span').map((_, li) => cleanText($(li).text())).get();
    const feat = (re) => { const f = feats.find((t) => re.test(t)); return f ? toNumber(f.match(/\d[\d.,]*/)?.[0]) : null; };
    const images = uniq(card.find('img').map((_, img) => $(img).attr('data-src') || $(img).attr('src')).get()
      .filter((s) => s && !s.startsWith('data:'))
      .map((s) => absUrl(s, base)));
    const title = cleanText(card.find('.card__title--primary, .card__title').first().text());
    const id = card.attr('data-item-card') || url.match(/--(\d+)/)?.[1];
    out.push({
      source: 'argenprop',
      id: `argenprop:${id}`,
      url,
      title: cleanText(card.find('.card__title').last().text()) || title,
      operation,
      type,
      price: /consultar/i.test(priceText || '') ? null : price,
      currency,
      expenses: expText ? toNumber(expText.match(/\d[\d.,]*/)?.[0]) : null,
      address: cleanText(card.find('.card__address').first().text()),
      neighborhood: title?.includes(',') ? title.split(',')[0].split(' en ').pop().trim() : null,
      city: title?.split(',').pop()?.trim() || null,
      lat: null,
      lng: null,
      area_total: feat(/m².*tot|tot.*m²/i),
      area_covered: feat(/m².*cub|cub/i) ?? feat(/m²/),
      rooms: feat(/amb/i),
      bedrooms: feat(/dorm/i),
      bathrooms: feat(/baño/i),
      images,
      published_at: null,
    });
  });
  return out;
}

export default {
  name: 'argenprop',
  label: 'Argenprop',
  collect: (cfg, log) => crawl(cfg, log, {
    source: 'argenprop',
    typeSlugs: TYPES,
    buildUrl: ({ op, slug, page }) =>
      `https://www.argenprop.com/${slug}/${OPS[op]}/${cfg.zona.argenprop}${page > 1 ? `?pagina-${page}` : ''}`,
    parse: parseArgenprop,
  }),
};
