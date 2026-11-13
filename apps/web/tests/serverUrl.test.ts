import { describe, expect, it } from 'vitest';
import { DEV_SERVER_URL, refusalError, serverUrl } from '../src/net/transport';

describe('serverUrl', () => {
  it('a production build connects to the origin that served it', () => {
    expect(serverUrl({ DEV: false }, 'https://durak.example')).toBe('https://durak.example');
  });

  it('dev mode connects to the local game server', () => {
    expect(serverUrl({ DEV: true }, 'http://localhost:5173')).toBe(DEV_SERVER_URL);
  });

  it('VITE_SERVER_URL overrides both', () => {
    expect(serverUrl({ DEV: false, VITE_SERVER_URL: 'https://api.example' }, 'https://durak.example')).toBe(
      'https://api.example',
    );
    expect(serverUrl({ DEV: true, VITE_SERVER_URL: 'https://api.example' })).toBe('https://api.example');
  });

  it('an empty VITE_SERVER_URL is ignored', () => {
    expect(serverUrl({ DEV: false, VITE_SERVER_URL: '' }, 'https://durak.example')).toBe('https://durak.example');
  });
});

describe('refusalError', () => {
  it('maps a known server code from a refused handshake, anything else to INTERNAL', () => {
    expect(refusalError('TOO_MANY_CONNECTIONS')).toEqual({ code: 'TOO_MANY_CONNECTIONS', message: 'TOO_MANY_CONNECTIONS' });
    expect(refusalError('boom')).toEqual({ code: 'INTERNAL', message: 'boom' });
  });
});
