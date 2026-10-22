import React, { useState, useRef, useEffect } from 'react';
import { 
  UploadCloud, 
  X, 
  FileText, 
  CheckCircle2, 
  Download, 
  AlertCircle, 
  FileSpreadsheet, 
  Phone, 
  Database,
  ArrowRight
} from 'lucide-react';
import type { CustomerCreateInput } from '../../types';
import { 
  parseTelecomCsv, 
  downloadSampleCsv, 
  getSampleCsvContent 
} from '../../utils/csvHelper';

interface LeadImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  onImport: (leads: Partial<CustomerCreateInput>[]) => Promise<boolean>;
}

type TabMode = 'FILE' | 'PASTE_CSV' | 'JSON';

export const LeadImportModal: React.FC<LeadImportModalProps> = ({ isOpen, onClose, onImport }) => {
  const [tab, setTab] = useState<TabMode>('FILE');
  const [file, setFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [rawText, setRawText] = useState('');
  const [parsedLeads, setParsedLeads] = useState<Partial<CustomerCreateInput>[]>([]);
  const [detectedHeaders, setDetectedHeaders] = useState<string[]>([]);
  const [parseErrors, setParseErrors] = useState<string[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{ type: 'error' | 'success'; text: string } | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Reset state when modal opens/closes
  useEffect(() => {
    if (isOpen) {
      setStatusMessage(null);
    } else {
      setFile(null);
      setRawText('');
      setParsedLeads([]);
      setDetectedHeaders([]);
      setParseErrors([]);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  // Process text content (from file or paste)
  const processContent = (content: string, mode: 'CSV' | 'JSON') => {
    setStatusMessage(null);
    setParseErrors([]);

    if (mode === 'JSON') {
      try {
        const parsed = JSON.parse(content);
        if (!Array.isArray(parsed) || parsed.length === 0) {
          throw new Error('Please provide a JSON array with at least one lead record.');
        }
        setParsedLeads(parsed);
        setDetectedHeaders(Object.keys(parsed[0] || {}));
      } catch (err: any) {
        setParsedLeads([]);
        setParseErrors([err.message || 'Invalid JSON format']);
      }
      return;
    }

    // CSV Mode
    const result = parseTelecomCsv(content);
    setParsedLeads(result.leads);
    setDetectedHeaders(result.headers);
    setParseErrors(result.errors);

    if (result.leads.length === 0 && result.errors.length === 0) {
      setParseErrors(['No valid lead rows could be extracted. Please check the CSV structure.']);
    }
  };

  // Handle file selection
  const handleFileChange = (selectedFile: File) => {
    setFile(selectedFile);
    const reader = new FileReader();

    reader.onload = (e) => {
      const content = e.target?.result as string;
      if (!content) return;

      if (selectedFile.name.endsWith('.json')) {
        setTab('JSON');
        processContent(content, 'JSON');
      } else {
        processContent(content, 'CSV');
      }
    };

    reader.onerror = () => {
      setStatusMessage({ type: 'error', text: 'Failed to read file from disk.' });
    };

    reader.readAsText(selectedFile);
  };

  // Drag and Drop handlers
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFileChange(e.dataTransfer.files[0]);
    }
  };

  // Load sample template into paste view
  const handleLoadSamplePaste = () => {
    const sample = getSampleCsvContent();
    setRawText(sample);
    processContent(sample, 'CSV');
  };

  // Submit leads to backend
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (parsedLeads.length === 0) {
      setStatusMessage({ type: 'error', text: 'No leads available to import.' });
      return;
    }

    try {
      setIsSubmitting(true);
      setStatusMessage(null);
      const success = await onImport(parsedLeads);
      if (success) {
        onClose();
      }
    } catch (err: any) {
      setStatusMessage({ type: 'error', text: err.message || 'Import failed.' });
    } finally {
      setIsSubmitting(false);
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
    }}>
      <div style={{
        background: '#0a0f1d',
        border: '1px solid var(--border-light)',
        borderRadius: 'var(--radius-lg)',
        width: '100%',
        maxWidth: 820,
        maxHeight: '92vh',
        display: 'flex',
        flexDirection: 'column',
        boxShadow: '0 30px 60px -15px rgba(0, 0, 0, 0.85)',
        overflow: 'hidden',
      }}>
        {/* Modal Header */}
        <div style={{
          padding: '16px 24px',
          borderBottom: '1px solid var(--border-subtle)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          background: 'rgba(255, 255, 255, 0.02)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{
              width: 36,
              height: 36,
              borderRadius: 10,
              background: 'linear-gradient(135deg, var(--airtel-red) 0%, var(--airtel-red-dark) 100%)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#fff',
            }}>
              <UploadCloud size={20} />
            </div>
            <div>
              <h3 style={{ fontSize: '1.1rem', fontWeight: 800, color: '#fff', letterSpacing: '-0.01em' }}>
                Import Airtel Campaign Leads
              </h3>
              <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                Upload spreadsheet (CSV) with Wi-Fi router pickup leads
              </p>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {/* Quick Sample Download */}
            <button
              type="button"
              onClick={downloadSampleCsv}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                background: 'rgba(56, 189, 248, 0.1)',
                border: '1px solid rgba(56, 189, 248, 0.25)',
                color: 'var(--accent-cyan)',
                padding: '6px 12px',
                borderRadius: 'var(--radius-sm)',
                fontSize: '0.75rem',
                fontWeight: 600,
                cursor: 'pointer',
              }}
              title="Download CSV template matching your spreadsheet"
            >
              <Download size={13} />
              Download Sample CSV
            </button>

            <button
              onClick={onClose}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--text-muted)',
                cursor: 'pointer',
                padding: 4,
                display: 'flex',
                alignItems: 'center',
              }}
            >
              <X size={20} />
            </button>
          </div>
        </div>

        {/* Tab Selection */}
        <div style={{
          display: 'flex',
          borderBottom: '1px solid var(--border-subtle)',
          padding: '0 24px',
          background: 'rgba(0, 0, 0, 0.2)',
          gap: 16,
        }}>
          <button
            type="button"
            onClick={() => setTab('FILE')}
            style={{
              padding: '12px 4px',
              border: 'none',
              background: 'none',
              borderBottom: tab === 'FILE' ? '2px solid var(--airtel-red)' : '2px solid transparent',
              color: tab === 'FILE' ? '#fff' : 'var(--text-muted)',
              fontSize: '0.84rem',
              fontWeight: 700,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <FileSpreadsheet size={16} color={tab === 'FILE' ? 'var(--airtel-red)' : 'currentColor'} />
            Upload CSV File
          </button>

          <button
            type="button"
            onClick={() => setTab('PASTE_CSV')}
            style={{
              padding: '12px 4px',
              border: 'none',
              background: 'none',
              borderBottom: tab === 'PASTE_CSV' ? '2px solid var(--airtel-red)' : '2px solid transparent',
              color: tab === 'PASTE_CSV' ? '#fff' : 'var(--text-muted)',
              fontSize: '0.84rem',
              fontWeight: 700,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <FileText size={16} color={tab === 'PASTE_CSV' ? 'var(--airtel-red)' : 'currentColor'} />
            Paste CSV Text
          </button>

          <button
            type="button"
            onClick={() => setTab('JSON')}
            style={{
              padding: '12px 4px',
              border: 'none',
              background: 'none',
              borderBottom: tab === 'JSON' ? '2px solid var(--airtel-red)' : '2px solid transparent',
              color: tab === 'JSON' ? '#fff' : 'var(--text-muted)',
              fontSize: '0.84rem',
              fontWeight: 700,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <Database size={16} color={tab === 'JSON' ? 'var(--airtel-red)' : 'currentColor'} />
            Direct JSON Array
          </button>
        </div>

        {/* Modal Scrollable Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
          {/* TAB 1: FILE DROPZONE */}
          {tab === 'FILE' && (
            <div>
              <div
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                style={{
                  border: isDragging ? '2px dashed var(--airtel-red)' : '2px dashed var(--border-light)',
                  borderRadius: 'var(--radius-lg)',
                  background: isDragging ? 'rgba(228, 0, 0, 0.08)' : 'rgba(15, 23, 42, 0.5)',
                  padding: '36px 20px',
                  textAlign: 'center',
                  cursor: 'pointer',
                  transition: 'all 0.2s ease',
                  position: 'relative',
                }}
              >
                <input
                  type="file"
                  ref={fileInputRef}
                  onChange={(e) => e.target.files?.[0] && handleFileChange(e.target.files[0])}
                  accept=".csv,.txt,.tsv,.json"
                  style={{ display: 'none' }}
                />

                <div style={{
                  width: 56,
                  height: 56,
                  borderRadius: 16,
                  background: 'rgba(255, 255, 255, 0.05)',
                  margin: '0 auto 14px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: isDragging ? 'var(--airtel-red)' : 'var(--accent-blue)',
                }}>
                  <UploadCloud size={28} />
                </div>

                <h4 style={{ fontSize: '0.98rem', fontWeight: 700, color: '#fff', marginBottom: 6 }}>
                  {file ? file.name : 'Click to select or drag & drop CSV file'}
                </h4>

                <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', maxWidth: 440, margin: '0 auto' }}>
                  Supports CSV formatted with columns: <strong style={{ color: '#fff' }}>R. Date, Check, SUBS_DEL_NO, ACCOUNT_NO, SERVICE_END, Address</strong>
                </p>

                {file && (
                  <div style={{ marginTop: 14 }}>
                    <span className="badge badge-green" style={{ fontSize: '0.76rem' }}>
                      Selected: {file.name} ({(file.size / 1024).toFixed(1)} KB)
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* TAB 2: PASTE CSV */}
          {tab === 'PASTE_CSV' && (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 600 }}>
                  Paste CSV content (Comma or Tab separated):
                </label>
                <button
                  type="button"
                  onClick={handleLoadSamplePaste}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'var(--accent-cyan)',
                    fontSize: '0.78rem',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                  }}
                >
                  <FileText size={13} />
                  Insert Sample CSV
                </button>
              </div>

              <textarea
                rows={6}
                value={rawText}
                onChange={(e) => {
                  setRawText(e.target.value);
                  processContent(e.target.value, 'CSV');
                }}
                placeholder="R. Date,Check,SUBS_DEL_NO,ACCOUNT_NO,SERVICE_END,Address&#10;29 Aug 26,.,01121344121_wifi,20022941256,27 Aug 26,Delhi, 110011, burari, sant nagar"
                style={{
                  width: '100%',
                  padding: '12px',
                  borderRadius: 'var(--radius-md)',
                  background: 'rgba(15, 23, 42, 0.8)',
                  border: '1px solid var(--border-light)',
                  color: '#e2e8f0',
                  fontFamily: 'monospace',
                  fontSize: '0.8rem',
                  outline: 'none',
                  resize: 'vertical',
                }}
              />
            </div>
          )}

          {/* TAB 3: JSON */}
          {tab === 'JSON' && (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 600 }}>
                  Raw JSON Array:
                </label>
                <button
                  type="button"
                  onClick={() => {
                    const sample = [
                      {
                        subs_del_no: "01121344121_wifi",
                        account_no: "20022941256",
                        service_end_date: "2026-08-27",
                        r_date: "2026-08-29",
                        address: "Delhi, 110011, burari, sant nagar",
                        phone: "+911121344121",
                        name: "Airtel Subscriber"
                      }
                    ];
                    const jsonStr = JSON.stringify(sample, null, 2);
                    setRawText(jsonStr);
                    processContent(jsonStr, 'JSON');
                  }}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'var(--accent-cyan)',
                    fontSize: '0.78rem',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                  }}
                >
                  <FileText size={13} />
                  Insert Sample JSON
                </button>
              </div>

              <textarea
                rows={6}
                value={rawText}
                onChange={(e) => {
                  setRawText(e.target.value);
                  processContent(e.target.value, 'JSON');
                }}
                placeholder='[{"subs_del_no":"01121344121_wifi","account_no":"20022941256","address":"Delhi..."}]'
                style={{
                  width: '100%',
                  padding: '12px',
                  borderRadius: 'var(--radius-md)',
                  background: 'rgba(15, 23, 42, 0.8)',
                  border: '1px solid var(--border-light)',
                  color: '#34d399',
                  fontFamily: 'monospace',
                  fontSize: '0.8rem',
                  outline: 'none',
                  resize: 'vertical',
                }}
              />
            </div>
          )}

          {/* Validation Errors banner */}
          {parseErrors.length > 0 && (
            <div style={{
              marginTop: 14,
              padding: '10px 14px',
              borderRadius: 'var(--radius-md)',
              background: 'rgba(239, 68, 68, 0.1)',
              border: '1px solid rgba(239, 68, 68, 0.25)',
              color: 'var(--accent-rose)',
              fontSize: '0.8rem',
              display: 'flex',
              alignItems: 'flex-start',
              gap: 8,
            }}>
              <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 2 }} />
              <div>
                <strong>Validation Notice:</strong>
                <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
                  {parseErrors.slice(0, 3).map((err, idx) => (
                    <li key={idx}>{err}</li>
                  ))}
                  {parseErrors.length > 3 && (
                    <li>...and {parseErrors.length - 3} more errors.</li>
                  )}
                </ul>
              </div>
            </div>
          )}

          {/* PREVIEW TABLE OF PARSED LEADS */}
          {parsedLeads.length > 0 && (
            <div style={{ marginTop: 20 }}>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: 10,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <h4 style={{ fontSize: '0.88rem', fontWeight: 700, color: '#fff' }}>
                    Parsed Leads Preview
                  </h4>
                  <span className="badge badge-green" style={{ fontSize: '0.72rem' }}>
                    {parsedLeads.length} Leads Ready
                  </span>
                </div>

                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  Showing first {Math.min(5, parsedLeads.length)} of {parsedLeads.length}
                </span>
              </div>

              {detectedHeaders.length > 0 && (
                <div style={{ marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>Detected Headers:</span>
                  {detectedHeaders.map((h, i) => (
                    <span key={i} className="badge badge-slate" style={{ fontSize: '0.68rem', padding: '2px 6px' }}>
                      {h}
                    </span>
                  ))}
                </div>
              )}

              {/* Informative resolution pill */}
              <div style={{
                background: 'rgba(56, 189, 248, 0.08)',
                border: '1px solid rgba(56, 189, 248, 0.2)',
                borderRadius: 'var(--radius-md)',
                padding: '8px 12px',
                marginBottom: 12,
                fontSize: '0.78rem',
                color: 'var(--accent-cyan)',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}>
                <Phone size={14} style={{ flexShrink: 0 }} />
                <span>
                  <strong>SIP Auto-Resolution:</strong> Phone numbers have been automatically extracted from{' '}
                  <code style={{ background: 'rgba(0,0,0,0.3)', padding: '2px 4px', borderRadius: 4 }}>SUBS_DEL_NO</code>{' '}
                  and formatted to E.164 (+91) for Exotel / LiveKit outbound dialing.
                </span>
              </div>

              {/* Table Preview */}
              <div style={{
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--border-subtle)',
                overflowX: 'auto',
                background: 'rgba(0, 0, 0, 0.3)',
              }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.78rem', textAlign: 'left' }}>
                  <thead>
                    <tr style={{
                      background: 'rgba(255, 255, 255, 0.03)',
                      borderBottom: '1px solid var(--border-subtle)',
                      color: 'var(--text-muted)',
                      textTransform: 'uppercase',
                      letterSpacing: '0.04em',
                    }}>
                      <th style={{ padding: '8px 12px' }}>#</th>
                      <th style={{ padding: '8px 12px' }}>SUBS_DEL_NO</th>
                      <th style={{ padding: '8px 12px' }}>ACCOUNT_NO</th>
                      <th style={{ padding: '8px 12px' }}>Dialable Phone</th>
                      <th style={{ padding: '8px 12px' }}>Service End</th>
                      <th style={{ padding: '8px 12px' }}>R. Date</th>
                      <th style={{ padding: '8px 12px' }}>Address</th>
                    </tr>
                  </thead>
                  <tbody>
                    {parsedLeads.slice(0, 5).map((lead, idx) => (
                      <tr key={idx} style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.04)' }}>
                        <td style={{ padding: '8px 12px', color: 'var(--text-muted)' }}>{idx + 1}</td>
                        <td style={{ padding: '8px 12px', fontWeight: 600, color: '#fff' }}>
                          {lead.subs_del_no || '-'}
                        </td>
                        <td style={{ padding: '8px 12px', color: 'var(--text-secondary)' }}>
                          {lead.account_no || '-'}
                        </td>
                        <td style={{ padding: '8px 12px' }}>
                          <span className="badge badge-purple" style={{ fontSize: '0.72rem' }}>
                            {lead.phone}
                          </span>
                        </td>
                        <td style={{ padding: '8px 12px', color: 'var(--accent-amber)' }}>
                          {lead.service_end_date || '-'}
                        </td>
                        <td style={{ padding: '8px 12px', color: 'var(--text-muted)' }}>
                          {lead.r_date || '-'}
                        </td>
                        <td style={{
                          padding: '8px 12px',
                          maxWidth: 220,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          color: 'var(--text-secondary)',
                        }}>
                          {lead.address}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {statusMessage && (
            <div style={{
              marginTop: 14,
              padding: '10px 14px',
              borderRadius: 'var(--radius-md)',
              background: statusMessage.type === 'error' ? 'rgba(239, 68, 68, 0.15)' : 'rgba(34, 197, 94, 0.15)',
              color: statusMessage.type === 'error' ? 'var(--accent-rose)' : 'var(--accent-green)',
              fontSize: '0.82rem',
              fontWeight: 600,
            }}>
              {statusMessage.text}
            </div>
          )}
        </div>

        {/* Modal Footer Actions */}
        <div style={{
          padding: '16px 24px',
          borderTop: '1px solid var(--border-subtle)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          background: 'rgba(255, 255, 255, 0.02)',
        }}>
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: '8px 16px',
              borderRadius: 'var(--radius-sm)',
              background: 'rgba(255, 255, 255, 0.08)',
              color: 'var(--text-secondary)',
              border: '1px solid var(--border-subtle)',
              fontSize: '0.84rem',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>

          <button
            type="button"
            onClick={handleSubmit}
            disabled={isSubmitting || parsedLeads.length === 0}
            style={{
              padding: '9px 20px',
              borderRadius: 'var(--radius-sm)',
              background: parsedLeads.length === 0
                ? 'rgba(255, 255, 255, 0.1)'
                : 'linear-gradient(135deg, var(--airtel-red) 0%, var(--airtel-red-dark) 100%)',
              color: parsedLeads.length === 0 ? 'var(--text-muted)' : '#fff',
              border: 'none',
              fontSize: '0.86rem',
              fontWeight: 700,
              cursor: isSubmitting || parsedLeads.length === 0 ? 'not-allowed' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              boxShadow: parsedLeads.length > 0 ? '0 2px 10px rgba(228, 0, 0, 0.35)' : 'none',
            }}
          >
            <CheckCircle2 size={16} />
            {isSubmitting ? (
              'Importing Leads...'
            ) : (
              `Import ${parsedLeads.length > 0 ? parsedLeads.length : ''} Leads into Campaign`
            )}
            <ArrowRight size={14} />
          </button>
        </div>
      </div>
    </div>
  );
};
