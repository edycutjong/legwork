import { defineConfig } from 'vite';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** The release stamp shown in the footer: the git tag on the built commit (release.yml tags every releasable push, so the
 *  Pages deploy — which checks out with full history — sees it), else `v<package.json>-dev` for a local or tagless build. */
function appVersion(): string {
  try { return execSync('git describe --tags --abbrev=0', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { return `v${JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version}-dev`; }
}

// Relative base so the same dist/ serves from legwork.edycu.dev (GitHub Pages) and from any static host.
export default defineConfig({
  base: './',
  define: { __APP_VERSION__: JSON.stringify(appVersion()) },
  build: { outDir: 'dist', target: 'es2022', sourcemap: false },
});
