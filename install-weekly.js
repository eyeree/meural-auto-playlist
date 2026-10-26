const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function scheduleLines(node, root) {
  const quote = text => `'${text.replaceAll("'", "'\\''")}'`;
  const command = `${quote(node)} ${quote(path.join(root, 'index.js'))} sync --apply --scheduled >> ${quote(path.join(root, '.meural/weekly.log'))} 2>&1 # meural-weekly-feed`;
  return [`0 * * * * ${command}`, `@reboot ${command}`];
}

function install() {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (timezone !== 'America/Los_Angeles') throw new Error(`System timezone is ${timezone}; configure America/Los_Angeles before installing this cron job.`);
  const current = spawnSync('crontab', ['-l'], { encoding: 'utf8' });
  if (current.error) throw current.error;
  if (current.status !== 0 && !/no crontab/i.test(current.stderr)) throw new Error('Could not read the existing crontab.');
  const data = path.join(__dirname, '.meural');
  fs.mkdirSync(data, { recursive: true, mode: 0o700 });
  const log = path.join(data, 'weekly.log');
  fs.closeSync(fs.openSync(log, 'a', 0o600));
  fs.chmodSync(log, 0o600);
  const marker = '# meural-weekly-feed';
  const lines = (current.stdout || '').split('\n').filter(line => !line.endsWith(marker));
  while (lines.at(-1) === '') lines.pop();
  lines.push(...scheduleLines(process.execPath, __dirname));
  const result = spawnSync('crontab', ['-'], { encoding:'utf8', input: lines.join('\n') + '\n' });
  if (result.error || result.status !== 0) throw new Error('Could not install the weekly crontab.');
  console.log('Installed hourly and startup checks for the Sunday 09:00 Pacific update, with missed-run recovery.');
  console.log(`Log: ${path.join(data, 'weekly.log')}`);
}

if (require.main === module) {
  try { install(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { install, scheduleLines };
