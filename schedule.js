const pacific = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
});

function parts(date) {
  return Object.fromEntries(pacific.formatToParts(date).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
}

// Latest Sunday 09:00 Pacific, including the spring/fall offset changes.
function latestWeeklyRun(now = new Date()) {
  const local = parts(now);
  const day = new Date(Date.UTC(local.year, local.month - 1, local.day));
  let daysBack = day.getUTCDay();
  if (daysBack === 0 && local.hour < 9) daysBack = 7;
  const wallTime = day.getTime() - daysBack * 86400000 + 9 * 3600000;
  let instant = wallTime;
  for (let i = 0; i < 3; i++) {
    const p = parts(new Date(instant));
    instant += wallTime - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  }
  return new Date(instant).toISOString();
}

function needsWeeklyRun(record, due) {
  return !(Date.parse(record?.lastSuccess) >= Date.parse(due));
}

module.exports = { latestWeeklyRun, needsWeeklyRun };
