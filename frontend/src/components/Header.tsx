import React from 'react';
import { PhoneCall, Cpu, Activity, Database, RefreshCw, PlusCircle, UploadCloud, Globe, LogOut, User } from 'lucide-react';
import type { SystemHealth, AuthUser } from '../types';

interface HeaderProps {
  health: SystemHealth | null;
  loading: boolean;
  onRefresh: () => void;
  onSeedLead: () => void;
  onImportModalOpen?: () => void;
  onTestCallOpen?: () => void;
  onBackToLanding?: () => void;
  user?: AuthUser | null;
  onLogout?: () => void;
}

export const Header: React.FC<HeaderProps> = ({ 
  health, 
  loading, 
  onRefresh, 
  onSeedLead,
  onImportModalOpen,
  onTestCallOpen,
  onBackToLanding,
  user,
  onLogout
}) => {
  return (
    <header style={{
      borderBottom: '1px solid var(--border-subtle)',
      background: 'rgba(10, 14, 23, 0.85)',
      backdropFilter: 'blur(16px)',
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
            width: 44,
            height: 44,
            borderRadius: 12,
            background: 'linear-gradient(135deg, #e40000 0%, #8b0000 100%)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 0 20px rgba(228, 0, 0, 0.4)',
            color: '#fff',
          }}>
            <PhoneCall size={22} />
          </div>

          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <h1 style={{ fontSize: '1.25rem', fontWeight: 800, color: '#fff', letterSpacing: '-0.02em' }}>
                Airtel <span style={{ color: 'var(--airtel-red)' }}>Voice AI</span>
              </h1>
              <span className="badge badge-red" style={{ fontSize: '0.68rem', padding: '2px 8px' }}>
                <span className="pulse-indicator" style={{ background: '#ff4d4d', boxShadow: '0 0 8px #ff4d4d' }}></span>
                Agent: Priya (AI)
              </span>
            </div>
            <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
              Outbound Wi-Fi Router Pickup & Telecom Campaign Engine
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
            <Cpu size={14} color="var(--accent-cyan)" />
            <span style={{ color: 'var(--text-secondary)' }}>Groq Qwen + Sarvam</span>
            <span style={{ color: 'var(--accent-green)', fontWeight: 600 }}>~₹2.4/min</span>
          </div>

          <div className="glass-panel" style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '6px 12px',
            borderRadius: 20,
            fontSize: '0.78rem',
          }}>
            <Activity size={14} color="var(--accent-blue)" />
            <span style={{ color: 'var(--text-secondary)' }}>Exotel SIP (In & Out):</span>
            <span style={{ color: 'var(--accent-green)', fontWeight: 600 }}>Active</span>
          </div>

          <div className="glass-panel" style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '6px 12px',
            borderRadius: 20,
            fontSize: '0.78rem',
          }}>
            <Database size={14} color={health?.database.connected ? 'var(--accent-green)' : 'var(--accent-rose)'} />
            <span style={{ color: 'var(--text-secondary)' }}>Postgres:</span>
            <span style={{
              color: health?.database.connected ? 'var(--accent-green)' : 'var(--accent-rose)',
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
                background: 'rgba(255, 255, 255, 0.08)',
                border: '1px solid var(--border-light)',
                color: '#fff',
                padding: '8px 14px',
                borderRadius: 'var(--radius-md)',
                fontSize: '0.82rem',
                fontWeight: 600,
              }}
              title="Import campaign leads batch"
            >
              <UploadCloud size={15} color="var(--accent-blue)" />
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
                background: 'rgba(228, 0, 0, 0.12)',
                border: '1px solid rgba(228, 0, 0, 0.45)',
                color: '#ff4d4d',
                padding: '8px 14px',
                borderRadius: 'var(--radius-md)',
                fontSize: '0.82rem',
                fontWeight: 700,
                boxShadow: '0 0 12px rgba(228, 0, 0, 0.25)',
                cursor: 'pointer',
              }}
              title="Open Developer Test Call Console"
            >
              <PhoneCall size={14} />
              Test AI Call
            </button>
          )}

          {onBackToLanding && (
            <button
              onClick={onBackToLanding}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                background: 'rgba(200, 173, 126, 0.12)',
                border: '1px solid rgba(200, 173, 126, 0.4)',
                color: '#e4d3b6',
                padding: '8px 14px',
                borderRadius: 'var(--radius-md)',
                fontSize: '0.82rem',
                fontWeight: 600,
                cursor: 'pointer',
              }}
              title="Return to Curo AI Landing Page"
            >
              <Globe size={15} />
              Website
            </button>
          )}

          <button
            onClick={onSeedLead}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              background: 'rgba(255, 255, 255, 0.08)',
              border: '1px solid var(--border-light)',
              color: '#fff',
              padding: '8px 14px',
              borderRadius: 'var(--radius-md)',
              fontSize: '0.82rem',
              fontWeight: 600,
            }}
            title="Add a test lead to database"
          >
            <PlusCircle size={15} color="var(--accent-cyan)" />
            Add Test Lead
          </button>

          <button
            onClick={onRefresh}
            disabled={loading}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              background: 'linear-gradient(135deg, var(--airtel-red) 0%, var(--airtel-red-dark) 100%)',
              color: '#fff',
              padding: '8px 16px',
              borderRadius: 'var(--radius-md)',
              fontSize: '0.82rem',
              fontWeight: 700,
              boxShadow: '0 2px 10px rgba(228, 0, 0, 0.35)',
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
              background: 'rgba(255, 255, 255, 0.05)',
              border: '1px solid rgba(255, 255, 255, 0.1)',
              fontSize: '0.8rem',
            }}>
              <User size={14} color="var(--accent-cyan)" />
              <span style={{ color: '#fff', fontWeight: 600 }}>{user.name}</span>
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
                background: 'rgba(244, 63, 94, 0.1)',
                border: '1px solid rgba(244, 63, 94, 0.3)',
                color: '#fda4af',
                padding: '8px 12px',
                borderRadius: 'var(--radius-md)',
                fontSize: '0.82rem',
                fontWeight: 600,
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
