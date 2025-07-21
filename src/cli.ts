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
    string: ['index', 'port', 'format', 'verbose-json'],
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
      --verbose-json   Include full mismatch text in JSON output
`);
    process.exit(argv.help ? 0 : 1);
  }

  const folder = path.resolve(process.cwd(), argv._[1] as string);
  const indexFile = argv.index as string;
  const forcedPort = argv.port ? Number(argv.port) : undefined;

  if (argv.verbose) console.log(`[ssr-diag] Serving folder: ${folder}`);

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

  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();

  // Only pipe console.log (ignore errors like 404)
  page.on('console', (msg) => {
    if (msg.type() === 'log') console.log(`[page] ${msg.text()}`);
  });

  const wrapperSource = await readFile(path.resolve(__dirname, 'index.js'), 'utf8');
  await page.evaluateOnNewDocument(wrapperSource);

  // 1) Navigate & fetch raw HTML via HTTP
  const response = await page.goto(url, { waitUntil: 'networkidle0' });
  if (!response || response.status() >= 400) {
    console.error(`❌ Failed to load page (status ${response?.status()})`);
    await browser.close();
    server.close();
    process.exit(1);
  }
  const serverHtml = await response.text();
  const serverLinesArr = serverHtml.split('\n');

  // 2) Give client hydration a moment
  await new Promise((resolve) => setTimeout(resolve, 500));

  // 3) Capture hydrated HTML
  const clientHtml: string = await page.evaluate(
    () => document.documentElement.outerHTML
  );

  await browser.close();
  server.close();

  // normalize: strip doctype/comments, unify meta tag styles
  const normalize = (html: string) =>
    html
      .replace(/^<!DOCTYPE html>.*?<html/, '<html')
      .replace(/<meta charset="([^"]+)"\s*\/?>/g, '<meta charset="$1">')
      .trim();
  const cleanServer = normalize(serverHtml);
  const cleanClient = normalize(clientHtml);
  const diffs = diffLines(cleanServer, cleanClient);

  // Group diffs with context
  type LineInfo = { line: number; snippet: string; length: number };
  const MAX = 120;
  const grouped: Array<{
    contextBefore: LineInfo[];
    serverLines: LineInfo[];
    clientLines: LineInfo[];
    contextAfter: LineInfo[];
  }> = [];
  let cursor = 0;
  let current: any = null;

  diffs.forEach((p) => {
    const lines = p.value.split('\n').filter(Boolean);
    if (p.added || p.removed) {
      if (!current) {
        const before = serverLinesArr.slice(Math.max(0, cursor - 1), cursor);
        current = {
          contextBefore: before.map((full, i) => {
            const num = cursor - before.length + i + 1;
            const snip = full.length > MAX ? full.slice(0, MAX) + '…' : full;
            return { line: num, snippet: snip, length: full.length };
          }),
          serverLines: [],
          clientLines: [],
          contextAfter: [],
        };
        grouped.push(current);
      }
      lines.forEach((full, i) => {
        const num = cursor + i + 1;
        const snip = full.length > MAX ? full.slice(0, MAX) + '…' : full;
        if (p.removed) current.serverLines.push({ line: num, snippet: snip, length: full.length });
        if (p.added) current.clientLines.push({ line: num, snippet: snip, length: full.length });
      });
    } else {
      if (current) {
        const after = serverLinesArr.slice(cursor, cursor + 1);
        current.contextAfter = after.map((full, i) => {
          const num = cursor + i + 1;
          const snip = full.length > MAX ? full.slice(0, MAX) + '…' : full;
          return { line: num, snippet: snip, length: full.length };
        });
        current = null;
      }
      cursor += p.value.split('\n').length - 1;
    }
  });

  // Filter out non‑root diffs, keep only those touching <div id="root"> or <h1>
  const isRelevant = (g: any) =>
    [...g.serverLines, ...g.clientLines].some((ln: LineInfo) =>
      /<div id="root"|<h1/.test(ln.snippet)
    );
  const filtered = grouped.filter(isRelevant);

  // JSON mode
  if (argv.format === 'json') {
    console.log(JSON.stringify({ mismatches: filtered }, null, 2));
    process.exit(filtered.length ? 1 : 0);
  }

  // Text mode
  if (!filtered.length) {
    console.log(chalk.green('✅ No hydration mismatches detected.'));
    process.exit(0);
  }

  filtered.forEach((g, idx) => {
    console.error(chalk.yellow(`\nMismatch #${idx + 1}`));
    g.contextBefore.forEach((l) =>
      console.error(chalk.dim(`  ${l.line} | ${l.snippet}`))
    );
    g.serverLines.forEach((l) =>
      console.error(chalk.red(`- ${l.line} | ${l.snippet}`))
    );
    g.clientLines.forEach((l) =>
      console.error(chalk.green(`+ ${l.line} | ${l.snippet}`))
    );
    g.contextAfter.forEach((l) =>
      console.error(chalk.dim(`  ${l.line} | ${l.snippet}`))
    );
  });

  process.exit(1);
}

runDiag().catch((err) => {
  console.error('[ssr-diag] Unexpected error:', err);
  process.exit(1);
});