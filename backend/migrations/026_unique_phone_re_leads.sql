-- Deduplicate real_estate_leads on phone and add unique index
DO $$
DECLARE
  dup RECORD;
  keeper_id UUID;
BEGIN
  -- For any phone that has duplicates, pick the keeper
  FOR dup IN
    SELECT phone, array_agg(id ORDER BY created_at ASC) as id_list
    FROM real_estate_leads
    GROUP BY phone
    HAVING count(*) > 1
  LOOP
    keeper_id := dup.id_list[1];
    -- Reassign foreign keys
    UPDATE calls SET re_lead_id = keeper_id WHERE re_lead_id = ANY(dup.id_list[2:]);
    UPDATE real_estate_properties SET lead_id = keeper_id WHERE lead_id = ANY(dup.id_list[2:]);
    -- Delete the duplicate rows
    DELETE FROM real_estate_leads WHERE id = ANY(dup.id_list[2:]);
  END LOOP;
END $$;

-- Add unique index on real_estate_leads(phone) if not exists
CREATE UNIQUE INDEX IF NOT EXISTS uq_real_estate_leads_phone ON real_estate_leads(phone);

