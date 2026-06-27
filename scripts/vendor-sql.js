const { copyFileSync, existsSync, mkdirSync } = require('fs');
const { join } = require('path');

const ROOT = join(__dirname, '..');
const src = join(ROOT, 'node_modules', 'sql.js', 'dist', 'sql-asm.js');
const dest = join(ROOT, 'vendor', 'sql-asm.js');

if (!existsSync(src)) {
  console.error('Run npm install first (sql.js must be present).');
  process.exit(1);
}

mkdirSync(join(ROOT, 'vendor'), { recursive: true });
copyFileSync(src, dest);
console.log('[vendor:sql] copied', dest);
