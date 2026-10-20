import React, { useState } from 'react';
import { useDashboardData } from './hooks';
import { Header, NavigationTabs } from './components/layout';
import { Toast } from './components/common';
import { 
  CampaignOverview, 
  LeadDirectory, 
  LeadImportModal,
  RecentCalls, 
  CallDetailModal, 
  RetryQueue, 
  SopReference 
} from './features';
import './index.css';
import './App.css';

export const App: React.FC = () => {
  const {
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
  } = useDashboardData();

  const [isImportModalOpen, setIsImportModalOpen] = useState(false);

  // Quick Seed Lead handler for demo testing
  const handleSeedLead = async () => {
    const randomSuffix = Math.floor(1000 + Math.random() * 9000);
    const testLead = {
      name: `Rajesh Sharma (${randomSuffix})`,
      phone: `+919811${randomSuffix}22`,
      account_no: `2002294${randomSuffix}`,
      subs_del_no: `0112134${randomSuffix}_wifi`,
      service_end_date: '2026-08-27',
      address: `Flat ${randomSuffix % 500}, Pocket 4, Mayur Vihar Phase 1, New Delhi - 110091`,
      language: 'hi',
    };

    const success = await handleImportLeads([testLead]);
    if (success) {
      showToast(`Added test lead: ${testLead.name}`, 'success');
      setActiveTab('LEADS');
    }
  };

  return (
    <div className="dashboard-shell" style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      {/* Top Application Header */}
      <Header
        health={health}
        loading={loading}
        onRefresh={loadAllData}
        onSeedLead={handleSeedLead}
        onImportModalOpen={() => setIsImportModalOpen(true)}
      />

      {/* Main Dashboard Body */}
      <main style={{ flex: 1, maxWidth: 1440, width: '100%', margin: '0 auto', padding: '24px 28px' }}>
        {/* Navigation Tabs */}
        <NavigationTabs
          activeTab={activeTab}
          onTabChange={setActiveTab}
          leadsCount={customers.length}
          callsCount={recentCalls.length}
          retriesCount={retries.length}
        />

        {/* Tab View Routing */}
        <div className="tab-content" style={{ marginTop: 8 }}>
          {activeTab === 'CAMPAIGN' && (
            <CampaignOverview
              summary={summary}
              loading={loading}
            />
          )}

          {activeTab === 'LEADS' && (
            <LeadDirectory
              customers={customers}
              onDial={handleDialCustomer}
              dialingId={dialingId}
            />
          )}

          {activeTab === 'CALLS' && (
            <RecentCalls
              calls={recentCalls}
              onSelectCall={setSelectedCall}
            />
          )}

          {activeTab === 'RETRIES' && (
            <RetryQueue
              retries={retries}
              onDial={handleDialCustomer}
              dialingId={dialingId}
            />
          )}

          {activeTab === 'SOP' && (
            <SopReference />
          )}
        </div>
      </main>

      {/* Turn-by-Turn Audio & Transcript Modal */}
      <CallDetailModal
        call={selectedCall}
        onClose={() => setSelectedCall(null)}
      />

      {/* Bulk Lead Import Modal */}
      <LeadImportModal
        isOpen={isImportModalOpen}
        onClose={() => setIsImportModalOpen(false)}
        onImport={handleImportLeads}
      />

      {/* Toast Notification Banner */}
      {toast && (
        <Toast
          message={toast.message}
          type={toast.type}
          onClose={() => showToast('', 'success')}
        />
      )}
    </div>
  );
};

export default App;
