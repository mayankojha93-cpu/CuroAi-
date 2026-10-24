export interface MisOverview {
  sourceRows: number;
  uniqueContacts: number;
  connectedCalls: number;
  totalAttempts: number;
  dispositionedContacts: number;
}

export interface DispositionItem {
  name: string;
  count: number;
}

export interface CategoryBreakdown {
  category: string;
  dispositions: DispositionItem[];
}

export interface CampaignSummary {
  overview: MisOverview;
  categories: CategoryBreakdown[];
}

export interface SystemHealth {
  status: string;
  timestamp: string;
  uptime: number;
  database: {
    connected: boolean;
    activePoolClients?: number;
  };
}

export type TabKey = 'DASHBOARD' | 'CAMPAIGN' | 'LEADS' | 'CALLS' | 'RETRIES' | 'BILLING' | 'SETTINGS';

export type CampaignStage = 'Running' | 'Paused' | 'Completed' | 'Stopped' | 'RUNNING' | 'PAUSED' | 'COMPLETED' | 'STOPPED';

export interface CampaignItem {
  id: string;
  name: string;
  description: string;
  status: CampaignStage;
  service?: string;
  progress_percent?: number;
  total_contacts: number;
  unique_called: number;
  successful_calls: number;
  failed_calls: number;
  remaining_calls: number;
  credits_used?: number;
  total_credits?: number;
  execution_date?: string;
  contacts?: string[];
  created_at?: string;
  updated_at?: string;
}
