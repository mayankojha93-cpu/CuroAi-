import React, { useState, useEffect } from 'react';
import { 
  PhoneCall, 
  Clock, 
  Download, 
  Play, 
  FileText, 
  RefreshCw, 
  ChevronDown,
  CheckCircle2,
  AlertCircle
} from 'lucide-react';
import type { CallRecord } from '../../types';
import { initiateTestCall, fetchTestCallHistory } from '../../services/api.service';
import { CallDetailModal } from './CallDetailModal';
import { useAuth } from '../../context/AuthContext';
import { cleanEnglishOnly } from '../../utils/textUtils';

interface TestCallViewProps {
  onSelectCall?: (call: CallRecord) => void;
}

const SCRIPTS = [
  { id: 'my_estate_finder', label: 'My Estate Finder — Property Intake (Sagar)', scriptKey: 'my_estate_finder', defaultOrg: 'My Estate Finder' },
  { id: 'trump_towers', label: 'Trump Towers India — Real Estate', scriptKey: 'Trump_towers_india', defaultOrg: 'Trump Towers India' },
  { id: 'ratnafin', label: 'Ratnafin — Machinery Loan', scriptKey: 'Ratnafin_machinery_loan', defaultOrg: 'Ratnafin' },
  { id: 'airtel_return', label: 'Airtel Wi-Fi Router Return', scriptKey: 'airtel_router_return', defaultOrg: 'Airtel Telecom' },
  { id: 'direct_outreach', label: 'Direct Voice Outreach', scriptKey: 'direct_voice_outreach', defaultOrg: 'Direct Voice' },
];

const LANGUAGES = [
  { id: 'multilingual', label: 'Multilingual' },
  { id: 'en', label: 'English' },
  { id: 'hi', label: 'Hindi' },
  { id: 'hinglish', label: 'Hinglish' },
];

const PIPELINES = [
  { id: 'sarvam_priya', value: 'Sarvam AI (Priya - hi-IN)', label: 'Curoai 2026-0.2' },
  { id: 'sarvam_aditya', value: 'Sarvam AI (Aditya - hi-IN)', label: 'Curoai 2026-0.3' },
  { id: 'openai_alloy', value: 'OpenAI Realtime (Alloy)', label: 'Curoai 2026-0.4' },
  { id: 'openai_echo', value: 'OpenAI Realtime (Echo)', label: 'Curoai 2026-0.5' },
  { id: 'elevenlabs', value: 'ElevenLabs (Rachel - Expressive)', label: 'Curoai 2026-0.6' },
];

export const TestCallView: React.FC<TestCallViewProps> = ({ onSelectCall }) => {
  const { user } = useAuth();
  const assignedPipeline = user?.assigned_pipeline || 'airtel';
  const isRealEstate = assignedPipeline === 'real_estate';

  const availableScripts = SCRIPTS.filter((s) => {
    if (assignedPipeline === 'all') return true;
    if (isRealEstate) {
      return s.id === 'my_estate_finder' || s.id === 'trump_towers';
    } else {
      return s.id === 'airtel_return' || s.id === 'ratnafin' || s.id === 'direct_outreach';
    }
  });

  const [activeTab, setActiveTab] = useState<'MAKE_CALL' | 'CALL_HISTORY'>('MAKE_CALL');
  
  // Form fields matching user screenshot & prompt:
  // phone no, Customer name, Company Org name, Script, Language, Voice pipeline
  const [phone, setPhone] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [companyName, setCompanyName] = useState(() =>
    isRealEstate ? 'My Estate Finder' : 'Airtel Telecom'
  );
  const [selectedScript, setSelectedScript] = useState(() =>
    isRealEstate ? 'My Estate Finder — Property Intake (Sagar)' : 'Airtel Wi-Fi Router Return'
  );
  const [selectedLanguage, setSelectedLanguage] = useState(() =>
    isRealEstate ? 'Hinglish' : 'Multilingual'
  );
  const [selectedPipeline, setSelectedPipeline] = useState(() =>
    isRealEstate ? 'Sarvam AI (Aditya - hi-IN)' : 'Sarvam AI (Priya - hi-IN)'
  );

  useEffect(() => {
    if (isRealEstate) {
      setSelectedScript('My Estate Finder — Property Intake (Sagar)');
      setCompanyName('My Estate Finder');
      setSelectedPipeline('Sarvam AI (Aditya - hi-IN)');
      setSelectedLanguage('Hinglish');
    } else {
      setSelectedScript('Airtel Wi-Fi Router Return');
      setCompanyName('Airtel Telecom');
      setSelectedPipeline('Sarvam AI (Priya - hi-IN)');
      setSelectedLanguage('Multilingual');
    }
  }, [isRealEstate]);

  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const handleScriptChange = (label: string) => {
    setSelectedScript(label);
    const found = SCRIPTS.find((s) => s.label === label);
    if (found) {
      setCompanyName(found.defaultOrg);
      if (found.id === 'my_estate_finder') {
        setSelectedPipeline('Sarvam AI (Aditya - hi-IN)');
        if (selectedLanguage === 'Hindi') {
          setSelectedLanguage('Hinglish');
        }
      } else if (found.id === 'airtel_return') {
        setSelectedPipeline('Sarvam AI (Priya - hi-IN)');
      }
    }
  };

  const applyPreset = (preset: { phone: string; name: string; script: string; pipeline: string; company: string }) => {
    setPhone(preset.phone);
    setCustomerName(preset.name);
    setSelectedScript(preset.script);
    setSelectedPipeline(preset.pipeline);
    setCompanyName(preset.company);
    setFeedback(null);
  };

  // History state
  const [historyCalls, setHistoryCalls] = useState<CallRecord[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [selectedCallForModal, setSelectedCallForModal] = useState<CallRecord | null>(null);
  const [dispositionFilter, setDispositionFilter] = useState<string>('ALL');

  const loadHistory = async () => {
    setLoadingHistory(true);
    try {
      const calls = await fetchTestCallHistory();
      setHistoryCalls(calls);
    } catch {
      // keep existing
    } finally {
      setLoadingHistory(false);
    }
  };

  useEffect(() => {
    loadHistory();
  }, []);

  const handleTriggerCall = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanPhone = phone.trim();
    if (!cleanPhone || cleanPhone.replace(/\D/g, '').length < 10) {
      setFeedback({ type: 'error', message: 'Please enter a valid 10-digit phone number.' });
      return;
    }

    setSubmitting(true);
    setFeedback(null);

    const scriptObj = SCRIPTS.find((s) => s.label === selectedScript || s.id === selectedScript);
    const scriptKey = scriptObj ? scriptObj.scriptKey : 'Trump_towers_india';
    const org = companyName.trim() || (scriptObj ? scriptObj.defaultOrg : 'Direct Voice Outreach');

    const formattedPhone = cleanPhone.startsWith('+') ? cleanPhone : `+91${cleanPhone.replace(/\D/g, '')}`;

    try {
      const langCode = (selectedLanguage === 'Hindi' || selectedLanguage === 'Hinglish') ? 'hi' : 'en';
      const res = await initiateTestCall({
        phone: formattedPhone,
        customer_name: customerName.trim() || undefined,
        company_name: org,
        script: scriptKey,
        language: langCode,
        voice_pipeline: selectedPipeline,
      });

      setFeedback({
        type: 'success',
        message: res.message || `Test call successfully dispatched to ${formattedPhone}!`,
      });

      // Reload call history in background
      await loadHistory();

      // Clear phone input after success
      setPhone('');
      setCustomerName('');
    } catch (err: any) {
      setFeedback({
        type: 'error',
        message: err.message || 'Failed to dispatch test call. Please check SIP trunks.',
      });
    } finally {
      setSubmitting(false);
    }
  };

  const handleExportHistory = () => {
    if (historyCalls.length === 0) return;
    const headers = ['Phone', 'Created At', 'Script', 'Duration (s)', 'Status', 'Disposition', 'Company'];
    const rows = historyCalls.map((c) => [
      c.customer_phone || (c as any).phone || '',
      c.created_at || '',
      c.script || (c as any).campaign_name || 'Trump_towers_india',
      c.duration_seconds || 0,
      c.status || '',
      c.final_disposition || (c as any).call_result || '',
      c.company_name || '',
    ]);

    const csvContent = [headers.join(','), ...rows.map((r) => r.map((f) => `"${f}"`).join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `test_calls_export_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const formatTimestamp = (dateStr?: string) => {
    if (!dateStr) return 'Just now';
    try {
      const d = new Date(dateStr);
      return d.toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
      });
    } catch {
      return dateStr;
    }
  };


  // Status & Canonical Disposition badge styling
  const renderStatusBadge = (status?: string, disposition?: string) => {
    const s = (status || '').toUpperCase();
    const d = (disposition || '').toUpperCase();

    // 1. Qualified Lead
    if (d.includes('QUALIFIED')) {
      return (
        <span style={{
          display: 'inline-block',
          padding: '4px 10px',
          borderRadius: 4,
          fontSize: '0.68rem',
          fontWeight: 700,
          letterSpacing: '0.04em',
          background: 'rgba(16, 185, 129, 0.15)',
          border: '1px solid rgba(16, 185, 129, 0.35)',
          color: '#10B981',
        }}>
          QUALIFIED
        </span>
      );
    }

    // 2. Advisor Callback Booked
    if (d.includes('ADVISOR')) {
      return (
        <span style={{
          display: 'inline-block',
          padding: '4px 10px',
          borderRadius: 4,
          fontSize: '0.68rem',
          fontWeight: 700,
          letterSpacing: '0.04em',
          background: 'rgba(168, 85, 247, 0.15)',
          border: '1px solid rgba(168, 85, 247, 0.35)',
          color: '#C084FC',
        }}>
          ADVISOR
        </span>
      );
    }

    // 3. Schedule Callback
    if (d.includes('CALLBACK')) {
      return (
        <span style={{
          display: 'inline-block',
          padding: '4px 10px',
          borderRadius: 4,
          fontSize: '0.68rem',
          fontWeight: 700,
          letterSpacing: '0.04em',
          background: 'rgba(56, 189, 248, 0.15)',
          border: '1px solid rgba(56, 189, 248, 0.35)',
          color: '#38BDF8',
        }}>
          CALLBACK
        </span>
      );
    }

    // 4. WhatsApp Info Requested
    if (d.includes('WHATSAPP')) {
      return (
        <span style={{
          display: 'inline-block',
          padding: '4px 10px',
          borderRadius: 4,
          fontSize: '0.68rem',
          fontWeight: 700,
          letterSpacing: '0.04em',
          background: 'rgba(6, 182, 212, 0.15)',
          border: '1px solid rgba(6, 182, 212, 0.35)',
          color: '#22D3EE',
        }}>
          WHATSAPP
        </span>
      );
    }

    // 5. Not Interested
    if (d.includes('NOT INTERESTED')) {
      return (
        <span style={{
          display: 'inline-block',
          padding: '4px 10px',
          borderRadius: 4,
          fontSize: '0.68rem',
          fontWeight: 700,
          letterSpacing: '0.04em',
          background: 'rgba(148, 163, 184, 0.15)',
          border: '1px solid rgba(148, 163, 184, 0.35)',
          color: '#94A3B8',
        }}>
          NOT INTERESTED
        </span>
      );
    }

    // 6. Do Not Call
    if (d.includes('DO NOT CALL') || d.includes('DNC')) {
      return (
        <span style={{
          display: 'inline-block',
          padding: '4px 10px',
          borderRadius: 4,
          fontSize: '0.68rem',
          fontWeight: 700,
          letterSpacing: '0.04em',
          background: 'rgba(244, 63, 94, 0.15)',
          border: '1px solid rgba(244, 63, 94, 0.35)',
          color: '#FB7185',
        }}>
          DO NOT CALL
        </span>
      );
    }

    // 7. Wrong Number
    if (d.includes('WRONG NUMBER')) {
      return (
        <span style={{
          display: 'inline-block',
          padding: '4px 10px',
          borderRadius: 4,
          fontSize: '0.68rem',
          fontWeight: 700,
          letterSpacing: '0.04em',
          background: 'rgba(249, 115, 22, 0.15)',
          border: '1px solid rgba(249, 115, 22, 0.35)',
          color: '#FB923C',
        }}>
          WRONG NUMBER
        </span>
      );
    }

    // 8. No Answer
    if (s === 'NO_ANSWER' || s === 'NO ANSWER' || d.includes('NO ANSWER')) {
      return (
        <span style={{
          display: 'inline-block',
          padding: '4px 10px',
          borderRadius: 4,
          fontSize: '0.68rem',
          fontWeight: 700,
          letterSpacing: '0.04em',
          background: 'rgba(245, 158, 11, 0.15)',
          border: '1px solid rgba(245, 158, 11, 0.35)',
          color: '#F59E0B',
        }}>
          NO ANSWER
        </span>
      );
    }

    if (s === 'COMPLETED' || s === 'SUCCESSFUL' || s === 'ANSWERED' || d.includes('GOAL') || d.includes('PICKUP')) {
      return (
        <span style={{
          display: 'inline-block',
          padding: '4px 10px',
          borderRadius: 4,
          fontSize: '0.68rem',
          fontWeight: 700,
          letterSpacing: '0.04em',
          background: 'rgba(16, 185, 129, 0.12)',
          border: '1px solid rgba(16, 185, 129, 0.28)',
          color: '#10B981',
        }}>
          COMPLETED
        </span>
      );
    }
    if (s === 'BUSY') {
      return (
        <span style={{
          display: 'inline-block',
          padding: '4px 10px',
          borderRadius: 4,
          fontSize: '0.68rem',
          fontWeight: 700,
          letterSpacing: '0.04em',
          background: 'rgba(239, 68, 68, 0.12)',
          border: '1px solid rgba(239, 68, 68, 0.28)',
          color: '#EF4444',
        }}>
          BUSY
        </span>
      );
    }
    return (
      <span style={{
        display: 'inline-block',
        padding: '4px 10px',
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
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24, paddingBottom: 48, minHeight: '80vh' }}>
      
      {/* Top Navigation Tabs matching screenshot */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          onClick={() => setActiveTab('MAKE_CALL')}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 18px',
            borderRadius: 8,
            fontSize: '0.86rem',
            fontWeight: 600,
            cursor: 'pointer',
            transition: 'all 0.15s ease',
            border: 'none',
            background: activeTab === 'MAKE_CALL' ? '#2563EB' : 'transparent',
            color: activeTab === 'MAKE_CALL' ? '#FFFFFF' : '#94A3B8',
          }}
          onMouseEnter={(e) => {
            if (activeTab !== 'MAKE_CALL') e.currentTarget.style.color = '#FFFFFF';
          }}
          onMouseLeave={(e) => {
            if (activeTab !== 'MAKE_CALL') e.currentTarget.style.color = '#94A3B8';
          }}
        >
          <PhoneCall size={15} />
          Make Call
        </button>

        <button
          onClick={() => {
            setActiveTab('CALL_HISTORY');
            loadHistory();
          }}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 18px',
            borderRadius: 8,
            fontSize: '0.86rem',
            fontWeight: 600,
            cursor: 'pointer',
            transition: 'all 0.15s ease',
            border: 'none',
            background: activeTab === 'CALL_HISTORY' ? '#2563EB' : 'transparent',
            color: activeTab === 'CALL_HISTORY' ? '#FFFFFF' : '#94A3B8',
          }}
          onMouseEnter={(e) => {
            if (activeTab !== 'CALL_HISTORY') e.currentTarget.style.color = '#FFFFFF';
          }}
          onMouseLeave={(e) => {
            if (activeTab !== 'CALL_HISTORY') e.currentTarget.style.color = '#94A3B8';
          }}
        >
          <Clock size={15} />
          Call History
        </button>
      </div>

      {/* TAB 1: MAKE CALL VIEW (Matching Screenshot 1) */}
      {activeTab === 'MAKE_CALL' && (
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', paddingTop: 16 }}>
          <div
            style={{
              width: '100%',
              maxWidth: 520,
              background: '#0B0F19',
              border: '1px solid rgba(139, 92, 246, 0.22)',
              borderRadius: 16,
              padding: '36px 36px',
              position: 'relative',
              boxShadow: '0 0 70px -15px rgba(147, 51, 234, 0.22), 0 25px 50px -12px rgba(0, 0, 0, 0.7)',
            }}
          >
            {/* Glow Aura effect */}
            <div style={{
              position: 'absolute',
              top: -1,
              left: '15%',
              right: '15%',
              height: 2,
              background: 'linear-gradient(90deg, transparent, rgba(168, 85, 247, 0.8), transparent)',
              borderRadius: 2,
            }} />

            <h2 style={{
              textAlign: 'center',
              fontSize: '1.25rem',
              fontWeight: 700,
              color: '#FFFFFF',
              marginTop: 0,
              marginBottom: 28,
              letterSpacing: '-0.01em',
            }}>
              Initiate a Test Call
            </h2>

            {feedback && (
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '12px 14px',
                borderRadius: 8,
                marginBottom: 20,
                fontSize: '0.84rem',
                background: feedback.type === 'success' ? 'rgba(16, 185, 129, 0.12)' : 'rgba(239, 68, 68, 0.12)',
                border: `1px solid ${feedback.type === 'success' ? 'rgba(16, 185, 129, 0.3)' : 'rgba(239, 68, 68, 0.3)'}`,
                color: feedback.type === 'success' ? '#34D399' : '#FCA5A5',
              }}>
                {feedback.type === 'success' ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
                <span>{feedback.message}</span>
              </div>
            )}

            {/* Quick Presets Pills */}
            <div style={{ marginBottom: 18 }}>
              <div style={{ fontSize: '0.76rem', color: '#64748B', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 8 }}>
                Quick Test Presets
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {(isRealEstate
                  ? [
                      {
                        title: '🏠 Estate Finder (Sagar)',
                        name: 'Vikramaditya Singhania',
                        phone: '+919811122233',
                        script: 'My Estate Finder — Property Intake (Sagar)',
                        pipeline: 'Sarvam AI (Arvind - hi-IN)',
                        company: 'My Estate Finder',
                      },
                      {
                        title: '🏢 Commercial Lease',
                        name: 'Ananya Deshmukh',
                        phone: '+919845012345',
                        script: 'My Estate Finder — Property Intake (Sagar)',
                        pipeline: 'Sarvam AI (Arvind - hi-IN)',
                        company: 'My Estate Finder',
                      },
                    ]
                  : [
                      {
                        title: '📶 Airtel Wi-Fi Return',
                        name: 'Rajan Nayak',
                        phone: '+919811122233',
                        script: 'Airtel Wi-Fi Router Return',
                        pipeline: 'Sarvam AI (Priya - hi-IN)',
                        company: 'Airtel Telecom',
                      },
                      {
                        title: '💳 Ratnafin Loan',
                        name: 'Pooja Verma',
                        phone: '+919876543210',
                        script: 'Ratnafin — Machinery Loan',
                        pipeline: 'Sarvam AI (Priya - hi-IN)',
                        company: 'Ratnafin',
                      },
                      {
                        title: '📞 Voice Outreach',
                        name: 'Karan Mehra',
                        phone: '+919988776655',
                        script: 'Direct Voice Outreach',
                        pipeline: 'Sarvam AI (Priya - hi-IN)',
                        company: 'Direct Voice',
                      },
                    ]
                ).map((p, idx) => (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => applyPreset(p)}
                    style={{
                      background: selectedScript === p.script ? 'rgba(59, 130, 246, 0.16)' : 'rgba(255, 255, 255, 0.04)',
                      border: `1px solid ${selectedScript === p.script ? 'rgba(59, 130, 246, 0.4)' : 'rgba(255, 255, 255, 0.08)'}`,
                      color: selectedScript === p.script ? '#60A5FA' : '#94A3B8',
                      borderRadius: 6,
                      padding: '5px 10px',
                      fontSize: '0.75rem',
                      fontWeight: 600,
                      cursor: 'pointer',
                      transition: 'all 0.15s ease',
                    }}
                  >
                    {p.title}
                  </button>
                ))}
              </div>
            </div>

            <form onSubmit={handleTriggerCall} style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
              {/* Field 1: Phone Number with Country Flag & Code */}
              <div>
                <label style={{ display: 'block', fontSize: '0.82rem', color: '#94A3B8', fontWeight: 600, marginBottom: 8 }}>
                  Phone Number
                </label>
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  background: '#070A12',
                  border: '1px solid rgba(255, 255, 255, 0.08)',
                  borderRadius: 8,
                  overflow: 'hidden',
                  transition: 'border-color 0.15s ease',
                }}>
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '11px 14px',
                    borderRight: '1px solid rgba(255, 255, 255, 0.08)',
                    color: '#E2E8F0',
                    fontSize: '0.88rem',
                    fontWeight: 600,
                    userSelect: 'none',
                  }}>
                    <span style={{ fontSize: '1.05rem', lineHeight: 1 }}>🇮🇳</span>
                    <span>+91</span>
                  </div>
                  <input
                    type="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="Enter phone number"
                    required
                    style={{
                      flex: 1,
                      background: 'transparent',
                      border: 'none',
                      outline: 'none',
                      color: '#FFFFFF',
                      fontSize: '0.9rem',
                      padding: '11px 14px',
                    }}
                  />
                </div>
              </div>

              {/* Field 2: Customer Name */}
              <div>
                <label style={{ display: 'block', fontSize: '0.82rem', color: '#94A3B8', fontWeight: 600, marginBottom: 8 }}>
                  Customer Name
                </label>
                <input
                  type="text"
                  value={customerName}
                  onChange={(e) => setCustomerName(e.target.value)}
                  placeholder="Enter name (optional)"
                  style={{
                    width: '100%',
                    background: '#070A12',
                    border: '1px solid rgba(255, 255, 255, 0.08)',
                    borderRadius: 8,
                    color: '#FFFFFF',
                    fontSize: '0.9rem',
                    padding: '11px 14px',
                    outline: 'none',
                    boxSizing: 'border-box',
                  }}
                />
              </div>

              {/* Field 3: Company / Org Name */}
              <div>
                <label style={{ display: 'block', fontSize: '0.82rem', color: '#94A3B8', fontWeight: 600, marginBottom: 8 }}>
                  Company / Org Name
                </label>
                <input
                  type="text"
                  value={companyName}
                  onChange={(e) => setCompanyName(e.target.value)}
                  placeholder="Leave empty for script default"
                  style={{
                    width: '100%',
                    background: '#070A12',
                    border: '1px solid rgba(255, 255, 255, 0.08)',
                    borderRadius: 8,
                    color: '#FFFFFF',
                    fontSize: '0.9rem',
                    padding: '11px 14px',
                    outline: 'none',
                    boxSizing: 'border-box',
                  }}
                />
              </div>

              {/* Two columns: Script and Language */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                {/* Script */}
                <div>
                  <label style={{ display: 'block', fontSize: '0.82rem', color: '#94A3B8', fontWeight: 600, marginBottom: 8 }}>
                    Script
                  </label>
                  <div style={{ position: 'relative' }}>
                    <select
                      value={selectedScript}
                      onChange={(e) => handleScriptChange(e.target.value)}
                      style={{
                        width: '100%',
                        background: '#070A12',
                        border: '1px solid rgba(255, 255, 255, 0.08)',
                        borderRadius: 8,
                        color: '#FFFFFF',
                        fontSize: '0.85rem',
                        padding: '11px 32px 11px 12px',
                        outline: 'none',
                        appearance: 'none',
                        cursor: 'pointer',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                      }}
                    >
                      {availableScripts.map((s) => (
                        <option key={s.id} value={s.label} style={{ background: '#0B0F19', color: '#FFFFFF' }}>
                          {s.label}
                        </option>
                      ))}
                    </select>
                    <ChevronDown size={14} color="#64748B" style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }} />
                  </div>
                </div>

                {/* Language */}
                <div>
                  <label style={{ display: 'block', fontSize: '0.82rem', color: '#94A3B8', fontWeight: 600, marginBottom: 8 }}>
                    Language
                  </label>
                  <div style={{ position: 'relative' }}>
                    <select
                      value={selectedLanguage}
                      onChange={(e) => setSelectedLanguage(e.target.value)}
                      style={{
                        width: '100%',
                        background: '#070A12',
                        border: '1px solid rgba(255, 255, 255, 0.08)',
                        borderRadius: 8,
                        color: '#FFFFFF',
                        fontSize: '0.85rem',
                        padding: '11px 32px 11px 12px',
                        outline: 'none',
                        appearance: 'none',
                        cursor: 'pointer',
                      }}
                    >
                      {LANGUAGES.filter((l) => {
                        // For 2nd pipeline (Estate Finder), keep only English and Hinglish (remove Hindi)
                        if (selectedScript.includes('Estate Finder') && l.id === 'hi') {
                          return false;
                        }
                        return true;
                      }).map((l) => (
                        <option key={l.id} value={l.label} style={{ background: '#0B0F19', color: '#FFFFFF' }}>
                          {l.label}
                        </option>
                      ))}
                    </select>
                    <ChevronDown size={14} color="#64748B" style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }} />
                  </div>
                </div>
              </div>

              {/* Voice Pipeline */}
              <div>
                <label style={{ display: 'block', fontSize: '0.82rem', color: '#94A3B8', fontWeight: 600, marginBottom: 8 }}>
                  Voice Pipeline
                </label>
                <div style={{ position: 'relative' }}>
                  <select
                    value={selectedPipeline}
                    onChange={(e) => setSelectedPipeline(e.target.value)}
                    style={{
                      width: '100%',
                      background: '#070A12',
                      border: '1px solid rgba(255, 255, 255, 0.08)',
                      borderRadius: 8,
                      color: '#FFFFFF',
                      fontSize: '0.85rem',
                      padding: '11px 32px 11px 14px',
                      outline: 'none',
                      appearance: 'none',
                      cursor: 'pointer',
                    }}
                  >
                    {PIPELINES.map((p) => (
                      <option key={p.id} value={p.value} style={{ background: '#0B0F19', color: '#FFFFFF' }}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={14} color="#64748B" style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }} />
                </div>
              </div>

              {/* Trigger Call Action Button */}
              <button
                type="submit"
                disabled={submitting}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                  width: '100%',
                  marginTop: 8,
                  padding: '12px 20px',
                  borderRadius: 8,
                  background: submitting ? '#1E40AF' : '#2563EB',
                  border: 'none',
                  color: '#FFFFFF',
                  fontSize: '0.92rem',
                  fontWeight: 600,
                  cursor: submitting ? 'not-allowed' : 'pointer',
                  transition: 'background 0.15s ease',
                  boxShadow: '0 4px 14px rgba(37, 99, 235, 0.4)',
                }}
                onMouseEnter={(e) => {
                  if (!submitting) e.currentTarget.style.background = '#1D4ED8';
                }}
                onMouseLeave={(e) => {
                  if (!submitting) e.currentTarget.style.background = '#2563EB';
                }}
              >
                <Play size={15} fill="#FFFFFF" />
                {submitting ? 'Triggering Call...' : 'Trigger Call'}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* TAB 2: CALL HISTORY VIEW (Matching Screenshot 2) */}
      {activeTab === 'CALL_HISTORY' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Header with Title and Export Button */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 }}>
            <h2 style={{ fontSize: '1.25rem', fontWeight: 700, color: '#FFFFFF', margin: 0 }}>
              Recent Test Calls
            </h2>

            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <button
                onClick={loadHistory}
                disabled={loadingHistory}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '8px 14px',
                  borderRadius: 8,
                  background: 'rgba(255, 255, 255, 0.04)',
                  border: '1px solid rgba(255, 255, 255, 0.1)',
                  color: '#94A3B8',
                  fontSize: '0.84rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                <RefreshCw size={14} className={loadingHistory ? 'spin' : ''} />
                Refresh
              </button>

              <button
                onClick={handleExportHistory}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '8px 16px',
                  borderRadius: 8,
                  background: 'rgba(255, 255, 255, 0.05)',
                  border: '1px solid rgba(255, 255, 255, 0.12)',
                  color: '#E2E8F0',
                  fontSize: '0.84rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'rgba(255, 255, 255, 0.09)';
                  e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.2)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)';
                  e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.12)';
                }}
              >
                <Download size={15} />
                Export
              </button>
            </div>
          </div>

          {/* Real Estate & Campaign Canonical Disposition Filter Bar */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            overflowX: 'auto',
            paddingBottom: 4,
            marginBottom: 14,
          }}>
            {[
              { id: 'ALL', label: 'All Dispositions', count: historyCalls.length, color: '#3B82F6' },
              { id: 'QUALIFIED', label: 'Qualified Lead', count: historyCalls.filter((c) => ((c.final_disposition || '') as string).toUpperCase().includes('QUALIFIED')).length, color: '#10B981' },
              { id: 'CALLBACK', label: 'Schedule Callback', count: historyCalls.filter((c) => {
                const d = ((c.final_disposition || '') as string).toUpperCase();
                return d.includes('CALLBACK') && !d.includes('ADVISOR');
              }).length, color: '#38BDF8' },
              { id: 'ADVISOR', label: 'Advisor Callback', count: historyCalls.filter((c) => ((c.final_disposition || '') as string).toUpperCase().includes('ADVISOR')).length, color: '#A855F7' },
              { id: 'WHATSAPP', label: 'WhatsApp Sent', count: historyCalls.filter((c) => ((c.final_disposition || '') as string).toUpperCase().includes('WHATSAPP')).length, color: '#06B6D4' },
              { id: 'NOT_INTERESTED', label: 'Not Interested', count: historyCalls.filter((c) => ((c.final_disposition || '') as string).toUpperCase().includes('NOT INTERESTED')).length, color: '#94A3B8' },
              { id: 'DNC', label: 'Do Not Call', count: historyCalls.filter((c) => {
                const d = ((c.final_disposition || '') as string).toUpperCase();
                return d.includes('DO NOT CALL') || d.includes('DNC');
              }).length, color: '#F43F5E' },
            ].map((pill) => {
              const isSelected = dispositionFilter === pill.id;
              return (
                <button
                  key={pill.id}
                  type="button"
                  onClick={() => setDispositionFilter(pill.id)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '6px 12px',
                    borderRadius: 20,
                    fontSize: '0.76rem',
                    fontWeight: 600,
                    cursor: 'pointer',
                    transition: 'all 0.15s ease',
                    border: `1px solid ${isSelected ? pill.color : 'rgba(255, 255, 255, 0.08)'}`,
                    background: isSelected ? `${pill.color}20` : 'rgba(255, 255, 255, 0.03)',
                    color: isSelected ? '#FFFFFF' : '#94A3B8',
                    whiteSpace: 'nowrap',
                  }}
                >
                  <span style={{
                    width: 7,
                    height: 7,
                    borderRadius: '50%',
                    background: pill.color,
                  }} />
                  <span>{pill.label}</span>
                  <span style={{
                    background: 'rgba(255, 255, 255, 0.1)',
                    padding: '1px 6px',
                    borderRadius: 10,
                    fontSize: '0.7rem',
                    fontWeight: 700,
                    color: isSelected ? '#FFFFFF' : '#CBD5E1',
                  }}>
                    {pill.count}
                  </span>
                </button>
              );
            })}
          </div>

          {/* List of Calls */}
          {loadingHistory && historyCalls.length === 0 ? (
            <div style={{ padding: 48, textAlign: 'center', color: '#64748B' }}>
              Loading test call records from database...
            </div>
          ) : historyCalls.length === 0 ? (
            <div style={{
              background: '#0B0F19',
              border: '1px solid rgba(255, 255, 255, 0.06)',
              borderRadius: 12,
              padding: 48,
              textAlign: 'center',
              color: '#64748B',
            }}>
              No test call records found. Switch to the <strong>Make Call</strong> tab to trigger a real test call.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {historyCalls.filter((c) => {
                if (dispositionFilter === 'ALL') return true;
                const disp = ((c.final_disposition || (c as any).call_result || '') as string).toUpperCase();
                if (dispositionFilter === 'QUALIFIED') return disp.includes('QUALIFIED');
                if (dispositionFilter === 'CALLBACK') return disp.includes('CALLBACK') && !disp.includes('ADVISOR');
                if (dispositionFilter === 'ADVISOR') return disp.includes('ADVISOR');
                if (dispositionFilter === 'WHATSAPP') return disp.includes('WHATSAPP');
                if (dispositionFilter === 'NOT_INTERESTED') return disp.includes('NOT INTERESTED');
                if (dispositionFilter === 'DNC') return disp.includes('DO NOT CALL') || disp.includes('DNC');
                return true;
              }).map((call, idx) => {
                const phoneDisplay = call.customer_phone || (call as any).phone || '+919330188999';
                const timeDisplay = formatTimestamp(call.created_at);
                const rawName = call.customer_name || (call as any).name || (call as any).owner_name_confirmed || (call as any).owner_name;
                const userName = cleanEnglishOnly(rawName);
                
                // Format script display: e.g. My Estate Finder (Sagar) or Trump_towers_india (English)
                const rawScript = call.script || (call as any).campaign_name || 'Trump_towers_india';
                let normalizedScriptKey = 'Trump_towers_india';
                if (rawScript.includes('Estate') || rawScript.includes('my_estate') || rawScript.includes('sagar') || rawScript.includes('Property')) {
                  normalizedScriptKey = 'My Estate Finder (Sagar)';
                } else if (rawScript.includes('Trump')) {
                  normalizedScriptKey = 'Trump_towers_india';
                } else if (rawScript.includes('Ratnafin')) {
                  normalizedScriptKey = 'Ratnafin_machinery_loan';
                } else if (rawScript.includes('airtel') || rawScript.includes('router')) {
                  normalizedScriptKey = 'Airtel Wi-Fi Router Return';
                }
                const langName = (call as any).language === 'hi' || (call as any).customer_language === 'hi' ? 'Hinglish' : 'English';
                const scriptDisplay = normalizedScriptKey.includes('(') ? normalizedScriptKey : `${normalizedScriptKey} (${langName})`;

                const durationSec = call.duration_seconds || 0;
                const durationDisplay = durationSec > 0 ? `${durationSec}s` : '-';
                const rawDisp = call.final_disposition || (call as any).call_result || (call.status === 'completed' ? 'Qualified Lead' : '—');

                return (
                  <div
                    key={call.id || idx}
                    style={{
                      background: '#090D16',
                      border: '1px solid rgba(255, 255, 255, 0.05)',
                      borderRadius: 10,
                      padding: '16px 20px',
                      display: 'grid',
                      gridTemplateColumns: '1.5fr 1.7fr 0.8fr 1fr 1.6fr 1.2fr',
                      alignItems: 'center',
                      gap: 16,
                      transition: 'background 0.15s ease',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = 'rgba(255, 255, 255, 0.02)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = '#090D16';
                    }}
                  >
                    {/* Col 1: Name (English only), Phone number & Time */}
                    <div>
                      {userName ? (
                        <>
                          <div style={{ color: '#FFFFFF', fontWeight: 600, fontSize: '0.90rem', letterSpacing: '0.01em', marginBottom: 2 }}>
                            {userName}
                          </div>
                          <div style={{ color: '#94A3B8', fontSize: '0.78rem', letterSpacing: '0.01em' }}>
                            {phoneDisplay}
                          </div>
                        </>
                      ) : (
                        <div style={{ color: '#FFFFFF', fontWeight: 700, fontSize: '0.92rem', letterSpacing: '0.01em' }}>
                          {phoneDisplay}
                        </div>
                      )}
                      <div style={{ color: '#64748B', fontSize: '0.74rem', marginTop: 3 }}>
                        {timeDisplay}
                      </div>
                    </div>

                    {/* Col 2: Script (Language) */}
                    <div style={{ color: '#94A3B8', fontSize: '0.86rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {scriptDisplay}
                    </div>

                    {/* Col 3: Duration seconds */}
                    <div style={{ color: '#94A3B8', fontSize: '0.86rem' }}>
                      {durationDisplay}
                    </div>

                    {/* Col 4: Status Badge */}
                    <div>
                      {renderStatusBadge(call.status, call.final_disposition)}
                    </div>

                    {/* Col 5: Disposition */}
                    <div style={{ color: '#E2E8F0', fontSize: '0.86rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {rawDisp}
                    </div>

                    {/* Col 6: Transcript button */}
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end' }}>
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedCallForModal(call);
                          if (onSelectCall) onSelectCall(call);
                        }}
                        title="View Transcript"
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          background: 'rgba(255, 255, 255, 0.04)',
                          border: '1px solid rgba(255, 255, 255, 0.08)',
                          color: '#38BDF8',
                          padding: '7px 14px',
                          borderRadius: 8,
                          fontSize: '0.82rem',
                          fontWeight: 600,
                          cursor: 'pointer',
                          transition: 'all 0.15s ease',
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.background = 'rgba(56, 189, 248, 0.12)';
                          e.currentTarget.style.borderColor = 'rgba(56, 189, 248, 0.3)';
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.background = 'rgba(255, 255, 255, 0.04)';
                          e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.08)';
                        }}
                      >
                        <FileText size={15} />
                        <span>Transcript</span>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Transcript & Call Details Modal */}
      {selectedCallForModal && (
        <CallDetailModal
          call={selectedCallForModal}
          onClose={() => setSelectedCallForModal(null)}
        />
      )}
    </div>
  );
};
