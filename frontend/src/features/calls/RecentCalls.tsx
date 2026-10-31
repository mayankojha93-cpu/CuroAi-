import React, { useState, useMemo } from 'react';
import { Search, ChevronDown, FileText, Volume2 } from 'lucide-react';
import type { CallRecord } from '../../types';
import { matchCanonicalDisposition } from '../campaign/CampaignDetailView';

interface RecentCallsProps {
  calls: CallRecord[];
  onSelectCall: (call: CallRecord) => void;
}

export const RecentCalls: React.FC<RecentCallsProps> = ({ calls, onSelectCall }) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'SUCCESSFUL' | 'FAILED' | 'NO_ANSWER'>('ALL');

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
    return clean;
  };

  // 3 distinct statuses: Successful, Failed, and No Answer
  const normalizeStatus = (status: string, disposition?: string): 'SUCCESSFUL' | 'FAILED' | 'NO_ANSWER' => {
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

  const allCalls = useMemo(() => {
    return calls || [];
  }, [calls]);

  const filteredCalls = useMemo(() => {
    return allCalls.filter((c) => {
      const phone = c.customer_phone || (c as any).phone || '';
      const ref = (c as any).subs_del_no || (c as any).contact_ref || '';
      const camp = (c as any).campaign_name || '';
      const disp = c.final_disposition || (c as any).call_result || '';
      const lang = (c as any).language || (c as any).customer_language || '';

      const matchesSearch =
        phone.toLowerCase().includes(searchTerm.toLowerCase()) ||
        ref.toLowerCase().includes(searchTerm.toLowerCase()) ||
        camp.toLowerCase().includes(searchTerm.toLowerCase()) ||
        disp.toLowerCase().includes(searchTerm.toLowerCase()) ||
        lang.toLowerCase().includes(searchTerm.toLowerCase());

      const norm = normalizeStatus(c.status, disp);
      const matchesStatus =
        statusFilter === 'ALL' ||
        norm === statusFilter;

      return matchesSearch && matchesStatus;
    });
  }, [allCalls, searchTerm, statusFilter]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24, paddingBottom: 36 }}>
      {/* Header matching user screenshot */}
      <div>
        <h1 style={{
          fontSize: '1.95rem',
          fontWeight: 700,
          color: '#FFFFFF',
          letterSpacing: '-0.025em',
          lineHeight: 1.2,
        }}>
          Call log
        </h1>
        <p style={{ fontSize: '0.9rem', color: '#94A3B8', marginTop: 6 }}>
          Every call across all campaigns, newest first.
        </p>
      </div>

      {/* Search & Filter Toolbar with 3 statuses */}
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
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
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

        {/* Filter Dropdown supporting All calls, Successful, Failed, and No Answer */}
        <div style={{ position: 'relative' }}>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as any)}
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

      {/* Table matching CuroAI design with Campaign column and 3 statuses */}
      <div style={{ overflowX: 'auto', width: '100%' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
          <thead>
            <tr style={{
              borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
              color: '#64748B',
              fontSize: '0.82rem',
              fontWeight: 500,
            }}>
              <th style={{ padding: '12px 16px', width: '16%' }}>Contact</th>
              <th style={{ padding: '12px 16px', width: '24%' }}>Campaign</th>
              <th style={{ padding: '12px 16px', width: '13%' }}>Status</th>
              <th style={{ padding: '12px 16px', width: '15%' }}>Result</th>
              <th style={{ padding: '12px 16px', width: '10%' }}>Language</th>
              <th style={{ padding: '12px 16px', width: '10%' }}>Duration</th>
              <th style={{ padding: '12px 16px', width: '12%' }}>Time</th>
              <th style={{ padding: '12px 16px', width: '4%', textAlign: 'right' }}></th>
            </tr>
          </thead>
          <tbody>
            {filteredCalls.length === 0 ? (
              <tr>
                <td colSpan={8} style={{ padding: 48, textAlign: 'center', color: '#64748B' }}>
                  No call records found matching filter.
                </td>
              </tr>
            ) : (
              filteredCalls.map((call, idx) => {
                const phoneDisplay = maskPhone(call.customer_phone || (call as any).phone);
                const refId = call.subs_del_no || (call as any).contact_ref || '—';
                const campName = (call as any).campaign_name || 'Direct Voice Outreach';
                const rawResult = call.final_disposition || (call as any).call_result || call.call_status;
                const normStatus = normalizeStatus(call.status, rawResult);
                const resultText = rawResult
                  ? matchCanonicalDisposition(rawResult, call.duration_seconds, call.status)
                  : (normStatus === 'SUCCESSFUL' ? 'Confirmed For Pickup' : (normStatus === 'NO_ANSWER' ? 'Not Connected (No Answer)' : 'Not Connected (Failed)'));
                const langText = (call as any).language === 'en' || (call as any).customer_language === 'en' ? 'English' : 'Hindi';
                const durationText = formatDuration(call.duration_seconds);
                const timeText = (call as any).formatted_time || formatTime(call.created_at);

                return (
                  <tr
                    key={call.id || idx}
                    onClick={() => onSelectCall(call)}
                    style={{
                      borderBottom: '1px solid rgba(255, 255, 255, 0.04)',
                      cursor: 'pointer',
                      transition: 'background 0.15s ease',
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255, 255, 255, 0.02)')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                  >
                    {/* Contact */}
                    <td style={{ padding: '14px 16px' }}>
                      <div style={{ color: '#FFFFFF', fontWeight: 700, fontSize: '0.88rem', letterSpacing: '0.01em' }}>
                        {phoneDisplay}
                      </div>
                      <div style={{ color: '#64748B', fontSize: '0.74rem', marginTop: 2 }}>
                        {refId}
                      </div>
                    </td>

                    {/* Campaign */}
                    <td style={{
                      padding: '14px 16px',
                      color: '#94A3B8',
                      fontSize: '0.85rem',
                      maxWidth: 240,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}>
                      {campName}
                    </td>

                    {/* Status Badge with all 3 statuses: SUCCESSFUL, FAILED, NO ANSWER */}
                    <td style={{ padding: '14px 16px' }}>
                      {normStatus === 'SUCCESSFUL' && (
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
                      )}

                      {normStatus === 'FAILED' && (
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
                      )}

                      {normStatus === 'NO_ANSWER' && (
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
                      )}
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

                    {/* Action */}
                    <td style={{ padding: '14px 16px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6 }}>
                        {call.recording_url ? (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              onSelectCall(call);
                            }}
                            title="Call Recording Ready — Click to Listen"
                            style={{
                              width: 30,
                              height: 30,
                              borderRadius: 6,
                              background: 'rgba(16, 185, 129, 0.14)',
                              border: '1px solid rgba(16, 185, 129, 0.3)',
                              color: '#10B981',
                              display: 'inline-flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              cursor: 'pointer',
                              transition: 'all 0.15s ease',
                            }}
                          >
                            <Volume2 size={14} />
                          </button>
                        ) : null}

                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onSelectCall(call);
                          }}
                          title="View Transcript & Details"
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
                      </div>
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
