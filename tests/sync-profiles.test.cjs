const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');
const { IDBFactory } = require('fake-indexeddb');

const html = readFileSync(new URL('../index.html', `file://${__filename}`), 'utf8');
const functionNames = [
  'uid', 'normalizeTimestamp', 'normalizeDeletedCardTimestamps', 'pruneDeletedCardTimestamps',
  'normalizeCardFlair', 'normalizeCard', 'normalizeSyncState', 'getLocalSyncStateSnapshot',
  'cloneCard', 'resolveCardEvent', 'pickWinningCardEvent', 'mergeSyncStates', 'areSyncStatesEqual',
  'applySyncStateToLocal', 'hasPendingSyncWork', 'buildSyncPayload', 'parseSyncPayload',
  'openSyncDb', 'idbSet', 'idbGet', 'idbDelete', 'writeLocalSnapshot', 'persistLocalSnapshot',
  'restoreLocalSnapshot', 'profileSnapshotKey', 'getFirebaseProfileId', 'applyProfileSnapshot',
  'migrateSyncProfiles', 'findLocalProfile', 'commitActiveProfile', 'applyActiveProfile',
  'switchSyncProfile', 'trackProfileMutation', 'activateDeviceProfile',
  'normalizeFirebaseConfig', 'toPersistedFirebaseConfig', 'normalizeFirebaseSession',
  'applyFirebaseSession', 'applyFirebaseAuthenticatedSession', 'isFirebaseSessionCurrent',
  'queueFirebaseSessionPersist', 'persistFirebaseSession', 'clearFirebaseSessionAndPersist',
  'clearFirebaseSession', 'queueFirebaseConfigPersist', 'restoreSyncConfig',
  'isSecureFirebaseDatabaseUrl', 'isLocalhostHostname', 'isSupportedFirebaseAppOrigin',
  'isFirebaseRealtimeDatabaseUrl', 'validateFirebaseConfig', 'validateFirebaseConfigTransport',
  'isFirebaseSyncActive', 'isLocalSyncActive', 'isAnySyncActive', 'clearSyncRetryTimer',
  'runAutoSync', 'performAutoSync', 'pushToActiveSync', 'pullFromActiveSync',
  'pushToFirebase', 'pullFromFirebase', 'fetchFirebaseSyncState', 'buildFirebaseUrl',
  'buildFirebaseHeaders', 'firebaseFetch', 'mapFirebaseFetchError', 'ensureFirebaseIdToken',
  'refreshFirebaseIdToken', 'mapFirebaseAuthError', 'signInFirebaseWithPassword', 'firebaseAuthRequest',
  'activateFirebase', 'connectFirebase', 'isFirebaseConnectionAttemptCurrent',
  'abandonFirebaseConnectionAttempt'
];
const source = functionNames.map(name => {
  const match = html.match(new RegExp('^      (?:async )?function ' + name + '\\([^]*?^      \\}', 'm'));
  assert.ok(match, name);
  return match[0];
}).join('\n');
const stateSource = html.match(/^      const state = \{[^]*?^      \};/m)[0];

function app(indexedDB = new IDBFactory()) {
  const timers = new Map();
  let nextTimer = 0;
  const context = vm.createContext({
    indexedDB, URL, URLSearchParams, Response, console,
    setTimeout: callback => { timers.set(++nextTimer, callback); return nextTimer; },
    clearTimeout: id => timers.delete(id),
    window: { isSecureContext: true, location: { protocol: 'https:', hostname: 'app.test' } },
    fetch: async () => { throw new Error('Unexpected network request'); }
  });
  vm.runInContext(`
    const STAGES = [0,1,3,7,14,30,60,120,240,365,730];
    const CARD_FLAIRS = ['🎓','🇺🇸'];
    const DEFAULT_CARD_FLAIR = CARD_FLAIRS[0];
    const SYNC_DB_NAME = 'vokabeln-sync-db';
    const SYNC_DB_STORE = 'settings';
    const SYNC_LOCAL_SNAPSHOT_KEY = 'localSnapshot.v1';
    const SYNC_OUTBOX_KEY = 'syncOutbox.v1';
    const SYNC_MODE_KEY = 'syncMode';
    const SYNC_FIREBASE_SESSION_KEY = 'syncFirebaseSession';
    const SYNC_FIREBASE_CONFIG_KEY = 'syncFirebaseConfig';
    const SYNC_LOCAL_DIRECTORY_KEY = 'syncLocalDirectoryHandle';
    const SYNC_LOCAL_FILE_KEY = 'syncLocalFileHandle';
    const SYNC_FIREBASE_CONFIG_EXPORT_PROMPT_KEY = 'syncFirebaseConfigExportPrompt';
    const SYNC_ACTIVE_PROFILE_KEY = 'activeProfile.v1';
    const SYNC_PROFILES_KEY = 'profiles.v1';
    const SYNC_FIREBASE_DRAFT_KEY = 'firebaseDraft.v1';
    const SYNC_PROFILE_MIGRATION_NOTICE_KEY = 'profileMigrationNotice.v1';
    const DEVICE_PROFILE_ID = 'device';
    const SYNC_TOMBSTONE_RETENTION_MS = 180 * 86400000;
    const SYNC_SCHEMA_VERSION = 2;
    const SYNC_FIREBASE_CONFLICT_RETRY_LIMIT = 3;
    const now = () => Date.now();
    const createInitialData = () => ({cards:[]});
    const createDefaultStudyFlairSelection = () => ({});
    const loadThemeMode = () => 'dark';
    const requestRenderAfterDataChange = () => {};
    const updateAppBadge = () => {};
    const setLocalDataControlsEnabled = () => {};
    const resetProfileView = () => {};
    const renderStudy = () => {};
    const setSyncModeUi = () => {};
    const applyFirebaseConfigToUi = () => {};
    const scheduleSyncRetry = () => {};
    const scheduleSyncWrite = () => {};
    const setSyncResultStatus = () => {};
    const setSyncStatus = () => {};
    const showNotice = message => { notices.push(message); };
    const notices = [];
    const setFirebaseConnectionInProgress = value => { state.firebaseConnectInProgress = value; };
    const offerFirebaseConfigExport = async () => {};
    const closeFirebaseDialog = () => {};
    let localSnapshotPersistPromise = Promise.resolve();
    ${stateSource}
    ${source}
    globalThis.state = state;
    globalThis.notices = notices;
    state.localRestoreComplete = true;
  `, context);
  context.evaluate = script => vm.runInContext(script, context);
  context.database = indexedDB;
  return context;
}

function card(id, updatedAt = Date.now()) {
  return { id, front: id, back: `answer ${id}`, stage: 0, dueAt: 0, flair: '🎓', updatedAt };
}

function profile(app, userUid, database = 'one') {
  const config = {databaseUrl: `https://${database}.firebaseio.com`, apiKey: 'key', email: `${userUid}@test.invalid`};
  return {id: app.getFirebaseProfileId(config, userUid), kind: 'firebase', config,
    session: {userUid, refreshToken: `refresh-${userUid}`, idToken: `token-${userUid}`, tokenExpiresAt: Date.now() + 60000}};
}

async function initialized() {
  const a = app();
  await a.restoreSyncConfig();
  await a.restoreLocalSnapshot();
  return a;
}

function ids(cards) {
  return Array.from(cards, card => card.id);
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise, resolve};
}

async function seedCards(a, cards, pending = true) {
  a.state.data.cards = cards;
  a.state.localRevision++;
  a.state.pendingSyncWrite = pending;
  if (!pending) a.state.lastSyncedRevision = a.state.localRevision;
  await a.persistLocalSnapshot();
}

function remote(cards) {
  return new Response(JSON.stringify({schemaVersion:2, cards, deletedCardIds:{}}),
    {headers:{etag:'"version"'}});
}

test('accounts, databases and the device retain independent snapshots and pending deletions', async () => {
  const a = await initialized();
  await seedCards(a, [card('device-only')]);
  const first = profile(a, 'A');
  const second = profile(a, 'B');
  const otherDatabase = profile(a, 'A', 'two');
  await a.switchSyncProfile(() => first);
  assert.deepEqual(ids(a.state.data.cards), []);
  await seedCards(a, [card('private-A')]);
  a.state.syncDeletedCardTimestamps = {'removed-A': Date.now()};
  await a.switchSyncProfile(() => second);
  assert.deepEqual(ids(a.state.data.cards), []);
  assert.equal(a.hasPendingSyncWork(), false);
  await seedCards(a, [card('private-B')], false);
  await a.switchSyncProfile(() => otherDatabase);
  assert.deepEqual(ids(a.state.data.cards), []);
  await a.switchSyncProfile(() => first);
  assert.deepEqual(ids(a.state.data.cards), ['private-A']);
  assert.ok(a.state.syncDeletedCardTimestamps['removed-A']);
  assert.equal(a.hasPendingSyncWork(), true);
  await a.switchSyncProfile(() => second);
  assert.deepEqual(ids(a.state.data.cards), ['private-B']);
  assert.equal(a.hasPendingSyncWork(), false);
  await a.activateDeviceProfile();
  assert.deepEqual(ids(a.state.data.cards), ['device-only']);
});

test('switching to an empty Firebase database never uploads old cards', async () => {
  const a = await initialized();
  await seedCards(a, [card('private-device')], false);
  const target = profile(a, 'B');
  const uploads = [];
  a.fetch = async (url, options) => {
    if (options.method === 'PUT') {
      uploads.push(JSON.parse(options.body));
      return remote([]);
    }
    return remote([]);
  };
  await a.activateFirebase(target.config, {session:target.session});
  assert.deepEqual(ids(a.state.data.cards), []);
  assert.equal(uploads.length, 0);
  a.fetch = async (url, options) => {
    if (options.method === 'PUT') {
      uploads.push(JSON.parse(options.body));
      return remote([]);
    }
    return new Response('null', {headers:{etag:'"empty"'}});
  };
  await a.runAutoSync();
  assert.deepEqual(uploads.map(item => ids(item.cards)), [[]]);
});

test('migration retains snapshot, outbox and original backup without retaining an active cloud session', async () => {
  const a = app();
  const old = {cards:[card('snapshot')], deletedCardIds:{}, revision:3, lastSyncedRevision:3};
  const outbox = {cards:[card('unsent')], deletedCardIds:{gone:Date.now()}, revision:4};
  await a.idbSet('localSnapshot.v1', old);
  await a.idbSet('syncOutbox.v1', outbox);
  await a.idbSet('syncFirebaseConfig', profile(a, 'A').config);
  await a.idbSet('syncFirebaseSession', profile(a, 'A').session);
  await a.idbSet('syncMode', 'firebase');
  await a.restoreSyncConfig();
  await a.restoreLocalSnapshot();
  assert.equal(a.state.activeProfileId, 'device');
  assert.equal(a.state.syncMode, null);
  assert.deepEqual(ids(a.state.data.cards), ['snapshot', 'unsent']);
  assert.ok(a.state.syncDeletedCardTimestamps.gone);
  assert.equal(a.state.pendingSyncWrite, true);
  assert.deepEqual(await a.idbGet('legacyProfileBackup.v1'), {snapshot:old, outbox});
  assert.equal(await a.idbGet('syncFirebaseSession'), null);
  assert.equal(await a.idbGet('profileMigrationNotice.v1'), true);
  await a.idbDelete('profileMigrationNotice.v1');
  await a.migrateSyncProfiles();
  assert.equal(await a.idbGet('profileMigrationNotice.v1'), null);
  assert.deepEqual(ids((await a.idbGet(a.profileSnapshotKey('device'))).cards), ['snapshot','unsent']);
});

test('a failed migration rolls back atomically and can be retried', async () => {
  const a = app();
  await a.idbSet('localSnapshot.v1', {cards:'invalid'});
  await assert.rejects(a.migrateSyncProfiles());
  assert.equal(await a.idbGet('activeProfile.v1'), null);
  assert.deepEqual(await a.idbGet('localSnapshot.v1'), {cards:'invalid'});
  await a.idbSet('localSnapshot.v1', {cards:[card('repaired')]});
  await a.migrateSyncProfiles();
  assert.deepEqual(ids((await a.idbGet(a.profileSnapshotKey('device'))).cards), ['repaired']);
});

test('a switch waits for an old download and keeps its response in the old profile', async () => {
  const a = await initialized();
  const first = profile(a, 'A');
  const second = profile(a, 'B');
  await a.switchSyncProfile(() => first);
  const started = deferred();
  const response = deferred();
  a.fetch = async url => { assert.match(url, /auth=token-A/); started.resolve(); return response.promise; };
  const sync = a.runAutoSync();
  await started.promise;
  const switching = a.switchSyncProfile(() => second);
  assert.equal(a.state.activeProfileId, first.id);
  response.resolve(remote([card('download-A')]));
  await Promise.all([sync, switching]);
  assert.equal(a.state.activeProfileId, second.id);
  assert.deepEqual(ids(a.state.data.cards), []);
  assert.deepEqual(ids((await a.idbGet(a.profileSnapshotKey(first.id))).cards), ['download-A']);
});

test('an old upload finishes with old credentials before the new session activates', async () => {
  const a = await initialized();
  const first = profile(a, 'A');
  const second = profile(a, 'B');
  await a.switchSyncProfile(() => first);
  await seedCards(a, [card('upload-A')]);
  const started = deferred();
  const response = deferred();
  a.fetch = async (url, options) => {
    assert.match(url, /auth=token-A/);
    if (options.method === 'GET') return remote([]);
    assert.deepEqual(ids(JSON.parse(options.body).cards), ['upload-A']);
    started.resolve();
    return response.promise;
  };
  const sync = a.runAutoSync();
  await started.promise;
  const switching = a.switchSyncProfile(() => second);
  assert.equal(a.state.syncFirebaseIdToken, 'token-A');
  response.resolve(remote([]));
  await Promise.all([sync, switching]);
  assert.equal(a.state.syncFirebaseIdToken, 'token-B');
  assert.deepEqual(ids(a.state.data.cards), []);
});

test('a delayed token refresh stays with its original profile', async () => {
  const a = await initialized();
  const first = profile(a, 'A');
  const second = profile(a, 'B');
  first.session.tokenExpiresAt = 0;
  await a.switchSyncProfile(() => first);
  const started = deferred();
  const response = deferred();
  a.fetch = async url => {
    if (url.includes('securetoken')) { started.resolve(); return response.promise; }
    assert.match(url, /auth=renewed-A/);
    return remote([]);
  };
  const sync = a.runAutoSync();
  await started.promise;
  const switching = a.switchSyncProfile(() => second);
  response.resolve(new Response(JSON.stringify({user_id:'A', id_token:'renewed-A', refresh_token:'next-A', expires_in:3600})));
  await Promise.all([sync, switching]);
  assert.equal(a.state.syncFirebaseIdToken, 'token-B');
  const saved = await a.idbGet('activeProfile.v1');
  assert.equal(saved.session.userUid, 'B');
  assert.equal(saved.session.refreshToken, 'refresh-B');
});

test('a refresh response for another user is rejected before accessing the database', async () => {
  const a = await initialized();
  const first = profile(a, 'A');
  first.session.tokenExpiresAt = 0;
  await a.switchSyncProfile(() => first);
  let calls = 0;
  a.fetch = async url => {
    calls++;
    assert.ok(url.includes('securetoken'));
    return new Response(JSON.stringify({user_id:'B',id_token:'wrong-token',refresh_token:'wrong-refresh'}));
  };
  await assert.rejects(a.ensureFirebaseIdToken(first.config), /anderen Profil/);
  assert.equal(calls, 1);
  assert.equal(a.state.syncFirebaseUserUid, 'A');
});

test('offline switching and restart preserve the new profile without importing the old snapshot', async () => {
  const a = await initialized();
  await seedCards(a, [card('device')]);
  const target = profile(a, 'B');
  await a.activateFirebase(target.config, {session:target.session});
  assert.deepEqual(ids(a.state.data.cards), []);
  const restarted = app(a.database);
  await restarted.restoreSyncConfig();
  await restarted.restoreLocalSnapshot();
  assert.equal(restarted.state.activeProfileId, target.id);
  assert.deepEqual(ids(restarted.state.data.cards), []);
  assert.equal(restarted.hasPendingSyncWork(), false);
  await restarted.activateDeviceProfile();
  assert.deepEqual(ids(restarted.state.data.cards), ['device']);
});

test('configuration drafts cannot change the active profile or its credentials', async () => {
  const a = await initialized();
  const first = profile(a, 'A');
  await a.switchSyncProfile(() => first);
  await a.queueFirebaseConfigPersist(profile(a, 'B', 'two').config);
  assert.equal(a.state.activeProfileId, first.id);
  assert.equal(a.state.syncFirebaseConfig.databaseUrl, first.config.databaseUrl);
  assert.equal(a.state.syncFirebaseIdToken, 'token-A');
  assert.equal((await a.idbGet('activeProfile.v1')).session.userUid, 'A');
});

test('failed and cancelled logins retain the previous data and active record', async () => {
  const a = await initialized();
  const first = profile(a, 'A');
  await a.switchSyncProfile(() => first);
  await seedCards(a, [card('private-A')]);
  a.readFirebaseConfigFromUi = () => ({...profile(a, 'B').config, password:'secret'});
  a.fetch = async () => new Response(JSON.stringify({error:{message:'INVALID_PASSWORD'}}), {status:400});
  await a.connectFirebase();
  assert.equal(a.state.activeProfileId, first.id);
  assert.deepEqual(ids(a.state.data.cards), ['private-A']);
  const response = deferred();
  a.fetch = () => response.promise;
  const connecting = a.connectFirebase();
  a.state.firebaseConnectionAttempt++;
  a.state.firebaseConnectInProgress = false;
  response.resolve(new Response(JSON.stringify({localId:'B',idToken:'token-B',refreshToken:'refresh-B'})));
  await connecting;
  assert.equal((await a.idbGet('activeProfile.v1')).id, first.id);
  assert.deepEqual(ids(a.state.data.cards), ['private-A']);
});

test('snapshot and activation write failures abort the switch without losing old data', async () => {
  const a = await initialized();
  await seedCards(a, [card('keep')]);
  const target = profile(a, 'B');
  const originalWrite = a.writeLocalSnapshot;
  a.writeLocalSnapshot = async () => { throw new Error('quota'); };
  await assert.rejects(a.switchSyncProfile(() => target), /quota/);
  assert.equal(a.state.activeProfileId, 'device');
  assert.equal(a.state.profileSwitching, false);
  a.writeLocalSnapshot = originalWrite;
  a.commitActiveProfile = async () => { throw new Error('commit failed'); };
  await assert.rejects(a.switchSyncProfile(() => target), /commit failed/);
  assert.deepEqual(ids(a.state.data.cards), ['keep']);
  assert.equal((await a.idbGet('activeProfile.v1')).id, 'device');
});

test('cancellation inside the activation transaction leaves the active record untouched', async () => {
  const a = await initialized();
  await assert.rejects(a.commitActiveProfile(profile(a, 'B'), () => false));
  assert.equal((await a.idbGet('activeProfile.v1')).id, 'device');
});

test('a pending edit finishes in the old profile and new edits are blocked during the switch', async () => {
  const a = await initialized();
  const edit = deferred();
  const operation = a.trackProfileMutation(async () => {
    await edit.promise;
    await seedCards(a, [card('pending-edit')]);
  });
  const saving = operation();
  const switching = a.switchSyncProfile(() => profile(a, 'B'));
  let ran = false;
  await a.trackProfileMutation(() => { ran = true; })();
  assert.equal(ran, false);
  edit.resolve();
  await Promise.all([saving, switching]);
  assert.deepEqual(ids(a.state.data.cards), []);
  assert.deepEqual(ids((await a.idbGet(a.profileSnapshotKey('device'))).cards), ['pending-edit']);
});

test('file and directory handles are matched by entry identity instead of filename', async () => {
  const a = await initialized();
  await a.idbSet('profiles.v1', [
    {id:'local:file-a',kind:'file',handle:{entry:'a',name:'same.json'}},
    {id:'local:directory',kind:'directory',handle:{entry:'dir'}}
  ]);
  const file = await a.findLocalProfile({isSameEntry: async other => other.entry === 'a'}, 'file');
  const directory = await a.findLocalProfile({isSameEntry: async other => other.entry === 'dir'}, 'directory');
  const other = await a.findLocalProfile({name:'same.json',isSameEntry:async () => false}, 'file');
  assert.equal(file.id, 'local:file-a');
  assert.equal(directory.id, 'local:directory');
  assert.notEqual(other.id, file.id);
  await a.switchSyncProfile(() => file);
  await seedCards(a, [card('file-only')]);
  await a.switchSyncProfile(() => directory);
  assert.deepEqual(ids(a.state.data.cards), []);
  await a.switchSyncProfile(() => file);
  assert.deepEqual(ids(a.state.data.cards), ['file-only']);
});

test('a stale tab cannot persist its refresh token into another tab’s active profile', async () => {
  const a = await initialized();
  const first = profile(a, 'A');
  const second = profile(a, 'B');
  await a.switchSyncProfile(() => first);
  await a.idbSet('activeProfile.v1', second);
  await a.persistFirebaseSession();
  assert.equal((await a.idbGet('activeProfile.v1')).session.userUid, 'B');
});
