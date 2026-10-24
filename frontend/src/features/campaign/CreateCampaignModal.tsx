import React, { useState, useId, useMemo } from 'react';
import { 
  CheckCircle2, 
  AlertTriangle, 
  XCircle, 
  ChevronDown, 
  ChevronUp, 
  FileText,
  Upload
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

export const CreateCampaignModal: React.FC<CreateCampaignModalProps> = ({
  isOpen,
  onClose,
  onCampaignCreated,
}) => {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [contactsText, setContactsText] = useState('');
  const [fileName, setFileName] = useState('');
  const [fileRawLines, setFileRawLines] = useState<string[]>([]);
  const [showFlaggedDetails, setShowFlaggedDetails] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fileInputId = useId();

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

    if (contactCount === 0) {
      setError('Please provide at least one valid phone number (10+ digits).');
      return;
    }

    setIsSubmitting(true);
    try {
      const created = await createCampaign({
        name: name.trim(),
        description: description.trim() || 'Voice outreach campaign dispatched via CuroAI.',
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

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.78)',
        backdropFilter: 'blur(6px)',
        WebkitBackdropFilter: 'blur(6px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        padding: 20,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !isSubmitting) {
          onClose();
        }
      }}
    >
      <div
        style={{
          background: '#0E121B',
          border: '1px solid rgba(255, 255, 255, 0.1)',
          borderRadius: 16,
          width: 560,
          maxWidth: '100%',
          maxHeight: '92vh',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 24px 64px rgba(0, 0, 0, 0.85)',
          color: '#FFFFFF',
          animation: 'fadeIn 0.2s cubic-bezier(0.16, 1, 0.3, 1) forwards',
          overflow: 'hidden',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ padding: '24px 28px 18px 28px', borderBottom: '1px solid rgba(255, 255, 255, 0.07)' }}>
          <h2
            style={{
              fontSize: '1.25rem',
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
              fontSize: '0.84rem',
              color: '#94A3B8',
              margin: 0,
              lineHeight: 1.4,
            }}
          >
            Upload a CSV or paste contacts. Numbers &lt;10 digits and duplicates are automatically flagged and cleaned.
          </p>
        </div>

        {/* Scrollable Form Body */}
        <form
          onSubmit={handleLaunch}
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
            padding: '20px 28px',
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
              }}
            >
              {error}
            </div>
          )}

          {/* Field 1: Campaign name */}
          <div>
            <label
              style={{
                display: 'block',
                fontSize: '0.82rem',
                fontWeight: 500,
                color: '#E2E8F0',
                marginBottom: 6,
              }}
            >
              Campaign name
            </label>
            <input
              type="text"
              required
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Q4 Wi-Fi Router Outbound Pilot"
              style={{
                width: '100%',
                boxSizing: 'border-box',
                padding: '10px 14px',
                borderRadius: 8,
                background: '#080A10',
                border: '1px solid #3B82F6',
                color: '#FFFFFF',
                fontSize: '0.88rem',
                outline: 'none',
                boxShadow: '0 0 0 1px #3B82F6',
              }}
            />
          </div>

          {/* Field 2: Description */}
          <div>
            <label
              style={{
                display: 'block',
                fontSize: '0.82rem',
                fontWeight: 500,
                color: '#E2E8F0',
                marginBottom: 6,
              }}
            >
              Description
            </label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g. Outbound Hindi retention with Priya voice agent"
              style={{
                width: '100%',
                boxSizing: 'border-box',
                padding: '10px 14px',
                borderRadius: 8,
                background: '#080A10',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                color: '#FFFFFF',
                fontSize: '0.88rem',
                outline: 'none',
                transition: 'border-color 0.15s ease',
              }}
              onFocus={(e) => (e.currentTarget.style.borderColor = 'rgba(59, 130, 246, 0.5)')}
              onBlur={(e) => (e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.1)')}
            />
          </div>

          {/* Field 3: Upload CSV file */}
          <div>
            <label
              style={{
                display: 'block',
                fontSize: '0.82rem',
                fontWeight: 500,
                color: '#E2E8F0',
                marginBottom: 6,
              }}
            >
              Upload CSV file (supports phone_number, name, email)
            </label>
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

          {/* Field 4: Or paste contacts */}
          <div>
            <label
              style={{
                display: 'block',
                fontSize: '0.82rem',
                fontWeight: 500,
                color: '#E2E8F0',
                marginBottom: 6,
              }}
            >
              Or paste phone numbers manually
            </label>
            <textarea
              rows={3}
              value={contactsText}
              onChange={(e) => setContactsText(e.target.value)}
              placeholder="+919876543210, John Doe&#10;+919876543211, Jane Smith"
              style={{
                width: '100%',
                boxSizing: 'border-box',
                padding: '10px 14px',
                borderRadius: 8,
                background: '#080A10',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                color: '#FFFFFF',
                fontSize: '0.85rem',
                fontFamily: 'inherit',
                outline: 'none',
                resize: 'vertical',
                minHeight: 70,
                transition: 'border-color 0.15s ease',
              }}
              onFocus={(e) => (e.currentTarget.style.borderColor = 'rgba(59, 130, 246, 0.5)')}
              onBlur={(e) => (e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.1)')}
            />
          </div>

          {/* Validation & Flagged Breakdown Panel */}
          {hasUploadedOrEntered && (
            <div
              style={{
                background: '#06080E',
                border: '1px solid rgba(255, 255, 255, 0.08)',
                borderRadius: 10,
                padding: '12px 14px',
              }}
            >
              {/* Status pills row */}
              <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
                {/* Valid contacts badge */}
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

                {/* Duplicates flagged badge */}
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

                {/* Short numbers (< 10 digits) flagged badge */}
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

              {/* Explanatory note */}
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

                  {/* Expandable list of flagged numbers */}
                  {showFlaggedDetails && (
                    <div
                      style={{
                        marginTop: 10,
                        maxHeight: 130,
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

          {/* Footer Row */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              paddingTop: 8,
              borderTop: '1px solid rgba(255, 255, 255, 0.07)',
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
