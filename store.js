const fs = require('node:fs/promises');
const path = require('node:path');

async function readJSON(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error; }
}

async function writeJSON(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    await fs.chmod(temporary, 0o600);
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
}

async function withLock(file, work) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  let handle;
  try { handle = await fs.open(file, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Another run holds ${file}. Remove it only after confirming that run has stopped.`);
    throw error;
  }
  try { await handle.writeFile(String(process.pid)); return await work(); }
  finally { await handle.close(); await fs.rm(file, { force: true }); }
}

module.exports = { readJSON, writeJSON, withLock };
