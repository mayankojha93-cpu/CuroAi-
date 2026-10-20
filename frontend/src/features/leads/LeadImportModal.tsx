import React, { useState } from 'react';
import { UploadCloud, X, FileText, CheckCircle2 } from 'lucide-react';
import type { CustomerCreateInput } from '../../types';

interface LeadImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  onImport: (leads: Partial<CustomerCreateInput>[]) => Promise<boolean>;
}

export const LeadImportModal: React.FC<LeadImportModalProps> = ({ isOpen, onClose, onImport }) => {
  const [jsonInput, setJsonInput] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleSampleLoad = () => {
    const sample = [
      {
        name: "Vikram Malhotra",
        phone: "+919811122233",
        account_no: "20022941299",
        subs_del_no: "01121344199_wifi",
        service_end_date: "2026-09-15",
        address: "Flat 402, Tower B, Sector 62, Noida, UP - 201309",
        language: "hi"
      },
      {
        name: "Pooja Sharma",
        phone: "+919876543210",
        account_no: "20022941300",
        subs_del_no: "01121344200_wifi",
        service_end_date: "2026-08-30",
        address: "C-12, Green Park Extension, New Delhi - 110016",
        language: "hi"
      }
    ];
    setJsonInput(JSON.stringify(sample, null, 2));
    setError(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const parsed = JSON.parse(jsonInput);
      if (!Array.isArray(parsed) || parsed.length === 0) {
        throw new Error('Please provide a JSON array with at least one customer lead.');
      }
      setIsSubmitting(true);
      const success = await onImport(parsed);
      if (success) {
        onClose();
      }
    } catch (err: any) {
      setError(err.message || 'Invalid JSON format');
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
      background: 'rgba(0, 0, 0, 0.75)',
      backdropFilter: 'blur(8px)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 100,
      padding: 20,
    }}>
      <div style={{
        background: '#0d131f',
        border: '1px solid var(--border-light)',
        borderRadius: 'var(--radius-lg)',
        width: '100%',
        maxWidth: 580,
        boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.7)',
        overflow: 'hidden',
      }}>
        {/* Modal Header */}
        <div style={{
          padding: '16px 20px',
          borderBottom: '1px solid var(--border-subtle)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <UploadCloud size={20} color="var(--airtel-red)" />
            <h3 style={{ fontSize: '1.05rem', fontWeight: 700, color: '#fff' }}>
              Import Airtel Campaign Leads
            </h3>
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
            }}
          >
            <X size={20} />
          </button>
        </div>

        {/* Modal Body */}
        <form onSubmit={handleSubmit} style={{ padding: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <label style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', fontWeight: 600 }}>
              Lead Records (JSON Array):
            </label>
            <button
              type="button"
              onClick={handleSampleLoad}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--accent-blue)',
                fontSize: '0.78rem',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 4,
              }}
            >
              <FileText size={12} />
              Load Sample Format
            </button>
          </div>

          <textarea
            rows={10}
            value={jsonInput}
            onChange={(e) => setJsonInput(e.target.value)}
            placeholder="Paste JSON array containing: name, phone, account_no, subs_del_no, address..."
            style={{
              width: '100%',
              padding: '12px',
              borderRadius: 'var(--radius-md)',
              background: 'rgba(15, 23, 42, 0.9)',
              border: '1px solid var(--border-light)',
              color: '#34d399',
              fontFamily: 'monospace',
              fontSize: '0.82rem',
              outline: 'none',
              resize: 'vertical',
            }}
          />

          {error && (
            <div style={{ marginTop: 10, color: '#f87171', fontSize: '0.8rem' }}>
              {error}
            </div>
          )}

          {/* Modal Actions */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
            <button
              type="button"
              onClick={onClose}
              style={{
                padding: '8px 16px',
                borderRadius: 'var(--radius-sm)',
                background: 'rgba(255, 255, 255, 0.08)',
                color: 'var(--text-secondary)',
                border: '1px solid var(--border-subtle)',
                fontSize: '0.85rem',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting || !jsonInput.trim()}
              style={{
                padding: '8px 18px',
                borderRadius: 'var(--radius-sm)',
                background: 'linear-gradient(135deg, var(--airtel-red) 0%, var(--airtel-red-dark) 100%)',
                color: '#fff',
                border: 'none',
                fontSize: '0.85rem',
                fontWeight: 700,
                cursor: isSubmitting ? 'not-allowed' : 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <CheckCircle2 size={16} />
              {isSubmitting ? 'Importing...' : 'Upload & Save Leads'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
