'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

const { auditLockfile } = require('../src/resolver');

function entry(result, name) {
  return result.packages.find((pkg) => pkg.package === name);
}

test('accepts a clean locked graph reachable from every root', () => {
  const result = auditLockfile({
    registry: {
      app: { '1.0.0': { dependencies: { lib: '^1.0.0' } } },
      lib: { '1.2.0': {}, '1.0.0': {} },
    },
    root: { app: '1.0.0' },
    locked: { app: '1.0.0', lib: '1.2.0' },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.summary, {
    lockedPackages: 2,
    reachable: 2,
    orphans: 0,
    missing: 0,
    cycles: 0,
    issues: 0,
    byCode: {
      ROOT_DEPENDENCY_NOT_LOCKED: 0,
      ROOT_RANGE_VIOLATION: 0,
      DEPENDENCY_NOT_LOCKED: 0,
      LOCKED_VERSION_RANGE_VIOLATION: 0,
      LOCKED_VERSION_NOT_IN_REGISTRY: 0,
      CYCLE: 0,
    },
    statuses: { ok: 2, orphan: 0, error: 0, missing: 0 },
  });
  assert.deepEqual(result.cycles, []);
  assert.deepEqual(entry(result, 'app'), {
    package: 'app',
    version: '1.0.0',
    status: 'ok',
    reachable: true,
    path: [
      { package: 'app', version: '1.0.0', requiredRange: '1.0.0', requiredBy: { type: 'root' } },
    ],
    issues: [],
  });
  assert.deepEqual(entry(result, 'lib').path, [
    { package: 'app', version: '1.0.0', requiredRange: '1.0.0', requiredBy: { type: 'root' } },
    {
      package: 'lib',
      version: '1.2.0',
      requiredRange: '^1.0.0',
      requiredBy: { type: 'dependency', package: 'app', version: '1.0.0' },
    },
  ]);
});

test('does not reselect versions when the locked version satisfies a loose range', () => {
  const result = auditLockfile({
    registry: {
      app: { '1.0.0': { dependencies: { lib: '>=1.0.0' } } },
      lib: { '2.0.0': {}, '1.2.0': {} },
    },
    root: { app: '1.0.0' },
    locked: { app: '1.0.0', lib: '1.2.0' },
  });

  assert.equal(result.ok, true);
  assert.equal(entry(result, 'lib').version, '1.2.0');
});

test('reports a locked version that violates a dependency range', () => {
  const result = auditLockfile({
    registry: {
      app: { '1.0.0': { dependencies: { lib: '^2.0.0' } } },
      lib: { '1.5.0': {} },
    },
    root: { app: '1.0.0' },
    locked: { app: '1.0.0', lib: '1.5.0' },
  });

  assert.equal(result.ok, false);
  const lib = entry(result, 'lib');
  assert.equal(lib.status, 'error');
  assert.equal(lib.issues.length, 1);
  assert.deepEqual(lib.issues[0], {
    code: 'LOCKED_VERSION_RANGE_VIOLATION',
    lockedVersion: '1.5.0',
    requiredRange: '^2.0.0',
    requiredBy: { type: 'dependency', package: 'app', version: '1.0.0' },
    path: [
      { package: 'app', version: '1.0.0', requiredRange: '1.0.0', requiredBy: { type: 'root' } },
      {
        package: 'lib',
        version: '1.5.0',
        requiredRange: '^2.0.0',
        requiredBy: { type: 'dependency', package: 'app', version: '1.0.0' },
      },
    ],
  });
  assert.equal(result.summary.byCode.LOCKED_VERSION_RANGE_VIOLATION, 1);
});

test('reports a root requirement the locked version does not satisfy', () => {
  const result = auditLockfile({
    registry: { app: { '1.0.0': {} } },
    root: { app: '^2.0.0' },
    locked: { app: '1.0.0' },
  });

  const app = entry(result, 'app');
  assert.equal(app.status, 'error');
  assert.deepEqual(app.issues, [
    {
      code: 'ROOT_RANGE_VIOLATION',
      lockedVersion: '1.0.0',
      requiredRange: '^2.0.0',
      requiredBy: { type: 'root' },
      path: [
        { package: 'app', version: '1.0.0', requiredRange: '^2.0.0', requiredBy: { type: 'root' } },
      ],
    },
  ]);
  assert.equal(result.summary.byCode.ROOT_RANGE_VIOLATION, 1);
});

test('reports a root dependency missing from the lockfile', () => {
  const result = auditLockfile({
    registry: { app: { '1.0.0': {} } },
    root: { app: '1.0.0', ghost: '^1.0.0' },
    locked: { app: '1.0.0' },
  });

  const ghost = entry(result, 'ghost');
  assert.deepEqual(ghost, {
    package: 'ghost',
    version: null,
    status: 'missing',
    reachable: false,
    path: null,
    issues: [
      {
        code: 'ROOT_DEPENDENCY_NOT_LOCKED',
        requiredRange: '^1.0.0',
        requiredBy: { type: 'root' },
        path: [
          { package: 'ghost', version: null, requiredRange: '^1.0.0', requiredBy: { type: 'root' } },
        ],
      },
    ],
  });
  assert.equal(result.summary.missing, 1);
  assert.equal(result.summary.statuses.missing, 1);
  assert.equal(result.summary.byCode.ROOT_DEPENDENCY_NOT_LOCKED, 1);
});

test('reports a transitive dependency missing from the lockfile with its path', () => {
  const result = auditLockfile({
    registry: {
      app: { '1.0.0': { dependencies: { lib: '^1.0.0' } } },
      lib: { '1.0.0': { dependencies: { util: '^1.0.0' } } },
    },
    root: { app: '1.0.0' },
    locked: { app: '1.0.0', lib: '1.0.0' },
  });

  const util = entry(result, 'util');
  assert.equal(util.status, 'missing');
  assert.equal(util.issues[0].code, 'DEPENDENCY_NOT_LOCKED');
  assert.deepEqual(util.issues[0].path.map((node) => node.package), ['app', 'lib', 'util']);
  assert.equal(util.issues[0].path.at(-1).version, null);
  assert.equal(result.summary.byCode.DEPENDENCY_NOT_LOCKED, 1);
});

test('reports a locked version absent from the registry', () => {
  const result = auditLockfile({
    registry: { app: { '1.0.0': {} } },
    root: { app: '1.0.0' },
    locked: { app: '1.0.0', lib: '1.5.0' },
  });

  const lib = entry(result, 'lib');
  assert.equal(lib.status, 'error');
  assert.equal(lib.reachable, false);
  assert.deepEqual(lib.issues, [{ code: 'LOCKED_VERSION_NOT_IN_REGISTRY', path: null }]);
  assert.equal(result.summary.byCode.LOCKED_VERSION_NOT_IN_REGISTRY, 1);
});

test('flags locked packages unreachable from any root as orphans', () => {
  const result = auditLockfile({
    registry: {
      app: { '1.0.0': { dependencies: { lib: '^1.0.0' } } },
      lib: { '1.0.0': {} },
      extra: { '2.0.0': {} },
    },
    root: { app: '1.0.0' },
    locked: { app: '1.0.0', lib: '1.0.0', extra: '2.0.0' },
  });

  assert.equal(result.ok, false);
  const extra = entry(result, 'extra');
  assert.equal(extra.status, 'orphan');
  assert.equal(extra.reachable, false);
  assert.deepEqual(extra.issues, []);
  assert.equal(result.summary.orphans, 1);
  assert.equal(result.summary.reachable, 2);
  assert.deepEqual(result.summary.statuses, { ok: 2, orphan: 1, error: 0, missing: 0 });
});

test('expands orphan packages and reports their broken edges', () => {
  const result = auditLockfile({
    registry: {
      app: { '1.0.0': {} },
      orphan: { '1.0.0': { dependencies: { ghost: '*' } } },
    },
    root: { app: '1.0.0' },
    locked: { app: '1.0.0', orphan: '1.0.0' },
  });

  assert.equal(entry(result, 'orphan').status, 'orphan');
  const ghost = entry(result, 'ghost');
  assert.equal(ghost.status, 'missing');
  assert.deepEqual(ghost.issues[0].path, [
    { package: 'orphan', version: '1.0.0', requiredBy: null },
    {
      package: 'ghost',
      version: null,
      requiredRange: '*',
      requiredBy: { type: 'dependency', package: 'orphan', version: '1.0.0' },
    },
  ]);
});

test('detects dependency cycles reachable from the root', () => {
  const result = auditLockfile({
    registry: {
      app: { '1.0.0': { dependencies: { a: '1.0.0' } } },
      a: { '1.0.0': { dependencies: { b: '1.0.0' } } },
      b: { '1.0.0': { dependencies: { a: '1.0.0' } } },
    },
    root: { app: '1.0.0' },
    locked: { app: '1.0.0', a: '1.0.0', b: '1.0.0' },
  });

  assert.equal(result.summary.cycles, 1);
  assert.deepEqual(result.cycles[0].packages, ['a', 'b']);
  assert.deepEqual(
    result.cycles[0].path.map((node) => node.package),
    ['app', 'a', 'b', 'a']
  );
  assert.equal(result.cycles[0].path.at(-1).requiredBy.package, 'b');
  for (const name of ['a', 'b']) {
    const pkg = entry(result, name);
    assert.equal(pkg.status, 'error');
    assert.deepEqual(pkg.issues.map((issue) => issue.code), ['CYCLE']);
  }
  assert.equal(result.summary.byCode.CYCLE, 2);
});

test('detects self loops', () => {
  const result = auditLockfile({
    registry: {
      app: { '1.0.0': { dependencies: { loopy: '1.0.0' } } },
      loopy: { '1.0.0': { dependencies: { loopy: '1.0.0' } } },
    },
    root: { app: '1.0.0' },
    locked: { app: '1.0.0', loopy: '1.0.0' },
  });

  assert.equal(result.summary.cycles, 1);
  assert.deepEqual(result.cycles[0].packages, ['loopy']);
  assert.deepEqual(
    result.cycles[0].path.map((node) => node.package),
    ['app', 'loopy', 'loopy']
  );
});

test('ignores edges to unlocked packages while finding cycles', () => {
  const result = auditLockfile({
    registry: {
      a: { '1.0.0': { dependencies: { aaaNotLocked: '1.0.0', b: '1.0.0' } } },
      b: { '1.0.0': { dependencies: { a: '1.0.0' } } },
    },
    root: { a: '1.0.0' },
    locked: { a: '1.0.0', b: '1.0.0' },
  });

  assert.equal(result.summary.cycles, 1);
  assert.deepEqual(result.cycles[0].packages, ['a', 'b']);
  assert.equal(entry(result, 'aaaNotLocked').status, 'missing');
});

test('reports cycles made only of orphan packages', () => {
  const result = auditLockfile({
    registry: {
      app: { '1.0.0': {} },
      c: { '1.0.0': { dependencies: { d: '1.0.0' } } },
      d: { '1.0.0': { dependencies: { c: '1.0.0' } } },
    },
    root: { app: '1.0.0' },
    locked: { app: '1.0.0', c: '1.0.0', d: '1.0.0' },
  });

  assert.equal(result.summary.cycles, 1);
  assert.deepEqual(result.cycles[0].packages, ['c', 'd']);
  assert.equal(result.cycles[0].path[0].requiredBy, null);
  assert.deepEqual(
    result.cycles[0].path.map((node) => node.package),
    ['c', 'd', 'c']
  );
});

test('sorts packages by name and locates the shortest lexicographic path', () => {
  const result = auditLockfile({
    registry: {
      // deep is reachable from root via two equal-length chains; z sorts
      // after b, so the bmid chain is the lexicographically smallest.
      root: { '1.0.0': { dependencies: { bmid: '^1.0.0', zmid: '^1.0.0' } } },
      zmid: { '1.0.0': { dependencies: { deep: '^1.0.0' } } },
      bmid: { '1.0.0': { dependencies: { deep: '^1.0.0' } } },
      deep: { '1.0.0': {} },
    },
    root: { root: '1.0.0' },
    locked: { root: '1.0.0', zmid: '1.0.0', bmid: '1.0.0', deep: '1.0.0' },
  });

  assert.deepEqual(
    result.packages.map((pkg) => pkg.package),
    ['bmid', 'deep', 'root', 'zmid']
  );
  assert.deepEqual(entry(result, 'deep').path.map((node) => node.package), ['root', 'bmid', 'deep']);
});

test('does not depend on object key order', () => {
  const body = {
    registry: {
      zeta: { '1.0.0': { dependencies: { alpha: '^1.0.0' } } },
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
      zeta: { '1.0.0': { dependencies: { alpha: '^1.0.0' } } },
    },
  };

  assert.deepEqual(auditLockfile(body), auditLockfile(reordered));
});

test('handles empty root and empty lockfile', () => {
  const result = auditLockfile({
    registry: { app: { '1.0.0': {} } },
    root: {},
    locked: {},
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.packages, []);
  assert.deepEqual(result.cycles, []);
  assert.equal(result.summary.lockedPackages, 0);
});

test('keeps auditing a deep locked graph without a recursion limit', () => {
  // A recursive graph walk over a chain this deep blows the small stack
  // (synchronous recursion dies at ~1.2k frames under --stack-size=100),
  // so the SCC and reachability traversals must be iterative.
  const script = `
    const { auditLockfile } = require(${JSON.stringify(require.resolve('../src/resolver'))});
    const depth = 1300;
    const registry = {};
    const locked = {};
    for (let i = 0; i < depth; i += 1) {
      const name = 'p' + String(i).padStart(4, '0');
      locked[name] = '1.0.0';
      registry[name] = i + 1 < depth
        ? { '1.0.0': { dependencies: { ['p' + String(i + 1).padStart(4, '0')]: '^1.0.0' } } }
        : { '1.0.0': {} };
    }
    const result = auditLockfile({
      registry,
      root: { p0000: '^1.0.0' },
      locked,
    });
    if (result.packages.length !== depth || !result.ok) process.exit(2);
  `;

  const run = spawnSync(process.execPath, ['--stack-size=100', '-e', script], { encoding: 'utf8' });
  assert.equal(
    run.status,
    0,
    `deep graph audit failed (status ${run.status}):\n${run.stderr}`
  );
});

test('rejects malformed lockfile requests', () => {
  assert.throws(
    () => auditLockfile({ registry: {}, root: {} }),
    /locked must be an object/
  );
  assert.throws(
    () => auditLockfile({ registry: {}, root: {}, locked: { app: '1.0' } }),
    /valid semver version/
  );
  assert.throws(
    () => auditLockfile({ registry: {}, root: { app: 'nope' }, locked: {} }),
    /valid semver range/
  );
});
