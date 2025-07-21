#!/usr/bin/env node
import path from 'path';
import { createServer } from 'http';
const serveHandler: any = require('serve-handler');
import puppeteer from 'puppeteer';
import { diffLines } from 'diff';
import { readFile } from 'fs/promises';
import minimist from 'minimist';
import chalk from 'chalk';

async function runDiag() {
  const argv = minimist(process.argv.slice(2), {
    alias: { h: 'help', i: 'index', p: 'port', v: 'verbose', f: 'format' },
    boolean: ['help', 'verbose'],
    string: ['index', 'port', 'format'],
    default: { index: 'index.html', format: 'text' },
  });

  if (argv.help || argv._[0] !== 'run' || !argv._[1]) {
    console.log(`
Usage: ssr-diag run <path> [options]

Commands:
  run <path>           Scan SSR output folder for hydration mismatches

Options:
  -h, --help           Show this help message
  -i, --index <file>   HTML filename to serve (default: index.html)
  -p, --port <num>     Port for static server (default: random)
  -v, --verbose        Print extra debug information
  -f, --format <mode>  Output format: 'text' (default) or 'json'
`);
    process.exit(argv.help ? 0 : 1);
  }

  const folder = path.resolve(process.cwd(), argv._[1] as string);
  const indexFile = argv.index as string;
  const forcedPort = argv.port ? Number(argv.port) : undefined;
  const isVerbose = argv.verbose as boolean;

  if (isVerbose) console.log(`[ssr-diag] Serving folder: ${folder}`);

  // Start static server
  const server = createServer((req, res) =>
    serveHandler(req, res, { public: folder })
  );
  await new Promise<void>((resolve) =>
    server.listen(forcedPort ?? 0, '127.0.0.1', () => resolve())
  );
  const addr = server.address();
  if (!addr) {
    console.error('❌ Failed to start static server');
    process.exit(1);
  }
  const port = typeof addr === 'object' ? addr.port : addr;
  const url = `http://127.0.0.1:${port}/${indexFile}`;

  console.log(`[ssr-diag] Serving ${folder} → ${url}`);

  // Launch Puppeteer in CI‑friendly mode
  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();

  // Inject hydration‑wrapper
  const wrapperSource = await readFile(path.resolve(__dirname, 'index.js'), 'utf8');
  await page.evaluateOnNewDocument(wrapperSource);

  // Load page and capture server HTML
  const response = await page.goto(url, { waitUntil: 'networkidle0' });
  if (!response || response.status() >= 400) {
    console.error(`❌ Failed to load page (status ${response?.status()})`);
    await browser.close();
    server.close();
    process.exit(1);
  }
  const serverHtml = await page.content();

  // Capture hydrated HTML
  const clientHtml: string = await page.evaluate(
    () => document.documentElement.outerHTML
  );

  await browser.close();
  server.close();

  // Diff and output
  const diffs = diffLines(serverHtml, clientHtml);

  // JSON mode
  if (argv.format === 'json') {
    const mismatches = diffs
      .filter((p) => p.added || p.removed)
      .map((p) => ({
        type: p.added ? 'add' : 'remove',
        text: p.value.trimEnd(),
      }));
    console.log(JSON.stringify({ mismatches }, null, 2));
    process.exit(mismatches.length ? 1 : 0);
  }

  // Text mode with color
  const changes = diffs.filter((p) => p.added || p.removed);
  if (!changes.length) {
    console.log(chalk.green('✅ No hydration mismatches detected.'));
    process.exit(0);
  }

  console.error(chalk.red('❌ Hydration mismatches found:'));
  diffs.forEach((part) => {
    const lines = part.value.split('\n').filter(Boolean);
    lines.forEach((line) => {
      const prefix = part.added ? '+' : part.removed ? '-' : ' ';
      const colored = part.added
        ? chalk.green(line)
        : part.removed
        ? chalk.red(line)
        : chalk.dim(line);
      if (part.added || part.removed) {
        console.error(`${prefix} ${colored}`);
      }
    });
  });
  process.exit(1);
}

runDiag().catch((err) => {
  console.error('[ssr-diag] Unexpected error:', err);
  process.exit(1);
});