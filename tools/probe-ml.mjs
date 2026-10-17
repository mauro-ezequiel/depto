// Muestras de Mercado Libre para ver qué datos trae cada vista (lista, mapa, ficha).
import { mkdirSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';
const B = 'https://inmuebles.mercadolibre.com.ar/departamentos/venta/capital-federal/flores/';
const URLS = {
  lista: B,
  mapa: `${B}_DisplayType_M`,
  mapa2: `${B}_DisplayType_M_NoIndex_True`,
  desktop: B,
};
mkdirSync('debug', { recursive: true });
for (const [name, url] of Object.entries(URLS)) {
  const ua = name === 'desktop' ? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36' : UA;
  try {
    const res = await fetch(url, { headers: { 'user-agent': ua, 'accept-language': 'es-AR,es;q=0.9', accept: 'text/html,*/*' }, signal: AbortSignal.timeout(25000) });
    const body = await res.text();
    console.log(name, res.status, res.url, body.length, (body.match(/"latitude"/g) || []).length, (body.match(/D_NQ_NP_/g) || []).length);
    writeFileSync(`debug/ml-${name}.html.gz`, gzipSync(body));
  } catch (e) { console.log(name, e.message); }
}
