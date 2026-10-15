const path = require('node:path');
const { parseArgs } = require('node:util');
const { Auth } = require('./auth');
const { login } = require('./api-login');
const { readJSON, withLock } = require('./store');
const Meural = require('./meural');
const { sync } = require('./sync');

async function main(args = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    apply: { type: 'boolean' }, 'dry-run': { type: 'boolean' },
    'cleanup-device': { type: 'boolean' }, 'refresh': { type: 'boolean' }, status: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' }, username: { type: 'string' },
    config: { type: 'string', default: path.join(__dirname, 'meural.config.json') },
    'data-dir': { type: 'string', default: path.join(__dirname, '.meural') },
    'feed-pages': { type: 'string' }, 'env-file': { type: 'string', default: path.join(__dirname, '.env') }
  } });
  const command = positionals[0] || 'sync';
  if (values.help) {
    console.log(`Usage: node index.js <command> [options]
  login                Sign in through NETGEAR's API (prompts for MFA if needed)
  auth --status        Show access-token expiry (refresh expiry is unknown)
  auth --refresh       Verify the saved refresh token
  devices              List devices, orientations, and storage
  feeds                List public feed playlists (metadata only)
  sync                 Preview changes; default is a dry run
  sync --apply         Apply changes and send playlists to devices
  sync --apply --cleanup-device  Also remove old device content
Options: --config FILE --data-dir DIR --feed-pages N --dry-run
Login options: --username EMAIL --env-file FILE
Password: NETGEAR_PASSWORD in .env/environment, or a hidden terminal prompt
Weekly scheduling instructions: README.md`);
    return;
  }
  if (positionals.length > 1 || !['login','auth','devices','feeds','sync'].includes(command)) throw new Error('Unknown command. Use --help.');
  if (values.apply && values['dry-run']) throw new Error('Choose either --apply or --dry-run.');
  if (values.status && values.refresh) throw new Error('Choose either --status or --refresh.');
  const directory = path.resolve(values['data-dir']);
  await withLock(path.join(directory, 'run.lock'), async () => {
    const authFile = path.join(directory, 'auth.json');
    const auth = new Auth(authFile);
    if (command === 'login') {
      await login(authFile, { username: values.username, envFile: path.resolve(values['env-file']) });
      return;
    }
    if (command === 'auth') {
      if (values.status) console.log(JSON.stringify(await auth.status(), null, 2));
      else if (values.refresh) { await auth.token(true); console.log('NETGEAR token refresh succeeded.'); }
      else throw new Error('Use auth --status, auth --refresh, or login to sign in.');
      return;
    }
    const api = new Meural(auth);
    if (command === 'devices') {
      console.log(JSON.stringify((await api.devices()).map(d=>({id:d.id,alias:d.alias,orientation:d.orientation,currentGallery:d.currentGallery,freeSpaceMB:d.freeSpace})),null,2));
      return;
    }
    const config = await readJSON(values.config);
    if (values['feed-pages'] !== undefined) config.feedPages = Number(values['feed-pages']);
    require('./sync').validateConfig(config);
    if (command === 'feeds') {
      const seen = new Set();
      for (let page = 1; page <= config.feedPages; page++) {
        const response = await api.feedPage(page);
        if (!Array.isArray(response.data) || typeof response.isLast !== 'boolean') throw new Error('Unexpected feed response.');
        for (const p of response.data) if (p.postType === 'gallery' && p.post?.isPublic === true && !seen.has(String(p.post.id))) {
          seen.add(String(p.post.id));
          console.log(JSON.stringify({id:p.post.id,name:p.post.name,orientation:p.post.orientation,featuredAt:p.post.featuredAt,itemCount:p.post.itemCount}));
        }
        if (response.isLast) break;
      }
      return;
    }
    await sync(api, config, path.join(directory, 'state.json'), {
      apply: !!values.apply, cleanupDevice: !!values['cleanup-device']
    });
  });
}

if (require.main === module) main().catch(error => {
  console.error(error.message); process.exitCode = 1;
});
module.exports = { main };
