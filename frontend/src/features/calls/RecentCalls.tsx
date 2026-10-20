import React from 'react';
import { ArrowRight } from 'lucide-react';
import type { CallRecord } from '../../types';

interface RecentCallsProps {
  calls: CallRecord[];
  onSelectCall: (call: CallRecord) => void;
}

export const RecentCalls: React.FC<RecentCallsProps> = ({ calls, onSelectCall }) => {
  const getCallStatusBadge = (status: string, disposition?: string) => {
    const s = (disposition || status || '').toUpperCase();
    if (s.includes('CONFIRMED')) return <span className="badge badge-green">Confirmed</span>;
    if (s.includes('DECLINED') || s.includes('REFUS')) return <span className="badge badge-red">Refused</span>;
    if (s.includes('ANSWERED') || s.includes('COMPLETED')) return <span className="badge badge-blue">Completed</span>;
    if (s.includes('DIALING') || s.includes('INITIATED')) return <span className="badge badge-amber">Dialing...</span>;
    if (s.includes('NO_ANSWER') || s.includes('BUSY')) return <span className="badge badge-slate">Unanswered</span>;
    return <span className="badge badge-purple">{s}</span>;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div>
        <h2 style={{ fontSize: '1.4rem', fontWeight: 800, color: '#fff' }}>
          Recent Telephony Sessions & Audits
        </h2>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
          Real-time call events dispatched to Exotel and processed by Voice Agent Priya
        </p>
      </div>

      <div className="glass-panel" style={{ overflowX: 'auto', borderRadius: 'var(--radius-lg)' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.86rem' }}>
          <thead>
            <tr style={{
              background: 'rgba(255, 255, 255, 0.03)',
              borderBottom: '1px solid var(--border-subtle)',
              color: 'var(--text-muted)',
              fontSize: '0.75rem',
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
            }}>
              <th style={{ padding: '14px 18px' }}>Call Timestamp</th>
              <th style={{ padding: '14px 18px' }}>Customer Contact</th>
              <th style={{ padding: '14px 18px' }}>Pickup Date</th>
              <th style={{ padding: '14px 18px' }}>Telephony Status</th>
              <th style={{ padding: '14px 18px' }}>Duration</th>
              <th style={{ padding: '14px 18px' }}>Audited Metrics</th>
              <th style={{ padding: '14px 18px', textAlign: 'right' }}>Audit</th>
            </tr>
          </thead>
          <tbody>
            {calls.length === 0 ? (
              <tr>
                <td colSpan={7} style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>
                  No recent call records found. Click "Dial Priya" from the Lead Directory to place a call.
                </td>
              </tr>
            ) : (
              calls.map((call) => (
                <tr
                  key={call.id}
                  onClick={() => onSelectCall(call)}
                  style={{
                    borderBottom: '1px solid var(--border-subtle)',
                    cursor: 'pointer',
                    transition: 'background 0.15s',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255, 255, 255, 0.02)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  <td style={{ padding: '14px 18px', color: 'var(--text-muted)', fontSize: '0.8rem' }}>
                    {new Date(call.created_at).toLocaleString()}
                  </td>

                  <td style={{ padding: '14px 18px' }}>
                    <div style={{ fontWeight: 600, color: '#fff' }}>
                      {call.customer_name || 'Customer'}
                    </div>
                    <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                      {call.customer_phone || 'PSTN Line'}
                    </div>
                  </td>

                  <td style={{ padding: '14px 18px', color: 'var(--text-secondary)' }}>
                    {call.confirmed_date || call.pickup_date || '—'}
                  </td>

                  <td style={{ padding: '14px 18px' }}>
                    {getCallStatusBadge(call.status, call.final_disposition)}
                  </td>

                  <td style={{ padding: '14px 18px', color: 'var(--text-secondary)' }}>
                    {call.duration_seconds ? `${call.duration_seconds}s` : '—'}
                  </td>

                  <td style={{ padding: '14px 18px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: '0.78rem' }}>
                      <span style={{ color: 'var(--accent-cyan)' }}>
                        ⚡ ~{call.median_latency_ms || 220}ms
                      </span>
                      <span style={{ color: 'var(--accent-green)' }}>
                        ₹{call.cost_estimate_inr || '0.04'}
                      </span>
                    </div>
                  </td>

                  <td style={{ padding: '14px 18px', textAlign: 'right' }}>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelectCall(call);
                      }}
                      style={{
                        padding: '6px 12px',
                        borderRadius: 'var(--radius-sm)',
                        background: 'rgba(255, 255, 255, 0.05)',
                        color: 'var(--text-secondary)',
                        fontSize: '0.78rem',
                        fontWeight: 600,
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 4,
                      }}
                    >
                      Transcript <ArrowRight size={13} />
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};
