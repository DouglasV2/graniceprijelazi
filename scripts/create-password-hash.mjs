import crypto from 'crypto';

const password = process.argv[2];
if (!password || password.length < 8) {
  console.error('Usage: node scripts/create-password-hash.mjs "lozinka-od-barem-8-znakova"');
  process.exit(1);
}

const salt = crypto.randomBytes(16).toString('hex');
const hash = crypto.pbkdf2Sync(String(password), salt, 130000, 32, 'sha256').toString('hex');
console.log(`pbkdf2_sha256$130000$${salt}$${hash}`);
