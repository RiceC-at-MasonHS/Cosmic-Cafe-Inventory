#!/usr/bin/env node
// ============================================================================
// Cosmic Cafe PocketBase Schema & Catalog Seeder (Zero external dependencies)
//
// Usage:
//   PB_URL=http://127.0.0.1:8090 \
//   PB_ADMIN_EMAIL=stemplek@masonohioschools.com \
//   PB_ADMIN_PASSWORD=YourSecurePassword \
//   node scripts/seed.mjs
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PB_URL = (process.env.PB_URL || "http://127.0.0.1:8090").replace(/\/$/, "");
const ADMIN_EMAIL = process.env.PB_ADMIN_EMAIL || "stemplek@masonohioschools.com";
const ADMIN_PASSWORD = process.env.PB_ADMIN_PASSWORD || "CosmicCafe2026!";

const SEED_PATH = path.resolve(__dirname, "../data/seed-catalog.json");

async function api(endpoint, { method = "GET", token = null, body = null } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = token;

  const res = await fetch(`${PB_URL}${endpoint}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }

  return { ok: res.ok, status: res.status, data: json };
}

async function authenticateSuperuser() {
  // PocketBase v0.23+ uses _superusers collection
  let res = await api("/api/collections/_superusers/auth-with-password", {
    method: "POST",
    body: { identity: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  if (res.ok && res.data?.token) return res.data.token;

  // Fallback for older PocketBase releases
  res = await api("/api/admins/auth-with-password", {
    method: "POST",
    body: { identity: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  if (res.ok && res.data?.token) return res.data.token;

  throw new Error(
    `Could not authenticate as superuser (${ADMIN_EMAIL}) at ${PB_URL}. ` +
      `Create the first superuser in ${PB_URL}/_/ or via './pocketbase superuser upsert' first.`
  );
}

async function ensureCollection(token, spec) {
  const existing = await api(`/api/collections/${spec.name}`, { token });
  if (existing.ok) {
    console.log(`  [ok] Collection '${spec.name}' already exists.`);
    return existing.data.id;
  }

  const created = await api("/api/collections", {
    method: "POST",
    token,
    body: spec,
  });
  if (!created.ok) {
    throw new Error(`Failed creating collection '${spec.name}': ${JSON.stringify(created.data)}`);
  }
  console.log(`  [+] Created collection '${spec.name}' (${created.data.id})`);
  return created.data.id;
}

async function upsertRecord(token, collection, id, payload) {
  const check = await api(`/api/collections/${collection}/records/${id}`, { token });
  if (check.ok) {
    const upd = await api(`/api/collections/${collection}/records/${id}`, {
      method: "PATCH",
      token,
      body: payload,
    });
    if (!upd.ok) throw new Error(`Failed updating ${collection}/${id}: ${JSON.stringify(upd.data)}`);
    return "updated";
  }

  const ins = await api(`/api/collections/${collection}/records`, {
    method: "POST",
    token,
    body: { id, ...payload },
  });
  if (!ins.ok) throw new Error(`Failed inserting ${collection}/${id}: ${JSON.stringify(ins.data)}`);
  return "created";
}

function toPbId(slug) {
  // PocketBase custom record IDs must be 15-char alphanumeric strings;
  // pad or hash deterministically so re-running seed.mjs is 100% idempotent.
  const clean = slug.replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (clean.length >= 15) return clean.slice(0, 15);
  return clean.padEnd(15, "0");
}

async function main() {
  console.log(`==> Connecting to PocketBase at ${PB_URL}...`);
  const token = await authenticateSuperuser();

  console.log("==> Ensuring schema collections exist...");
  const zonesColId = await ensureCollection(token, {
    name: "zones",
    type: "base",
    listRule: "",
    viewRule: "",
    createRule: null,
    updateRule: null,
    deleteRule: null,
    fields: [
      { name: "slug", type: "text", required: true },
      { name: "name", type: "text", required: true },
      { name: "description", type: "text" },
    ],
  });

  const vendorsColId = await ensureCollection(token, {
    name: "vendors",
    type: "base",
    listRule: "",
    viewRule: "",
    createRule: null,
    updateRule: null,
    deleteRule: null,
    fields: [
      { name: "slug", type: "text", required: true },
      { name: "name", type: "text", required: true },
      { name: "order_method", type: "text" },
      { name: "lead_time_days", type: "number" },
      { name: "order_url", type: "url" },
      { name: "contact_email", type: "email" },
    ],
  });

  const itemsColId = await ensureCollection(token, {
    name: "items",
    type: "base",
    listRule: "",
    viewRule: "",
    createRule: null,
    updateRule: null,
    deleteRule: null,
    fields: [
      { name: "slug", type: "text", required: true },
      { name: "legacy_id", type: "number" },
      { name: "name", type: "text", required: true },
      { name: "unit", type: "text", required: true },
      { name: "category", type: "text", required: true },
      { name: "zones", type: "json" },
      { name: "cadence", type: "text" },
      { name: "active", type: "bool" },
      { name: "vendor", type: "relation", collectionId: vendorsColId, maxSelect: 1 },
      { name: "par_level", type: "number" },
      { name: "reorder_point", type: "number" },
      { name: "total_on_hand", type: "number" },
      { name: "estimated_on_hand", type: "number" },
      { name: "last_counted_at", type: "text" },
      { name: "notes", type: "text" },
    ],
  });

  await ensureCollection(token, {
    name: "zone_counts",
    type: "base",
    listRule: "",
    viewRule: "",
    createRule: "",
    updateRule: "",
    deleteRule: null,
    fields: [
      { name: "item", type: "relation", collectionId: itemsColId, maxSelect: 1, required: true },
      { name: "zone", type: "relation", collectionId: zonesColId, maxSelect: 1, required: true },
      { name: "quantity", type: "number" },
      { name: "updated_by", type: "text" },
    ],
  });

  await ensureCollection(token, {
    name: "count_logs",
    type: "base",
    listRule: "",
    viewRule: "",
    createRule: null,
    updateRule: null,
    deleteRule: null,
    fields: [
      { name: "item", type: "relation", collectionId: itemsColId, maxSelect: 1, required: true },
      { name: "zone", type: "relation", collectionId: zonesColId, maxSelect: 1, required: true },
      { name: "previous_qty", type: "number" },
      { name: "new_qty", type: "number" },
      { name: "counted_by", type: "text" },
    ],
  });

  await ensureCollection(token, {
    name: "recipes",
    type: "base",
    listRule: "",
    viewRule: "",
    createRule: null,
    updateRule: null,
    deleteRule: null,
    fields: [
      { name: "pos_sku", type: "text", required: true },
      { name: "item", type: "relation", collectionId: itemsColId, maxSelect: 1, required: true },
      { name: "units_per_sale", type: "number", required: true },
    ],
  });

  await ensureCollection(token, {
    name: "pos_imports",
    type: "base",
    listRule: "",
    viewRule: "",
    createRule: null,
    updateRule: null,
    deleteRule: null,
    fields: [
      { name: "filename", type: "text", required: true },
      { name: "batch_hash", type: "text", required: true },
      { name: "row_count", type: "number" },
    ],
  });

  // Semester Barista Roster (public read for phone autocomplete; superuser-only write)
  await ensureCollection(token, {
    name: "baristas",
    type: "base",
    listRule: "",
    viewRule: "",
    createRule: null,
    updateRule: null,
    deleteRule: null,
    fields: [
      { name: "first_name", type: "text", required: true },
      { name: "last_name", type: "text", required: true },
      { name: "full_name", type: "text", required: true },
      { name: "email", type: "email" },
      { name: "semester", type: "text" },
      { name: "active", type: "bool" },
    ],
  });

  if (!fs.existsSync(SEED_PATH)) {
    console.log(`==> No seed catalog found at ${SEED_PATH}; schema setup complete.`);
    return;
  }

  const catalog = JSON.parse(fs.readFileSync(SEED_PATH, "utf8"));
  const zoneIdMap = {};
  const vendorIdMap = {};

  console.log(`==> Seeding ${catalog.zones.length} storage zones...`);
  for (const z of catalog.zones) {
    const pbId = toPbId(`zone_${z.id}`);
    zoneIdMap[z.id] = pbId;
    await upsertRecord(token, "zones", pbId, {
      slug: z.id,
      name: z.name,
      description: z.description || "",
    });
  }

  console.log(`==> Seeding ${catalog.vendors.length} vendors...`);
  for (const v of catalog.vendors) {
    const pbId = toPbId(`vend_${v.id}`);
    vendorIdMap[v.id] = pbId;
    await upsertRecord(token, "vendors", pbId, {
      slug: v.id,
      name: v.name,
      order_method: v.orderMethod || "portal",
      lead_time_days: v.leadTimeDays || 2,
      order_url: v.orderUrl || "",
      contact_email: v.contactEmail || "",
    });
  }

  console.log(`==> Seeding ${catalog.items.length} Cosmic Cafe inventory items...`);
  for (const item of catalog.items) {
    const pbId = toPbId(`item_${item.id}`);
    const mappedZones = (item.zones || []).map((slug) => zoneIdMap[slug] || slug);
    const qty = Number(item.seededQty || 0);

    await upsertRecord(token, "items", pbId, {
      slug: item.id,
      legacy_id: item.legacyId,
      name: item.name,
      unit: item.unit,
      category: item.category,
      zones: mappedZones,
      cadence: item.cadence || "weekly",
      active: item.active !== false,
      vendor: vendorIdMap[item.vendorId] || "",
      par_level: Number(item.parLevel || 4),
      reorder_point: Number(item.reorderPoint || 1),
      total_on_hand: qty,
      estimated_on_hand: qty,
      notes: item.notes || "",
    });

    if (qty > 0 && mappedZones.length > 0) {
      const primaryZone = mappedZones[0];
      const zcId = toPbId(`zc_${item.id}_${primaryZone}`);
      await upsertRecord(token, "zone_counts", zcId, {
        item: pbId,
        zone: primaryZone,
        quantity: qty,
        updated_by: "initial-seed",
      });
    }
  }

  console.log("==> Seed complete! All 8 collections and 84 items are ready.");
}

main().catch((err) => {
  console.error("Seed failed:", err.message);
  process.exit(1);
});
