DROP TABLE IF EXISTS catalog_items;
DROP TABLE IF EXISTS images;

CREATE TABLE catalog_items (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    price REAL NOT NULL,
    image_id TEXT,
    created_at TEXT DEFAULT current_timestamp,
    updated_at TEXT DEFAULT current_timestamp,
    created_by_id INTEGER
);

CREATE TABLE images (
    id TEXT PRIMARY KEY,
    data BLOB NOT NULL,
    content_type TEXT NOT NULL DEFAULT 'image/jpeg',
    created_at TEXT DEFAULT current_timestamp,
    updated_at TEXT DEFAULT current_timestamp
);