'use strict';

const semver = require('semver');

class ResolutionError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'ResolutionError';
    this.statusCode = 400;
    this.details = details;
  }
}

const ROOT_SOURCE = Object.freeze({ type: 'root' });
const UPDATE_SOURCE = Object.freeze({ type: 'update' });

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertNonEmptyName(name, location) {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new ResolutionError(`${location} names must be non-empty strings.`);
  }
}

function compareSource(a, b) {
  if (a.type !== b.type) return a.type < b.type ? -1 : 1;
  if (a.type === 'root' || a.type === 'update') return 0;
  if (a.package !== b.package) return a.package < b.package ? -1 : 1;
  return semver.compareBuild(a.version, b.version);
}

function compareConstraints(a, b) {
  if (a.range !== b.range) return a.range < b.range ? -1 : 1;
  return compareSource(a.source, b.source);
}

function comparePathNodes(a, b) {
  // Root-level constraints carry empty chains, so both nodes may be absent.
  if (a.name === undefined && b.name === undefined) return 0;
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  const versionResult = semver.compareBuild(a.version, b.version);
  if (versionResult !== 0) return versionResult;
  if (a.range !== b.range) return a.range < b.range ? -1 : 1;
  return compareSource(a.source, b.source);
}

/**
 * Convert and validate the request body into Maps that do not retain the
 * caller's object insertion order.
 */
function normalizeInput(input) {
  if (!isPlainObject(input)) {
    throw new ResolutionError('The request body must be a JSON object.');
  }

  const { registry, root } = input;

  if (!isPlainObject(registry)) {
    throw new ResolutionError('registry must be an object mapping package names to versions.');
  }
  if (!isPlainObject(root)) {
    throw new ResolutionError('root must be an object mapping dependency names to semver ranges.');
  }

  const catalog = new Map();

  for (const packageName of Object.keys(registry).sort()) {
    assertNonEmptyName(packageName, 'registry');
    const versionsInput = registry[packageName];

    if (!isPlainObject(versionsInput)) {
      throw new ResolutionError(`registry.${packageName} must map versions to package metadata.`);
    }

    const canonicalVersionEntries = Object.entries(versionsInput).map(([version, metadata]) => {
      if (!semver.valid(version)) {
        throw new ResolutionError(`"${version}" in registry.${packageName} is not a valid semver version.`);
      }
      return { originalVersion: version, canonicalVersion: semver.parse(version).version, metadata };
    });

    canonicalVersionEntries.sort((a, b) =>
      semver.rcompare(a.canonicalVersion, b.canonicalVersion)
    );

    const versionEntries = [];
    const canonicalVersions = new Set();

    for (const { originalVersion: version, canonicalVersion, metadata } of canonicalVersionEntries) {
      if (canonicalVersions.has(canonicalVersion)) {
        throw new ResolutionError(
          `registry.${packageName} contains duplicate canonical version ${canonicalVersion}.`
        );
      }
      canonicalVersions.add(canonicalVersion);
      if (!isPlainObject(metadata)) {
        throw new ResolutionError(`registry.${packageName}.${version} must be an object.`);
      }

      const dependencies = new Map();
      if (metadata.dependencies !== undefined) {
        if (!isPlainObject(metadata.dependencies)) {
          throw new ResolutionError(
            `registry.${packageName}.${version}.dependencies must be an object.`
          );
        }

        for (const dependencyName of Object.keys(metadata.dependencies).sort()) {
          assertNonEmptyName(dependencyName, 'dependency');
          const range = metadata.dependencies[dependencyName];
          if (typeof range !== 'string' || semver.validRange(range) === null) {
            throw new ResolutionError(
              `Dependency "${dependencyName}" of ${packageName}@${version} has an invalid semver range.`
            );
          }
          dependencies.set(dependencyName, range);
        }
      }

      versionEntries.push({
        version: canonicalVersion,
        dependencies,
      });
    }

    if (versionEntries.length === 0) {
      throw new ResolutionError(`registry.${packageName} must contain at least one version.`);
    }

    catalog.set(packageName, versionEntries);
  }

  const rootRequirements = new Map();
  for (const packageName of Object.keys(root).sort()) {
    assertNonEmptyName(packageName, 'root');
    const range = root[packageName];
    if (typeof range !== 'string' || semver.validRange(range) === null) {
      throw new ResolutionError(`root.${packageName} must be a valid semver range string.`);
    }
    rootRequirements.set(packageName, range);
  }

  return { catalog, rootRequirements };
}

function serializeSource(source) {
  if (source.type === 'root') return { type: 'root' };
  if (source.type === 'update') return { type: 'update' };
  return {
    type: 'dependency',
    package: source.package,
    version: source.version,
  };
}

function cloneConstraints(constraints) {
  const result = new Map();
  for (const [name, entries] of constraints) {
    result.set(name, entries.map((entry) => ({ ...entry, source: { ...entry.source } })));
  }
  return result;
}

function cloneReasons(reasons) {
  const result = new Map();
  for (const [name, chains] of reasons) {
    result.set(name, chains.map((chain) => chain.map((node) => ({
      name: node.name,
      version: node.version,
      range: node.range,
      source: { ...node.source },
    }))));
  }
  return result;
}

function cloneSelected(selected) {
  const result = new Map();
  for (const [name, entry] of selected) {
    result.set(name, {
      ...entry,
      source: { ...entry.source },
      path: entry.path.map((node) => ({ ...node, source: { ...node.source } })),
    });
  }
  return result;
}

function sourceLabel(source) {
  if (source.type === 'root') return 'root';
  if (source.type === 'update') return 'update';
  return `${source.package}@${source.version}`;
}

function choosePrimaryConstraint(entries, chains) {
  let bestIndex = 0;

  for (let i = 1; i < entries.length; i += 1) {
    const best = chains[bestIndex];
    const current = chains[i];

    if (
      current.length > best.length ||
      (current.length === best.length && comparePathNodes(
        current[current.length - 1] || {},
        best[best.length - 1] || {}
      ) < 0)
    ) {
      bestIndex = i;
    }
  }

  return { entry: entries[bestIndex], chain: chains[bestIndex] };
}

function buildEndpointConstraints(entries) {
  return entries
    .map((entry) => ({
      requiredRange: entry.range,
      requiredBy: serializeSource(entry.source),
    }))
    .sort((a, b) => compareConstraints(
      { range: a.requiredRange, source: a.requiredBy },
      { range: b.requiredRange, source: b.requiredBy }
    ));
}

function buildConflict(target, state, reasonCode, catalog) {
  const entries = state.constraints.get(target) || [];
  const chains = state.reasons.get(target) || [];
  const primary = choosePrimaryConstraint(entries, chains);
  const selected = state.selected.get(target);
  const availableVersions = (catalog.get(target) || []).map((entry) => entry.version);
  const compatibleVersions = availableVersions.filter((version) =>
    satisfiesAll(version, entries)
  );

  const chain = primary.chain.map((node) => ({
    package: node.name,
    selectedVersion: node.version,
    requiredRange: node.range,
    requiredBy: serializeSource(node.source),
  }));

  chain.push({
    package: target,
    ...(selected ? { selectedVersion: selected.version } : {}),
    requiredRange: primary.entry.range,
    requiredBy: serializeSource(primary.entry.source),
    constraints: buildEndpointConstraints(entries),
    availableVersions,
    compatibleVersions,
    reasonCode,
  });

  return {
    satisfiable: false,
    conflict: {
      package: target,
      reasonCode,
      chain,
    },
  };
}

function satisfiesAll(version, constraints) {
  return constraints.every(({ range }) => semver.satisfies(version, range));
}

function byName(a, b) {
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
}

/**
 * Build the initial solver state from named requirement sets. Each set
 * contributes one constraint per package, inserted in sorted package-name
 * order so the state never depends on the caller's key order.
 */
function buildInitialState(requirementSets) {
  const constraints = new Map();
  const reasons = new Map();

  for (const { requirements, source } of requirementSets) {
    for (const [name, range] of [...requirements.entries()].sort(byName)) {
      if (!constraints.has(name)) {
        constraints.set(name, []);
        reasons.set(name, []);
      }
      constraints.get(name).push({ range, source: { ...source } });
      reasons.get(name).push([]);
    }
  }

  return { constraints, reasons, selected: new Map() };
}

/**
 * Select a candidate version for target and propagate its dependencies into
 * a cloned state. Returns { state } on success or { conflict } when one of
 * the new dependency ranges contradicts an already selected version.
 */
function applyCandidate(state, target, candidate, catalog) {
  const nextConstraints = cloneConstraints(state.constraints);
  const nextReasons = cloneReasons(state.reasons);
  const nextSelected = cloneSelected(state.selected);

  const targetEntries = nextConstraints.get(target);
  const targetChains = nextReasons.get(target);
  const primary = choosePrimaryConstraint(targetEntries, targetChains);

  const selectedEntry = {
    version: candidate.version,
    range: primary.entry.range,
    source: { ...primary.entry.source },
    path: primary.chain.map((node) => ({ ...node, source: { ...node.source } })),
  };
  nextSelected.set(target, selectedEntry);

  const pathNode = {
    name: target,
    version: candidate.version,
    range: primary.entry.range,
    source: { ...primary.entry.source },
  };
  const dependencyChain = [...selectedEntry.path, pathNode];

  for (const dependencyName of [...candidate.dependencies.keys()].sort()) {
    const range = candidate.dependencies.get(dependencyName);
    const source = {
      type: 'dependency',
      package: target,
      version: candidate.version,
    };
    const constraint = { range, source };

    if (!nextConstraints.has(dependencyName)) {
      nextConstraints.set(dependencyName, []);
      nextReasons.set(dependencyName, []);
    }

    nextConstraints.get(dependencyName).push(constraint);
    nextReasons.get(dependencyName).push(
      dependencyChain.map((node) => ({ ...node, source: { ...node.source } }))
    );

    const alreadySelected = nextSelected.get(dependencyName);
    if (alreadySelected && !semver.satisfies(alreadySelected.version, range)) {
      return {
        conflict: buildConflict(
          dependencyName,
          {
            constraints: nextConstraints,
            reasons: nextReasons,
            selected: nextSelected,
          },
          'SELECTED_VERSION_DOES_NOT_SATISFY_CONSTRAINT',
          catalog
        ),
      };
    }
  }

  return {
    state: {
      constraints: nextConstraints,
      reasons: nextReasons,
      selected: nextSelected,
    },
  };
}

function solve({ catalog, rootRequirements }) {
  const initialState = buildInitialState([
    { requirements: rootRequirements, source: ROOT_SOURCE },
  ]);
  let firstConflict = null;

  function recordConflict(conflict) {
    if (firstConflict === null) firstConflict = conflict;
    return null;
  }

  function dfs(state) {
    const unresolved = [...state.constraints.keys()]
      .filter((name) => !state.selected.has(name))
      .sort();

    if (unresolved.length === 0) {
      return [...state.selected.entries()]
        .sort(byName)
        .map(([name, entry]) => ({
          package: name,
          version: entry.version,
        }));
    }

    const target = unresolved[0];
    const targetConstraints = state.constraints.get(target);
    const availableVersions = catalog.get(target) || [];
    const candidates = availableVersions.filter((entry) =>
      satisfiesAll(entry.version, targetConstraints)
    );

    if (candidates.length === 0) {
      const reasonCode = availableVersions.length === 0
        ? 'PACKAGE_NOT_IN_REGISTRY'
        : 'NO_VERSION_SATISFIES_CONSTRAINTS';
      return recordConflict(buildConflict(target, state, reasonCode, catalog));
    }

    for (const candidate of candidates) {
      const result = applyCandidate(state, target, candidate, catalog);
      if (result.conflict) {
        recordConflict(result.conflict);
        continue;
      }

      const solution = dfs(result.state);
      if (solution) return solution;
    }

    return null;
  }

  const plan = dfs(initialState);

  if (plan) {
    return {
      satisfiable: true,
      plan,
    };
  }

  return firstConflict;
}

function normalizeLocked(locked) {
  if (!isPlainObject(locked)) {
    throw new ResolutionError('locked must be an object mapping package names to locked versions.');
  }

  const result = new Map();
  for (const packageName of Object.keys(locked).sort()) {
    assertNonEmptyName(packageName, 'locked');
    const version = locked[packageName];
    if (typeof version !== 'string' || !semver.valid(version)) {
      throw new ResolutionError(`locked.${packageName} must be a valid semver version string.`);
    }
    result.set(packageName, semver.parse(version).version);
  }
  return result;
}

function normalizeUpdate(update) {
  if (!isPlainObject(update)) {
    throw new ResolutionError('update must be an object mapping package names to semver ranges.');
  }

  const result = new Map();
  for (const packageName of Object.keys(update).sort()) {
    assertNonEmptyName(packageName, 'update');
    const range = update[packageName];
    if (typeof range !== 'string' || semver.validRange(range) === null) {
      throw new ResolutionError(`update.${packageName} must be a valid semver range string.`);
    }
    result.set(packageName, range);
  }
  return result;
}

/**
 * Total order over feasible plans: fewer changes relative to locked wins;
 * ties are broken by walking package names in lexicographic order and
 * preferring the higher version (a plan that contains the package beats one
 * that does not). Returns 0 only for identical plans.
 */
function comparePlans(a, b) {
  if (a.changes !== b.changes) return a.changes - b.changes;

  const names = [...new Set([...a.versions.keys(), ...b.versions.keys()])].sort();
  for (const name of names) {
    const aVersion = a.versions.get(name);
    const bVersion = b.versions.get(name);
    if (aVersion === undefined && bVersion === undefined) continue;
    if (aVersion === undefined) return 1;
    if (bVersion === undefined) return -1;
    const order = semver.compareBuild(aVersion, bVersion);
    if (order !== 0) return -order;
  }
  return 0;
}

function solveUpdate({ catalog, rootRequirements, updateRequirements, locked }) {
  const initialState = buildInitialState([
    { requirements: rootRequirements, source: ROOT_SOURCE },
    { requirements: updateRequirements, source: UPDATE_SOURCE },
  ]);

  let firstConflict = null;
  let best = null;

  function recordConflict(conflict) {
    if (firstConflict === null) firstConflict = conflict;
  }

  // Lower bound on the changes any completion of this state still needs.
  // Selections are final, and every constrained package missing from locked
  // must appear in the final plan. Locked packages not yet constrained are
  // not counted: a later selection may still pull them into the plan.
  function lowerBoundChanges(state) {
    let count = 0;
    for (const [name, entry] of state.selected) {
      if (locked.get(name) !== entry.version) count += 1;
    }
    for (const name of state.constraints.keys()) {
      if (!state.selected.has(name) && !locked.has(name)) count += 1;
    }
    return count;
  }

  function exactChanges(selected) {
    let count = 0;
    for (const [name, entry] of selected) {
      if (locked.get(name) !== entry.version) count += 1;
    }
    for (const name of locked.keys()) {
      if (!selected.has(name)) count += 1;
    }
    return count;
  }

  function dfs(state) {
    if (best !== null && lowerBoundChanges(state) > best.changes) return;

    const unresolved = [...state.constraints.keys()]
      .filter((name) => !state.selected.has(name))
      .sort();

    if (unresolved.length === 0) {
      const plan = [...state.selected.entries()]
        .sort(byName)
        .map(([name, entry]) => ({
          package: name,
          version: entry.version,
        }));
      const candidate = {
        plan,
        changes: exactChanges(state.selected),
        versions: new Map(plan.map((entry) => [entry.package, entry.version])),
      };
      if (best === null || comparePlans(candidate, best) < 0) best = candidate;
      return;
    }

    const target = unresolved[0];
    const targetConstraints = state.constraints.get(target);
    const availableVersions = catalog.get(target) || [];
    const candidates = availableVersions.filter((entry) =>
      satisfiesAll(entry.version, targetConstraints)
    );

    if (candidates.length === 0) {
      const reasonCode = availableVersions.length === 0
        ? 'PACKAGE_NOT_IN_REGISTRY'
        : 'NO_VERSION_SATISFIES_CONSTRAINTS';
      recordConflict(buildConflict(target, state, reasonCode, catalog));
      return;
    }

    // Try the locked version first so low-change plans are found early; the
    // remaining candidates keep their descending version order.
    const lockedVersion = locked.get(target);
    const ordered = lockedVersion === undefined
      ? candidates
      : candidates
        .filter((entry) => entry.version === lockedVersion)
        .concat(candidates.filter((entry) => entry.version !== lockedVersion));

    const bound = lowerBoundChanges(state);

    for (const candidate of ordered) {
      const cost = candidate.version === lockedVersion ? 0 : 1;
      if (best !== null && bound + cost > best.changes) continue;

      const result = applyCandidate(state, target, candidate, catalog);
      if (result.conflict) {
        recordConflict(result.conflict);
        continue;
      }

      dfs(result.state);
    }
  }

  dfs(initialState);

  if (best === null) return firstConflict;

  const kept = [];
  const changed = [];

  for (const { package: name, version } of best.plan) {
    const lockedVersion = locked.get(name);
    if (lockedVersion === undefined) {
      changed.push({ package: name, from: null, to: version });
    } else if (lockedVersion !== version) {
      changed.push({ package: name, from: lockedVersion, to: version });
    } else {
      kept.push({ package: name, version });
    }
  }

  for (const [name, lockedVersion] of [...locked.entries()].sort(byName)) {
    if (!best.versions.has(name)) {
      changed.push({ package: name, from: lockedVersion, to: null });
    }
  }

  changed.sort((a, b) => (a.package < b.package ? -1 : a.package > b.package ? 1 : 0));

  return {
    satisfiable: true,
    plan: best.plan,
    kept,
    changed,
  };
}

// --- Lockfile audit ---------------------------------------------------------

const AUDIT_ISSUE_CODES = Object.freeze([
  'ROOT_DEPENDENCY_NOT_LOCKED',
  'ROOT_RANGE_VIOLATION',
  'DEPENDENCY_NOT_LOCKED',
  'LOCKED_VERSION_RANGE_VIOLATION',
  'LOCKED_VERSION_NOT_IN_REGISTRY',
  'CYCLE',
]);

function auditSourceKey(requiredBy) {
  if (!requiredBy) return '';
  if (requiredBy.type === 'root') return 'root';
  return `${requiredBy.package}@${requiredBy.version}`;
}

function auditPathKey(path) {
  return path
    .map((node) => `${node.name}@${node.version === null ? '' : node.version}`)
    .join('>');
}

function compareAuditIssues(a, b) {
  const rankA = AUDIT_ISSUE_CODES.indexOf(a.code);
  const rankB = AUDIT_ISSUE_CODES.indexOf(b.code);
  if (rankA !== rankB) return rankA - rankB;
  const rangeA = a.requiredRange || '';
  const rangeB = b.requiredRange || '';
  if (rangeA !== rangeB) return rangeA < rangeB ? -1 : 1;
  const sourceA = auditSourceKey(a.requiredBy);
  const sourceB = auditSourceKey(b.requiredBy);
  if (sourceA !== sourceB) return sourceA < sourceB ? -1 : 1;
  const pathA = auditPathKey(a.path);
  const pathB = auditPathKey(b.path);
  return pathA < pathB ? -1 : pathA > pathB ? 1 : 0;
}

/**
 * BFS predecessor for every locked package reachable from a root
 * requirement. Roots are expanded in name order and a package's locked
 * dependencies are sorted by name, so the first BFS visit always follows
 * the shortest, then lexicographically smallest root-to-package chain.
 * Storing predecessors (rather than a full path per package) keeps the
 * traversal O(n); paths are reconstructed on demand.
 */
function buildRootPredecessors(rootRequirements, lockedVersions, edges) {
  const predecessor = new Map();
  const queue = [];

  for (const [name, range] of [...rootRequirements.entries()].sort(byName)) {
    if (lockedVersions.has(name) && !predecessor.has(name)) {
      predecessor.set(name, { from: null, range });
      queue.push(name);
    }
  }

  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head];
    for (const edge of edges.get(current) || []) {
      if (lockedVersions.has(edge.name) && !predecessor.has(edge.name)) {
        predecessor.set(edge.name, { from: current, range: edge.range });
        queue.push(edge.name);
      }
    }
  }

  return predecessor;
}

function reconstructRootPath(name, predecessor, lockedVersions) {
  const nodes = [];
  let cursor = name;
  while (cursor !== null) {
    const pred = predecessor.get(cursor);
    nodes.push({
      name: cursor,
      version: lockedVersions.get(cursor),
      range: pred.range,
      // null marks the root edge; undefined marks an orphan chain start.
      requiredBy: pred.from === null ? null : { package: pred.from, version: lockedVersions.get(pred.from) },
    });
    cursor = pred.from;
  }
  return nodes.reverse();
}

function buildEdgePath(sourceName, edge, rootPredecessors, lockedVersions) {
  const targetNode = {
    name: edge.name,
    version: lockedVersions.has(edge.name) ? lockedVersions.get(edge.name) : null,
    range: edge.range,
    requiredBy: { package: sourceName, version: lockedVersions.get(sourceName) },
  };

  if (rootPredecessors.has(sourceName)) {
    return [...reconstructRootPath(sourceName, rootPredecessors, lockedVersions), targetNode];
  }

  return [
    { name: sourceName, version: lockedVersions.get(sourceName), range: undefined, requiredBy: undefined },
    targetNode,
  ];
}

function serializeAuditPath(path) {
  if (path === null) return null;
  return path.map((node) => {
    const serialized = { package: node.name, version: node.version };
    if (node.range !== undefined) serialized.requiredRange = node.range;
    if (node.requiredBy === null) {
      serialized.requiredBy = { type: 'root' };
    } else if (node.requiredBy === undefined) {
      serialized.requiredBy = null;
    } else {
      serialized.requiredBy = {
        type: 'dependency',
        package: node.requiredBy.package,
        version: node.requiredBy.version,
      };
    }
    return serialized;
  });
}

function serializeAuditIssue(issue) {
  const result = { code: issue.code };
  if (issue.lockedVersion !== undefined) result.lockedVersion = issue.lockedVersion;
  if (issue.requiredRange !== undefined) result.requiredRange = issue.requiredRange;
  if (issue.requiredBy !== undefined) {
    result.requiredBy = issue.requiredBy === null
      ? { type: 'root' }
      : { type: 'dependency', package: issue.requiredBy.package, version: issue.requiredBy.version };
  }
  result.path = serializeAuditPath(issue.path);
  return result;
}

/**
 * Find the SCCs of the locked graph with iterative Kosaraju so deep graphs
 * cannot overflow the call stack. Adjacency lists are pre-sorted by
 * dependency name, which makes both passes and the resulting component
 * ordering independent of object key order.
 */
function findCyclicComponents(nodes, edges) {
  const lockedNodes = new Set(nodes);
  const visited = new Set();
  const finishOrder = [];

  for (const start of nodes) {
    if (visited.has(start)) continue;
    const stack = [{ node: start, edgeIndex: 0 }];
    visited.add(start);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const neighbors = edges.get(frame.node) || [];
      if (frame.edgeIndex < neighbors.length) {
        const next = neighbors[frame.edgeIndex].name;
        frame.edgeIndex += 1;
        // Cycles are defined over the locked graph only; unlocked targets
        // have no recorded outgoing edges and cannot close a loop.
        if (lockedNodes.has(next) && !visited.has(next)) {
          visited.add(next);
          stack.push({ node: next, edgeIndex: 0 });
        }
      } else {
        finishOrder.push(frame.node);
        stack.pop();
      }
    }
  }

  const reverseEdges = new Map();
  for (const source of nodes) {
    for (const edge of edges.get(source) || []) {
      if (!lockedNodes.has(edge.name)) continue;
      if (!reverseEdges.has(edge.name)) reverseEdges.set(edge.name, []);
      reverseEdges.get(edge.name).push({ name: source, range: edge.range });
    }
  }

  const components = [];
  const assigned = new Set();

  for (let i = finishOrder.length - 1; i >= 0; i -= 1) {
    const start = finishOrder[i];
    if (assigned.has(start)) continue;

    const members = [];
    const stack = [start];
    assigned.add(start);
    while (stack.length > 0) {
      const node = stack.pop();
      members.push(node);
      for (const edge of reverseEdges.get(node) || []) {
        if (!assigned.has(edge.name)) {
          assigned.add(edge.name);
          stack.push(edge.name);
        }
      }
    }
    members.sort();
    if (members.length > 1 || (edges.get(members[0]) || []).some((edge) => edge.name === members[0])) {
      components.push(members);
    }
  }

  components.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return components;
}

/**
 * Deterministic representative cycle for an SCC: the shortest cycle from the
 * smallest member back to itself, breaking ties by successor name. Edges are
 * traversed in name order, so BFS discovers the lexicographically smallest
 * such cycle first. Returns BFS predecessor data; the path is reconstructed
 * only when the cycle is serialized.
 */
function findCycleClosure(members, start, edges) {
  const inComponent = new Set(members);
  const predecessor = new Map();
  const queue = [start];
  let closing = null;

  for (let head = 0; head < queue.length && closing === null; head += 1) {
    const current = queue[head];
    for (const edge of edges.get(current) || []) {
      if (!inComponent.has(edge.name)) continue;
      if (edge.name === start) {
        closing = { from: current, range: edge.range };
        break;
      }
      if (!predecessor.has(edge.name)) {
        predecessor.set(edge.name, { from: current, range: edge.range });
        queue.push(edge.name);
      }
    }
  }

  return { predecessor, closing };
}

function buildCyclePath(members, start, edges, rootPredecessors, lockedVersions) {
  const { predecessor, closing } = findCycleClosure(members, start, edges);

  // Successor nodes n1, ..., nk, start (the closing node repeats the start).
  const successors = [{
    name: start,
    range: closing.range,
    requiredBy: { package: closing.from, version: lockedVersions.get(closing.from) },
  }];
  let cursor = closing.from;
  while (cursor !== start) {
    const pred = predecessor.get(cursor);
    successors.push({
      name: cursor,
      range: pred.range,
      requiredBy: { package: pred.from, version: lockedVersions.get(pred.from) },
    });
    cursor = pred.from;
  }
  successors.reverse();

  if (rootPredecessors.has(start)) {
    return [...reconstructRootPath(start, rootPredecessors, lockedVersions), ...successors];
  }
  return [
    { name: start, version: lockedVersions.get(start), range: undefined, requiredBy: undefined },
    ...successors,
  ];
}

function auditLockfile(input) {
  const { catalog, rootRequirements } = normalizeInput(input);
  const lockedVersions = normalizeLocked(input.locked);

  // Metadata for each locked version, taken as recorded — no re-selection.
  const lockedEntries = [...lockedVersions.entries()].sort(byName).map(([name, version]) => {
    const registryVersions = catalog.get(name) || [];
    const registryEntry = registryVersions.find((entry) => entry.version === version) || null;
    return { name, version, registryEntry };
  });

  // Locked graph: edges are known only when the locked version is in the
  // registry, and only edges pointing at locked packages participate.
  const edges = new Map();
  for (const { name, registryEntry } of lockedEntries) {
    if (!registryEntry) continue;
    edges.set(
      name,
      [...registryEntry.dependencies.entries()]
        .sort(byName)
        .map(([dependencyName, range]) => ({ name: dependencyName, range }))
    );
  }

  const rootPredecessors = buildRootPredecessors(rootRequirements, lockedVersions, edges);

  // Issues grouped by the package they describe (target-centric). Targets
  // may be referenced packages that are absent from `locked`.
  const issues = new Map();

  function addIssue(target, issue) {
    if (!issues.has(target)) issues.set(target, []);
    issues.get(target).push(issue);
  }

  // 1. Root requirements against the locked graph.
  for (const [name, range] of [...rootRequirements.entries()].sort(byName)) {
    if (!lockedVersions.has(name)) {
      addIssue(name, {
        code: 'ROOT_DEPENDENCY_NOT_LOCKED',
        requiredRange: range,
        requiredBy: null,
        path: [{ name, version: null, range, requiredBy: null }],
      });
    } else if (!semver.satisfies(lockedVersions.get(name), range)) {
      addIssue(name, {
        code: 'ROOT_RANGE_VIOLATION',
        lockedVersion: lockedVersions.get(name),
        requiredRange: range,
        requiredBy: null,
        path: reconstructRootPath(name, rootPredecessors, lockedVersions),
      });
    }
  }

  // 2. Every locked package's recorded semver dependencies.
  for (const { name: sourceName, version: sourceVersion, registryEntry } of lockedEntries) {
    if (!registryEntry) continue;
    for (const edge of edges.get(sourceName)) {
      if (!lockedVersions.has(edge.name)) {
        addIssue(edge.name, {
          code: 'DEPENDENCY_NOT_LOCKED',
          requiredRange: edge.range,
          requiredBy: { package: sourceName, version: sourceVersion },
          path: buildEdgePath(sourceName, edge, rootPredecessors, lockedVersions),
        });
      } else if (!semver.satisfies(lockedVersions.get(edge.name), edge.range)) {
        addIssue(edge.name, {
          code: 'LOCKED_VERSION_RANGE_VIOLATION',
          lockedVersion: lockedVersions.get(edge.name),
          requiredRange: edge.range,
          requiredBy: { package: sourceName, version: sourceVersion },
          path: buildEdgePath(sourceName, edge, rootPredecessors, lockedVersions),
        });
      }
    }
  }

  // 3. Locked versions that the offline registry no longer provides.
  for (const { name, registryEntry } of lockedEntries) {
    if (!registryEntry) {
      addIssue(name, {
        code: 'LOCKED_VERSION_NOT_IN_REGISTRY',
        path: rootPredecessors.has(name)
          ? reconstructRootPath(name, rootPredecessors, lockedVersions)
          : null,
      });
    }
  }

  // 4. Cycles inside the locked graph.
  const cycles = [];
  const cyclicComponents = findCyclicComponents(
    lockedEntries.map((entry) => entry.name),
    edges
  );
  for (const members of cyclicComponents) {
    const start = members[0];
    const path = buildCyclePath(
      members,
      start,
      edges,
      rootPredecessors,
      lockedVersions
    );
    cycles.push({ packages: members, path });
    for (const member of members) {
      addIssue(member, { code: 'CYCLE', path });
    }
  }

  const statuses = { ok: 0, orphan: 0, error: 0, missing: 0 };
  const referencedNames = new Set(issues.keys());
  const packageNames = [...new Set([...lockedVersions.keys(), ...referencedNames])].sort();

  const packages = packageNames.map((name) => {
    const packageIssues = (issues.get(name) || []).slice().sort(compareAuditIssues);

    if (lockedVersions.has(name)) {
      const version = lockedVersions.get(name);
      const reachable = rootPredecessors.has(name);
      const status = packageIssues.length > 0 ? 'error' : reachable ? 'ok' : 'orphan';
      statuses[status] += 1;
      return {
        package: name,
        version,
        status,
        reachable,
        path: serializeAuditPath(
          reachable ? reconstructRootPath(name, rootPredecessors, lockedVersions) : null
        ),
        issues: packageIssues.map(serializeAuditIssue),
      };
    }

    statuses.missing += 1;
    return {
      package: name,
      version: null,
      status: 'missing',
      reachable: false,
      path: null,
      issues: packageIssues.map(serializeAuditIssue),
    };
  });

  const byCode = {};
  for (const code of AUDIT_ISSUE_CODES) byCode[code] = 0;
  let issueCount = 0;
  for (const packageIssues of issues.values()) {
    for (const issue of packageIssues) {
      byCode[issue.code] += 1;
      issueCount += 1;
    }
  }

  const orphanCount = lockedEntries.filter(({ name }) => !rootPredecessors.has(name)).length;

  return {
    ok: issueCount === 0 && orphanCount === 0,
    summary: {
      lockedPackages: lockedVersions.size,
      reachable: lockedVersions.size - orphanCount,
      orphans: orphanCount,
      missing: statuses.missing,
      cycles: cyclicComponents.length,
      issues: issueCount,
      byCode,
      statuses,
    },
    packages,
    cycles: cycles.map((cycle) => ({
      packages: cycle.packages,
      path: serializeAuditPath(cycle.path),
    })),
  };
}

function resolve(input) {
  return solve(normalizeInput(input));
}

function planUpdate(input) {
  const { catalog, rootRequirements } = normalizeInput(input);
  const locked = normalizeLocked(input.locked);
  const updateRequirements = normalizeUpdate(input.update);
  return solveUpdate({ catalog, rootRequirements, updateRequirements, locked });
}

module.exports = {
  ResolutionError,
  auditLockfile,
  normalizeInput,
  planUpdate,
  resolve,
  sourceLabel,
};
