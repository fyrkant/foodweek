-- Dishes get a stable UUID; meals reference a dish instead of copying its name.

CREATE TABLE dishes (
  id TEXT PRIMARY KEY,                        -- UUID v4
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  uses INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Random UUID v4, evaluated per row.
-- Most-used spelling wins when names differ only by case.
INSERT OR IGNORE INTO dishes (id, name, uses, created_at)
SELECT
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
  lower(hex(randomblob(6))),
  name, uses, created_at
FROM dinners
ORDER BY uses DESC, created_at ASC;

-- Any meal whose name never made it into the catalog.
INSERT OR IGNORE INTO dishes (id, name, uses)
SELECT
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
  lower(hex(randomblob(6))),
  name, COUNT(*)
FROM meals
GROUP BY name;

CREATE TABLE meals_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,                 -- YYYY-MM-DD
  dish_id TEXT NOT NULL REFERENCES dishes (id),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- dishes.name is on the left so its NOCASE collation is used.
INSERT INTO meals_new (id, date, dish_id, sort_order, created_at)
SELECT m.id, m.date, d.id, m.sort_order, m.created_at
FROM meals m
JOIN dishes d ON d.name = m.name;

DROP TABLE meals;
ALTER TABLE meals_new RENAME TO meals;
CREATE INDEX idx_meals_date ON meals (date);
CREATE INDEX idx_meals_dish ON meals (dish_id);

DROP TABLE dinners;
