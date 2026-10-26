const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

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
  if (process.platform === 'linux') {
    const handle = await fs.open(file, 'a+', 0o600);
    try {
      // flock operates on the inherited open file description. The parent keeps
      // it locked after this helper exits; close/process death releases it.
      const result = spawnSync('flock', ['-n', '3'], { stdio: ['ignore', 'ignore', 'ignore', handle.fd], timeout: 5000 });
      if (result.error || ![0, 1].includes(result.status)) throw new Error('Could not acquire the run lock. Install the Linux flock utility (util-linux).');
      if (result.status === 1) throw Object.assign(new Error(`Another run holds ${file}.`), { code: 'ELOCKED' });
      // Honor a live job using the previous PID-file implementation during the
      // upgrade. A dead legacy owner can be safely migrated to the OS lock.
      const previous = await handle.readFile('utf8');
      if (/^\d+$/.test(previous.trim())) {
        if (await processExists(Number(previous.trim()))) throw Object.assign(new Error(`Another run holds ${file}.`), { code: 'ELOCKED' });
      }
      await handle.chmod(0o600);
      await handle.truncate(0);
      await handle.writeFile(JSON.stringify({ lock: 'flock', pid: process.pid }));
      return await work();
    } finally { await handle.close(); }
  }
  let handle;
  try { handle = await fs.open(file, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw Object.assign(new Error(`Another run holds ${file}. Remove it only after confirming that run has stopped.`), { code: 'ELOCKED' });
    throw error;
  }
  try { await handle.writeFile(String(process.pid)); return await work(); }
  finally { await handle.close(); await fs.rm(file, { force: true }); }
}

async function processExists(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; if (error.code === 'EPERM') return true; throw error; }
}

module.exports = { readJSON, writeJSON, withLock };
