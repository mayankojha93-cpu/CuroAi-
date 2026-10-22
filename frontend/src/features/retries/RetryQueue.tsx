import React from 'react';
import { RotateCcw, Clock, Phone, ShieldCheck } from 'lucide-react';
import type { Customer } from '../../types';

interface RetryQueueProps {
  retries: Customer[];
  onDial: (customerId: string, name?: string) => void;
  dialingId: string | null;
}

export const RetryQueue: React.FC<RetryQueueProps> = ({ retries, onDial, dialingId }) => {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Policy card */}
      <div className="glass-panel" style={{
        padding: 20,
        background: 'linear-gradient(135deg, rgba(245, 158, 11, 0.08) 0%, rgba(15, 23, 42, 0.6) 100%)',
        borderColor: 'rgba(245, 158, 11, 0.3)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <RotateCcw size={18} color="var(--accent-amber)" />
          <h3 style={{ fontSize: '1.05rem', fontWeight: 700, color: '#fff' }}>
            Airtel Approved Retry Engine Policy (Image 5 Rules)
          </h3>
        </div>
        <p style={{ fontSize: '0.84rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
          Customers who encounter <strong style={{ color: '#fff' }}>NO_ANSWER</strong>, <strong style={{ color: '#fff' }}>BUSY</strong>, <strong style={{ color: '#fff' }}>VOICEMAIL</strong>, <strong style={{ color: '#fff' }}>NO_RESPONSE</strong>, or <strong style={{ color: '#fff' }}>DISCONNECTED</strong> are automatically spaced:
          <strong> Attempt 2</strong> occurs after at least a <strong>3-hour cooldown</strong>; <strong>Attempt 3</strong> is scheduled for the next calling day at 10:30 AM. After 3 attempts, leads are closed as <strong style={{ color: 'var(--accent-rose)' }}>NOT_REACHED</strong>.
        </p>
      </div>

      {/* Queue Table */}
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
              <th style={{ padding: '14px 18px' }}>Customer Lead</th>
              <th style={{ padding: '14px 18px' }}>Phone</th>
              <th style={{ padding: '14px 18px' }}>Previous Outcome</th>
              <th style={{ padding: '14px 18px' }}>Attempts Made</th>
              <th style={{ padding: '14px 18px' }}>Scheduled Next Attempt</th>
              <th style={{ padding: '14px 18px', textAlign: 'right' }}>Override Action</th>
            </tr>
          </thead>
          <tbody>
            {retries.length === 0 ? (
              <tr>
                <td colSpan={6} style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>
                  <ShieldCheck size={28} color="var(--accent-green)" style={{ margin: '0 auto 8px' }} />
                  <div>No leads currently waiting in retry cooldown queue.</div>
                </td>
              </tr>
            ) : (
              retries.map((cust) => {
                const isDialing = dialingId === cust.id;
                const nextTime = cust.next_attempt_time ? new Date(cust.next_attempt_time) : null;
                const isReady = nextTime ? nextTime <= new Date() : true;

                return (
                  <tr
                    key={cust.id}
                    style={{ borderBottom: '1px solid var(--border-subtle)' }}
                  >
                    <td style={{ padding: '14px 18px' }}>
                      <div style={{ fontWeight: 600, color: '#fff' }}>{cust.name}</div>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                        Acc: {cust.account_no || cust.subs_del_no || '—'}
                      </div>
                    </td>

                    <td style={{ padding: '14px 18px', color: 'var(--text-secondary)' }}>
                      {cust.phone}
                    </td>

                    <td style={{ padding: '14px 18px' }}>
                      <span className="badge badge-amber">
                        {cust.current_disposition || 'NO_ANSWER'}
                      </span>
                    </td>

                    <td style={{ padding: '14px 18px', fontWeight: 700, color: '#fff' }}>
                      {cust.total_attempts} of {cust.max_attempts}
                    </td>

                    <td style={{ padding: '14px 18px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <Clock size={13} color={isReady ? 'var(--accent-green)' : 'var(--accent-amber)'} />
                        <span style={{
                          color: isReady ? 'var(--accent-green)' : 'var(--text-secondary)',
                          fontWeight: isReady ? 600 : 400,
                          fontSize: '0.82rem',
                        }}>
                          {isReady ? 'Ready for Call' : nextTime?.toLocaleString() || 'Pending'}
                        </span>
                      </div>
                    </td>

                    <td style={{ padding: '14px 18px', textAlign: 'right' }}>
                      <button
                        onClick={() => onDial(cust.id, cust.name)}
                        disabled={isDialing}
                        style={{
                          padding: '6px 14px',
                          borderRadius: 'var(--radius-sm)',
                          background: isReady ? 'var(--airtel-red)' : 'rgba(255, 255, 255, 0.08)',
                          color: '#fff',
                          fontSize: '0.78rem',
                          fontWeight: 600,
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 6,
                          cursor: isDialing ? 'not-allowed' : 'pointer',
                        }}
                      >
                        <Phone size={12} />
                        {isDialing ? 'Dialing...' : isReady ? 'Dial Now' : 'Force Dial'}
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};
