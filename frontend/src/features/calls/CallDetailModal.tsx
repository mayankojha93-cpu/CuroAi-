import React from 'react';
import { X, Phone, User, Bot, MessageSquare } from 'lucide-react';
import type { CallRecord } from '../../types';

interface CallDetailModalProps {
  call: CallRecord | null;
  onClose: () => void;
}

export const CallDetailModal: React.FC<CallDetailModalProps> = ({ call, onClose }) => {
  if (!call) return null;

  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      background: 'rgba(0, 0, 0, 0.75)',
      backdropFilter: 'blur(8px)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 100,
      padding: 20,
    }} onClick={onClose}>
      <div
        className="glass-panel"
        style={{
          width: '100%',
          maxWidth: 780,
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border-light)',
          borderRadius: 'var(--radius-xl)',
          overflow: 'hidden',
          boxShadow: 'var(--shadow-lg)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{
          padding: '20px 24px',
          borderBottom: '1px solid var(--border-subtle)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          background: 'rgba(255, 255, 255, 0.02)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{
              width: 38,
              height: 38,
              borderRadius: 10,
              background: 'var(--accent-red-glow)',
              color: 'var(--airtel-red)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}>
              <Phone size={20} />
            </div>
            <div>
              <h3 style={{ fontSize: '1.15rem', fontWeight: 800, color: '#fff' }}>
                Call Audit & Transcript
              </h3>
              <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                Room: {call.room_name} | Call ID: {call.id.slice(0, 8)}...
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            style={{
              background: 'rgba(255, 255, 255, 0.08)',
              color: 'var(--text-secondary)',
              border: 'none',
              width: 32,
              height: 32,
              borderRadius: '50%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
            }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Scrollable Content */}
        <div style={{ padding: 24, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* Key Outcome Highlights */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
            gap: 12,
          }}>
            <div className="glass-panel" style={{ padding: 14 }}>
              <span style={{ fontSize: '0.74rem', color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 600 }}>
                Final Disposition
              </span>
              <div style={{ marginTop: 4 }}>
                <span className="badge badge-green" style={{ fontSize: '0.8rem', padding: '4px 10px' }}>
                  {call.final_disposition || call.outcome || 'IN_PROGRESS'}
                </span>
              </div>
            </div>

            <div className="glass-panel" style={{ padding: 14 }}>
              <span style={{ fontSize: '0.74rem', color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 600 }}>
                Confirmed Pickup Date
              </span>
              <div style={{ fontSize: '1rem', fontWeight: 700, color: '#fff', marginTop: 4 }}>
                {call.confirmed_date || call.pickup_date || 'Not Scheduled'}
              </div>
            </div>

            <div className="glass-panel" style={{ padding: 14 }}>
              <span style={{ fontSize: '0.74rem', color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 600 }}>
                Duration & Latency
              </span>
              <div style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--accent-cyan)', marginTop: 4 }}>
                {call.duration_seconds || 0}s | ~{call.median_latency_ms || 220}ms TTFT
              </div>
            </div>

            <div className="glass-panel" style={{ padding: 14 }}>
              <span style={{ fontSize: '0.74rem', color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 600 }}>
                AI Telephony Cost
              </span>
              <div style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--accent-green)', marginTop: 4 }}>
                ₹{call.cost_estimate_inr || '0.04'}
              </div>
            </div>
          </div>

          {/* Customer & Address Details */}
          <div className="glass-panel" style={{ padding: 16 }}>
            <h4 style={{ fontSize: '0.85rem', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 12, letterSpacing: '0.04em' }}>
              Customer Verification & Destination
            </h4>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, fontSize: '0.86rem' }}>
              <div>
                <span style={{ color: 'var(--text-muted)' }}>Customer: </span>
                <strong style={{ color: '#fff' }}>{call.customer_name || 'Customer'}</strong> ({call.customer_phone})
              </div>
              <div>
                <span style={{ color: 'var(--text-muted)' }}>Address Status: </span>
                <strong style={{ color: call.address_confirmed ? 'var(--accent-green)' : 'var(--accent-amber)' }}>
                  {call.address_confirmed ? 'Registered Address Confirmed' : 'Updated / Pending'}
                </strong>
              </div>
              <div style={{ gridColumn: '1 / -1' }}>
                <span style={{ color: 'var(--text-muted)' }}>Pickup Location: </span>
                <span style={{ color: '#fff' }}>{call.new_address || call.customer_address || 'Registered Address'}</span>
              </div>
              {call.customer_note && (
                <div style={{ gridColumn: '1 / -1', background: 'rgba(255, 255, 255, 0.04)', padding: 10, borderRadius: 8 }}>
                  <span style={{ color: 'var(--accent-amber)', fontWeight: 600 }}>Note: </span>
                  <span style={{ color: 'var(--text-secondary)' }}>{call.customer_note}</span>
                </div>
              )}
            </div>
          </div>

          {/* Turn-by-Turn Conversational Transcript */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <MessageSquare size={16} color="var(--accent-purple)" />
              <h4 style={{ fontSize: '0.92rem', fontWeight: 700, color: '#fff' }}>
                Full Turn-by-Turn Hindi/Hinglish Transcript
              </h4>
            </div>

            <div style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
              maxHeight: 280,
              overflowY: 'auto',
              padding: 12,
              background: 'rgba(10, 14, 23, 0.5)',
              borderRadius: 'var(--radius-md)',
              border: '1px solid var(--border-subtle)',
            }}>
              {!call.transcript || call.transcript.length === 0 ? (
                <p style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 20, fontSize: '0.85rem' }}>
                  No turn-by-turn dialogue captured for this call.
                </p>
              ) : (
                call.transcript.map((item, idx) => {
                  const isBot = item.role === 'assistant';
                  return (
                    <div
                      key={idx}
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: isBot ? 'flex-start' : 'flex-end',
                      }}
                    >
                      <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        fontSize: '0.72rem',
                        color: 'var(--text-muted)',
                        marginBottom: 3,
                      }}>
                        {isBot ? (
                          <>
                            <Bot size={12} color="var(--airtel-red)" />
                            <span style={{ color: '#ff6666', fontWeight: 600 }}>Priya (AI Voice)</span>
                          </>
                        ) : (
                          <>
                            <User size={12} color="var(--accent-cyan)" />
                            <span style={{ color: 'var(--accent-cyan)', fontWeight: 600 }}>Customer</span>
                          </>
                        )}
                      </div>

                      <div style={{
                        maxWidth: '82%',
                        padding: '10px 14px',
                        borderRadius: isBot ? '4px 14px 14px 14px' : '14px 4px 14px 14px',
                        background: isBot ? 'rgba(228, 0, 0, 0.12)' : 'rgba(59, 130, 246, 0.12)',
                        border: isBot ? '1px solid rgba(228, 0, 0, 0.25)' : '1px solid rgba(59, 130, 246, 0.25)',
                        color: '#fff',
                        fontSize: '0.86rem',
                        lineHeight: 1.45,
                      }}>
                        {item.message}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div style={{
          padding: '14px 24px',
          borderTop: '1px solid var(--border-subtle)',
          display: 'flex',
          justifyContent: 'flex-end',
          background: 'rgba(255, 255, 255, 0.02)',
        }}>
          <button
            onClick={onClose}
            style={{
              padding: '8px 18px',
              borderRadius: 'var(--radius-sm)',
              background: 'rgba(255, 255, 255, 0.08)',
              color: '#fff',
              fontWeight: 600,
              fontSize: '0.85rem',
              cursor: 'pointer',
            }}
          >
            Close Details
          </button>
        </div>
      </div>
    </div>
  );
};
