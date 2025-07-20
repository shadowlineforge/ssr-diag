import * as ReactDOMClient from 'react-dom/client';

const originalHydrate = (ReactDOMClient as any).hydrateRoot;

Object.defineProperty(ReactDOMClient, 'hydrateRoot', {
  value: function (...args: any[]) {
    try {
      return originalHydrate.apply(this, args);
    } catch (err: any) {
      console.error('[ssr-diag] Hydration mismatch detected');
      console.error(err.componentStack);
      // TODO: serialize server vs client HTML
      throw err;
    }
  },
  writable: true,
  configurable: true,
});

export {}; // ensure this file is a module
