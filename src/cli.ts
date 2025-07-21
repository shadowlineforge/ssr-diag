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
  const serverLinesArr = serverHtml.split('\n');

  // Capture hydrated HTML
  const clientHtml: string = await page.evaluate(
    () => document.documentElement.outerHTML
  );

  await browser.close();
  server.close();

  await browser.close();
  server.close();

  // ── Normalize out the doctype and any comments before <html> ──
  const normalize = (html: string) =>
    html.replace(/^<!DOCTYPE html>.*?<html/, '<html').trim();

  const cleanServerHtml = normalize(serverHtml);
  const cleanClientHtml = normalize(clientHtml);

  // ── Diff results on normalized HTML ──
  const diffs = diffLines(cleanServerHtml, cleanClientHtml);

  // JSON mode with line numbers
  if (argv.format === 'json') {
    const MAX_SNIPPET = 120;
    const grouped: Array<{
      contextBefore: { line: number; snippet: string; length: number }[];
      serverLines: { line: number; snippet: string; length: number }[];
      clientLines: { line: number; snippet: string; length: number }[];
      contextAfter: { line: number; snippet: string; length: number }[];
    }> = [];
    let cursor = 0;
    let current: any = null;

    diffs.forEach((p) => {
      const lines = p.value.split('\n').filter(Boolean);
      if (p.added || p.removed) {
        if (!current) {
          const beforeLines = serverLinesArr.slice(Math.max(0, cursor - 2), cursor);
          current = {
            contextBefore: beforeLines.map((full, idx) => {
              const lineNum = cursor - beforeLines.length + idx + 1;
              const snippet = full.length > MAX_SNIPPET ? full.slice(0, MAX_SNIPPET) + '…' : full;
              return { line: lineNum, snippet, length: full.length };
            }),
            serverLines: [],
            clientLines: [],
            contextAfter: []
          };
          grouped.push(current);
        }
        if (p.removed) {
          lines.forEach((full, idx) => {
            const lineNum = cursor + idx + 1;
            const snippet = full.length > MAX_SNIPPET ? full.slice(0, MAX_SNIPPET) + '…' : full;
            current.serverLines.push({ line: lineNum, snippet, length: full.length });
          });
        }
        if (p.added) {
          lines.forEach((full, idx) => {
            const lineNum = cursor + idx + 1;
            const snippet = full.length > MAX_SNIPPET ? full.slice(0, MAX_SNIPPET) + '…' : full;
            current.clientLines.push({ line: lineNum, snippet, length: full.length });
          });
        }
      } else {
        if (current) {
          const afterLines = serverLinesArr.slice(cursor, cursor + 2);
          current.contextAfter = afterLines.map((full, idx) => {
            const lineNum = cursor + idx + 1;
            const snippet = full.length > MAX_SNIPPET ? full.slice(0, MAX_SNIPPET) + '…' : full;
            return { line: lineNum, snippet, length: full.length };
          });
          current = null;
        }
        cursor += p.value.split('\n').length - 1;
      }
    });

    console.log(JSON.stringify({ mismatches: grouped }, null, 2));
    process.exit(grouped.length ? 1 : 0);
  }

  // Text mode with context
  let mismatchCount = 0;
  let cursor = 0;

  diffs.forEach((part) => {
    if (!part.added && !part.removed) {
      cursor += part.value.split('\n').length - 1;
      return;
    }
    mismatchCount++;
    console.error(chalk.yellow(`\nMismatch #${mismatchCount}`));

    // context before
    const start = Math.max(0, cursor - 2);
    for (let c = start; c < cursor; c++) {
      console.error(chalk.dim(`  ${c + 1} | ${serverLinesArr[c]}`));
    }

    // removed = server
    if (part.removed) {
      part.value.split('\n').filter(Boolean).forEach((l, idx) => {
        console.error(chalk.red(`- ${cursor + idx + 1} | ${l}`));
      });
    }
    // added = client
    if (part.added) {
      part.value.split('\n').filter(Boolean).forEach((l, idx) => {
        console.error(chalk.green(`+ ${cursor + idx + 1} | ${l}`));
      });
    }

    // advance cursor over removed lines
    if (part.removed) {
      cursor += part.value.split('\n').length - 1;
    }

    // context after
    const end = Math.min(serverLinesArr.length, cursor + 2);
    for (let c = cursor; c < end; c++) {
      console.error(chalk.dim(`  ${c + 1} | ${serverLinesArr[c]}`));
    }
  });

  if (mismatchCount === 0) {
    console.log(chalk.green('✅ No hydration mismatches detected.'));
    process.exit(0);
  }
  process.exit(1);
}

runDiag().catch((err) => {
  console.error('[ssr-diag] Unexpected error:', err);
  process.exit(1);
});