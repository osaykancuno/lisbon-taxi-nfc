// Builds one game archive: the browser bundle, the server verifier and the matching scoring configuration, kept together.
// Adapted from studio-games-example/scripts/package-game.ts (MIT, Copyright 2026 SuperRare).
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { strToU8 } from 'fflate';
import { scoringConfiguration, type Configuration } from '../src/shell/config.js';

export type GameFiles = Record<string, Uint8Array>;
const root = fileURLToPath(new URL('../', import.meta.url));
const TITLES: Record<Configuration['game'], string> = { 'the-lisbon-way': 'THE LISBON WAY' };

const common = { absWorkingDir: root, bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, write: false, legalComments: 'inline' } as const;

export async function packageGame(configuration: Configuration): Promise<GameFiles> {
  const [browser, verifier, template, stylesheet, license, notice] = await Promise.all([
    build({ ...common, entryPoints: [`src/entries/${configuration.game}.ts`], define: { __DEV_ANY_ORIGIN__: 'false' } }),   // dev-only code drops out
    build({ ...common, entryPoints: [`src/verifiers/${configuration.game}.ts`] }),
    readFile(new URL('../src/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../src/shell/styles.css', import.meta.url)),
    readFile(new URL('../LICENSE', import.meta.url)),
    readFile(new URL('../NOTICE', import.meta.url)),
  ]);
  const appBundle = browser.outputFiles[0];
  const verifierBundle = verifier.outputFiles[0];
  if (!appBundle || !verifierBundle) throw new Error('Bundler returned no application or verifier output.');
  if (verifierBundle.contents.byteLength > 256_000) throw new Error('Server verifier exceeds Studio’s 256 KB module limit.');
  const appPath = `assets/app-${createHash('sha256').update(appBundle.contents).digest('hex').slice(0, 16)}.js`;
  // a web app: add to the home screen, full screen, on every device. Icons when the game has them (src/assets/icons/).
  const icons: GameFiles = {};
  for (const size of [192, 512]) {
    const source = new URL(`../src/assets/icons/${configuration.game}-${size}.png`, import.meta.url);
    if (existsSync(source)) icons[`assets/icon-${size}.png`] = await readFile(source);
  }
  const manifest = {
    name: `${TITLES[configuration.game]} · THE WALL ARCADE`, short_name: TITLES[configuration.game], start_url: '../', scope: '../',
    display: 'standalone', orientation: 'portrait', background_color: '#DEDBD3', theme_color: '#0B0B0B',
    icons: Object.keys(icons).map((path) => ({ src: `./${path.slice('assets/'.length)}`, sizes: `${path.match(/(\d+)\.png$/)?.[1]}x${path.match(/(\d+)\.png$/)?.[1]}`, type: 'image/png', purpose: 'any' })),
  };
  const webApp = [
    '<link rel="manifest" href="./assets/manifest.json">',
    '<meta name="theme-color" content="#0B0B0B">',
    '<meta name="mobile-web-app-capable" content="yes">',
    '<meta name="apple-mobile-web-app-capable" content="yes">',
    '<meta name="apple-mobile-web-app-status-bar-style" content="black">',
    `<meta name="apple-mobile-web-app-title" content="${TITLES[configuration.game]}">`,
    ...(icons['assets/icon-192.png'] ? ['<link rel="apple-touch-icon" href="./assets/icon-192.png">', '<link rel="icon" type="image/png" href="./assets/icon-192.png">'] : []),
  ].map((tag) => `    ${tag}`).join('\n');
  const stylePath = `assets/styles-${createHash('sha256').update(stylesheet).digest('hex').slice(0, 16)}.css`;
  const index = template
    .replace('<head>', `<head>\n    <meta name="play-factory-game-id" content="${configuration.appId}">\n    <link data-rare-app-metadata="true" rel="canonical" href="${configuration.appOrigin}/">`)
    .replace('<title>THE WALL ARCADE</title>', `<title>${TITLES[configuration.game]} · THE WALL ARCADE</title>`)
    .replace('./assets/app.js', `./${appPath}`)
    .replace('./assets/styles.css', `./${stylePath}`)
    .replace('  </head>', `${webApp}\n  </head>`);
  if (!index.includes(appPath) || !index.includes(stylePath) || !index.includes('assets/manifest.json')) throw new Error('index.html template placeholders were not replaced.');
  return {
    'index.html': strToU8(index),
    'config.json': strToU8(`${JSON.stringify(configuration, null, 2)}\n`),
    [appPath]: appBundle.contents,
    [stylePath]: stylesheet,
    'assets/manifest.json': strToU8(`${JSON.stringify(manifest, null, 2)}\n`),
    ...icons,
    'server-verifier.js': verifierBundle.contents,
    'scoring-config.json': strToU8(`${JSON.stringify(scoringConfiguration(configuration.game), null, 2)}\n`),
    LICENSE: license,
    NOTICE: notice,
  };
}
