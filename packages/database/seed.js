#!/usr/bin/env node
/**
 * Idempotent development seed: demo users, a product catalog with stock, and
 * a handful of reviews. Safe to run repeatedly — everything upserts on a
 * natural key.
 *
 *   node packages/database/seed.js
 */
import bcrypt from "bcryptjs";
import pg from "pg";

const { Client } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

if (process.env.NODE_ENV === "production" && process.env.ALLOW_SEED !== "yes") {
  console.error("Refusing to seed in production. Set ALLOW_SEED=yes to override.");
  process.exit(1);
}

const USERS = [
  {
    username: "demo",
    email: "demo@example.com",
    password: "Password123!",
    first_name: "Demo",
    last_name: "Customer",
    role: "customer",
  },
  {
    username: "admin",
    email: "admin@example.com",
    password: "Admin123!Pass",
    first_name: "Site",
    last_name: "Administrator",
    role: "admin",
  },
];

const PRODUCTS = [
  {
    sku: "TSHIRT-BLK-M",
    name: "Essential Cotton T-Shirt",
    description:
      "Heavyweight 240gsm organic cotton tee with a relaxed fit and reinforced collar. Pre-shrunk and garment-dyed for a soft hand feel that survives the wash.",
    category: "Apparel",
    brand: "Northwind",
    price_cents: 2499,
    image_url: "https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?w=800&q=80",
    attributes: { gender: "unisex", size: "M", color: "Black", material: "Organic cotton" },
    stock: 120,
  },
  {
    sku: "HOODIE-GRY-L",
    name: "Brushed Fleece Hoodie",
    description:
      "Mid-weight brushed fleece hoodie with a double-layer hood, kangaroo pocket and ribbed cuffs. Cut for layering over a tee without bulk.",
    category: "Apparel",
    brand: "Northwind",
    price_cents: 5999,
    image_url: "https://images.unsplash.com/photo-1556821840-3a63f95609a7?w=800&q=80",
    attributes: { gender: "unisex", size: "L", color: "Heather Grey", material: "Cotton blend" },
    stock: 64,
  },
  {
    sku: "SNEAK-WHT-42",
    name: "Court Low Leather Sneaker",
    description:
      "Full-grain leather sneaker on a vulcanised rubber cupsole. Padded collar, cotton laces and a removable moulded footbed.",
    category: "Footwear",
    brand: "Halden",
    price_cents: 11900,
    image_url: "https://images.unsplash.com/photo-1549298916-b41d501d3772?w=800&q=80",
    attributes: { gender: "unisex", size: "42", color: "White", material: "Leather" },
    stock: 38,
  },
  {
    sku: "HEADPH-ANC-01",
    name: "Aurora ANC Over-Ear Headphones",
    description:
      "Hybrid active noise cancelling with 40mm dynamic drivers, multipoint Bluetooth 5.3 and USB-C fast charge. Memory-foam earcups rated for all-day wear.",
    category: "Electronics",
    brand: "Aurora Audio",
    price_cents: 24900,
    image_url: "https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=800&q=80",
    attributes: { color: "Midnight", battery_life_hours: 45, connectivity: "Bluetooth 5.3" },
    stock: 25,
  },
  {
    sku: "WATCH-FIT-02",
    name: "Pulse Fitness Watch",
    description:
      "1.4in AMOLED fitness watch with continuous heart-rate, SpO2, built-in GPS and 5ATM water resistance. Tracks 90+ workout modes.",
    category: "Electronics",
    brand: "Pulse",
    price_cents: 17900,
    image_url: "https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=800&q=80",
    attributes: { color: "Graphite", battery_life_hours: 168, resolution: "454x454" },
    stock: 42,
  },
  {
    sku: "MONITOR-27-4K",
    name: 'Clarity 27" 4K IPS Monitor',
    description:
      "27-inch 3840x2160 IPS panel covering 99% sRGB, with 90W USB-C power delivery, a built-in KVM and a fully adjustable stand.",
    category: "Electronics",
    brand: "Clarity",
    price_cents: 42900,
    image_url: "https://images.unsplash.com/photo-1527443224154-c4a3942d3acf?w=800&q=80",
    attributes: { resolution: "3840x2160", panel: "IPS", refresh_rate_hz: 60 },
    stock: 15,
  },
  {
    sku: "BACKPK-30L",
    name: "Transit 30L Commuter Backpack",
    description:
      "Weather-resistant 30 litre commuter pack with a padded 16in laptop sleeve, luggage pass-through and a clamshell main compartment.",
    category: "Accessories",
    brand: "Transit",
    price_cents: 8900,
    image_url: "https://images.unsplash.com/photo-1553062407-98eeb64c6a62?w=800&q=80",
    attributes: { color: "Olive", capacity_litres: 30, material: "Recycled nylon" },
    stock: 55,
  },
  {
    sku: "MUG-CER-350",
    name: "Stoneware Coffee Mug 350ml",
    description:
      "Hand-glazed stoneware mug with a reactive finish, so no two are identical. Dishwasher and microwave safe.",
    category: "Home",
    brand: "Kiln & Co",
    price_cents: 1650,
    image_url: "https://images.unsplash.com/photo-1514228742587-6b1558fcca3d?w=800&q=80",
    attributes: { color: "Sand", capacity_ml: 350, material: "Stoneware" },
    stock: 200,
  },
  {
    sku: "DESK-LAMP-LED",
    name: "Arc LED Desk Lamp",
    description:
      "Dimmable LED desk lamp with five colour temperatures, a 90+ CRI panel and a USB-A charging port in the base.",
    category: "Home",
    brand: "Arc",
    price_cents: 5490,
    image_url: "https://images.unsplash.com/photo-1507473885765-e6ed057f782c?w=800&q=80",
    attributes: { color: "White", power_watts: 12, cri: 90 },
    stock: 3, // deliberately low so the low-stock UI path is exercised
  },
  {
    sku: "KEYB-MECH-87",
    name: "Tenkeyless Mechanical Keyboard",
    description:
      "87-key hot-swappable mechanical keyboard with PBT double-shot caps, a gasket mount and per-key RGB. Ships with tactile brown switches.",
    category: "Electronics",
    brand: "Keyforge",
    price_cents: 13900,
    image_url: "https://images.unsplash.com/photo-1587829741301-dc798b83add3?w=800&q=80",
    attributes: { color: "Black", layout: "TKL", switch_type: "Tactile" },
    stock: 0, // deliberately out of stock
  },
  {
    sku: "JEANS-SLM-32",
    name: "Slim Fit Stretch Jeans",
    description:
      "12oz stretch denim in a slim-straight leg with a mid rise. Enough give to cycle in, enough structure to hold its shape.",
    category: "Apparel",
    brand: "Northwind",
    price_cents: 7900,
    image_url: "https://images.unsplash.com/photo-1542272604-787c3835535d?w=800&q=80",
    attributes: { gender: "men", size: "32", color: "Indigo", material: "Stretch denim" },
    stock: 47,
  },
  {
    sku: "BOTTLE-INS-750",
    name: "Insulated Water Bottle 750ml",
    description:
      "Double-walled vacuum-insulated stainless bottle. Keeps drinks cold for 24 hours or hot for 12, with a leakproof lid.",
    category: "Accessories",
    brand: "Transit",
    price_cents: 3200,
    image_url: "https://images.unsplash.com/photo-1602143407151-7111542de6e8?w=800&q=80",
    attributes: { color: "Steel", capacity_ml: 750, material: "Stainless steel" },
    stock: 88,
  },
];

const REVIEWS = [
  {
    sku: "HEADPH-ANC-01",
    rating: 5,
    title: "Genuinely quiet",
    body: "The ANC handles aircraft cabin noise better than headphones costing twice as much. Battery claim is accurate.",
  },
  {
    sku: "HEADPH-ANC-01",
    rating: 4,
    title: "Great, slightly heavy",
    body: "Sound is excellent and multipoint pairing just works. They do get warm after about three hours.",
  },
  {
    sku: "TSHIRT-BLK-M",
    rating: 5,
    title: "Holds its shape",
    body: "Ten washes in and the collar has not stretched at all. Buying more.",
  },
  {
    sku: "SNEAK-WHT-42",
    rating: 4,
    title: "Comfortable out of the box",
    body: "No break-in period needed. The leather creases quickly but that suits the style.",
  },
  {
    sku: "MONITOR-27-4K",
    rating: 5,
    title: "The KVM sells it",
    body: "One cable to the laptop, and the built-in KVM means one keyboard and mouse for both machines.",
  },
  {
    sku: "DESK-LAMP-LED",
    rating: 3,
    title: "Good light, wobbly arm",
    body: "Light quality is genuinely excellent but the arm does not hold position at full extension.",
  },
];

async function main() {
  const ssl =
    (process.env.PGSSLMODE ?? "disable") === "disable"
      ? false
      : { rejectUnauthorized: process.env.PGSSLMODE !== "no-verify" };

  const client = new Client({ connectionString: DATABASE_URL, ssl });
  await client.connect();

  try {
    await client.query("BEGIN");

    // --- users -------------------------------------------------------
    const userIds = {};
    for (const user of USERS) {
      const passwordHash = await bcrypt.hash(user.password, 10);
      const { rows } = await client.query(
        `INSERT INTO users (username, email, password_hash, first_name, last_name, role)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (email) DO UPDATE
           SET password_hash = EXCLUDED.password_hash,
               first_name    = EXCLUDED.first_name,
               last_name     = EXCLUDED.last_name,
               role          = EXCLUDED.role
         RETURNING user_id`,
        [user.username, user.email, passwordHash, user.first_name, user.last_name, user.role],
      );
      userIds[user.username] = rows[0].user_id;
    }
    console.log(`  users:    ${USERS.length}`);

    // --- default address for the demo user ---------------------------
    await client.query(
      `INSERT INTO addresses (user_id, address_type, recipient_name, address_line1,
                              city, country, zip, is_default)
       VALUES ($1, 'home', 'Demo Customer', 'Musterstraße 12', 'Berlin', 'Germany', '10115', TRUE)
       ON CONFLICT DO NOTHING`,
      [userIds.demo],
    );

    // --- products + inventory ----------------------------------------
    const productIds = {};
    for (const product of PRODUCTS) {
      const { rows } = await client.query(
        `INSERT INTO products (sku, name, description, category, brand, price_cents, image_url, attributes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (sku) DO UPDATE
           SET name        = EXCLUDED.name,
               description = EXCLUDED.description,
               category    = EXCLUDED.category,
               brand       = EXCLUDED.brand,
               price_cents = EXCLUDED.price_cents,
               image_url   = EXCLUDED.image_url,
               attributes  = EXCLUDED.attributes
         RETURNING product_id`,
        [
          product.sku,
          product.name,
          product.description,
          product.category,
          product.brand,
          product.price_cents,
          product.image_url,
          JSON.stringify(product.attributes),
        ],
      );
      const productId = rows[0].product_id;
      productIds[product.sku] = productId;

      await client.query(
        `INSERT INTO inventory (product_id, available)
         VALUES ($1, $2)
         ON CONFLICT (product_id) DO UPDATE SET available = EXCLUDED.available`,
        [productId, product.stock],
      );

      // Queue the catalog document for the Elasticsearch indexer.
      await client.query(
        `INSERT INTO catalog_outbox (product_id, operation, payload)
         VALUES ($1, 'upsert', NULL)`,
        [productId],
      );
    }
    console.log(`  products: ${PRODUCTS.length}`);

    // --- reviews ------------------------------------------------------
    let reviewCount = 0;
    for (const [index, review] of REVIEWS.entries()) {
      // Alternate authors so the unique (product_id, user_id) constraint holds.
      const author = index % 2 === 0 ? userIds.demo : userIds.admin;
      const result = await client.query(
        `INSERT INTO reviews (product_id, user_id, rating, title, body, is_verified_purchase)
         VALUES ($1, $2, $3, $4, $5, TRUE)
         ON CONFLICT (product_id, user_id) DO NOTHING`,
        [productIds[review.sku], author, review.rating, review.title, review.body],
      );
      reviewCount += result.rowCount;
    }
    console.log(`  reviews:  ${reviewCount}`);

    await client.query("COMMIT");
    console.log("\nSeed complete.");
    console.log("  demo@example.com  / Password123!");
    console.log("  admin@example.com / Admin123!Pass");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(`Seed failed: ${err.message}`);
  process.exit(1);
});
