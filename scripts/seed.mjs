#!/usr/bin/env node
/**
 * Cosmic Cafe PocketBase Schema & 84-Item Catalog Seeder
 *
 * Idempotently creates/updates all PocketBase collections and populates
 * zones, vendors, items, and initial zone_counts from data/seed-catalog.json.
 *
 * Works identically against:
 *   - DEV (routed via cloudflared):  https://dev.yourcafe.org
 *   - PROD (routed via Caddy):       https://inventory.yourcafe.org
 *
 * Usage:
 *   node scripts/seed.mjs --url https://dev.yourcafe.org --email admin@school.org --password "..."
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CATALOG_PATH = path.resolve(__dirname, "../data/seed-catalog.json");

function parseArgs(argv) {
  const args = { catalog: DEFAULT_CATALOG_PATH };
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i];
    const val = argv[i + 1];
    if (key === "--url") { args.url = val?.replace(/\/+$/, ""); i++; }
    else if (key === "--email") { args.email = val; i++; }
    else if (key === "--password") { args.password = val; i++; }
    else if (key === "--catalog") { args.catalog = path.resolve(val); i++; }
  }
  if (!args.url || !args.email || !args.password) {
    console.error("Usage: node scripts/seed.mjs --url <PB_URL> --email <ADMIN_EMAIL> --password <ADMIN_PASS>");
    process.exit(1);
  }
  return args;
}

async function api(baseUrl, endpoint, { method = "GET", token = "", body = null } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = token;

  const res = await fetch(`${baseUrl}${endpoint}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : null,
  });

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }

  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} ${method} ${endpoint}: ${JSON.stringify(data)}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function ensureCollection(baseUrl, token, existingMap, definition) {
  const existing = existingMap.get(definition.name);
  if (!existing) {
    const created = await api(baseUrl, "/api/collections", {
      method: "POST",
      token,
      body: definition,
    });
    existingMap.set(definition.name, created);
    console.log(`  [+] Created collection: ${definition.name} (${created.id})`);
    return created;
  } else {
    // Preserve existing system id field config while updating fields/rules
    const updated = await api(baseUrl, `/api/collections/${existing.id}`, {
      method: "PATCH",
      token,
      body: {
        fields: definition.fields,
        listRule: definition.listRule,
        viewRule: definition.viewRule,
        createRule: definition.createRule,
        updateRule: definition.updateRule,
        deleteRule: definition.deleteRule,
      },
    });
    existingMap.set(definition.name, updated);
    console.log(`  [=] Verified collection: ${definition.name} (${updated.id})`);
    return updated;
  }
}

async function upsertRecord(baseUrl, token, collectionName, recordData) {
  try {
    await api(baseUrl, `/api/collections/${collectionName}/records/${recordData.id}`, {
      method: "PATCH",
      token,
      body: recordData,
    });
    return "updated";
  } catch (err) {
    if (err.status === 404) {
      await api(baseUrl, `/api/collections/${collectionName}/records`, {
        method: "POST",
        token,
        body: recordData,
      });
      return "created";
    }
    throw err;
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const catalog = JSON.parse(fs.readFileSync(args.catalog, "utf8"));

  console.log(`==> Authenticating with PocketBase at ${args.url}...`);
  const auth = await api(args.url, "/api/collections/_superusers/auth-with-password", {
    method: "POST",
    body: { identity: args.email, password: args.password },
  });
  const token = auth.token;

  console.log("==> Fetching existing collections...");
  const collectionsList = await api(args.url, "/api/collections?perPage=200", { token });
  const existingMap = new Map((collectionsList.items || []).map((c) => [c.name, c]));

  const slugIdField = {
    name: "id",
    type: "text",
    primaryKey: true,
    required: true,
    pattern: "^[a-z0-9-]{2,80}$",
  };

  console.log("==> Configuring collections & security rules...");

  // 1. zones (Public read, superuser write)
  const zonesCol = await ensureCollection(args.url, token, existingMap, {
    name: "zones",
    type: "base",
    listRule: "",
    viewRule: "",
    createRule: null,
    updateRule: null,
    deleteRule: null,
    fields: [
      slugIdField,
      { name: "name", type: "text", required: true },
      { name: "description", type: "text" },
    ],
  });

  // 2. vendors (Public read, superuser write)
  const vendorsCol = await ensureCollection(args.url, token, existingMap, {
    name: "vendors",
    type: "base",
    listRule: "",
    viewRule: "",
    createRule: null,
    updateRule: null,
    deleteRule: null,
    fields: [
      slugIdField,
      { name: "name", type: "text", required: true },
      { name: "order_method", type: "text" },
      { name: "lead_time_days", type: "number" },
      { name: "order_days", type: "json" },
      { name: "contact_email", type: "text" },
      { name: "order_url", type: "text" },
    ],
  });

  // 3. items (Public read; superuser write or server hook recalculation)
  const itemsCol = await ensureCollection(args.url, token, existingMap, {
    name: "items",
    type: "base",
    listRule: "",
    viewRule: "",
    createRule: null,
    updateRule: null,
    deleteRule: null,
    fields: [
      slugIdField,
      { name: "legacy_id", type: "number" },
      { name: "name", type: "text", required: true },
      { name: "unit", type: "text", required: true },
      { name: "category", type: "text", required: true },
      { name: "zones", type: "relation", collectionId: zonesCol.id, maxSelect: 10 },
      { name: "cadence", type: "text" },
      { name: "active", type: "bool" },
      { name: "vendor", type: "relation", collectionId: vendorsCol.id, maxSelect: 1 },
      { name: "par_level", type: "number" },
      { name: "reorder_point", type: "number" },
      { name: "total_on_hand", type: "number" },
      { name: "estimated_on_hand", type: "number" },
      { name: "last_counted_at", type: "text" },
      { name: "notes", type: "text" },
    ],
  });

  // 4. zone_counts (Baristas can read/create/update zone balances; delete locked)
  await ensureCollection(args.url, token, existingMap, {
    name: "zone_counts",
    type: "base",
    listRule: "",
    viewRule: "",
    createRule: "",
    updateRule: "",
    deleteRule: null,
    fields: [
      slugIdField,
      { name: "item", type: "relation", collectionId: itemsCol.id, maxSelect: 1, required: true },
      { name: "zone", type: "relation", collectionId: zonesCol.id, maxSelect: 1, required: true },
      { name: "quantity", type: "number", min: 0 },
      { name: "updated_by", type: "text" },
      { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
    ],
  });

  // 5. count_logs (Public read for barista leaderboard; server-hook-only writes)
  await ensureCollection(args.url, token, existingMap, {
    name: "count_logs",
    type: "base",
    listRule: "",
    viewRule: "",
    createRule: null,
    updateRule: null,
    deleteRule: null,
    fields: [
      { name: "item", type: "relation", collectionId: itemsCol.id, maxSelect: 1, required: true },
      { name: "zone", type: "relation", collectionId: zonesCol.id, maxSelect: 1, required: true },
      { name: "previous_qty", type: "number" },
      { name: "new_qty", type: "number" },
      { name: "counted_by", type: "text" },
      { name: "created", type: "autodate", onCreate: true, onUpdate: false },
    ],
  });

  // 6. recipes (Maps DripOS SKUs/modifiers to inventory depletion; superuser only)
  await ensureCollection(args.url, token, existingMap, {
    name: "recipes",
    type: "base",
    listRule: null,
    viewRule: null,
    createRule: null,
    updateRule: null,
    deleteRule: null,
    fields: [
      { name: "pos_sku", type: "text", required: true },
      { name: "item", type: "relation", collectionId: itemsCol.id, maxSelect: 1, required: true },
      { name: "units_per_sale", type: "number", required: true },
    ],
  });

  // 7. pos_imports (Deduplicates DripOS CSV uploads by SHA-256 hash)
  await ensureCollection(args.url, token, existingMap, {
    name: "pos_imports",
    type: "base",
    listRule: null,
    viewRule: null,
    createRule: null,
    updateRule: null,
    deleteRule: null,
    fields: [
      { name: "filename", type: "text", required: true },
      { name: "batch_hash", type: "text", required: true },
      { name: "row_count", type: "number" },
      { name: "created", type: "autodate", onCreate: true, onUpdate: false },
    ],
  });

  console.log(`==> Seeding ${catalog.zones.length} storage zones...`);
  for (const z of catalog.zones) {
    await upsertRecord(args.url, token, "zones", z);
  }

  console.log(`==> Seeding ${catalog.vendors.length} vendors...`);
  for (const v of catalog.vendors) {
    await upsertRecord(args.url, token, "vendors", {
      id: v.id,
      name: v.name,
      order_method: v.orderMethod,
      lead_time_days: v.leadTimeDays,
      order_days: v.orderDays,
      contact_email: v.contactEmail || "",
      order_url: v.orderUrl || "",
    });
  }

  console.log(`==> Seeding ${catalog.items.length} inventory items & initial zone balances...`);
  let createdItems = 0;
  let updatedItems = 0;

  for (const item of catalog.items) {
    const status = await upsertRecord(args.url, token, "items", {
      id: item.id,
      legacy_id: item.legacyId,
      name: item.name,
      unit: item.unit,
      category: item.category,
      zones: item.zones,
      cadence: item.cadence,
      active: item.active,
      vendor: item.vendorId,
      par_level: item.parLevel,
      reorder_point: item.reorderPoint,
      total_on_hand: item.seededQty,
      estimated_on_hand: item.seededQty,
      notes: item.notes || "",
    });
    if (status === "created") createdItems++;
    else updatedItems++;

    // Initialize zone_counts records (primary zone gets seededQty; secondary zones start at 0 if missing)
    for (let idx = 0; idx < item.zones.length; idx++) {
      const zoneId = item.zones[idx];
      const zcId = `${item.id}--${zoneId}`;
      try {
        await api(args.url, `/api/collections/zone_counts/records/${zcId}`, { token });
      } catch (err) {
        if (err.status === 404) {
          await api(args.url, "/api/collections/zone_counts/records", {
            method: "POST",
            token,
            body: {
              id: zcId,
              item: item.id,
              zone: zoneId,
              quantity: idx === 0 ? item.seededQty : 0,
              updated_by: "initial-seed",
            },
          });
        }
      }
    }
  }

  console.log(`Done! Items: ${createdItems} created, ${updatedItems} updated.`);
}

main().catch((err) => {
  console.error("Seeder failed:", err);
  process.exit(1);
});
