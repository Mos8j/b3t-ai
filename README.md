# UCAAS

Windows PowerShell: use `npm.cmd` instead of `npm` if scripts are blocked.

## First-time setup
    npm install
    npm test
    copy .env.example .env
    npm run keygen            (paste the two printed lines into .env, replacing the placeholders)

## Database (Docker Desktop must be running)
    npm run db:up
    npm run db:migrate        (creates/updates the tables; safe to re-run)
    npm run db:status
    npm run db:down           (stops the containers; data is kept)

## Run the app
    npm run dev
Then open http://localhost:3000. The first time, it asks you to create the admin account.

Packages: `core` (rules), `importer` (website lists), `security` (encryption, passwords, redaction, roles), `db` (migrations).
Apps: `api` (login, clients, browser page).
Docs: `docs/`. Your site data: `data/`.
