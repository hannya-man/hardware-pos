// Runs public/sw.js against fake service-worker globals: online, offline,
// a page address it never saw, a redirect, and another site's request.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { checker } from './harness.mjs';

const SCOPE = 'https://hannya-man.github.io/hardware-pos/';
const { check, finish } = checker();

const store = new Map();
const caches = {
  open: async () => ({
    put: async (request, response) => { store.set(request.url, await response.text()); },
    match: async (request, { ignoreSearch } = {}) => {
      const url = typeof request === 'string' ? request : request.url;
      const key = ignoreSearch ? url.split('?')[0] : url;
      return store.has(key) ? new Response(store.get(key), { status: 200 }) : undefined;
    },
  }),
};
let online = true;
let fetched = 0;
const site = { [SCOPE]: '<html>app v1</html>', [`${SCOPE}assets/index-1.js`]: 'js v1' };
const fakeFetch = async (request) => {
  fetched++;
  if (!online) throw new TypeError('Failed to fetch');
  if (request.url === 'https://hannya-man.github.io/hardware-pos') {
    return Object.defineProperty(new Response(site[SCOPE], { status: 200 }), 'redirected', { value: true });
  }
  return site[request.url] ? new Response(site[request.url], { status: 200 }) : new Response('nope', { status: 404 });
};

const handlers = {};
const self = {
  location: new URL(SCOPE),
  registration: { scope: SCOPE },
  clients: { claim: async () => {} },
  skipWaiting: () => {},
  addEventListener: (type, fn) => { handlers[type] = fn; },
};
vm.runInNewContext(readFileSync(new URL('../caidic-pos-frontend/public/sw.js', import.meta.url), 'utf8'),
  { self, caches, fetch: fakeFetch, Response, URL, console });

async function visit(url, { method = 'GET', mode = 'no-cors' } = {}) {
  let answer = null;
  handlers.fetch({ request: { url, method, mode }, respondWith: (p) => { answer = p; } });
  if (!answer) return null;
  const response = await answer;
  return response.type === 'error' ? 'error' : await response.text();
}

check('online: the page from the network', (await visit(SCOPE, { mode: 'navigate' })) === '<html>app v1</html>');
check('online: a file from the network', (await visit(`${SCOPE}assets/index-1.js`)) === 'js v1');
check('both kept', store.size === 2, [...store.keys()].join());
const before = fetched;
check('another site (Supabase) is left alone', (await visit('https://ref.supabase.co/rest/v1/rpc/pos_ping', { method: 'POST' })) === null && fetched === before);
check('POST is left alone', (await visit(`${SCOPE}x`, { method: 'POST' })) === null);

site[SCOPE] = '<html>app v2</html>';
check('online: a new deploy shows at once', (await visit(SCOPE, { mode: 'navigate' })) === '<html>app v2</html>');

online = false;
check('offline: the page from the saved copy', (await visit(SCOPE, { mode: 'navigate' })) === '<html>app v2</html>');
check('offline: files from the saved copy', (await visit(`${SCOPE}assets/index-1.js?v=1`)) === 'js v1');
check('offline: another page address opens the app', (await visit(`${SCOPE}index.html`, { mode: 'navigate' })) === '<html>app v2</html>');
check('offline: an unknown file is a network error', (await visit(`${SCOPE}assets/missing.js`)) === 'error');

online = true;
store.clear();
await visit('https://hannya-man.github.io/hardware-pos', { mode: 'navigate' });
check('a redirected page is not kept', store.size === 0);

finish('service worker');
