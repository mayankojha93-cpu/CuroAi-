import React, { useState } from 'react';
import { PhoneCall, Lock, Mail, Eye, EyeOff, ArrowLeft, AlertCircle, RefreshCw } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';

interface LoginPageProps {
  onSuccess: () => void;
  onBackToHome: () => void;
}

export const LoginPage: React.FC<LoginPageProps> = ({ onSuccess, onBackToHome }) => {
  const { login, isAuthenticated } = useAuth();
  const [email, setEmail] = useState('admin@curoai.in');
  const [password, setPassword] = useState('admin12345');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Auto-route to dashboard when authenticated
  React.useEffect(() => {
    if (isAuthenticated) {
      onSuccess();
    }
  }, [isAuthenticated, onSuccess]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    const result = await login(email, password);
    setSubmitting(false);

    if (result.success) {
      onSuccess();
    } else {
      setError(result.error || 'Invalid credentials');
    }
  };

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '24px',
      background: 'radial-gradient(ellipse at 80% 20%, rgba(228, 0, 0, 0.12), transparent 50%), radial-gradient(ellipse at 20% 80%, rgba(49, 93, 75, 0.15), transparent 50%), #0a0e17',
      position: 'relative',
    }}>
      {/* Top back button */}
      <button
        type="button"
        onClick={onBackToHome}
        style={{
          position: 'absolute',
          top: 28,
          left: 28,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          background: 'rgba(255, 255, 255, 0.06)',
          border: '1px solid rgba(255, 255, 255, 0.12)',
          color: '#B7C4BB',
          padding: '10px 18px',
          borderRadius: 99,
          fontSize: '0.86rem',
          cursor: 'pointer',
          transition: 'all 0.2s ease',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.color = '#fff';
          e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.3)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = '#B7C4BB';
          e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.12)';
        }}
      >
        <ArrowLeft size={16} />
        Back to Website
      </button>

      {/* Login Card */}
      <div style={{
        maxWidth: 440,
        width: '100%',
        padding: '38px 34px',
        borderRadius: 24,
        background: 'rgba(18, 24, 38, 0.82)',
        border: '1px solid rgba(255, 255, 255, 0.12)',
        boxShadow: '0 24px 60px rgba(0, 0, 0, 0.6), 0 0 40px rgba(228, 0, 0, 0.1)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
      }}>
        {/* Brand Header */}
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <div style={{
            width: 52,
            height: 52,
            borderRadius: 16,
            background: 'linear-gradient(135deg, #e40000 0%, #8b0000 100%)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 0 24px rgba(228, 0, 0, 0.45)',
            color: '#fff',
            marginBottom: 16,
          }}>
            <PhoneCall size={26} />
          </div>

          <h2 style={{
            fontSize: '1.45rem',
            fontWeight: 800,
            color: '#fff',
            letterSpacing: '-0.02em',
            margin: '0 0 6px',
            fontFamily: 'var(--font-sans)',
          }}>
            Operations Console Login
          </h2>
          <p style={{ fontSize: '0.84rem', color: '#8FA195', margin: 0 }}>
            Airtel Voice AI &bull; Outbound Campaign Engine
          </p>
        </div>

        {/* Error Banner */}
        {error && (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '12px 14px',
            borderRadius: 12,
            background: 'rgba(244, 63, 94, 0.12)',
            border: '1px solid rgba(244, 63, 94, 0.35)',
            color: '#fda4af',
            fontSize: '0.84rem',
            marginBottom: 20,
          }}>
            <AlertCircle size={16} style={{ flexShrink: 0 }} />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} style={{ display: 'grid', gap: 18 }}>
          {/* Email field */}
          <div>
            <label style={{
              display: 'block',
              fontSize: '0.8rem',
              fontWeight: 600,
              color: '#B7C4BB',
              marginBottom: 7,
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
            }}>
              Operator Email
            </label>
            <div style={{ position: 'relative' }}>
              <Mail size={16} style={{
                position: 'absolute',
                left: 14,
                top: '50%',
                transform: 'translateY(-50%)',
                color: '#64748b',
                pointerEvents: 'none',
              }} />
              <input
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="admin@curoai.in"
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  padding: '13px 14px 13px 40px',
                  borderRadius: 12,
                  border: '1px solid rgba(255, 255, 255, 0.16)',
                  background: 'rgba(10, 14, 23, 0.7)',
                  color: '#fff',
                  fontSize: '0.92rem',
                  outline: 'none',
                  transition: 'border-color 0.2s ease',
                }}
                onFocus={(e) => (e.target.style.borderColor = 'var(--airtel-red)')}
                onBlur={(e) => (e.target.style.borderColor = 'rgba(255, 255, 255, 0.16)')}
              />
            </div>
          </div>

          {/* Password field */}
          <div>
            <label style={{
              display: 'block',
              fontSize: '0.8rem',
              fontWeight: 600,
              color: '#B7C4BB',
              marginBottom: 7,
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
            }}>
              Password
            </label>
            <div style={{ position: 'relative' }}>
              <Lock size={16} style={{
                position: 'absolute',
                left: 14,
                top: '50%',
                transform: 'translateY(-50%)',
                color: '#64748b',
                pointerEvents: 'none',
              }} />
              <input
                type={showPassword ? 'text' : 'password'}
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  padding: '13px 44px 13px 40px',
                  borderRadius: 12,
                  border: '1px solid rgba(255, 255, 255, 0.16)',
                  background: 'rgba(10, 14, 23, 0.7)',
                  color: '#fff',
                  fontSize: '0.92rem',
                  outline: 'none',
                  transition: 'border-color 0.2s ease',
                }}
                onFocus={(e) => (e.target.style.borderColor = 'var(--airtel-red)')}
                onBlur={(e) => (e.target.style.borderColor = 'rgba(255, 255, 255, 0.16)')}
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                style={{
                  position: 'absolute',
                  right: 12,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  background: 'none',
                  border: 'none',
                  color: '#64748b',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  padding: 4,
                }}
                title={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>

          {/* Submit button */}
          <button
            type="submit"
            disabled={submitting}
            style={{
              marginTop: 10,
              width: '100%',
              padding: '14px',
              borderRadius: 12,
              background: 'linear-gradient(135deg, #e40000 0%, #a00000 100%)',
              border: 'none',
              color: '#fff',
              fontSize: '0.94rem',
              fontWeight: 700,
              cursor: submitting ? 'not-allowed' : 'pointer',
              boxShadow: '0 8px 24px rgba(228, 0, 0, 0.4)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              transition: 'transform 0.15s ease, box-shadow 0.15s ease',
            }}
          >
            {submitting ? (
              <>
                <RefreshCw size={16} style={{ animation: 'spin 1s linear infinite' }} />
                Authenticating...
              </>
            ) : (
              'Sign In to Console'
            )}
          </button>
        </form>

        {/* Demo Hint */}
        <div style={{
          marginTop: 24,
          padding: '12px 14px',
          borderRadius: 12,
          background: 'rgba(255, 255, 255, 0.04)',
          border: '1px solid rgba(255, 255, 255, 0.08)',
          fontSize: '0.78rem',
          color: '#94a3b8',
          textAlign: 'center',
        }}>
          <span style={{ color: 'var(--accent-amber)', fontWeight: 600 }}>Default Admin: </span>
          <code>admin@curoai.in</code> / <code>admin12345</code>
        </div>
      </div>
    </div>
  );
};
