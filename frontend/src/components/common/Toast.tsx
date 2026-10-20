import React from 'react';
import { CheckCircle2, AlertCircle, X } from 'lucide-react';

export interface ToastProps {
  message: string;
  type?: 'success' | 'error';
  onClose?: () => void;
}

export const Toast: React.FC<ToastProps> = ({ message, type = 'success', onClose }) => {
  const isSuccess = type === 'success';

  return (
    <div
      style={{
        position: 'fixed',
        bottom: '2rem',
        right: '2rem',
        zIndex: 9999,
        background: isSuccess ? '#064e3b' : '#7f1d1d',
        border: `1px solid ${isSuccess ? '#10b981' : '#ef4444'}`,
        color: '#ffffff',
        padding: '0.85rem 1.25rem',
        borderRadius: '12px',
        boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.5), 0 8px 10px -6px rgba(0, 0, 0, 0.5)',
        display: 'flex',
        alignItems: 'center',
        gap: '0.75rem',
        maxWidth: '420px',
        animation: 'slideIn 0.25s ease-out',
      }}
    >
      {isSuccess ? (
        <CheckCircle2 size={20} color="#34d399" style={{ flexShrink: 0 }} />
      ) : (
        <AlertCircle size={20} color="#f87171" style={{ flexShrink: 0 }} />
      )}
      <span style={{ fontSize: '0.9rem', fontWeight: 500, lineHeight: 1.4 }}>{message}</span>
      {onClose && (
        <button
          onClick={onClose}
          style={{
            background: 'none',
            border: 'none',
            color: 'rgba(255, 255, 255, 0.6)',
            cursor: 'pointer',
            padding: '2px',
            marginLeft: 'auto',
            display: 'flex',
            alignItems: 'center',
          }}
        >
          <X size={16} />
        </button>
      )}
    </div>
  );
};
