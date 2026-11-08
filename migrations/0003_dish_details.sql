-- Optional details on a dish, shown wherever it's planned.
ALTER TABLE dishes ADD COLUMN recipe_url TEXT;
ALTER TABLE dishes ADD COLUMN notes TEXT;
