#!/usr/bin/env node
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const path_1 = __importDefault(require("path"));
const http_1 = require("http");
const serveHandler = require('serve-handler');
const puppeteer_1 = __importDefault(require("puppeteer"));
const diff_1 = require("diff");
const promises_1 = require("fs/promises");
const minimist_1 = __importDefault(require("minimist"));
const chalk_1 = __importDefault(require("chalk"));
async function runDiag() {
    const argv = (0, minimist_1.default)(process.argv.slice(2), {
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
    const folder = path_1.default.resolve(process.cwd(), argv._[1]);
    const indexFile = argv.index;
    const forcedPort = argv.port ? Number(argv.port) : undefined;
    const isVerbose = argv.verbose;
    if (isVerbose)
        console.log(`[ssr-diag] Serving folder: ${folder}`);
    // Start static server
    const server = (0, http_1.createServer)((req, res) => serveHandler(req, res, { public: folder }));
    await new Promise((resolve) => server.listen(forcedPort ?? 0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    if (!addr) {
        console.error('❌ Failed to start static server');
        process.exit(1);
    }
    const port = typeof addr === 'object' ? addr.port : addr;
    const url = `http://127.0.0.1:${port}/${indexFile}`;
    console.log(`[ssr-diag] Serving ${folder} → ${url}`);
    // Launch Puppeteer in CI‑friendly mode
    const browser = await puppeteer_1.default.launch({
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await browser.newPage();
    // Inject hydration‑wrapper
    const wrapperSource = await (0, promises_1.readFile)(path_1.default.resolve(__dirname, 'index.js'), 'utf8');
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
    const clientHtml = await page.evaluate(() => document.documentElement.outerHTML);
    await browser.close();
    server.close();
    await browser.close();
    server.close();
    // ── Normalize out the doctype and any comments before <html> ──
    const normalize = (html) => html.replace(/^<!DOCTYPE html>.*?<html/, '<html').trim();
    const cleanServerHtml = normalize(serverHtml);
    const cleanClientHtml = normalize(clientHtml);
    // ── Diff results on normalized HTML ──
    const diffs = (0, diff_1.diffLines)(cleanServerHtml, cleanClientHtml);
    // JSON mode with line numbers
    if (argv.format === 'json') {
        const MAX_SNIPPET = 120;
        const grouped = [];
        let cursor = 0;
        let current = null;
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
            }
            else {
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
        console.error(chalk_1.default.yellow(`\nMismatch #${mismatchCount}`));
        // context before
        const start = Math.max(0, cursor - 2);
        for (let c = start; c < cursor; c++) {
            console.error(chalk_1.default.dim(`  ${c + 1} | ${serverLinesArr[c]}`));
        }
        // removed = server
        if (part.removed) {
            part.value.split('\n').filter(Boolean).forEach((l, idx) => {
                console.error(chalk_1.default.red(`- ${cursor + idx + 1} | ${l}`));
            });
        }
        // added = client
        if (part.added) {
            part.value.split('\n').filter(Boolean).forEach((l, idx) => {
                console.error(chalk_1.default.green(`+ ${cursor + idx + 1} | ${l}`));
            });
        }
        // advance cursor over removed lines
        if (part.removed) {
            cursor += part.value.split('\n').length - 1;
        }
        // context after
        const end = Math.min(serverLinesArr.length, cursor + 2);
        for (let c = cursor; c < end; c++) {
            console.error(chalk_1.default.dim(`  ${c + 1} | ${serverLinesArr[c]}`));
        }
    });
    if (mismatchCount === 0) {
        console.log(chalk_1.default.green('✅ No hydration mismatches detected.'));
        process.exit(0);
    }
    process.exit(1);
}
runDiag().catch((err) => {
    console.error('[ssr-diag] Unexpected error:', err);
    process.exit(1);
});
