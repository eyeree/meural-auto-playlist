const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function install() {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (timezone !== 'America/Los_Angeles') throw new Error(`System timezone is ${timezone}; configure America/Los_Angeles before installing this cron job.`);
  const current = spawnSync('crontab', ['-l'], { encoding: 'utf8' });
  if (current.error) throw current.error;
  if (current.status !== 0 && !/no crontab/i.test(current.stderr)) throw new Error('Could not read the existing crontab.');
  const quote = text => `'${text.replaceAll("'", "'\\''")}'`;
  const data = path.join(__dirname, '.meural');
  fs.mkdirSync(data, { recursive: true, mode: 0o700 });
  const marker = '# meural-weekly-feed';
  const command = `0 9 * * 0 ${quote(process.execPath)} ${quote(path.join(__dirname, 'index.js'))} sync --apply >> ${quote(path.join(data, 'weekly.log'))} 2>&1 ${marker}`;
  const lines = (current.stdout || '').split('\n').filter(line => !line.endsWith(marker));
  while (lines.at(-1) === '') lines.pop();
  lines.push(command);
  const result = spawnSync('crontab', ['-'], { encoding:'utf8', input: lines.join('\n') + '\n' });
  if (result.error || result.status !== 0) throw new Error('Could not install the weekly crontab.');
  console.log('Installed weekly Sunday 09:00 America/Los_Angeles (adjusts for daylight saving).');
  console.log(`Log: ${path.join(data, 'weekly.log')}`);
}

try { install(); } catch (error) { console.error(error.message); process.exitCode = 1; }
