import React, { useState, useEffect, useMemo } from 'react';
import { 
  ChevronLeft, 
  Download, 
  Users, 
  Phone, 
  Check, 
  X, 
  Clock, 
  Wallet,
  Search,
  ChevronDown,
  FileText
} from 'lucide-react';
import type { CampaignItem, CallRecord } from '../../types';
import { fetchCampaignCalls } from '../../services';

const formatDuration = (seconds?: number): string => {
  if (seconds === undefined || seconds === null) return '0m 00s';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s < 10 ? '0' : ''}${s}s`;
};

const formatTime = (isoString?: string): string => {
  if (!isoString) return '—';
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return isoString;
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const month = months[d.getMonth()];
    const day = d.getDate();
    let hours = d.getHours();
    const minutes = d.getMinutes();
    const ampm = hours >= 12 ? 'pm' : 'am';
    hours = hours % 12;
    hours = hours ? hours : 12;
    const minStr = minutes < 10 ? `0${minutes}` : `${minutes}`;
    return `${day} ${month}, ${hours}:${minStr} ${ampm}`;
  } catch {
    return isoString;
  }
};

const maskPhone = (phone?: string): string => {
  if (!phone) return '—';
  if (phone.includes('*')) return phone;
  const clean = phone.trim();
  const digits = clean.replace(/\D/g, '');
  if (digits.length >= 10) {
    const firstTwo = digits.slice(-10, -8);
    const lastTwo = digits.slice(-2);
    return `+91 ${firstTwo}****** ${lastTwo}`;
  }
  return clean || '—';
};

interface CampaignDetailViewProps {
  campaign: CampaignItem;
  onBack: () => void;
  onSelectCall?: (call: CallRecord) => void;
}

type SubTab = 'OVERVIEW' | 'CALL_LOG' | 'DETAILS';

export const CampaignDetailView: React.FC<CampaignDetailViewProps> = ({
  campaign,
  onBack,
  onSelectCall,
}) => {
  const [activeTab, setActiveTab] = useState<SubTab>('OVERVIEW');
  const [calls, setCalls] = useState<CallRecord[]>([]);
  const [loadingCalls, setLoadingCalls] = useState(false);
  const [callSearchTerm, setCallSearchTerm] = useState('');
  const [callFilter, setCallFilter] = useState<'ALL' | 'SUCCESSFUL' | 'FAILED' | 'NO_ANSWER'>('ALL');

  const normalizeCallStatus = (status: string, disposition?: string): 'SUCCESSFUL' | 'FAILED' | 'NO_ANSWER' => {
    const s = (status || '').toLowerCase();
    const d = (disposition || '').toLowerCase();
    if (s === 'no_answer' || s === 'no answer' || d.includes('no answer') || d.includes('timeout') || d.includes('ringing')) {
      return 'NO_ANSWER';
    }
    if (s === 'completed' || s === 'successful' || s === 'answered' || d.includes('goal completed')) {
      return 'SUCCESSFUL';
    }
    return 'FAILED';
  };

  useEffect(() => {
    let isMounted = true;
    const loadCalls = async () => {
      setLoadingCalls(true);
      try {
        const data = await fetchCampaignCalls(campaign.id);
        if (isMounted) {
          setCalls(data || []);
        }
      } catch {
        if (isMounted) {
          setCalls([]);
        }
      } finally {
        if (isMounted) setLoadingCalls(false);
      }
    };

    loadCalls();
    return () => {
      isMounted = false;
    };
  }, [campaign.id]);

  // Filtered calls matching search and status filter (Successful, Failed, No Answer)
  const filteredCalls = useMemo(() => {
    return calls.filter((c) => {
      const phone = (c as any).customer_phone || (c as any).phone || '';
      const ref = (c as any).contact_ref || '';
      const result = (c as any).call_result || (c as any).disposition || '';
      const lang = (c as any).customer_language || (c as any).language || '';
      const matchesSearch = 
        phone.toLowerCase().includes(callSearchTerm.toLowerCase()) ||
        ref.toLowerCase().includes(callSearchTerm.toLowerCase()) ||
        result.toLowerCase().includes(callSearchTerm.toLowerCase()) ||
        lang.toLowerCase().includes(callSearchTerm.toLowerCase());
      
      const norm = normalizeCallStatus(c.status, result);
      const matchesStatus = 
        callFilter === 'ALL' ||
        norm === callFilter;
      
      return matchesSearch && matchesStatus;
    });
  }, [calls, callSearchTerm, callFilter]);

  const totalContacts = campaign.total_contacts || 1;
  const successful = campaign.successful_calls || 0;
  const failed = campaign.failed_calls || 0;
  const remaining = campaign.remaining_calls || 0;
  const uniqueCalled = campaign.unique_called || 0;
  const creditsUsed = campaign.credits_used || 0;

  const successfulPercent = Math.round((successful / totalContacts) * 100);
  const failedPercent = Math.round((failed / totalContacts) * 100);
  const remainingPercent = Math.round((remaining / totalContacts) * 100);
  const progressPercent = campaign.progress_percent ?? (totalContacts > 0 ? Math.min(100, Math.round(((successful + failed) / totalContacts) * 100)) : 100);

  const normalizeStatus = (status: string) => {
    const s = (status || '').toUpperCase();
    if (s.includes('RUN')) return 'RUNNING';
    if (s.includes('PAUS')) return 'PAUSED';
    if (s.includes('COMPLET')) return 'COMPLETED';
    if (s.includes('STOP')) return 'STOPPED';
    return 'RUNNING';
  };

  const normStatus = normalizeStatus(campaign.status);

  const handleDownloadCsv = () => {
    const csvRows = [
      ['Campaign Name', campaign.name],
      ['Status', normStatus],
      ['Total Contacts', totalContacts.toString()],
      ['Unique Called', uniqueCalled.toString()],
      ['Successful Calls', `${successful} (${successfulPercent}%)`],
      ['Failed Calls', `${failed} (${failedPercent}%)`],
      ['Remaining Calls', `${remaining} (${remainingPercent}%)`],
      ['Credits Used', creditsUsed.toString()],
      ['Execution Date', campaign.execution_date || '7 Oct 2026'],
      ['Service Engine', campaign.service || 'curoai_service'],
      ['Exported At', new Date().toISOString()],
    ];

    const csvContent = 'data:text/csv;charset=utf-8,' + csvRows.map((e) => e.join(',')).join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `${campaign.name.replace(/\s+/g, '_')}_Report.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24, paddingBottom: 40 }}>
      {/* Top Header: Back Button, Title, Badge, Report (CSV) button */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: 16,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          {/* Back button */}
          <button
            onClick={onBack}
            style={{
              width: 38,
              height: 38,
              borderRadius: 8,
              background: '#0E121B',
              border: '1px solid rgba(255, 255, 255, 0.1)',
              color: '#94A3B8',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              transition: 'all 0.15s ease',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = '#FFFFFF';
              e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.25)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = '#94A3B8';
              e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.1)';
            }}
            title="Back to Campaigns"
            aria-label="Back to Campaigns"
          >
            <ChevronLeft size={18} />
          </button>

          {/* Title & Status Badge */}
          <div>
            <h1 style={{
              fontSize: '1.45rem',
              fontWeight: 700,
              color: '#FFFFFF',
              letterSpacing: '-0.02em',
              margin: '0 0 6px 0',
              lineHeight: 1.25,
            }}>
              {campaign.name}
            </h1>

            <div>
              {normStatus === 'COMPLETED' && (
                <span style={{
                  display: 'inline-block',
                  padding: '2px 8px',
                  borderRadius: 4,
                  background: 'rgba(168, 85, 247, 0.14)',
                  border: '1px solid rgba(168, 85, 247, 0.35)',
                  color: '#C084FC',
                  fontSize: '0.68rem',
                  fontWeight: 700,
                  letterSpacing: '0.04em',
                }}>
                  COMPLETED
                </span>
              )}
              {normStatus === 'RUNNING' && (
                <span style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                  padding: '2px 8px',
                  borderRadius: 4,
                  background: 'rgba(16, 185, 129, 0.14)',
                  border: '1px solid rgba(16, 185, 129, 0.35)',
                  color: '#10B981',
                  fontSize: '0.68rem',
                  fontWeight: 700,
                  letterSpacing: '0.04em',
                }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#10B981', display: 'inline-block' }} />
                  RUNNING
                </span>
              )}
              {normStatus === 'PAUSED' && (
                <span style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                  padding: '2px 8px',
                  borderRadius: 4,
                  background: 'rgba(245, 158, 11, 0.14)',
                  border: '1px solid rgba(245, 158, 11, 0.35)',
                  color: '#F59E0B',
                  fontSize: '0.68rem',
                  fontWeight: 700,
                  letterSpacing: '0.04em',
                }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#F59E0B', display: 'inline-block' }} />
                  PAUSED
                </span>
              )}
              {normStatus === 'STOPPED' && (
                <span style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                  padding: '2px 8px',
                  borderRadius: 4,
                  background: 'rgba(239, 68, 68, 0.14)',
                  border: '1px solid rgba(239, 68, 68, 0.35)',
                  color: '#EF4444',
                  fontSize: '0.68rem',
                  fontWeight: 700,
                  letterSpacing: '0.04em',
                }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#EF4444', display: 'inline-block' }} />
                  STOPPED
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Report (CSV) button matching screenshot */}
        <button
          onClick={handleDownloadCsv}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '9px 18px',
            borderRadius: 8,
            background: '#0E121B',
            border: '1px solid rgba(255, 255, 255, 0.12)',
            color: '#FFFFFF',
            fontSize: '0.84rem',
            fontWeight: 600,
            cursor: 'pointer',
            transition: 'all 0.15s ease',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = '#151A27';
            e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.25)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = '#0E121B';
            e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.12)';
          }}
        >
          <Download size={14} color="#94A3B8" />
          Report (CSV)
        </button>
      </div>

      {/* Sub-tabs bar: Overview | Call log | Details */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 28,
        borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
        paddingBottom: 2,
      }}>
        <button
          onClick={() => setActiveTab('OVERVIEW')}
          style={{
            background: 'transparent',
            border: 'none',
            padding: '8px 4px 12px 4px',
            fontSize: '0.88rem',
            fontWeight: activeTab === 'OVERVIEW' ? 600 : 500,
            color: activeTab === 'OVERVIEW' ? '#FFFFFF' : '#64748B',
            cursor: 'pointer',
            position: 'relative',
            transition: 'color 0.15s ease',
          }}
        >
          Overview
          {activeTab === 'OVERVIEW' && (
            <span style={{
              position: 'absolute',
              bottom: -2,
              left: 0,
              right: 0,
              height: 2,
              background: '#38BDF8',
              borderRadius: 2,
            }} />
          )}
        </button>

        <button
          onClick={() => setActiveTab('CALL_LOG')}
          style={{
            background: 'transparent',
            border: 'none',
            padding: '8px 4px 12px 4px',
            fontSize: '0.88rem',
            fontWeight: activeTab === 'CALL_LOG' ? 600 : 500,
            color: activeTab === 'CALL_LOG' ? '#FFFFFF' : '#64748B',
            cursor: 'pointer',
            position: 'relative',
            transition: 'color 0.15s ease',
          }}
        >
          Call log
          {activeTab === 'CALL_LOG' && (
            <span style={{
              position: 'absolute',
              bottom: -2,
              left: 0,
              right: 0,
              height: 2,
              background: '#38BDF8',
              borderRadius: 2,
            }} />
          )}
        </button>

        <button
          onClick={() => setActiveTab('DETAILS')}
          style={{
            background: 'transparent',
            border: 'none',
            padding: '8px 4px 12px 4px',
            fontSize: '0.88rem',
            fontWeight: activeTab === 'DETAILS' ? 600 : 500,
            color: activeTab === 'DETAILS' ? '#FFFFFF' : '#64748B',
            cursor: 'pointer',
            position: 'relative',
            transition: 'color 0.15s ease',
          }}
        >
          Details
          {activeTab === 'DETAILS' && (
            <span style={{
              position: 'absolute',
              bottom: -2,
              left: 0,
              right: 0,
              height: 2,
              background: '#38BDF8',
              borderRadius: 2,
            }} />
          )}
        </button>
      </div>

      {/* Tab Content: OVERVIEW matching screenshot */}
      {activeTab === 'OVERVIEW' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* Section 1: Progress Card */}
          <div style={{
            background: '#0E121B',
            border: '1px solid rgba(255, 255, 255, 0.08)',
            borderRadius: 14,
            padding: '24px 28px',
          }}>
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 16,
            }}>
              <span style={{ fontSize: '1rem', fontWeight: 700, color: '#FFFFFF' }}>
                Progress
              </span>
              <span style={{
                fontSize: '0.84rem',
                fontWeight: 700,
                color: '#10B981',
                background: 'rgba(16, 185, 129, 0.12)',
                border: '1px solid rgba(16, 185, 129, 0.28)',
                padding: '3px 12px',
                borderRadius: 6,
              }}>
                {progressPercent}%
              </span>
            </div>

            {/* Vibrant green progress bar */}
            <div style={{
              height: 7,
              width: '100%',
              background: 'rgba(255, 255, 255, 0.08)',
              borderRadius: 4,
              overflow: 'hidden',
            }}>
              <div style={{
                height: '100%',
                width: `${progressPercent}%`,
                background: '#10B981',
                borderRadius: 4,
                transition: 'width 0.4s ease',
              }} />
            </div>
          </div>

          {/* Section 2: 6 Stat Cards in a row */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
            gap: 14,
          }}>
            {/* 1. Contacts */}
            <div style={{
              background: '#0E121B',
              border: '1px solid rgba(255, 255, 255, 0.08)',
              borderRadius: 12,
              padding: '16px 18px',
              display: 'flex',
              alignItems: 'center',
              gap: 14,
            }}>
              <div style={{
                width: 38,
                height: 38,
                borderRadius: 8,
                background: 'rgba(37, 99, 235, 0.16)',
                border: '1px solid rgba(37, 99, 235, 0.28)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#3B82F6',
                flexShrink: 0,
              }}>
                <Users size={18} />
              </div>
              <div>
                <div style={{ fontSize: '0.78rem', color: '#94A3B8' }}>Contacts</div>
                <div style={{ fontSize: '1.28rem', fontWeight: 700, color: '#FFFFFF', marginTop: 2 }}>
                  {totalContacts.toLocaleString()}
                </div>
              </div>
            </div>

            {/* 2. Unique called */}
            <div style={{
              background: '#0E121B',
              border: '1px solid rgba(255, 255, 255, 0.08)',
              borderRadius: 12,
              padding: '16px 18px',
              display: 'flex',
              alignItems: 'center',
              gap: 14,
            }}>
              <div style={{
                width: 38,
                height: 38,
                borderRadius: 8,
                background: 'rgba(147, 51, 234, 0.16)',
                border: '1px solid rgba(147, 51, 234, 0.28)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#A855F7',
                flexShrink: 0,
              }}>
                <Phone size={18} />
              </div>
              <div>
                <div style={{ fontSize: '0.78rem', color: '#94A3B8' }}>Unique called</div>
                <div style={{ fontSize: '1.28rem', fontWeight: 700, color: '#FFFFFF', marginTop: 2 }}>
                  {uniqueCalled.toLocaleString()}
                </div>
              </div>
            </div>

            {/* 3. Successful */}
            <div style={{
              background: '#0E121B',
              border: '1px solid rgba(255, 255, 255, 0.08)',
              borderRadius: 12,
              padding: '16px 18px',
              display: 'flex',
              alignItems: 'center',
              gap: 14,
            }}>
              <div style={{
                width: 38,
                height: 38,
                borderRadius: 8,
                background: 'rgba(16, 185, 129, 0.16)',
                border: '1px solid rgba(16, 185, 129, 0.28)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#10B981',
                flexShrink: 0,
              }}>
                <Check size={18} strokeWidth={2.5} />
              </div>
              <div>
                <div style={{ fontSize: '0.78rem', color: '#94A3B8' }}>Successful</div>
                <div style={{ fontSize: '1.28rem', fontWeight: 700, color: '#FFFFFF', marginTop: 2 }}>
                  {successful.toLocaleString()}
                </div>
              </div>
            </div>

            {/* 4. Failed */}
            <div style={{
              background: '#0E121B',
              border: '1px solid rgba(255, 255, 255, 0.08)',
              borderRadius: 12,
              padding: '16px 18px',
              display: 'flex',
              alignItems: 'center',
              gap: 14,
            }}>
              <div style={{
                width: 38,
                height: 38,
                borderRadius: 8,
                background: 'rgba(239, 68, 68, 0.16)',
                border: '1px solid rgba(239, 68, 68, 0.28)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#EF4444',
                flexShrink: 0,
              }}>
                <X size={18} strokeWidth={2.5} />
              </div>
              <div>
                <div style={{ fontSize: '0.78rem', color: '#94A3B8' }}>Failed</div>
                <div style={{ fontSize: '1.28rem', fontWeight: 700, color: '#FFFFFF', marginTop: 2 }}>
                  {failed.toLocaleString()}
                </div>
              </div>
            </div>

            {/* 5. Remaining */}
            <div style={{
              background: '#0E121B',
              border: '1px solid rgba(255, 255, 255, 0.08)',
              borderRadius: 12,
              padding: '16px 18px',
              display: 'flex',
              alignItems: 'center',
              gap: 14,
            }}>
              <div style={{
                width: 38,
                height: 38,
                borderRadius: 8,
                background: 'rgba(245, 158, 11, 0.16)',
                border: '1px solid rgba(245, 158, 11, 0.28)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#F59E0B',
                flexShrink: 0,
              }}>
                <Clock size={18} />
              </div>
              <div>
                <div style={{ fontSize: '0.78rem', color: '#94A3B8' }}>Remaining</div>
                <div style={{ fontSize: '1.28rem', fontWeight: 700, color: '#FFFFFF', marginTop: 2 }}>
                  {remaining.toLocaleString()}
                </div>
              </div>
            </div>

            {/* 6. Credits used */}
            <div style={{
              background: '#0E121B',
              border: '1px solid rgba(255, 255, 255, 0.08)',
              borderRadius: 12,
              padding: '16px 18px',
              display: 'flex',
              alignItems: 'center',
              gap: 14,
            }}>
              <div style={{
                width: 38,
                height: 38,
                borderRadius: 8,
                background: 'rgba(56, 189, 248, 0.16)',
                border: '1px solid rgba(56, 189, 248, 0.28)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#38BDF8',
                flexShrink: 0,
              }}>
                <Wallet size={18} />
              </div>
              <div>
                <div style={{ fontSize: '0.78rem', color: '#94A3B8' }}>Credits used</div>
                <div style={{ fontSize: '1.28rem', fontWeight: 700, color: '#FFFFFF', marginTop: 2 }}>
                  {creditsUsed.toLocaleString()}
                </div>
              </div>
            </div>
          </div>

          {/* Section 3: Outcome breakdown Card */}
          <div style={{
            background: '#0E121B',
            border: '1px solid rgba(255, 255, 255, 0.08)',
            borderRadius: 14,
            padding: '24px 28px',
          }}>
            <h2 style={{
              fontSize: '1.02rem',
              fontWeight: 700,
              color: '#FFFFFF',
              marginBottom: 20,
            }}>
              Outcome breakdown
            </h2>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {/* Row 1: Successful */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
                <span style={{ fontSize: '0.84rem', color: '#94A3B8', width: 140, flexShrink: 0 }}>
                  Successful
                </span>
                <div style={{ flex: 1, height: 6, background: 'rgba(255, 255, 255, 0.06)', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${successfulPercent}%`, background: '#10B981', borderRadius: 3 }} />
                </div>
                <span style={{ fontSize: '0.84rem', color: '#94A3B8', width: 90, textAlign: 'right', flexShrink: 0 }}>
                  {successful} ({successfulPercent}%)
                </span>
              </div>

              {/* Row 2: Failed */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
                <span style={{ fontSize: '0.84rem', color: '#94A3B8', width: 140, flexShrink: 0 }}>
                  Failed
                </span>
                <div style={{ flex: 1, height: 6, background: 'rgba(255, 255, 255, 0.06)', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${failedPercent}%`, background: '#EF4444', borderRadius: 3 }} />
                </div>
                <span style={{ fontSize: '0.84rem', color: '#94A3B8', width: 90, textAlign: 'right', flexShrink: 0 }}>
                  {failed} ({failedPercent}%)
                </span>
              </div>

              {/* Row 3: No answer / other */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
                <span style={{ fontSize: '0.84rem', color: '#94A3B8', width: 140, flexShrink: 0 }}>
                  No answer / other
                </span>
                <div style={{ flex: 1, height: 6, background: 'rgba(255, 255, 255, 0.06)', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: '0%', background: '#64748B', borderRadius: 3 }} />
                </div>
                <span style={{ fontSize: '0.84rem', color: '#94A3B8', width: 90, textAlign: 'right', flexShrink: 0 }}>
                  0 (0%)
                </span>
              </div>

              {/* Row 4: Remaining */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
                <span style={{ fontSize: '0.84rem', color: '#94A3B8', width: 140, flexShrink: 0 }}>
                  Remaining
                </span>
                <div style={{ flex: 1, height: 6, background: 'rgba(255, 255, 255, 0.06)', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${remainingPercent}%`, background: '#F59E0B', borderRadius: 3 }} />
                </div>
                <span style={{ fontSize: '0.84rem', color: '#94A3B8', width: 90, textAlign: 'right', flexShrink: 0 }}>
                  {remaining} ({remainingPercent}%)
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Tab Content: CALL LOG matching screenshot */}
      {activeTab === 'CALL_LOG' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          {/* Top Search & Filter Bar */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 16,
          }}>
            {/* Search Input */}
            <div style={{ position: 'relative', width: 340, maxWidth: '100%' }}>
              <Search
                size={16}
                style={{
                  position: 'absolute',
                  left: 14,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  color: '#64748B',
                  pointerEvents: 'none',
                }}
              />
              <input
                type="text"
                placeholder="Search..."
                value={callSearchTerm}
                onChange={(e) => setCallSearchTerm(e.target.value)}
                style={{
                  width: '100%',
                  padding: '9px 14px 9px 38px',
                  borderRadius: 10,
                  background: '#0E121B',
                  border: '1px solid rgba(255, 255, 255, 0.08)',
                  color: '#FFFFFF',
                  fontSize: '0.86rem',
                  outline: 'none',
                  transition: 'border-color 0.15s ease',
                }}
                onFocus={(e) => (e.currentTarget.style.borderColor = 'rgba(59, 130, 246, 0.5)')}
                onBlur={(e) => (e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.08)')}
              />
            </div>

            {/* Filter Dropdown */}
            <div style={{ position: 'relative' }}>
              <select
                value={callFilter}
                onChange={(e) => setCallFilter(e.target.value as any)}
                style={{
                  padding: '9px 38px 9px 16px',
                  borderRadius: 10,
                  background: '#0E121B',
                  border: '1px solid rgba(255, 255, 255, 0.12)',
                  color: '#FFFFFF',
                  fontSize: '0.86rem',
                  fontWeight: 600,
                  appearance: 'none',
                  WebkitAppearance: 'none',
                  cursor: 'pointer',
                  outline: 'none',
                  boxShadow: '0 4px 14px rgba(0, 0, 0, 0.4)',
                }}
              >
                <option value="ALL">All calls</option>
                <option value="SUCCESSFUL">Successful</option>
                <option value="FAILED">Failed</option>
                <option value="NO_ANSWER">No Answer</option>
              </select>
              <ChevronDown
                size={14}
                style={{
                  position: 'absolute',
                  right: 14,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  color: '#94A3B8',
                  pointerEvents: 'none',
                }}
              />
            </div>
          </div>

          {/* Table matching screenshot */}
          <div style={{ overflowX: 'auto', width: '100%' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
              <thead>
                <tr style={{
                  borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
                  color: '#64748B',
                  fontSize: '0.82rem',
                  fontWeight: 500,
                }}>
                  <th style={{ padding: '12px 16px', width: '22%' }}>Contact</th>
                  <th style={{ padding: '12px 16px', width: '16%' }}>Status</th>
                  <th style={{ padding: '12px 16px', width: '20%' }}>Result</th>
                  <th style={{ padding: '12px 16px', width: '14%' }}>Language</th>
                  <th style={{ padding: '12px 16px', width: '12%' }}>Duration</th>
                  <th style={{ padding: '12px 16px', width: '12%' }}>Time</th>
                  <th style={{ padding: '12px 16px', width: '4%', textAlign: 'right' }}></th>
                </tr>
              </thead>
              <tbody>
                {filteredCalls.length === 0 ? (
                  <tr>
                    <td colSpan={7} style={{ padding: 48, textAlign: 'center', color: '#64748B' }}>
                      {loadingCalls ? 'Loading campaign call logs...' : 'No call records found matching filter.'}
                    </td>
                  </tr>
                ) : (
                  filteredCalls.map((c, idx) => {
                    const rawPhone = (c as any).customer_phone || (c as any).phone || (c as any).customerPhone || '';
                    const phoneDisplay = rawPhone ? maskPhone(rawPhone) : '—';
                    const refId = (c as any).subs_del_no || (c as any).contact_ref || (c as any).lead_id || (c.id ? `REF-${c.id.slice(0, 6).toUpperCase()}` : '—');
                    const statusRaw = (c.status || '').toLowerCase();
                    const resultText = (c as any).disposition || (c as any).call_result || (c as any).notes || (statusRaw === 'completed' ? 'Goal completed' : '—');
                    const rawLang = (c as any).customer_language || (c as any).language || '';
                    const langText = rawLang === 'hi' ? 'Hindi' : (rawLang === 'en' ? 'English' : (rawLang || '—'));
                    const durationText = formatDuration(c.duration_seconds);
                    const timeText = (c as any).formatted_time || formatTime(c.created_at);

                    return (
                      <tr
                        key={c.id || idx}
                        onClick={() => onSelectCall && onSelectCall(c)}
                        style={{
                          borderBottom: '1px solid rgba(255, 255, 255, 0.04)',
                          cursor: 'pointer',
                          transition: 'background 0.15s ease',
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255, 255, 255, 0.02)')}
                        onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                      >
                        {/* Contact: Phone & Ref */}
                        <td style={{ padding: '14px 16px' }}>
                          <div style={{ color: '#FFFFFF', fontWeight: 700, fontSize: '0.88rem', letterSpacing: '0.01em' }}>
                            {phoneDisplay}
                          </div>
                          <div style={{ color: '#64748B', fontSize: '0.74rem', marginTop: 2 }}>
                            {refId}
                          </div>
                        </td>

                        {/* Status badge with 3 statuses */}
                        <td style={{ padding: '14px 16px' }}>
                          {(() => {
                            const norm = normalizeCallStatus(c.status, resultText);
                            if (norm === 'SUCCESSFUL') {
                              return (
                                <span style={{
                                  display: 'inline-block',
                                  padding: '3px 8px',
                                  borderRadius: 4,
                                  fontSize: '0.68rem',
                                  fontWeight: 700,
                                  letterSpacing: '0.04em',
                                  background: 'rgba(16, 185, 129, 0.12)',
                                  border: '1px solid rgba(16, 185, 129, 0.28)',
                                  color: '#10B981',
                                }}>
                                  SUCCESSFUL
                                </span>
                              );
                            }
                            if (norm === 'FAILED') {
                              return (
                                <span style={{
                                  display: 'inline-block',
                                  padding: '3px 8px',
                                  borderRadius: 4,
                                  fontSize: '0.68rem',
                                  fontWeight: 700,
                                  letterSpacing: '0.04em',
                                  background: 'rgba(239, 68, 68, 0.12)',
                                  border: '1px solid rgba(239, 68, 68, 0.28)',
                                  color: '#EF4444',
                                }}>
                                  FAILED
                                </span>
                              );
                            }
                            return (
                              <span style={{
                                display: 'inline-block',
                                padding: '3px 8px',
                                borderRadius: 4,
                                fontSize: '0.68rem',
                                fontWeight: 700,
                                letterSpacing: '0.04em',
                                background: 'rgba(245, 158, 11, 0.12)',
                                border: '1px solid rgba(245, 158, 11, 0.28)',
                                color: '#F59E0B',
                              }}>
                                NO ANSWER
                              </span>
                            );
                          })()}
                        </td>

                        {/* Result */}
                        <td style={{ padding: '14px 16px', color: '#94A3B8', fontSize: '0.85rem' }}>
                          {resultText}
                        </td>

                        {/* Language */}
                        <td style={{ padding: '14px 16px', color: '#94A3B8', fontSize: '0.85rem' }}>
                          {langText}
                        </td>

                        {/* Duration */}
                        <td style={{ padding: '14px 16px', color: '#94A3B8', fontSize: '0.85rem' }}>
                          {durationText}
                        </td>

                        {/* Time */}
                        <td style={{ padding: '14px 16px', color: '#94A3B8', fontSize: '0.85rem' }}>
                          {timeText}
                        </td>

                        {/* Rightmost action button with blue document icon matching screenshot */}
                        <td style={{ padding: '14px 16px', textAlign: 'right' }}>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              onSelectCall && onSelectCall(c);
                            }}
                            title="View Transcript & Audio"
                            aria-label="View Transcript"
                            style={{
                              width: 30,
                              height: 30,
                              borderRadius: 6,
                              background: 'rgba(37, 99, 235, 0.14)',
                              border: '1px solid rgba(59, 130, 246, 0.3)',
                              color: '#38BDF8',
                              display: 'inline-flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              cursor: 'pointer',
                              transition: 'all 0.15s ease',
                            }}
                            onMouseEnter={(e) => {
                              e.currentTarget.style.background = 'rgba(37, 99, 235, 0.25)';
                              e.currentTarget.style.borderColor = 'rgba(59, 130, 246, 0.55)';
                            }}
                            onMouseLeave={(e) => {
                              e.currentTarget.style.background = 'rgba(37, 99, 235, 0.14)';
                              e.currentTarget.style.borderColor = 'rgba(59, 130, 246, 0.3)';
                            }}
                          >
                            <FileText size={14} />
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
      )}

      {/* Tab Content: DETAILS matching user screenshot */}
      {activeTab === 'DETAILS' && (
        <div style={{
          background: '#0E121B',
          border: '1px solid rgba(255, 255, 255, 0.08)',
          borderRadius: 14,
          padding: '24px 28px',
          maxWidth: '100%',
        }}>
          {/* Card Title */}
          <h2 style={{
            fontSize: '1.02rem',
            fontWeight: 700,
            color: '#FFFFFF',
            margin: '0 0 10px 0',
          }}>
            Details
          </h2>

          {/* Description */}
          <p style={{
            fontSize: '0.86rem',
            color: '#94A3B8',
            margin: '0 0 24px 0',
            lineHeight: 1.5,
          }}>
            {campaign.description || 'Our future allocation Hindi test with English switching. Uses a three-way model for all unique contacts.'}
          </p>

          {/* Key-Value details list */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: '120px 1fr',
            rowGap: 14,
            columnGap: 24,
            alignItems: 'center',
            fontSize: '0.86rem',
          }}>
            <div style={{ color: '#94A3B8' }}>Service</div>
            <div style={{ color: '#FFFFFF', fontWeight: 700 }}>
              {campaign.service || 'curoai_service'}
            </div>

            <div style={{ color: '#94A3B8' }}>Date</div>
            <div style={{ color: '#FFFFFF', fontWeight: 700 }}>
              {campaign.execution_date || '7 Oct 2026'}
            </div>

            <div style={{ color: '#94A3B8' }}>Contacts</div>
            <div style={{ color: '#FFFFFF', fontWeight: 700 }}>
              {(campaign.total_contacts || 317).toLocaleString()}
            </div>

            <div style={{ color: '#94A3B8' }}>Campaign ID</div>
            <div style={{ color: '#FFFFFF', fontWeight: 700 }}>
              {(() => {
                if (!campaign.id) return 'c1';
                if (campaign.id === 'c1') return 'c1';
                if (campaign.id.startsWith('c1000000-0000-0000-0000-00000000000')) {
                  const num = parseInt(campaign.id.slice(-2), 10);
                  return `c${isNaN(num) ? 1 : num}`;
                }
                if (campaign.id.length <= 4) return campaign.id;
                return `c${campaign.id.slice(0, 2)}`;
              })()}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
