# Running the platform in GitHub Codespaces

This folder starts the whole platform in one codespace: the API and the worker, the seller and
admin panels, the buyer site, PostgreSQL 17, Redis and Mailpit. It changes no application code;
it is the Linux twin of `scripts/dev-local.bat`.

## Create the codespace

1. On GitHub: **Code -> Codespaces -> ... -> New with options**.
2. Branch: `main` (or the branch you want to test). Machine type: **4-core** (16 GB RAM). The
   config asks for 4 cores; with everything running the app container uses about 5 GB of RAM.
3. **Create codespace**. The first start takes about 5 minutes: it pulls the images, runs
   `pnpm install`, applies every migration and writes the local Market config
   (`.devcontainer/setup.sh`). Then `.devcontainer/start.sh` starts the apps; the API needs about
   one more minute to build.

A free personal account has 120 core-hours and 15 GB-months of storage per month, so a 4-core
codespace runs for about 30 hours a month. Stop it when you are not using it
(**Codespaces -> ... -> Stop codespace**; it also stops itself after 30 idle minutes by default).
A stopped codespace keeps the database; starting it again runs `start.sh` again.

## Open the apps

The panels only answer on the host names they are configured for (`PANEL_HOSTS`, ADR-0034), so
open them through a port forward to your own computer, not through the `*.app.github.dev`
links:

- **VS Code desktop** (Codespaces extension, "Open in VS Code Desktop"): the ports are forwarded
  to `localhost` on your computer automatically. Or
- **GitHub CLI** on your computer:
  `gh codespace ports forward 3000:3000 3001:3001 3002:3002 3003:3003 8025:8025`

Then, in your browser:

| App          | Address                           |
|--------------|-----------------------------------|
| Seller panel | http://seller.localhost:3001      |
| Admin panel  | http://admin.localhost:3002       |
| Buyer site   | http://storefront.localhost:3003  |
| API          | http://localhost:3000/health, Swagger at http://localhost:3000/docs |
| Mailpit      | http://localhost:8025 (all mail the platform sends) |

The `*.app.github.dev` links from the **Ports** tab work for the buyer site (sample data),
Swagger and Mailpit. On them the panels show their pages but every sign-in answers 404, because
that host is not in `PANEL_HOSTS`.

## Day to day

- Logs: `.local/logs/<api|worker|seller|admin|web>.log` (for example `tail -f .local/logs/api.log`).
- Stop the apps: `bash .devcontainer/stop.sh`; start them again: `bash .devcontainer/start.sh`.
- After pulling new code: `pnpm install`, `pnpm db:migrate`, then stop and start the apps.
- Sample data (one admin, five Brisbane sellers, 14 products, a buyer), as
  `scripts\demo-local.bat` does: `bash .devcontainer/seed.sh`. The logins are written to
  `.local/demo-credentials.txt`; the admin's sign-in code: `node scripts/demo-seed/admin-code.mjs`.
- Database shell: `psql postgresql://mondapac_migrator:mondapac_migrator@localhost:5432/mondapac`.

## What is not configured

Everything that needs a real key stays off, exactly as with `.env.example`: Stripe test
payments, Mapbox address lookup and map, Google sign-in, the AI assistant and description
writer, couriers (Mondapac Drive, Uber Direct, Zoom2u, DoorDash, Australia Post), S3 (photos are
stored on disk in `.object-store/`) and ClamAV. To try one, add its variables to `.env` (or
`apps/<app>/.env.local`) in the codespace, or store them as Codespaces secrets in your GitHub
settings, and restart the apps. Never commit them.
