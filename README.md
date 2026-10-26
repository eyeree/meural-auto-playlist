# Meural weekly public-feed playlists

Builds one playlist per configured canvas from public Meural feed playlists,
rotating weekly through unseen images, then the least recently shown images.
Individual image orientation determines which device receives it,
including images from mixed-orientation source playlists. Videos, private items,
unknown orientations, and square images are excluded. Each managed playlist has
at most 100 images after a successful run.

Requires Node.js 22 or later. There are no npm runtime dependencies.
Linux/WSL also uses `flock` from the standard `util-linux` package for locking.

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
The configured feed-page limit defaults to up to 100 pages of 100 entries.
The scan stops at the end of the feed and reads the full pool within that limit,
using at most four concurrent playlist requests. It deduplicates image IDs and
filters prices: sampler images, images with zero nonsubscriber price, and images
with zero subscriber price when the account reports an active membership are
eligible. Missing/unknown prices and items requiring an additional payment are
excluded. Public visibility by itself does not establish eligibility. The script
does not purchase artwork.

Each Sunday at 9 AM Pacific begins a new selection period. The script prefers
images never used on that device, breaking ties by newest feed feature date.
When fewer than 100 unseen images remain, it fills the rest with images shown
least recently. Repeats are unavoidable if the eligible pool is smaller than 100.
The same selection is kept throughout the week, including manual reruns. History
for removed images stays in `.meural/state.json`, so old images are not mistaken
for unseen ones. The first run migrates the existing playlists into that history.
History measures successful playlist sends, not individual on-screen playbacks.

The first applied run creates private, account-owned playlists. Their IDs and
item addition timestamps are saved in `.meural/state.json`. Later runs update
those playlists even if a device is currently showing a different one. Catalog
source playlists are never edited. Missing saved playlists, account changes,
orientation changes, or empty matching feed results stop the sync for review.

Writes are resumable: the intended selection is saved before artwork changes,
so a failed run retries the same batch. Additions happen before removals, with pruning after each
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

Installs idempotent user cron entries for startup and the top of every hour,
replacing the old Sunday-only entry and preserving other cron jobs. Each check
runs `sync --apply --scheduled`, which computes the latest **Sunday at 9 AM
Pacific** and updates only devices that have not succeeded since then. Already
completed devices are skipped, including when another device needs a retry.
Several missed weeks produce one catch-up update, rather than replaying old weeks.
Pacific daylight-saving changes are handled explicitly. The installer verifies
the system timezone and uses absolute Node/script paths to avoid cron/NVM PATH
problems. Timestamped output is appended to `.meural/weekly.log`.

When WSL is off at the scheduled time, the startup check catches up when cron
starts again. The hourly check also handles resume from sleep and retries after
network or API failures. WSL and its cron daemon still need to run eventually;
these entries do not wake Windows or start a stopped WSL distribution themselves.
After moving the repository or upgrading/removing the pinned Node installation,
run the installer again. To remove the schedule, use `crontab -e` and remove both
lines ending in `# meural-weekly-feed`.

Runs take an exclusive `.meural/run.lock` to prevent overlapping writes and
token refresh races. On Linux/WSL this is an OS lock, automatically released on
process exit, forced termination, or shutdown; the file itself stays in place and
must not be deleted while a job runs. Scheduled checks skip cleanly when another
run holds the lock. Other platforms use the original exclusive PID file, which
can require manual cleanup after a forced termination. Keep `.meural/state.json`
between runs. `MEURAL_DEBUG=1` logs endpoint paths without credentials for diagnostics.

## API references

This uses the web client's API, without a public stability guarantee:

- [Longstanding Meural REST API reference](https://documenter.getpostman.com/view/1657302/RVnWjKUL)
- [Current community authentication implementation](https://github.com/GuySie/ha-meural/blob/master/custom_components/meural/netgear_auth.py)
- [Current community cloud client](https://github.com/GuySie/ha-meural/blob/master/custom_components/meural/pymeural.py)

Endpoint/header and refresh behavior were checked against the signed-in Meural
website on October 14, 2026. The password/MFA implementation follows the community
authentication reference above; these NETGEAR endpoints have no public stability
guarantee.
