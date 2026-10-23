import React, { useState, useEffect } from 'react';
import { useDashboardData } from './hooks';
import { Header, NavigationTabs, Toast } from './components';
import { 
  CampaignOverview, 
  LeadDirectory, 
  LeadImportModal,
  RecentCalls, 
  CallDetailModal, 
  TestCallModal, 
  RetryQueue, 
  SopReference,
  LandingPage,
  LoginPage
} from './features';
import { AuthProvider, useAuth, getStoredAuthToken } from './context/AuthContext';
import type { AuthUser } from './types';
import './index.css';
import './App.css';

interface DashboardViewProps {
  user: AuthUser | null;
  onLogout: () => void;
}

const DashboardView: React.FC<DashboardViewProps> = ({ user, onLogout }) => {
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
  const [isTestCallModalOpen, setIsTestCallModalOpen] = useState(false);

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
        onTestCallOpen={() => setIsTestCallModalOpen(true)}
        user={user}
        onLogout={onLogout}
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
              onImportModalOpen={() => setIsImportModalOpen(true)}
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

      {/* Developer Test Call Console Modal */}
      <TestCallModal
        isOpen={isTestCallModalOpen}
        onClose={() => setIsTestCallModalOpen(false)}
        onCallInitiated={loadAllData}
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

type AppRoute = '/' | '/login' | '/dashboard';

function resolveRoute(): AppRoute {
  const path = window.location.pathname.toLowerCase();
  const hash = window.location.hash.toLowerCase();

  if (path === '/login' || hash === '#/login' || hash === '#login') {
    return '/login';
  }
  if (path === '/dashboard' || hash === '#/dashboard' || hash === '#dashboard') {
    return '/dashboard';
  }
  return '/';
}

const AppRouter: React.FC = () => {
  const { isAuthenticated, user, logout } = useAuth();
  const [currentRoute, setCurrentRoute] = useState<AppRoute>(resolveRoute);

  const navigateTo = React.useCallback((route: AppRoute) => {
    setCurrentRoute(route);
    window.history.pushState(null, '', route);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  useEffect(() => {
    const handleUrlChange = () => {
      setCurrentRoute(resolveRoute());
    };

    const handleUnauthorized = () => {
      navigateTo('/login');
    };

    window.addEventListener('popstate', handleUrlChange);
    window.addEventListener('hashchange', handleUrlChange);
    window.addEventListener('auth:unauthorized', handleUnauthorized);

    return () => {
      window.removeEventListener('popstate', handleUrlChange);
      window.removeEventListener('hashchange', handleUrlChange);
      window.removeEventListener('auth:unauthorized', handleUnauthorized);
    };
  }, [navigateTo]);

  // Instantly recognize auth state from React context or stored token
  const isAuthed = isAuthenticated || !!getStoredAuthToken();

  // If user is logged in, auto-redirect from / or /login to /dashboard
  useEffect(() => {
    if (isAuthed && (currentRoute === '/' || currentRoute === '/login')) {
      navigateTo('/dashboard');
    }
  }, [isAuthed, currentRoute, navigateTo]);

  // Route Guard: /dashboard
  if (currentRoute === '/dashboard') {
    if (!isAuthed) {
      return (
        <LoginPage
          onSuccess={() => navigateTo('/dashboard')}
          onBackToHome={() => navigateTo('/')}
        />
      );
    }

    return (
      <DashboardView
        user={user}
        onLogout={() => {
          logout();
          navigateTo('/login');
        }}
      />
    );
  }

  // Route: /login
  if (currentRoute === '/login') {
    if (isAuthed) {
      return (
        <DashboardView
          user={user}
          onLogout={() => {
            logout();
            navigateTo('/login');
          }}
        />
      );
    }

    return (
      <LoginPage
        onSuccess={() => navigateTo('/dashboard')}
        onBackToHome={() => navigateTo('/')}
      />
    );
  }

  // Route: / (Default Public Landing Page - Only shown when unauthenticated)
  if (isAuthed) {
    return (
      <DashboardView
        user={user}
        onLogout={() => {
          logout();
          navigateTo('/login');
        }}
      />
    );
  }

  return (
    <LandingPage
      onLogin={() => navigateTo('/login')}
    />
  );
};

export const App: React.FC = () => {
  return (
    <AuthProvider>
      <AppRouter />
    </AuthProvider>
  );
};

export default App;
