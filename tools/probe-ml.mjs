// Muestras de Mercado Libre para ver qué datos trae cada vista (lista, mapa, ficha).
import { mkdirSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';
const B = 'https://inmuebles.mercadolibre.com.ar/departamentos/venta/capital-federal/flores/';
const URLS = {
  mapa_p2a: `${B}_Desde_101_DisplayType_M_NoIndex_True`,
  mapa_p2b: `${B}_Desde_51_DisplayType_M_NoIndex_True`,
  mapa_p30: `${B}_Desde_2901_DisplayType_M_NoIndex_True`,
  mapa_precio: `${B}_PriceRange_60000USD-90000USD_DisplayType_M`,
  mapa_precio_p2: `${B}_Desde_101_PriceRange_60000USD-90000USD_DisplayType_M_NoIndex_True`,
  item: 'https://departamento.mercadolibre.com.ar/MLA-3558709502-_JM',
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
