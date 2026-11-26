// Muestras de Mercado Libre y RE/MAX para ver qué devuelven hoy.
import { mkdirSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';
const B = 'https://inmuebles.mercadolibre.com.ar/departamentos/venta/capital-federal/flores/';
const URLS = {
  ml_lista: B,
  ml_mapa: `${B}_DisplayType_M`,
  ml_terrenos: 'https://inmuebles.mercadolibre.com.ar/terrenos-lotes/venta/capital-federal/',
  remax: 'https://api-ar.redremax.com/remaxweb-ar/api/listings/findAll?page=0&pageSize=100&sort=-createdAt&in:operationId=1',
};
mkdirSync('debug', { recursive: true });
for (const [name, url] of Object.entries(URLS)) {
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'es-AR,es;q=0.9', accept: name === 'remax' ? 'application/json' : 'text/html,*/*', ...(name === 'remax' ? { origin: 'https://www.remax.com.ar' } : {}) }, signal: AbortSignal.timeout(25000) });
    const body = await res.text();
    console.log(name, res.status, res.url, body.length, body.slice(0, 200).replace(/\s+/g, ' '));
    writeFileSync(`debug/${name}.txt.gz`, gzipSync(`${res.status} ${res.url}\n${JSON.stringify(Object.fromEntries(res.headers))}\n\n${body}`));
  } catch (e) { console.log(name, e.message); }
}
