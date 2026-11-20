# Cosmic Cafe Inventory — Two-Box Infrastructure

## Environment Matrix

| Property | Production (`cafe-prod`) | Dev / Student Sandbox (`cafe-dev`) |
| :--- | :--- | :--- |
| **GCP Machine Type** | `e2-small` (2 vCPU, 2 GB RAM) | `e2-micro` (Always-Free tier, 1 GB RAM) |
| **GCP Region & Disk** | Any US region, 30 GB Balanced/Standard | `us-central1` / `us-east1` / `us-west1`, 30 GB **Standard** disk (Always-Free requirement) |
| **Public IPv4** | **Static External IP** (~$3.65/mo) | **None / Ephemeral** ($0/mo — IP changes on reboot) |
| **GCP Firewall Inbound** | Allow TCP `80, 443` (Public); TCP `22` (Teacher IP only) | **Deny all public web traffic** (`80, 443` closed); TCP `22` (Classroom/VPN) |
| **Ingress / TLS** | **Caddy** reverse proxy (`:443` -> `127.0.0.1:8090`) | **`cloudflared` daemon** (outbound-only tunnel -> `http://127.0.0.1:8090`) |
| **Uses `cloudflared`?** | **NO** — direct TLS avoids tunnel daemon dependency | **YES** — required because `dev` has no fixed IP or open ports |
| **Domain** | `https://inventory.yourcafe.org` | `https://dev.yourcafe.org` |
| **Email Hook Behavior** | Sends live reorder alerts to advisor/manager | Prefixes subjects with `[DEV SANDBOX]` so student tests never trigger real orders |

## Security Notes for Cybersecurity Students (`cafe-dev`)
1. **Zero-Trust Ingress:** `cafe-dev` has no open HTTP/HTTPS ports on its VPC firewall. All public traffic enters through Cloudflare's edge and traverses an outbound-initiated QUIC/HTTP2 tunnel (`cloudflared.service`).
2. **Process Isolation:** PocketBase runs as an unprivileged `pocketbase` system user (`NoNewPrivileges=true`, `ProtectSystem=strict`) listening strictly on `127.0.0.1:8090` so it cannot be reached bypassing the proxy/tunnel.
3. **Production Guardrails:** Students have SSH/admin access on `cafe-dev` only. `cafe-prod` receives updates exclusively via tagged Git releases or teacher-approved migrations.
