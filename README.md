# Meural weekly public-feed playlists

Builds one playlist per configured canvas from the newest public Meural feed
playlists. Individual image orientation determines which device receives it,
including images from mixed-orientation source playlists. Videos, private items,
unknown orientations, and square images are excluded. Each managed playlist has
at most 100 images after a successful run.

Requires Node.js 22 or later. There are no npm runtime dependencies.

## Authentication

No personal API key or browser is required. Sign in with:

```sh
node index.js login
```

The command uses NETGEAR's Cognito password/challenge API and exchanges the
result for Meural access and refresh tokens. Verification codes, if required,
are prompted for in the terminal. Passwords and codes are not echoed.

To supply the password without a prompt, create a `.env` beside `index.js`:

```dotenv
NETGEAR_EMAIL="you@example.com"
NETGEAR_PASSWORD="your-password"
```

`.env.example` contains placeholders you can copy. `.env` and `.env.*` are
ignored by Git, except `.env.example`. On POSIX systems the command restricts
`.env` to mode 0600. Quote values containing spaces or `#`. Environment variables
override `.env`. The email defaults to the saved account when available; otherwise
it is prompted for. A missing file or missing password triggers a hidden password
prompt. Use `--username EMAIL` to select another account or `--env-file FILE`
to select another credentials file. Use the same `--data-dir` as the scheduled
job if you changed the default.

Login verifies the new refresh token before replacing the saved session.
Failed login or verification leaves existing credentials untouched. Passwords and
verification codes are never written to the token cache or logged. Login does
not change playlists. There is no browser login or cookie-import dependency.

```sh
node index.js auth --status
node index.js auth --refresh
```

Tokens are stored in `.meural/auth.json` with mode 0600, inside a mode 0700
directory. They are git-ignored and never printed. Refreshed tokens are written
atomically, preserving the previous refresh token if NETGEAR does not rotate it.
Scheduled runs use the saved refresh token and do not read the password or prompt.
The current access token has a one-hour
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
website on October 14, 2026. The password/MFA implementation follows the community
authentication reference above; these NETGEAR endpoints have no public stability
guarantee.
