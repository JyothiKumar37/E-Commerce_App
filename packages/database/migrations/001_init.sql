-- =====================================================================
-- 001_init: identity, catalog, inventory, orders, payments, shipping,
--           reviews and recommendations.
--
-- Conventions
--   * UUID primary keys (no enumerable sequential ids in public URLs)
--   * money as integer minor units (cents) — never float
--   * citext for case-insensitive natural keys (email, username, sku)
--   * timestamptz everywhere; the application never sees a naive timestamp
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "citext";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";    -- trigram search fallback when ES is down

-- Shared trigger to maintain updated_at without relying on the app.
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------

CREATE TABLE users (
  user_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username      CITEXT NOT NULL UNIQUE,
  email         CITEXT NOT NULL UNIQUE,
  password_hash TEXT   NOT NULL,
  first_name    TEXT   NOT NULL,
  last_name     TEXT   NOT NULL,
  role          TEXT   NOT NULL DEFAULT 'customer'
                       CHECK (role IN ('customer', 'admin')),
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT users_username_length CHECK (char_length(username) BETWEEN 3 AND 30),
  CONSTRAINT users_email_shape     CHECK (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')
);

CREATE TRIGGER users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Refresh tokens are opaque and revocable; only the SHA-256 digest is stored.
CREATE TABLE refresh_tokens (
  token_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  -- Set when this token is rotated, pointing at its successor. Presenting a
  -- token that has already been rotated indicates theft; the whole family is
  -- then revoked.
  replaced_by  UUID REFERENCES refresh_tokens(token_id) ON DELETE SET NULL,
  user_agent   TEXT,
  ip_address   INET,
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX refresh_tokens_user_idx    ON refresh_tokens(user_id) WHERE revoked_at IS NULL;
CREATE INDEX refresh_tokens_expires_idx ON refresh_tokens(expires_at);

CREATE TABLE addresses (
  address_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  address_type   TEXT NOT NULL DEFAULT 'home'
                      CHECK (address_type IN ('home', 'work', 'billing', 'shipping', 'other')),
  recipient_name TEXT NOT NULL,
  address_line1  TEXT NOT NULL,
  address_line2  TEXT,
  city           TEXT NOT NULL,
  state          TEXT,
  country        TEXT NOT NULL,
  zip            TEXT NOT NULL,
  phone          TEXT,
  is_default     BOOLEAN NOT NULL DEFAULT FALSE,
  effective_date DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX addresses_user_idx ON addresses(user_id);
-- At most one default address per user, enforced by the database.
CREATE UNIQUE INDEX addresses_one_default_per_user
  ON addresses(user_id) WHERE is_default;

CREATE TRIGGER addresses_updated_at BEFORE UPDATE ON addresses
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- Catalog
-- ---------------------------------------------------------------------

CREATE TABLE products (
  product_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku           CITEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  category      TEXT NOT NULL,
  brand         TEXT,
  price_cents   INTEGER NOT NULL CHECK (price_cents >= 0),
  currency      CHAR(3) NOT NULL DEFAULT 'EUR',
  image_url     TEXT,
  -- Free-form facets (gender, size, color, resolution, battery_life, ...).
  -- Keeps the schema stable as new product types are added.
  attributes    JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  -- Denormalised from reviews for cheap list rendering.
  rating_avg    NUMERIC(3,2) NOT NULL DEFAULT 0 CHECK (rating_avg BETWEEN 0 AND 5),
  rating_count  INTEGER NOT NULL DEFAULT 0 CHECK (rating_count >= 0),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX products_category_idx   ON products(category)  WHERE is_active;
CREATE INDEX products_brand_idx      ON products(brand)     WHERE is_active;
CREATE INDEX products_price_idx      ON products(price_cents);
CREATE INDEX products_attributes_idx ON products USING GIN (attributes);
-- Trigram index powers the degraded search path when Elasticsearch is down.
CREATE INDEX products_name_trgm_idx  ON products USING GIN (name gin_trgm_ops);
CREATE INDEX products_desc_trgm_idx  ON products USING GIN (description gin_trgm_ops);

CREATE TRIGGER products_updated_at BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Outbox: catalog writes enqueue here in the same transaction, and a worker
-- replays them into Elasticsearch. Without this, a crash between the Postgres
-- commit and the ES call leaves the index permanently stale.
CREATE TABLE catalog_outbox (
  outbox_id   BIGSERIAL PRIMARY KEY,
  product_id  UUID NOT NULL,
  operation   TEXT NOT NULL CHECK (operation IN ('upsert', 'delete')),
  payload     JSONB,
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  processed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX catalog_outbox_pending_idx
  ON catalog_outbox(created_at) WHERE processed_at IS NULL;

-- ---------------------------------------------------------------------
-- Inventory
-- ---------------------------------------------------------------------

CREATE TABLE inventory (
  product_id     UUID PRIMARY KEY REFERENCES products(product_id) ON DELETE CASCADE,
  available      INTEGER NOT NULL DEFAULT 0 CHECK (available >= 0),
  reserved       INTEGER NOT NULL DEFAULT 0 CHECK (reserved  >= 0),
  reorder_level  INTEGER NOT NULL DEFAULT 5,
  warehouse_code TEXT NOT NULL DEFAULT 'MAIN',
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER inventory_updated_at BEFORE UPDATE ON inventory
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A reservation holds stock between "checkout started" and "payment captured".
CREATE TABLE inventory_reservations (
  reservation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id       UUID,
  user_id        UUID,
  status         TEXT NOT NULL DEFAULT 'held'
                      CHECK (status IN ('held', 'committed', 'released', 'expired')),
  expires_at     TIMESTAMPTZ NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX inventory_reservations_expiry_idx
  ON inventory_reservations(expires_at) WHERE status = 'held';
CREATE INDEX inventory_reservations_order_idx ON inventory_reservations(order_id);

CREATE TABLE inventory_reservation_items (
  reservation_id UUID NOT NULL REFERENCES inventory_reservations(reservation_id) ON DELETE CASCADE,
  product_id     UUID NOT NULL REFERENCES products(product_id),
  quantity       INTEGER NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (reservation_id, product_id)
);

CREATE TRIGGER inventory_reservations_updated_at BEFORE UPDATE ON inventory_reservations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Append-only audit of every stock movement.
CREATE TABLE inventory_ledger (
  entry_id    BIGSERIAL PRIMARY KEY,
  product_id  UUID NOT NULL REFERENCES products(product_id) ON DELETE CASCADE,
  delta       INTEGER NOT NULL,
  reason      TEXT NOT NULL,
  reference   TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX inventory_ledger_product_idx ON inventory_ledger(product_id, created_at DESC);

-- ---------------------------------------------------------------------
-- Orders
-- ---------------------------------------------------------------------

CREATE TABLE orders (
  order_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number     TEXT NOT NULL UNIQUE,
  user_id          UUID NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  status           TEXT NOT NULL DEFAULT 'pending_payment'
                        CHECK (status IN ('pending_payment', 'paid', 'processing',
                                          'shipped', 'delivered', 'cancelled', 'refunded', 'failed')),
  subtotal_cents   INTEGER NOT NULL CHECK (subtotal_cents >= 0),
  shipping_cents   INTEGER NOT NULL DEFAULT 0 CHECK (shipping_cents >= 0),
  tax_cents        INTEGER NOT NULL DEFAULT 0 CHECK (tax_cents >= 0),
  total_cents      INTEGER NOT NULL CHECK (total_cents >= 0),
  currency         CHAR(3) NOT NULL DEFAULT 'EUR',
  -- Snapshotted, not a foreign key: editing an address must not rewrite the
  -- shipping details of an order already dispatched.
  shipping_address JSONB NOT NULL,
  billing_address  JSONB,
  reservation_id   UUID,
  -- Unique per user; the DB is the final arbiter of double-submit protection
  -- even if Redis is flushed.
  idempotency_key  TEXT,
  placed_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cancelled_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT orders_total_consistent
    CHECK (total_cents = subtotal_cents + shipping_cents + tax_cents)
);

CREATE INDEX orders_user_idx   ON orders(user_id, placed_at DESC);
CREATE INDEX orders_status_idx ON orders(status);
CREATE UNIQUE INDEX orders_idempotency_idx
  ON orders(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TRIGGER orders_updated_at BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE order_items (
  order_item_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id         UUID NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
  product_id       UUID NOT NULL REFERENCES products(product_id) ON DELETE RESTRICT,
  -- Product name/sku/price are snapshotted so an invoice stays truthful after
  -- the catalog changes.
  sku              CITEXT NOT NULL,
  name             TEXT NOT NULL,
  image_url        TEXT,
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
  quantity         INTEGER NOT NULL CHECK (quantity > 0),
  total_cents      INTEGER NOT NULL CHECK (total_cents >= 0),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX order_items_order_idx   ON order_items(order_id);
CREATE INDEX order_items_product_idx ON order_items(product_id);

CREATE TABLE order_events (
  event_id   BIGSERIAL PRIMARY KEY,
  order_id   UUID NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
  status     TEXT NOT NULL,
  note       TEXT,
  actor      TEXT NOT NULL DEFAULT 'system',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX order_events_order_idx ON order_events(order_id, created_at);

-- ---------------------------------------------------------------------
-- Payments
-- ---------------------------------------------------------------------

CREATE TABLE payments (
  payment_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        UUID NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  provider        TEXT NOT NULL DEFAULT 'mock',
  provider_ref    TEXT,
  method          TEXT NOT NULL CHECK (method IN ('card', 'paypal', 'sepa', 'invoice')),
  -- Never store a PAN. Only the display suffix and brand.
  card_last4      CHAR(4),
  card_brand      TEXT,
  amount_cents    INTEGER NOT NULL CHECK (amount_cents > 0),
  currency        CHAR(3) NOT NULL DEFAULT 'EUR',
  status          TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'authorized', 'captured',
                                         'failed', 'refunded', 'cancelled')),
  failure_reason  TEXT,
  idempotency_key TEXT UNIQUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX payments_order_idx ON payments(order_id);
CREATE INDEX payments_user_idx  ON payments(user_id, created_at DESC);

CREATE TRIGGER payments_updated_at BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- Shipping
-- ---------------------------------------------------------------------

CREATE TABLE shipments (
  shipment_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id           UUID NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
  carrier            TEXT NOT NULL DEFAULT 'DHL',
  service_level      TEXT NOT NULL DEFAULT 'standard'
                          CHECK (service_level IN ('standard', 'express', 'overnight')),
  tracking_number    TEXT UNIQUE,
  status             TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'label_created', 'in_transit',
                                            'out_for_delivery', 'delivered', 'returned', 'cancelled')),
  destination        JSONB NOT NULL,
  estimated_delivery DATE,
  shipped_at         TIMESTAMPTZ,
  delivered_at       TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX shipments_order_idx ON shipments(order_id);

CREATE TRIGGER shipments_updated_at BEFORE UPDATE ON shipments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE shipment_events (
  event_id    BIGSERIAL PRIMARY KEY,
  shipment_id UUID NOT NULL REFERENCES shipments(shipment_id) ON DELETE CASCADE,
  status      TEXT NOT NULL,
  location    TEXT,
  note        TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX shipment_events_shipment_idx ON shipment_events(shipment_id, occurred_at);

-- ---------------------------------------------------------------------
-- Reviews
-- ---------------------------------------------------------------------

CREATE TABLE reviews (
  review_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id           UUID NOT NULL REFERENCES products(product_id) ON DELETE CASCADE,
  user_id              UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  order_id             UUID REFERENCES orders(order_id) ON DELETE SET NULL,
  rating               SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  title                TEXT,
  body                 TEXT NOT NULL,
  is_verified_purchase BOOLEAN NOT NULL DEFAULT FALSE,
  status               TEXT NOT NULL DEFAULT 'published'
                            CHECK (status IN ('published', 'pending', 'rejected')),
  helpful_count        INTEGER NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- One review per product per user.
  CONSTRAINT reviews_one_per_user_product UNIQUE (product_id, user_id)
);

CREATE INDEX reviews_product_idx ON reviews(product_id, created_at DESC)
  WHERE status = 'published';
CREATE INDEX reviews_user_idx ON reviews(user_id);

CREATE TRIGGER reviews_updated_at BEFORE UPDATE ON reviews
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Keep products.rating_avg / rating_count in step with reviews automatically,
-- so the rollup can never drift from the source rows.
CREATE OR REPLACE FUNCTION refresh_product_rating()
RETURNS TRIGGER AS $$
DECLARE
  target UUID := COALESCE(NEW.product_id, OLD.product_id);
BEGIN
  UPDATE products p
  SET rating_avg = COALESCE(agg.avg_rating, 0),
      rating_count = COALESCE(agg.total, 0)
  FROM (
    SELECT ROUND(AVG(rating)::numeric, 2) AS avg_rating, COUNT(*) AS total
    FROM reviews
    WHERE product_id = target AND status = 'published'
  ) agg
  WHERE p.product_id = target;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER reviews_rollup
  AFTER INSERT OR UPDATE OR DELETE ON reviews
  FOR EACH ROW EXECUTE FUNCTION refresh_product_rating();

-- ---------------------------------------------------------------------
-- Recommendations
-- ---------------------------------------------------------------------

-- "Customers who bought A also bought B", recomputed in batch.
CREATE TABLE product_affinity (
  product_id     UUID NOT NULL REFERENCES products(product_id) ON DELETE CASCADE,
  related_id     UUID NOT NULL REFERENCES products(product_id) ON DELETE CASCADE,
  score          NUMERIC(8,6) NOT NULL CHECK (score >= 0),
  co_occurrences INTEGER NOT NULL DEFAULT 0,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (product_id, related_id),
  CONSTRAINT product_affinity_distinct CHECK (product_id <> related_id)
);

CREATE INDEX product_affinity_score_idx ON product_affinity(product_id, score DESC);

CREATE TABLE user_recommendations (
  user_id      UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  product_id   UUID NOT NULL REFERENCES products(product_id) ON DELETE CASCADE,
  score        NUMERIC(8,6) NOT NULL,
  reason       TEXT NOT NULL DEFAULT 'popular',
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, product_id)
);

CREATE INDEX user_recommendations_score_idx ON user_recommendations(user_id, score DESC);

-- Behavioural signal feeding the generator.
CREATE TABLE product_views (
  view_id    BIGSERIAL PRIMARY KEY,
  product_id UUID NOT NULL REFERENCES products(product_id) ON DELETE CASCADE,
  user_id    UUID REFERENCES users(user_id) ON DELETE SET NULL,
  session_id TEXT,
  viewed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX product_views_product_idx ON product_views(product_id, viewed_at DESC);
CREATE INDEX product_views_user_idx    ON product_views(user_id, viewed_at DESC)
  WHERE user_id IS NOT NULL;

-- Batch bookkeeping for the recommendation-generation service.
CREATE TABLE recommendation_runs (
  run_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status       TEXT NOT NULL DEFAULT 'running'
                    CHECK (status IN ('running', 'completed', 'failed')),
  strategy     TEXT NOT NULL,
  users_scored INTEGER NOT NULL DEFAULT 0,
  pairs_scored INTEGER NOT NULL DEFAULT 0,
  error        TEXT,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at  TIMESTAMPTZ
);
