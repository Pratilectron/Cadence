const REQUIRED_PACKAGES = [
  'busboy',
  'dotenv',
  'socket.io',
];

function checkDependencies() {
  const missing = [];
  for (const name of REQUIRED_PACKAGES) {
    try {
      require.resolve(name);
    } catch {
      missing.push(name);
    }
  }

  if (!missing.length) return;

  console.error('[Cadence] Missing npm packages:', missing.join(', '));
  console.error('[Cadence] Fix: DirectAdmin → Setup Node.js App → set Application root to the folder with package.json');
  console.error('[Cadence] Then click Run NPM Install and Restart.');
  console.error('[Cadence] Module search paths:', require('./module-paths').getModuleSearchPaths().join(' | '));
  process.exit(1);
}

module.exports = { checkDependencies };
