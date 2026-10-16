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
