// Completa los avisos de Mercado Libre con datos de la página del aviso
// (dormitorios, baños, m² totales/cubiertos, ubicación y todas las fotos),
// porque el listado de búsqueda trae solo una parte.
import { dumpRaw, fetchText, sleep, toNumber, uniq } from './util.mjs';

const LABELS = {
  bedrooms: /^dormitorios$/i,
  bathrooms: /^baños$/i,
  rooms: /^ambientes$/i,
  area_total: /^superficie total$/i,
  area_covered: /^superficie cubierta$/i,
  expenses: /^expensas$/i,
};

// Busca pares {"name"/"text": "Dormitorios", "value"/"value_name": "2"} en el JSON de la página.
export function parseMlDetail(html) {
  const out = {};
  const pairRe = /"(?:name|text|title|label)":"([^"]{3,40})"[^{}]{0,200}?"(?:value_name|value|subtitle)":"([^"]{1,40})"/g;
  let m;
  while ((m = pairRe.exec(html))) {
    const [, label, value] = m;
    for (const [k, re] of Object.entries(LABELS)) {
      if (out[k] == null && re.test(label.trim())) out[k] = toNumber(value);
    }
  }
  const lat = html.match(/"latitude":\s*(-?\d+\.\d+)/);
  const lng = html.match(/"longitude":\s*(-?\d+\.\d+)/);
  if (lat && lng) { out.lat = Number(lat[1]); out.lng = Number(lng[1]); }
  const pics = uniq([...html.matchAll(/https:\/\/http2\.mlstatic\.com\/D_NQ_NP_(?:2X_)?(\d+-MLA\d+_\d+)-[A-Z]\.(?:webp|jpg)/g)].map((x) => x[1]));
  if (pics.length) out.images = pics.slice(0, 15).map((id) => `https://http2.mlstatic.com/D_NQ_NP_${id}-O.webp`);
  return out;
}

export async function enrichMercadoLibre(listings, cfg, log) {
  const max = cfg.detalles_max ?? 250;
  let done = 0, ok = 0;
  for (const l of listings) {
    if (l.source !== 'mercadolibre' || l.detail_at || done >= max) continue;
    done++;
    try {
      const html = await fetchText(l.url);
      if (done === 1) dumpRaw('ml-item.html', html);
      const d = parseMlDetail(html);
      for (const [k, v] of Object.entries(d)) {
        if (v == null || (Array.isArray(v) && !v.length)) continue;
        if (k === 'images' && (l.images?.length || 0) >= v.length) continue;
        l[k] = v;
      }
      if (d.lat != null) delete l.approx;
      l.detail_at = new Date().toISOString();
      ok++;
    } catch (e) {
      log(`  ${l.url}: ${e.message}`);
      if (e.status === 403 || e.status === 429) break;
    }
    await sleep(cfg.pausa_detalles_ms ?? 1200);
  }
  log(`  completados ${ok} de ${done} avisos`);
}
