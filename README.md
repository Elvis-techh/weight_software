# Báscula Central

**A truck-scale and back-office system for a weighing station.** It reads weights straight from a physical scale, records every weighing, prices each load, and keeps the station's receipts, expenses and payroll in one place, even when the internet drops.

[![Latest release](https://img.shields.io/github/v/release/Elvis-techh/weight_software?label=release)](https://github.com/Elvis-techh/weight_software/releases/latest)
[![Release workflow](https://github.com/Elvis-techh/weight_software/actions/workflows/release.yml/badge.svg)](https://github.com/Elvis-techh/weight_software/actions/workflows/release.yml)
![Platform](https://img.shields.io/badge/desktop-Windows-0078D6)
![Node](https://img.shields.io/badge/node-20-339933)

> The application's interface is in **Spanish** because it is used daily by Spanish-speaking staff at a station in Honduras. Code and code comments are in English.

---

## What problem does it solve?

A weighing station handles trucks all day: a truck arrives loaded, is weighed, unloads, is weighed again, and the difference is what gets paid for. On paper or in spreadsheets this is slow and easy to get wrong: a misread number, a lost receipt, a price applied to the wrong client, an edit nobody can explain later.

Báscula Central replaces that with one system that:

- **Takes the weight from the scale itself**, so nobody types it by hand.
- **Calculates the amount owed** from the client's agreed price, per ton or per quintal (100 lb).
- **Prints the receipt (boleta)** and keeps a searchable history of every weighing.
- **Keeps the books** for the station: external receipts, expenses, and payroll.
- **Leaves a trail.** Every edit or deletion of a record is logged with a before/after copy and a written reason, so changes can be reviewed.
- **Never loses a weighing.** If the connection to the server is lost, weighings are queued on the computer and sent when it returns.

## Features

| Area | What it does |
|---|---|
| **Pesaje** (weighing) | Live reading from the scale over a serial port, with stability detection. Two-pass weighing (Peso 1 / Peso 2) giving gross, tare and net, trucks waiting in the yard, manual entry as a fallback, automatic boleta numbering, receipt printing. |
| **Clientes** (clients) | Client records with agreed prices per ton or per quintal, categories, and a global price adjustment tool. |
| **Overview / Historial de Pesajes** | Daily overview and a filterable history of all weighings, with reports. |
| **Historial de Cambios** | Audit log of edits and deletions. Each entry stores what changed and a mandatory reason, for fraud review. |
| **Recibos externos** | Tracks receipts from external buyers: tonnage, price, payment status, scanned receipt or PDF attached. |
| **Gastos** (expenses) | Station expenses with attached photos or PDFs. |
| **Planilla** (payroll) | Employees, daily attendance and pay periods. |
| **Offline queue** | Weighings made without a connection are stored locally and synced automatically. |
| **Auto-update** | The installed app checks GitHub Releases and offers to update itself. |

## How it works

```
┌─────────────────────────────┐        HTTPS         ┌──────────────────────────────┐
│  Desktop app (Electron)     │ ───────────────────▶ │  API server (Node + Express) │
│  Windows PC at the station  │                      │  SQLite database (WAL mode)  │
│                             │ ◀─────────────────── │                              │
│  • UI (HTML + Tailwind CSS) │                      │  • Serialized write queue    │
│  • Serial-port scale reader │                      │  • Rate limiting, Helmet     │
│  • Offline weighing queue   │                      │  • Hourly backups            │
└──────────────┬──────────────┘                      └───────────────┬──────────────┘
               │ RS-232 / USB serial                                 │ S3-compatible API
        ┌──────▼──────┐                                     ┌────────▼─────────┐
        │ Truck scale │                                     │ Object storage   │
        │ indicator   │                                     │ receipts, photos,│
        └─────────────┘                                     │ DB backups       │
                                                            └──────────────────┘
```

- **Frontend** ([frontend/](frontend/)): an Electron desktop app. It reads the scale with `serialport`, renders the UI, prints receipts, and updates itself with `electron-updater`.
- **Backend** ([backend/](backend/)): an Express API over a SQLite database in WAL mode. Writes go through a single queue so concurrent terminals cannot corrupt a record.
- **Storage**: receipt scans, photos and PDFs go to S3-compatible object storage (DigitalOcean Spaces). Without it, they are stored in the database, which is how local development works.
- **Backups**: a systemd timer snapshots the database every hour and uploads it off the server. Seven days of hourly copies are kept, plus one per day indefinitely. The restore script verifies the restored row counts. See [backend/deploy/README.md](backend/deploy/README.md).

## Tech stack

| Layer | Technology |
|---|---|
| Desktop shell | Electron 28, electron-builder (NSIS installer), electron-updater |
| UI | Vanilla JavaScript, Tailwind CSS 3, PDF.js |
| Hardware | `serialport` |
| API | Node.js 20, Express 4, Helmet, express-rate-limit |
| Database | SQLite (`sqlite3`) in WAL mode |
| Object storage | AWS SDK v3 against DigitalOcean Spaces |
| CI/CD | GitHub Actions builds and publishes the Windows installer on every version tag |

## Repository layout

```
backend/            Express API, SQLite schema and migrations
  scripts/          Backup, restore, reset and sandbox helper scripts
  deploy/           systemd units and the production runbook
frontend/           Electron app
  js/               Feature modules (pesaje, clientes, planilla, ...)
  receipt/          Printable receipt and report templates
  scripts/dev.js    One-command local sandbox
.github/workflows/  Release pipeline
DESARROLLO.md       Development and deployment guide (Spanish)
```

## Getting started (development)

Development never touches the real station's data: `npm run dev` starts a **sandbox**, which is a local server with its own throwaway database and a separate offline queue. The window is framed in amber so you always know where you are.

**Requirements:** Node.js 20 and npm. Windows is the target platform for installers; development also works on Linux and macOS.

```bash
git clone https://github.com/Elvis-techh/weight_software.git
cd weight_software

# 1. Install dependencies
(cd backend  && npm install)
(cd frontend && npm install)

# 2. Start the sandbox server and the app together
cd frontend
npm run dev
```

No scale is needed for development: use **Ingreso Manual** in the weighing screen to enter weights by hand.

Configuration for the production server is documented in [backend/.env.example](backend/.env.example). Copy it to `.env`; never commit the filled-in file.

More detail, including loading a copy of a real backup into the sandbox and testing offline mode, is in [DESARROLLO.md](DESARROLLO.md) (Spanish).

## Releasing

Releases are tag-driven. Bump the version in `frontend/package.json`, commit, then:

```bash
git tag vX.Y.Z && git push origin vX.Y.Z
```

The [release workflow](.github/workflows/release.yml) builds the Windows installer and publishes it to [Releases](https://github.com/Elvis-techh/weight_software/releases). Installed apps pick it up the next time they open. Ordinary pushes to `main` never trigger a release.

## Project status

Báscula Central is in **production use** at a working weighing station and is actively developed. It is built around that station's workflow, so it is shared here as a reference and portfolio project rather than a general-purpose product. Issues and ideas are welcome.

## Security

Please do not open a public issue for a security problem. Contact the maintainer privately through the email on their [GitHub profile](https://github.com/Elvis-techh).

## Author

Built and maintained by [Elvis Rivera](https://github.com/Elvis-techh).
