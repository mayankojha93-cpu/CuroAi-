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

export type TabKey = 'CAMPAIGN' | 'LEADS' | 'CALLS' | 'RETRIES' | 'SOP';
