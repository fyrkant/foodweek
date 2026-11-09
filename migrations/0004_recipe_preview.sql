-- Preview of the recipe page (title and image), fetched by the Worker.
ALTER TABLE dishes ADD COLUMN recipe_title TEXT;
ALTER TABLE dishes ADD COLUMN recipe_image TEXT;
ALTER TABLE dishes ADD COLUMN recipe_checked_at TEXT;
