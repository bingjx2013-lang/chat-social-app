'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const dbPath = path.join(dataDir, 'app.sqlite');
const backupRoot = path.resolve(process.env.BACKUP_DIR || path.join(dataDir, 'backups'));
if (!fs.existsSync(dbPath)) {
  console.error(`Database not found at ${dbPath}`);
  process.exit(1);
}
fs.mkdirSync(backupRoot, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const targetDir = path.join(backupRoot, `backup-${stamp}`);
fs.mkdirSync(targetDir, { recursive: false });
(async () => {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    await db.backup(path.join(targetDir, 'app.sqlite'));
  } finally {
    db.close();
  }
  const uploads = path.join(dataDir, 'uploads');
  if (fs.existsSync(uploads)) fs.cpSync(uploads, path.join(targetDir, 'uploads'), { recursive: true, errorOnExist: true });
  fs.writeFileSync(path.join(targetDir, 'BACKUP-MANIFEST.txt'),
    `Created: ${new Date().toISOString()}\nDatabase: app.sqlite\nUploads: ${fs.existsSync(uploads) ? 'included' : 'directory missing'}\n`);
  console.log(`Backup completed: ${targetDir}`);
})().catch(err => {
  console.error('Backup failed:', err.message);
  process.exitCode = 1;
});
