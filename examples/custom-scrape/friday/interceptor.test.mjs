import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const script = readFileSync(new URL('./interceptor.js', import.meta.url), 'utf8');
test('captures only list APIs and preserves fetch and native XHR behavior', async () => {
  class Xhr extends EventTarget {
    static DONE = 4;
    open() {}
    responseText = '{"items":[]}';
    responseType = '';
  }
  const response = { clone: () => ({ text: async () => '{"items":[]}' }) };
  const window = { location: new URL('https://friday.17usoft.com/system/api-keys'),
    fetch: async () => response, XMLHttpRequest: Xhr };
  const context = vm.createContext({ window, URL, WeakMap, WeakSet, Promise });
  vm.runInContext(script, context);
  const wrappedFetch = window.fetch;
  vm.runInContext(script, context);
  assert.equal(window.fetch, wrappedFetch);
  assert.equal(window.XMLHttpRequest, Xhr);
  assert.equal(window.XMLHttpRequest.DONE, 4);
  const urls = ['/system/api-keys', '/_next/static/chunks/system/api-keys/page.js',
    '/api/authing/v2/workspaces/a/api-keys/key1',
    'https://other.example/api/authing/v2/workspaces/a/api-keys',
    '/api/authing/v2/workspaces/a/api-keys?limit=20'];
  for (const url of urls) assert.equal(await window.fetch(url), response);
  assert.equal(await window.fetch(new URL('https://friday.17usoft.com/api/authing/v2/workspaces/a/api-keys')), response);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(window.__flowlet_scrape_stash.length, 2);
  const xhr = new window.XMLHttpRequest();
  assert.ok(xhr instanceof Xhr);
  for (const url of urls) { xhr.open('GET', url); xhr.dispatchEvent(new Event('load')); }
  assert.equal(window.__flowlet_scrape_stash.length, 3);
  response.clone = () => { throw Error('capture failure'); };
  assert.equal(await window.fetch(urls.at(-1)), response);
});
