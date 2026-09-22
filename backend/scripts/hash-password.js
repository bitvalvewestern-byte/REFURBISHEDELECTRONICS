'use strict';
/**
 * Generate an ADMIN_PASSWORD_HASH value for backend/.env
 *   node scripts/hash-password.js "MyStrongPassword"
 *   npm run hash-password -- "MyStrongPassword"
 */
const { hashPassword } = require('../services/adminService');

const password = process.argv[2];
if (!password) {
  console.error('Usage: node scripts/hash-password.js "your-password"');
  process.exit(1);
}
if (password.length < 10) {
  console.error('Refusing: choose a password of at least 10 characters.');
  process.exit(1);
}
console.log('\nAdd this line to backend/.env:\n');
console.log(`ADMIN_PASSWORD_HASH=${hashPassword(password)}\n`);
