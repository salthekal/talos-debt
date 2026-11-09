/** The dashboard's own English and Arabic text, so the run finds things by what people read. */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { transform } = createRequire(import.meta.url)('esbuild');

async function load(lang) {
  const src = await readFile(join(here, `../src/i18n/${lang}.ts`), 'utf8');
  const { code } = await transform(src.replace(/^import .*$/m, ''), { loader: 'ts', format: 'esm' });
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`))[lang];
}
const all = { en: await load('en'), ar: await load('ar') };

/** Plain strings; for plural text, the general form. */
export function text(lang) {
  return Object.fromEntries(Object.entries(all[lang]).map(([k, v]) => [k, typeof v === 'string' ? v : v.other]));
}
