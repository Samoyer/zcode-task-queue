'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { StateStore, StorageFatalError } = require('../lib/state-store');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ztq-store-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function defaults() {
  return {
    schemaVersion: 2,
    generation: 0,
    revision: 0,
    queue: { paused: false, pausedBySystem: false, pauseReason: null, guardState: {} },
    settings: { completionMarker: 'x' },
    tasks: [],
    idempotency: [],
  };
}

function failFirstPrimaryTempOpen() {
  let failed = false;
  return new Proxy(fs, {
    get(target, key) {
      if (key === 'openSync') return (file, ...args) => {
        if (!failed && /^\.state\.\d/.test(path.basename(String(file)))) {
          failed = true;
          const error = new Error('simulated first-write ENOSPC');
          error.code = 'ENOSPC';
          throw error;
        }
        return target.openSync(file, ...args);
      };
      return target[key];
    },
  });
}

test('legacy files migrate once and backups remain intact', (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'tasks.json'), JSON.stringify([{ id: 'a' }]));
  fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ completionMarker: 'old' }));
  const store = new StateStore({ dataDir: root });
  const loaded = store.load(defaults());
  assert.equal(loaded.migrated, true);
  assert.equal(loaded.snapshot.tasks[0].id, 'a');
  assert.equal(loaded.snapshot.settings.completionMarker, 'old');
  assert.ok(fs.existsSync(path.join(root, 'tasks.json.legacy.bak')));
  assert.equal(fs.statSync(path.join(root, 'state.json')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(root).mode & 0o777, 0o700);
});

test('a failed first write without legacy data can retry after storage recovers', (t) => {
  const root = fixture(t);
  assert.throws(
    () => new StateStore({ dataDir: root, fsImpl: failFirstPrimaryTempOpen() }).load(defaults()),
    /simulated first-write ENOSPC/,
  );
  assert.equal(fs.existsSync(path.join(root, 'state.json')), false);
  assert.equal(fs.existsSync(path.join(root, '.state-v2-initialized')), false);

  const retried = new StateStore({ dataDir: root }).load(defaults());
  assert.equal(retried.migrated, true);
  assert.deepEqual(retried.snapshot.tasks, []);
  assert.equal(fs.existsSync(path.join(root, 'state.json')), true);
  assert.equal(fs.existsSync(path.join(root, '.state-v2-initialized')), true);
});

test('a failed first legacy migration leaves no false initialization evidence and retries safely', (t) => {
  const root = fixture(t);
  const tasksFile = path.join(root, 'tasks.json');
  const settingsFile = path.join(root, 'settings.json');
  fs.writeFileSync(tasksFile, JSON.stringify([{ id: 'legacy-safe', status: 'pending' }]));
  fs.writeFileSync(settingsFile, JSON.stringify({ completionMarker: 'legacy-marker' }));

  assert.throws(
    () => new StateStore({ dataDir: root, fsImpl: failFirstPrimaryTempOpen() }).load(defaults()),
    /simulated first-write ENOSPC/,
  );
  assert.equal(fs.existsSync(path.join(root, 'state.json')), false);
  assert.equal(fs.existsSync(path.join(root, '.state-v2-initialized')), false);
  assert.equal(fs.existsSync(`${tasksFile}.legacy.bak`), false);
  assert.equal(fs.existsSync(`${settingsFile}.legacy.bak`), false);
  assert.equal(JSON.parse(fs.readFileSync(tasksFile, 'utf8'))[0].id, 'legacy-safe');

  const retried = new StateStore({ dataDir: root }).load(defaults());
  assert.equal(retried.migrated, true);
  assert.equal(retried.snapshot.tasks[0].id, 'legacy-safe');
  assert.equal(retried.snapshot.settings.completionMarker, 'legacy-marker');
  assert.equal(JSON.parse(fs.readFileSync(`${tasksFile}.legacy.bak`, 'utf8'))[0].id, 'legacy-safe');
  assert.equal(fs.existsSync(`${settingsFile}.legacy.bak`), true);
  assert.equal(fs.existsSync(path.join(root, '.state-v2-initialized')), true);
});

test('atomic saves retain a valid previous generation', (t) => {
  const root = fixture(t);
  const store = new StateStore({ dataDir: root });
  let state = store.load(defaults()).snapshot;
  state = { ...state, generation: 1, revision: 1, tasks: [{ id: 'one', status: 'pending' }] };
  store.save(state);
  state = { ...state, generation: 2, revision: 2, tasks: [{ id: 'two', status: 'pending' }] };
  store.save(state);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'state.json'))).tasks[0].id, 'two');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'state.json.bak'))).tasks[0].id, 'one');
});

test('corrupt primary recovers backup in a forced pause', (t) => {
  const root = fixture(t);
  const store = new StateStore({ dataDir: root });
  let state = store.load(defaults()).snapshot;
  state = { ...state, generation: 1, revision: 1, tasks: [{ id: 'safe', status: 'pending' }] };
  store.save(state);
  state = { ...state, generation: 2, revision: 2, tasks: [{ id: 'new', status: 'pending' }] };
  store.save(state);
  fs.writeFileSync(path.join(root, 'state.json'), '{');
  const recovered = new StateStore({ dataDir: root }).load(defaults());
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.snapshot.tasks[0].id, 'safe');
  assert.equal(recovered.snapshot.queue.paused, true);
  assert.equal(recovered.snapshot.queue.pauseReason.kind, 'storage-recovery');
  assert.ok(fs.readdirSync(root).some((name) => name.includes('.corrupt.')));
});

test('corrupt primary and backup fail closed', (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'state.json'), '{');
  fs.writeFileSync(path.join(root, 'state.json.bak'), '{');
  assert.throws(() => new StateStore({ dataDir: root }).load(defaults()), StorageFatalError);
});

test('a quarantined first-generation state stays fail-closed on every restart', (t) => {
  const root = fixture(t);
  const store = new StateStore({ dataDir: root });
  const state = store.load(defaults()).snapshot;
  state.tasks = [{ id: 'must-survive', status: 'pending' }];
  // This remains the first generation: there is intentionally no backup yet.
  fs.writeFileSync(path.join(root, 'state.json'), JSON.stringify(state));
  fs.writeFileSync(path.join(root, 'state.json'), '{');

  assert.throws(() => new StateStore({ dataDir: root }).load(defaults()), StorageFatalError);
  assert.equal(fs.existsSync(path.join(root, 'state.json')), false);
  assert.equal(fs.existsSync(path.join(root, '.state-v2-initialized')), true);
  assert.throws(() => new StateStore({ dataDir: root }).load(defaults()), StorageFatalError);
  assert.equal(fs.existsSync(path.join(root, 'state.json')), false);
});

test('a missing primary recovers the valid previous generation instead of replaying legacy data', (t) => {
  const root = fixture(t);
  const store = new StateStore({ dataDir: root });
  let state = store.load(defaults()).snapshot;
  state = { ...state, generation: 1, revision: 1, tasks: [{ id: 'safe', status: 'pending' }] };
  store.save(state);
  state = { ...state, generation: 2, revision: 2, tasks: [{ id: 'newer', status: 'pending' }] };
  store.save(state);
  fs.writeFileSync(path.join(root, 'tasks.json'), JSON.stringify([{ id: 'legacy', status: 'done' }]));
  fs.rmSync(path.join(root, 'state.json'));

  const recovered = new StateStore({ dataDir: root }).load(defaults());
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.migrated, false);
  assert.equal(recovered.snapshot.tasks[0].id, 'safe');
  assert.equal(recovered.snapshot.queue.pauseReason.kind, 'storage-recovery');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8')).tasks[0].id, 'safe');
});

test('a markerless valid primary is watermarked in both copies before activation completes', (t) => {
  const root = fixture(t);
  const activation = defaults();
  activation.queue.guardState = {
    stopLastAt: 101,
    enableLastAt: 102,
    lastAppliedAt: 103,
    lastWindowOpen: false,
  };
  const markerless = defaults();
  markerless.tasks = [{ id: 'markerless-primary', status: 'pending' }];
  markerless.queue.guardState = { stopLastAt: 1, enableLastAt: 2, lastAppliedAt: 3, lastWindowOpen: true };
  fs.writeFileSync(path.join(root, 'state.json'), JSON.stringify(markerless));

  const loaded = new StateStore({ dataDir: root }).load(activation);
  assert.equal(loaded.migrated, true);
  assert.equal(loaded.recovered, false);
  assert.equal(loaded.snapshot.tasks[0].id, 'markerless-primary');
  assert.equal(fs.existsSync(path.join(root, '.state-v2-initialized')), true);
  for (const name of ['state.json', 'state.json.bak']) {
    const persisted = JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
    assert.equal(persisted.queue.guardState.stopLastAt, 101);
    assert.equal(persisted.queue.guardState.enableLastAt, 102);
    assert.equal(persisted.queue.guardState.lastAppliedAt, 103);
    assert.equal(persisted.queue.guardState.lastWindowOpen, false);
  }
});

test('a markerless activation write failure leaves the valid primary available for retry', (t) => {
  const root = fixture(t);
  const activation = defaults();
  activation.queue.guardState = { stopLastAt: 201, enableLastAt: 202, lastAppliedAt: 203 };
  const markerless = defaults();
  markerless.tasks = [{ id: 'must-not-be-quarantined', status: 'pending' }];
  fs.writeFileSync(path.join(root, 'state.json'), JSON.stringify(markerless));

  assert.throws(
    () => new StateStore({ dataDir: root, fsImpl: failFirstPrimaryTempOpen() }).load(activation),
    /simulated first-write ENOSPC/,
  );
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8')).tasks[0].id, 'must-not-be-quarantined');
  assert.equal(fs.readdirSync(root).some((name) => name.includes('.corrupt.')), false);
  assert.equal(fs.existsSync(path.join(root, '.state-v2-initialized')), false);

  const retried = new StateStore({ dataDir: root }).load(activation);
  assert.equal(retried.migrated, true);
  assert.equal(retried.snapshot.tasks[0].id, 'must-not-be-quarantined');
  assert.equal(retried.snapshot.queue.guardState.stopLastAt, 201);
});

test('a markerless backup recovery persists its activation watermark before creating the marker', (t) => {
  const root = fixture(t);
  const activation = defaults();
  activation.queue.guardState = { stopLastAt: 301, enableLastAt: 302, lastAppliedAt: 303 };
  const backup = defaults();
  backup.tasks = [{ id: 'markerless-backup', status: 'pending' }];
  fs.writeFileSync(path.join(root, 'state.json.bak'), JSON.stringify(backup));

  const loaded = new StateStore({ dataDir: root }).load(activation);
  assert.equal(loaded.recovered, true);
  assert.equal(loaded.migrated, true);
  assert.equal(loaded.snapshot.tasks[0].id, 'markerless-backup');
  assert.equal(loaded.snapshot.queue.pauseReason.kind, 'storage-recovery');
  assert.equal(fs.existsSync(path.join(root, '.state-v2-initialized')), true);
  for (const name of ['state.json', 'state.json.bak']) {
    const persisted = JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
    assert.equal(persisted.queue.guardState.stopLastAt, 301);
    assert.equal(persisted.queue.guardState.enableLastAt, 302);
    assert.equal(persisted.queue.guardState.lastAppliedAt, 303);
  }
});

test('an initialized backup recovery also advances stale guard watermarks in both copies', (t) => {
  const root = fixture(t);
  const activation = defaults();
  activation.queue.guardState = { stopLastAt: 401, enableLastAt: 402, lastAppliedAt: 403 };
  const backup = defaults();
  backup.tasks = [{ id: 'stale-backup', status: 'pending' }];
  fs.writeFileSync(path.join(root, 'state.json.bak'), JSON.stringify(backup));
  fs.writeFileSync(path.join(root, '.state-v2-initialized'), 'initialized\n');

  const loaded = new StateStore({ dataDir: root }).load(activation);
  assert.equal(loaded.recovered, true);
  assert.equal(loaded.migrated, false);
  assert.equal(loaded.snapshot.tasks[0].id, 'stale-backup');
  for (const name of ['state.json', 'state.json.bak']) {
    const persisted = JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
    assert.equal(persisted.queue.guardState.stopLastAt, 401);
    assert.equal(persisted.queue.guardState.enableLastAt, 402);
    assert.equal(persisted.queue.guardState.lastAppliedAt, 403);
  }
});

test('schema-invalid primary is quarantined and recovered from the last valid generation', (t) => {
  const root = fixture(t);
  const store = new StateStore({ dataDir: root });
  let state = store.load(defaults()).snapshot;
  state = { ...state, generation: 1, revision: 1, tasks: [{ id: 'safe', status: 'pending' }] };
  store.save(state);
  state = { ...state, generation: 2, revision: 2, tasks: [{ id: 'new', status: 'pending' }] };
  store.save(state);
  const invalid = JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8'));
  invalid.tasks = [{ id: 'broken' }];
  fs.writeFileSync(path.join(root, 'state.json'), JSON.stringify(invalid));
  const recovered = new StateStore({ dataDir: root }).load(defaults());
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.snapshot.tasks[0].id, 'safe');
  assert.equal(recovered.snapshot.queue.paused, true);
});

test('an fsync failure before rename preserves the previous complete snapshot', (t) => {
  const root = fixture(t);
  const normal = new StateStore({ dataDir: root });
  let state = normal.load(defaults()).snapshot;
  state = { ...state, generation: 1, revision: 1, tasks: [{ id: 'old', status: 'pending' }] };
  normal.save(state);
  let failed = false;
  const faultyFs = new Proxy(fs, {
    get(target, key) {
      if (key === 'fsyncSync') return (fd) => {
        if (!failed) {
          failed = true;
          const error = new Error('simulated ENOSPC');
          error.code = 'ENOSPC';
          throw error;
        }
        return target.fsyncSync(fd);
      };
      return target[key];
    },
  });
  const attempted = { ...state, generation: 2, revision: 2, tasks: [{ id: 'new', status: 'pending' }] };
  assert.throws(() => new StateStore({ dataDir: root, fsImpl: faultyFs }).save(attempted), StorageFatalError);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'state.json'))).tasks[0].id, 'old');
  assert.equal(fs.readdirSync(root).some((name) => name.endsWith('.tmp')), false);
});

test('a main-file rename failure never exposes the attempted generation', (t) => {
  const root = fixture(t);
  const normal = new StateStore({ dataDir: root });
  let state = normal.load(defaults()).snapshot;
  state = { ...state, generation: 1, revision: 1, tasks: [{ id: 'old', status: 'pending' }] };
  normal.save(state);
  const stateFile = path.join(root, 'state.json');
  const faultyFs = new Proxy(fs, {
    get(target, key) {
      if (key === 'renameSync') return (source, destination) => {
        if (destination === stateFile) throw new Error('simulated rename failure');
        return target.renameSync(source, destination);
      };
      return target[key];
    },
  });
  const attempted = { ...state, generation: 2, revision: 2, tasks: [{ id: 'new', status: 'pending' }] };
  assert.throws(() => new StateStore({ dataDir: root, fsImpl: faultyFs }).save(attempted), StorageFatalError);
  assert.equal(JSON.parse(fs.readFileSync(stateFile)).tasks[0].id, 'old');
  assert.equal(fs.readdirSync(root).some((name) => name.endsWith('.tmp')), false);
});
