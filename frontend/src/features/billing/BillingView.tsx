import React, { useState, useEffect } from 'react';
import { Wallet, CheckCircle2 } from 'lucide-react';
import { fetchBillingBalance, addBillingCredits, fetchCampaigns } from '../../services/api.service';
import type { CampaignItem } from '../../types';

interface CampaignBillingRow {
  id: string;
  name: string;
  contacts: number;
  creditsUsed: number;
  status: string;
}

export const BillingView: React.FC = () => {
  const [credits, setCredits] = useState<number>(() => {
    const saved = localStorage.getItem('curoai_credits');
    return saved ? parseInt(saved, 10) : 0;
  });
  const [campaigns, setCampaigns] = useState<CampaignBillingRow[]>([]);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [isAdding, setIsAdding] = useState(false);

  // Load balance from backend
  useEffect(() => {
    fetchBillingBalance()
      .then((data) => {
        if (data && typeof data.available_credits === 'number') {
          setCredits(data.available_credits);
          localStorage.setItem('curoai_credits', String(data.available_credits));
        }
      })
      .catch(() => {});

    // Also load live campaigns if available
    fetchCampaigns()
      .then((data) => {
        if (data && data.length > 0) {
          const rows: CampaignBillingRow[] = data.map((c: CampaignItem) => ({
            id: c.id,
            name: c.name,
            contacts: c.total_contacts || (Array.isArray(c.contacts) ? c.contacts.length : 0),
            creditsUsed: c.credits_used || 0,
            status: (c.status || 'PAUSED').toUpperCase(),
          }));
          setCampaigns(rows);
        } else {
          setCampaigns([]);
        }
      })
      .catch(() => setCampaigns([]));
  }, []);

  const contactsStillToCall = campaigns
    .filter((c) => c.status === 'RUNNING' || c.status === 'PAUSED')
    .reduce((acc, c) => acc + (c.contacts || 0), 0);

  const handleAddCredits = async (amount: number) => {
    if (isAdding) return;
    setIsAdding(true);
    try {
      const res = await addBillingCredits(amount);
      const newBal = res.available_credits || credits + amount;
      setCredits(newBal);
      localStorage.setItem('curoai_credits', String(newBal));
      window.dispatchEvent(new CustomEvent('curoai_credits_updated', { detail: { credits: newBal } }));
      setToastMessage(`Successfully added +${amount.toLocaleString()} credits`);
      setTimeout(() => setToastMessage(null), 3000);
    } catch {
      // Fallback local update
      const newBal = credits + amount;
      setCredits(newBal);
      localStorage.setItem('curoai_credits', String(newBal));
      window.dispatchEvent(new CustomEvent('curoai_credits_updated', { detail: { credits: newBal } }));
      setToastMessage(`Added +${amount.toLocaleString()} credits (Demo Mode)`);
      setTimeout(() => setToastMessage(null), 3000);
    } finally {
      setIsAdding(false);
    }
  };

  const getStatusBadge = (status: string) => {
    const s = status.toUpperCase();
    if (s === 'COMPLETED') {
      return (
        <span style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '3px 10px',
          borderRadius: 6,
          fontSize: '0.72rem',
          fontWeight: 700,
          letterSpacing: '0.04em',
          background: 'rgba(168, 85, 247, 0.14)',
          border: '1px solid rgba(168, 85, 247, 0.3)',
          color: '#C084FC',
        }}>
          COMPLETED
        </span>
      );
    }
    if (s === 'PAUSED') {
      return (
        <span style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '3px 10px',
          borderRadius: 6,
          fontSize: '0.72rem',
          fontWeight: 700,
          letterSpacing: '0.04em',
          background: 'rgba(245, 158, 11, 0.14)',
          border: '1px solid rgba(245, 158, 11, 0.3)',
          color: '#F59E0B',
        }}>
          PAUSED
        </span>
      );
    }
    if (s === 'RUNNING') {
      return (
        <span style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '3px 10px',
          borderRadius: 6,
          fontSize: '0.72rem',
          fontWeight: 700,
          letterSpacing: '0.04em',
          background: 'rgba(16, 185, 129, 0.14)',
          border: '1px solid rgba(16, 185, 129, 0.3)',
          color: '#34D399',
        }}>
          RUNNING
        </span>
      );
    }
    return (
      <span style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '3px 10px',
        borderRadius: 6,
        fontSize: '0.72rem',
        fontWeight: 700,
        letterSpacing: '0.04em',
        background: 'rgba(244, 63, 94, 0.14)',
        border: '1px solid rgba(244, 63, 94, 0.3)',
        color: '#FB7185',
      }}>
        {s}
      </span>
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24, paddingBottom: 40, width: '100%' }}>
      {/* Page Header */}
      <div>
        <div style={{
          fontSize: '0.72rem',
          fontWeight: 800,
          letterSpacing: '0.08em',
          color: '#38BDF8',
          marginBottom: 6,
          textTransform: 'uppercase',
        }}>
          BILLING
        </div>
        <h1 style={{ fontSize: '1.95rem', fontWeight: 700, color: '#FFFFFF', letterSpacing: '-0.025em', margin: 0 }}>
          Credits
        </h1>
        <p style={{ fontSize: '0.88rem', color: '#94A3B8', marginTop: 6, marginBottom: 0 }}>
          Credits are used per contact in a campaign.
        </p>
      </div>

      {toastMessage && (
        <div style={{
          padding: '10px 16px',
          borderRadius: 8,
          background: 'rgba(16, 185, 129, 0.12)',
          border: '1px solid rgba(16, 185, 129, 0.28)',
          color: '#34D399',
          fontSize: '0.84rem',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}>
          <CheckCircle2 size={16} /> {toastMessage}
        </div>
      )}

      {/* Main Available Credits Box */}
      <div style={{
        background: '#0C101A',
        border: '1px solid rgba(255, 255, 255, 0.08)',
        borderRadius: 16,
        padding: '36px 32px 30px 32px',
        maxWidth: 580,
        width: '100%',
        margin: '0 auto',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        textAlign: 'center',
        boxShadow: '0 8px 32px rgba(0, 0, 0, 0.35)',
      }}>
        {/* Wallet Icon */}
        <div style={{
          width: 48,
          height: 48,
          borderRadius: 12,
          background: 'rgba(245, 158, 11, 0.12)',
          border: '1px solid rgba(245, 158, 11, 0.25)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#F59E0B',
          marginBottom: 16,
        }}>
          <Wallet size={24} />
        </div>

        {/* Title & Available credits count */}
        <div style={{ fontSize: '0.88rem', color: '#94A3B8', fontWeight: 500, marginBottom: 4 }}>
          Available credits
        </div>
        <div style={{
          fontSize: '3rem',
          fontWeight: 700,
          color: '#FFFFFF',
          letterSpacing: '-0.02em',
          lineHeight: 1.1,
          marginBottom: 14,
        }}>
          {credits.toLocaleString()}
        </div>

        {/* Subtitle explanation */}
        <p style={{
          fontSize: '0.85rem',
          color: '#94A3B8',
          lineHeight: 1.45,
          maxWidth: 440,
          margin: '0 0 24px 0',
        }}>
          {contactsStillToCall > 0
            ? `${contactsStillToCall.toLocaleString()} contacts still to call on paused or running campaigns — ${credits >= contactsStillToCall ? 'your balance covers them.' : 'additional credits recommended.'}`
            : 'All campaigns are up to date with zero remaining calls.'}
        </p>

        {/* Quick Add Buttons */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, marginBottom: 16 }}>
          <button
            onClick={() => handleAddCredits(1000)}
            disabled={isAdding}
            style={{
              background: '#131A29',
              border: '1px solid rgba(255, 255, 255, 0.12)',
              color: '#FFFFFF',
              borderRadius: 8,
              padding: '7px 18px',
              fontSize: '0.82rem',
              fontWeight: 600,
              cursor: isAdding ? 'not-allowed' : 'pointer',
              transition: 'all 0.15s ease',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = '#1E293B';
              e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.25)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = '#131A29';
              e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.12)';
            }}
          >
            + 1,000
          </button>

          <button
            onClick={() => handleAddCredits(5000)}
            disabled={isAdding}
            style={{
              background: '#131A29',
              border: '1px solid rgba(255, 255, 255, 0.12)',
              color: '#FFFFFF',
              borderRadius: 8,
              padding: '7px 18px',
              fontSize: '0.82rem',
              fontWeight: 600,
              cursor: isAdding ? 'not-allowed' : 'pointer',
              transition: 'all 0.15s ease',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = '#1E293B';
              e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.25)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = '#131A29';
              e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.12)';
            }}
          >
            + 5,000
          </button>

          <button
            onClick={() => handleAddCredits(10000)}
            disabled={isAdding}
            style={{
              background: '#131A29',
              border: '1px solid rgba(255, 255, 255, 0.12)',
              color: '#FFFFFF',
              borderRadius: 8,
              padding: '7px 18px',
              fontSize: '0.82rem',
              fontWeight: 600,
              cursor: isAdding ? 'not-allowed' : 'pointer',
              transition: 'all 0.15s ease',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = '#1E293B';
              e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.25)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = '#131A29';
              e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.12)';
            }}
          >
            + 10,000
          </button>
        </div>

        {/* Demo Mode Subtext */}
        <div style={{ fontSize: '0.75rem', color: '#64748B' }}>
          Demo mode: no payment is taken. Set a payment link in the code to go live.
        </div>
      </div>

      {/* Campaigns Credit Breakdown Table */}
      <div style={{
        marginTop: 12,
        background: '#0C101A',
        border: '1px solid rgba(255, 255, 255, 0.08)',
        borderRadius: 14,
        overflow: 'hidden',
      }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.85rem' }}>
          <thead>
            <tr style={{
              background: 'rgba(255, 255, 255, 0.02)',
              borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
              color: '#64748B',
              fontSize: '0.78rem',
              fontWeight: 500,
            }}>
              <th style={{ padding: '14px 22px' }}>Campaign</th>
              <th style={{ padding: '14px 22px' }}>Contacts</th>
              <th style={{ padding: '14px 22px' }}>Credits used</th>
              <th style={{ padding: '14px 22px', textAlign: 'right' }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {campaigns.length === 0 ? (
              <tr>
                <td colSpan={4} style={{ padding: '36px 20px', textAlign: 'center', color: '#64748B' }}>
                  No campaign credit breakdown available.
                </td>
              </tr>
            ) : (
              campaigns.map((camp) => (
                <tr
                  key={camp.id}
                  style={{
                    borderBottom: '1px solid rgba(255, 255, 255, 0.04)',
                    transition: 'background 0.15s ease',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255, 255, 255, 0.02)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  <td style={{
                    padding: '16px 22px',
                    color: '#FFFFFF',
                    fontWeight: 600,
                    fontSize: '0.86rem',
                  }}>
                    {camp.name}
                  </td>
                  <td style={{
                    padding: '16px 22px',
                    color: '#94A3B8',
                    fontSize: '0.86rem',
                  }}>
                    {camp.contacts.toLocaleString()}
                  </td>
                  <td style={{
                    padding: '16px 22px',
                    color: '#94A3B8',
                    fontSize: '0.86rem',
                  }}>
                    {camp.creditsUsed}
                  </td>
                  <td style={{
                    padding: '16px 22px',
                    textAlign: 'right',
                  }}>
                    {getStatusBadge(camp.status)}
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
