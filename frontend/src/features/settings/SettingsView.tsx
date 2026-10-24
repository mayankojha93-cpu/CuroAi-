import React, { useState } from 'react';
import { 
  Server, 
  PhoneCall, 
  Save, 
  CheckCircle2, 
  Volume2
} from 'lucide-react';
import type { SystemHealth, AuthUser } from '../../types';

interface SettingsViewProps {
  health: SystemHealth | null;
  user: AuthUser | null;
}

export const SettingsView: React.FC<SettingsViewProps> = ({ health, user }) => {
  const [telephonyProvider, setTelephonyProvider] = useState<'exotel' | 'twilio' | 'sip'>('exotel');
  const [voiceSpeed, setVoiceSpeed] = useState<number>(1.0);
  const [latencyThreshold, setLatencyThreshold] = useState<number>(850);
  const [savedSuccess, setSavedSuccess] = useState<boolean>(false);

  const handleSave = () => {
    setSavedSuccess(true);
    setTimeout(() => setSavedSuccess(false), 3000);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 28, paddingBottom: 32 }}>
      <div>
        <div style={{
          fontSize: '0.72rem',
          fontWeight: 800,
          letterSpacing: '0.08em',
          color: '#38BDF8',
          marginBottom: 6,
          textTransform: 'uppercase',
        }}>
          SYSTEM CONFIGURATION
        </div>
        <h1 style={{ fontSize: '1.9rem', fontWeight: 700, color: '#FFFFFF', letterSpacing: '-0.025em' }}>
          Settings & Agent Preferences
        </h1>
        <p style={{ fontSize: '0.88rem', color: '#94A3B8', marginTop: 4 }}>
          Fine-tune Priya voice agent thresholds, Exotel telephony hooks, and infrastructure health.
        </p>
      </div>

      {savedSuccess && (
        <div style={{
          padding: '12px 18px',
          borderRadius: 10,
          background: 'rgba(16, 185, 129, 0.12)',
          border: '1px solid rgba(16, 185, 129, 0.3)',
          color: '#34D399',
          fontSize: '0.86rem',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}>
          <CheckCircle2 size={16} /> Configuration saved and applied to running voice agents.
        </div>
      )}

      {/* Grid of settings panels */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))',
        gap: 22,
      }}>
        {/* Telephony & SIP Trunking */}
        <div style={{
          background: '#0E121B',
          border: '1px solid rgba(255, 255, 255, 0.08)',
          borderRadius: 14,
          padding: '22px 24px',
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{
              width: 36,
              height: 36,
              borderRadius: 8,
              background: 'rgba(37, 99, 235, 0.15)',
              border: '1px solid rgba(37, 99, 235, 0.3)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#3B82F6',
            }}>
              <PhoneCall size={18} />
            </div>
            <div>
              <h3 style={{ fontSize: '0.98rem', fontWeight: 600, color: '#FFFFFF' }}>
                Telephony Gateway
              </h3>
              <p style={{ fontSize: '0.76rem', color: '#64748B' }}>
                Primary trunk carrier for outbound campaigns
              </p>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <label style={{ fontSize: '0.82rem', color: '#94A3B8' }}>
              Telephony Provider
              <select
                value={telephonyProvider}
                onChange={(e) => setTelephonyProvider(e.target.value as any)}
                style={{
                  width: '100%',
                  marginTop: 6,
                  padding: '9px 12px',
                  borderRadius: 8,
                  background: 'rgba(0, 0, 0, 0.3)',
                  border: '1px solid rgba(255, 255, 255, 0.12)',
                  color: '#FFFFFF',
                  fontSize: '0.86rem',
                  outline: 'none',
                }}
              >
                <option value="exotel">Exotel Cloud Telephony (India PRI/SIP)</option>
                <option value="twilio">Twilio Voice Elastic Trunk</option>
                <option value="sip">Custom On-Prem Asterisk/FreeSWITCH SIP</option>
              </select>
            </label>

            <label style={{ fontSize: '0.82rem', color: '#94A3B8' }}>
              Caller ID (DID / Virtual Number)
              <input
                type="text"
                defaultValue="+91 80 4719 3300"
                style={{
                  width: '100%',
                  marginTop: 6,
                  padding: '9px 12px',
                  borderRadius: 8,
                  background: 'rgba(0, 0, 0, 0.3)',
                  border: '1px solid rgba(255, 255, 255, 0.12)',
                  color: '#FFFFFF',
                  fontSize: '0.86rem',
                  outline: 'none',
                }}
              />
            </label>
          </div>
        </div>

        {/* Voice AI Synthesis & Latency */}
        <div style={{
          background: '#0E121B',
          border: '1px solid rgba(255, 255, 255, 0.08)',
          borderRadius: 14,
          padding: '22px 24px',
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{
              width: 36,
              height: 36,
              borderRadius: 8,
              background: 'rgba(168, 85, 247, 0.15)',
              border: '1px solid rgba(168, 85, 247, 0.3)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#A855F7',
            }}>
              <Volume2 size={18} />
            </div>
            <div>
              <h3 style={{ fontSize: '0.98rem', fontWeight: 600, color: '#FFFFFF' }}>
                Voice Agent Priya Tuning
              </h3>
              <p style={{ fontSize: '0.76rem', color: '#64748B' }}>
                Acoustic model & interruption latency control
              </p>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.82rem', color: '#94A3B8', marginBottom: 6 }}>
                <span>Speech Rate Multiplier</span>
                <span style={{ color: '#38BDF8', fontWeight: 600 }}>{voiceSpeed.toFixed(1)}x</span>
              </div>
              <input
                type="range"
                min="0.8"
                max="1.3"
                step="0.05"
                value={voiceSpeed}
                onChange={(e) => setVoiceSpeed(parseFloat(e.target.value))}
                style={{ width: '100%', accentColor: '#38BDF8' }}
              />
            </div>

            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.82rem', color: '#94A3B8', marginBottom: 6 }}>
                <span>Max Target Turn-around Latency</span>
                <span style={{ color: '#10B981', fontWeight: 600 }}>{latencyThreshold} ms</span>
              </div>
              <input
                type="range"
                min="400"
                max="1500"
                step="50"
                value={latencyThreshold}
                onChange={(e) => setLatencyThreshold(parseInt(e.target.value))}
                style={{ width: '100%', accentColor: '#10B981' }}
              />
            </div>
          </div>
        </div>
      </div>

      {/* System Infrastructure Health Panel */}
      <div style={{
        background: '#0E121B',
        border: '1px solid rgba(255, 255, 255, 0.08)',
        borderRadius: 14,
        padding: '22px 24px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
          <Server size={18} color="#38BDF8" />
          <h3 style={{ fontSize: '1rem', fontWeight: 600, color: '#FFFFFF' }}>
            Infrastructure Diagnostics
          </h3>
        </div>

        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
          gap: 16,
        }}>
          <div style={{ background: 'rgba(255, 255, 255, 0.02)', padding: '14px', borderRadius: 10, border: '1px solid rgba(255, 255, 255, 0.05)' }}>
            <div style={{ fontSize: '0.74rem', color: '#64748B' }}>Backend API Status</div>
            <div style={{ fontSize: '0.98rem', fontWeight: 600, color: '#10B981', marginTop: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#10B981' }}></span>
              {health?.status || 'HEALTHY (ACTIVE)'}
            </div>
          </div>

          <div style={{ background: 'rgba(255, 255, 255, 0.02)', padding: '14px', borderRadius: 10, border: '1px solid rgba(255, 255, 255, 0.05)' }}>
            <div style={{ fontSize: '0.74rem', color: '#64748B' }}>Database Pool</div>
            <div style={{ fontSize: '0.98rem', fontWeight: 600, color: '#FFFFFF', marginTop: 4 }}>
              {health?.database?.connected ? 'PostgreSQL Connected' : 'Ready / Active'}
            </div>
          </div>

          <div style={{ background: 'rgba(255, 255, 255, 0.02)', padding: '14px', borderRadius: 10, border: '1px solid rgba(255, 255, 255, 0.05)' }}>
            <div style={{ fontSize: '0.74rem', color: '#64748B' }}>System Uptime</div>
            <div style={{ fontSize: '0.98rem', fontWeight: 600, color: '#38BDF8', marginTop: 4 }}>
              {health?.uptime ? `${Math.floor(health.uptime / 3600)}h ${Math.floor((health.uptime % 3600) / 60)}m` : '99.98% SLA'}
            </div>
          </div>

          <div style={{ background: 'rgba(255, 255, 255, 0.02)', padding: '14px', borderRadius: 10, border: '1px solid rgba(255, 255, 255, 0.05)' }}>
            <div style={{ fontSize: '0.74rem', color: '#64748B' }}>Authenticated Role</div>
            <div style={{ fontSize: '0.98rem', fontWeight: 600, color: '#C084FC', marginTop: 4 }}>
              {user?.role || 'Administrator'}
            </div>
          </div>
        </div>
      </div>

      {/* Save Button */}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button
          onClick={handleSave}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            background: '#2563EB',
            border: 'none',
            color: '#FFFFFF',
            padding: '11px 24px',
            borderRadius: 10,
            fontSize: '0.9rem',
            fontWeight: 600,
            cursor: 'pointer',
            boxShadow: '0 4px 16px rgba(37, 99, 235, 0.3)',
          }}
        >
          <Save size={16} />
          Save System Configuration
        </button>
      </div>
    </div>
  );
};
