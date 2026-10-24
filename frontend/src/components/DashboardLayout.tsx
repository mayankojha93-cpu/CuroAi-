import React, { useState, useEffect } from 'react';
import { 
  LayoutGrid, 
  Megaphone, 
  Phone, 
  Users, 
  RotateCcw, 
  CreditCard, 
  Settings, 
  Wallet, 
  LogOut, 
  Menu, 
  X, 
  ChevronLeft, 
  ChevronRight,
  RefreshCw
} from 'lucide-react';
import type { TabKey, SystemHealth, AuthUser } from '../types';
import { fetchBillingBalance } from '../services/api.service';

interface DashboardLayoutProps {
  activeTab: TabKey;
  onTabChange: (tab: TabKey) => void;
  leadsCount: number;
  callsCount: number;
  retriesCount: number;
  health: SystemHealth | null;
  loading: boolean;
  onRefresh: () => void;
  onImportModalOpen: () => void;
  onTestCallOpen: () => void;
  user: AuthUser | null;
  onLogout: () => void;
  children: React.ReactNode;
}

interface NavItemConfig {
  id: TabKey;
  label: string;
  icon: React.ReactNode;
  badge?: { count: number | string; color: string } | null;
}

export const DashboardLayout: React.FC<DashboardLayoutProps> = ({
  activeTab,
  onTabChange,
  leadsCount,
  callsCount,
  retriesCount,
  health: _health,
  loading,
  onRefresh,
  onImportModalOpen: _onImportModalOpen,
  onTestCallOpen: _onTestCallOpen,
  user,
  onLogout,
  children,
}) => {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [credits, setCredits] = useState<number>(() => {
    const saved = localStorage.getItem('curoai_credits');
    return saved ? parseInt(saved, 10) : 21874;
  });

  useEffect(() => {
    fetchBillingBalance()
      .then((data) => {
        if (data && typeof data.available_credits === 'number') {
          setCredits(data.available_credits);
          localStorage.setItem('curoai_credits', String(data.available_credits));
        }
      })
      .catch(() => {});

    const handleUpdate = (e: CustomEvent<{ credits: number }>) => {
      if (e.detail && typeof e.detail.credits === 'number') {
        setCredits(e.detail.credits);
      }
    };
    window.addEventListener('curoai_credits_updated', handleUpdate as EventListener);
    return () => window.removeEventListener('curoai_credits_updated', handleUpdate as EventListener);
  }, []);

  const getBreadcrumbTitle = (tab: TabKey) => {
    switch (tab) {
      case 'DASHBOARD': return 'Dashboard';
      case 'CAMPAIGN': return 'Campaigns';
      case 'CALLS': return 'Calls';
      case 'LEADS': return 'Lead Directory';
      case 'RETRIES': return 'Retry Queue';
      case 'BILLING': return 'Billing';
      case 'SETTINGS': return 'Settings';
      default: return 'Dashboard';
    }
  };

  const navItems: NavItemConfig[] = [
    {
      id: 'DASHBOARD',
      label: 'Dashboard',
      icon: <LayoutGrid size={18} />,
    },
    {
      id: 'CAMPAIGN',
      label: 'Campaigns',
      icon: <Megaphone size={18} />,
    },
    {
      id: 'CALLS',
      label: 'Calls',
      icon: <Phone size={18} />,
      badge: callsCount > 0 ? { count: callsCount, color: 'badge-blue' } : null,
    },
    {
      id: 'LEADS',
      label: 'Leads',
      icon: <Users size={18} />,
      badge: leadsCount > 0 ? { count: leadsCount, color: 'badge-green' } : null,
    },
    {
      id: 'RETRIES',
      label: 'Retries',
      icon: <RotateCcw size={18} />,
      badge: retriesCount > 0 ? { count: retriesCount, color: 'badge-amber' } : null,
    },
    {
      id: 'BILLING',
      label: 'Billing',
      icon: <CreditCard size={18} />,
    },
    {
      id: 'SETTINGS',
      label: 'Settings',
      icon: <Settings size={18} />,
    },
  ];

  return (
    <div style={{
      display: 'flex',
      minHeight: '100vh',
      background: 'var(--bg-primary)',
      color: 'var(--text-primary)',
      position: 'relative',
    }}>
      {/* Mobile Backdrop Overlay */}
      {mobileMenuOpen && (
        <div
          onClick={() => setMobileMenuOpen(false)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.75)',
            backdropFilter: 'blur(4px)',
            zIndex: 90,
          }}
        />
      )}

      {/* Left Navigation Sidebar */}
      <aside
        className={mobileMenuOpen ? 'mobile-open' : ''}
        style={{
          width: sidebarCollapsed ? 76 : 240,
          flexShrink: 0,
          background: 'var(--bg-sidebar)',
          borderRight: '1px solid var(--border-subtle)',
          display: 'flex',
          flexDirection: 'column',
          position: 'sticky',
          top: 0,
          height: '100vh',
          zIndex: 100,
          transition: 'width 0.22s cubic-bezier(0.16, 1, 0.3, 1), transform 0.28s ease',
        }}
      >
        {/* Toggle Collapse Button on Right Edge */}
        <button
          onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
          style={{
            position: 'absolute',
            right: -12,
            top: 260,
            width: 24,
            height: 24,
            borderRadius: '50%',
            background: '#0E121B',
            border: '1px solid rgba(255, 255, 255, 0.15)',
            color: '#94A3B8',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            zIndex: 10,
            boxShadow: '0 2px 8px rgba(0, 0, 0, 0.5)',
            transition: 'all 0.15s ease',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = '#FFFFFF';
            e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.35)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = '#94A3B8';
            e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.15)';
          }}
          title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {sidebarCollapsed ? <ChevronRight size={13} /> : <ChevronLeft size={13} />}
        </button>

        {/* Brand Header */}
        <div style={{
          padding: sidebarCollapsed ? '24px 0' : '22px 24px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: sidebarCollapsed ? 'center' : 'space-between',
          borderBottom: '1px solid var(--border-subtle)',
        }}>
          <div 
            onClick={() => onTabChange('DASHBOARD')}
            style={{ 
              display: 'flex', 
              alignItems: 'center', 
              gap: 12, 
              cursor: 'pointer',
              textDecoration: 'none' 
            }}
          >
            {/* Logo Icon matching screenshot (circular cyan-blue glowing badge) */}
            <div style={{
              width: 34,
              height: 34,
              borderRadius: 10,
              background: 'linear-gradient(135deg, rgba(56, 189, 248, 0.25) 0%, rgba(37, 99, 235, 0.3) 100%)',
              border: '1px solid rgba(56, 189, 248, 0.35)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 0 14px rgba(56, 189, 248, 0.25)',
              flexShrink: 0,
            }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="8" stroke="url(#curo-grad)" strokeWidth="3" strokeLinecap="round" strokeDasharray="36 12" />
                <circle cx="12" cy="12" r="3.2" fill="#38BDF8" />
                <defs>
                  <linearGradient id="curo-grad" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="#38BDF8" />
                    <stop offset="100%" stopColor="#2563EB" />
                  </linearGradient>
                </defs>
              </svg>
            </div>

            {!sidebarCollapsed && (
              <span style={{
                fontSize: '1.28rem',
                fontWeight: 800,
                color: '#FFFFFF',
                letterSpacing: '-0.02em',
              }}>
                Curo
              </span>
            )}
          </div>

          <button
            onClick={() => setMobileMenuOpen(false)}
            style={{
              display: 'none',
              background: 'transparent',
              color: 'var(--text-secondary)',
              padding: 4,
            }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Navigation Links */}
        <div style={{
          flex: 1,
          padding: sidebarCollapsed ? '16px 8px' : '16px 12px',
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          overflowY: 'auto',
        }}>
          {navItems.map((item) => {
            const isActive = activeTab === item.id;

            return (
              <button
                key={item.id}
                onClick={() => {
                  onTabChange(item.id);
                  setMobileMenuOpen(false);
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: sidebarCollapsed ? 'center' : 'space-between',
                  width: '100%',
                  padding: sidebarCollapsed ? '11px 0' : '10px 14px',
                  borderRadius: 8,
                  background: isActive ? 'rgba(37, 99, 235, 0.16)' : 'transparent',
                  border: isActive ? '1px solid rgba(59, 130, 246, 0.25)' : '1px solid transparent',
                  color: isActive ? '#3B82F6' : '#94A3B8',
                  fontWeight: isActive ? 600 : 500,
                  fontSize: '0.88rem',
                  textAlign: 'left',
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                }}
                onMouseEnter={(e) => {
                  if (!isActive) {
                    e.currentTarget.style.background = 'rgba(255, 255, 255, 0.04)';
                    e.currentTarget.style.color = '#FFFFFF';
                  }
                }}
                onMouseLeave={(e) => {
                  if (!isActive) {
                    e.currentTarget.style.background = 'transparent';
                    e.currentTarget.style.color = '#94A3B8';
                  }
                }}
                title={sidebarCollapsed ? item.label : undefined}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span style={{
                    color: isActive ? '#3B82F6' : '#64748B',
                    display: 'flex',
                    alignItems: 'center',
                  }}>
                    {item.icon}
                  </span>
                  {!sidebarCollapsed && <span>{item.label}</span>}
                </div>

                {!sidebarCollapsed && item.badge && (
                  <span
                    className={`badge ${item.badge.color}`}
                    style={{ fontSize: '0.68rem', padding: '1px 7px' }}
                  >
                    {item.badge.count}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Bottom User Area & Logout */}
        {!sidebarCollapsed ? (
          <div style={{
            padding: '14px 16px',
            borderTop: '1px solid var(--border-subtle)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
              <div style={{
                width: 32,
                height: 32,
                borderRadius: '50%',
                background: '#2563EB',
                color: '#FFFFFF',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontWeight: 700,
                fontSize: '0.82rem',
                flexShrink: 0,
              }}>
                {user?.name ? user.name[0].toUpperCase() : 'C'}
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{
                  fontSize: '0.82rem',
                  fontWeight: 600,
                  color: '#FFFFFF',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}>
                  {user?.name || 'CuroAI Admin'}
                </div>
                <div style={{
                  fontSize: '0.7rem',
                  color: '#64748B',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}>
                  {user?.role || 'Administrator'}
                </div>
              </div>
            </div>

            <button
              onClick={onLogout}
              style={{
                width: 30,
                height: 30,
                borderRadius: 6,
                background: 'transparent',
                border: 'none',
                color: '#64748B',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
                transition: 'color 0.15s ease',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.color = '#FB7185')}
              onMouseLeave={(e) => (e.currentTarget.style.color = '#64748B')}
              title="Sign Out"
              aria-label="Sign out"
            >
              <LogOut size={16} />
            </button>
          </div>
        ) : (
          <div style={{
            padding: '16px 0',
            borderTop: '1px solid var(--border-subtle)',
            display: 'flex',
            justifyContent: 'center',
          }}>
            <button
              onClick={onLogout}
              style={{
                width: 32,
                height: 32,
                borderRadius: '50%',
                background: '#2563EB',
                border: 'none',
                color: '#FFFFFF',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                fontWeight: 700,
                fontSize: '0.82rem',
              }}
              title="Sign Out"
            >
              <LogOut size={14} />
            </button>
          </div>
        )}
      </aside>

      {/* Main Content Shell */}
      <div style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        height: '100vh',
        overflowY: 'auto',
      }}>
        {/* Top Control Bar (matching screenshot top bar) */}
        <header style={{
          position: 'sticky',
          top: 0,
          zIndex: 40,
          background: 'rgba(7, 9, 14, 0.92)',
          backdropFilter: 'blur(16px)',
          WebkitBackdropFilter: 'blur(16px)',
          borderBottom: '1px solid var(--border-subtle)',
          padding: '14px 32px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 16,
        }}>
          {/* Breadcrumbs: CuroAI / Dashboard */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button
              onClick={() => setMobileMenuOpen(true)}
              style={{
                display: 'none',
                background: 'rgba(255, 255, 255, 0.05)',
                border: '1px solid var(--border-subtle)',
                color: '#FFFFFF',
                padding: '6px 8px',
                borderRadius: 6,
              }}
            >
              <Menu size={16} />
            </button>

            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: '0.86rem',
              color: '#64748B',
            }}>
              <span style={{ color: '#94A3B8', fontWeight: 500 }}>CuroAI</span>
              <span style={{ color: '#475569' }}>/</span>
              <span style={{ color: '#FFFFFF', fontWeight: 600 }}>
                {getBreadcrumbTitle(activeTab)}
              </span>
            </div>
          </div>

          {/* Right Header Toolbar: 4,874 credits & User Profile */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            {/* Refresh telemetry */}
            <button
              onClick={onRefresh}
              disabled={loading}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                background: 'rgba(255, 255, 255, 0.04)',
                border: '1px solid rgba(255, 255, 255, 0.09)',
                color: '#94A3B8',
                padding: '7px 11px',
                borderRadius: 8,
                fontSize: '0.8rem',
                cursor: 'pointer',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.color = '#FFFFFF')}
              onMouseLeave={(e) => (e.currentTarget.style.color = '#94A3B8')}
              title="Refresh telemetry"
            >
              <RefreshCw size={13} style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }} />
            </button>

            {/* Credit Pill: [wallet icon] 4,874 credits */}
            <button
              onClick={() => onTabChange('BILLING')}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '7px 14px',
                borderRadius: 8,
                background: 'rgba(37, 99, 235, 0.12)',
                border: '1px solid rgba(59, 130, 246, 0.28)',
                color: '#60A5FA',
                fontSize: '0.82rem',
                fontWeight: 600,
                cursor: 'pointer',
                transition: 'all 0.15s ease',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'rgba(37, 99, 235, 0.2)';
                e.currentTarget.style.borderColor = 'rgba(59, 130, 246, 0.45)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'rgba(37, 99, 235, 0.12)';
                e.currentTarget.style.borderColor = 'rgba(59, 130, 246, 0.28)';
              }}
            >
              <Wallet size={15} color="#38BDF8" />
              <span>{credits.toLocaleString()} credits</span>
            </button>

            {/* User Avatar & Info */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{
                width: 32,
                height: 32,
                borderRadius: '50%',
                background: '#2563EB',
                color: '#FFFFFF',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontWeight: 700,
                fontSize: '0.82rem',
                flexShrink: 0,
              }}>
                {user?.name ? user.name[0].toUpperCase() : 'C'}
              </div>

              <div style={{ display: 'flex', flexDirection: 'column' }}>
                <span style={{ fontSize: '0.82rem', fontWeight: 600, color: '#FFFFFF', lineHeight: 1.2 }}>
                  {user?.name || 'CuroAI Admin'}
                </span>
                <span style={{ fontSize: '0.7rem', color: '#64748B' }}>
                  {user?.role || 'Administrator'}
                </span>
              </div>
            </div>
          </div>
        </header>

        {/* Workspace Body */}
        <main style={{
          flex: 1,
          padding: '28px 32px',
          maxWidth: 1440,
          width: '100%',
          boxSizing: 'border-box',
        }}>
          {children}
        </main>
      </div>
    </div>
  );
};
