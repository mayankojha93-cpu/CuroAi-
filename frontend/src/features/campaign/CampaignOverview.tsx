import React from 'react';
import { BarChart3, Users, PhoneCall, PhoneOff, CalendarCheck } from 'lucide-react';
import type { CampaignSummary } from '../../types';

interface CampaignOverviewProps {
  summary: CampaignSummary | null;
  loading: boolean;
}

export const CampaignOverview: React.FC<CampaignOverviewProps> = ({ summary, loading }) => {
  if (loading && !summary) {
    return (
      <div style={{ padding: '60px 0', textAlign: 'center', color: 'var(--text-muted)' }}>
        Loading Campaign MIS Overview...
      </div>
    );
  }

  const overview = summary?.overview || {
    sourceRows: 0,
    uniqueContacts: 0,
    connectedCalls: 0,
    totalAttempts: 0,
    dispositionedContacts: 0,
  };

  const categories = summary?.categories || [];

  const connectedPercent = overview.sourceRows > 0
    ? Math.round((overview.connectedCalls / overview.sourceRows) * 100)
    : 0;

  const disconnectedCount = overview.sourceRows - overview.connectedCalls;
  const disconnectedPercent = overview.sourceRows > 0
    ? Math.round((disconnectedCount / overview.sourceRows) * 100)
    : 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      {/* Hero Header with MIS Title */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: 12,
      }}>
        <div>
          <h2 style={{ fontSize: '1.4rem', fontWeight: 800, color: '#fff', letterSpacing: '-0.02em' }}>
            Airtel IP TV Urgent Campaign Summary (MIS)
          </h2>
          <p style={{ fontSize: '0.84rem', color: 'var(--text-muted)' }}>
            Audited performance metrics, live connection rates, and categorical dispositions
          </p>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="badge badge-green" style={{ fontSize: '0.78rem', padding: '4px 10px' }}>
            <span className="pulse-indicator" style={{ background: '#10b981' }}></span>
            Live Campaign Sync
          </span>
        </div>
      </div>

      {/* 5 Audited KPI Cards (Matching Image 1 & Database) */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
        gap: 16,
      }}>
        {/* Total Base Uploaded */}
        <div className="glass-panel" style={{ padding: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <span style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
              Total Base Uploaded
            </span>
            <div style={{
              width: 34,
              height: 34,
              borderRadius: 8,
              background: 'rgba(59, 130, 246, 0.15)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--accent-blue)',
            }}>
              <Users size={18} />
            </div>
          </div>
          <div style={{ fontSize: '2rem', fontWeight: 800, color: '#fff', lineHeight: 1 }}>
            {overview.sourceRows.toLocaleString()}
          </div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 8 }}>
            Unique Contacts: <strong style={{ color: '#fff' }}>{overview.uniqueContacts}</strong>
          </div>
        </div>

        {/* Connected Calls (Ring Done) */}
        <div className="glass-panel" style={{ padding: 20, borderColor: 'rgba(16, 185, 129, 0.25)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <span style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--accent-green)', textTransform: 'uppercase' }}>
              Connected (Ring Done)
            </span>
            <div style={{
              width: 34,
              height: 34,
              borderRadius: 8,
              background: 'rgba(16, 185, 129, 0.15)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--accent-green)',
            }}>
              <PhoneCall size={18} />
            </div>
          </div>
          <div style={{ fontSize: '2rem', fontWeight: 800, color: 'var(--accent-green)', lineHeight: 1 }}>
            {overview.connectedCalls.toLocaleString()}
          </div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 8 }}>
            Connection Rate: <strong style={{ color: 'var(--accent-green)' }}>{connectedPercent}%</strong>
          </div>
        </div>

        {/* Disconnected / Ring No Answer */}
        <div className="glass-panel" style={{ padding: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <span style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--accent-amber)', textTransform: 'uppercase' }}>
              Disconnected / RNA
            </span>
            <div style={{
              width: 34,
              height: 34,
              borderRadius: 8,
              background: 'rgba(245, 158, 11, 0.15)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--accent-amber)',
            }}>
              <PhoneOff size={18} />
            </div>
          </div>
          <div style={{ fontSize: '2rem', fontWeight: 800, color: 'var(--accent-amber)', lineHeight: 1 }}>
            {disconnectedCount > 0 ? disconnectedCount.toLocaleString() : 0}
          </div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 8 }}>
            Scheduled for 3-Hour Retry ({disconnectedPercent}%)
          </div>
        </div>

        {/* Total Call Attempts */}
        <div className="glass-panel" style={{ padding: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <span style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--accent-cyan)', textTransform: 'uppercase' }}>
              Total Dial Attempts
            </span>
            <div style={{
              width: 34,
              height: 34,
              borderRadius: 8,
              background: 'rgba(6, 182, 212, 0.15)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--accent-cyan)',
            }}>
              <BarChart3 size={18} />
            </div>
          </div>
          <div style={{ fontSize: '2rem', fontWeight: 800, color: '#fff', lineHeight: 1 }}>
            {overview.totalAttempts.toLocaleString()}
          </div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 8 }}>
            Max 3 attempts per subscriber
          </div>
        </div>

        {/* Closed / Upgraded Conversions */}
        <div className="glass-panel" style={{ padding: 20, borderColor: 'rgba(228, 0, 0, 0.3)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <span style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--airtel-red)', textTransform: 'uppercase' }}>
              Pickup Scheduled
            </span>
            <div style={{
              width: 34,
              height: 34,
              borderRadius: 8,
              background: 'rgba(228, 0, 0, 0.15)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--airtel-red)',
            }}>
              <CalendarCheck size={18} />
            </div>
          </div>
          <div style={{ fontSize: '2rem', fontWeight: 800, color: 'var(--airtel-red)', lineHeight: 1 }}>
            {overview.dispositionedContacts.toLocaleString()}
          </div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 8 }}>
            Technician visit confirmed
          </div>
        </div>
      </div>

      {/* Categorical Dispositions Table (Replicating MIS Breakdown) */}
      <div className="glass-panel" style={{ padding: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
          <div>
            <h3 style={{ fontSize: '1.05rem', fontWeight: 700, color: '#fff' }}>
              Audited Category Dispositions Breakdown
            </h3>
            <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
              Breakdown across Connected, Disconnected, DND, Language Barrier & Converted
            </p>
          </div>
          <span className="badge badge-neutral" style={{ fontSize: '0.75rem' }}>
            5 Categories Monitored
          </span>
        </div>

        {categories.length === 0 ? (
          <div style={{ padding: '30px 0', textAlign: 'center', color: 'var(--text-muted)' }}>
            No campaign calls recorded yet. Click <strong>"Add Test Lead"</strong> or dial a customer to populate.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {categories.map((cat, idx) => {
              const categoryTotal = cat.dispositions.reduce((acc, d) => acc + d.count, 0);
              const percentageOfSource = overview.sourceRows > 0
                ? Math.round((categoryTotal / overview.sourceRows) * 100)
                : 0;

              return (
                <div key={idx} style={{
                  background: 'rgba(255, 255, 255, 0.02)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 'var(--radius-md)',
                  padding: 16,
                }}>
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    marginBottom: 10,
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{ fontWeight: 700, color: '#fff', fontSize: '0.92rem' }}>
                        {cat.category}
                      </span>
                      <span className="badge badge-blue" style={{ fontSize: '0.72rem' }}>
                        {categoryTotal} Total
                      </span>
                    </div>
                    <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 600 }}>
                      {percentageOfSource}% of Base
                    </span>
                  </div>

                  {/* Progress bar */}
                  <div style={{
                    width: '100%',
                    height: 6,
                    background: 'rgba(255, 255, 255, 0.08)',
                    borderRadius: 3,
                    overflow: 'hidden',
                    marginBottom: 12,
                  }}>
                    <div style={{
                      width: `${Math.min(percentageOfSource, 100)}%`,
                      height: '100%',
                      background: cat.category === 'Connected' 
                        ? 'var(--accent-green)' 
                        : cat.category === 'Disconnected' 
                        ? 'var(--accent-amber)' 
                        : 'var(--airtel-red)',
                      transition: 'width 0.3s ease',
                    }} />
                  </div>

                  {/* Individual Dispositions */}
                  <div style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                    gap: 8,
                  }}>
                    {cat.dispositions.map((disp, dIdx) => (
                      <div key={dIdx} style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        background: 'rgba(0, 0, 0, 0.2)',
                        padding: '6px 10px',
                        borderRadius: 'var(--radius-sm)',
                        fontSize: '0.78rem',
                      }}>
                        <span style={{ color: 'var(--text-secondary)' }}>{disp.name}</span>
                        <strong style={{ color: '#fff' }}>{disp.count}</strong>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
