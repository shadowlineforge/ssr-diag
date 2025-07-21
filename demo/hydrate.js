import React from 'react';
import { hydrateRoot } from 'react-dom/client';

setTimeout(() => {
  hydrateRoot(
    document.getElementById('root'),
    React.createElement('h1', null, 'Client says Hello')
  );
}, 100);
