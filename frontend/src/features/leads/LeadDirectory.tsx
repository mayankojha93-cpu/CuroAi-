import React, { useState } from 'react';
import { Search, Phone, User, Calendar, UploadCloud } from 'lucide-react';
import type { Customer } from '../../types';

interface LeadDirectoryProps {
  customers: Customer[];
  onDial: (customerId: string, name?: string) => void;
  dialingId: string | null;
  onImportModalOpen?: () => void;
}

export const LeadDirectory: React.FC<LeadDirectoryProps> = ({ 
  customers, 
  onDial, 
  dialingId,
  onImportModalOpen 
}) => {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'ALL' | 'PENDING' | 'CONFIRMED' | 'DECLINED' | 'RETRYING'>('ALL');

  const filteredCustomers = customers.filter((c) => {
    const q = search.toLowerCase();
    const matchSearch =
      c.name.toLowerCase().includes(q) ||
      c.phone.toLowerCase().includes(q) ||
      (c.account_no && c.account_no.toLowerCase().includes(q)) ||
      (c.subs_del_no && c.subs_del_no.toLowerCase().includes(q)) ||
      c.address.toLowerCase().includes(q);

    if (!matchSearch) return false;

    if (filter === 'PENDING') return !c.is_closed && (!c.current_disposition || c.current_disposition === 'PENDING');
    if (filter === 'CONFIRMED') return c.current_disposition?.includes('CONFIRMED') || c.current_disposition?.includes('PICKUP');
    if (filter === 'DECLINED') return c.current_disposition?.includes('DECLINED') || c.current_disposition?.includes('REFUS');
    if (filter === 'RETRYING') return !c.is_closed && c.total_attempts > 0;
    return true;
  });

  const getStatusBadge = (c: Customer) => {
    if (c.is_closed) {
      if (c.current_disposition?.includes('CONFIRMED')) {
        return <span className="badge badge-green">Confirmed for Pickup</span>;
      }
      if (c.current_disposition?.includes('DECLINED') || c.current_disposition?.includes('REFUS')) {
        return <span className="badge badge-red">Refused / Declined</span>;
      }
      if (c.current_disposition === 'NOT_REACHED') {
        return <span className="badge badge-slate">Max Attempts (Not Reached)</span>;
      }
      return <span className="badge badge-purple">{c.current_disposition}</span>;
    }

    if (c.total_attempts > 0) {
      return (
        <span className="badge badge-amber">
          Retry {c.total_attempts}/{c.max_attempts}
        </span>
      );
    }

    return <span className="badge badge-blue">Pending First Call</span>;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Search and Filter Controls */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: 16,
      }}>
        {/* Search Bar */}
        <div style={{
          position: 'relative',
          flex: '1 1 320px',
          maxWidth: 450,
        }}>
          <Search size={16} color="var(--text-muted)" style={{ position: 'absolute', left: 14, top: 13 }} />
          <input
            type="text"
            placeholder="Search by Account No, Wi-Fi ID, Name, Phone..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{
              width: '100%',
              padding: '10px 14px 10px 38px',
              borderRadius: 'var(--radius-md)',
              background: 'rgba(15, 23, 42, 0.8)',
              border: '1px solid var(--border-light)',
              color: '#fff',
              fontSize: '0.88rem',
              outline: 'none',
            }}
          />
        </div>

        {/* Filter Pills and Action */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {(['ALL', 'PENDING', 'CONFIRMED', 'DECLINED', 'RETRYING'] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setFilter(tab)}
                style={{
                  padding: '6px 14px',
                  borderRadius: 20,
                  fontSize: '0.78rem',
                  fontWeight: 600,
                  background: filter === tab ? 'var(--airtel-red)' : 'rgba(255, 255, 255, 0.05)',
                  color: filter === tab ? '#fff' : 'var(--text-secondary)',
                  border: filter === tab ? '1px solid var(--airtel-red)' : '1px solid var(--border-subtle)',
                }}
              >
                {tab}
              </button>
            ))}
          </div>

          {onImportModalOpen && (
            <button
              onClick={onImportModalOpen}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                background: 'rgba(56, 189, 248, 0.12)',
                border: '1px solid rgba(56, 189, 248, 0.3)',
                color: 'var(--accent-cyan)',
                padding: '6px 14px',
                borderRadius: 20,
                fontSize: '0.78rem',
                fontWeight: 700,
                cursor: 'pointer',
              }}
              title="Upload leads CSV file"
            >
              <UploadCloud size={14} />
              Upload CSV
            </button>
          )}
        </div>
      </div>

      {/* Leads Table matching Image 2 columns */}
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
              <th style={{ padding: '14px 18px' }}>Subscriber & Account</th>
              <th style={{ padding: '14px 18px' }}>Customer Name</th>
              <th style={{ padding: '14px 18px' }}>Phone Number</th>
              <th style={{ padding: '14px 18px' }}>Service End</th>
              <th style={{ padding: '14px 18px' }}>Address</th>
              <th style={{ padding: '14px 18px' }}>Attempts</th>
              <th style={{ padding: '14px 18px' }}>Current Disposition</th>
              <th style={{ padding: '14px 18px', textAlign: 'right' }}>Action</th>
            </tr>
          </thead>
          <tbody>
            {filteredCustomers.length === 0 ? (
              <tr>
                <td colSpan={8} style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>
                  No customer leads matching the selected criteria.
                </td>
              </tr>
            ) : (
              filteredCustomers.map((cust) => {
                const isDialing = dialingId === cust.id;
                return (
                  <tr
                    key={cust.id}
                    style={{
                      borderBottom: '1px solid var(--border-subtle)',
                      transition: 'background 0.15s',
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255, 255, 255, 0.02)')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                  >
                    <td style={{ padding: '14px 18px' }}>
                      <div style={{ fontWeight: 600, color: '#fff' }}>
                        {cust.subs_del_no || '01121344121_wifi'}
                      </div>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                        Acc: {cust.account_no || '20022941256'}
                      </div>
                    </td>

                    <td style={{ padding: '14px 18px', fontWeight: 600, color: '#fff' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <User size={14} color="var(--text-muted)" />
                        {cust.name}
                      </div>
                    </td>

                    <td style={{ padding: '14px 18px', color: 'var(--text-secondary)' }}>
                      {cust.phone}
                    </td>

                    <td style={{ padding: '14px 18px', color: 'var(--text-muted)', fontSize: '0.8rem' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <Calendar size={13} />
                        {cust.service_end_date ? new Date(cust.service_end_date).toLocaleDateString() : '27 Aug 26'}
                      </div>
                    </td>

                    <td style={{ padding: '14px 18px', maxWidth: 260, color: 'var(--text-secondary)' }}>
                      <div style={{
                        display: '-webkit-box',
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: 'vertical',
                        overflow: 'hidden',
                        fontSize: '0.8rem',
                      }} title={cust.address}>
                        {cust.address}
                      </div>
                    </td>

                    <td style={{ padding: '14px 18px' }}>
                      <span style={{
                        fontWeight: 700,
                        color: cust.total_attempts >= cust.max_attempts ? 'var(--accent-rose)' : '#fff',
                      }}>
                        {cust.total_attempts} / {cust.max_attempts}
                      </span>
                    </td>

                    <td style={{ padding: '14px 18px' }}>
                      {getStatusBadge(cust)}
                    </td>

                    <td style={{ padding: '14px 18px', textAlign: 'right' }}>
                      <button
                        onClick={() => onDial(cust.id, cust.name)}
                        disabled={isDialing}
                        style={{
                          background: isDialing
                            ? 'var(--accent-amber)'
                            : 'linear-gradient(135deg, var(--airtel-red) 0%, var(--airtel-red-dark) 100%)',
                          color: '#fff',
                          padding: '7px 14px',
                          borderRadius: 'var(--radius-sm)',
                          fontSize: '0.78rem',
                          fontWeight: 700,
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 6,
                          boxShadow: '0 2px 8px rgba(228, 0, 0, 0.3)',
                          cursor: isDialing ? 'not-allowed' : 'pointer',
                        }}
                      >
                        <Phone size={13} style={{ animation: isDialing ? 'pulseGlow 1s infinite' : 'none' }} />
                        {isDialing ? 'Dialing...' : 'Dial Priya'}
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
