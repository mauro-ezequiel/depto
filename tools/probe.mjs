// Prueba qué portales inmobiliarios se dejan leer desde GitHub Actions.
// Uso: node tools/probe.mjs  -> escribe debug/probe.json
import { mkdirSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';
const SITES = {
  trovit: 'https://casas.trovit.com.ar/index.php/cod.search_homes/type.1/what_d.capital%20federal/origin.2/rooms_min.0/bathrooms_min.0/order_by.source_date/',
  mitula: 'https://casas.mitula.com.ar/casas/departamentos-capital-federal',
  nuroa: 'https://www.nuroa.com.ar/venta/departamentos-capital-federal',
  clarin: 'https://inmuebles.clarin.com/departamentos-venta-capital-federal',
  buscainmueble: 'https://www.buscainmueble.com/departamentos/venta/capital-federal',
  century21: 'https://century21.com.ar/propiedades/departamento/venta/capital-federal',
  coldwell: 'https://www.coldwellbanker.com.ar/propiedades',
  kw: 'https://www.kw.com.ar/propiedades',
  toribio: 'https://www.toribioachaval.com/propiedades',
  ljramos: 'https://www.ljramos.com.ar/propiedades',
  soldati: 'https://www.soldatipropiedades.com.ar/propiedades',
  properstar: 'https://www.properstar.com.ar/argentina/buenos-aires/venta/departamento',
  doomos: 'https://www.doomos.com.ar/de/venta-departamentos-capital-federal.html',
  icasas: 'https://www.icasas.com.ar/venta/departamentos-capital-federal',
  tokko_demo: 'https://www.tokkobroker.com/api/v1/property/?format=json&limit=1',
  inmuebles24: 'https://www.argenprop.com/',
};

mkdirSync('debug', { recursive: true });
const out = {};
for (const [name, url] of Object.entries(SITES)) {
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'es-AR,es;q=0.9', accept: 'text/html,*/*' }, redirect: 'follow', signal: AbortSignal.timeout(25000) });
    const body = await res.text();
    out[name] = {
      url, final: res.url, status: res.status, len: body.length,
      title: body.match(/<title[^>]*>([^<]*)/i)?.[1]?.trim().slice(0, 120),
      challenge: /just a moment|human verification|captcha|access denied|cf-chl/i.test(body.slice(0, 5000)),
      jsonld: (body.match(/application\/ld\+json/g) || []).length,
      nextdata: body.includes('__NEXT_DATA__'),
      prices: (body.match(/(U\$S|USD|US\$)\s?[\d.]{5,}/g) || []).length,
    };
    if (res.ok && body.length > 5000) writeFileSync(`debug/probe-${name}.html.gz`, gzipSync(body));
  } catch (e) {
    out[name] = { url, error: e.message };
  }
  console.log(name, JSON.stringify(out[name]));
}
writeFileSync('debug/probe.json', JSON.stringify(out, null, 2));
