# ssr-diag

A CLI tool to detect React SSR hydration mismatches by diffing server‑rendered HTML vs. hydrated DOM.

## Install

    npm install -g ssr-diag
    # or, for the alpha prerelease:
    npm install -g ssr-diag@alpha

## Usage

    ssr-diag run <path-to-SSR-output> [options]

## Commands

**`run <path>`**  
Scan the specified folder (must contain your HTML file) for hydration mismatches.

## Options

- **`-h, --help`**: Show this help message and exit  
- **`-i, --index <file>`**: Name of the HTML file to serve (default: `index.html`)  
- **`-p, --port <num>`**: Static server port (default: random)  
- **`-v, --verbose`**: Print extra debug information

## Examples

    # Basic
    ssr-diag run ./out

    # Custom index file
    ssr-diag run ./dist -i main.html

    # Pin port and verbose
    ssr-diag run ./out -p 8080 -v

## GitHub Actions

Fail your CI on hydration mismatches:

    name: Hydration Check
    on: [push, pull_request]

    jobs:
      hydration:
        runs-on: ubuntu-latest
        steps:
          - uses: actions/checkout@v3
          - name: Build SSR output
            run: npm run build:ssr
          - name: Install ssr-diag
            run: npm install -g ssr-diag@alpha
          - name: Run hydration diagnostic
            run: ssr-diag run ./out

## Contributing

Open issues or PRs for bug reports, feature requests, or improvements. Feedback welcome—especially on diff formatting and JSON output mode!
