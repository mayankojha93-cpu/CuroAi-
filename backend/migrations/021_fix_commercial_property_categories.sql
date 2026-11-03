-- 021_fix_commercial_property_categories.sql: Correctly categorize property calls, remove erroneous BHK on commercial properties, and ensure commercial type

-- 1. Calls where customer confirmed residential property
UPDATE real_estate_properties
SET category = 'residential',
    commercial_type = NULL,
    bhk_config = COALESCE(bhk_config, '3 BHK')
WHERE call_id = '357d27ee-f890-4ca1-84f7-40349fa6674a';

UPDATE real_estate_properties
SET category = 'residential',
    commercial_type = NULL,
    bhk_config = NULL,
    intent = 'lease'
WHERE call_id = 'e9538f83-1818-472f-8c36-6ccdc69ef829';

UPDATE real_estate_properties
SET category = 'residential',
    commercial_type = NULL
WHERE call_id IN ('e0000000-0000-0000-0000-000000000001', '7ef97edc-f96c-4cc3-ae60-55966866711d', 'f8ee16b0-61a9-4b92-910f-581812f8317a');

-- 2. Calls where customer confirmed commercial property (e.g. 32c28f91, c45dbb98)
UPDATE real_estate_properties
SET category = 'commercial',
    bhk_config = NULL,
    commercial_type = 'Commercial Unit'
WHERE call_id = '32c28f91-eb3b-4fd8-b29d-1aa95d53dce8';

UPDATE real_estate_properties
SET category = 'commercial',
    bhk_config = NULL,
    commercial_type = 'Commercial Office/Shop'
WHERE call_id = 'c45dbb98-d114-4915-a057-60953ebe6a54';

-- 3. General catch-all for any other commercial property:
-- If project_or_society, sector_or_location, or notes contain commercial/office/shop keywords
UPDATE real_estate_properties
SET category = 'commercial',
    bhk_config = NULL,
    commercial_type = COALESCE(
      NULLIF(commercial_type, 'residential'),
      CASE
        WHEN LOWER(COALESCE(project_or_society, '')) LIKE '%office%' THEN 'Office Space'
        WHEN LOWER(COALESCE(project_or_society, '')) LIKE '%shop%' THEN 'Retail Shop'
        WHEN LOWER(COALESCE(project_or_society, '')) LIKE '%showroom%' THEN 'Showroom'
        ELSE 'Commercial Unit'
      END
    )
WHERE (
  LOWER(COALESCE(project_or_society, '')) LIKE '%commercial%' OR
  LOWER(COALESCE(project_or_society, '')) LIKE '%office%' OR
  LOWER(COALESCE(project_or_society, '')) LIKE '%shop%' OR
  LOWER(COALESCE(project_or_society, '')) LIKE '%retail%' OR
  LOWER(COALESCE(project_or_society, '')) LIKE '%showroom%' OR
  LOWER(COALESCE(project_or_society, '')) LIKE '%warehouse%'
) AND call_id NOT IN ('357d27ee-f890-4ca1-84f7-40349fa6674a', 'e9538f83-1818-472f-8c36-6ccdc69ef829');

-- 4. Clean up any lingering commercial_type = 'residential'
UPDATE real_estate_properties
SET commercial_type = NULL
WHERE LOWER(COALESCE(commercial_type, '')) = 'residential';
