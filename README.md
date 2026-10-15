# Meural weekly public-feed playlists

Builds one playlist per configured canvas from the newest public Meural feed
playlists. Individual image orientation determines which device receives it,
including images from mixed-orientation source playlists. Videos, private items,
unknown orientations, and square images are excluded. Each managed playlist has
at most 100 images after a successful run.

Requires Node.js 22 or later. There are no npm runtime dependencies.
`agent-browser` is needed only to import the initial signed-in browser session.

## Authentication

No personal API key is required. The observed website flow is:

1. Sign in interactively to NETGEAR (including any verification challenge).
2. NETGEAR redirects to Meural with an authorization code; the website exchanges
   it at `accounts2.netgear.com/api/oauth/token?code=...`.
3. The website stores Meural access and refresh tokens in cookies.
4. Scheduled runs call `GET https://accounts2.netgear.com/api/getAccessToken`
   with `Authorization: Bearer <refresh token>` and the public Meural `appkey`.
   NETGEAR also requires the web-client Origin, Referer, and User-Agent headers.
5. Meural API calls use `https://api.meural.com/v1`, `Authorization: Token ...`,
   `x-meural-api-version: 4`, and `x-meural-source-platform: web`.

To sign in or replace an expired/revoked session:

```sh
node index.js login
```

This opens NETGEAR's normal login page in a dedicated browser tab. In WSL it
reuses Chrome on CDP port 9222, or starts Windows Chrome with the same dedicated
profile as the `cdp-chrome` helper. Complete the password and any MFA steps in
the browser. The command waits for the redirect to Meural, verifies the new
refresh token, then saves it privately. It waits for a refresh token different
from the saved one so an old browser cookie cannot masquerade as renewed login.
If NETGEAR keeps reusing the existing session, sign out in that login tab and
sign in again. Existing saved credentials are retained
if login times out or token verification fails. Login does not change playlists.
On native Linux/macOS, if no CDP browser exists, agent-browser launches a visible
Chrome session instead. Install agent-browser and its browser first if needed.
Use `--cdp PORT` for another existing browser, or `--timeout SECONDS` to change
the default ten-minute login timeout. Use the same `--data-dir` as your scheduled
job if you changed the default. An unattended scheduled run never opens a browser.

You can also import an already signed-in Meural tab manually, inspect status,
or verify the refresh token without opening a browser:

```sh
node index.js auth --cdp 9222
node index.js auth --status
node index.js auth --refresh
```

Tokens are stored in `.meural/auth.json` with mode 0600, inside a mode 0700
directory. They are git-ignored and never printed. Refreshed tokens are written
atomically, preserving the previous refresh token if NETGEAR does not rotate it.
Subsequent runs work without Chrome. The current access token has a one-hour
lifetime and is refreshed automatically before expiry or once after an HTTP 401.
The refresh token is opaque: NETGEAR does not expose its expiry date to this
script. Do not assume it is permanent or that weekly use extends its lifetime.
The observed refresh response returns only a new access token; when NETGEAR
returns a replacement refresh token, the script stores it automatically.
`auth --status` shows the access-token expiry and recorded import/refresh times,
without printing credentials. It cannot verify an opaque refresh token offline;
use `auth --refresh` to check whether NETGEAR still accepts it.
If NETGEAR expires or revokes the session,
the job exits with recovery instructions in `.meural/weekly.log`; run `login`
interactively, then retry `sync --apply`. No cron changes are needed. Refresh tokens
are account credentials: do not share the `.meural` directory.

## Configuration and commands

`meural.config.json` pins the device IDs, expected orientations, and managed
playlist names. It currently targets `monet-920` (landscape) and
`rembrandt-165` (portrait). The script checks the device-reported orientation
against the configuration rather than changing the frame orientation itself.

```sh
node index.js devices
node index.js feeds                  # List public source playlists
node index.js sync                   # Dry run (default)
node index.js sync --apply           # Update playlists and send them to canvases
node index.js sync --apply --cleanup-device
npm test
```

`--config FILE`, `--data-dir DIR`, and `--feed-pages N` override the defaults.
The configured feed-page limit defaults to up to three pages of 100 entries.
Increase it if older catalog content needs to be considered. Sources in the
scanned pages are sorted by `featuredAt`, newest first. The sync fetches images
until it has enough for both orientations, deduplicates IDs, and keeps the newest
100 matching public feed images. If fewer than 100 are available, matching
existing managed images fill the remaining space, newest additions first.
An artwork's original creation date is never used to measure playlist age.

Weekly checks add newly featured images and evict older ones; they do not
randomize the collection when Meural has not published new feed content.

The first applied run creates private, account-owned playlists. Their IDs and
item addition timestamps are saved in `.meural/state.json`. Later runs update
those playlists even if a device is currently showing a different one. Catalog
source playlists are never edited. Missing saved playlists, account changes,
orientation changes, or empty matching feed results stop the sync for review.

Writes are resumable: additions happen before removals, with pruning after each
successful addition, verification before device transfer, and state checkpoints.
A cloud list may briefly contain one extra item during an update. Timed-out
playlist writes are checked against server state before declaring failure;
ambiguous additions are not blindly replayed. A failed write
can leave a partial update; the next run re-reads actual playlist contents.
Errors do not trigger removal of the remaining old images. The job never deletes
artwork or playlists from your cloud account.

Storage cleanup detaches older playlists and individually added artwork from
the relevant device only, preserving the managed playlist. It runs automatically
when reported free space is below 500 MB, or once if a transfer explicitly fails
for insufficient storage. `--cleanup-device` forces it even with sufficient free
space. Other albums are left alone. Device downloads and space reclamation are
asynchronous; an offline device or slow reclamation can require a later retry.

## Weekly schedule

```sh
node install-weekly.js
```

Installs an idempotent user cron entry for **Sunday at 9 AM Pacific**, preserving
other cron jobs. It verifies the system timezone is `America/Los_Angeles`, so
daylight-saving changes are handled by the local cron daemon. The entry uses an
absolute Node executable and script path, avoiding cron/NVM PATH problems. It
runs `sync --apply` and appends output to `.meural/weekly.log`.

The WSL distribution and cron daemon must be running at the scheduled time; cron
does not catch up missed runs. After moving the repository or upgrading/removing
the pinned Node installation, run the installer again. To remove the schedule,
use `crontab -e` and remove the line ending in `# meural-weekly-feed`.

Runs take an exclusive `.meural/run.lock` to prevent overlapping writes and
token refresh races. A hard-killed process can leave this lock behind; remove it
only after confirming there is no running job. Keep `.meural/state.json` between
runs. `MEURAL_DEBUG=1` logs endpoint paths without credentials for diagnostics.

## API references

This uses the web client's API, without a public stability guarantee:

- [Longstanding Meural REST API reference](https://documenter.getpostman.com/view/1657302/RVnWjKUL)
- [Current community authentication implementation](https://github.com/GuySie/ha-meural/blob/master/custom_components/meural/netgear_auth.py)
- [Current community cloud client](https://github.com/GuySie/ha-meural/blob/master/custom_components/meural/pymeural.py)

Endpoint/header and refresh behavior were checked against the signed-in Meural
website on October 14, 2026. The initial password/MFA exchange was not captured.
