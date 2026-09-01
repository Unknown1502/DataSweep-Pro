/*
 * Importing @mcp-b/global for its side effects installs the WebMCP polyfill and
 * initializes document.modelContext. It must run before any component tries to
 * register a tool, so it is the first import in the app.
 */
import '@mcp-b/global';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element.');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
