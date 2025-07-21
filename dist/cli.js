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
async function runDiag() {
    const argv = (0, minimist_1.default)(process.argv.slice(2), {
        alias: { h: 'help', i: 'index', p: 'port', v: 'verbose' },
        boolean: ['help', 'verbose'],
        string: ['index', 'port'],
        default: { index: 'index.html' }
    });
    if (argv.help || argv._[0] !== 'run' || !argv._[1]) {
        console.log(`
Usage: ssr-diag run <path> [options]

Commands:
  run <path>          Scan the SSR output folder at <path> for hydration mismatches

Options:
  -h, --help          Show this help message and exit
  -i, --index <file>  Name of the HTML file to serve (default: index.html)
  -p, --port <num>    Port for static server (default: random)
  -v, --verbose       Print extra debug information
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
    await new Promise(resolve => server.listen(forcedPort ?? 0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    if (!addr) {
        console.error('❌ Failed to start static server');
        process.exit(1);
    }
    const port = typeof addr === 'object' ? addr.port : addr;
    const url = `http://127.0.0.1:${port}/${indexFile}`;
    console.log(`[ssr-diag] Serving ${folder} → ${url}`);
    // Puppeteer
    const browser = await puppeteer_1.default.launch({
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    // Inject hydration‑wrapper
    const wrapperSource = await (0, promises_1.readFile)(path_1.default.resolve(__dirname, 'index.js'), 'utf8');
    await page.evaluateOnNewDocument(wrapperSource);
    // Load page and grab pre‑hydrate HTML
    const response = await page.goto(url, { waitUntil: 'networkidle0' });
    if (!response || response.status() >= 400) {
        console.error(`❌ Failed to load page (status ${response?.status()})`);
        await browser.close();
        server.close();
        process.exit(1);
    }
    const serverHtml = await page.content();
    // Grab hydrated HTML
    const clientHtml = await page.evaluate(() => document.documentElement.outerHTML);
    await browser.close();
    server.close();
    // Diff and report
    const diffs = (0, diff_1.diffLines)(serverHtml, clientHtml);
    const changes = diffs.filter(p => p.added || p.removed);
    if (changes.length === 0) {
        console.log('✅ No hydration mismatches detected.');
        process.exit(0);
    }
    console.error('❌ Hydration mismatches found:');
    diffs.forEach(part => {
        const prefix = part.added ? '+' : part.removed ? '-' : ' ';
        part.value.split('\n').forEach(line => {
            if (line)
                console.error(`${prefix} ${line}`);
        });
    });
    process.exit(1);
}
runDiag().catch(err => {
    console.error('[ssr-diag] Unexpected error:', err);
    process.exit(1);
});
