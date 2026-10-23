import React from 'react';
import { BarChart3, Users, PhoneCall, RotateCcw, BookOpen } from 'lucide-react';
import type { TabKey } from '../types';

interface NavigationTabsProps {
  activeTab: TabKey;
  onTabChange: (tab: TabKey) => void;
  leadsCount: number;
  callsCount: number;
  retriesCount: number;
}

export const NavigationTabs: React.FC<NavigationTabsProps> = ({
  activeTab,
  onTabChange,
  leadsCount,
  callsCount,
  retriesCount,
}) => {
  const tabs = [
    {
      id: 'CAMPAIGN' as TabKey,
      label: 'Campaign Overview (MIS)',
      icon: <BarChart3 size={16} />,
      badge: null,
    },
    {
      id: 'LEADS' as TabKey,
      label: 'Lead Directory & Calling',
      icon: <Users size={16} />,
      badge: leadsCount > 0 ? leadsCount : null,
      badgeColor: 'badge-green',
    },
    {
      id: 'CALLS' as TabKey,
      label: 'Recent Calls & Audio Audit',
      icon: <PhoneCall size={16} />,
      badge: callsCount > 0 ? callsCount : null,
      badgeColor: 'badge-blue',
    },
    {
      id: 'RETRIES' as TabKey,
      label: 'Retry Queue (3-Hour Cooldown)',
      icon: <RotateCcw size={16} />,
      badge: retriesCount > 0 ? retriesCount : null,
      badgeColor: 'badge-amber',
    },
    {
      id: 'SOP' as TabKey,
      label: '17 FAQ & SOP Scenarios',
      icon: <BookOpen size={16} />,
      badge: '17 SOP',
      badgeColor: 'badge-neutral',
    },
  ];

  return (
    <div style={{
      display: 'flex',
      gap: 6,
      borderBottom: '1px solid var(--border-subtle)',
      paddingBottom: 2,
      marginBottom: 24,
      overflowX: 'auto',
    }}>
      {tabs.map((tab) => {
        const isActive = activeTab === tab.id;
        return (
          <button
            key={tab.id}
            onClick={() => onTabChange(tab.id)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '12px 18px',
              borderRadius: 'var(--radius-md) var(--radius-md) 0 0',
              background: isActive ? 'rgba(156, 195, 169, 0.12)' : 'transparent',
              border: 'none',
              borderBottom: isActive ? '2px solid var(--curo-sage)' : '2px solid transparent',
              color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
              fontWeight: isActive ? 600 : 500,
              fontSize: '0.88rem',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              transition: 'all 0.15s ease',
            }}
            onMouseEnter={(e) => {
              if (!isActive) {
                e.currentTarget.style.color = 'var(--text-primary)';
                e.currentTarget.style.background = 'rgba(255, 255, 255, 0.02)';
              }
            }}
            onMouseLeave={(e) => {
              if (!isActive) {
                e.currentTarget.style.color = 'var(--text-secondary)';
                e.currentTarget.style.background = 'transparent';
              }
            }}
          >
            {tab.icon}
            {tab.label}
            {tab.badge !== null && (
              <span 
                className={`badge ${tab.badgeColor || (isActive ? 'badge-green' : 'badge-neutral')}`} 
                style={{ fontSize: '0.7rem', padding: '1px 6px' }}
              >
                {tab.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
};
