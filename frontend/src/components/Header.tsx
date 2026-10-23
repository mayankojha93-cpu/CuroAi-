import React from 'react';
import { PhoneCall, Cpu, Activity, Database, RefreshCw, UploadCloud, LogOut, User } from 'lucide-react';
import type { SystemHealth, AuthUser } from '../types';

interface HeaderProps {
  health: SystemHealth | null;
  loading: boolean;
  onRefresh: () => void;
  onImportModalOpen?: () => void;
  onTestCallOpen?: () => void;
  user?: AuthUser | null;
  onLogout?: () => void;
}

export const Header: React.FC<HeaderProps> = ({ 
  health, 
  loading, 
  onRefresh, 
  onImportModalOpen,
  onTestCallOpen,
  user,
  onLogout
}) => {
  return (
    <header style={{
      borderBottom: '1px solid var(--border-subtle)',
      background: 'rgba(12, 18, 16, 0.88)',
      backdropFilter: 'blur(20px)',
      WebkitBackdropFilter: 'blur(20px)',
      position: 'sticky',
      top: 0,
      zIndex: 50,
      padding: '14px 28px',
    }}>
      <div style={{
        maxWidth: 1440,
        margin: '0 auto',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: 16,
      }}>
        {/* Logo and Brand */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{
            width: 42,
            height: 42,
            borderRadius: 12,
            background: 'linear-gradient(135deg, rgba(156, 195, 169, 0.2) 0%, rgba(49, 93, 75, 0.3) 100%)',
            border: '1px solid rgba(156, 195, 169, 0.35)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 0 20px rgba(156, 195, 169, 0.15)',
            color: 'var(--curo-sage)',
          }}>
            <PhoneCall size={20} />
          </div>

          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <h1 style={{
                fontSize: '1.25rem',
                fontFamily: 'var(--font-display)',
                fontWeight: 500,
                color: 'var(--text-primary)',
                letterSpacing: '-0.025em',
                lineHeight: 1.2,
              }}>
                Curo <span style={{ color: 'var(--curo-sage)' }}>Voice AI</span>
              </h1>
              <span className="badge badge-green" style={{ fontSize: '0.68rem', padding: '2px 8px' }}>
                <span className="pulse-indicator"></span>
                Agent: Priya
              </span>
            </div>
            <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
              Enterprise Voice Care & Outbound Router Campaign Engine
            </p>
          </div>
        </div>

        {/* Live System Health Pills */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div className="glass-panel" style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '6px 12px',
            borderRadius: 20,
            fontSize: '0.78rem',
          }}>
            <Cpu size={14} color="var(--curo-sage)" />
            <span style={{ color: 'var(--text-secondary)' }}>Groq Qwen + Sarvam</span>
            <span style={{ color: 'var(--curo-sage)', fontWeight: 600 }}>~₹2.4/min</span>
          </div>

          <div className="glass-panel" style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '6px 12px',
            borderRadius: 20,
            fontSize: '0.78rem',
          }}>
            <Activity size={14} color="var(--curo-gold)" />
            <span style={{ color: 'var(--text-secondary)' }}>Exotel SIP:</span>
            <span style={{ color: 'var(--curo-sage)', fontWeight: 600 }}>Active</span>
          </div>

          <div className="glass-panel" style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '6px 12px',
            borderRadius: 20,
            fontSize: '0.78rem',
          }}>
            <Database size={14} color={health?.database.connected ? 'var(--curo-sage)' : 'var(--accent-rose)'} />
            <span style={{ color: 'var(--text-secondary)' }}>Postgres:</span>
            <span style={{
              color: health?.database.connected ? 'var(--curo-sage)' : 'var(--accent-rose)',
              fontWeight: 600
            }}>
              {health?.database.connected ? 'Online' : 'Offline'}
            </span>
          </div>

          {/* Action buttons */}
          {onImportModalOpen && (
            <button
              onClick={onImportModalOpen}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                background: 'rgba(255, 255, 255, 0.05)',
                border: '1px solid var(--border-light)',
                color: 'var(--text-primary)',
                padding: '8px 14px',
                borderRadius: 'var(--radius-md)',
                fontSize: '0.82rem',
                fontWeight: 500,
                cursor: 'pointer',
              }}
              title="Import campaign leads batch"
            >
              <UploadCloud size={15} color="var(--curo-sage)" />
              Import Leads
            </button>
          )}

          {onTestCallOpen && (
            <button
              onClick={onTestCallOpen}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                background: 'var(--curo-sage)',
                border: '1px solid var(--curo-sage)',
                color: 'var(--curo-night)',
                padding: '8px 14px',
                borderRadius: 'var(--radius-md)',
                fontSize: '0.82rem',
                fontWeight: 600,
                boxShadow: '0 2px 10px rgba(156, 195, 169, 0.25)',
                cursor: 'pointer',
              }}
              title="Open Developer Test Call Console"
            >
              <PhoneCall size={14} />
              Test AI Call
            </button>
          )}

          <button
            onClick={onRefresh}
            disabled={loading}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              background: 'rgba(255, 255, 255, 0.05)',
              border: '1px solid var(--border-light)',
              color: 'var(--text-primary)',
              padding: '8px 16px',
              borderRadius: 'var(--radius-md)',
              fontSize: '0.82rem',
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            <RefreshCw size={14} style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }} />
            Refresh
          </button>

          {user && (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 12px',
              borderRadius: 'var(--radius-md)',
              background: 'rgba(156, 195, 169, 0.08)',
              border: '1px solid var(--border-subtle)',
              fontSize: '0.8rem',
            }}>
              <User size={14} color="var(--curo-sage)" />
              <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{user.name}</span>
              <span className="badge badge-neutral" style={{ fontSize: '0.68rem', padding: '1px 6px', textTransform: 'uppercase' }}>
                {user.role}
              </span>
            </div>
          )}

          {onLogout && (
            <button
              onClick={onLogout}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                background: 'rgba(229, 115, 115, 0.08)',
                border: '1px solid rgba(229, 115, 115, 0.25)',
                color: '#ff8a80',
                padding: '8px 12px',
                borderRadius: 'var(--radius-md)',
                fontSize: '0.82rem',
                fontWeight: 500,
                cursor: 'pointer',
              }}
              title="Sign out of Operations Console"
            >
              <LogOut size={14} />
              Logout
            </button>
          )}
        </div>
      </div>
    </header>
  );
};
