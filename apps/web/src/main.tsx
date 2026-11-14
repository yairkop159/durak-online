import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';
import { GameClient } from './net/client';
import { ClientProvider } from './net/react';
import { browserSessionStorage } from './net/sessionStore';
import { serverUrl, socketTransport } from './net/transport';
import { registerServiceWorker } from './pwa/registerSW';

const client = new GameClient({ transport: socketTransport(serverUrl()), storage: browserSessionStorage() });

registerServiceWorker();

const root = document.getElementById('root');
if (!root) throw new Error('#root missing');
createRoot(root).render(
  <StrictMode>
    <ClientProvider client={client}>
      <App />
    </ClientProvider>
  </StrictMode>,
);
