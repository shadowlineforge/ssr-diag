import React from 'react';
import { hydrateRoot } from 'react-dom/client';

setTimeout(() => {
  // This intentionally mismatches the SSR output
  hydrateRoot(
    document.getElementById('root'),
    React.createElement('h1', null, 'Hello CSR')
  );
}, 100);
