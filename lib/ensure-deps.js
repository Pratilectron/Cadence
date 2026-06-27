const REQUIRED_PACKAGES = [
  'sql.js',
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
  console.error('[Cadence] Fix: open DirectAdmin → Setup Node.js App → Run NPM Install');
  console.error('[Cadence] Or SSH: cd to the folder with package.json && npm install --omit=dev');
  console.error('[Cadence] Do not upload node_modules from your PC — install on the server.');
  process.exit(1);
}

module.exports = { checkDependencies };
