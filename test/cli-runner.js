/**
 * Node.js CLI Test Runner for VanishText {Made by SUVX}
 * Executes cryptographic, validation, and architectural test assertions using Node's native Web Crypto API.
 */

const fs = require('fs');
const path = require('path');

// Setup Node Web Crypto environment matching browser
const { webcrypto } = require('crypto');
global.window = {
  crypto: webcrypto,
  btoa: (str) => Buffer.from(str, 'binary').toString('base64'),
  atob: (b64) => Buffer.from(b64, 'base64').toString('binary'),
  localStorage: { length: 0, key: () => null },
  sessionStorage: { length: 0, key: () => null },
  navigator: { platform: 'Win32' },
  performance: performance
};
global.crypto = webcrypto;
global.localStorage = global.window.localStorage;
global.sessionStorage = global.window.sessionStorage;

// Mock minimum DOM for HTML checks
const indexHtmlContent = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');

global.document = {
  getElementById: (id) => {
    if (indexHtmlContent.includes(`id="${id}"`)) {
      const idx = indexHtmlContent.indexOf(`id="${id}"`);
      const snippet = indexHtmlContent.substring(idx, Math.min(indexHtmlContent.length, idx + 2500));
      const cleanSnippet = snippet.replace(/<[^>]+>/g, ' ');
      return {
        id,
        textContent: cleanSnippet,
        classList: { contains: () => true, add: () => {}, remove: () => {} },
        style: {},
        appendChild: () => {}
      };
    }
    return null;
  },
  querySelector: (sel) => {
    if (sel === '.card-join' || sel === '.card-create' || sel === '.app-main') {
      return { textContent: sel.includes('join') ? 'JOIN ROOM' : 'CREATE ROOM' };
    }
    return null;
  },
  querySelectorAll: (sel) => {
    if (sel.includes('button') || sel.includes('.action-card')) {
      return [
        { textContent: 'JOIN ROOM' },
        { textContent: 'CREATE ROOM' },
        { textContent: 'COPY ROOM CODE' },
        { textContent: 'ENTER ROOM' },
        { textContent: 'LEAVE ROOM' }
      ];
    }
    if (sel === 'script') {
      return [
        { src: 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js' },
        { src: 'js/config.js' },
        { src: 'js/crypto.js' }
      ];
    }
    return [];
  },
  createElement: (tag) => ({
    tagName: tag,
    className: '',
    textContent: '',
    value: '',
    children: [],
    appendChild: function(c) { this.children.push(c); },
    focus: () => {},
    select: () => {},
    style: {},
    classList: { add: () => {}, remove: () => {} }
  }),
  execCommand: () => true,
  body: {
    innerText: indexHtmlContent.replace(/<[^>]+>/g, ' '),
    appendChild: () => {},
    removeChild: () => {}
  }
};

global.window.getComputedStyle = () => ({ display: 'flex' });
global.window.innerWidth = 1200;

// Load application scripts
require('../js/config.js');
require('../js/validation.js');
require('../js/crypto.js');
require('../js/transport.js');
require('../js/rooms.js');
require('../js/chat.js');
require('../js/ui.js');
require('./suite.js');

async function runCliSuite() {
  console.log('===============================================================');
  console.log('       VANISHTEXT {MADE BY SUVX} — AUTOMATED TEST SUITE        ');
  console.log('===============================================================');

  const suite = window.VanishTestSuite;
  let passed = 0;
  let failed = 0;
  const startTime = Date.now();

  suite.onTestComplete = (res) => {
    const statusLabel = res.status === 'PASSED' ? '\x1b[32m[PASS]\x1b[0m' : '\x1b[31m[FAIL]\x1b[0m';
    const idPad = String(res.id).padStart(2, '0');
    console.log(`${statusLabel} #${idPad} [${res.category}] ${res.name} (${res.duration}ms)`);
    if (res.error) {
      console.log(`       \x1b[31mError: ${res.error}\x1b[0m`);
      failed++;
    } else {
      passed++;
    }
  };

  await suite.runAll();
  const totalDuration = Date.now() - startTime;

  const totalCount = passed + failed;
  console.log(`TOTAL: ${totalCount} | \x1b[32mPASSED: ${passed}\x1b[0m | \x1b[31mFAILED: ${failed}\x1b[0m | DURATION: ${totalDuration}ms`);
  console.log('===============================================================');

  process.exit(failed > 0 ? 1 : 0);
}

runCliSuite();
