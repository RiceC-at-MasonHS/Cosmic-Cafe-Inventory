# Contributing to Cosmic Cafe Inventory

Welcome! This project powers daily operations for the **Cosmic Cafe** while serving as a live learning lab for our school's Computer Science, Cybersecurity, and Business Management students.

Because real baristas and advisors rely on production every school morning, please follow the workflow and safety guidelines below.

---

## 1. Golden Rules

1. **Never develop or test against Production (`inventory.yourcafe.org`).**
   All code changes, API experiments, and CSV upload tests happen on the **Dev Sandbox (`dev.yourcafe.org`)** or on a local PocketBase instance on your laptop.
2. **Understand how `dev` and `prod` differ in networking:**
   * **`dev` (`cafe-dev`)** has **no fixed public IP** and no open web ports. Public traffic reaches it exclusively through an outbound **`cloudflared` tunnel** (`cloudflared.service` $\rightarrow$ `http://127.0.0.1:8090`). Do not install Caddy or open ports `80`/`443` on `cafe-dev`.
   * **`prod` (`cafe-prod`)** runs on a fixed IP behind **Caddy** for direct TLS and **does not use `cloudflared`**.
3. **Never commit secrets or real student/staff passwords.**
   Keep API tokens, superuser passwords, and Cloudflare tunnel tokens out of Git.

---

## 2. Local Development Setup

You can run the full stack locally in under two minutes without touching either cloud VM:

1. Download the PocketBase binary matching your OS into a local `.local-pb/` folder (ignored by Git).
2. Start PocketBase with our hooks and frontend:
   ```bash
   APP_ENV=dev ./.local-pb/pocketbase serve \
     --hooksDir=./pb_hooks \
     --publicDir=./pb_public
   ```
3. Open `http://127.0.0.1:8090/_/` to create a local superuser, then seed your local database:
   ```bash
   node scripts/seed.mjs \
     --url http://127.0.0.1:8090 \
     --email dev@local.test \
     --password localdevpassword123
   ```
4. Visit `http://127.0.0.1:8090/` to test the Barista Counter, Live Stock view, and DripOS importer.

---

## 3. Deploying & Testing on `cafe-dev`

When your change is ready to test in a live cloud environment:

1. Push your feature branch to GitHub and open a Pull Request.
2. On `cafe-dev` (via SSH or your team's deploy script), pull your branch into `/opt/pocketbase/` and restart PocketBase:
   ```bash
   sudo systemctl restart pocketbase
   ```
3. Verify the Cloudflare Tunnel (`sudo systemctl status cloudflared`) is active and test your changes at `https://dev.yourcafe.org`.
4. **Testing Email Hooks:** Any cron or order alert triggered on `cafe-dev` automatically adds `[DEV SANDBOX]` to the subject line. Confirm with your advisor before triggering test emails.

---

## 4. Cybersecurity Student Guidelines

Students with authorized SSH/admin access to `cafe-dev` are encouraged to audit and harden the sandbox within these boundaries:

* **In Scope (`cafe-dev` only):**
  * Inspecting `systemd` service sandboxing (`NoNewPrivileges`, `ProtectSystem`, `ReadWritePaths`).
  * Auditing PocketBase collection API rules (`listRule`, `createRule`, `updateRule`) to ensure baristas cannot alter `par_level` or forge `count_logs`.
  * Verifying Cloudflare Zero Trust tunnel posture and confirming zero listening ports on external interfaces (`ss -tulpn`).
* **Out of Scope:**
  * Any scanning, load testing, or unauthorized access attempts against `cafe-prod` (`inventory.yourcafe.org`), school district networks, or third-party infrastructure.
  * Disabling `cloudflared.service` without coordinating with your class team (doing so takes `dev.yourcafe.org` offline for everyone).

---

## 5. Updating the Item Catalog

If the cafe adds a new syrup, seasonal drink, or storage zone:
1. Update `data/seed-catalog.json` with a lowercase hyphenated `id` (e.g., `pistachio-syrup`).
2. Re-run `node scripts/seed.mjs` against `dev` first—the script is **idempotent** and will create new items or update metadata without erasing existing zone counts.
3. Submit a Pull Request so the advisor can promote the catalog update to `prod`.
