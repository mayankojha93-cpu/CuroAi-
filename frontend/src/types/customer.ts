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
  cust_email?: string | null;
  customer_identifier?: string | null;
  alternate_phones?: string[] | null;
  alternate_phone?: string | null;
  pincode?: string | null;
  zone?: string | null;
  town_flag?: string | null;
  service_city?: string | null;
  disconnection_reason?: string | null;
  circle_new?: string | null;
  circle_new20?: string | null;
  allocated_to?: string | null;
  check_status?: string | null;
  product_name?: string | null;
  total_attempts: number;
  max_attempts: number;
  next_attempt_time?: string | null;
  current_disposition?: string | null;
  is_closed: boolean;
  created_at: string;
}

export interface CustomerCreateInput {
  name?: string;
  phone?: string;
  address?: string;
  language?: string;
  account_no?: string;
  subs_del_no?: string;
  service_end_date?: string;
  r_date?: string;
  check?: string;
  check_status?: string;
  cust_email?: string;
  customer_identifier?: string;
  alternate_phones?: string[];
  alternate_phone?: string;
  pincode?: string;
  zone?: string;
  town_flag?: string;
  service_city?: string;
  disconnection_reason?: string;
  circle_new?: string;
  circle_new20?: string;
  allocated_to?: string;
  product_name?: string;
}
