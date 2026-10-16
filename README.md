# Depto

Una app que junta avisos de departamentos, PH, casas, locales, oficinas y terrenos de varios portales en un solo lugar, con fotos y datos. Al tocar un aviso te lleva a la publicación original. Se instala en el celular como una app (PWA) y se actualiza sola.

## Cómo funciona

- **`collector/`**: el recolector. Lee cada portal, normaliza los avisos y escribe `web/data/listings.json`. Recuerda cuándo vio cada aviso por primera vez, marca las bajas de precio y borra los que no aparecen hace 10 días.
- **`web/`**: la app. Es una página estática: lista con fotos deslizables, filtros (operación, tipo, precio, moneda, ambientes, m², portal), búsqueda, guardados, descartados y mapa.
- **`.github/workflows/actualizar.yml`**: corre el recolector **cada 3 horas** en GitHub y publica la app en GitHub Pages. La app abierta en el celular busca datos nuevos al volver a abrirla y cada 15 minutos.

## Portales

| Portal | Cómo se lee | Notas |
|---|---|---|
| Mercado Libre | API oficial | Necesita una app gratis de desarrollador (ver abajo). Sin eso intenta la página pública. |
| Argenprop | HTML del listado | |
| Zonaprop | Datos incrustados en la página | Tiene protección anti-bots fuerte; puede bloquear a los servidores de GitHub. |
| Properati | Datos incrustados (Next.js) | |
| RE/MAX | API JSON de su web | |

Cada portal es independiente: si uno falla, los demás siguen. En la app, "Estado de portales" muestra cuántos avisos trajo cada uno en la última corrida o por qué falló.

Leer estos sitios automáticamente puede ir contra sus términos de uso; el recolector va despacio (una página cada 2,5 s) y solo guarda lo que el aviso muestra públicamente, con link al original.

## Puesta en marcha

1. Crear un repositorio en GitHub y subir esta carpeta.
2. En el repo: **Settings → Pages → Source: GitHub Actions**.
3. (Opcional, recomendado) Mercado Libre: crear una app en https://developers.mercadolibre.com.ar/devcenter y cargar `ML_CLIENT_ID` y `ML_CLIENT_SECRET` en **Settings → Secrets and variables → Actions**.
4. En **Actions → Actualizar avisos y publicar → Run workflow** para la primera corrida.
5. Abrir la URL de Pages en el celular: en Android tocar **Instalar**; en iPhone, Safari → Compartir → **Agregar a inicio**.

## Cambiar zona o qué buscar

Editar `collector/config.json`: zona (slug de cada portal), operaciones, tipos, páginas por búsqueda y cada cuánto borrar avisos viejos.

## Correr local

```bash
npm install
npm test                 # pruebas de los lectores
npm run collect          # o: node collector/collect.mjs argenprop,remax
npm run serve            # abre http://localhost:8080
```
