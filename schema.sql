DROP TABLE IF EXISTS catalog_items;
DROP TABLE IF EXISTS images;
DROP TABLE IF EXISTS transactions;
DROP TABLE IF EXISTS cart;

CREATE TABLE catalog_items (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    price REAL NOT NULL,
    qty INTEGER NOT NULL DEFAULT 0,
    image_id TEXT,
    user_id TEXT NOT NULL,
    is_archived INTEGER DEFAULT 0,
    is_banned INTEGER DEFAULT 0,
    created_at TEXT DEFAULT current_timestamp,
    updated_at TEXT DEFAULT current_timestamp
);

CREATE TABLE images (
    id TEXT PRIMARY KEY,
    data BLOB NOT NULL,
    content_type TEXT NOT NULL DEFAULT 'image/jpeg',
    created_at TEXT DEFAULT current_timestamp,
    updated_at TEXT DEFAULT current_timestamp
);

CREATE TABLE transactions (
    id TEXT PRIMARY KEY,
    buyer_id TEXT NOT NULL,
    seller_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    amount DECIMAL(10,2) NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed')),
    platform_fee REAL DEFAULT 0.0,
    promo_code TEXT,
    discount_amount REAL DEFAULT 0.0,
    created_at TEXT DEFAULT current_timestamp,
    updated_at TEXT DEFAULT current_timestamp,
    FOREIGN KEY (item_id) REFERENCES catalog_items(id) ON DELETE CASCADE
);

CREATE TABLE cart (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT current_timestamp,
    updated_at TEXT DEFAULT current_timestamp,
    FOREIGN KEY (item_id) REFERENCES catalog_items(id) ON DELETE CASCADE,
    UNIQUE(user_id, item_id)
);

CREATE TABLE IF NOT EXISTS platform_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

INSERT OR IGNORE INTO platform_settings (key, value) VALUES ('fee_type', 'percentage');
INSERT OR IGNORE INTO platform_settings (key, value) VALUES ('fee_percentage', '0.00');
INSERT OR IGNORE INTO platform_settings (key, value) VALUES ('fee_fixed', '0.00');

CREATE TABLE IF NOT EXISTS promos (
    id TEXT PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL CHECK (type IN ('percentage', 'fixed')),
    value REAL NOT NULL,
    is_active INTEGER DEFAULT 1,
    max_uses INTEGER,
    used_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT current_timestamp
);

CREATE TABLE IF NOT EXISTS reviews (
    id TEXT PRIMARY KEY,
    transaction_id TEXT NOT NULL,
    rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
    comment TEXT,
    reply TEXT,
    created_at TEXT DEFAULT current_timestamp,
    updated_at TEXT DEFAULT current_timestamp,
    FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
);

CREATE INDEX idx_reviews_transaction_id ON reviews(transaction_id);