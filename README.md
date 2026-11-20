# Cosmic Cafe Inventory System

A lightweight, high-uptime inventory management web application built for a student-run high school coffee shop. Powered by **PocketBase** (Go + embedded SQLite), it replaces fragile multi-tab spreadsheets with QR-routed mobile zone counting, multi-location stock aggregation, DripOS POS CSV depletion tracking, and automated 1:30 PM school-day reorder digests.

---

## Two-Box Infrastructure Overview

To guarantee morning-rush reliability while giving Computer Science and Cybersecurity students a safe sandbox to explore real infrastructure, this system runs across two isolated Google Cloud VMs:

| Environment | URL | GCP Instance | Public IP | Ingress & TLS | Uses `cloudflared`? |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Production (`prod`)** | `https://inventory.yourcafe.org` | `e2-small` (2 vCPU, 2 GB RAM) | **Static External IPv4** | **Caddy** (`:443` $\rightarrow$ `127.0.0.1:8090`) | **NO** (direct static IP + Caddy) |
| **Dev Sandbox (`dev`)** | `https://dev.yourcafe.org` | `e2-micro` (Always-Free tier) | **None / Ephemeral** ($0/mo) | **Cloudflare Tunnel** (`cloudflared` $\rightarrow$ `127.0.0.1:8090`) | **YES** (required; no open ports) |

> **Important Networking Note:** `prod` intentionally does **not** run `cloudflared` so live cafe operations never depend on a tunnel daemon or ephemeral routing. `dev` requires `cloudflared` because it skips a fixed IPv4 address and keeps all inbound HTTP/HTTPS firewall ports closed.

---

## Repository Structure

```text
cosmic-cafe-inventory/
├── ARCHITECTURE.md               # Network topology, firewall rules & security notes
├── CONTRIBUTING.md               # Student & advisor workflow, sandbox rules & PR guide
├── README.md                     # Setup, operations & maintenance guide (this file)
├── setup-vm.sh                   # Idempotent Ubuntu 24.04 VM provisioner (--env prod|dev)
├── data/
│   └── seed-catalog.json         # Cleaned 84-item Cosmic Cafe catalog, zones & vendors
├── pb_hooks/
│   └── cosmic_cafe.pb.js         # Multi-zone sum hook, 1:30 PM order cron & DripOS API
├── pb_public/
│   └── index.html                # Single-file mobile QR counter, dashboard & QR printer
└── scripts/
    └── seed.mjs                  # Node.js API script to create collections & seed data
```

---

## Quickstart Deployment

### 1. Provision Both VMs
SSH into each fresh Ubuntu 24.04 LTS VM on Google Cloud and run `setup-vm.sh` with its matching environment flag:

* **On `cafe-prod` (Static IP, Caddy TLS, no `cloudflared`):**
  ```bash
  sudo bash setup-vm.sh --env prod --domain inventory.yourcafe.org
  ```
* **On `cafe-dev` (Ephemeral IP, `cloudflared` tunnel, no Caddy):**
  ```bash
  sudo bash setup-vm.sh --env dev --domain dev.yourcafe.org --tunnel-token <CLOUDFLARE_TUNNEL_TOKEN>
  ```
  In the Cloudflare Zero Trust dashboard, route the public hostname `dev.yourcafe.org` to service `http://127.0.0.1:8090`.

### 2. Deploy Application Files
Copy `pb_hooks/` and `pb_public/` into `/opt/pocketbase/` on each VM and restart PocketBase:
```bash
sudo cp -r pb_hooks pb_public /opt/pocketbase/
sudo chown -R pocketbase:pocketbase /opt/pocketbase
sudo systemctl restart pocketbase
```

### 3. Create Superuser & Seed the Database
1. Open `https://dev.yourcafe.org/_/` (and `https://inventory.yourcafe.org/_/`) in your browser to create the initial PocketBase Superuser account.
2. Run the database schema and 84-item catalog seeder from any machine with Node.js 18+:
   ```bash
   node scripts/seed.mjs \
     --url https://dev.yourcafe.org \
     --email advisor@school.org \
     --password 'YOUR_SUPERUSER_PASSWORD'
   ```
   *(Repeat against `https://inventory.yourcafe.org` once tested on `dev`.)*

### 4. Configure Outbound Email & Automated Backups
In the PocketBase Admin UI (`/_/`):
1. **Settings $\rightarrow$ Mail settings:** Configure your school Google Workspace SMTP relay or transactional mail credentials so the 1:30 PM cron job can email vendor reorder sheets.
2. **Settings $\rightarrow$ Backups:** Enable nightly automated backups (e.g., `0 2 * * *`) connected to a Google Cloud Storage S3-compatible bucket.

---

## Daily Cafe Operations

### Barista Counting Protocol (< 60 Seconds per Zone)
1. **Print Station QR Codes:** Open the web app $\rightarrow$ **Print QR Labels** tab, print the 8 station cards, and tape them inside each storage door (Island Fridge, Coffee Cabinet, Back Fridge, Tea Drawer, Front Shelves, Back Shelves, Storage Closet, Cleaning Cabinet).
2. **Scan & Count:** After closing duties are complete and no customers remain, a barista scans the station QR code on the cafe iPad or phone.
3. **Round Down Rule:** Always count **whole, unopened units only** (e.g., 1 full box of 12 sleeves + 3 loose unopened sleeves + 1 open sleeve = `15`).
4. **Partial Multi-Location Updates:** Items stored in multiple spots (such as `Paper Towels` in `front-shelves` and `storage-closet`) store separate zone balances in `zone_counts` and automatically recalculate `items.total_on_hand` without wiping uncounted shelves.

### Automated 1:30 PM School-Day Order Reports
* Runs Monday–Friday at **1:30 PM** (`America/New_York`).
* **Every school day:** Alerts the advisor immediately if any active item reaches `0`.
* **Scheduled order days (Tue & Thu):** Appends all active items at or below `reorder_point`, grouped by vendor, with suggested order quantities (`par_level - total_on_hand`).
* On `cafe-dev`, all automated emails are automatically prefixed with `[DEV SANDBOX]` so student tests never trigger real purchases.

### DripOS POS CSV Ingestion
Export **All Product Sales (CSV)** and **Modifier Sales (CSV)** from DripOS (**Finance $\rightarrow$ Reports**), open the **DripOS Import** tab in the web app (Advisor login required), and upload the file. Batches are deduplicated via SHA-256 hash so re-uploading a report never double-deducts stock.
