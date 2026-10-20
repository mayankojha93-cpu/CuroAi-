import React, { useState } from 'react';
import { 
  BarChart3, Users, PhoneCall, PhoneOff, CalendarCheck, 
  CheckCircle2, Clock, ShieldAlert, HelpCircle, PhoneMissed, 
  Filter, Search
} from 'lucide-react';
import type { CampaignSummary } from '../../types';

interface CampaignOverviewProps {
  summary: CampaignSummary | null;
  loading: boolean;
}

export const CampaignOverview: React.FC<CampaignOverviewProps> = ({ summary, loading }) => {
  const [selectedCategory, setSelectedCategory] = useState<string>('ALL');
  const [searchTerm, setSearchTerm] = useState<string>('');

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

  const disconnectedCount = Math.max(0, overview.sourceRows - overview.connectedCalls);
  const disconnectedPercent = overview.sourceRows > 0
    ? Math.round((disconnectedCount / overview.sourceRows) * 100)
    : 0;

  // Flatten all dispositions for the detailed MIS table
  const allDispositions = categories.flatMap((cat) =>
    cat.dispositions.map((disp) => {
      const categoryTotal = cat.dispositions.reduce((acc, d) => acc + d.count, 0);
      const categoryShare = categoryTotal > 0 ? Math.round((disp.count / categoryTotal) * 100) : 0;
      const baseShare = overview.sourceRows > 0 ? ((disp.count / overview.sourceRows) * 100).toFixed(1) : '0.0';

      return {
        category: cat.category,
        name: disp.name,
        count: disp.count,
        categoryTotal,
        categoryShare,
        baseShare,
      };
    })
  );

  // Filter dispositions based on search and selected category
  const filteredDispositions = allDispositions.filter((item) => {
    const matchesCategory = selectedCategory === 'ALL' || item.category === selectedCategory;
    const matchesSearch = item.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                          item.category.toLowerCase().includes(searchTerm.toLowerCase());
    return matchesCategory && matchesSearch;
  });

  const getCategoryMeta = (categoryName: string) => {
    const lower = categoryName.toLowerCase();
    if (lower.includes('ready') || lower.includes('pickup')) {
      return {
        color: 'var(--accent-green)',
        badgeClass: 'badge-green',
        icon: <CheckCircle2 size={16} color="var(--accent-green)" />,
        actionTag: 'Field Technician Dispatched',
        tagClass: 'badge-green',
      };
    }
    if (lower.includes('callback')) {
      return {
        color: 'var(--accent-blue)',
        badgeClass: 'badge-blue',
        icon: <Clock size={16} color="var(--accent-blue)" />,
        actionTag: 'Callback Scheduled in CRM',
        tagClass: 'badge-blue',
      };
    }
    if (lower.includes('will not return') || lower.includes('refus')) {
      return {
        color: 'var(--accent-rose)',
        badgeClass: 'badge-red',
        icon: <ShieldAlert size={16} color="var(--accent-rose)" />,
        actionTag: 'Closed / Terminal Exception',
        tagClass: 'badge-red',
      };
    }
    if (lower.includes('other')) {
      return {
        color: 'var(--accent-purple)',
        badgeClass: 'badge-purple',
        icon: <HelpCircle size={16} color="var(--accent-purple)" />,
        actionTag: 'Airtel 121 / DND Registry',
        tagClass: 'badge-purple',
      };
    }
    // Unconnected / Multiple attempts
    return {
      color: 'var(--accent-amber)',
      badgeClass: 'badge-amber',
      icon: <PhoneMissed size={16} color="var(--accent-amber)" />,
      actionTag: '3-Hour Cooldown Retry Queue',
      tagClass: 'badge-amber',
    };
  };

  const getDispositionAction = (name: string, category: string) => {
    const n = name.toLowerCase();
    if (n.includes('confirmed for pickup')) return { label: 'Technician Assigned', variant: 'badge-green' };
    if (n.includes('willing to pickup')) return { label: 'Awaiting Date Selection', variant: 'badge-blue' };
    if (n.includes('callback')) return { label: 'Queued for Re-contact', variant: 'badge-blue' };
    if (n.includes('already returned')) return { label: 'Inventory Reconciled', variant: 'badge-slate' };
    if (n.includes('refused')) return { label: 'Customer Refusal Logged', variant: 'badge-red' };
    if (n.includes('damaged') || n.includes('lost')) return { label: 'Hardware Write-Off', variant: 'badge-red' };
    if (n.includes('recharged') || n.includes('recharge')) return { label: 'Retention Verified', variant: 'badge-green' };
    if (n.includes('refund')) return { label: 'Escalated to 121 Billing', variant: 'badge-amber' };
    if (n.includes('wrong number')) return { label: 'Lead Invalidated', variant: 'badge-slate' };
    if (n.includes('do not call')) return { label: 'DND Flagged', variant: 'badge-red' };
    if (n.includes('language')) return { label: 'Regional Queue Routing', variant: 'badge-purple' };
    if (n.includes('disconnected')) return { label: 'Auto-Retry (3h Cooldown)', variant: 'badge-amber' };
    if (n.includes('no answer') || n.includes('voicemail')) return { label: 'Slot 2/3 Retry Scheduled', variant: 'badge-amber' };
    if (n.includes('not reached')) return { label: 'Max Attempts Exhausted', variant: 'badge-slate' };
    return { label: getCategoryMeta(category).actionTag, variant: getCategoryMeta(category).tagClass };
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      {/* Hero Header */}
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
            Audited management information system tracking base penetration, connection yield, and disposition shares
          </p>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="badge badge-green" style={{ fontSize: '0.78rem', padding: '4px 10px' }}>
            <span className="pulse-indicator" style={{ background: '#10b981' }}></span>
            Real-Time Audit Active
          </span>
        </div>
      </div>

      {/* 5 Audited KPI Cards (Matching Image 1) */}
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

      {/* Categorical Breakdown Container */}
      <div className="glass-panel" style={{ padding: 24, borderRadius: 'var(--radius-lg)' }}>
        {/* Section Title & Search */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 16,
          marginBottom: 20,
        }}>
          <div>
            <h3 style={{ fontSize: '1.15rem', fontWeight: 800, color: '#fff', letterSpacing: '-0.01em' }}>
              Audited Category Dispositions Breakdown
            </h3>
            <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
              Comprehensive telecom auditing matrix with sub-disposition volume, category share, and pipeline action
            </p>
          </div>

          {/* Search Box */}
          <div style={{ position: 'relative', width: 260 }}>
            <Search size={15} color="var(--text-muted)" style={{ position: 'absolute', left: 12, top: 10 }} />
            <input
              type="text"
              placeholder="Search dispositions..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              style={{
                width: '100%',
                padding: '7px 12px 7px 34px',
                borderRadius: 'var(--radius-md)',
                background: 'rgba(15, 23, 42, 0.8)',
                border: '1px solid var(--border-light)',
                color: '#fff',
                fontSize: '0.82rem',
                outline: 'none',
              }}
            />
          </div>
        </div>

        {/* Category Filter Pills */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexWrap: 'wrap',
          paddingBottom: 16,
          borderBottom: '1px solid var(--border-subtle)',
          marginBottom: 16,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-muted)', fontSize: '0.78rem', marginRight: 4 }}>
            <Filter size={13} />
            <span>Filter Category:</span>
          </div>

          <button
            onClick={() => setSelectedCategory('ALL')}
            style={{
              padding: '6px 14px',
              borderRadius: 20,
              fontSize: '0.78rem',
              fontWeight: 600,
              background: selectedCategory === 'ALL' ? 'var(--airtel-red)' : 'rgba(255, 255, 255, 0.05)',
              color: selectedCategory === 'ALL' ? '#fff' : 'var(--text-secondary)',
              border: selectedCategory === 'ALL' ? '1px solid var(--airtel-red)' : '1px solid var(--border-subtle)',
              cursor: 'pointer',
              transition: 'all 0.15s ease',
            }}
          >
            All Categories ({allDispositions.length})
          </button>

          {categories.map((cat, idx) => {
            const meta = getCategoryMeta(cat.category);
            const isSelected = selectedCategory === cat.category;
            const catTotal = cat.dispositions.reduce((acc, d) => acc + d.count, 0);

            return (
              <button
                key={idx}
                onClick={() => setSelectedCategory(cat.category)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '6px 14px',
                  borderRadius: 20,
                  fontSize: '0.78rem',
                  fontWeight: 600,
                  background: isSelected ? 'rgba(255, 255, 255, 0.12)' : 'rgba(255, 255, 255, 0.04)',
                  color: isSelected ? '#fff' : 'var(--text-secondary)',
                  border: isSelected ? `1px solid ${meta.color}` : '1px solid var(--border-subtle)',
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                }}
              >
                {meta.icon}
                <span>{cat.category}</span>
                <span style={{
                  background: 'rgba(0, 0, 0, 0.3)',
                  padding: '1px 6px',
                  borderRadius: 10,
                  fontSize: '0.7rem',
                  color: isSelected ? meta.color : 'var(--text-muted)',
                }}>
                  {catTotal}
                </span>
              </button>
            );
          })}
        </div>

        {/* Executive MIS Structured Table */}
        <div style={{ overflowX: 'auto', borderRadius: 'var(--radius-md)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.86rem' }}>
            <thead>
              <tr style={{
                background: 'rgba(255, 255, 255, 0.03)',
                borderBottom: '1px solid var(--border-subtle)',
                color: 'var(--text-muted)',
                fontSize: '0.74rem',
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
              }}>
                <th style={{ padding: '12px 16px', width: '22%' }}>Category Group</th>
                <th style={{ padding: '12px 16px', width: '26%' }}>Audited Sub-Disposition</th>
                <th style={{ padding: '12px 16px', textAlign: 'center', width: '12%' }}>Volume (Count)</th>
                <th style={{ padding: '12px 16px', width: '18%' }}>Category Share (%)</th>
                <th style={{ padding: '12px 16px', textAlign: 'center', width: '10%' }}>% of Base</th>
                <th style={{ padding: '12px 16px', textAlign: 'right', width: '12%' }}>Pipeline Action</th>
              </tr>
            </thead>
            <tbody>
              {filteredDispositions.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>
                    No dispositions found matching criteria.
                  </td>
                </tr>
              ) : (
                filteredDispositions.map((disp, idx) => {
                  const meta = getCategoryMeta(disp.category);
                  const action = getDispositionAction(disp.name, disp.category);

                  return (
                    <tr
                      key={idx}
                      style={{
                        borderBottom: '1px solid var(--border-subtle)',
                        transition: 'background 0.15s ease',
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255, 255, 255, 0.02)')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                    >
                      {/* Category */}
                      <td style={{ padding: '14px 16px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          {meta.icon}
                          <span style={{ fontWeight: 600, color: '#fff', fontSize: '0.84rem' }}>
                            {disp.category}
                          </span>
                        </div>
                      </td>

                      {/* Sub-disposition Name */}
                      <td style={{ padding: '14px 16px' }}>
                        <div style={{ fontWeight: 600, color: 'var(--text-primary, #f1f5f9)', fontSize: '0.86rem' }}>
                          {disp.name}
                        </div>
                      </td>

                      {/* Volume Count */}
                      <td style={{ padding: '14px 16px', textAlign: 'center' }}>
                        <span style={{
                          display: 'inline-block',
                          padding: '3px 10px',
                          borderRadius: 6,
                          background: disp.count > 0 ? 'rgba(255, 255, 255, 0.06)' : 'transparent',
                          color: disp.count > 0 ? '#fff' : 'var(--text-muted)',
                          fontWeight: 700,
                          fontSize: '0.88rem',
                        }}>
                          {disp.count.toLocaleString()}
                        </span>
                      </td>

                      {/* Category Share with Progress Bar */}
                      <td style={{ padding: '14px 16px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <div style={{
                            flex: 1,
                            height: 6,
                            background: 'rgba(255, 255, 255, 0.08)',
                            borderRadius: 3,
                            overflow: 'hidden',
                          }}>
                            <div style={{
                              width: `${Math.min(disp.categoryShare, 100)}%`,
                              height: '100%',
                              background: meta.color,
                              borderRadius: 3,
                              transition: 'width 0.4s ease',
                            }} />
                          </div>
                          <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', width: 36, textAlign: 'right', fontWeight: 600 }}>
                            {disp.categoryShare}%
                          </span>
                        </div>
                      </td>

                      {/* Base Share */}
                      <td style={{ padding: '14px 16px', textAlign: 'center', color: 'var(--text-secondary)', fontSize: '0.82rem', fontWeight: 600 }}>
                        {disp.baseShare}%
                      </td>

                      {/* Action Tag */}
                      <td style={{ padding: '14px 16px', textAlign: 'right' }}>
                        <span className={`badge ${action.variant}`} style={{ fontSize: '0.72rem', whiteSpace: 'nowrap' }}>
                          {action.label}
                        </span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Table Summary Footer */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 12,
          marginTop: 18,
          paddingTop: 16,
          borderTop: '1px solid var(--border-subtle)',
          fontSize: '0.8rem',
          color: 'var(--text-muted)',
        }}>
          <div>
            Showing <strong style={{ color: '#fff' }}>{filteredDispositions.length}</strong> audited dispositions across{' '}
            <strong style={{ color: '#fff' }}>{categories.length}</strong> campaign categories
          </div>
          <div style={{ display: 'flex', gap: 16 }}>
            <span>Base Penetration: <strong style={{ color: 'var(--accent-cyan)' }}>{overview.sourceRows > 0 ? Math.round((overview.totalAttempts / overview.sourceRows) * 100) : 0}%</strong></span>
            <span>Audited Closures: <strong style={{ color: 'var(--accent-green)' }}>{overview.dispositionedContacts}</strong></span>
          </div>
        </div>
      </div>
    </div>
  );
};
