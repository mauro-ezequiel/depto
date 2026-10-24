// Pruebas de los lectores con HTML de ejemplo armado a mano
// (con la forma que usan los portales; no son avisos reales).
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgenprop } from '../sources/argenprop.mjs';
import { listingsFromHtml, extractJsonBlobs } from '../lib/embedded.mjs';
import { toNumber, parsePrice, guessType } from '../lib/util.mjs';

test('números en formato argentino', () => {
  assert.equal(toNumber('1.250.000'), 1250000);
  assert.equal(toNumber('45,5'), 45.5);
  assert.equal(toNumber('USD 98.000'), 98000);
  assert.deepEqual(parsePrice('U$S 120.000'), { price: 120000, currency: 'USD' });
  assert.deepEqual(parsePrice('$ 450.000'), { price: 450000, currency: 'ARS' });
  assert.equal(guessType('PH en venta 3 ambientes'), 'ph');
});

test('argenprop: lee tarjetas del listado', () => {
  const html = `<div class="listing__item"><a class="card" href="/departamento-en-venta-en-palermo-2-ambientes--111" data-item-card="111">
    <ul class="card__photos"><li><img data-src="https://static.example/f1.jpg"></li><li><img src="data:image/gif;base64,x" data-src="https://static.example/f2.jpg"></li></ul>
    <p class="card__price"><span class="card__currency">USD</span> 120.000 <span class="card__expenses">+ $ 50.000 expensas</span></p>
    <p class="card__address">Gurruchaga 1234</p>
    <h2 class="card__title--primary">Departamento en Venta en Palermo, Capital Federal</h2>
    <ul class="card__main-features"><li><span>50 m² cubie.</span></li><li><span>2 ambientes</span></li><li><span>1 dormitorio</span></li></ul>
  </a></div>`;
  const [l] = parseArgenprop(html, { base: 'https://www.argenprop.com/departamentos/venta/capital-federal', operation: 'venta', type: 'departamento' });
  assert.equal(l.url, 'https://www.argenprop.com/departamento-en-venta-en-palermo-2-ambientes--111');
  assert.equal(l.price, 120000);
  assert.equal(l.currency, 'USD');
  assert.equal(l.expenses, 50000);
  assert.equal(l.rooms, 2);
  assert.equal(l.bedrooms, 1);
  assert.equal(l.area_covered, 50);
  assert.equal(l.neighborhood, 'Palermo');
  assert.deepEqual(l.images, ['https://static.example/f1.jpg', 'https://static.example/f2.jpg']);
});

test('estado incrustado estilo zonaprop', () => {
  const state = {
    listPostings: [{
      postingId: '999', title: 'Hermoso PH reciclado', url: '/propiedades/ph-999.html',
      priceOperationTypes: [{ operationType: { name: 'Venta' }, prices: [{ amount: 150000, currency: 'USD' }] }],
      postingLocation: { address: { name: 'Thames 100' }, location: { name: 'Villa Crespo', parent: { name: 'Capital Federal' } } },
      visiblePictures: { pictures: [{ url730x532: 'https://img.example/a.jpg' }] },
      mainFeatures: { CFT100: { label: 'Superficie total', value: '80' }, CFT1: { label: 'Ambientes', value: '3' } },
      realEstateType: { name: 'PH' },
    }],
  };
  const html = `<script>window.__PRELOADED_STATE__ = ${JSON.stringify(state)};</script>`;
  assert.equal(extractJsonBlobs(html).length, 1);
  const [l] = listingsFromHtml(html, { source: 'zonaprop', base: 'https://www.zonaprop.com.ar/x.html' });
  assert.equal(l.url, 'https://www.zonaprop.com.ar/propiedades/ph-999.html');
  assert.equal(l.type, 'ph');
  assert.equal(l.operation, 'venta');
  assert.equal(l.price, 150000);
  assert.equal(l.area_total, 80);
  assert.equal(l.rooms, 3);
  assert.equal(l.neighborhood, 'Villa Crespo');
  assert.deepEqual(l.images, ['https://img.example/a.jpg']);
});

test('__NEXT_DATA__ y JSON-LD', () => {
  const next = { props: { pageProps: { results: [{ id: 'p1', title: 'Local a la calle', url: 'https://www.properati.com.ar/detalle/p1', price: { amount: 900000, currency: 'ARS' }, images: [{ url: 'https://img.example/l.jpg' }] }] } } };
  const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(next)}</script>`;
  const [l] = listingsFromHtml(html, { source: 'properati', base: 'https://www.properati.com.ar/', operation: 'alquiler' });
  assert.equal(l.type, 'local');
  assert.equal(l.currency, 'ARS');
  assert.equal(l.operation, 'alquiler');
});

test('mercado libre: tarjetas polycard de la página pública', async () => {
  const { parsePolycards } = await import('../sources/mercadolibre.mjs');
  const card = { id: 'POLYCARD', polycard: {
    metadata: { id: 'MLA1', url: 'departamento.mercadolibre.com.ar/MLA-1-depto-_JM', domain_id: 'MLA-APARTMENTS_FOR_SALE' },
    pictures: { pictures: [{ id: '123-MLA1_102026' }] },
    components: [
      { type: 'headline', headline: { text: 'Departamento en venta' } },
      { type: 'title', title: { text: 'Depto luminoso' } },
      { type: 'price', price: { current_price: { value: 98000, currency: 'USD' } } },
      { type: 'attributes_list', attributes_list: { texts: ['2 ambs.', '1 baño', '45 m² cubiertos'] } },
      { type: 'location', location: { text: 'Gurruchaga 100, Palermo, Capital Federal' } },
    ] } };
  const html = `<script>_n.ctx.r=${JSON.stringify({ results: [card, card] })};</script>`;
  const r = parsePolycards(html, {});
  assert.equal(r.length, 1);
  assert.equal(r[0].url, 'https://departamento.mercadolibre.com.ar/MLA-1-depto-_JM');
  assert.equal(r[0].operation, 'venta');
  assert.equal(r[0].type, 'departamento');
  assert.equal(r[0].rooms, 2);
  assert.equal(r[0].area_covered, 45);
  assert.equal(r[0].neighborhood, 'Palermo');
  assert.equal(r[0].images[0], 'https://http2.mlstatic.com/D_NQ_NP_123-MLA1_102026-O.webp');
});

test('remax: fila de la API', async () => {
  const { mapRemax } = await import('../sources/remax.mjs');
  const l = mapRemax({
    id: 'abc', slug: 'ph-palermo', title: 'PH en Palermo', location: { type: 'Point', coordinates: [-58.42, -34.58] },
    totalRooms: 3, bathrooms: 1, price: 150000, priceExposure: true, currency: { value: 'USD' }, expensesPrice: null,
    displayAddress: 'Thames 100', dimensionTotalBuilt: 80, dimensionCovered: 70, type: { value: 'ph' }, operation: { value: 'sale' },
    photos: [{ value: 'listings/abc/2.jpg', position: 1 }, { value: 'listings/abc/1.jpg', position: 0 }],
    addressInfo: 'Palermo, Capital Federal',
  });
  assert.equal(l.url, 'https://www.remax.com.ar/listings/ph-palermo');
  assert.equal(l.type, 'ph');
  assert.equal(l.operation, 'venta');
  assert.equal(l.lat, -34.58);
  assert.equal(l.neighborhood, 'Palermo');
  assert.equal(l.images[0], 'https://d1acdg20u0pmxj.cloudfront.net/listings/abc/1.jpg');
});

test('mercado libre: datos de la página del aviso', async () => {
  const { parseMlDetail } = await import('../lib/details.mjs');
  const html = `{"name":"Dormitorios","value_name":"2"},{"name":"Superficie total","value_name":"80 m²"},{"name":"Superficie cubierta","value_name":"70 m²"},{"name":"Baños","value_name":"1"} "latitude":-34.58,"longitude":-58.42 https://http2.mlstatic.com/D_NQ_NP_2X_111-MLA9_102026-F.webp https://http2.mlstatic.com/D_NQ_NP_222-MLA9_102026-O.jpg`;
  const d = parseMlDetail(html);
  assert.equal(d.bedrooms, 2);
  assert.equal(d.area_total, 80);
  assert.equal(d.area_covered, 70);
  assert.equal(d.bathrooms, 1);
  assert.equal(d.lat, -34.58);
  assert.equal(d.images.length, 2);
});

test('inmobiliarias: RealEstateListing de schema.org', async () => {
  const { mapRealEstateListing } = await import('../sources/inmobiliarias.mjs');
  const l = mapRealEstateListing({
    '@type': 'RealEstateListing', name: 'Santa Fe 2300. Alquiler.', url: 'https://x.com/propiedad/a--1', image: 'https://x.com/a.webp',
    about: { '@type': 'Apartment', address: { streetAddress: 'Santa Fe 2395', addressLocality: 'Palermo', addressRegion: 'Capital Federal' },
      geo: { latitude: -34.59, longitude: -58.4 }, floorSize: { value: 115 }, numberOfRooms: 4, numberOfBedrooms: 3, numberOfBathroomsTotal: 1 },
    offers: { '@type': 'OfferForLease', price: 1800000, priceCurrency: 'ARS' },
  }, { nombre: 'LJ Ramos' });
  assert.equal(l.operation, 'alquiler');
  assert.equal(l.type, 'departamento');
  assert.equal(l.bedrooms, 3);
  assert.equal(l.neighborhood, 'Palermo');
  assert.equal(l.publisher, 'LJ Ramos');
});

test('características: apto crédito, cochera, balcón y patio', async () => {
  const { textFeatures } = await import('../collect.mjs');
  const { parseMlDetail } = await import('../lib/details.mjs');
  const a = { title: 'Venta 3 amb con balcón - Apto Crédito', url: 'https://x.com/MLA-1-venta-3-amb-cochera-fija-_JM' };
  textFeatures(a);
  assert.deepEqual([a.credito, a.cochera, a.balcon, a.patio], [true, true, true, undefined]);
  const b = { title: 'PH con patio, sin cochera, no apto crédito' };
  textFeatures(b);
  assert.deepEqual([b.credito, b.cochera, b.patio], [undefined, undefined, true]);
  const d = parseMlDetail('{"id":"Cocheras","text":"1"},{"id":"Apto crédito","text":"Sí"},{"id":"Balcón","text":"No"}');
  assert.deepEqual([d.cochera, d.credito, d.balcon], [true, true, false]);
});

test('estado: en pozo y a estrenar', async () => {
  const { textFeatures } = await import('../collect.mjs');
  const t = (title) => { const l = { title }; textFeatures(l); return [l.pozo, l.nuevo]; };
  assert.deepEqual(t('Departamento En Flores De 3 Amb - Entr Abril 27'), [true, undefined]);
  assert.deepEqual(t('Monoambiente en pozo, financiado'), [true, undefined]);
  assert.deepEqual(t('2 ambientes a estrenar, entrega inmediata'), [undefined, true]);
  assert.deepEqual(t('3 amb reciclado con balcón'), [undefined, undefined]);
});
