// Prints fresh random secrets to paste into your .env file. Run: npm run keygen
import { randomBytes } from 'node:crypto';
console.log('Paste these two lines into your .env file (replace the placeholder lines):\n');
console.log(`MASTER_ENCRYPTION_KEY=${randomBytes(32).toString('base64')}`);
console.log(`SESSION_SECRET=${randomBytes(48).toString('base64')}`);
console.log('\nKeep .env private and back up MASTER_ENCRYPTION_KEY somewhere safe.');
console.log('If it is lost, encrypted client data can never be recovered. Never share it or commit it.');
