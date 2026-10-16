// Saca los datos JSON que los portales incrustan en su HTML
// (JSON-LD, __NEXT_DATA__, __PRELOADED_STATE__, estado de Angular, etc.)
// y busca adentro objetos que parezcan avisos de inmuebles.

import {
  absUrl, cleanText, guessOperation, guessType, normCurrency, toNumber, uniq,
} from './util.mjs';

// Lee un objeto/array JSON balanceado empezando en text[start] ('{' o '[').
function readBalanced(text, start) {
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function tryParse(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { /* sigue */ }
  // Angular escapa el estado con &q; &a; etc.
  try {
    return JSON.parse(s.replace(/&q;/g, '"').replace(/&a;/g, '&').replace(/&s;/g, "'").replace(/&l;/g, '<').replace(/&g;/g, '>'));
  } catch { return null; }
}

export function extractJsonBlobs(html) {
  const blobs = [];
  const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = scriptRe.exec(html))) {
    const attrs = m[1] || '';
    const body = (m[2] || '').trim();
    if (!body) continue;
    if (/application\/(ld\+)?json/i.test(attrs) || /id=["']__NEXT_DATA__["']/i.test(attrs)) {
      const j = tryParse(body);
      if (j) blobs.push(j);
      continue;
    }
    // window.__ALGO__ = {...};  /  var x = JSON.parse('...')
    const assignRe = /(?:window\.)?[A-Za-z_$][\w$.]*\s*=\s*([{[])/g;
    let a;
    while ((a = assignRe.exec(body))) {
      const start = a.index + a[0].length - 1;
      const raw = readBalanced(body, start);
      if (raw && raw.length > 200) {
        const j = tryParse(raw);
        if (j) blobs.push(j);
        assignRe.lastIndex = start + raw.length;
      }
    }
    const jp = body.match(/JSON\.parse\((['"])([\s\S]+?)\1\)/);
    if (jp) {
      try { const j = tryParse(JSON.parse(`"${jp[2].replace(/"/g, '\\"')}"`)); if (j) blobs.push(j); } catch { /* nada */ }
    }
  }
  return blobs;
}

const PRICE_KEYS = ['price', 'precio', 'amount', 'priceAmount', 'priceValue', 'operationPrice'];
const URL_KEYS = ['url', 'permalink', 'link', 'href', 'detailUrl', 'canonicalUrl', 'slug'];
const IMG_KEYS = ['images', 'pictures', 'photos', 'image', 'thumbnail', 'picture', 'fotos', 'visiblePictures', 'mainImage', 'photo'];

function pickImages(v, base, out = []) {
  if (!v || out.length > 30) return out;
  if (typeof v === 'string') {
    if (/^(https?:)?\/\/|^\//.test(v) && /\.(jpe?g|png|webp|avif)|\/(img|image|photo|picture|fotos?)\b|mlstatic|cloudfront|imgur/i.test(v)) {
      const u = absUrl(v.startsWith('//') ? 'https:' + v : v, base);
      if (u) out.push(u);
    }
    return out;
  }
  if (Array.isArray(v)) { for (const x of v) pickImages(x, base, out); return out; }
  if (typeof v === 'object') {
    // preferimos la versión más grande
    const prefer = ['url730x532', 'url1200x1200', 'original', 'large', 'secure_url', 'url', 'src', 'href', 'contentUrl', 'resizeUrl'];
    for (const k of prefer) if (typeof v[k] === 'string') { pickImages(v[k], base, out); return out; }
    for (const k of ['pictures', 'images', 'photos']) if (v[k]) pickImages(v[k], base, out);
  }
  return out;
}

function firstKey(o, keys) {
  for (const k of keys) if (o[k] != null && o[k] !== '') return o[k];
  return null;
}

function readPrice(o) {
  // formatos típicos: price: 120000 | price: {amount, currency} | offers: {price, priceCurrency}
  // | priceOperationTypes: [{operationType:{name}, prices:[{amount,currency}]}]
  if (Array.isArray(o.priceOperationTypes) && o.priceOperationTypes[0]) {
    const pot = o.priceOperationTypes[0];
    const p = (pot.prices || [])[0] || {};
    return {
      price: toNumber(p.amount), currency: normCurrency(p.currency || p.currencyId),
      operation: guessOperation(pot.operationType?.name),
    };
  }
  if (o.offers) {
    const of = Array.isArray(o.offers) ? o.offers[0] : o.offers;
    if (of && (of.price != null || of.lowPrice != null)) {
      return { price: toNumber(of.price ?? of.lowPrice), currency: normCurrency(of.priceCurrency) };
    }
  }
  const p = firstKey(o, PRICE_KEYS);
  if (p == null) return null;
  if (typeof p === 'object') {
    return {
      price: toNumber(p.amount ?? p.value ?? p.price ?? p.formatted),
      currency: normCurrency(p.currency ?? p.currency_id ?? p.currencyId ?? p.symbol),
    };
  }
  return {
    price: toNumber(p),
    currency: normCurrency(o.currency ?? o.currency_id ?? o.currencyId ?? o.priceCurrency ?? o.currencySymbol),
  };
}

function readFeature(o, ...names) {
  for (const n of names) {
    if (o[n] != null && typeof o[n] !== 'object') return toNumber(o[n]);
    if (o[n] && typeof o[n] === 'object' && 'value' in o[n]) return toNumber(o[n].value);
  }
  // Zonaprop: mainFeatures: { CFT100: {label:'Superficie total', value:'50'} }
  const feats = o.mainFeatures || o.features || o.attributes;
  if (feats && typeof feats === 'object') {
    const list = Array.isArray(feats) ? feats : Object.values(feats);
    for (const f of list) {
      if (!f || typeof f !== 'object') continue;
      const label = String(f.label ?? f.name ?? f.id ?? '').toLowerCase();
      for (const n of names) {
        if (label.includes(n.toLowerCase())) return toNumber(f.value ?? f.value_name ?? f.values?.[0]?.name);
      }
    }
  }
  return null;
}

function readAddress(o) {
  const loc = o.postingLocation || o.location || o.address || o.ubicacion || o.geo || {};
  let address = null, neighborhood = null, city = null, lat = null, lng = null;
  if (typeof loc === 'string') address = loc;
  else {
    address = cleanText(loc.address?.name ?? loc.streetAddress ?? loc.address_line ?? (typeof loc.address === 'string' ? loc.address : null) ?? o.address_line ?? o.fullAddress ?? (typeof o.address === 'string' ? o.address : null));
    neighborhood = cleanText(loc.location?.name ?? loc.neighborhood?.name ?? loc.neighborhood ?? loc.addressLocality ?? loc.city?.name ?? o.neighborhood);
    city = cleanText(loc.location?.parent?.name ?? loc.city?.name ?? loc.state?.name ?? loc.addressRegion ?? null);
    const g = loc.postingGeolocation?.geolocation || loc.geolocation || loc.geo || loc;
    lat = toNumber(g.latitude ?? g.lat); lng = toNumber(g.longitude ?? g.lng ?? g.lon);
  }
  return { address, neighborhood, city, lat, lng };
}

// ¿Parece un aviso? Necesita precio + (url o id) + (título o dirección o imágenes).
function looksLikeListing(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
  const hasPrice = PRICE_KEYS.some((k) => o[k] != null) || o.priceOperationTypes || o.offers;
  const hasLink = URL_KEYS.some((k) => typeof o[k] === 'string') || o.postingId || o.id;
  const hasDesc = o.title || o.name || o.address || o.postingLocation || IMG_KEYS.some((k) => o[k]);
  return Boolean(hasPrice && hasLink && hasDesc);
}

export function findListingObjects(root, max = 500) {
  const found = [];
  const seen = new Set();
  const walk = (v, depth) => {
    if (!v || typeof v !== 'object' || depth > 14 || found.length >= max || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    if (looksLikeListing(v)) { found.push(v); return; }
    for (const k in v) walk(v[k], depth + 1);
  };
  walk(root, 0);
  return found;
}

// Convierte un objeto "con pinta de aviso" en nuestro formato común.
export function mapGeneric(o, { source, base, operation, type }) {
  const rawUrl = firstKey(o, URL_KEYS);
  let url = typeof rawUrl === 'string' ? absUrl(rawUrl, base) : null;
  if (!url) return null;
  const pr = readPrice(o) || {};
  const title = cleanText(o.title ?? o.name ?? o.generatedTitle ?? o.headline);
  const addr = readAddress(o);
  const images = uniq(pickImages(IMG_KEYS.map((k) => o[k]), base)).slice(0, 15);
  const typeText = o.realEstateType?.name ?? o.propertyType?.name ?? o.propertyType ?? o.type?.name ?? o.typeName ?? o['@type'];
  return {
    source,
    id: `${source}:${o.postingId ?? o.id ?? o.listingId ?? url}`,
    url,
    title,
    operation: pr.operation || guessOperation(o.operationType?.name, o.operation?.name, o.operation, url) || operation || null,
    type: guessType(typeof typeText === 'string' ? typeText : '', title, url) || type || null,
    price: pr.price ?? null,
    currency: pr.currency ?? null,
    expenses: toNumber(o.expenses?.amount ?? o.expenses ?? o.expensas),
    ...addr,
    area_total: readFeature(o, 'totalSurface', 'surfaceTotal', 'total_area', 'Superficie total', 'Sup. total', 'm² totales'),
    area_covered: readFeature(o, 'coveredSurface', 'surfaceCovered', 'covered_area', 'Superficie cubierta', 'm² cubiertos'),
    rooms: readFeature(o, 'rooms', 'ambientes', 'numberOfRooms', 'Ambientes', 'totalRooms'),
    bedrooms: readFeature(o, 'bedrooms', 'dormitorios', 'Dormitorios', 'numberOfBedrooms'),
    bathrooms: readFeature(o, 'bathrooms', 'baños', 'Baños', 'numberOfBathroomsTotal'),
    images,
    published_at: o.publishDate ?? o.datePosted ?? o.createdAt ?? o.date_created ?? o.publicationDate ?? null,
  };
}

export function listingsFromHtml(html, ctx) {
  const out = [];
  for (const blob of extractJsonBlobs(html)) {
    for (const o of findListingObjects(blob)) {
      const l = mapGeneric(o, ctx);
      if (l) out.push(l);
    }
  }
  return out;
}
