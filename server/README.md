# IRMA API proxy

Read-only Node.js proxy for loading public competition data from IRMA. The proxy handles the IRMA session cookie and CSRF token, combines the competition, competition-day, class and entry data, and allows the browser simulator to read it without exposing a general-purpose proxy.

## Run with Docker

```bash
cd server
cp .env.example .env
docker compose up -d --build
curl http://127.0.0.1:3000/health
```

Load competition day `27518`:

```bash
curl http://127.0.0.1:3000/api/irma/competitions/27518
```

Load the public registration list for a competition day:

```bash
curl http://127.0.0.1:3000/api/irma/competitions/27518/entries
```

The simulator's **Hae ilmoittautuneet IRMA:sta** panel uses this endpoint and
creates `KilpSrj.xml` and `KILP.DAT` in the browser. IRMA does not provide the
course control codes in the registration list, so select the event's existing
`radat1.xml` before loading the generated files. If IRMA has not made the
registration report public, the endpoint returns an error instead of exposing
private entries.

List competitions from the IRMA calendar:

```bash
curl "http://127.0.0.1:3000/api/irma/competitions?year=2026&upcoming=true&lang=fi"
```

The list endpoint returns `{ "competitions": [...] }`. `year` is optional and
defaults to the current year; `upcoming` defaults to `true`. The endpoint is
read-only and uses the same short in-memory cache as the competition detail
endpoint.

Language can be `fi`, `sv` or `en`:

```bash
curl "http://127.0.0.1:3000/api/irma/competitions/27518?lang=fi"
```

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Listening port inside the container |
| `ALLOWED_ORIGIN` | `https://ikivela.github.io` | Allowed browser origin; multiple origins can be comma-separated |
| `CACHE_TTL_SECONDS` | `300` | In-memory cache lifetime |
| `NODE_ENV` | `production` | Use `development` to include upstream error details |

For local browser development, use for example:

```text
ALLOWED_ORIGIN=https://ikivela.github.io,http://localhost:8000,http://127.0.0.1:8000,http://localhost:5500,http://127.0.0.1:5500,http://localhost:5173,http://127.0.0.1:5173
```

## Nginx

Use a dedicated HTTPS hostname and proxy it to the loopback-only container port:

```nginx
server {
    listen 443 ssl;
    server_name irma-api.example.fi;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Configure the certificate with Certbot or your existing TLS setup. The public API URL will then be:

```text
https://irma-api.example.fi/api/irma/competitions/27518
```

## Browser request

```js
const response = await fetch(
  "https://irma-api.example.fi/api/irma/competitions/27518"
);

if (!response.ok) {
  throw new Error(`IRMA request failed: ${response.status}`);
}

const data = await response.json();
console.log(data.competition, data.classes, data.entries);
```

The IRMA endpoints used here are internal and undocumented. They can change when IRMA is updated.
