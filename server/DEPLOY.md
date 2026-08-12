# Choral server

One file, no dependencies. Games are held in memory and nothing is written to
disk, so a restart ends every game in progress.

## Local

```bash
node server.js
```

Listens on 8790. A page opened from localhost points at it automatically, so the
whole thing can be played through without deploying.

## Point the game at it

`index.html` holds the address in one place:

```js
const SERVER = /^(localhost|127\.0\.0\.1|\[::1\]|)$/.test(location.hostname)
  ? 'http://127.0.0.1:8790'
  : 'https://choral-server.example.run.app';
```

The second address is a placeholder. Replace it after the first deploy.

## Cloud Run

```bash
gcloud run deploy choral --source . --region us-central1 --allow-unauthenticated --max-instances 1 --concurrency 80 --memory 256Mi --set-env-vars ALLOW_ORIGIN=https://maplesugarstone.github.io
```

- `--max-instances 1` must not change. Games live in one process, so a second
  instance would answer half the requests and know nothing about the other half.
- No `--min-instances`, so the process shuts down when nobody is playing. Safe
  here because each player holds a request open, so a live game is never idle.
  Costs a cold start for the first player of the day.
- `--concurrency 80` is the real ceiling on players, since each holds one open
  request.
- `ALLOW_ORIGIN` is the origin only. The game is served from
  `https://maplesugarstone.github.io/Choral`, so the value is
  `https://maplesugarstone.github.io`. Including `/Choral` makes every request
  fail without saying why. Unset allows any site to call the API.

Both ends are HTTPS, so the client must use the `https://` form of the Cloud Run
address. This fits inside the free tier at this size.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | 8790 | set by Cloud Run |
| `MAX_PLAYERS` | 10 | seats in the whole lobby |
| `MAX_SEATS_PER_IP` | 3 | games one address may hold at once. A household shares one address, so this is seats per household |
| `MAX_WAITING` | `MAX_PLAYERS` + 10 | requests held open at once |
| `POOL_SECONDS` | 600 | each clock starts here |
| `INCREMENT` | 2 | seconds returned for placing a piece |
| `ALLOW_ORIGIN` | `*` | the site allowed to call the API |

## Protections

- **Flooding.** 40 tokens per address refilling at 8 a second. A request costs 2,
  a poll costs 0.25. The address is the last `X-Forwarded-For` entry, the one
  Cloud Run itself appends; the earlier entries are client supplied. A second
  bucket covers all traffic as a backstop. Behind a proxy that is not Cloud Run,
  check which entry is the trustworthy one.
- **Lobby capacity.** `MAX_PLAYERS` total, `MAX_SEATS_PER_IP` per address. Past
  that, arrivals get 503 with `full: true` rather than an empty room.
- **Large or slow requests.** Bodies cap at 2048 bytes. Headers must arrive in 10
  seconds, the request in 20. Rejections wait for the client to finish sending,
  or closing early would reset its next request.
- **Junk input.** Names match `[A-Za-z0-9 _-]{1,16}`, codes are 8 characters from
  a fixed alphabet, squares must land on the agreed board.
- **Guessing.** Codes are `crypto.randomInt` over 36^8. Tokens are 24 random
  bytes. Both are far past what the rate limit allows anyone to try.
- **Unbounded memory.** Rooms dropped after 45 idle minutes, seekers after 5,
  bucket table pruned past 5000 addresses.
- **Cross site use.** `ALLOW_ORIGIN` pins the API to your page. No cookies are
  set.

## Not protected against

- **A modified client.** The rules run in the browser. The server checks turn
  order and owns the clock, but does not know whether a square was legal. An
  edited client can send an illegal move, which the opponent's client rejects and
  reports rather than accepting. Fixing this means porting the rules here.
- **A restart.** A redeploy ends every game in progress. There is no reconnect.
- **Names.** Nobody owns one.
