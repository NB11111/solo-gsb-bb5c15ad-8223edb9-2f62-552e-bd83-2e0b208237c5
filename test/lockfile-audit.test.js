'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { auditLockfile } = require('../src/resolver');

function byName(result, name) {
  return result.packages.find((entry) => entry.package === name);
}

function cleanResult() {
  return auditLockfile({
    registry: {
      app: { '1.0.0': { dependencies: { lib: '^1.0.0' } } },
      lib: { '1.2.0': {}, '1.0.0': {} },
    },
    root: { app: '1.0.0' },
    locked: { app: '1.0.0', lib: '1.2.0' },
  });
}

test('accepts a lockfile whose locked versions satisfy every constraint', () => {
  const result = cleanResult();

  assert.equal(result.ok, true);
  assert.deepEqual(result.packages, [
    { package: 'app', lockedVersion: '1.0.0', status: 'OK', issues: [] },
    { package: 'lib', lockedVersion: '1.2.0', status: 'OK', issues: [] },
  ]);
  assert.deepEqual(result.summary, {
    totalPackages: 2,
    rootReachablePackages: 2,
    orphanPackages: 0,
    statusCounts: {
      OK: 2,
      LOCKED_PACKAGE_MISSING: 0,
      LOCKED_VERSION_NOT_IN_REGISTRY: 0,
      SEMVER_VIOLATION: 0,
      CYCLE: 0,
      ORPHAN_PACKAGE: 0,
    },
    issueCounts: {
      LOCKED_PACKAGE_MISSING: 0,
      LOCKED_VERSION_NOT_IN_REGISTRY: 0,
      SEMVER_VIOLATION: 0,
      CYCLE: 0,
      ORPHAN_PACKAGE: 0,
    },
    issuesTotal: 0,
  });
});

test('packages are sorted by name regardless of input key order', () => {
  const body = {
    registry: {
      zeta: { '1.0.0': { dependencies: { alpha: '~1.0.0' } } },
      alpha: { '1.0.0': {} },
    },
    root: { zeta: '1.0.0' },
    locked: { zeta: '1.0.0', alpha: '1.0.0' },
  };
  const reordered = {
    locked: { alpha: '1.0.0', zeta: '1.0.0' },
    root: { zeta: '1.0.0' },
    registry: {
      alpha: { '1.0.0': {} },
      zeta: { '1.0.0': { dependencies: { alpha: '~1.0.0' } } },
    },
  };

  const result = auditLockfile(body);
  assert.deepEqual(auditLockfile(reordered), result);
  assert.deepEqual(result.packages.map((entry) => entry.package), ['alpha', 'zeta']);
});

test('reports a transitive dependency whose locked version violates semver', () => {
  const result = auditLockfile({
    registry: {
      app: { '1.0.0': { dependencies: { lib: '^2.0.0' } } },
      lib: { '2.0.0': {}, '1.5.0': {} },
    },
    root: { app: '1.0.0' },
    locked: { app: '1.0.0', lib: '1.5.0' },
  });

  assert.equal(result.ok, false);
  const lib = byName(result, 'lib');
  assert.equal(lib.status, 'SEMVER_VIOLATION');
  assert.equal(lib.issues.length, 1);
  assert.deepEqual(lib.issues[0], {
    code: 'SEMVER_VIOLATION',
    lockedVersion: '1.5.0',
    requiredRange: '^2.0.0',
    requiredBy: { type: 'dependency', package: 'app', version: '1.0.0' },
    path: [
      {
        package: 'app',
        lockedVersion: '1.0.0',
        requiredRange: '1.0.0',
        requiredBy: { type: 'root' },
      },
      {
        package: 'lib',
        lockedVersion: '1.5.0',
        requiredRange: '^2.0.0',
        requiredBy: { type: 'dependency', package: 'app', version: '1.0.0' },
      },
    ],
  });
  assert.equal(result.summary.issueCounts.SEMVER_VIOLATION, 1);
});

test('reports root requirements whose locked version violates semver', () => {
  const result = auditLockfile({
    registry: { lib: { '1.0.0': {}, '2.0.0': {} } },
    root: { lib: '^2.0.0' },
    locked: { lib: '1.0.0' },
  });

  const issue = byName(result, 'lib').issues[0];
  assert.equal(issue.code, 'SEMVER_VIOLATION');
  assert.deepEqual(issue.requiredBy, { type: 'root' });
  assert.deepEqual(issue.path.map((node) => node.package), ['lib']);
});

test('reports a required package that is absent from the lockfile once', () => {
  const result = auditLockfile({
    registry: {
      app: { '1.0.0': { dependencies: { ghost: '^1.0.0' } } },
      other: { '1.0.0': { dependencies: { ghost: '^1.0.0' } } },
    },
    root: { app: '1.0.0', other: '1.0.0' },
    locked: { app: '1.0.0', other: '1.0.0' },
  });

  const ghost = byName(result, 'ghost');
  assert.equal(ghost.lockedVersion, null);
  assert.equal(ghost.status, 'LOCKED_PACKAGE_MISSING');
  assert.equal(ghost.issues.length, 1);
  // The canonical path is the shortest one; ties resolve in lexicographic
  // order, so app (not other) introduces the reported path.
  assert.deepEqual(ghost.issues[0].path.map((node) => node.package), ['app', 'ghost']);
  assert.equal(result.summary.issueCounts.LOCKED_PACKAGE_MISSING, 1);
});

test('reports a root requirement that is absent from the lockfile', () => {
  const result = auditLockfile({
    registry: {},
    root: { ghost: '^1.0.0' },
    locked: {},
  });

  const ghost = byName(result, 'ghost');
  assert.equal(ghost.status, 'LOCKED_PACKAGE_MISSING');
  assert.deepEqual(ghost.issues[0].path, [
    {
      package: 'ghost',
      lockedVersion: null,
      requiredRange: '^1.0.0',
      requiredBy: { type: 'root' },
    },
  ]);
});

test('reports a locked version that the offline registry does not provide', () => {
  const result = auditLockfile({
    registry: {
      app: { '1.0.0': { dependencies: { lib: '^1.0.0' } } },
      lib: { '1.4.0': {} },
    },
    root: { app: '1.0.0' },
    locked: { app: '1.0.0', lib: '1.5.0' },
  });

  const issue = byName(result, 'lib').issues.find(
    (entry) => entry.code === 'LOCKED_VERSION_NOT_IN_REGISTRY'
  );
  assert.deepEqual(issue, {
    code: 'LOCKED_VERSION_NOT_IN_REGISTRY',
    lockedVersion: '1.5.0',
    availableVersions: ['1.4.0'],
    path: [
      {
        package: 'app',
        lockedVersion: '1.0.0',
        requiredRange: '1.0.0',
        requiredBy: { type: 'root' },
      },
      {
        package: 'lib',
        lockedVersion: '1.5.0',
        requiredRange: '^1.0.0',
        requiredBy: { type: 'dependency', package: 'app', version: '1.0.0' },
      },
    ],
  });
});

test('reports a dependency cycle with a root-to-cycle dependency path', () => {
  const result = auditLockfile({
    registry: {
      app: { '1.0.0': { dependencies: { cyc: '1.0.0' } } },
      cyc: { '1.0.0': { dependencies: { cycdep: '1.0.0' } } },
      cycdep: { '1.0.0': { dependencies: { cyc: '1.0.0' } } },
    },
    root: { app: '1.0.0' },
    locked: { app: '1.0.0', cyc: '1.0.0', cycdep: '1.0.0' },
  });

  const cyc = byName(result, 'cyc');
  assert.equal(cyc.status, 'CYCLE');
  assert.deepEqual(cyc.issues[0].packages, [
    { package: 'cyc', lockedVersion: '1.0.0' },
    { package: 'cycdep', lockedVersion: '1.0.0' },
  ]);
  assert.deepEqual(
    cyc.issues[0].path.map((node) => node.package),
    ['app', 'cyc', 'cycdep', 'cyc']
  );
  // The closing edge identifies the dependency that loops back.
  const closing = cyc.issues[0].path.at(-1);
  assert.equal(closing.requiredRange, '1.0.0');
  assert.deepEqual(closing.requiredBy, {
    type: 'dependency',
    package: 'cycdep',
    version: '1.0.0',
  });
  assert.equal(byName(result, 'cycdep').status, 'CYCLE');
});

test('reports a self-dependency as a cycle', () => {
  const result = auditLockfile({
    registry: { a: { '1.0.0': { dependencies: { a: '1.0.0' } } } },
    root: { a: '1.0.0' },
    locked: { a: '1.0.0' },
  });

  const a = byName(result, 'a');
  assert.equal(a.status, 'CYCLE');
  assert.deepEqual(a.issues[0].packages, [{ package: 'a', lockedVersion: '1.0.0' }]);
  assert.deepEqual(a.issues[0].path.map((node) => node.package), ['a', 'a']);
});

test('reports locked packages not reachable from the root as orphans', () => {
  const result = auditLockfile({
    registry: {
      app: { '1.0.0': { dependencies: { lib: '^1.0.0' } } },
      lib: { '1.0.0': {} },
      stray: { '2.0.0': { dependencies: { straydep: '^1.0.0' } } },
      straydep: { '1.0.0': {} },
    },
    root: { app: '1.0.0' },
    locked: { app: '1.0.0', lib: '1.0.0', stray: '2.0.0', straydep: '1.0.0' },
  });

  assert.equal(byName(result, 'stray').status, 'ORPHAN_PACKAGE');
  assert.equal(byName(result, 'straydep').status, 'ORPHAN_PACKAGE');
  assert.deepEqual(byName(result, 'stray').issues[0].path, []);
  assert.equal(result.summary.rootReachablePackages, 2);
  assert.equal(result.summary.orphanPackages, 2);
});

test('status reflects the highest-priority issue when several apply', () => {
  const result = auditLockfile({
    registry: {
      app: { '1.0.0': { dependencies: { lib: '^2.0.0' } } },
      lib: { '2.0.0': {} },
      orphan: { '1.0.0': {} },
    },
    root: { app: '1.0.0' },
    // orphan exists in the registry but is not reachable from root; lib is
    // reachable but pinned to a registry-missing, violating version.
    locked: { app: '1.0.0', lib: '1.5.0', orphan: '1.0.0' },
  });

  assert.equal(byName(result, 'lib').status, 'LOCKED_VERSION_NOT_IN_REGISTRY');
  const codes = byName(result, 'lib').issues.map((issue) => issue.code);
  assert.deepEqual(codes, ['LOCKED_VERSION_NOT_IN_REGISTRY', 'SEMVER_VIOLATION']);
  assert.equal(byName(result, 'orphan').status, 'ORPHAN_PACKAGE');
});

test('rejects malformed audit requests', () => {
  assert.throws(
    () => auditLockfile({ registry: {}, root: {} }),
    /locked must be an object/
  );
  assert.throws(
    () => auditLockfile({ registry: {}, root: {}, locked: { app: 'not-a-version' } }),
    /valid semver version/
  );
  assert.throws(
    () => auditLockfile({ registry: {}, root: { app: 'not-a-range' }, locked: {} }),
    /valid semver range/
  );
});
