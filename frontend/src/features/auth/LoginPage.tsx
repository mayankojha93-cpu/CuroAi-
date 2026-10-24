import React, { useState } from 'react';
import { PhoneCall, Lock, Mail, Eye, EyeOff, AlertCircle, RefreshCw } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';

interface LoginPageProps {
  onSuccess: () => void;
  onBackToHome?: () => void;
}

export const LoginPage: React.FC<LoginPageProps> = ({ onSuccess }) => {
  const { login, isAuthenticated } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
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
      background: 'radial-gradient(ellipse at 20% 20%, rgba(16, 185, 129, 0.12), transparent 50%), radial-gradient(ellipse at 80% 80%, rgba(200, 173, 126, 0.08), transparent 50%), #080C0A',
      position: 'relative',
      fontFamily: 'var(--font-sans)',
    }}>
      {/* Login Card */}
      <div style={{
        maxWidth: 420,
        width: '100%',
        padding: '38px 32px',
        borderRadius: 'var(--radius-xl)',
        background: 'rgba(16, 24, 20, 0.78)',
        border: '1px solid rgba(255, 255, 255, 0.1)',
        boxShadow: '0 24px 60px rgba(0, 0, 0, 0.7), 0 0 40px rgba(16, 185, 129, 0.08)',
        backdropFilter: 'blur(24px)',
        WebkitBackdropFilter: 'blur(24px)',
      }}>
        {/* Brand Header */}
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <div style={{
            width: 48,
            height: 48,
            borderRadius: 14,
            background: 'linear-gradient(135deg, rgba(16, 185, 129, 0.25) 0%, rgba(5, 150, 105, 0.4) 100%)',
            border: '1px solid rgba(16, 185, 129, 0.4)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 0 24px rgba(16, 185, 129, 0.25)',
            color: '#34D399',
            marginBottom: 16,
          }}>
            <PhoneCall size={22} />
          </div>

          <h1 style={{
            fontSize: '1.45rem',
            fontWeight: 700,
            color: '#fff',
            letterSpacing: '-0.02em',
            margin: '0 0 6px',
          }}>
            Welcome Back <span style={{ color: 'var(--curo-emerald)' }}>Curo AI</span>
          </h1>
          <p style={{ fontSize: '0.86rem', color: 'var(--text-secondary)', margin: 0 }}>
            Sign in to continue
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
            background: 'rgba(251, 113, 133, 0.12)',
            border: '1px solid rgba(251, 113, 133, 0.35)',
            color: '#FB7185',
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
              fontSize: '0.78rem',
              fontWeight: 600,
              color: 'var(--text-secondary)',
              marginBottom: 7,
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
            }}>
              Work Email
            </label>
            <div style={{ position: 'relative' }}>
              <Mail size={16} style={{
                position: 'absolute',
                left: 14,
                top: '50%',
                transform: 'translateY(-50%)',
                color: 'var(--text-muted)',
                pointerEvents: 'none',
              }} />
              <input
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@company.com"
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  padding: '12px 14px 12px 40px',
                  borderRadius: 'var(--radius-md)',
                  border: '1px solid rgba(255, 255, 255, 0.12)',
                  background: 'rgba(10, 15, 12, 0.8)',
                  color: '#fff',
                  fontSize: '0.9rem',
                  outline: 'none',
                  transition: 'border-color 0.2s ease, box-shadow 0.2s ease',
                }}
                onFocus={(e) => {
                  e.target.style.borderColor = 'var(--curo-emerald)';
                  e.target.style.boxShadow = '0 0 0 3px rgba(16, 185, 129, 0.15)';
                }}
                onBlur={(e) => {
                  e.target.style.borderColor = 'rgba(255, 255, 255, 0.12)';
                  e.target.style.boxShadow = 'none';
                }}
              />
            </div>
          </div>

          {/* Password field */}
          <div>
            <label style={{
              display: 'block',
              fontSize: '0.78rem',
              fontWeight: 600,
              color: 'var(--text-secondary)',
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
                color: 'var(--text-muted)',
                pointerEvents: 'none',
              }} />
              <input
                type={showPassword ? 'text' : 'password'}
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter your password"
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  padding: '12px 42px 12px 40px',
                  borderRadius: 'var(--radius-md)',
                  border: '1px solid rgba(255, 255, 255, 0.12)',
                  background: 'rgba(10, 15, 12, 0.8)',
                  color: '#fff',
                  fontSize: '0.9rem',
                  outline: 'none',
                  transition: 'border-color 0.2s ease, box-shadow 0.2s ease',
                }}
                onFocus={(e) => {
                  e.target.style.borderColor = 'var(--curo-emerald)';
                  e.target.style.boxShadow = '0 0 0 3px rgba(16, 185, 129, 0.15)';
                }}
                onBlur={(e) => {
                  e.target.style.borderColor = 'rgba(255, 255, 255, 0.12)';
                  e.target.style.boxShadow = 'none';
                }}
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
                  color: 'var(--text-muted)',
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
              padding: '13px',
              borderRadius: 'var(--radius-md)',
              background: 'linear-gradient(135deg, #10B981 0%, #059669 100%)',
              border: '1px solid rgba(16, 185, 129, 0.5)',
              color: '#fff',
              fontSize: '0.92rem',
              fontWeight: 700,
              cursor: submitting ? 'not-allowed' : 'pointer',
              boxShadow: '0 8px 24px rgba(16, 185, 129, 0.35)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              transition: 'transform 0.15s ease, box-shadow 0.15s ease',
            }}
            onMouseEnter={(e) => {
              if (!submitting) {
                e.currentTarget.style.boxShadow = '0 10px 30px rgba(16, 185, 129, 0.5)';
                e.currentTarget.style.transform = 'translateY(-1px)';
              }
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.boxShadow = '0 8px 24px rgba(16, 185, 129, 0.35)';
              e.currentTarget.style.transform = 'translateY(0)';
            }}
          >
            {submitting ? (
              <>
                <RefreshCw size={16} style={{ animation: 'spin 1s linear infinite' }} />
                Authenticating...
              </>
            ) : (
              'Login'
            )}
          </button>

          {/* Quick Demo Access Button */}
          <button
            type="button"
            onClick={() => {
              const demoUser = {
                id: 'admin-curo',
                name: 'CuroAI Admin',
                email: 'admin@curoai.in',
                role: 'Administrator',
              };
              localStorage.setItem('curo_auth_token', 'demo-curo-token-session');
              localStorage.setItem('curo_auth_user', JSON.stringify(demoUser));
              onSuccess();
            }}
            style={{
              width: '100%',
              padding: '11px',
              borderRadius: 'var(--radius-md)',
              background: 'rgba(56, 189, 248, 0.1)',
              border: '1px solid rgba(56, 189, 248, 0.3)',
              color: '#38BDF8',
              fontSize: '0.86rem',
              fontWeight: 600,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              transition: 'all 0.15s ease',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'rgba(56, 189, 248, 0.18)';
              e.currentTarget.style.borderColor = 'rgba(56, 189, 248, 0.5)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'rgba(56, 189, 248, 0.1)';
              e.currentTarget.style.borderColor = 'rgba(56, 189, 248, 0.3)';
            }}
          >
            Enter Dashboard (CuroAI Admin Demo)
          </button>
        </form>
      </div>
    </div>
  );
};
