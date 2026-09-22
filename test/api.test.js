'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('../src/app');

function listen(app) {
  return new Promise((resolveServer, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolveServer(server));
    server.on('error', reject);
  });
}

async function request(server, path, options = {}) {
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: options.method || 'GET',
    headers: options.body
      ? { 'content-type': 'application/json', ...(options.headers || {}) }
      : options.headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  return {
    status: response.status,
    body: await response.json(),
  };
}

test('health check reports service status', async () => {
  const server = await listen(createApp());
  try {
    const response = await request(server, '/health');
    assert.equal(response.status, 200);
    assert.equal(response.body.status, 'ok');
    assert.equal(response.body.service, 'offline-dependency-resolver');
  } finally {
    server.close();
  }
});

test('POST /resolve returns an installation plan', async () => {
  const server = await listen(createApp());
  try {
    const response = await request(server, '/resolve', {
      method: 'POST',
      body: {
        registry: {
          app: { '1.0.0': { dependencies: { lib: '^1.0.0' } } },
          lib: { '1.2.0': {}, '1.0.0': {} },
        },
        root: { app: '1.0.0' },
      },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      satisfiable: true,
      plan: [
        { package: 'app', version: '1.0.0' },
        { package: 'lib', version: '1.2.0' },
      ],
    });
  } finally {
    server.close();
  }
});

test('POST /resolve reports 409 and a conflict chain when unsolvable', async () => {
  const server = await listen(createApp());
  try {
    const response = await request(server, '/resolve', {
      method: 'POST',
      body: {
        registry: {
          app: { '1.0.0': { dependencies: { lib: '^2.0.0' } } },
          lib: { '1.0.0': {} },
        },
        root: { app: '1.0.0' },
      },
    });

    assert.equal(response.status, 409);
    assert.equal(response.body.satisfiable, false);
    assert.equal(response.body.conflict.package, 'lib');
    assert.equal(
      response.body.conflict.chain[0].requiredBy.type,
      'root'
    );
    assert.equal(
      response.body.conflict.chain.at(-1).reasonCode,
      'NO_VERSION_SATISFIES_CONSTRAINTS'
    );
  } finally {
    server.close();
  }
});

test('POST /resolve validates malformed requests', async () => {
  const server = await listen(createApp());
  try {
    const response = await request(server, '/resolve', {
      method: 'POST',
      body: { registry: {}, root: { app: 'invalid range' } },
    });

    assert.equal(response.status, 400);
    assert.equal(response.body.error, 'INVALID_REQUEST');
  } finally {
    server.close();
  }
});

test('POST /update-plan returns a plan with kept and changed summaries', async () => {
  const server = await listen(createApp());
  try {
    const response = await request(server, '/update-plan', {
      method: 'POST',
      body: {
        registry: {
          app: { '1.0.0': {} },
          lib: { '2.1.0': {}, '1.2.0': {} },
        },
        root: { app: '1.0.0', lib: '>=1.0.0' },
        locked: { lib: '1.2.0' },
        update: { lib: '^2.0.0' },
      },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      satisfiable: true,
      plan: [
        { package: 'app', version: '1.0.0' },
        { package: 'lib', version: '2.1.0' },
      ],
      kept: [],
      changed: [
        { package: 'app', from: null, to: '1.0.0' },
        { package: 'lib', from: '1.2.0', to: '2.1.0' },
      ],
    });
  } finally {
    server.close();
  }
});

test('POST /update-plan reports 409 with the shared conflict structure', async () => {
  const server = await listen(createApp());
  try {
    const response = await request(server, '/update-plan', {
      method: 'POST',
      body: {
        registry: { lib: { '1.0.0': {} } },
        root: {},
        locked: { lib: '1.0.0' },
        update: { lib: '^2.0.0' },
      },
    });

    assert.equal(response.status, 409);
    assert.equal(response.body.satisfiable, false);
    assert.equal(response.body.conflict.package, 'lib');
    assert.equal(
      response.body.conflict.chain.at(-1).reasonCode,
      'NO_VERSION_SATISFIES_CONSTRAINTS'
    );
    assert.deepEqual(response.body.conflict.chain.at(-1).requiredBy, {
      type: 'update',
    });
  } finally {
    server.close();
  }
});

test('POST /update-plan rejects invalid locked versions and update ranges', async () => {
  const server = await listen(createApp());
  try {
    const badLocked = await request(server, '/update-plan', {
      method: 'POST',
      body: { registry: {}, root: {}, locked: { app: 'not-a-version' }, update: {} },
    });
    assert.equal(badLocked.status, 400);
    assert.equal(badLocked.body.error, 'INVALID_REQUEST');

    const badUpdate = await request(server, '/update-plan', {
      method: 'POST',
      body: { registry: {}, root: {}, locked: {}, update: { lib: 'not-a-range' } },
    });
    assert.equal(badUpdate.status, 400);
    assert.equal(badUpdate.body.error, 'INVALID_REQUEST');
  } finally {
    server.close();
  }
});

test('POST /lockfile-audit returns 200 for a consistent lockfile', async () => {
  const server = await listen(createApp());
  try {
    const response = await request(server, '/lockfile-audit', {
      method: 'POST',
      body: {
        registry: {
          app: { '1.0.0': { dependencies: { lib: '^1.0.0' } } },
          lib: { '1.2.0': {} },
        },
        root: { app: '1.0.0' },
        locked: { app: '1.0.0', lib: '1.2.0' },
      },
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.deepEqual(response.body.packages.map((entry) => entry.package), ['app', 'lib']);
    assert.equal(response.body.summary.totalPackages, 2);
    assert.equal(response.body.summary.issuesTotal, 0);
  } finally {
    server.close();
  }
});

test('POST /lockfile-audit returns 409 with stable per-package statuses and paths', async () => {
  const server = await listen(createApp());
  try {
    const response = await request(server, '/lockfile-audit', {
      method: 'POST',
      body: {
        registry: {
          app: { '1.0.0': { dependencies: { lib: '^2.0.0', ghost: '*' } } },
          lib: { '2.0.0': {}, '1.5.0': {} },
        },
        root: { app: '1.0.0' },
        locked: { app: '1.0.0', lib: '1.5.0', stray: '9.0.0' },
      },
    });

    assert.equal(response.status, 409);
    assert.equal(response.body.ok, false);
    assert.deepEqual(
      response.body.packages.map((entry) => entry.package),
      ['app', 'ghost', 'lib', 'stray']
    );

    const lib = response.body.packages.find((entry) => entry.package === 'lib');
    assert.equal(lib.status, 'SEMVER_VIOLATION');
    assert.equal(lib.issues[0].requiredRange, '^2.0.0');
    assert.deepEqual(
      lib.issues[0].path.map((node) => node.package),
      ['app', 'lib']
    );

    const ghost = response.body.packages.find((entry) => entry.package === 'ghost');
    assert.equal(ghost.lockedVersion, null);
    assert.equal(ghost.status, 'LOCKED_PACKAGE_MISSING');

    const stray = response.body.packages.find((entry) => entry.package === 'stray');
    assert.equal(stray.status, 'LOCKED_VERSION_NOT_IN_REGISTRY');

    assert.equal(response.body.summary.orphanPackages, 1);
    assert.ok(response.body.summary.issuesTotal > 0);
  } finally {
    server.close();
  }
});

test('POST /lockfile-audit validates malformed requests', async () => {
  const server = await listen(createApp());
  try {
    const missingLocked = await request(server, '/lockfile-audit', {
      method: 'POST',
      body: { registry: {}, root: {} },
    });
    assert.equal(missingLocked.status, 400);
    assert.equal(missingLocked.body.error, 'INVALID_REQUEST');

    const badVersion = await request(server, '/lockfile-audit', {
      method: 'POST',
      body: { registry: {}, root: {}, locked: { app: 'not-a-version' } },
    });
    assert.equal(badVersion.status, 400);
    assert.equal(badVersion.body.error, 'INVALID_REQUEST');
  } finally {
    server.close();
  }
});
