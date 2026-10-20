export interface Customer {
  id: string;
  name: string;
  phone: string;
  address: string;
  language: string;
  account_no?: string | null;
  subs_del_no?: string | null;
  service_end_date?: string | null;
  r_date?: string | null;
  total_attempts: number;
  max_attempts: number;
  next_attempt_time?: string | null;
  current_disposition?: string | null;
  is_closed: boolean;
  created_at: string;
}

export interface CustomerCreateInput {
  name: string;
  phone: string;
  address?: string;
  language?: string;
  account_no?: string;
  subs_del_no?: string;
  service_end_date?: string;
  r_date?: string;
}
