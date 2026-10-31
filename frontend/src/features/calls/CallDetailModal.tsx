import React, { useState, useEffect, useMemo } from 'react';
import { X, Phone, User, Bot, MessageSquare, Volume2, ShieldAlert } from 'lucide-react';
import type { CallRecord } from '../../types';
import { fetchCallDetail } from '../../services/api.service';

interface CallDetailModalProps {
  call: CallRecord | null;
  onClose: () => void;
}

interface TranscriptTurn {
  role?: string;
  speaker?: string;
  message?: string;
  text?: string;
  content?: string;
  timestamp?: number;
}

export const CallDetailModal: React.FC<CallDetailModalProps> = ({ call, onClose }) => {
  const [activeCall, setActiveCall] = useState<CallRecord | null>(call);

  // Sync activeCall when prop changes and fetch full record from DB
  useEffect(() => {
    setActiveCall(call);
    if (call?.id) {
      fetchCallDetail(call.id)
        .then((freshCall) => {
          if (freshCall) {
            setActiveCall(freshCall);
          }
        })
        .catch(() => {
          // If fetch fails, keep current call prop
        });
    }
  }, [call]);

  const transcriptList: TranscriptTurn[] = useMemo(() => {
    if (!activeCall) return [];
    const t = (activeCall as any).transcript;
    if (!t) return [];
    if (Array.isArray(t)) return t;
    if (typeof t === 'string') {
      try {
        const parsed = JSON.parse(t);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }
    return [];
  }, [activeCall]);

  if (!call || !activeCall) return null;

  const rawStatus = (activeCall.status || '').toLowerCase();
  const rawDisp = ((activeCall as any).final_disposition || (activeCall as any).call_result || activeCall.call_status || '').toLowerCase();

  let canonicalStatus: 'SUCCESSFUL' | 'FAILED' | 'NO_ANSWER' = 'SUCCESSFUL';
  if (rawStatus === 'no_answer' || rawStatus === 'no answer' || rawDisp.includes('no answer') || rawDisp.includes('timeout') || rawDisp.includes('ringing')) {
    canonicalStatus = 'NO_ANSWER';
  } else if (rawStatus === 'failed' || rawDisp.includes('dropped') || rawDisp.includes('barrier') || rawDisp.includes('wrong number')) {
    canonicalStatus = 'FAILED';
  } else {
    canonicalStatus = 'SUCCESSFUL';
  }

  const getStatusBadge = () => {
    if (canonicalStatus === 'SUCCESSFUL') {
      return (
        <span style={{
          background: 'rgba(16, 185, 129, 0.15)',
          border: '1px solid rgba(16, 185, 129, 0.3)',
          color: '#34D399',
          padding: '4px 10px',
          borderRadius: 6,
          fontSize: '0.74rem',
          fontWeight: 700,
          letterSpacing: '0.04em',
        }}>
          SUCCESSFUL
        </span>
      );
    }
    if (canonicalStatus === 'NO_ANSWER') {
      return (
        <span style={{
          background: 'rgba(245, 158, 11, 0.15)',
          border: '1px solid rgba(245, 158, 11, 0.3)',
          color: '#F59E0B',
          padding: '4px 10px',
          borderRadius: 6,
          fontSize: '0.74rem',
          fontWeight: 700,
          letterSpacing: '0.04em',
        }}>
          NO ANSWER
        </span>
      );
    }
    return (
      <span style={{
        background: 'rgba(244, 63, 94, 0.15)',
        border: '1px solid rgba(244, 63, 94, 0.3)',
        color: '#FB7185',
        padding: '4px 10px',
        borderRadius: 6,
        fontSize: '0.74rem',
        fontWeight: 700,
        letterSpacing: '0.04em',
      }}>
        FAILED
      </span>
    );
  };

  const phoneDisplay = activeCall.customer_phone || (activeCall as any).phone || '—';
  const campaignName = (activeCall as any).campaign_name || 'Campaign';

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.8)',
        backdropFilter: 'blur(10px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
        padding: 20,
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 780,
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
          background: '#0B0F19',
          border: '1px solid rgba(255, 255, 255, 0.1)',
          borderRadius: 16,
          overflow: 'hidden',
          boxShadow: '0 20px 50px rgba(0, 0, 0, 0.6)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{
          padding: '20px 24px',
          borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          background: 'rgba(255, 255, 255, 0.02)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{
              width: 40,
              height: 40,
              borderRadius: 10,
              background: 'rgba(56, 189, 248, 0.12)',
              border: '1px solid rgba(56, 189, 248, 0.25)',
              color: '#38BDF8',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}>
              <Phone size={20} />
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <h3 style={{ fontSize: '1.15rem', fontWeight: 700, color: '#FFFFFF', margin: 0 }}>
                  Call Audit & Transcript
                </h3>
                {getStatusBadge()}
              </div>
              <p style={{ fontSize: '0.8rem', color: '#94A3B8', marginTop: 3, marginBottom: 0 }}>
                {campaignName} • Call ID: {activeCall.id ? activeCall.id.slice(0, 8) : '—'}
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            style={{
              background: 'rgba(255, 255, 255, 0.06)',
              color: '#94A3B8',
              border: 'none',
              width: 32,
              height: 32,
              borderRadius: '50%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              transition: 'all 0.15s ease',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'rgba(255, 255, 255, 0.12)';
              e.currentTarget.style.color = '#FFFFFF';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'rgba(255, 255, 255, 0.06)';
              e.currentTarget.style.color = '#94A3B8';
            }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Scrollable Content */}
        <div style={{ padding: 24, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 18 }}>
          {/* Key Outcome Highlights */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
            gap: 12,
          }}>
            <div style={{
              background: '#0F1524',
              border: '1px solid rgba(255, 255, 255, 0.06)',
              borderRadius: 10,
              padding: '12px 14px',
            }}>
              <span style={{ fontSize: '0.72rem', color: '#64748B', textTransform: 'uppercase', fontWeight: 700, letterSpacing: '0.04em' }}>
                Final Disposition
              </span>
              <div style={{ fontSize: '0.88rem', fontWeight: 600, color: '#FFFFFF', marginTop: 4 }}>
                {(activeCall as any).final_disposition || (activeCall as any).call_result || (activeCall as any).disposition || activeCall.call_status || '—'}
              </div>
            </div>

            <div style={{
              background: '#0F1524',
              border: '1px solid rgba(255, 255, 255, 0.06)',
              borderRadius: 10,
              padding: '12px 14px',
            }}>
              <span style={{ fontSize: '0.72rem', color: '#64748B', textTransform: 'uppercase', fontWeight: 700, letterSpacing: '0.04em' }}>
                Confirmed Date
              </span>
              <div style={{ fontSize: '0.88rem', fontWeight: 600, color: '#38BDF8', marginTop: 4 }}>
                {(activeCall as any).confirmed_date || (activeCall as any).pickup_date || '—'}
              </div>
            </div>

            <div style={{
              background: '#0F1524',
              border: '1px solid rgba(255, 255, 255, 0.06)',
              borderRadius: 10,
              padding: '12px 14px',
            }}>
              <span style={{ fontSize: '0.72rem', color: '#64748B', textTransform: 'uppercase', fontWeight: 700, letterSpacing: '0.04em' }}>
                Duration & Latency
              </span>
              <div style={{ fontSize: '0.88rem', fontWeight: 600, color: '#34D399', marginTop: 4 }}>
                {activeCall.duration_seconds || 0}s {activeCall.median_latency_ms ? `| ~${activeCall.median_latency_ms}ms` : ''}
              </div>
            </div>
          </div>

          {/* Real Estate Property Intake Dossier (if real-estate call) */}
          {Boolean((activeCall as any).re_category || (activeCall as any).re_project_or_society || (activeCall.script || '').includes('Estate')) && (
            <div style={{
              background: '#0F1524',
              border: '1px solid rgba(139, 92, 246, 0.25)',
              borderRadius: 12,
              padding: 16,
              boxShadow: '0 0 25px -5px rgba(139, 92, 246, 0.1)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <h4 style={{ fontSize: '0.78rem', color: '#A78BFA', textTransform: 'uppercase', fontWeight: 700, letterSpacing: '0.05em', margin: 0 }}>
                  🏡 My Estate Finder — Property Intake Dossier
                </h4>
                <div style={{ display: 'flex', gap: 6 }}>
                  {(activeCall as any).re_category && (
                    <span style={{ background: 'rgba(139, 92, 246, 0.2)', color: '#C4B5FD', padding: '2px 8px', borderRadius: 4, fontSize: '0.72rem', fontWeight: 700 }}>
                      {String((activeCall as any).re_category).toUpperCase()}
                    </span>
                  )}
                  {(activeCall as any).re_intent && (
                    <span style={{ background: 'rgba(56, 189, 248, 0.2)', color: '#7DD3FC', padding: '2px 8px', borderRadius: 4, fontSize: '0.72rem', fontWeight: 700 }}>
                      {String((activeCall as any).re_intent).toUpperCase()}
                    </span>
                  )}
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, fontSize: '0.84rem' }}>
                <div>
                  <span style={{ color: '#94A3B8' }}>Society / Project: </span>
                  <strong style={{ color: '#FFFFFF' }}>{(activeCall as any).re_project_or_society || '—'}</strong>
                </div>
                <div>
                  <span style={{ color: '#94A3B8' }}>Sector / Location: </span>
                  <span style={{ color: '#E2E8F0' }}>{(activeCall as any).re_sector_or_location || '—'}</span>
                </div>
                <div>
                  <span style={{ color: '#94A3B8' }}>Unit & Floor: </span>
                  <span style={{ color: '#E2E8F0' }}>
                    {[(activeCall as any).re_unit_number, (activeCall as any).re_floor_number ? `Floor ${(activeCall as any).re_floor_number}` : ''].filter(Boolean).join(', ') || '—'}
                  </span>
                </div>
                <div>
                  <span style={{ color: '#94A3B8' }}>Config / Type: </span>
                  <span style={{ color: '#38BDF8', fontWeight: 600 }}>{(activeCall as any).re_bhk_config || (activeCall as any).re_commercial_type || '—'}</span>
                </div>
                <div>
                  <span style={{ color: '#94A3B8' }}>Approx Area: </span>
                  <span style={{ color: '#E2E8F0' }}>{(activeCall as any).re_approx_area_sqft ? `${(activeCall as any).re_approx_area_sqft} sq ft` : '—'}</span>
                </div>
                <div>
                  <span style={{ color: '#94A3B8' }}>Furnishing: </span>
                  <span style={{ color: '#E2E8F0' }}>{(activeCall as any).re_furnishing_status || '—'}</span>
                </div>
                <div>
                  <span style={{ color: '#94A3B8' }}>Expected Price / Rent: </span>
                  <strong style={{ color: '#34D399' }}>
                    {(activeCall as any).re_expected_sale_price || (activeCall as any).re_expected_monthly_rent || '—'}
                  </strong>
                </div>
                <div>
                  <span style={{ color: '#94A3B8' }}>Immediate Occupancy: </span>
                  <span style={{ color: '#E2E8F0' }}>
                    {(activeCall as any).re_immediate_occupancy === true ? 'Yes' : ((activeCall as any).re_immediate_occupancy === false ? 'No' : '—')}
                  </span>
                </div>
                {(activeCall as any).re_is_currently_leased !== undefined && (activeCall as any).re_is_currently_leased !== null && (
                  <div>
                    <span style={{ color: '#94A3B8' }}>Current Lease Status: </span>
                    <span style={{ color: '#E2E8F0' }}>
                      {(activeCall as any).re_is_currently_leased
                        ? `Leased out${(activeCall as any).re_current_rent_received ? ` (${(activeCall as any).re_current_rent_received})` : ''}`
                        : 'Vacant'}
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Customer & Address Details */}
          <div style={{
            background: '#0F1524',
            border: '1px solid rgba(255, 255, 255, 0.06)',
            borderRadius: 12,
            padding: 16,
          }}>
            <h4 style={{ fontSize: '0.76rem', color: '#64748B', textTransform: 'uppercase', marginBottom: 12, fontWeight: 700, letterSpacing: '0.05em' }}>
              Customer Verification & Destination
            </h4>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, fontSize: '0.84rem' }}>
              <div>
                <span style={{ color: '#94A3B8' }}>Customer: </span>
                <strong style={{ color: '#FFFFFF' }}>{activeCall.customer_name || '—'}</strong> ({phoneDisplay})
              </div>
              <div>
                <span style={{ color: '#94A3B8' }}>Contact Ref: </span>
                <span style={{ color: '#38BDF8', fontWeight: 600 }}>{(activeCall as any).subs_del_no || (activeCall as any).contact_ref || '—'}</span>
              </div>
              <div style={{ gridColumn: '1 / -1' }}>
                <span style={{ color: '#94A3B8' }}>Address: </span>
                <span style={{ color: '#E2E8F0' }}>{(activeCall as any).new_address || activeCall.customer_address || '—'}</span>
              </div>
              {(activeCall as any).customer_note && (
                <div style={{ gridColumn: '1 / -1', background: 'rgba(245, 158, 11, 0.08)', border: '1px solid rgba(245, 158, 11, 0.2)', padding: 10, borderRadius: 8 }}>
                  <span style={{ color: '#F59E0B', fontWeight: 600 }}>Note: </span>
                  <span style={{ color: '#E2E8F0' }}>{(activeCall as any).customer_note}</span>
                </div>
              )}
            </div>
          </div>

          {/* Audio Recording Player if available */}
          {activeCall.recording_url && (
            <div style={{
              background: '#0F1524',
              border: '1px solid rgba(56, 189, 248, 0.2)',
              borderRadius: 12,
              padding: 14,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <Volume2 size={16} color="#38BDF8" />
                <span style={{ fontSize: '0.84rem', fontWeight: 600, color: '#FFFFFF' }}>
                  Call Audio Recording
                </span>
              </div>
              <audio
                controls
                src={activeCall.recording_url}
                style={{ width: '100%', height: 36, outline: 'none' }}
              />
            </div>
          )}

          {/* Turn-by-Turn Transcript */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <MessageSquare size={16} color="#C084FC" />
              <h4 style={{ fontSize: '0.9rem', fontWeight: 700, color: '#FFFFFF', margin: 0 }}>
                Full Turn-by-Turn Voice Transcript
              </h4>
            </div>

            <div style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
              maxHeight: 280,
              overflowY: 'auto',
              padding: 14,
              background: '#090D16',
              borderRadius: 12,
              border: '1px solid rgba(255, 255, 255, 0.06)',
            }}>
              {transcriptList.length === 0 ? (
                <p style={{ textAlign: 'center', color: '#64748B', padding: '24px 0', fontSize: '0.85rem', margin: 0 }}>
                  No turn-by-turn dialogue captured for this call.
                </p>
              ) : (
                transcriptList.map((item, idx) => {
                  const roleStr = (item.role || '').toLowerCase();
                  const speakerStr = (item.speaker || '').toLowerCase();
                  const isBot = roleStr === 'assistant' || speakerStr === 'agent' || speakerStr === 'assistant';
                  const isSystem = roleStr === 'system';
                  const text = item.message || item.text || item.content || '';

                  if (isSystem) {
                    return (
                      <div
                        key={idx}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          gap: 6,
                          padding: '6px 12px',
                          background: 'rgba(255, 255, 255, 0.04)',
                          borderRadius: 6,
                          fontSize: '0.75rem',
                          color: '#94A3B8',
                          margin: '4px 0',
                        }}
                      >
                        <ShieldAlert size={12} color="#F59E0B" />
                        <span>{text}</span>
                      </div>
                    );
                  }

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
                        color: '#64748B',
                        marginBottom: 4,
                      }}>
                        {isBot ? (
                          <>
                            <Bot size={13} color="#38BDF8" />
                            <span style={{ color: '#38BDF8', fontWeight: 600 }}>CuroAI Voice Agent</span>
                          </>
                        ) : (
                          <>
                            <User size={13} color="#10B981" />
                            <span style={{ color: '#10B981', fontWeight: 600 }}>Customer</span>
                          </>
                        )}
                      </div>

                      <div style={{
                        maxWidth: '82%',
                        padding: '10px 14px',
                        borderRadius: isBot ? '4px 14px 14px 14px' : '14px 4px 14px 14px',
                        background: isBot ? 'rgba(56, 189, 248, 0.1)' : 'rgba(16, 185, 129, 0.1)',
                        border: isBot ? '1px solid rgba(56, 189, 248, 0.22)' : '1px solid rgba(16, 185, 129, 0.22)',
                        color: '#FFFFFF',
                        fontSize: '0.85rem',
                        lineHeight: 1.45,
                      }}>
                        {text}
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
          borderTop: '1px solid rgba(255, 255, 255, 0.08)',
          display: 'flex',
          justifyContent: 'flex-end',
          background: 'rgba(255, 255, 255, 0.02)',
        }}>
          <button
            onClick={onClose}
            style={{
              padding: '8px 20px',
              borderRadius: 8,
              background: '#1E293B',
              border: '1px solid rgba(255, 255, 255, 0.12)',
              color: '#FFFFFF',
              fontWeight: 600,
              fontSize: '0.84rem',
              cursor: 'pointer',
              transition: 'background 0.15s ease',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = '#334155')}
            onMouseLeave={(e) => (e.currentTarget.style.background = '#1E293B')}
          >
            Close Details
          </button>
        </div>
      </div>
    </div>
  );
};
