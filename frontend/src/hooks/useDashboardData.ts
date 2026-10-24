import { useState, useEffect, useCallback } from 'react';
import { 
  fetchHealth, 
  fetchCampaignSummary, 
  fetchCustomers, 
  fetchRecentCalls, 
  fetchPendingRetries, 
  initiateCall, 
  importLeads 
} from '../services';
import type { 
  CampaignSummary, 
  Customer, 
  CallRecord, 
  SystemHealth, 
  TabKey,
  CustomerCreateInput
} from '../types';

export function useDashboardData() {
  const [activeTab, setActiveTab] = useState<TabKey>('DASHBOARD');
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [summary, setSummary] = useState<CampaignSummary | null>(null);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [recentCalls, setRecentCalls] = useState<CallRecord[]>([]);
  const [retries, setRetries] = useState<Customer[]>([]);

  const [loading, setLoading] = useState(false);
  const [dialingId, setDialingId] = useState<string | null>(null);
  const [selectedCall, setSelectedCall] = useState<CallRecord | null>(null);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  const showToast = useCallback((message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  }, []);

  const loadAllData = useCallback(async () => {
    setLoading(true);
    try {
      const [h, s, c, calls, r] = await Promise.all([
        fetchHealth().catch(() => null),
        fetchCampaignSummary().catch(() => null),
        fetchCustomers().catch(() => []),
        fetchRecentCalls().catch(() => []),
        fetchPendingRetries().catch(() => []),
      ]);

      if (h) setHealth(h);
      if (s) setSummary(s);
      setCustomers(c);
      setRecentCalls(calls);
      setRetries(r);
    } catch (err: any) {
      console.error('Error loading dashboard data:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAllData();
    const interval = setInterval(loadAllData, 10000); // 10s auto-refresh
    return () => clearInterval(interval);
  }, [loadAllData]);

  const handleDialCustomer = async (customerId: string, name?: string) => {
    try {
      setDialingId(customerId);
      const call = await initiateCall(customerId);
      showToast(`Outbound SIP call initiated to ${name || 'Customer'} (Room: ${call.roomName})`, 'success');
      await loadAllData();
    } catch (err: any) {
      showToast(err.message || 'Call initiation failed', 'error');
    } finally {
      setDialingId(null);
    }
  };

  const handleImportLeads = async (leads: Partial<CustomerCreateInput>[]) => {
    try {
      const result = await importLeads(leads);
      showToast(`Successfully imported ${result.count} leads into Airtel campaign!`, 'success');
      await loadAllData();
      return true;
    } catch (err: any) {
      showToast(err.message || 'Failed to import leads', 'error');
      return false;
    }
  };

  return {
    activeTab,
    setActiveTab,
    health,
    summary,
    customers,
    recentCalls,
    retries,
    loading,
    dialingId,
    selectedCall,
    setSelectedCall,
    toast,
    showToast,
    loadAllData,
    handleDialCustomer,
    handleImportLeads,
  };
}
