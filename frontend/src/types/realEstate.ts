export interface RealEstateLead {
  id: string;
  campaign_id?: string | null;
  owner_name: string;
  phone: string;
  alternate_phone?: string | null;
  email?: string | null;
  preferred_language: string;
  lead_status: string;
  current_disposition?: string | null;
  total_attempts: number;
  max_attempts: number;
  last_called_at?: string | null;
  notes?: string | null;
  created_at: string;
}

export interface RealEstateProperty {
  id: string;
  lead_id?: string | null;
  call_id?: string | null;
  category: 'RESIDENTIAL' | 'COMMERCIAL' | 'residential' | 'commercial';
  intent: 'SALE' | 'LEASE' | 'RENT' | 'sale' | 'lease' | 'rent';
  project_or_society?: string | null;
  sector_or_location?: string | null;
  unit_number?: string | null;
  floor_number?: string | null;
  bhk_config?: string | null;
  commercial_type?: string | null;
  approx_area_sqft?: number | null;
  furnishing_status?: string | null;
  expected_sale_price?: string | null;
  expected_monthly_rent?: string | null;
  is_currently_leased?: boolean | null;
  current_rent_received?: string | null;
  immediate_occupancy?: boolean | null;
  raw_notes?: string | null;
  owner_name?: string | null;
  phone?: string | null;
  call_time?: string | null;
  duration_seconds?: number | null;
  final_disposition?: string | null;
  created_at: string;
}

