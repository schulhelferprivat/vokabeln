const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const { createServer } = require('node:http');
const path = require('node:path');
const { test, before, after } = require('node:test');
const { chromium } = require('playwright');

let server;
let browser;
let origin;

before(async () => {
  const root = path.resolve(__dirname, '..');
  server = createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const file = pathname === '/' ? 'index.html' : pathname.slice(1);
    if (!['index.html','service-worker.js','manifest.webmanifest','icon-32x32.png','icon-192x192.png','icon-512x512.png'].includes(file)) {
      response.writeHead(404).end();
      return;
    }
    const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'application/javascript' : file.endsWith('.png') ? 'image/png' : 'application/manifest+json';
    response.writeHead(200, {'Content-Type':type});
    response.end(await readFile(path.join(root, file)));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({headless:true, executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});
});

after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
});

function card(id) {
  return {id, front:id, back:`answer ${id}`, flair:'🎓', stage:0, dueAt:0, updatedAt:Date.now()};
}

async function setup(t, legacy = false) {
  const context = await browser.newContext({serviceWorkers:'block'});
  t.after(() => context.close());
  await context.addInitScript(() => localStorage.setItem('notifOnboarding.v1', JSON.stringify({completed:true})));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  const databases = new Map();
  const uploads = [];
  await context.route('https://identitytoolkit.googleapis.com/**', async route => {
    const body = route.request().postDataJSON();
    const uid = body.email.split('@')[0];
    if (body.password === 'wrong') {
      await route.fulfill({status:400,json:{error:{message:'INVALID_PASSWORD'}}});
    } else {
      await route.fulfill({json:{localId:uid,idToken:`token-${uid}`,refreshToken:`refresh-${uid}`,expiresIn:3600}});
    }
  });
  await context.route('https://securetoken.googleapis.com/**', route => {
    const token = new URLSearchParams(route.request().postData()).get('refresh_token');
    const uid = token.slice('refresh-'.length);
    return route.fulfill({json:{user_id:uid,id_token:`token-${uid}`,refresh_token:token,expires_in:3600}});
  });
  await context.route(/https:\/\/.*\.firebaseio\.com\//, route => {
    const url = new URL(route.request().url());
    const uid = url.searchParams.get('auth').slice('token-'.length);
    const key = `${url.hostname}:${uid}`;
    if (route.request().method() === 'PUT') {
      const payload = route.request().postDataJSON();
      uploads.push({key, payload});
      databases.set(key, payload);
    }
    const payload = databases.get(key) || {schemaVersion:2,cards:[card(`cloud-${uid}`)],deletedCardIds:{}};
    return route.fulfill({json:payload,headers:{etag:'"test-version"','access-control-expose-headers':'etag'}});
  });
  if (legacy) {
    await page.route(`${origin}/`, route => route.fulfill({contentType:'text/html',body:'<html></html>'}));
    await page.goto(origin);
    await page.evaluate(async () => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('vokabeln-sync-db', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('settings');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise((resolve, reject) => {
        const tx = db.transaction('settings', 'readwrite');
        tx.objectStore('settings').put({cards:[{id:'legacy',front:'legacy',back:'old',updatedAt:1}],revision:1},'localSnapshot.v1');
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    });
    await page.unroute(`${origin}/`);
  }
  await page.goto(origin);
  await page.waitForFunction(() => !document.getElementById('btnAdd').disabled);
  return {page, context, databases, uploads};
}

async function stored(page, key) {
  return page.evaluate(async key => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('vokabeln-sync-db', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const value = await new Promise((resolve, reject) => {
      const request = db.transaction('settings').objectStore('settings').get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return value;
  }, key);
}

async function activeCards(page) {
  const profile = await stored(page, 'activeProfile.v1');
  const snapshot = await stored(page, ['profileSnapshot.v1',profile.id]);
  return (snapshot?.cards || []).map(card => card.front).sort();
}

async function expectCards(page, expected) {
  const deadline = Date.now() + 5000;
  let actual;
  do {
    actual = await activeCards(page);
    if (JSON.stringify(actual) === JSON.stringify([...expected].sort())) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  assert.deepEqual(actual, [...expected].sort());
}

async function add(page, front, back = `answer ${front}`) {
  await page.click('#tabList');
  await page.fill('#addFront', front);
  await page.fill('#addBack', back);
  await page.click('#btnAdd');
  await page.waitForFunction(() => document.getElementById('addFront').value === '');
}

async function connect(page, uid, database = 'one') {
  await page.click('#tabSettings');
  await page.click('#btnOpenFirebaseDialog');
  await page.fill('#firebaseDatabaseUrl', `https://${database}.firebaseio.com`);
  await page.fill('#firebaseApiKey', 'key');
  await page.fill('#firebaseEmail', `${uid}@test.invalid`);
  await page.fill('#firebasePassword', 'password');
  await page.click('#btnConnectFirebase');
  await page.waitForFunction(() => document.getElementById('confirmDialog').open || !document.getElementById('firebaseDialog').open);
  if (await page.locator('#confirmDialog').evaluate(dialog => dialog.open)) await page.click('#btnConfirmCancel');
  await page.locator('#firebaseDialog').waitFor({state:'hidden'});
}

test('real UI separates device, accounts and databases across switching and reload', {timeout:60000}, async t => {
  const {page, uploads} = await setup(t);
  await add(page, 'Gerätekarte', 'device');
  await expectCards(page, ['Gerätekarte']);
  await connect(page, 'A');
  await expectCards(page, ['cloud-A']);
  await add(page, 'Privatgeheimnis', 'confidential translation');
  await connect(page, 'B');
  await expectCards(page, ['cloud-B']);
  await connect(page, 'A');
  await expectCards(page, ['cloud-A','Privatgeheimnis']);
  await connect(page, 'A', 'two');
  await expectCards(page, ['cloud-A']);
  await page.reload();
  await expectCards(page, ['cloud-A']);
  assert.equal((await stored(page,'activeProfile.v1')).config.databaseUrl, 'https://two.firebaseio.com');
  await page.click('#tabSettings');
  await page.click('#btnDeviceProfile');
  await expectCards(page, ['Gerätekarte']);
  for (const upload of uploads) {
    assert.ok(!upload.payload.cards.some(card => card.front === 'Gerätekarte'));
    if (upload.key !== 'one.firebaseio.com:A') assert.ok(!upload.payload.cards.some(card => card.front === 'Privatgeheimnis'));
  }
});

test('migration notice appears once and old cards stay on the device', {timeout:30000}, async t => {
  const {page} = await setup(t, true);
  await page.locator('#noticeDialog').waitFor({state:'visible'});
  assert.match(await page.locator('#noticeText').textContent(), /bisherigen Karten bleiben/);
  await page.click('#btnNoticeOk');
  await expectCards(page, ['legacy']);
  await page.reload();
  await page.waitForFunction(() => !document.getElementById('btnAdd').disabled);
  assert.equal(await page.locator('#noticeDialog').evaluate(dialog => dialog.open), false);
  await connect(page, 'B');
  await expectCards(page, ['cloud-B']);
  await page.click('#btnDeviceProfile');
  await expectCards(page, ['legacy']);
});

test('real directory handles are reused after switching and restarting', {timeout:30000}, async t => {
  const {page} = await setup(t);
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getDirectoryHandle('first', {create:true});
    window.showDirectoryPicker = async () => handle;
  });
  await page.click('#tabSettings');
  await page.click('#btnPickSyncFolder');
  await page.waitForFunction(async () => {
    const db = await new Promise(resolve => { const req = indexedDB.open('vokabeln-sync-db',1); req.onsuccess = () => resolve(req.result); });
    const record = await new Promise(resolve => { const req = db.transaction('settings').objectStore('settings').get('activeProfile.v1'); req.onsuccess = () => resolve(req.result); });
    db.close();
    return record?.kind === 'directory';
  });
  const original = await stored(page, 'activeProfile.v1');
  await add(page, 'Ordnerwort', 'directory translation');
  await page.click('#tabSettings');
  await page.click('#btnDeviceProfile');
  await expectCards(page, []);
  await page.click('#btnPickSyncFolder');
  await expectCards(page, ['Ordnerwort']);
  assert.equal((await stored(page,'activeProfile.v1')).id, original.id);
  await page.reload();
  await expectCards(page, ['Ordnerwort']);
  assert.equal((await stored(page,'activeProfile.v1')).id, original.id);
});
