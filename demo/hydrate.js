import React from 'react';
import { hydrateRoot } from 'react-dom/client';

console.log('🚨 demo hydration running');

hydrateRoot(
  document.getElementById('root'),
  React.createElement('h1', null, 'Client says Hello')
);
