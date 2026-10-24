import React from 'react';
import { 
  Megaphone, 
  Users, 
  Check, 
  Wallet, 
  ChevronRight, 
  X, 
  Plus, 
  PhoneCall, 
  Phone,
  BarChart3,
  CreditCard
} from 'lucide-react';
import type { CampaignSummary, CallRecord, TabKey, AuthUser } from '../../types';

interface DashboardHomeProps {
  summary: CampaignSummary | null;
  recentCalls: CallRecord[];
  user: AuthUser | null;
  onTabChange: (tab: TabKey) => void;
  onImportModalOpen: () => void;
  onTestCallOpen: () => void;
  onSelectCall: (call: CallRecord) => void;
}

export const DashboardHome: React.FC<DashboardHomeProps> = ({
  summary,
  recentCalls,
  user,
  onTabChange,
  onImportModalOpen,
  onTestCallOpen,
  onSelectCall,
}) => {
  const overview = summary?.overview || {
    sourceRows: 0,
    uniqueContacts: 0,
    connectedCalls: 0,
    totalAttempts: 0,
    dispositionedContacts: 0,
  };

  const successRate = overview.uniqueContacts > 0
    ? Math.round((overview.connectedCalls / (overview.uniqueContacts || 1)) * 100)
    : (overview.totalAttempts > 0 ? Math.round((overview.connectedCalls / overview.totalAttempts) * 100) : 0);

  // Mask phone number for security & display like the screenshot: +91 84****** 16
  const formatMaskedPhone = (phone?: string) => {
    if (!phone) return '—';
    const cleaned = phone.replace(/\D/g, '');
    if (cleaned.length >= 10) {
      const start = cleaned.slice(-10, -8);
      const end = cleaned.slice(-2);
      return `+91 ${start}****** ${end}`;
    }
    return phone || '—';
  };

  // Format call date & time like "7 Oct, 4:59 pm"
  const formatCallTime = (dateStr?: string) => {
    if (!dateStr) return '—';
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return '—';
    return date.toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  };

  const displayCalls = recentCalls.slice(0, 6);

  const isCallSuccessful = (call: any) => {
    const disp = (call.disposition || call.status || '').toUpperCase();
    if (disp.includes('FAILED') || disp.includes('UNCONNECTED') || disp.includes('NO_ANSWER') || disp.includes('BUSY') || disp.includes('CANCELLED')) {
      return false;
    }
    return true;
  };

  const getCallLanguage = (call: any) => {
    const lang = (call.customer_language || call.language || '').toLowerCase();
    if (lang === 'hi' || lang === 'hindi') return 'Hindi';
    if (lang === 'en' || lang === 'english') return 'English';
    return call.customer_language || call.language || '—';
  };

  const adminName = user?.name || 'CuroAI Admin';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 32, paddingBottom: 32 }}>
      {/* Top Welcome Header */}
      <div style={{
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: 16,
      }}>
        <div>
          <div style={{
            fontSize: '0.72rem',
            fontWeight: 800,
            letterSpacing: '0.08em',
            color: '#38BDF8',
            marginBottom: 6,
            textTransform: 'uppercase',
          }}>
            DASHBOARD
          </div>

          <h1 style={{
            fontSize: '1.95rem',
            fontWeight: 700,
            color: '#FFFFFF',
            letterSpacing: '-0.025em',
            lineHeight: 1.2,
          }}>
            Welcome back,{' '}
            <span style={{
              background: 'linear-gradient(135deg, #A855F7 0%, #C084FC 100%)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
            }}>
              {adminName}
            </span>
          </h1>

          <p style={{
            fontSize: '0.9rem',
            color: '#94A3B8',
            marginTop: 6,
          }}>
            Here is how your voice campaigns are performing.
          </p>
        </div>

        {/* Action Button */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            onClick={onTestCallOpen}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              background: 'rgba(255, 255, 255, 0.05)',
              border: '1px solid rgba(255, 255, 255, 0.12)',
              color: '#E2E8F0',
              padding: '10px 18px',
              borderRadius: 10,
              fontSize: '0.88rem',
              fontWeight: 600,
              cursor: 'pointer',
              transition: 'all 0.18s ease',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'rgba(255, 255, 255, 0.09)';
              e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.25)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)';
              e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.12)';
            }}
          >
            <PhoneCall size={16} color="#38BDF8" />
            Test AI call
          </button>

          <button
            onClick={onImportModalOpen}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              background: '#2563EB',
              border: '1px solid rgba(59, 130, 246, 0.4)',
              color: '#FFFFFF',
              padding: '10px 20px',
              borderRadius: 10,
              fontSize: '0.88rem',
              fontWeight: 600,
              cursor: 'pointer',
              boxShadow: '0 4px 16px rgba(37, 99, 235, 0.35)',
              transition: 'all 0.18s ease',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = '#1D4ED8';
              e.currentTarget.style.transform = 'translateY(-1px)';
              e.currentTarget.style.boxShadow = '0 6px 20px rgba(37, 99, 235, 0.5)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = '#2563EB';
              e.currentTarget.style.transform = 'translateY(0)';
              e.currentTarget.style.boxShadow = '0 4px 16px rgba(37, 99, 235, 0.35)';
            }}
          >
            <Plus size={16} strokeWidth={2.5} />
            Create campaign
          </button>
        </div>
      </div>

      {/* 4 Stat Cards Row */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))',
        gap: 16,
      }}>
        {/* Card 1: Campaigns */}
        <div 
          onClick={() => onTabChange('CAMPAIGN')}
          style={{
            background: '#0E121B',
            border: '1px solid rgba(255, 255, 255, 0.07)',
            borderRadius: 14,
            padding: '20px 22px',
            display: 'flex',
            alignItems: 'center',
            gap: 18,
            cursor: 'pointer',
            transition: 'border-color 0.2s, transform 0.2s',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = 'rgba(59, 130, 246, 0.3)';
            e.currentTarget.style.transform = 'translateY(-2px)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.07)';
            e.currentTarget.style.transform = 'translateY(0)';
          }}
        >
          <div style={{
            width: 46,
            height: 46,
            borderRadius: 10,
            background: 'rgba(37, 99, 235, 0.16)',
            border: '1px solid rgba(37, 99, 235, 0.28)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#3B82F6',
            flexShrink: 0,
          }}>
            <Megaphone size={20} />
          </div>
          <div>
            <div style={{ fontSize: '0.82rem', color: '#94A3B8', fontWeight: 500 }}>
              Campaigns
            </div>
            <div style={{ fontSize: '1.7rem', fontWeight: 700, color: '#FFFFFF', lineHeight: 1.2, margin: '2px 0' }}>
              6
            </div>
            <div style={{ fontSize: '0.78rem', color: '#64748B' }}>
              2 active or paused
            </div>
          </div>
        </div>

        {/* Card 2: Total contacts */}
        <div 
          onClick={() => onTabChange('LEADS')}
          style={{
            background: '#0E121B',
            border: '1px solid rgba(255, 255, 255, 0.07)',
            borderRadius: 14,
            padding: '20px 22px',
            display: 'flex',
            alignItems: 'center',
            gap: 18,
            cursor: 'pointer',
            transition: 'border-color 0.2s, transform 0.2s',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = 'rgba(168, 85, 247, 0.3)';
            e.currentTarget.style.transform = 'translateY(-2px)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.07)';
            e.currentTarget.style.transform = 'translateY(0)';
          }}
        >
          <div style={{
            width: 46,
            height: 46,
            borderRadius: 10,
            background: 'rgba(147, 51, 234, 0.16)',
            border: '1px solid rgba(147, 51, 234, 0.28)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#A855F7',
            flexShrink: 0,
          }}>
            <Users size={20} />
          </div>
          <div>
            <div style={{ fontSize: '0.82rem', color: '#94A3B8', fontWeight: 500 }}>
              Total contacts
            </div>
            <div style={{ fontSize: '1.7rem', fontWeight: 700, color: '#FFFFFF', lineHeight: 1.2, margin: '2px 0' }}>
              {(overview.uniqueContacts || 0).toLocaleString()}
            </div>
            <div style={{ fontSize: '0.78rem', color: '#64748B' }}>
              across all campaigns
            </div>
          </div>
        </div>

        {/* Card 3: Success rate */}
        <div 
          onClick={() => onTabChange('CALLS')}
          style={{
            background: '#0E121B',
            border: '1px solid rgba(255, 255, 255, 0.07)',
            borderRadius: 14,
            padding: '20px 22px',
            display: 'flex',
            alignItems: 'center',
            gap: 18,
            cursor: 'pointer',
            transition: 'border-color 0.2s, transform 0.2s',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = 'rgba(16, 185, 129, 0.3)';
            e.currentTarget.style.transform = 'translateY(-2px)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.07)';
            e.currentTarget.style.transform = 'translateY(0)';
          }}
        >
          <div style={{
            width: 46,
            height: 46,
            borderRadius: 10,
            background: 'rgba(16, 185, 129, 0.16)',
            border: '1px solid rgba(16, 185, 129, 0.28)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#10B981',
            flexShrink: 0,
          }}>
            <Check size={20} strokeWidth={2.5} />
          </div>
          <div>
            <div style={{ fontSize: '0.82rem', color: '#94A3B8', fontWeight: 500 }}>
              Success rate
            </div>
            <div style={{ fontSize: '1.7rem', fontWeight: 700, color: '#FFFFFF', lineHeight: 1.2, margin: '2px 0' }}>
              {successRate}%
            </div>
            <div style={{ fontSize: '0.78rem', color: '#64748B' }}>
              {(overview.connectedCalls || 0).toLocaleString()} successful calls
            </div>
          </div>
        </div>

        {/* Card 4: Credits */}
        <div 
          onClick={() => onTabChange('BILLING')}
          style={{
            background: '#0E121B',
            border: '1px solid rgba(255, 255, 255, 0.07)',
            borderRadius: 14,
            padding: '20px 22px',
            display: 'flex',
            alignItems: 'center',
            gap: 18,
            cursor: 'pointer',
            transition: 'border-color 0.2s, transform 0.2s',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = 'rgba(245, 158, 11, 0.3)';
            e.currentTarget.style.transform = 'translateY(-2px)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.07)';
            e.currentTarget.style.transform = 'translateY(0)';
          }}
        >
          <div style={{
            width: 46,
            height: 46,
            borderRadius: 10,
            background: 'rgba(245, 158, 11, 0.16)',
            border: '1px solid rgba(245, 158, 11, 0.28)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#F59E0B',
            flexShrink: 0,
          }}>
            <Wallet size={20} />
          </div>
          <div>
            <div style={{ fontSize: '0.82rem', color: '#94A3B8', fontWeight: 500 }}>
              Credits
            </div>
            <div style={{ fontSize: '1.7rem', fontWeight: 700, color: '#FFFFFF', lineHeight: 1.2, margin: '2px 0' }}>
              4,874
            </div>
            <div style={{ fontSize: '0.78rem', color: '#64748B' }}>
              available balance
            </div>
          </div>
        </div>
      </div>

      {/* Main 2-Column Section */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))',
        gap: 28,
        alignItems: 'start',
      }}>
        {/* Left Column: Quick Actions */}
        <div>
          <h2 style={{
            fontSize: '1.05rem',
            fontWeight: 700,
            color: '#FFFFFF',
            marginBottom: 16,
          }}>
            Quick actions
          </h2>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {/* Action 1: Create campaign */}
            <div
              onClick={onImportModalOpen}
              style={{
                background: '#0E121B',
                border: '1px solid rgba(255, 255, 255, 0.07)',
                borderRadius: 14,
                padding: '16px 20px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                cursor: 'pointer',
                transition: 'all 0.18s ease',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = '#131825';
                e.currentTarget.style.borderColor = 'rgba(59, 130, 246, 0.25)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = '#0E121B';
                e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.07)';
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                <div style={{
                  width: 42,
                  height: 42,
                  borderRadius: 10,
                  background: 'rgba(37, 99, 235, 0.16)',
                  border: '1px solid rgba(37, 99, 235, 0.25)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#3B82F6',
                }}>
                  <Megaphone size={19} />
                </div>
                <div>
                  <div style={{ fontSize: '0.92rem', fontWeight: 600, color: '#FFFFFF' }}>
                    Create campaign
                  </div>
                  <div style={{ fontSize: '0.8rem', color: '#94A3B8', marginTop: 2 }}>
                    Upload contacts and launch a voice campaign
                  </div>
                </div>
              </div>
              <ChevronRight size={18} color="#64748B" />
            </div>

            {/* Action 2: View campaigns */}
            <div
              onClick={() => onTabChange('CAMPAIGN')}
              style={{
                background: '#0E121B',
                border: '1px solid rgba(255, 255, 255, 0.07)',
                borderRadius: 14,
                padding: '16px 20px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                cursor: 'pointer',
                transition: 'all 0.18s ease',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = '#131825';
                e.currentTarget.style.borderColor = 'rgba(168, 85, 247, 0.25)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = '#0E121B';
                e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.07)';
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                <div style={{
                  width: 42,
                  height: 42,
                  borderRadius: 10,
                  background: 'rgba(147, 51, 234, 0.16)',
                  border: '1px solid rgba(147, 51, 234, 0.25)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#A855F7',
                }}>
                  <BarChart3 size={19} />
                </div>
                <div>
                  <div style={{ fontSize: '0.92rem', fontWeight: 600, color: '#FFFFFF' }}>
                    View campaigns
                  </div>
                  <div style={{ fontSize: '0.8rem', color: '#94A3B8', marginTop: 2 }}>
                    Monitor progress and results
                  </div>
                </div>
              </div>
              <ChevronRight size={18} color="#64748B" />
            </div>

            {/* Action 3: Call log */}
            <div
              onClick={() => onTabChange('CALLS')}
              style={{
                background: '#0E121B',
                border: '1px solid rgba(255, 255, 255, 0.07)',
                borderRadius: 14,
                padding: '16px 20px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                cursor: 'pointer',
                transition: 'all 0.18s ease',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = '#131825';
                e.currentTarget.style.borderColor = 'rgba(16, 185, 129, 0.25)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = '#0E121B';
                e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.07)';
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                <div style={{
                  width: 42,
                  height: 42,
                  borderRadius: 10,
                  background: 'rgba(16, 185, 129, 0.16)',
                  border: '1px solid rgba(16, 185, 129, 0.25)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#10B981',
                }}>
                  <Phone size={19} />
                </div>
                <div>
                  <div style={{ fontSize: '0.92rem', fontWeight: 600, color: '#FFFFFF' }}>
                    Call log
                  </div>
                  <div style={{ fontSize: '0.8rem', color: '#94A3B8', marginTop: 2 }}>
                    Search every call
                  </div>
                </div>
              </div>
              <ChevronRight size={18} color="#64748B" />
            </div>

            {/* Action 4: Billing */}
            <div
              onClick={() => onTabChange('BILLING')}
              style={{
                background: '#0E121B',
                border: '1px solid rgba(255, 255, 255, 0.07)',
                borderRadius: 14,
                padding: '16px 20px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                cursor: 'pointer',
                transition: 'all 0.18s ease',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = '#131825';
                e.currentTarget.style.borderColor = 'rgba(56, 189, 248, 0.25)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = '#0E121B';
                e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.07)';
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                <div style={{
                  width: 42,
                  height: 42,
                  borderRadius: 10,
                  background: 'rgba(56, 189, 248, 0.16)',
                  border: '1px solid rgba(56, 189, 248, 0.25)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#38BDF8',
                }}>
                  <CreditCard size={19} />
                </div>
                <div>
                  <div style={{ fontSize: '0.92rem', fontWeight: 600, color: '#FFFFFF' }}>
                    Billing
                  </div>
                  <div style={{ fontSize: '0.8rem', color: '#94A3B8', marginTop: 2 }}>
                    Check your credit balance
                  </div>
                </div>
              </div>
              <ChevronRight size={18} color="#64748B" />
            </div>
          </div>
        </div>

        {/* Right Column: Recent Calls */}
        <div>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 16,
          }}>
            <h2 style={{
              fontSize: '1.05rem',
              fontWeight: 700,
              color: '#FFFFFF',
            }}>
              Recent calls
            </h2>

            <button
              onClick={() => onTabChange('CALLS')}
              style={{
                background: 'transparent',
                border: 'none',
                color: '#94A3B8',
                fontSize: '0.82rem',
                fontWeight: 500,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                padding: '4px 6px',
                borderRadius: 6,
                transition: 'color 0.15s ease',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.color = '#FFFFFF')}
              onMouseLeave={(e) => (e.currentTarget.style.color = '#94A3B8')}
            >
              View all &gt;
            </button>
          </div>

          <div style={{
            background: '#0E121B',
            border: '1px solid rgba(255, 255, 255, 0.07)',
            borderRadius: 14,
            overflow: 'hidden',
          }}>
            {displayCalls.length === 0 ? (
              <div style={{ padding: '36px 20px', textAlign: 'center', color: '#64748B', fontSize: '0.85rem' }}>
                No recent calls recorded yet.
              </div>
            ) : (
              displayCalls.map((call, idx) => {
                const isSuccess = isCallSuccessful(call);
                const lang = getCallLanguage(call);
                const isLast = idx === displayCalls.length - 1;

              return (
                <div
                  key={call.id || idx}
                  onClick={() => onSelectCall(call as any)}
                  style={{
                    padding: '13px 18px',
                    borderBottom: isLast ? 'none' : '1px solid rgba(255, 255, 255, 0.04)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    cursor: 'pointer',
                    transition: 'background 0.15s ease',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255, 255, 255, 0.03)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                    {/* Status Box */}
                    <div style={{
                      width: 32,
                      height: 32,
                      borderRadius: 8,
                      background: isSuccess ? 'rgba(16, 185, 129, 0.12)' : 'rgba(239, 68, 68, 0.12)',
                      border: isSuccess ? '1px solid rgba(16, 185, 129, 0.28)' : '1px solid rgba(239, 68, 68, 0.28)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: isSuccess ? '#10B981' : '#EF4444',
                      flexShrink: 0,
                    }}>
                      {isSuccess ? <Check size={16} strokeWidth={2.5} /> : <X size={16} strokeWidth={2.5} />}
                    </div>

                    {/* Phone & Meta */}
                    <div>
                      <div style={{
                        fontSize: '0.88rem',
                        fontWeight: 600,
                        color: '#FFFFFF',
                        letterSpacing: '0.01em',
                      }}>
                        {formatMaskedPhone((call as any).customer_phone)}
                      </div>
                      <div style={{
                        fontSize: '0.74rem',
                        color: '#64748B',
                        marginTop: 2,
                      }}>
                        {formatCallTime(call.created_at)} · {lang}
                      </div>
                    </div>
                  </div>

                  {/* Badge */}
                  <div>
                    {isSuccess ? (
                      <span style={{
                        display: 'inline-block',
                        padding: '3px 10px',
                        borderRadius: 6,
                        background: 'rgba(16, 185, 129, 0.08)',
                        border: '1px solid rgba(16, 185, 129, 0.3)',
                        color: '#10B981',
                        fontSize: '0.68rem',
                        fontWeight: 700,
                        letterSpacing: '0.04em',
                      }}>
                        SUCCESSFUL
                      </span>
                    ) : (
                      <span style={{
                        display: 'inline-block',
                        padding: '3px 10px',
                        borderRadius: 6,
                        background: 'rgba(239, 68, 68, 0.08)',
                        border: '1px solid rgba(239, 68, 68, 0.3)',
                        color: '#EF4444',
                        fontSize: '0.68rem',
                        fontWeight: 700,
                        letterSpacing: '0.04em',
                      }}>
                        FAILED
                      </span>
                    )}
                  </div>
                </div>
              );
            }))}
          </div>
        </div>
      </div>
    </div>
  );
};
