// Zonaprop: los avisos vienen en el estado JSON incrustado en la página
// (objetos con postingId, priceOperationTypes, visiblePictures...).
// Ojo: Zonaprop usa protección anti-bots y suele bloquear servidores de nube.
import { crawl } from '../lib/crawl.mjs';

const TYPES = { departamento: 'departamentos', ph: 'ph', casa: 'casas', local: 'locales-comerciales', oficina: 'oficinas-comerciales', terreno: 'terrenos' };
const OPS = { venta: 'venta', alquiler: 'alquiler', temporal: 'alquiler-temporal' };

export default {
  name: 'zonaprop',
  label: 'Zonaprop',
  collect: (cfg, log) => crawl(cfg, log, {
    source: 'zonaprop',
    typeSlugs: TYPES,
    buildUrl: ({ op, slug, page }) =>
      `https://www.zonaprop.com.ar/${slug}-${OPS[op]}-${cfg.zona.zonaprop}${page > 1 ? `-pagina-${page}` : ''}.html`,
  }),
};
