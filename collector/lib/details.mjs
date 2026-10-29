// Completa los avisos de Mercado Libre con datos de la página del aviso
// (dormitorios, baños, m² totales/cubiertos, ubicación y todas las fotos),
// porque el listado de búsqueda trae solo una parte.
import { dumpRaw, fetchText, sleep, toNumber, uniq } from './util.mjs';

const DETAIL_V = 2;

const LABELS = {
  bedrooms: /^dormitorios$/i,
  bathrooms: /^baños$/i,
  rooms: /^ambientes$/i,
  area_total: /^superficie total$/i,
  area_covered: /^superficie cubierta$/i,
  expenses: /^expensas$/i,
};
// Datos de sí/no de la ficha
const FLAGS = {
  credito: /^apto cr[eé]dito$/i,
  balcon: /^balc[oó]n$/i,
  patio: /^(patio|jard[ií]n)$/i,
};

// Busca pares {"name"/"text": "Dormitorios", "value"/"value_name": "2"} en el JSON de la página.
export function parseMlDetail(html) {
  const out = {};
  // Dos formatos: {"name":"Dormitorios",...,"value_name":"2"} y la tabla {"id":"Dormitorios","text":"2"}
  const pairRes = [
    /"(?:name|text|title|label)":"([^"]{3,40})"[^{}]{0,200}?"(?:value_name|value|subtitle)":"([^"]{1,40})"/g,
    /"id":"([^"]{3,40})","text":"([^"]{1,40})"/g,
  ];
  for (const pairRe of pairRes) {
    let m;
    while ((m = pairRe.exec(html))) {
      const [, label, value] = m;
      for (const [k, re] of Object.entries(FLAGS)) {
        if (out[k] == null && re.test(label.trim()) && /^(s[ií]|no)$/i.test(value.trim())) out[k] = /^s/i.test(value.trim());
      }
      const num = value.match(/\d+(?:[.,]\d+)*/)?.[0];
      if (!num) continue;
      if (/^cocheras$/i.test(label.trim()) && out.cochera == null) out.cochera = toNumber(num) > 0;
      if (/^antig[uü]edad$/i.test(label.trim()) && out.antiguedad == null) out.antiguedad = toNumber(num);
      for (const [k, re] of Object.entries(LABELS)) {
        if (out[k] == null && re.test(label.trim())) out[k] = toNumber(num);
      }
    }
  }
  const lat = html.match(/"latitude":\s*(-?\d+\.\d+)/);
  const lng = html.match(/"longitude":\s*(-?\d+\.\d+)/);
  if (lat && lng) { out.lat = Number(lat[1]); out.lng = Number(lng[1]); }
  // La galería del aviso es el primer "pictures":[...] de la página (el resto pueden ser otros avisos)
  const gallery = html.match(/"pictures":\[(.*?)\]/)?.[1];
  let pics = gallery ? uniq([...gallery.matchAll(/"id":"(\d+-MLA\d+_\d+)"/g)].map((x) => x[1])) : [];
  if (!pics.length) pics = uniq([...html.matchAll(/https:\/\/http2\.mlstatic\.com\/D_NQ_NP_(?:2X_)?(\d+-MLA\d+_\d+)-[A-Z]\.(?:webp|jpg)/g)].map((x) => x[1]));
  if (pics.length) out.images = pics.slice(0, 40).map((id) => `https://http2.mlstatic.com/D_NQ_NP_${id}-O.webp`);
  return out;
}

// Prioridad: lo más buscado primero (venta hasta USD 150.000, alquileres comunes), y lo más nuevo.
function priority(l) {
  if (l.operation === 'venta' && l.currency === 'USD' && l.price && l.price <= 150000) return 0;
  if (l.operation !== 'venta' && l.currency === 'ARS' && l.price && l.price <= 1500000) return 1;
  return 2;
}

// Abre la ficha de cada aviso de Mercado Libre (trae todas las fotos, la ubicación exacta,
// dormitorios, baños, etc.). Son muchísimos: cada corrida hace los que entran en el tiempo
// máximo y la siguiente sigue con los que faltan.
export async function enrichMercadoLibre(listings, cfg, log, checkpoint) {
  const max = cfg.detalles_max ?? 250;
  const deadline = Date.now() + (cfg.detalles_minutos ?? 60) * 60000;
  const workers = cfg.detalles_paralelo ?? 1;
  const queue = listings.filter((l) => l.source === 'mercadolibre' && l.detail_v !== DETAIL_V)
    .sort((a, b) => priority(a) - priority(b) || (b.first_seen || '').localeCompare(a.first_seen || ''))
    .slice(0, max);
  const pending = queue.length;
  let done = 0, ok = 0, stop = false, blocks = 0;
  let pause = cfg.pausa_detalles_ms ?? 1200;
  const box = cfg.zona.bbox;
  const one = async (l) => {
    try {
      const html = await fetchText(l.url);
      if (done === 1) dumpRaw('ml-item.html', html);
      const d = parseMlDetail(html);
      if (d.lat != null && (!box || (d.lat >= box.sur && d.lat <= box.norte && d.lng >= box.oeste && d.lng <= box.este))) {
        l.lat = d.lat; l.lng = d.lng; delete l.approx;
      }
      delete d.lat; delete d.lng;
      for (const k of ['rooms', 'bedrooms', 'bathrooms']) if (d[k] === 0) delete d[k];
      for (const [k, v] of Object.entries(d)) {
        if (v == null || (Array.isArray(v) && !v.length)) continue;
        if (v === false && l[k] === true) continue; // si el título lo dice, no lo pisamos
        if (k === 'images' && (l.images?.length || 0) >= v.length) continue;
        l[k] = v;
      }
      l.detail_at = new Date().toISOString();
      l.detail_v = DETAIL_V;
      ok++;
      blocks = 0;
    } catch (e) {
      if (e.status === 404 || e.status === 410) { l.detail_v = DETAIL_V; return; } // aviso dado de baja
      log(`  ${l.url}: ${e.message}`);
      if (e.status === 403 || e.status === 429) {
        // ML frena si vamos rápido: esperamos y seguimos más despacio; si insiste, cortamos
        blocks++;
        if (blocks >= 4) stop = true;
        else { pause *= 2; await sleep(120000); }
        queue.unshift(l);
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: workers }, async () => {
    while (!stop && queue.length && Date.now() < deadline) {
      const l = queue.shift();
      done++;
      await one(l);
      // se guarda cada tanto: si el proceso se corta, lo hecho no se pierde
      if (checkpoint && done % 1000 === 0) await checkpoint();
      await sleep(pause);
    }
  }));
  const left = listings.filter((l) => l.source === 'mercadolibre' && l.detail_v !== DETAIL_V).length;
  log(`  completados ${ok} de ${done} (quedaban ${pending}; faltan ${left} para la próxima corrida)`);
  if (process.env.GITHUB_ACTIONS) console.log(`::notice title=Fichas Mercado Libre::completadas ${ok} de ${done}, faltan ${left}, bloqueos ${blocks}, pausa final ${pause} ms${stop ? ', cortado por bloqueo' : ''}`);
}
