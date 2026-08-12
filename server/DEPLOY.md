# Putting the Choral server online

The server is one file with no dependencies. It holds games in memory and never
writes to disk, so there is no database to run and nothing to back up. That also
means a restart ends every game in progress, which is the tradeoff for keeping
the whole thing this small.

## Run it on your own machine first

```bash
node server.js
```

It listens on 8790 and prints the capacity it started with. A page opened from
localhost talks to that address on its own, so the whole thing can be played
through without deploying anything.

## Point the game at it

`index.html` carries the address in one place, near the comment that begins
"Where the server lives":

```js
const SERVER = /^(localhost|127\.0\.0\.1|\[::1\]|)$/.test(location.hostname)
  ? 'http://127.0.0.1:8790'
  : 'https://choral-server.example.run.app';
```

The second address is a placeholder. Replace it with what Cloud Run gives you
after the first deploy. Until then the far away menu works only on localhost.

## Cloud Run

The instance count must be pinned to one. Games live in the memory of a single
process, so a second instance would answer half the requests and know nothing
about the other half.

```bash
gcloud run deploy choral --source . --region us-central1 --allow-unauthenticated --max-instances 1 --concurrency 80 --memory 256Mi --set-env-vars ALLOW_ORIGIN=https://your-name-here.github.io
```

What each of those is doing:

- `--max-instances 1` is the one setting that must not change.
- There is no `--min-instances`, which means the process is allowed to shut down
  when nobody is playing. That is what keeps the bill at nothing. It is safe
  here because of how the game waits: each player holds a request open the whole
  time, so a game in progress is never idle and the process is never reclaimed
  underneath it. The cost is a second or two of cold start for the first player
  of the day.
- `--concurrency 80` is well above what ten players need. Each of them holds one
  request open at a time.
- `ALLOW_ORIGIN` must be the **origin** of the page, with no path on the end.
  A project page lives at `https://name.github.io/choral/`, and the origin of
  that is `https://name.github.io`. Putting the repository name in makes every
  request fail. Leaving the variable unset allows any site to call the API.

Cloud Run terminates TLS and gives you an HTTPS address. GitHub Pages is HTTPS
too, and a page served over HTTPS is not allowed to call a plain HTTP address,
so the client must point at the `https://` form.

At this size everything above sits inside the Cloud Run free tier. Watch the
billing page for the first week anyway, since a mistake in `--max-instances` is
the one that would cost money.

## What can be tuned without editing the file

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | 8790 | set by Cloud Run |
| `MAX_PLAYERS` | 10 | seats in the whole lobby |
| `MAX_SEATS_PER_IP` | 2 | games one address may hold at once |
| `MAX_WAITING` | 40 | requests held open at once |
| `POOL_SECONDS` | 600 | each clock starts here |
| `INCREMENT` | 2 | seconds returned for placing a piece |
| `ALLOW_ORIGIN` | `*` | the site allowed to call the API |

## What the exposed connection is protected against

- **Flooding.** Every address gets a bucket of 40 tokens refilling at 8 a
  second. Asking for something costs 2 and waiting for a move costs 0.25, so a
  patient client is never punished for polling. A second bucket covers everyone
  together, because the address a request claims to come from is a header and a
  header can be invented.
- **Filling the lobby.** Ten seats total, two per address. An eleventh player is
  told the lobbies are full rather than being left in a room nobody will join.
- **Large or slow requests.** Bodies stop at 2048 bytes. Headers must arrive
  within 10 seconds and the whole request within 20, so a connection cannot be
  held open by sending one byte at a time. A refusal waits for the client to
  finish sending before it answers, because closing on a client that is still
  writing resets its next request rather than this one, and being told to slow
  down has to leave a player able to try again.
- **Junk input.** Names must match `[A-Za-z0-9 _-]{1,16}` and codes must be
  eight characters from a fixed alphabet. A square must be a whole number that
  lands on the board both players agreed to. Anything else is refused before it
  reaches a room.
- **Guessing a private code.** Codes come from `crypto.randomInt` over 36
  characters, which is about 2.8 trillion of them, and seat tokens are 24 random
  bytes. Both are far beyond what the rate limit allows anyone to try.
- **Memory growing without bound.** Rooms are dropped after 45 idle minutes,
  seekers after 5, and the table of rate limit buckets is pruned once it passes
  5000 addresses.
- **Cross site use.** `ALLOW_ORIGIN` pins the API to your page. No cookies are
  ever set, so there is no session for another site to ride on.

## What it is not protected against

Worth saying plainly rather than leaving it to be discovered.

- **A modified client.** The rules run in the browser. The server checks that a
  move came from the right player at the right time, and it owns the clock, but
  it does not know whether a square was legal. Someone who edits their own copy
  can send a move their opponent's copy will refuse, which desyncs the game
  rather than winning it. Closing this means porting the rule set into the
  server, which is a real option later if the game finds an audience that cares.
- **A restart.** A redeploy ends every game in progress. There is no reconnect.
- **Names.** Nobody owns one. Two players may both call themselves the same
  thing on the same day.
