import React, { useState } from 'react';
import { 
  X, 
  PhoneCall, 
  Sparkles, 
  User, 
  MapPin, 
  Calendar, 
  Hash, 
  Wifi, 
  CheckCircle2, 
  AlertCircle,
  Radio,
  ArrowRight
} from 'lucide-react';
import { initiateTestCall, type TestCallInput } from '../../services';

interface TestCallModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCallInitiated?: () => void;
}

interface SamplePreset {
  id: string;
  title: string;
  tag: string;
  description: string;
  data: TestCallInput;
}

const DEVELOPER_PRESETS: SamplePreset[] = [
  {
    id: 'delhi-routine',
    title: 'Airtel Delhi Wi-Fi (Routine Pickup)',
    tag: 'Spreadsheet Sample',
    description: 'Routine Wi-Fi router return after service end date in Sant Nagar, Delhi',
    data: {
      name: 'Rajan Nayak',
      phone: '+919811122233',
      subs_del_no: '01121344121_wifi',
      account_no: '20022941256',
      service_end_date: '2026-08-27',
      r_date: '2026-08-29',
      address: 'Delhi, 110011, burari, sant nagar',
      language: 'hi',
    },
  },
  {
    id: 'bengaluru-relocated',
    title: 'Airtel Fiber Bengaluru (Shifted Address)',
    tag: 'Relocation Scenario',
    description: 'Customer moved to a new flat in Koramangala; needs new address confirmation',
    data: {
      name: 'Vikram Malhotra',
      phone: '+919845012345',
      subs_del_no: '08041239876_wifi',
      account_no: '20038891044',
      service_end_date: '2026-09-15',
      r_date: '2026-09-18',
      address: 'Flat 402, Sunshine Heights, Koramangala 4th Block, Bengaluru - 560034',
      language: 'hi',
    },
  },
  {
    id: 'noida-refund-query',
    title: 'Airtel Wi-Fi Noida (Dispute / 121 Query)',
    tag: 'Dispute Scenario',
    description: 'Customer claims router deposit refund; agent Priya clarifies policy and logs escalation',
    data: {
      name: 'Pooja Sharma',
      phone: '+919810987654',
      subs_del_no: '01149876543_wifi',
      account_no: '20049981231',
      service_end_date: '2026-08-10',
      r_date: '2026-08-14',
      address: 'C-12, Sector 62, Green Park Extension, Noida, UP - 201309',
      language: 'hi',
    },
  },
];

export const TestCallModal: React.FC<TestCallModalProps> = ({ isOpen, onClose, onCallInitiated }) => {
  const [selectedPresetId, setSelectedPresetId] = useState<string>('delhi-routine');
  const [formData, setFormData] = useState<TestCallInput>(DEVELOPER_PRESETS[0].data);
  const [isDialing, setIsDialing] = useState(false);
  const [dialResult, setDialResult] = useState<any | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleSelectPreset = (preset: SamplePreset) => {
    setSelectedPresetId(preset.id);
    // Keep user's custom phone number if they already typed one
    const currentPhone = formData.phone;
    setFormData({
      ...preset.data,
      phone: currentPhone || preset.data.phone,
    });
    setError(null);
    setDialResult(null);
  };

  const handleChange = (field: keyof TestCallInput, value: string) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  const handleStartTestCall = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setDialResult(null);

    if (!formData.phone || formData.phone.trim().length < 8) {
      setError('Please provide a valid recipient phone number (e.g. +9198XXXXXXXX).');
      return;
    }

    try {
      setIsDialing(true);
      const res = await initiateTestCall(formData);
      setDialResult(res.call);
      if (onCallInitiated) {
        onCallInitiated();
      }
    } catch (err: any) {
      setError(err.message || 'Call initiation failed. Verify your LiveKit and SIP trunk credentials.');
    } finally {
      setIsDialing(false);
    }
  };

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      background: 'rgba(0, 0, 0, 0.82)',
      backdropFilter: 'blur(10px)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 100,
      padding: 20,
    }} onClick={onClose}>
      <div
        className="glass-panel"
        style={{
          width: '100%',
          maxWidth: 820,
          maxHeight: '92vh',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border-light)',
          borderRadius: 'var(--radius-xl)',
          overflow: 'hidden',
          boxShadow: 'var(--shadow-lg)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{
          padding: '18px 24px',
          borderBottom: '1px solid var(--border-subtle)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          background: 'rgba(255, 255, 255, 0.02)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{
              width: 40,
              height: 40,
              borderRadius: 12,
              background: 'linear-gradient(135deg, var(--airtel-red) 0%, var(--airtel-red-dark) 100%)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#fff',
              boxShadow: '0 0 15px rgba(228, 0, 0, 0.4)',
            }}>
              <PhoneCall size={20} />
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <h3 style={{ fontSize: '1.15rem', fontWeight: 800, color: '#fff', letterSpacing: '-0.01em' }}>
                  Developer Test Call Console
                </h3>
                <span className="badge badge-red" style={{ fontSize: '0.68rem', padding: '2px 8px' }}>
                  Live Telephony
                </span>
              </div>
              <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                Test outbound calls dispatched to Priya Voice AI with custom or sample parameters
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-muted)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              padding: 4,
            }}
          >
            <X size={20} />
          </button>
        </div>

        {/* Scrollable Form Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
          {/* Preset Selector */}
          <div style={{ marginBottom: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
              <Sparkles size={15} color="var(--accent-cyan)" />
              <label style={{ fontSize: '0.82rem', fontWeight: 700, color: 'var(--text-secondary)' }}>
                Developer Sample Presets (Click to load):
              </label>
            </div>

            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
              gap: 10,
            }}>
              {DEVELOPER_PRESETS.map((preset) => {
                const isSelected = selectedPresetId === preset.id;
                return (
                  <div
                    key={preset.id}
                    onClick={() => handleSelectPreset(preset)}
                    style={{
                      border: isSelected ? '1px solid var(--airtel-red)' : '1px solid var(--border-subtle)',
                      background: isSelected ? 'rgba(228, 0, 0, 0.08)' : 'rgba(255, 255, 255, 0.02)',
                      borderRadius: 'var(--radius-md)',
                      padding: '12px 14px',
                      cursor: 'pointer',
                      transition: 'all 0.15s ease',
                      position: 'relative',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                      <span className="badge badge-blue" style={{ fontSize: '0.65rem', padding: '1px 6px' }}>
                        {preset.tag}
                      </span>
                      {isSelected && (
                        <CheckCircle2 size={14} color="var(--airtel-red)" />
                      )}
                    </div>
                    <div style={{ fontSize: '0.82rem', fontWeight: 700, color: '#fff', marginBottom: 4 }}>
                      {preset.title}
                    </div>
                    <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)', lineHeight: 1.3 }}>
                      {preset.description}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Test Call Details Form */}
          <form onSubmit={handleStartTestCall}>
            <div style={{
              background: 'rgba(15, 23, 42, 0.6)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-lg)',
              padding: 18,
              marginBottom: 18,
            }}>
              {/* TARGET PHONE NUMBER HIGHLIGHT */}
              <div style={{ marginBottom: 16 }}>
                <label style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: '0.84rem',
                  fontWeight: 700,
                  color: '#fff',
                  marginBottom: 6,
                }}>
                  <Radio size={14} color="var(--accent-rose)" />
                  Target Recipient Phone Number (Your Phone to Receive Call):
                </label>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <input
                    type="text"
                    value={formData.phone}
                    onChange={(e) => handleChange('phone', e.target.value)}
                    placeholder="+919811122233"
                    required
                    style={{
                      flex: 1,
                      padding: '12px 16px',
                      borderRadius: 'var(--radius-md)',
                      background: 'rgba(10, 14, 23, 0.9)',
                      border: '2px solid rgba(228, 0, 0, 0.4)',
                      color: '#38bdf8',
                      fontFamily: 'monospace',
                      fontSize: '1.05rem',
                      fontWeight: 700,
                      outline: 'none',
                    }}
                  />
                  <span style={{ fontSize: '0.74rem', color: 'var(--text-muted)', maxWidth: 220 }}>
                    Enter in standard format e.g. <strong style={{ color: '#fff' }}>+91XXXXXXXXXX</strong>
                  </span>
                </div>
              </div>

              {/* 2-Column Fields Grid */}
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
                gap: 14,
              }}>
                <div>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.78rem', color: 'var(--text-secondary)', marginBottom: 5 }}>
                    <User size={13} color="var(--text-muted)" />
                    Customer Name:
                  </label>
                  <input
                    type="text"
                    value={formData.name || ''}
                    onChange={(e) => handleChange('name', e.target.value)}
                    placeholder="e.g. Rajan Nayak"
                    style={{
                      width: '100%',
                      padding: '9px 12px',
                      borderRadius: 'var(--radius-sm)',
                      background: 'rgba(10, 14, 23, 0.8)',
                      border: '1px solid var(--border-light)',
                      color: '#fff',
                      fontSize: '0.82rem',
                    }}
                  />
                </div>

                <div>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.78rem', color: 'var(--text-secondary)', marginBottom: 5 }}>
                    <Wifi size={13} color="var(--text-muted)" />
                    SUBS_DEL_NO (Wi-Fi ID):
                  </label>
                  <input
                    type="text"
                    value={formData.subs_del_no || ''}
                    onChange={(e) => handleChange('subs_del_no', e.target.value)}
                    placeholder="e.g. 01121344121_wifi"
                    style={{
                      width: '100%',
                      padding: '9px 12px',
                      borderRadius: 'var(--radius-sm)',
                      background: 'rgba(10, 14, 23, 0.8)',
                      border: '1px solid var(--border-light)',
                      color: '#fff',
                      fontSize: '0.82rem',
                      fontFamily: 'monospace',
                    }}
                  />
                </div>

                <div>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.78rem', color: 'var(--text-secondary)', marginBottom: 5 }}>
                    <Hash size={13} color="var(--text-muted)" />
                    ACCOUNT_NO:
                  </label>
                  <input
                    type="text"
                    value={formData.account_no || ''}
                    onChange={(e) => handleChange('account_no', e.target.value)}
                    placeholder="e.g. 20022941256"
                    style={{
                      width: '100%',
                      padding: '9px 12px',
                      borderRadius: 'var(--radius-sm)',
                      background: 'rgba(10, 14, 23, 0.8)',
                      border: '1px solid var(--border-light)',
                      color: '#fff',
                      fontSize: '0.82rem',
                      fontFamily: 'monospace',
                    }}
                  />
                </div>

                <div>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.78rem', color: 'var(--text-secondary)', marginBottom: 5 }}>
                    <Calendar size={13} color="var(--text-muted)" />
                    SERVICE_END (Suspension Date):
                  </label>
                  <input
                    type="text"
                    value={formData.service_end_date || ''}
                    onChange={(e) => handleChange('service_end_date', e.target.value)}
                    placeholder="e.g. 27 Aug 26 or 2026-08-27"
                    style={{
                      width: '100%',
                      padding: '9px 12px',
                      borderRadius: 'var(--radius-sm)',
                      background: 'rgba(10, 14, 23, 0.8)',
                      border: '1px solid var(--border-light)',
                      color: '#fff',
                      fontSize: '0.82rem',
                    }}
                  />
                </div>

                <div style={{ gridColumn: '1 / -1' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.78rem', color: 'var(--text-secondary)', marginBottom: 5 }}>
                    <MapPin size={13} color="var(--text-muted)" />
                    Registered Address (Priya will confirm this during call):
                  </label>
                  <input
                    type="text"
                    value={formData.address || ''}
                    onChange={(e) => handleChange('address', e.target.value)}
                    placeholder="e.g. Delhi, 110011, burari, sant nagar"
                    style={{
                      width: '100%',
                      padding: '9px 12px',
                      borderRadius: 'var(--radius-sm)',
                      background: 'rgba(10, 14, 23, 0.8)',
                      border: '1px solid var(--border-light)',
                      color: '#fff',
                      fontSize: '0.82rem',
                    }}
                  />
                </div>
              </div>
            </div>

            {/* Error Banner */}
            {error && (
              <div style={{
                marginBottom: 16,
                padding: '10px 14px',
                borderRadius: 'var(--radius-md)',
                background: 'rgba(239, 68, 68, 0.15)',
                border: '1px solid rgba(239, 68, 68, 0.3)',
                color: 'var(--accent-rose)',
                fontSize: '0.8rem',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}>
                <AlertCircle size={16} />
                <span>{error}</span>
              </div>
            )}

            {/* Success Dial Banner */}
            {dialResult && (
              <div style={{
                marginBottom: 16,
                padding: '14px 18px',
                borderRadius: 'var(--radius-md)',
                background: 'rgba(34, 197, 94, 0.1)',
                border: '1px solid rgba(34, 197, 94, 0.3)',
                color: '#fff',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <CheckCircle2 size={18} color="var(--accent-green)" />
                  <strong style={{ color: 'var(--accent-green)', fontSize: '0.9rem' }}>
                    Test Call Successfully Initiated!
                  </strong>
                </div>
                <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                  <div>📞 Target Number: <strong>{dialResult.phone}</strong></div>
                  <div>🚪 LiveKit Room: <code>{dialResult.roomName}</code></div>
                  <div>🤖 Dispatched Agent: <strong>Priya (Airtel Voice AI)</strong></div>
                  <div>📡 Telephony Status: <span className="badge badge-blue">{dialResult.status}</span></div>
                </div>
                <p style={{ fontSize: '0.74rem', color: 'var(--text-muted)', marginTop: 8 }}>
                  👉 If your Exotel SIP trunk is provisioned, your phone should ring right now. Once you answer, Priya will speak in Hindi/Hinglish to schedule the Wi-Fi router pickup.
                </p>
              </div>
            )}

            {/* Modal Actions */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 10 }}>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                Powered by Groq Qwen 2.5 + Sarvam AI STT
              </div>

              <div style={{ display: 'flex', gap: 10 }}>
                <button
                  type="button"
                  onClick={onClose}
                  style={{
                    padding: '9px 18px',
                    borderRadius: 'var(--radius-sm)',
                    background: 'rgba(255, 255, 255, 0.08)',
                    color: 'var(--text-secondary)',
                    border: '1px solid var(--border-subtle)',
                    fontSize: '0.84rem',
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  Close
                </button>

                <button
                  type="submit"
                  disabled={isDialing}
                  style={{
                    padding: '9px 22px',
                    borderRadius: 'var(--radius-sm)',
                    background: isDialing
                      ? 'var(--accent-amber)'
                      : 'linear-gradient(135deg, var(--airtel-red) 0%, var(--airtel-red-dark) 100%)',
                    color: '#fff',
                    border: 'none',
                    fontSize: '0.86rem',
                    fontWeight: 700,
                    cursor: isDialing ? 'not-allowed' : 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    boxShadow: '0 2px 12px rgba(228, 0, 0, 0.4)',
                  }}
                >
                  <PhoneCall size={16} style={{ animation: isDialing ? 'pulseGlow 1s infinite' : 'none' }} />
                  {isDialing ? 'Dialing SIP Call...' : 'Place Test AI Call'}
                  <ArrowRight size={14} />
                </button>
              </div>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};
