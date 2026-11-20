/// <reference path="../pb_data/types.d.ts" />

// ============================================================================
// Cosmic Cafe Inventory Hooks (pb_hooks/cosmic_cafe.pb.js)
//
// Networking awareness:
//   - APP_ENV=prod : Served via Caddy + Static IP (no cloudflared).
//   - APP_ENV=dev  : Served via cloudflared tunnel (no fixed IP). Outbound
//                    emails are prefixed with [DEV SANDBOX] to prevent
//                    accidental vendor orders during student testing.
// ============================================================================

const APP_ENV = ($os.getenv("APP_ENV") || "dev").toLowerCase();
const IS_PROD = APP_ENV === "prod";
const ORDER_RECIPIENT = $os.getenv("ORDER_ALERT_EMAIL") || "stemplek@masonohioschools.com";
const SCHEDULED_ORDER_DAYS = [2, 4]; // 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri

onBootstrap((e) => {
  e.next();
  const ingressNote = IS_PROD
    ? "Caddy TLS + Static IP (no cloudflared)"
    : "cloudflared outbound tunnel (no fixed IP)";
  $app.logger().info(`Cosmic Cafe booted in [${APP_ENV.toUpperCase()}] mode | Ingress: ${ingressNote}`);
});

// ----------------------------------------------------------------------------
// 1. Multi-Location Auto-Aggregator
//    When a barista submits a count for ONE zone (e.g. "storage-closet"),
//    recalculate total_on_hand across ALL zones for that item without wiping
//    other zones' counts, and append an immutable audit row to count_logs.
// ----------------------------------------------------------------------------
function recalculateItemTotal(itemId, zoneId, previousQty, newQty, countedBy) {
  const zoneRecords = $app.findRecordsByFilter(
    "zone_counts",
    "item = {:itemId}",
    "",
    50,
    0,
    { itemId }
  );

  let total = 0;
  for (const zr of zoneRecords) {
    total += zr.getFloat("quantity");
  }

  const item = $app.findRecordById("items", itemId);
  item.set("total_on_hand", total);
  item.set("estimated_on_hand", total); // Reset POS estimate to verified physical count
  item.set("last_counted_at", new Date().toISOString());
  $app.save(item);

  // Write audit log for historical graphs & barista leaderboard
  const logsCollection = $app.findCollectionByNameOrId("count_logs");
  const logEntry = new Record(logsCollection);
  logEntry.set("item", itemId);
  logEntry.set("zone", zoneId);
  logEntry.set("previous_qty", previousQty);
  logEntry.set("new_qty", newQty);
  logEntry.set("counted_by", countedBy || "cafe-ipad");
  $app.save(logEntry);
}

onRecordAfterCreateSuccess((e) => {
  e.next();
  recalculateItemTotal(
    e.record.getString("item"),
    e.record.getString("zone"),
    0,
    e.record.getFloat("quantity"),
    e.record.getString("updated_by")
  );
}, "zone_counts");

onRecordAfterUpdateSuccess((e) => {
  e.next();
  const prev = e.record.original().getFloat("quantity");
  const curr = e.record.getFloat("quantity");
  if (prev === curr) return;

  recalculateItemTotal(
    e.record.getString("item"),
    e.record.getString("zone"),
    prev,
    curr,
    e.record.getString("updated_by")
  );
}, "zone_counts");

// ----------------------------------------------------------------------------
// 2. Consolidated 1:30 PM School-Day Order & Zero-Stock Runner
//    Runs Mon-Fri at 1:30 PM (server local timezone = America/New_York).
//    - Every school day: flags any active item that hit 0.
//    - Scheduled order days (Tue/Thu): appends all active items <= reorder_point,
//      grouped by vendor, with suggested order quantities to reach par_level.
// ----------------------------------------------------------------------------
cronAdd("cosmic_1330_order_digest", "30 13 * * 1-5", () => {
  const todayDow = new Date().getDay();
  const isScheduledOrderDay = SCHEDULED_ORDER_DAYS.includes(todayDow);

  const activeItems = $app.findRecordsByFilter(
    "items",
    "active = true",
    "category,name",
    500,
    0
  );

  const zeroItems = [];
  const vendorBuckets = {};

  for (const item of activeItems) {
    const onHand = item.getFloat("total_on_hand");
    const reorderPt = item.getFloat("reorder_point");
    const par = item.getFloat("par_level");
    const vendorId = item.getString("vendor") || "unassigned";

    const isZero = onHand <= 0;
    const isLow = onHand <= reorderPt;

    if (isZero) {
      zeroItems.push(item);
    }

    if (isZero || (isScheduledOrderDay && isLow)) {
      if (!vendorBuckets[vendorId]) vendorBuckets[vendorId] = [];
      vendorBuckets[vendorId].push({
        name: item.getString("name"),
        unit: item.getString("unit"),
        onHand,
        par,
        orderQty: Math.max(1, Math.ceil(par - onHand)),
        urgent: isZero,
      });
    }
  }

  // Stay silent on non-order days unless at least one item hit zero
  if (Object.keys(vendorBuckets).length === 0) {
    $app.logger().info("1:30 PM check: Stock healthy, no alert sent.");
    return;
  }

  let html = `<h2>Cosmic Cafe Inventory Order Report</h2>`;
  if (!IS_PROD) {
    html += `<p style="color:#b45309;"><strong>[DEV SANDBOX via cloudflared]</strong> Test alert — do not place vendor orders from this email.</p>`;
  }

  if (zeroItems.length > 0) {
    html += `<p style="color:#b91c1c;"><strong>Out-of-Stock Alert (${zeroItems.length} item(s) at 0):</strong> ${zeroItems
      .map((i) => i.getString("name"))
      .join(", ")}</p>`;
  }

  for (const [vendorId, lines] of Object.entries(vendorBuckets)) {
    let vendorName = vendorId;
    try {
      if (vendorId !== "unassigned") {
        vendorName = $app.findRecordById("vendors", vendorId).getString("name");
      }
    } catch (_) {}

    html += `<h3>Vendor: ${vendorName}</h3>
      <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;">
        <tr><th>Item</th><th>On Hand</th><th>Par</th><th>Suggested Order</th></tr>`;
    for (const line of lines) {
      const badge = line.urgent ? ` <strong style="color:#b91c1c;">[ZERO]</strong>` : "";
      html += `<tr>
        <td>${line.name}${badge}</td>
        <td>${line.onHand} ${line.unit}</td>
        <td>${line.par} ${line.unit}</td>
        <td><strong>${line.orderQty} ${line.unit}</strong></td>
      </tr>`;
    }
    html += `</table>`;
  }

  const envPrefix = IS_PROD ? "" : "[DEV SANDBOX] ";
  const subjectType = isScheduledOrderDay
    ? "Scheduled Reorder Sheet"
    : `Urgent Zero-Stock Alert (${zeroItems.length} out)`;

  const message = new MailerMessage({
    from: {
      address: $app.settings().meta.senderAddress,
      name: $app.settings().meta.senderName || "Cosmic Cafe Inventory",
    },
    to: [{ address: ORDER_RECIPIENT }],
    subject: `${envPrefix}Cosmic Cafe — ${subjectType}`,
    html,
  });

  $app.newMailClient().send(message);
  $app.logger().info(`1:30 PM order digest sent (${subjectType})`);
});

// ----------------------------------------------------------------------------
// 3. DripOS CSV Ingestion Endpoint
//    POST /api/cosmic/import-dripos
//    Body: { "filename": "product-sales.csv", "rows": [{ "sku": "16oz-latte", "qty": 42 }] }
//    Deduplicates batches via SHA-256 hash so re-uploading a CSV never double-deducts.
// ----------------------------------------------------------------------------
routerAdd(
  "POST",
  "/api/cosmic/import-dripos",
  (e) => {
    const body = e.requestInfo().body;
    const rows = body.rows || [];
    const filename = body.filename || "dripos-export.csv";

    if (!Array.isArray(rows) || rows.length === 0) {
      return e.json(400, { error: "Payload must include a non-empty 'rows' array." });
    }

    const batchHash = $security.sha256(JSON.stringify({ filename, rows }));
    const existing = $app.findRecordsByFilter("pos_imports", "batch_hash = {:hash}", "", 1, 0, {
      hash: batchHash,
    });
    if (existing.length > 0) {
      return e.json(409, { error: "This exact DripOS CSV batch has already been imported.", batchHash });
    }

    let deductionsApplied = 0;
    for (const row of rows) {
      const recipes = $app.findRecordsByFilter("recipes", "pos_sku = {:sku}", "", 20, 0, {
        sku: String(row.sku || "").trim(),
      });
      for (const recipe of recipes) {
        const item = $app.findRecordById("items", recipe.getString("item"));
        const used = Number(row.qty || 0) * recipe.getFloat("units_per_sale");
        const nextEst = Math.max(0, item.getFloat("estimated_on_hand") - used);
        item.set("estimated_on_hand", Number(nextEst.toFixed(3)));
        $app.save(item);
        deductionsApplied++;
      }
    }

    const importsCol = $app.findCollectionByNameOrId("pos_imports");
    const imp = new Record(importsCol);
    imp.set("filename", filename);
    imp.set("batch_hash", batchHash);
    imp.set("row_count", rows.length);
    $app.save(imp);

    return e.json(200, { status: "imported", batchHash, deductionsApplied });
  },
  $apis.requireSuperuserAuth()
);
