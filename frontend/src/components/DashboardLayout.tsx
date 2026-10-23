import React, { useState } from 'react';
import { 
  BarChart3, 
  Users, 
  PhoneCall, 
  RotateCcw, 
  BookOpen, 
  UploadCloud, 
  RefreshCw, 
  LogOut, 
  Menu, 
  X
} from 'lucide-react';
import type { TabKey, SystemHealth, AuthUser } from '../types';

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

const TAB_CONFIG: {
  id: TabKey;
  label: string;
  icon: React.ReactNode;
  description: string;
}[] = [
  {
    id: 'CAMPAIGN',
    label: 'Campaign Overview',
    icon: <BarChart3 size={18} />,
    description: 'Real-time MIS analytics & disposition distribution',
  },
  {
    id: 'LEADS',
    label: 'Lead Directory',
    icon: <Users size={18} />,
    description: 'Subscriber contacts, router pickup status & outbound dialing',
  },
  {
    id: 'CALLS',
    label: 'Recent Calls',
    icon: <PhoneCall size={18} />,
    description: 'Turn-by-turn transcripts, latency audits & audio playback',
  },
  {
    id: 'RETRIES',
    label: 'Retry Queue',
    icon: <RotateCcw size={18} />,
    description: '3-hour cooldown pool & scheduled reconnects',
  },
  {
    id: 'SOP',
    label: '17 SOP Scenarios',
    icon: <BookOpen size={18} />,
    description: 'Approved FAQ guidelines & objection handling rules',
  },
];

export const DashboardLayout: React.FC<DashboardLayoutProps> = ({
  activeTab,
  onTabChange,
  leadsCount,
  callsCount,
  retriesCount,
  health: _health,
  loading,
  onRefresh,
  onImportModalOpen,
  onTestCallOpen,
  user,
  onLogout,
  children,
}) => {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const getTabBadge = (id: TabKey) => {
    if (id === 'LEADS' && leadsCount > 0) return { count: leadsCount, color: 'badge-green' };
    if (id === 'CALLS' && callsCount > 0) return { count: callsCount, color: 'badge-blue' };
    if (id === 'RETRIES' && retriesCount > 0) return { count: retriesCount, color: 'badge-amber' };
    if (id === 'SOP') return { count: '17 SOP', color: 'badge-neutral' };
    return null;
  };

  const currentTabMeta = TAB_CONFIG.find((t) => t.id === activeTab) || TAB_CONFIG[0];

  return (
    <div style={{
      display: 'flex',
      minHeight: '100vh',
      background: 'var(--bg-primary)',
      color: 'var(--text-primary)',
      position: 'relative',
    }}>
      {/* Mobile Overlay */}
      {mobileMenuOpen && (
        <div
          onClick={() => setMobileMenuOpen(false)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.7)',
            backdropFilter: 'blur(4px)',
            zIndex: 90,
          }}
        />
      )}

      {/* Left Navigation Sidebar */}
      <aside 
        className={mobileMenuOpen ? 'mobile-open' : ''}
        style={{
        width: 270,
        flexShrink: 0,
        background: 'var(--bg-sidebar)',
        borderRight: '1px solid var(--border-subtle)',
        display: 'flex',
        flexDirection: 'column',
        position: 'sticky',
        top: 0,
        height: '100vh',
        zIndex: 100,
        transition: 'transform 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
      }}>
        {/* Brand Header */}
        <div style={{
          padding: '22px 20px',
          borderBottom: '1px solid var(--border-subtle)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{
              width: 38,
              height: 38,
              borderRadius: 10,
              background: 'linear-gradient(135deg, rgba(16, 185, 129, 0.25) 0%, rgba(5, 150, 105, 0.4) 100%)',
              border: '1px solid rgba(16, 185, 129, 0.4)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 0 16px rgba(16, 185, 129, 0.2)',
              color: '#34D399',
            }}>
              <PhoneCall size={18} />
            </div>

            <div>
              <span style={{
                fontSize: '1.05rem',
                fontWeight: 700,
                letterSpacing: '-0.02em',
                color: '#fff',
              }}>
                Curo <span style={{ color: 'var(--curo-emerald)' }}>AI</span>
              </span>
              <p style={{ fontSize: '0.74rem', color: 'var(--text-muted)', marginTop: 2 }}>
                Airtel Wi-Fi Router Campaign
              </p>
            </div>
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
        <div style={{ flex: 1, padding: '18px 12px', display: 'flex', flexDirection: 'column', gap: 4, overflowY: 'auto' }}>
          <div style={{
            fontSize: '0.68rem',
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            color: 'var(--text-muted)',
            padding: '6px 10px',
            marginBottom: 4,
          }}>
            Operations Workspace
          </div>

          {TAB_CONFIG.map((tab) => {
            const isActive = activeTab === tab.id;
            const badge = getTabBadge(tab.id);

            return (
              <button
                key={tab.id}
                onClick={() => {
                  onTabChange(tab.id);
                  setMobileMenuOpen(false);
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  width: '100%',
                  padding: '10px 14px',
                  borderRadius: 'var(--radius-md)',
                  background: isActive ? 'rgba(16, 185, 129, 0.12)' : 'transparent',
                  border: isActive ? '1px solid rgba(16, 185, 129, 0.25)' : '1px solid transparent',
                  color: isActive ? '#fff' : 'var(--text-secondary)',
                  fontWeight: isActive ? 600 : 500,
                  fontSize: '0.86rem',
                  textAlign: 'left',
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                }}
                onMouseEnter={(e) => {
                  if (!isActive) {
                    e.currentTarget.style.background = 'rgba(255, 255, 255, 0.04)';
                    e.currentTarget.style.color = '#fff';
                  }
                }}
                onMouseLeave={(e) => {
                  if (!isActive) {
                    e.currentTarget.style.background = 'transparent';
                    e.currentTarget.style.color = 'var(--text-secondary)';
                  }
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ color: isActive ? 'var(--curo-emerald)' : 'var(--text-muted)' }}>
                    {tab.icon}
                  </span>
                  <span>{tab.label}</span>
                </div>

                {badge && (
                  <span
                    className={`badge ${badge.color}`}
                    style={{ fontSize: '0.68rem', padding: '1px 7px' }}
                  >
                    {badge.count}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* User Card & Logout Dock */}
        <div style={{
          padding: '14px 16px',
          borderTop: '1px solid var(--border-subtle)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          background: 'rgba(0, 0, 0, 0.2)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <div style={{
              width: 32,
              height: 32,
              borderRadius: '50%',
              background: 'linear-gradient(135deg, #1F382B 0%, #0F2018 100%)',
              border: '1px solid rgba(16, 185, 129, 0.3)',
              color: 'var(--curo-emerald)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 700,
              fontSize: '0.78rem',
              flexShrink: 0,
            }}>
              {user?.name ? user.name.slice(0, 2).toUpperCase() : 'AD'}
            </div>

            <div style={{ minWidth: 0 }}>
              <div style={{
                fontSize: '0.82rem',
                fontWeight: 600,
                color: '#fff',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}>
                {user?.name || 'Administrator'}
              </div>
              <div style={{
                fontSize: '0.7rem',
                color: 'var(--text-muted)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}>
                {user?.email || 'admin@curoai.in'}
              </div>
            </div>
          </div>

          <button
            onClick={onLogout}
            style={{
              width: 32,
              height: 32,
              borderRadius: 'var(--radius-md)',
              background: 'rgba(251, 113, 133, 0.08)',
              border: '1px solid rgba(251, 113, 133, 0.25)',
              color: '#FB7185',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              transition: 'all 0.15s ease',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'rgba(251, 113, 133, 0.2)';
              e.currentTarget.style.color = '#fff';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'rgba(251, 113, 133, 0.08)';
              e.currentTarget.style.color = '#FB7185';
            }}
            title="Sign out of Operations Console"
            aria-label="Sign out"
          >
            <LogOut size={15} />
          </button>
        </div>
      </aside>

      {/* Main Workspace Body */}
      <div style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        height: '100vh',
        overflowY: 'auto',
      }}>
        {/* Top Control Bar */}
        <header style={{
          position: 'sticky',
          top: 0,
          zIndex: 40,
          background: 'rgba(8, 12, 10, 0.85)',
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          borderBottom: '1px solid var(--border-subtle)',
          padding: '14px 28px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 16,
        }}>
          {/* Breadcrumb & Section Title */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button
              onClick={() => setMobileMenuOpen(true)}
              style={{
                display: 'none',
                background: 'rgba(255, 255, 255, 0.05)',
                border: '1px solid var(--border-subtle)',
                color: '#fff',
                padding: '6px 8px',
                borderRadius: 'var(--radius-sm)',
              }}
            >
              <Menu size={16} />
            </button>

            <div>
              <h1 style={{
                fontSize: '1.18rem',
                fontWeight: 700,
                color: '#fff',
                letterSpacing: '-0.02em',
              }}>
                {currentTabMeta.label}
              </h1>
              <p style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: 2 }}>
                {currentTabMeta.description}
              </p>
            </div>
          </div>

          {/* Quick Action Toolbar */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {/* Import Leads Button */}
            <button
              onClick={onImportModalOpen}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 7,
                background: 'rgba(255, 255, 255, 0.04)',
                border: '1px solid var(--border-light)',
                color: 'var(--text-primary)',
                padding: '8px 14px',
                borderRadius: 'var(--radius-md)',
                fontSize: '0.82rem',
                fontWeight: 600,
                cursor: 'pointer',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'rgba(255, 255, 255, 0.08)';
                e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.25)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'rgba(255, 255, 255, 0.04)';
                e.currentTarget.style.borderColor = 'var(--border-light)';
              }}
              title="Import CSV batch leads"
            >
              <UploadCloud size={15} color="var(--curo-emerald)" />
              Import Leads
            </button>

            {/* Test AI Call Button */}
            <button
              onClick={onTestCallOpen}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 7,
                background: 'linear-gradient(135deg, #10B981 0%, #059669 100%)',
                border: '1px solid rgba(16, 185, 129, 0.5)',
                color: '#fff',
                padding: '8px 16px',
                borderRadius: 'var(--radius-md)',
                fontSize: '0.82rem',
                fontWeight: 700,
                boxShadow: '0 0 16px rgba(16, 185, 129, 0.3)',
                cursor: 'pointer',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.boxShadow = '0 0 24px rgba(16, 185, 129, 0.5)';
                e.currentTarget.style.transform = 'translateY(-1px)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.boxShadow = '0 0 16px rgba(16, 185, 129, 0.3)';
                e.currentTarget.style.transform = 'translateY(0)';
              }}
              title="Launch Test AI Outbound Call"
            >
              <PhoneCall size={14} />
              Test AI Call
            </button>

            {/* Refresh Button */}
            <button
              onClick={onRefresh}
              disabled={loading}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                background: 'rgba(255, 255, 255, 0.04)',
                border: '1px solid var(--border-light)',
                color: 'var(--text-secondary)',
                padding: '8px 12px',
                borderRadius: 'var(--radius-md)',
                fontSize: '0.82rem',
                cursor: 'pointer',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.color = '#fff')}
              onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-secondary)')}
              title="Refresh campaign telemetry"
            >
              <RefreshCw size={14} style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }} />
            </button>
          </div>
        </header>

        {/* Content Workspace */}
        <main style={{
          flex: 1,
          padding: '24px 28px',
          maxWidth: 1400,
          width: '100%',
        }}>
          {children}
        </main>
      </div>
    </div>
  );
};
