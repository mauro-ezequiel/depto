// Recorre operación × tipo × página para portales que se leen por HTML.
import { fetchText, sleep } from './util.mjs';
import { listingsFromHtml } from './embedded.mjs';

export async function crawl(cfg, log, { source, typeSlugs, buildUrl, parse }) {
  const out = [];
  let errors = 0;
  for (const op of cfg.operaciones) {
    for (const type of cfg.tipos) {
      if (!typeSlugs[type]) continue;
      for (let page = 1; page <= cfg.paginas_por_busqueda; page++) {
        const url = buildUrl({ op, type, slug: typeSlugs[type], page });
        if (!url) break;
        let items = [];
        try {
          const html = await fetchText(url);
          const ctx = { source, base: url, operation: op, type };
          items = parse ? parse(html, ctx) : [];
          if (!items.length) items = listingsFromHtml(html, ctx);
        } catch (e) {
          errors++;
          log(`  ${type}/${op} p${page}: ${e.message}${e.cause?.code ? ` (${e.cause.code})` : ''}`);
          // tres fallas seguidas sin ningún aviso: el portal no responde
          if (!out.length && errors >= 3) throw e;
          // si el portal nos bloquea de entrada, no insistimos
          if (e.status === 403 || e.status === 429) {
            if (!out.length) throw e;
            return out;
          }
          break;
        }
        log(`  ${type}/${op} p${page}: ${items.length}`);
        out.push(...items.map((l) => ({ ...l, operation: l.operation || op, type: l.type || type })));
        if (!items.length) break;
        await sleep(cfg.pausa_entre_pedidos_ms);
      }
    }
  }
  if (!out.length && errors) throw new Error('No se pudo leer ninguna página');
  return out;
}
