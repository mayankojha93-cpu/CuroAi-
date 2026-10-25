import React, { useState, useEffect } from 'react';
import { useDashboardData } from './hooks';
import { DashboardLayout, Toast } from './components';
import { 
  DashboardHome,
  BillingView,
  SettingsView,
  CampaignOverview, 
  CreateCampaignModal,
  LeadDirectory, 
  LeadImportModal,
  RecentCalls, 
  CallDetailModal, 
  TestCallModal, 
  TestCallView,
  RetryQueue, 
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

  const [isCreateCampaignModalOpen, setIsCreateCampaignModalOpen] = useState(false);
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [isTestCallModalOpen, setIsTestCallModalOpen] = useState(false);
  const [campaignRefreshKey, setCampaignRefreshKey] = useState(0);

  return (
    <DashboardLayout
      activeTab={activeTab}
      onTabChange={setActiveTab}
      leadsCount={customers.length}
      callsCount={recentCalls.length}
      retriesCount={retries.length}
      health={health}
      loading={loading}
      onRefresh={loadAllData}
      onImportModalOpen={() => setIsCreateCampaignModalOpen(true)}
      onTestCallOpen={() => setIsTestCallModalOpen(true)}
      user={user}
      onLogout={onLogout}
    >
      {/* Tab View Routing */}
      <div className="tab-content">
        {activeTab === 'DASHBOARD' && (
          <DashboardHome
            summary={summary}
            recentCalls={recentCalls}
            user={user}
            onTabChange={setActiveTab}
            onImportModalOpen={() => setIsCreateCampaignModalOpen(true)}
            onTestCallOpen={() => setIsTestCallModalOpen(true)}
            onSelectCall={setSelectedCall}
          />
        )}

        {activeTab === 'CAMPAIGN' && (
          <CampaignOverview
            summary={summary}
            loading={loading}
            onImportModalOpen={() => setIsCreateCampaignModalOpen(true)}
            onSelectCall={setSelectedCall}
            refreshTrigger={campaignRefreshKey}
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

        {activeTab === 'TEST_CALL' && (
          <TestCallView
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

        {activeTab === 'BILLING' && (
          <BillingView />
        )}

        {activeTab === 'SETTINGS' && (
          <SettingsView
            health={health}
            user={user}
          />
        )}
      </div>

      {/* Turn-by-Turn Audio & Transcript Modal */}
      <CallDetailModal
        call={selectedCall}
        onClose={() => setSelectedCall(null)}
      />

      {/* Create Voice Campaign Modal matching screenshot */}
      <CreateCampaignModal
        isOpen={isCreateCampaignModalOpen}
        onClose={() => setIsCreateCampaignModalOpen(false)}
        onCampaignCreated={() => {
          showToast('Voice campaign created and launched successfully!', 'success');
          setCampaignRefreshKey((k) => k + 1);
          loadAllData();
        }}
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
    </DashboardLayout>
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
