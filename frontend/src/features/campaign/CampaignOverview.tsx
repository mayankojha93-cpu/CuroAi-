import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { 
  Plus, 
  Search, 
  Play, 
  Pause, 
  Square, 
  Download, 
  Users, 
  PhoneCall, 
  Check, 
  X, 
  Clock, 
  ChevronDown,
  RotateCcw
} from 'lucide-react';
import type { CampaignSummary, CampaignItem, CampaignStage, CallRecord } from '../../types';
import { fetchCampaigns, updateCampaignStatus, fetchCampaignReport, type CampaignReportRow } from '../../services';
import { CampaignDetailView } from './CampaignDetailView';

interface CampaignOverviewProps {
  summary: CampaignSummary | null;
  loading: boolean;
  onImportModalOpen?: () => void;
  onSelectCall?: (call: CallRecord) => void;
  refreshTrigger?: number;
}

export const CampaignOverview: React.FC<CampaignOverviewProps> = ({
  summary: _summary,
  loading: _loading,
  onImportModalOpen,
  onSelectCall,
  refreshTrigger,
}) => {
  const [campaigns, setCampaigns] = useState<CampaignItem[]>([]);
  const [selectedCampaign, setSelectedCampaign] = useState<CampaignItem | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'RUNNING' | 'PAUSED' | 'COMPLETED' | 'STOPPED'>('ALL');
  const [isUpdatingId, setIsUpdatingId] = useState<string | null>(null);

  // Load campaigns from backend PostgreSQL database
  const loadCampaignsFromDb = useCallback(async () => {
    try {
      const data = await fetchCampaigns();
      setCampaigns(data || []);
    } catch {
      // Keep existing state if network error
    }
  }, []);

  useEffect(() => {
    loadCampaignsFromDb();
    const interval = setInterval(loadCampaignsFromDb, 8000);
    return () => clearInterval(interval);
  }, [loadCampaignsFromDb, refreshTrigger]);

  // Normalize status string (e.g., 'Running' -> 'RUNNING')
  const normalizeStatus = (status: string): 'RUNNING' | 'PAUSED' | 'COMPLETED' | 'STOPPED' => {
    const s = (status || '').toUpperCase();
    if (s.includes('RUN')) return 'RUNNING';
    if (s.includes('PAUS')) return 'PAUSED';
    if (s.includes('COMPLET')) return 'COMPLETED';
    if (s.includes('STOP')) return 'STOPPED';
    return 'RUNNING';
  };

  // Filter campaigns by search query and the 4 stages (Running, Paused, Completed, Stopped)
  const filteredCampaigns = useMemo(() => {
    return campaigns.filter((c) => {
      const matchesSearch = c.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                            c.description.toLowerCase().includes(searchTerm.toLowerCase());
      const normalized = normalizeStatus(c.status);
      const matchesStatus = statusFilter === 'ALL' || normalized === statusFilter;
      return matchesSearch && matchesStatus;
    });
  }, [campaigns, searchTerm, statusFilter]);

  // Stage transition action (Running <-> Paused <-> Stopped <-> Completed)
  const handleStageChange = async (id: string, newStage: CampaignStage) => {
    setIsUpdatingId(id);
    // Optimistic UI update
    setCampaigns((prev) =>
      prev.map((c) => (c.id === id ? { ...c, status: newStage } : c))
    );

    try {
      await updateCampaignStatus(id, newStage.toString().toUpperCase());
    } catch (err) {
      console.warn('Backend update failed, kept in local state:', err);
    } finally {
      setIsUpdatingId(null);
    }
  };

  const handleDownloadCsv = async (campaign: CampaignItem) => {
    try {
      const reportData: CampaignReportRow[] = await fetchCampaignReport(campaign.id);

      const headers = [
        'S.No.',
        'Lead Id',
        'SUBS DEL NO',
        'Mobile',
        'Customer Name',
        'Product Name',
        'Address',
        'Status',
        'Attempts Count',
        'Connected Attempts Count',
        'Last Call Time',
        'Attempt 1 Disposition',
        'Attempt 2 Disposition',
        'Attempt 3 Disposition',
        'Attempt 4 Disposition',
        'Attempt 5 Disposition',
        'Attempt 6 Disposition',
        'Attempt 7 Disposition',
        'Attempt 8 Disposition',
        'Final Disposition',
        'Conclusion Date',
        'Recording',
      ];

      const escapeCsvField = (field: string | number | null | undefined): string => {
        const str = String(field ?? '');
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
          return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
      };

      const csvRows = [headers.join(',')];
      for (const row of reportData) {
        csvRows.push([
          escapeCsvField(row.sno),
          escapeCsvField(row.lead_id),
          escapeCsvField(row.subs_del_no),
          escapeCsvField(row.mobile),
          escapeCsvField(row.customer_name),
          escapeCsvField(row.product_name),
          escapeCsvField(row.address),
          escapeCsvField(row.status),
          escapeCsvField(row.attempts_count),
          escapeCsvField(row.connected_attempts_count),
          escapeCsvField(row.last_call_time),
          escapeCsvField(row.attempt_1_disposition),
          escapeCsvField(row.attempt_2_disposition),
          escapeCsvField(row.attempt_3_disposition),
          escapeCsvField(row.attempt_4_disposition),
          escapeCsvField(row.attempt_5_disposition),
          escapeCsvField(row.attempt_6_disposition),
          escapeCsvField(row.attempt_7_disposition),
          escapeCsvField(row.attempt_8_disposition),
          escapeCsvField(row.final_disposition),
          escapeCsvField(row.conclusion_date),
          escapeCsvField(row.recording),
        ].join(','));
      }

      const csvContent = csvRows.join('\n');
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.setAttribute('href', url);
      link.setAttribute('download', `${campaign.name.replace(/\s+/g, '_')}_Report.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Failed to download report:', err);
    }
  };

  const getProgressBarColor = (status: string, idx: number) => {
    const norm = normalizeStatus(status);
    if (norm === 'RUNNING') return '#10B981'; // Green
    if (norm === 'PAUSED') return '#F59E0B';  // Amber
    if (norm === 'STOPPED') return '#FB7185'; // Red
    // COMPLETED
    const colors = ['#F59E0B', '#A855F7', '#38BDF8', '#10B981'];
    return colors[idx % colors.length];
  };

  // If a campaign is selected (e.g. by clicking the right-most play button on its card), show detail view matching user's screenshot
  if (selectedCampaign) {
    return (
      <CampaignDetailView
        campaign={selectedCampaign}
        onBack={() => {
          setSelectedCampaign(null);
          loadCampaignsFromDb();
        }}
        onSelectCall={onSelectCall}
      />
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 28, paddingBottom: 32 }}>
      {/* Top Header matching screenshot */}
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
            CAMPAIGNS
          </div>

          <h1 style={{
            fontSize: '1.95rem',
            fontWeight: 700,
            color: '#FFFFFF',
            letterSpacing: '-0.025em',
            lineHeight: 1.2,
          }}>
            Voice campaigns
          </h1>

          <p style={{
            fontSize: '0.9rem',
            color: '#94A3B8',
            marginTop: 6,
          }}>
            Manage and monitor every CuroAI outreach campaign.
          </p>
        </div>

        {/* Action Button: + Create campaign */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
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
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = '#2563EB';
              e.currentTarget.style.transform = 'translateY(0)';
            }}
          >
            <Plus size={16} strokeWidth={2.5} />
            Create campaign
          </button>
        </div>
      </div>

      {/* Filter and Search Bar with 4 stages matching user screenshot */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: 16,
      }}>
        {/* Search input with magnifying glass */}
        <div style={{ position: 'relative', width: 340, maxWidth: '100%' }}>
          <Search size={16} style={{
            position: 'absolute',
            left: 14,
            top: '50%',
            transform: 'translateY(-50%)',
            color: '#64748B',
            pointerEvents: 'none',
          }} />
          <input
            type="text"
            placeholder="Search..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            style={{
              width: '100%',
              padding: '10px 14px 10px 38px',
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

        {/* Dropdown Filter matching screenshot: All campaigns, Running, Paused, Completed, Stopped */}
        <div style={{ position: 'relative' }}>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as any)}
            style={{
              padding: '10px 38px 10px 16px',
              borderRadius: 10,
              background: '#0E121B',
              border: '1px solid rgba(255, 255, 255, 0.14)',
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
            <option value="ALL">All campaigns</option>
            <option value="RUNNING">Running</option>
            <option value="PAUSED">Paused</option>
            <option value="COMPLETED">Completed</option>
            <option value="STOPPED">Stopped</option>
          </select>
          <ChevronDown size={14} style={{
            position: 'absolute',
            right: 14,
            top: '50%',
            transform: 'translateY(-50%)',
            color: '#94A3B8',
            pointerEvents: 'none',
          }} />
        </div>
      </div>

      {/* Grid of Campaign Cards (3 Columns) */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(350px, 1fr))',
        gap: 20,
      }}>
        {filteredCampaigns.map((camp, idx) => {
          const normStatus = normalizeStatus(camp.status);
          const barColor = getProgressBarColor(normStatus, idx);
          const progress = camp.progress_percent ?? (normStatus === 'COMPLETED' ? 100 : 75);
          const isLoadingThis = isUpdatingId === camp.id;

          return (
            <div
              key={camp.id}
              onClick={() => setSelectedCampaign(camp)}
              style={{
                background: '#0E121B',
                border: '1px solid rgba(255, 255, 255, 0.08)',
                borderRadius: 14,
                padding: '22px 24px',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
                gap: 16,
                transition: 'border-color 0.2s ease, transform 0.2s ease',
                opacity: isLoadingThis ? 0.7 : 1,
                cursor: 'pointer',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.2)';
                e.currentTarget.style.transform = 'translateY(-2px)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.08)';
                e.currentTarget.style.transform = 'translateY(0)';
              }}
            >
              {/* Card Header: Title + Action Buttons */}
              <div>
                <div style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  justifyContent: 'space-between',
                  gap: 12,
                  marginBottom: 10,
                }}>
                  <h3 style={{
                    fontSize: '0.98rem',
                    fontWeight: 700,
                    color: '#FFFFFF',
                    lineHeight: 1.35,
                    flex: 1,
                  }}>
                    {camp.name}
                  </h3>

                  {/* Play & Stage controls */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                    {/* Right-most Play Button: opens campaign details overview matching screenshot */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedCampaign(camp);
                      }}
                      title="Open Campaign Overview & Calls"
                      aria-label="Open Campaign"
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: 6,
                        background: 'rgba(56, 189, 248, 0.12)',
                        border: '1px solid rgba(56, 189, 248, 0.35)',
                        color: '#38BDF8',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        cursor: 'pointer',
                        transition: 'all 0.15s ease',
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = 'rgba(56, 189, 248, 0.25)';
                        e.currentTarget.style.borderColor = 'rgba(56, 189, 248, 0.6)';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = 'rgba(56, 189, 248, 0.12)';
                        e.currentTarget.style.borderColor = 'rgba(56, 189, 248, 0.35)';
                      }}
                    >
                      <Play size={13} fill="currentColor" />
                    </button>

                    {/* Stage Toggle (Pause / Resume) */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (normStatus === 'RUNNING') {
                          handleStageChange(camp.id, 'PAUSED');
                        } else {
                          handleStageChange(camp.id, 'RUNNING');
                        }
                      }}
                      title={normStatus === 'RUNNING' ? 'Pause Campaign' : 'Start / Resume Campaign'}
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: 6,
                        background: 'rgba(255, 255, 255, 0.04)',
                        border: '1px solid rgba(255, 255, 255, 0.1)',
                        color: normStatus === 'RUNNING' ? '#10B981' : '#94A3B8',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        cursor: 'pointer',
                        transition: 'all 0.15s ease',
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'rgba(255, 255, 255, 0.04)')}
                    >
                      {normStatus === 'RUNNING' ? <Pause size={13} /> : <Play size={13} fill="currentColor" />}
                    </button>

                    {/* Stop / Reactivate Button */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (normStatus === 'STOPPED') {
                          handleStageChange(camp.id, 'RUNNING');
                        } else {
                          handleStageChange(camp.id, 'STOPPED');
                        }
                      }}
                      title={normStatus === 'STOPPED' ? 'Reactivate Campaign' : 'Stop Campaign'}
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: 6,
                        background: 'rgba(255, 255, 255, 0.04)',
                        border: '1px solid rgba(255, 255, 255, 0.1)',
                        color: normStatus === 'STOPPED' ? '#FB7185' : '#64748B',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        cursor: 'pointer',
                        transition: 'all 0.15s ease',
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(251, 113, 133, 0.15)')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'rgba(255, 255, 255, 0.04)')}
                    >
                      {normStatus === 'STOPPED' ? <RotateCcw size={12} /> : <Square size={12} fill="currentColor" />}
                    </button>
                  </div>
                </div>

                {/* Status Badge for all 4 stages: RUNNING, PAUSED, COMPLETED, STOPPED */}
                <div style={{ marginBottom: 12 }}>
                  {normStatus === 'RUNNING' && (
                    <span style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 5,
                      padding: '2px 8px',
                      borderRadius: 4,
                      background: 'rgba(16, 185, 129, 0.12)',
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
                      background: 'rgba(245, 158, 11, 0.12)',
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

                  {normStatus === 'COMPLETED' && (
                    <span style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 5,
                      padding: '2px 8px',
                      borderRadius: 4,
                      background: 'rgba(168, 85, 247, 0.12)',
                      border: '1px solid rgba(168, 85, 247, 0.35)',
                      color: '#C084FC',
                      fontSize: '0.68rem',
                      fontWeight: 700,
                      letterSpacing: '0.04em',
                    }}>
                      <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#C084FC', display: 'inline-block' }} />
                      COMPLETED
                    </span>
                  )}

                  {normStatus === 'STOPPED' && (
                    <span style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 5,
                      padding: '2px 8px',
                      borderRadius: 4,
                      background: 'rgba(239, 68, 68, 0.12)',
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

                {/* Description */}
                <p style={{
                  fontSize: '0.82rem',
                  color: '#94A3B8',
                  lineHeight: 1.5,
                  minHeight: 48,
                  marginBottom: 14,
                }}>
                  {camp.description}
                </p>

                {/* Contacts Meta Row */}
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 16,
                  fontSize: '0.78rem',
                  color: '#64748B',
                  marginBottom: 18,
                  flexWrap: 'wrap',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Users size={14} color="#94A3B8" />
                    <span style={{ color: '#E2E8F0', fontWeight: 500 }}>
                      {camp.total_contacts.toLocaleString()} contacts
                    </span>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <PhoneCall size={14} color="#94A3B8" />
                    <span style={{ color: '#E2E8F0', fontWeight: 500 }}>
                      {camp.unique_called.toLocaleString()} unique called
                    </span>
                  </div>

                  <div style={{ color: '#64748B' }}>
                    {camp.service || 'curoai_service'}
                  </div>
                </div>

                {/* Progress Bar & Telephony Breakdown */}
                <div style={{ marginBottom: 14 }}>
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    fontSize: '0.76rem',
                    marginBottom: 6,
                  }}>
                    <span style={{ color: '#94A3B8', fontWeight: 500 }}>Progress</span>
                    <span style={{ color: '#FFFFFF', fontWeight: 700 }}>{progress}%</span>
                  </div>

                  {/* Bar */}
                  <div style={{
                    height: 5,
                    width: '100%',
                    background: 'rgba(255, 255, 255, 0.08)',
                    borderRadius: 3,
                    overflow: 'hidden',
                    marginBottom: 10,
                  }}>
                    <div style={{
                      height: '100%',
                      width: `${progress}%`,
                      background: barColor,
                      borderRadius: 3,
                      transition: 'width 0.4s ease',
                    }} />
                  </div>

                  {/* Outcomes Row */}
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 16,
                    fontSize: '0.78rem',
                  }}>
                    <span style={{ color: '#10B981', display: 'flex', alignItems: 'center', gap: 4, fontWeight: 500 }}>
                      <Check size={13} strokeWidth={2.5} /> {camp.successful_calls.toLocaleString()} successful
                    </span>
                    <span style={{ color: '#EF4444', display: 'flex', alignItems: 'center', gap: 4, fontWeight: 500 }}>
                      <X size={13} strokeWidth={2.5} /> {camp.failed_calls.toLocaleString()} failed
                    </span>
                    <span style={{ color: '#F59E0B', display: 'flex', alignItems: 'center', gap: 4, fontWeight: 500 }}>
                      <Clock size={13} /> {camp.remaining_calls.toLocaleString()} remaining
                    </span>
                  </div>
                </div>
              </div>

              {/* Card Footer: Credits, Date & Download CSV Button */}
              <div>
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  paddingTop: 12,
                  borderTop: '1px solid rgba(255, 255, 255, 0.05)',
                  marginBottom: 12,
                }}>
                  <div style={{ fontSize: '0.8rem', fontWeight: 600, color: '#38BDF8' }}>
                    {camp.credits_used ?? 0} / {(camp.total_credits || camp.total_contacts).toLocaleString()} credits
                  </div>
                  <div style={{ fontSize: '0.78rem', color: '#64748B' }}>
                    {camp.execution_date || 'October 2026'}
                  </div>
                </div>

                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDownloadCsv(camp);
                  }}
                  style={{
                    width: '100%',
                    padding: '9px 14px',
                    borderRadius: 8,
                    background: 'rgba(255, 255, 255, 0.03)',
                    border: '1px solid rgba(255, 255, 255, 0.08)',
                    color: '#E2E8F0',
                    fontSize: '0.82rem',
                    fontWeight: 600,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 8,
                    transition: 'all 0.15s ease',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'rgba(255, 255, 255, 0.08)';
                    e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.2)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'rgba(255, 255, 255, 0.03)';
                    e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.08)';
                  }}
                >
                  <Download size={14} color="#94A3B8" />
                  Download report (CSV)
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
