// THE LISBON WAY: writes the game's public config (deploy/the-lisbon-way.config.json: the app id and its HTTPS origin,
// the arcade's shared credit group), the file PUBBLICA.cmd reads to update that same app. Never a key, token or secret:
// only what config.json holds. Three ways to know the app:
//   npx tsx scripts/the-lisbon-way-config.ts <app-deploy-output.json>
//       the --json answer of the bootstrap `rare-profile app deploy` (a NEW app);
//   npx tsx scripts/the-lisbon-way-config.ts --origin https://xxxx.srstudio.dev --products <product-list-output.json>
//       the existing app at that address, found in the --json answer of `rare-profile product list`;
//   npx tsx scripts/the-lisbon-way-config.ts --origin https://xxxx.srstudio.dev --app-id <uuid>
//       the existing app, its id given by hand.
// The answers may be NDJSON (one JSON object per line) and, saved by Windows PowerShell, UTF-16 or carry a BOM.
// Exit code 2: the app at --origin is not in the product list (the page then asks for its id).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { parseConfiguration } from '../src/shell/config.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const { values, positionals } = parseArgs({ allowPositionals: true, options: { origin: { type: 'string' }, products: { type: 'string' }, 'app-id': { type: 'string' } } });

/** Every JSON object of a CLI answer file (NDJSON or one document), the `data` of successful answers first. */
async function readAnswers(file: string): Promise<unknown[]> {
  const bytes = await readFile(file);
  const text = (bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.subarray(2).toString('utf16le') : bytes.toString('utf8')).replace(/^﻿/, '');
  const lines = text.split(/\r?\n/).map((line) => { try { return JSON.parse(line) as unknown; } catch { return null; } }).filter((v) => v !== null);
  const all = lines.length ? lines : (() => { try { return [JSON.parse(text) as unknown]; } catch { return []; } })();
  return all.filter((v) => !(typeof v === 'object' && v !== null && (v as { ok?: unknown }).ok === false))
    .map((v) => (typeof v === 'object' && v !== null && 'data' in v ? (v as { data: unknown }).data : v));
}
/** The first value of one of these keys, anywhere in a value (depth first). */
function find(value: unknown, keys: readonly string[], ok: (v: unknown) => boolean): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  for (const key of keys) { const v = (value as Record<string, unknown>)[key]; if (ok(v)) return v as string; }
  for (const v of Object.values(value)) { const found = find(v, keys, ok); if (found) return found; }
  return undefined;
}
/** Every object with a UUID `id`, anywhere in a value: the products of a product list. */
function products(value: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) { for (const v of value) products(v, out); return out; }
  if (typeof value !== 'object' || value === null) return out;
  const o = value as Record<string, unknown>;
  if (typeof o.id === 'string' && UUID.test(o.id)) out.push(o);
  for (const [k, v] of Object.entries(o)) if (k !== 'id') products(v, out);
  return out;
}
const originOf = (url: string): string => new URL(url).origin;

let appId: string | undefined, appUrl: string | undefined;
if (values.origin) {
  appUrl = originOf(values.origin);
  if (values['app-id']) {
    if (!UUID.test(values['app-id'])) throw new Error(`Not an app id: ${values['app-id']}`);
    appId = values['app-id'];
  } else if (values.products) {
    const host = new URL(appUrl).host;
    const all = products(await readAnswers(values.products));
    const matches = all.filter((p) => JSON.stringify(p).includes(host));
    if (matches.length !== 1) {
      process.stderr.write(`${matches.length ? 'Several apps' : 'No app'} found at ${appUrl}. Your apps:\n`);
      for (const p of all) process.stderr.write(`  ${p.id}  ${String(p.title ?? p.name ?? p.slug ?? '')}\n`);
      process.exit(2);
    }
    appId = (matches[0] as { id: string }).id;
  } else throw new Error('With --origin, give --products <file> or --app-id <uuid>');
} else {
  const file = positionals[0];
  if (!file) throw new Error('Usage: npx tsx scripts/the-lisbon-way-config.ts <app-deploy-output.json> | --origin <url> (--products <file> | --app-id <uuid>)');
  const data = (await readAnswers(file)).at(-1);
  appId = find(data, ['id', 'product_id', 'productId', 'app_id', 'appId'], (v) => typeof v === 'string' && UUID.test(v));
  const url = find(data, ['app_url', 'appUrl'], (v) => typeof v === 'string' && v.startsWith('https://'));
  appUrl = url ? originOf(url) : undefined;
  if (!appId || !appUrl) throw new Error(`No app id and app_url in ${file}: is it the --json answer of rare-profile app deploy?`);
}

const configuration = parseConfiguration({
  appId,
  groupId: '60faaf46-ba4b-460c-a82a-adb852371a94',          // THE WALL ARCADE's shared credit group: never create another
  studioUrl: 'https://studio.superrare.com',
  apiUrl: 'https://api.superrare.com',
  connectUrl: 'https://connect.superrare.com',
  appOrigin: appUrl,                                          // scheme + host, no path, no trailing slash
  display: 'embed',
  game: 'the-lisbon-way',
  hubUrl: 'https://6972mvu4.srstudio.dev/',
});
await mkdir(new URL('../deploy/', import.meta.url), { recursive: true });
await writeFile(new URL('../deploy/the-lisbon-way.config.json', import.meta.url), `${JSON.stringify(configuration, null, 2)}\n`);
console.log(`deploy/the-lisbon-way.config.json written: app ${configuration.appId} at ${configuration.appOrigin}

Every time the game changes, build and update this same app (on Windows: double-click PUBBLICA.cmd):
npm run build -- --config deploy/the-lisbon-way.config.json --output dist/the-lisbon-way.zip --force
rare-profile app update ${configuration.appId} --zip dist/the-lisbon-way.zip --max-attempts 10000 --json`);
