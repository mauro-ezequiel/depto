// Prueba qué páginas de terrenos se pueden leer desde GitHub Actions.
import { mkdirSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';
const URLS = {
  nuroa_caba: 'https://www.nuroa.com.ar/venta/terrenos-capital-federal',
  nuroa_bsas: 'https://www.nuroa.com.ar/venta/terrenos-buenos-aires',
  nuroa_gba: 'https://www.nuroa.com.ar/venta/terrenos-gran-buenos-aires',
  argenprop_caba: 'https://www.argenprop.com/terrenos/venta/capital-federal',
  argenprop_gba: 'https://www.argenprop.com/terrenos/venta/gba-norte',
  argenprop_deptos: 'https://www.argenprop.com/departamentos/venta/capital-federal',
  zonaprop: 'https://www.zonaprop.com.ar/terrenos-venta-capital-federal.html',
  properati: 'https://www.properati.com.ar/s/capital-federal/terreno/venta',
  remax_web: 'https://www.remax.com.ar/listings/buy?page=0&pageSize=24',
  ljramos: 'https://ljramos.com/propiedades?page=1',
  coldwell: 'https://coldwellbanker.com.ar/propiedades?page=1',
};
mkdirSync('debug', { recursive: true });
for (const [name, url] of Object.entries(URLS)) {
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'es-AR,es;q=0.9', accept: 'text/html,*/*' }, signal: AbortSignal.timeout(25000) });
    const body = await res.text();
    const cards = (body.match(/listing-card|card__price|nu_flat_|RealEstateListing/g) || []).length;
    console.log(name, res.status, res.url.slice(0, 120), body.length, 'cards', cards, (body.match(/<title>[^<]*/) || [''])[0].slice(0, 100));
    if (res.ok) writeFileSync(`debug/t-${name}.html.gz`, gzipSync(body));
  } catch (e) { console.log(name, e.message); }
}
