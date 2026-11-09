import '@fontsource/space-grotesk/400.css';
import '@fontsource/space-grotesk/500.css';
import '@fontsource/space-grotesk/600.css';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-sans-arabic/400.css';
import '@fontsource/ibm-plex-sans-arabic/500.css';
import '@fontsource/ibm-plex-sans-arabic/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import './styles/tokens.css';
import './styles/app.css';
import './styles/screens.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { demoSource } from './api/demo';
import { httpSource } from './api/http';

/**
 * The real dashboard talks to the API. The single-file prototype (and
 * `VITE_DEMO=1`) uses sample data, so the design can be reviewed without a server.
 */
// The saved light or dark choice applies on every page, the login page included.
try {
  const saved = localStorage.getItem('talos.theme');
  document.documentElement.dataset.theme =
    saved === 'light' || saved === 'dark' ? saved : window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
} catch {
  /* storage blocked: the device setting applies through CSS */
}

const demo = import.meta.env.VITE_PROTOTYPE === '1' || import.meta.env.VITE_DEMO === '1';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App source={demo ? demoSource : httpSource} hashRouter={import.meta.env.VITE_PROTOTYPE === '1'} />
  </StrictMode>,
);
