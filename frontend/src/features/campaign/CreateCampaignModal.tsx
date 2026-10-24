import React, { useState, useId, useMemo } from 'react';
import { 
  CheckCircle2, 
  AlertTriangle, 
  XCircle, 
  ChevronDown, 
  ChevronUp, 
  FileText,
  Upload,
  Clock,
  Sliders,
  Settings,
  Sparkles,
  Info,
  X,
  Plus
} from 'lucide-react';
import { createCampaign } from '../../services';
import type { CampaignItem } from '../../types';

interface CreateCampaignModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCampaignCreated?: (newCampaign: CampaignItem) => void;
}

interface ValidContact {
  phone: string;
  name?: string;
  email?: string;
}

interface FlaggedIssue {
  raw: string;
  type: 'duplicate' | 'short_number';
  reason: string;
}

export interface ScriptPresetOption {
  id: string;
  title: string;
  prompt: string;
}

export const SCRIPT_PRESETS: ScriptPresetOption[] = [
  {
    id: 'delhi-routine',
    title: 'Airtel Delhi Wi-Fi (Routine Pickup)',
    prompt: 'नमस्ते, मैं प्रिया बोल रही हूँ, एयरटेल की तरफ से। क्या मैं आपसे बात कर सकती हूँ? आपके एयरटेल वाई-फाई अकाउंट के संबंध में रूटीन पिकअप शेड्यूल करना है।',
  },
  {
    id: 'bengaluru-relocated',
    title: 'Airtel Fiber Bengaluru (Shifted Address)',
    prompt: 'नमस्ते, मैं प्रिया बोल रही हूँ, एयरटेल की तरफ से। आपने नए पते पर शिफ्ट होने की जानकारी दी थी, क्या हम आपके नए पते से वाई-फाई राउटर पिकअप शेड्यूल कर लें?',
  },
  {
    id: 'noida-refund-query',
    title: 'Airtel Wi-Fi Noida (Dispute / 121 Query)',
    prompt: 'नमस्ते, मैं प्रिया बोल रही हूँ, एयरटेल की तरफ से। आपके राउटर डिपॉजिट रिफंड और डिवाइस रिटर्न पॉलिसी की जानकारी देने के लिए कॉल किया है। क्या मैं आपसे बात कर सकती हूँ?',
  },
  {
    id: 'airtel-general-pickup',
    title: 'Airtel Standard Outbound Pickup',
    prompt: 'नमस्ते, मैं प्रिया बोल रही हूँ, एयरटेल की तरफ से। क्या मैं आपसे बात कर सकती हूँ? आपके एयरटेल वाई-फाई अकाउंट के सस्पेंशन के बाद राउटर पिकअप शेड्यूल करना है।',
  },
  {
    id: 'custom',
    title: 'Custom Script (Manual Input)',
    prompt: '',
  },
];

const ALL_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const DEFAULT_DISPOSITIONS = [
  'CONFIRMED_PICKUP',
  'NEEDS_AIRTEL_SUPPORT',
  'SCHEDULE_CALLBACK',
  'REFUSED',
  'WRONG_PERSON',
  'BUSY',
  'NO_ANSWER'
];

export const CreateCampaignModal: React.FC<CreateCampaignModalProps> = ({
  isOpen,
  onClose,
  onCampaignCreated,
}) => {
  // Campaign Details
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [selectedScriptId, setSelectedScriptId] = useState<string>('delhi-routine');
  const [scriptText, setScriptText] = useState<string>(SCRIPT_PRESETS[0].prompt);
  const [language, setLanguage] = useState('hi-IN');
  const [voicePipeline, setVoicePipeline] = useState('Sarvam AI (Priya - hi-IN)');

  // Schedule
  const [scheduleStartTime, setScheduleStartTime] = useState('09:00');
  const [scheduleEndTime, setScheduleEndTime] = useState('20:00');
  const [operatingDays, setOperatingDays] = useState<string[]>([
    'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'
  ]);

  // Rate Limits & Retries
  const [maxConcurrentCalls, setMaxConcurrentCalls] = useState<number | string>(5);
  const [callsPerMinute, setCallsPerMinute] = useState<number | string>(30);
  const [retryAttempts, setRetryAttempts] = useState<number | string>(3);
  const [retryDelayMinutes, setRetryDelayMinutes] = useState<number | string>(180);

  // Call Settings
  const [maxCallDurationMinutes, setMaxCallDurationMinutes] = useState<number | string>(5);
  const [expectedDispositions, setExpectedDispositions] = useState<string[]>(DEFAULT_DISPOSITIONS);
  const [newDispositionInput, setNewDispositionInput] = useState('');

  // Audience & Validation
  const [contactsText, setContactsText] = useState('');
  const [fileName, setFileName] = useState('');
  const [fileRawLines, setFileRawLines] = useState<string[]>([]);
  const [showFlaggedDetails, setShowFlaggedDetails] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fileInputId = useId();

  const selectedPreset = useMemo(
    () => SCRIPT_PRESETS.find((p) => p.id === selectedScriptId) || SCRIPT_PRESETS[0],
    [selectedScriptId]
  );

  const handleScriptChange = (id: string) => {
    setSelectedScriptId(id);
    const preset = SCRIPT_PRESETS.find((p) => p.id === id);
    if (preset && id !== 'custom') {
      setScriptText(preset.prompt);
    } else if (id === 'custom' && scriptText === selectedPreset.prompt) {
      setScriptText('');
    }
  };

  // Day toggle handler
  const toggleDay = (day: string) => {
    setOperatingDays((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day]
    );
  };

  // Disposition management
  const removeDisposition = (disp: string) => {
    setExpectedDispositions((prev) => prev.filter((d) => d !== disp));
  };

  const addDisposition = () => {
    const trimmed = newDispositionInput.trim().toUpperCase().replace(/\s+/g, '_');
    if (trimmed && !expectedDispositions.includes(trimmed)) {
      setExpectedDispositions((prev) => [...prev, trimmed]);
      setNewDispositionInput('');
    }
  };

  // Parse CSV and textarea contacts with duplicates and <10 digits flagging
  const { validContacts, flaggedDuplicates, flaggedShortNumbers } = useMemo(() => {
    const valid: ValidContact[] = [];
    const duplicates: FlaggedIssue[] = [];
    const shortNumbers: FlaggedIssue[] = [];
    const seenPhones = new Set<string>();

    let phoneColIdx = 0;
    let nameColIdx = -1;
    let emailColIdx = -1;
    let dataStartIndex = 0;

    // Detect CSV headers if uploaded file exists
    if (fileRawLines.length > 0) {
      const firstLine = fileRawLines[0];
      const headerCols = firstLine.split(',').map((c) =>
        c.trim().toLowerCase().replace(/^["']|["']$/g, '')
      );
      const isHeader = headerCols.some((c) =>
        c.includes('phone') ||
        c.includes('mobile') ||
        c.includes('number') ||
        c.includes('contact') ||
        c.includes('name') ||
        c.includes('email')
      );

      if (isHeader) {
        dataStartIndex = 1;
        headerCols.forEach((col, idx) => {
          if (
            col.includes('phone') ||
            col.includes('mobile') ||
            col.includes('number') ||
            col.includes('contact')
          ) {
            phoneColIdx = idx;
          } else if (
            col.includes('name') ||
            col.includes('customer') ||
            col.includes('subscriber')
          ) {
            nameColIdx = idx;
          } else if (col.includes('email') || col.includes('mail')) {
            emailColIdx = idx;
          }
        });
      }
    }

    const processEntry = (phoneStr: string, nameStr?: string, emailStr?: string) => {
      const cleanPhone = phoneStr.trim().replace(/^["']|["']$/g, '');
      if (!cleanPhone) return;

      const digits = cleanPhone.replace(/\D/g, '');
      if (digits.length === 0) return;

      // 1. Flag numbers with less than 10 digits
      if (digits.length < 10) {
        shortNumbers.push({
          raw: cleanPhone,
          type: 'short_number',
          reason: `Less than 10 digits (${digits.length} digits found)`,
        });
        return;
      }

      // 2. Normalize valid phone numbers (>= 10 digits)
      let normalized = cleanPhone.replace(/[^\d+]/g, '');
      if (!normalized.startsWith('+') && digits.length === 10) {
        normalized = '+91' + digits;
      } else if (!normalized.startsWith('+')) {
        normalized = '+' + digits;
      }

      // 3. Flag duplicates
      if (seenPhones.has(normalized)) {
        duplicates.push({
          raw: cleanPhone,
          type: 'duplicate',
          reason: `Duplicate number of ${normalized}`,
        });
        return;
      }

      seenPhones.add(normalized);
      valid.push({
        phone: normalized,
        name: nameStr ? nameStr.trim().replace(/^["']|["']$/g, '') : `Contact ${digits.slice(-4)}`,
        email: emailStr ? emailStr.trim().replace(/^["']|["']$/g, '') : undefined,
      });
    };

    // Process textarea contacts
    const textLines = contactsText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    for (const line of textLines) {
      if (line.includes(',')) {
        const parts = line.split(',').map((p) => p.trim());
        processEntry(parts[0], parts[1], parts[2]);
      } else {
        processEntry(line);
      }
    }

    // Process file lines
    for (let i = dataStartIndex; i < fileRawLines.length; i++) {
      const line = fileRawLines[i].trim();
      if (!line) continue;
      const cols = line.split(',').map((c) => c.trim());
      const phoneVal = cols[phoneColIdx] !== undefined ? cols[phoneColIdx] : cols[0];
      const nameVal = nameColIdx >= 0 ? cols[nameColIdx] : undefined;
      const emailVal = emailColIdx >= 0 ? cols[emailColIdx] : undefined;
      processEntry(phoneVal, nameVal, emailVal);
    }

    return { validContacts: valid, flaggedDuplicates: duplicates, flaggedShortNumbers: shortNumbers };
  }, [contactsText, fileRawLines]);

  const contactCount = validContacts.length;
  const totalFlagged = flaggedDuplicates.length + flaggedShortNumbers.length;
  const hasUploadedOrEntered = contactCount > 0 || totalFlagged > 0;

  if (!isOpen) return null;

  // Handle CSV/TXT file upload
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;
      if (!content) return;

      const lines = content
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);

      setFileRawLines(lines);
      setShowFlaggedDetails(false);
    };
    reader.readAsText(file);
  };

  const handleLaunch = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!name.trim()) {
      setError('Please enter a campaign name');
      return;
    }

    if (operatingDays.length === 0) {
      setError('Please select at least one operating day for the schedule.');
      return;
    }

    if (contactCount === 0) {
      setError('Please provide at least one valid phone number (10+ digits).');
      return;
    }

    const finalScript = selectedScriptId === 'custom'
      ? (scriptText.trim() || 'Custom Script')
      : (scriptText.trim() && scriptText.trim() !== selectedPreset.prompt
          ? `${selectedPreset.title}: ${scriptText.trim()}`
          : selectedPreset.title);

    setIsSubmitting(true);
    try {
      const created = await createCampaign({
        name: name.trim(),
        description: description.trim() || undefined,
        script: finalScript,
        language,
        voice_pipeline: voicePipeline,
        schedule_start_time: scheduleStartTime,
        schedule_end_time: scheduleEndTime,
        operating_days: operatingDays,
        max_concurrent_calls: Number(maxConcurrentCalls) || 5,
        calls_per_minute: Number(callsPerMinute) || 30,
        retry_attempts: Number(retryAttempts) >= 0 ? Number(retryAttempts) : 3,
        retry_delay_minutes: Number(retryDelayMinutes) || 180,
        max_call_duration_minutes: Number(maxCallDurationMinutes) || 5,
        expected_dispositions: expectedDispositions,
        status: 'RUNNING',
        total_contacts: contactCount,
        contacts: validContacts.map((c) => c.phone),
      });

      if (onCampaignCreated) {
        onCampaignCreated(created);
      }

      // Reset and close
      setName('');
      setDescription('');
      setSelectedScriptId('delhi-routine');
      setScriptText(SCRIPT_PRESETS[0].prompt);
      setContactsText('');
      setFileName('');
      setFileRawLines([]);
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to create campaign. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const inputStyle: React.CSSProperties = {
    width: '100%',
    boxSizing: 'border-box',
    padding: '9px 12px',
    borderRadius: 8,
    background: '#080A10',
    border: '1px solid rgba(255, 255, 255, 0.1)',
    color: '#FFFFFF',
    fontSize: '0.85rem',
    outline: 'none',
    transition: 'border-color 0.15s ease',
  };

  const labelStyle: React.CSSProperties = {
    display: 'block',
    fontSize: '0.78rem',
    fontWeight: 500,
    color: '#94A3B8',
    marginBottom: 5,
  };

  const sectionHeadingStyle: React.CSSProperties = {
    fontSize: '0.86rem',
    fontWeight: 600,
    color: '#E2E8F0',
    display: 'flex',
    alignItems: 'center',
    gap: 7,
    letterSpacing: '-0.01em',
    marginBottom: 12,
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.82)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        padding: '16px 20px',
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !isSubmitting) {
          onClose();
        }
      }}
    >
      <div
        style={{
          background: '#0B0F17',
          border: '1px solid rgba(255, 255, 255, 0.1)',
          borderRadius: 16,
          width: 680,
          maxWidth: '100%',
          maxHeight: '92vh',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 28px 72px rgba(0, 0, 0, 0.9)',
          color: '#FFFFFF',
          animation: 'fadeIn 0.2s cubic-bezier(0.16, 1, 0.3, 1) forwards',
          overflow: 'hidden',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ padding: '20px 24px 16px 24px', borderBottom: '1px solid rgba(255, 255, 255, 0.08)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <h2
                style={{
                  fontSize: '1.2rem',
                  fontWeight: 700,
                  color: '#FFFFFF',
                  letterSpacing: '-0.02em',
                  margin: '0 0 4px 0',
                }}
              >
                Create campaign
              </h2>
              <p
                style={{
                  fontSize: '0.8rem',
                  color: '#94A3B8',
                  margin: 0,
                  lineHeight: 1.4,
                }}
              >
                Configure voice agent script, dispatch schedule, rate limits, and target audience.
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              style={{
                background: 'rgba(255, 255, 255, 0.04)',
                border: '1px solid rgba(255, 255, 255, 0.08)',
                color: '#94A3B8',
                borderRadius: 8,
                padding: '6px 8px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                transition: 'all 0.15s ease',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = '#FFFFFF';
                e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = '#94A3B8';
                e.currentTarget.style.background = 'rgba(255, 255, 255, 0.04)';
              }}
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Scrollable Form Body */}
        <form
          onSubmit={handleLaunch}
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 20,
            padding: '20px 24px',
            overflowY: 'auto',
          }}
        >
          {error && (
            <div
              style={{
                padding: '10px 14px',
                borderRadius: 8,
                background: 'rgba(239, 68, 68, 0.12)',
                border: '1px solid rgba(239, 68, 68, 0.3)',
                color: '#EF4444',
                fontSize: '0.82rem',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <AlertTriangle size={15} />
              <span>{error}</span>
            </div>
          )}

          {/* SECTION 1: Campaign Details */}
          <div
            style={{
              background: '#070A10',
              border: '1px solid rgba(255, 255, 255, 0.06)',
              borderRadius: 12,
              padding: 16,
              display: 'flex',
              flexDirection: 'column',
              gap: 14,
            }}
          >
            <div style={sectionHeadingStyle}>
              <Sparkles size={15} color="#38BDF8" />
              <span>Campaign Information</span>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 12 }}>
              <div>
                <label style={labelStyle}>Campaign Name *</label>
                <input
                  type="text"
                  required
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Q4 Airtel Wi-Fi Outbound Pilot"
                  style={{
                    ...inputStyle,
                    borderColor: '#3B82F6',
                    boxShadow: '0 0 0 1px rgba(59, 130, 246, 0.3)',
                  }}
                />
              </div>

              <div>
                <label style={labelStyle}>Description (Optional)</label>
                <input
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="e.g. Outbound Hindi retention pilot"
                  style={inputStyle}
                  onFocus={(e) => (e.currentTarget.style.borderColor = 'rgba(59, 130, 246, 0.5)')}
                  onBlur={(e) => (e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.1)')}
                />
              </div>
            </div>

            {/* Script Dropdown Field */}
            <div>
              <label style={labelStyle}>Script *</label>
              <select
                value={selectedScriptId}
                onChange={(e) => handleScriptChange(e.target.value)}
                style={{
                  ...inputStyle,
                  cursor: 'pointer',
                  borderColor: 'rgba(59, 130, 246, 0.4)',
                }}
              >
                {SCRIPT_PRESETS.map((preset) => (
                  <option key={preset.id} value={preset.id} style={{ background: '#0B0F17' }}>
                    {preset.title}
                  </option>
                ))}
              </select>

              {/* Script Prompt Textarea */}
              <div style={{ marginTop: 8 }}>
                <textarea
                  rows={2}
                  value={scriptText}
                  onChange={(e) => setScriptText(e.target.value)}
                  placeholder={
                    selectedScriptId === 'custom'
                      ? 'Enter custom script or opening line for the voice agent...'
                      : 'Spoken line...'
                  }
                  style={{
                    ...inputStyle,
                    fontSize: '0.8rem',
                    fontFamily: 'inherit',
                    resize: 'vertical',
                    minHeight: 46,
                    lineHeight: 1.4,
                    background: '#080A10',
                  }}
                  onFocus={(e) => (e.currentTarget.style.borderColor = 'rgba(59, 130, 246, 0.5)')}
                  onBlur={(e) => (e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.1)')}
                />
              </div>
            </div>

            {/* Language & Voice Pipeline */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <label style={labelStyle}>Language</label>
                <select
                  value={language}
                  onChange={(e) => setLanguage(e.target.value)}
                  style={{
                    ...inputStyle,
                    cursor: 'pointer',
                  }}
                >
                  <option value="hi-IN" style={{ background: '#0B0F17' }}>Hindi (hi-IN)</option>
                  <option value="en-IN" style={{ background: '#0B0F17' }}>English (India - en-IN)</option>
                  <option value="hi-Latn" style={{ background: '#0B0F17' }}>Hinglish (hi-Latn)</option>
                  <option value="ta-IN" style={{ background: '#0B0F17' }}>Tamil (ta-IN)</option>
                  <option value="te-IN" style={{ background: '#0B0F17' }}>Telugu (te-IN)</option>
                  <option value="kn-IN" style={{ background: '#0B0F17' }}>Kannada (kn-IN)</option>
                  <option value="bn-IN" style={{ background: '#0B0F17' }}>Bengali (bn-IN)</option>
                  <option value="mr-IN" style={{ background: '#0B0F17' }}>Marathi (mr-IN)</option>
                </select>
              </div>

              <div>
                <label style={labelStyle}>Voice Pipeline</label>
                <select
                  value={voicePipeline}
                  onChange={(e) => setVoicePipeline(e.target.value)}
                  style={{
                    ...inputStyle,
                    cursor: 'pointer',
                  }}
                >
                  <option value="Sarvam AI (Priya - hi-IN)" style={{ background: '#0B0F17' }}>Sarvam AI (Priya - hi-IN)</option>
                  <option value="Sarvam AI (Arvind - hi-IN)" style={{ background: '#0B0F17' }}>Sarvam AI (Arvind - hi-IN)</option>
                  <option value="OpenAI Realtime (Alloy)" style={{ background: '#0B0F17' }}>OpenAI Realtime (Alloy)</option>
                  <option value="OpenAI Realtime (Echo)" style={{ background: '#0B0F17' }}>OpenAI Realtime (Echo)</option>
                  <option value="ElevenLabs (Rachel - Expressive)" style={{ background: '#0B0F17' }}>ElevenLabs (Rachel - Expressive)</option>
                </select>
              </div>
            </div>
          </div>

          {/* SECTION 2: Schedule */}
          <div
            style={{
              background: '#070A10',
              border: '1px solid rgba(255, 255, 255, 0.06)',
              borderRadius: 12,
              padding: 16,
              display: 'flex',
              flexDirection: 'column',
              gap: 14,
            }}
          >
            <div style={sectionHeadingStyle}>
              <Clock size={15} color="#A78BFA" />
              <span>Schedule & Operating Hours</span>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <label style={labelStyle}>Start Time</label>
                <input
                  type="time"
                  value={scheduleStartTime}
                  onChange={(e) => setScheduleStartTime(e.target.value)}
                  style={inputStyle}
                  onFocus={(e) => (e.currentTarget.style.borderColor = 'rgba(167, 139, 250, 0.5)')}
                  onBlur={(e) => (e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.1)')}
                />
              </div>

              <div>
                <label style={labelStyle}>End Time</label>
                <input
                  type="time"
                  value={scheduleEndTime}
                  onChange={(e) => setScheduleEndTime(e.target.value)}
                  style={inputStyle}
                  onFocus={(e) => (e.currentTarget.style.borderColor = 'rgba(167, 139, 250, 0.5)')}
                  onBlur={(e) => (e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.1)')}
                />
              </div>
            </div>

            <div>
              <label style={labelStyle}>Operating Days</label>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
                {ALL_DAYS.map((day) => {
                  const isActive = operatingDays.includes(day);
                  return (
                    <button
                      key={day}
                      type="button"
                      onClick={() => toggleDay(day)}
                      style={{
                        padding: '6px 14px',
                        borderRadius: 6,
                        border: isActive ? '1px solid #8B5CF6' : '1px solid rgba(255, 255, 255, 0.1)',
                        background: isActive ? 'rgba(139, 92, 246, 0.18)' : '#080A10',
                        color: isActive ? '#C4B5FD' : '#94A3B8',
                        fontSize: '0.78rem',
                        fontWeight: 600,
                        cursor: 'pointer',
                        transition: 'all 0.15s ease',
                      }}
                    >
                      {day}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* SECTION 3: Rate Limits & Retries */}
          <div
            style={{
              background: '#070A10',
              border: '1px solid rgba(255, 255, 255, 0.06)',
              borderRadius: 12,
              padding: 16,
              display: 'flex',
              flexDirection: 'column',
              gap: 14,
            }}
          >
            <div style={sectionHeadingStyle}>
              <Sliders size={15} color="#34D399" />
              <span>Rate Limits & Retry Policy</span>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
              <div>
                <label style={labelStyle}>Max Concurrent</label>
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={maxConcurrentCalls}
                  onChange={(e) => setMaxConcurrentCalls(e.target.value)}
                  style={inputStyle}
                  onFocus={(e) => (e.currentTarget.style.borderColor = 'rgba(52, 211, 153, 0.5)')}
                  onBlur={(e) => (e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.1)')}
                />
              </div>

              <div>
                <label style={labelStyle}>Calls Per Minute</label>
                <input
                  type="number"
                  min={1}
                  max={300}
                  value={callsPerMinute}
                  onChange={(e) => setCallsPerMinute(e.target.value)}
                  style={inputStyle}
                  onFocus={(e) => (e.currentTarget.style.borderColor = 'rgba(52, 211, 153, 0.5)')}
                  onBlur={(e) => (e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.1)')}
                />
              </div>

              <div>
                <label style={labelStyle}>Retry Attempt</label>
                <input
                  type="number"
                  min={0}
                  max={10}
                  value={retryAttempts}
                  onChange={(e) => setRetryAttempts(e.target.value)}
                  style={inputStyle}
                  onFocus={(e) => (e.currentTarget.style.borderColor = 'rgba(52, 211, 153, 0.5)')}
                  onBlur={(e) => (e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.1)')}
                />
              </div>

              <div>
                <label style={labelStyle}>Retry Delay (min)</label>
                <input
                  type="number"
                  min={1}
                  max={1440}
                  value={retryDelayMinutes}
                  onChange={(e) => setRetryDelayMinutes(e.target.value)}
                  style={inputStyle}
                  onFocus={(e) => (e.currentTarget.style.borderColor = 'rgba(52, 211, 153, 0.5)')}
                  onBlur={(e) => (e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.1)')}
                />
              </div>
            </div>

            {/* Retries Explanation Notice */}
            <div
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 8,
                padding: '10px 12px',
                borderRadius: 8,
                background: 'rgba(56, 189, 248, 0.08)',
                border: '1px solid rgba(56, 189, 248, 0.2)',
                color: '#7DD3FC',
                fontSize: '0.78rem',
                lineHeight: 1.45,
              }}
            >
              <Info size={14} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>
                <strong>Notice:</strong> Retries apply to every not-connected result, including no answer, busy, and failed or unreachable calls.
              </span>
            </div>
          </div>

          {/* SECTION 4: Call Settings */}
          <div
            style={{
              background: '#070A10',
              border: '1px solid rgba(255, 255, 255, 0.06)',
              borderRadius: 12,
              padding: 16,
              display: 'flex',
              flexDirection: 'column',
              gap: 14,
            }}
          >
            <div style={sectionHeadingStyle}>
              <Settings size={15} color="#FB923C" />
              <span>Call Settings & Dispositions</span>
            </div>

            <div>
              <label style={labelStyle}>Max Call Duration (minutes)</label>
              <input
                type="number"
                min={1}
                max={60}
                value={maxCallDurationMinutes}
                onChange={(e) => setMaxCallDurationMinutes(e.target.value)}
                style={{ ...inputStyle, maxWidth: 220 }}
                onFocus={(e) => (e.currentTarget.style.borderColor = 'rgba(251, 146, 60, 0.5)')}
                onBlur={(e) => (e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.1)')}
              />
            </div>

            <div>
              <label style={labelStyle}>Expected Dispositions</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                {expectedDispositions.map((disp) => (
                  <span
                    key={disp}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 5,
                      padding: '3px 8px',
                      borderRadius: 6,
                      background: 'rgba(251, 146, 60, 0.12)',
                      border: '1px solid rgba(251, 146, 60, 0.28)',
                      color: '#FDBA74',
                      fontSize: '0.74rem',
                      fontWeight: 600,
                    }}
                  >
                    {disp}
                    <button
                      type="button"
                      onClick={() => removeDisposition(disp)}
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: '#FDBA74',
                        cursor: 'pointer',
                        padding: 0,
                        display: 'flex',
                        alignItems: 'center',
                      }}
                    >
                      <X size={11} />
                    </button>
                  </span>
                ))}
              </div>

              {/* Add custom disposition row */}
              <div style={{ display: 'flex', gap: 8, maxWidth: 360 }}>
                <input
                  type="text"
                  value={newDispositionInput}
                  onChange={(e) => setNewDispositionInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addDisposition();
                    }
                  }}
                  placeholder="Add custom disposition (e.g. PAYMENT_PROMISED)"
                  style={{ ...inputStyle, padding: '7px 10px', fontSize: '0.8rem' }}
                />
                <button
                  type="button"
                  onClick={addDisposition}
                  style={{
                    padding: '7px 12px',
                    borderRadius: 8,
                    background: 'rgba(251, 146, 60, 0.15)',
                    border: '1px solid rgba(251, 146, 60, 0.3)',
                    color: '#FB923C',
                    fontSize: '0.78rem',
                    fontWeight: 600,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                    flexShrink: 0,
                  }}
                >
                  <Plus size={13} />
                  Add
                </button>
              </div>
            </div>
          </div>

          {/* SECTION 5: Audience & Contacts */}
          <div
            style={{
              background: '#070A10',
              border: '1px solid rgba(255, 255, 255, 0.06)',
              borderRadius: 12,
              padding: 16,
              display: 'flex',
              flexDirection: 'column',
              gap: 14,
            }}
          >
            <div style={sectionHeadingStyle}>
              <Upload size={15} color="#38BDF8" />
              <span>Target Audience (CSV or Manual Input)</span>
            </div>

            {/* CSV File Upload */}
            <div>
              <label style={labelStyle}>Upload CSV file (supports phone_number, name, email)</label>
              <div
                style={{
                  background: '#080A10',
                  border: '1px solid rgba(255, 255, 255, 0.1)',
                  borderRadius: 8,
                  padding: '8px 12px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                }}
              >
                <input
                  id={fileInputId}
                  type="file"
                  accept=".csv,.txt"
                  onChange={handleFileUpload}
                  style={{ display: 'none' }}
                />
                <label
                  htmlFor={fileInputId}
                  style={{
                    padding: '6px 14px',
                    borderRadius: 6,
                    background: 'rgba(56, 189, 248, 0.12)',
                    border: '1px solid rgba(56, 189, 248, 0.3)',
                    color: '#38BDF8',
                    fontSize: '0.78rem',
                    fontWeight: 600,
                    cursor: 'pointer',
                    userSelect: 'none',
                    flexShrink: 0,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    transition: 'background 0.15s ease',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(56, 189, 248, 0.22)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'rgba(56, 189, 248, 0.12)')}
                >
                  <Upload size={13} />
                  Choose CSV
                </label>

                <span
                  style={{
                    fontSize: '0.82rem',
                    color: fileName ? '#38BDF8' : '#64748B',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    flex: 1,
                  }}
                >
                  {fileName || 'No file selected (or drag & drop here)'}
                </span>
              </div>
            </div>

            {/* Manual Contacts Textarea */}
            <div>
              <label style={labelStyle}>Or paste phone numbers manually</label>
              <textarea
                rows={2}
                value={contactsText}
                onChange={(e) => setContactsText(e.target.value)}
                placeholder="+919876543210, John Doe&#10;+919876543211, Jane Smith"
                style={{
                  ...inputStyle,
                  fontFamily: 'inherit',
                  resize: 'vertical',
                  minHeight: 56,
                }}
                onFocus={(e) => (e.currentTarget.style.borderColor = 'rgba(59, 130, 246, 0.5)')}
                onBlur={(e) => (e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.1)')}
              />
            </div>

            {/* Validation Breakdown Panel */}
            {hasUploadedOrEntered && (
              <div
                style={{
                  background: '#04060A',
                  border: '1px solid rgba(255, 255, 255, 0.08)',
                  borderRadius: 10,
                  padding: '12px 14px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '3px 10px',
                      borderRadius: 6,
                      background: 'rgba(16, 185, 129, 0.14)',
                      border: '1px solid rgba(16, 185, 129, 0.3)',
                      color: '#34D399',
                      fontSize: '0.74rem',
                      fontWeight: 700,
                    }}
                  >
                    <CheckCircle2 size={13} />
                    <span>{contactCount} Valid Contact{contactCount === 1 ? '' : 's'}</span>
                  </div>

                  {flaggedDuplicates.length > 0 && (
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        padding: '3px 10px',
                        borderRadius: 6,
                        background: 'rgba(245, 158, 11, 0.14)',
                        border: '1px solid rgba(245, 158, 11, 0.3)',
                        color: '#F59E0B',
                        fontSize: '0.74rem',
                        fontWeight: 700,
                      }}
                    >
                      <AlertTriangle size={13} />
                      <span>{flaggedDuplicates.length} Duplicate{flaggedDuplicates.length === 1 ? '' : 's'} Flagged</span>
                    </div>
                  )}

                  {flaggedShortNumbers.length > 0 && (
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        padding: '3px 10px',
                        borderRadius: 6,
                        background: 'rgba(244, 63, 94, 0.14)',
                        border: '1px solid rgba(244, 63, 94, 0.3)',
                        color: '#FB7185',
                        fontSize: '0.74rem',
                        fontWeight: 700,
                      }}
                    >
                      <XCircle size={13} />
                      <span>{flaggedShortNumbers.length} Invalid (&lt;10 digits)</span>
                    </div>
                  )}
                </div>

                {totalFlagged > 0 ? (
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <p style={{ fontSize: '0.76rem', color: '#94A3B8', margin: 0, lineHeight: 1.4 }}>
                        Flagged items are automatically removed to protect campaign deliverability.
                      </p>
                      <button
                        type="button"
                        onClick={() => setShowFlaggedDetails(!showFlaggedDetails)}
                        style={{
                          background: 'transparent',
                          border: 'none',
                          color: '#38BDF8',
                          fontSize: '0.74rem',
                          fontWeight: 600,
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 4,
                          padding: '2px 4px',
                        }}
                      >
                        {showFlaggedDetails ? (
                          <>Hide flagged items <ChevronUp size={12} /></>
                        ) : (
                          <>View flagged ({totalFlagged}) <ChevronDown size={12} /></>
                        )}
                      </button>
                    </div>

                    {showFlaggedDetails && (
                      <div
                        style={{
                          marginTop: 10,
                          maxHeight: 120,
                          overflowY: 'auto',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 6,
                          padding: '8px 10px',
                          background: '#090D16',
                          borderRadius: 6,
                          border: '1px solid rgba(255, 255, 255, 0.05)',
                        }}
                      >
                        {flaggedShortNumbers.map((item, idx) => (
                          <div
                            key={`short-${idx}`}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              fontSize: '0.74rem',
                              color: '#FB7185',
                            }}
                          >
                            <span style={{ fontFamily: 'monospace' }}>{item.raw}</span>
                            <span style={{ color: '#64748B' }}>Flagged: &lt; 10 digits</span>
                          </div>
                        ))}

                        {flaggedDuplicates.map((item, idx) => (
                          <div
                            key={`dup-${idx}`}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              fontSize: '0.74rem',
                              color: '#F59E0B',
                            }}
                          >
                            <span style={{ fontFamily: 'monospace' }}>{item.raw}</span>
                            <span style={{ color: '#64748B' }}>Flagged: duplicate</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ) : (
                  <p style={{ fontSize: '0.75rem', color: '#10B981', margin: 0 }}>
                    ✓ All numbers passed validation (10+ digits, zero duplicates detected).
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Footer Row */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              paddingTop: 8,
              borderTop: '1px solid rgba(255, 255, 255, 0.08)',
            }}
          >
            {/* Contacts counter */}
            <div
              style={{
                fontSize: '0.82rem',
                color: contactCount > 0 ? '#38BDF8' : '#64748B',
                fontWeight: 600,
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <FileText size={14} />
              <span>{contactCount} valid contact{contactCount === 1 ? '' : 's'}</span>
            </div>

            {/* Action Buttons */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <button
                type="button"
                onClick={onClose}
                disabled={isSubmitting}
                style={{
                  padding: '9px 18px',
                  borderRadius: 8,
                  background: 'rgba(255, 255, 255, 0.05)',
                  border: '1px solid rgba(255, 255, 255, 0.1)',
                  color: '#E2E8F0',
                  fontSize: '0.85rem',
                  fontWeight: 600,
                  cursor: isSubmitting ? 'not-allowed' : 'pointer',
                  transition: 'background 0.15s ease',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)')}
              >
                Cancel
              </button>

              <button
                type="submit"
                disabled={isSubmitting || contactCount === 0}
                style={{
                  padding: '9px 20px',
                  borderRadius: 8,
                  background: contactCount === 0 ? '#1E293B' : '#2563EB',
                  border: 'none',
                  color: '#FFFFFF',
                  fontSize: '0.85rem',
                  fontWeight: 600,
                  cursor: (isSubmitting || contactCount === 0) ? 'not-allowed' : 'pointer',
                  boxShadow: contactCount === 0 ? 'none' : '0 4px 14px rgba(37, 99, 235, 0.35)',
                  transition: 'background 0.15s ease, transform 0.15s ease',
                  opacity: isSubmitting ? 0.7 : 1,
                }}
                onMouseEnter={(e) => {
                  if (!isSubmitting && contactCount > 0) {
                    e.currentTarget.style.background = '#1D4ED8';
                    e.currentTarget.style.transform = 'translateY(-1px)';
                  }
                }}
                onMouseLeave={(e) => {
                  if (!isSubmitting && contactCount > 0) {
                    e.currentTarget.style.background = '#2563EB';
                    e.currentTarget.style.transform = 'translateY(0)';
                  }
                }}
              >
                {isSubmitting ? 'Launching...' : 'Launch campaign'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};
