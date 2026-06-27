const { existsSync, readdirSync } = require('fs');
const { join, sep } = require('path');

function addModulePath(dir) {
  if (!dir || !existsSync(dir)) return;
  if (!module.paths.includes(dir)) {
    module.paths.unshift(dir);
  }
}

function findCloudLinuxNodevenvModules(appRoot) {
  const parts = appRoot.split(sep).filter(Boolean);
  const domainsIdx = parts.lastIndexOf('domains');
  if (domainsIdx < 0 || domainsIdx + 1 >= parts.length) return null;

  const homeParts = parts.slice(0, domainsIdx);
  const domain = parts[domainsIdx + 1];
  const appParts = parts.slice(domainsIdx + 2);
  if (!homeParts.length || !appParts.length) return null;

  const venvRoot = join(...homeParts, 'nodevenv', 'domains', domain, ...appParts);
  if (!existsSync(venvRoot)) return null;

  let versions = [];
  try {
    versions = readdirSync(venvRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => Number(b) - Number(a));
  } catch {
    return null;
  }

  for (const version of versions) {
    const candidate = join(venvRoot, version, 'lib', 'node_modules');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function patchModulePaths() {
  const appRoot = join(__dirname, '..');

  const cloudLinuxModules = findCloudLinuxNodevenvModules(appRoot);
  if (cloudLinuxModules) {
    addModulePath(cloudLinuxModules);
  }

  if (process.env.NODE_VIRTUAL_ENV) {
    addModulePath(join(process.env.NODE_VIRTUAL_ENV, 'lib', 'node_modules'));
  }

  if (process.env.NODE_PATH) {
    for (const entry of process.env.NODE_PATH.split(sep)) {
      addModulePath(entry);
    }
  }

  addModulePath(join(appRoot, 'node_modules'));
}

function getModuleSearchPaths() {
  return module.paths.slice(0, 8);
}

patchModulePaths();

module.exports = { getModuleSearchPaths, getAppRoot: () => join(__dirname, '..') };
