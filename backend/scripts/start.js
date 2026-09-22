'use strict';
/**
 * Production start script (used by render.yaml and any Node host).
 *
 * Why this exists: in production the backend refuses the plain-text
 * ADMIN_PASSWORD (config only accepts ADMIN_PASSWORD_HASH). This script
 * hashes the password once at boot, removes the plain value from the child
 * process environment, and then runs the real server. The plain password
 * therefore never appears in the running process's environment.
 *
 *   ADMIN_PASSWORD_HASH set  -> used as-is (recommended)
 *   ADMIN_PASSWORD set       -> hashed here, plain value stripped
 *   neither set              -> exit with a clear error
 *
 * Usage:
 *   node scripts/start.js
 */
const path = require('node:path');
const { spawn } = require('node:child_process');

// Load backend/.env so ADMIN_PASSWORD / ADMIN_PASSWORD_HASH are available
// even when the host only sets the other variables.
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { hashPassword } = require('../services/adminService');

const BACKEND_ROOT = path.join(__dirname, '..');

function fail(message) {
  console.error(`[start.js] ${message}`);
  process.exit(1);
}

let passwordHash = process.env.ADMIN_PASSWORD_HASH;
if (!passwordHash) {
  const plain = process.env.ADMIN_PASSWORD;
  if (!plain) {
    fail(
      'No admin credentials configured. Set ADMIN_PASSWORD_HASH (recommended, ' +
        'from `npm run hash-password -- "YourStrongPassword"`) or ADMIN_PASSWORD ' +
        '(hashed at boot and stripped from the environment).'
    );
  }
  if (plain.length < 10) {
    fail('ADMIN_PASSWORD is too short; choose at least 10 characters.');
  }
  passwordHash = hashPassword(plain);
  console.log('[start.js] ADMIN_PASSWORD_HASH not set: hashed ADMIN_PASSWORD at boot (plain value stripped).');
} else {
  console.log('[start.js] using ADMIN_PASSWORD_HASH from environment.');
}

const childEnv = { ...process.env, ADMIN_PASSWORD_HASH: passwordHash };
delete childEnv.ADMIN_PASSWORD; // never pass the plain password to the server

const child = spawn(process.execPath, ['server.js'], {
  cwd: BACKEND_ROOT,
  env: childEnv,
  stdio: 'inherit',
});

child.on('error', (err) => {
  console.error(`[start.js] failed to start server: ${err.message}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    console.log(`[start.js] server exited via ${signal}`);
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 0);
  }
});

// Forward termination signals so the host can stop the server gracefully.
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(sig, () => child.kill(sig));
}
