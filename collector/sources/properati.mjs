// Properati: sitio Next.js, los avisos vienen en __NEXT_DATA__.
import { crawl } from '../lib/crawl.mjs';

const TYPES = { departamento: 'departamento', ph: 'ph', casa: 'casa', local: 'local', oficina: 'oficina', terreno: 'terreno' };
const OPS = { venta: 'venta', alquiler: 'alquiler' };

export default {
  name: 'properati',
  label: 'Properati',
  collect: (cfg, log) => crawl(cfg, log, {
    source: 'properati',
    typeSlugs: TYPES,
    buildUrl: ({ op, slug, page }) => OPS[op]
      ? `https://www.properati.com.ar/s/${cfg.zona.properati}/${slug}/${OPS[op]}${page > 1 ? `/${page}` : ''}`
      : null,
  }),
};
