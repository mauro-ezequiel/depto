// Utilidades compartidas por todas las fuentes.

const UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function fetchText(url, { headers = {}, timeoutMs = 30000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'user-agent': UA,
        'accept-language': 'es-AR,es;q=0.9',
        accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        ...headers,
      },
    });
    const body = await res.text();
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} en ${url}`);
      err.status = res.status;
      throw err;
    }
    return body;
  } finally {
    clearTimeout(t);
  }
}

export async function fetchJson(url, opts) {
  return JSON.parse(await fetchText(url, opts));
}

// Números en formato argentino: "1.250.000" -> 1250000, "45,5" -> 45.5
export function toNumber(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = String(v).replace(/[^\d.,-]/g, '');
  if (!s) return null;
  if (s.includes(',') && s.includes('.')) s = s.replace(/\./g, '').replace(',', '.');
  else if (s.includes(',')) s = s.replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

export function normCurrency(c) {
  if (!c) return null;
  const s = String(c).toUpperCase();
  if (s.includes('USD') || s.includes('U$S') || s.includes('US$') || s === 'DOLAR' || s === 'DÓLAR') return 'USD';
  if (s.includes('ARS') || s === '$' || s.includes('PESO')) return 'ARS';
  return s.length <= 4 ? s : null;
}

// Interpreta un precio de texto tipo "USD 120.000" o "$ 450.000".
export function parsePrice(text) {
  if (!text) return { price: null, currency: null };
  const t = String(text);
  const currency = /U\$S|USD|US\$|D[óo]lar/i.test(t) ? 'USD' : /\$|ARS|peso/i.test(t) ? 'ARS' : null;
  const m = t.match(/\d[\d.,]*/);
  return { price: m ? toNumber(m[0]) : null, currency };
}

const TYPE_WORDS = [
  ['ph', /\bph\b|propiedad horizontal/i],
  ['departamento', /departamento|depto|monoambiente|apartment|\bdpto/i],
  ['casa', /\bcasa|chalet|house|d[uú]plex|triplex/i],
  ['local', /\blocal|comercial|store/i],
  ['oficina', /oficina|office|consultorio/i],
  ['terreno', /terreno|lote|land/i],
  ['cochera', /cochera|garage|parking/i],
  ['galpon', /galp[oó]n|dep[oó]sito|nave|warehouse/i],
  ['quinta', /quinta|campo|chacra/i],
];

export function guessType(...texts) {
  const s = texts.filter(Boolean).join(' ');
  for (const [k, re] of TYPE_WORDS) if (re.test(s)) return k;
  return null;
}

export function guessOperation(...texts) {
  const s = texts.filter(Boolean).join(' ');
  if (/alquiler temporal|temporario|temporary/i.test(s)) return 'temporal';
  if (/alquil|rent|lease/i.test(s)) return 'alquiler';
  if (/venta|vend|sale|sell|buy|comprar/i.test(s)) return 'venta';
  return null;
}

export function absUrl(u, base) {
  if (!u) return null;
  try {
    return new URL(String(u).trim(), base).href;
  } catch {
    return null;
  }
}

export function uniq(arr) {
  return [...new Set(arr.filter(Boolean))];
}

export function cleanText(s) {
  if (s == null) return null;
  const t = String(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return t || null;
}
