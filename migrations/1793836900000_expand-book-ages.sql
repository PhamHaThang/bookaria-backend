-- Up Migration
ALTER TABLE books
    DROP CONSTRAINT books_age_min_range,
    DROP CONSTRAINT books_age_max_range,
    ADD CONSTRAINT books_age_min_range CHECK (age_min BETWEEN 0 AND 150),
    ADD CONSTRAINT books_age_max_range CHECK (age_max BETWEEN 0 AND 150);

-- Down Migration
ALTER TABLE books
    DROP CONSTRAINT books_age_min_range,
    DROP CONSTRAINT books_age_max_range,
    ADD CONSTRAINT books_age_min_range CHECK (age_min BETWEEN 0 AND 18),
    ADD CONSTRAINT books_age_max_range CHECK (age_max BETWEEN 0 AND 18);
