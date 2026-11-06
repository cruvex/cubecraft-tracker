-- What happened in a scrape run, as one object: boards, missingCounts and unmapped, plus error when the run failed.

ALTER TABLE scrape_runs RENAME COLUMN boards TO details;
ALTER TABLE scrape_runs ALTER COLUMN details DROP DEFAULT;

ALTER TABLE scrape_runs ALTER COLUMN details TYPE jsonb USING
    CASE WHEN jsonb_array_length(details) = 0 THEN '{}'::jsonb ELSE jsonb_build_object('boards', details) END
    || CASE WHEN error IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('error', error) END;

ALTER TABLE scrape_runs ALTER COLUMN details SET DEFAULT '{}';
ALTER TABLE scrape_runs DROP COLUMN error;
