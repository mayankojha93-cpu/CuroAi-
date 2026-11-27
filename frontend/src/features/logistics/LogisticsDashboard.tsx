import React, { useEffect, useState } from 'react';
import { Truck, PhoneCall, AlertTriangle, CheckCircle2, Clock, Plus, RefreshCw, LogOut } from 'lucide-react';
import type { AuthUser } from '../../types';
import type {
  LogisticsCallRecord,
  LogisticsEscalation,
  LogisticsSummary,
  LogisticsTrip,
  LogisticsTripInput,
} from '../../types/logistics';
import {
  createLogisticsTrip,
  fetchLogisticsCalls,
  fetchLogisticsEscalations,
  fetchLogisticsSummary,
  fetchLogisticsTrips,
  initiateLogisticsCall,
  initiateLogisticsTestCall,
} from '../../services/logistics.service';
import { CreateTripModal } from './CreateTripModal';
import { LogisticsCallDetailModal } from './LogisticsCallDetailModal';

interface LogisticsDashboardProps {
  user: AuthUser | null;
  onLogout: () => void;
}

type LogisticsTab = 'TRIPS' | 'CALLS' | 'ESCALATIONS';

export const LogisticsDashboard: React.FC<LogisticsDashboardProps> = ({ user, onLogout }) => {
  const [activeTab, setActiveTab] = useState<LogisticsTab>('TRIPS');
  const [summary, setSummary] = useState<LogisticsSummary | null>(null);
  const [trips, setTrips] = useState<LogisticsTrip[]>([]);
  const [calls, setCalls] = useState<LogisticsCallRecord[]>([]);
  const [escalations, setEscalations] = useState<LogisticsEscalation[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialingTripId, setDialingTripId] = useState<string | null>(null);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [selectedCall, setSelectedCall] = useState<LogisticsCallRecord | null>(null);
  const [bannerMsg, setBannerMsg] = useState<string | null>(null);
  const [ttsProvider, setTtsProvider] = useState<string>('sarvam');

  const loadData = async () => {
    setLoading(true);
    try {
      const [sumRes, tripsRes, callsRes, escRes] = await Promise.all([
        fetchLogisticsSummary(),
        fetchLogisticsTrips(),
        fetchLogisticsCalls(),
        fetchLogisticsEscalations(),
      ]);
      setSummary(sumRes);
      setTrips(tripsRes);
      setCalls(callsRes);
      setEscalations(escRes);
    } catch (err: any) {
      setBannerMsg(err.message || 'Failed to load logistics data');
    } finally {
      setLoading(false);
    }
  };

  const isLogisticsUser = user?.assigned_pipeline === 'logistics';

  useEffect(() => {
    if (!isLogisticsUser) return;
    loadData();
    const timer = setInterval(loadData, 15000);
    return () => clearInterval(timer);
  }, [isLogisticsUser]);

  if (!isLogisticsUser) {
    return (
      <div className="min-h-screen bg-[#080C0A] text-white flex flex-col items-center justify-center p-6 text-center">
        <AlertTriangle className="w-10 h-10 text-rose-400 mb-3" />
        <h2 className="text-lg font-semibold mb-1">Access Denied</h2>
        <p className="text-sm text-gray-400 mb-5">
          Only authorized Mittal Pigments Logistics accounts can access this dashboard.
        </p>
        <button
          onClick={onLogout}
          className="px-4 py-2 rounded-lg bg-white/10 hover:bg-white/15 text-sm font-medium border border-white/10"
        >
          Sign Out
        </button>
      </div>
    );
  }

  const handleSaveTrip = async (data: LogisticsTripInput, callImmediately: boolean) => {
    if (callImmediately) {
      await initiateLogisticsTestCall(data);
      setBannerMsg(`Calling ${data.driver_name} (${data.vehicle_number})...`);
    } else {
      await createLogisticsTrip(data);
      setBannerMsg(`Trip ${data.vehicle_number} (${data.lr_number}) saved.`);
    }
    await loadData();
  };

  const handleCallTrip = async (tripId: string, round: number) => {
    setDialingTripId(tripId);
    try {
      await initiateLogisticsCall(tripId, round, ttsProvider);
      setBannerMsg(`Round ${round} call initiated (${ttsProvider}).`);
      await loadData();
    } catch (err: any) {
      setBannerMsg(err.message || 'Failed to initiate call');
    } finally {
      setDialingTripId(null);
    }
  };

  const priorityBadge = (priority?: string | null) => {
    if (priority === 'urgent') {
      return <span style={{ padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 700, background: 'rgba(239,68,68,0.2)', color: '#f87171' }}>URGENT</span>;
    }
    if (priority === 'high') {
      return <span style={{ padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 700, background: 'rgba(245,158,11,0.2)', color: '#fbbf24' }}>HIGH</span>;
    }
    return <span style={{ padding: '2px 8px', borderRadius: 999, fontSize: 11, background: 'rgba(148,163,184,0.15)', color: '#cbd5e1' }}>NORMAL</span>;
  };

  return (
    <div style={{ minHeight: '100vh', padding: '24px 32px', maxWidth: 1400, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24, flexWrap: 'wrap', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 40, height: 40, borderRadius: 10, background: 'rgba(59,130,246,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Truck size={22} color="#60a5fa" />
          </div>
          <div>
            <h1 style={{ margin: 0, fontSize: 22 }}>Mittal Pigments — Logistics Ops Assistant</h1>
            <div style={{ fontSize: 13, opacity: 0.7 }}>
              Signed in as {user?.name || user?.email} · Driver Trip & Unloading Status Console
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <select
            className="input"
            value={ttsProvider}
            onChange={(e) => setTtsProvider(e.target.value)}
            title="Select TTS Provider for driver calls"
            style={{ width: 'auto', minWidth: 165 }}
          >
            <option value="sarvam">TTS: Sarvam AI (Default)</option>
            <option value="elevenlabs">TTS: ElevenLabs</option>
            <option value="smallest">TTS: Smallest AI</option>
            <option value="soniox">TTS: Soniox</option>
            <option value="indic_tiny">TTS: Indic Tiny TTS</option>
          </select>
          <button className="btn btn-secondary" onClick={loadData} disabled={loading} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <RefreshCw size={15} /> Refresh
          </button>
          <button className="btn btn-primary" onClick={() => setIsCreateModalOpen(true)} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Plus size={15} /> New Trip / Call Driver
          </button>
          <button className="btn btn-secondary" onClick={onLogout} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <LogOut size={15} /> Logout
          </button>
        </div>
      </div>

      {bannerMsg && (
        <div style={{
          padding: '10px 14px', borderRadius: 8, marginBottom: 16,
          background: 'rgba(59,130,246,0.14)', border: '1px solid rgba(59,130,246,0.35)',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13,
        }}>
          <span>{bannerMsg}</span>
          <button onClick={() => setBannerMsg(null)} style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer' }}>✕</button>
        </div>
      )}

      {/* Summary Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 14, marginBottom: 24 }}>
        <div className="card" style={{ padding: 16 }}>
          <div style={{ fontSize: 12, opacity: 0.7 }}>Total Active Trips</div>
          <div style={{ fontSize: 28, fontWeight: 700, marginTop: 4 }}>{summary?.total_trips ?? 0}</div>
        </div>
        <div className="card" style={{ padding: 16 }}>
          <div style={{ fontSize: 12, opacity: 0.7, display: 'flex', alignItems: 'center', gap: 6 }}>
            <CheckCircle2 size={14} color="#34d399" /> Unloaded
          </div>
          <div style={{ fontSize: 28, fontWeight: 700, marginTop: 4, color: '#34d399' }}>{summary?.unloaded_count ?? 0}</div>
        </div>
        <div className="card" style={{ padding: 16 }}>
          <div style={{ fontSize: 12, opacity: 0.7, display: 'flex', alignItems: 'center', gap: 6 }}>
            <Clock size={14} color="#fbbf24" /> Waiting / In Transit
          </div>
          <div style={{ fontSize: 28, fontWeight: 700, marginTop: 4, color: '#fbbf24' }}>{summary?.in_progress_count ?? 0}</div>
        </div>
        <div className="card" style={{ padding: 16 }}>
          <div style={{ fontSize: 12, opacity: 0.7, display: 'flex', alignItems: 'center', gap: 6 }}>
            <AlertTriangle size={14} color="#f87171" /> Escalations (Urgent/High)
          </div>
          <div style={{ fontSize: 28, fontWeight: 700, marginTop: 4, color: '#f87171' }}>{summary?.escalated_count ?? 0}</div>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 8, borderBottom: '1px solid var(--border-subtle, #1f2937)', marginBottom: 20, paddingBottom: 8 }}>
        <button className={`btn ${activeTab === 'TRIPS' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setActiveTab('TRIPS')}>
          Trips & Dispatch ({trips.length})
        </button>
        <button className={`btn ${activeTab === 'CALLS' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setActiveTab('CALLS')}>
          Call Logs & Transcripts ({calls.length})
        </button>
        <button className={`btn ${activeTab === 'ESCALATIONS' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setActiveTab('ESCALATIONS')}>
          Ops Escalations ({escalations.length})
        </button>
      </div>

      {/* Trips Table */}
      {activeTab === 'TRIPS' && (
        <div className="card" style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border-subtle, #1f2937)', opacity: 0.75 }}>
                <th style={{ padding: 12 }}>Driver</th>
                <th style={{ padding: 12 }}>Vehicle / LR</th>
                <th style={{ padding: 12 }}>Route & Party</th>
                <th style={{ padding: 12 }}>Status</th>
                <th style={{ padding: 12 }}>Priority</th>
                <th style={{ padding: 12 }}>Last Summary</th>
                <th style={{ padding: 12 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {trips.map((t) => (
                <tr key={t.id} style={{ borderBottom: '1px solid var(--border-subtle, #1f2937)' }}>
                  <td style={{ padding: 12 }}>
                    <div style={{ fontWeight: 600 }}>{t.driver_name}</div>
                    <div style={{ fontSize: 12, opacity: 0.7 }}>{t.driver_phone}</div>
                  </td>
                  <td style={{ padding: 12 }}>
                    <div style={{ fontWeight: 600 }}>{t.vehicle_number}</div>
                    <div style={{ fontSize: 12, opacity: 0.7 }}>{t.lr_number}</div>
                  </td>
                  <td style={{ padding: 12 }}>
                    <div>{t.origin || '-'} → {t.destination || '-'}</div>
                    <div style={{ fontSize: 12, opacity: 0.7 }}>{t.consignee || '-'}</div>
                  </td>
                  <td style={{ padding: 12 }}>
                    <span style={{ fontWeight: 600 }}>{t.trip_status}</span>
                    {t.last_departure_eta && <div style={{ fontSize: 11, opacity: 0.7 }}>ETA: {t.last_departure_eta}</div>}
                  </td>
                  <td style={{ padding: 12 }}>{priorityBadge(t.last_priority)}</td>
                  <td style={{ padding: 12, maxWidth: 260 }}>
                    <div style={{ fontSize: 12, opacity: 0.85 }}>{t.last_summary || 'Not called yet'}</div>
                  </td>
                  <td style={{ padding: 12 }}>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button
                        className="btn btn-primary"
                        style={{ padding: '6px 10px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}
                        disabled={dialingTripId === t.id}
                        onClick={() => handleCallTrip(t.id, 1)}
                      >
                        <PhoneCall size={13} /> R1
                      </button>
                      <button
                        className="btn btn-secondary"
                        style={{ padding: '6px 10px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}
                        disabled={dialingTripId === t.id}
                        onClick={() => handleCallTrip(t.id, 2)}
                      >
                        <PhoneCall size={13} /> R2
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {trips.length === 0 && (
                <tr><td colSpan={7} style={{ padding: 24, textAlign: 'center', opacity: 0.6 }}>No trips found. Click "New Trip / Call Driver" to add one.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Calls Table */}
      {activeTab === 'CALLS' && (
        <div className="card" style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border-subtle, #1f2937)', opacity: 0.75 }}>
                <th style={{ padding: 12 }}>Driver / Vehicle</th>
                <th style={{ padding: 12 }}>Call Status</th>
                <th style={{ padding: 12 }}>Unloaded</th>
                <th style={{ padding: 12 }}>Delay Reason</th>
                <th style={{ padding: 12 }}>Priority</th>
                <th style={{ padding: 12 }}>Summary</th>
                <th style={{ padding: 12 }}>Details</th>
              </tr>
            </thead>
            <tbody>
              {calls.map((c) => (
                <tr key={c.id} style={{ borderBottom: '1px solid var(--border-subtle, #1f2937)' }}>
                  <td style={{ padding: 12 }}>
                    <div style={{ fontWeight: 600 }}>{c.driver_name || 'Driver'}</div>
                    <div style={{ fontSize: 12, opacity: 0.7 }}>{c.vehicle_number} · {c.lr_number}</div>
                  </td>
                  <td style={{ padding: 12 }}>{c.logistics_call_status || c.status}</td>
                  <td style={{ padding: 12 }}>{c.unloaded || 'unknown'}</td>
                  <td style={{ padding: 12 }}>{c.unloading_delay_reason || 'none'}</td>
                  <td style={{ padding: 12 }}>{priorityBadge(c.priority)}</td>
                  <td style={{ padding: 12, maxWidth: 280 }}>{c.summary_in_english || c.final_disposition || '-'}</td>
                  <td style={{ padding: 12 }}>
                    <button className="btn btn-secondary" style={{ padding: '5px 10px', fontSize: 12 }} onClick={() => setSelectedCall(c)}>
                      View JSON & Transcript
                    </button>
                  </td>
                </tr>
              ))}
              {calls.length === 0 && (
                <tr><td colSpan={7} style={{ padding: 24, textAlign: 'center', opacity: 0.6 }}>No logistics calls recorded yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Escalations Table */}
      {activeTab === 'ESCALATIONS' && (
        <div className="card" style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border-subtle, #1f2937)', opacity: 0.75 }}>
                <th style={{ padding: 12 }}>Priority</th>
                <th style={{ padding: 12 }}>Driver / Vehicle</th>
                <th style={{ padding: 12 }}>Issue / Breakdown / Shortage</th>
                <th style={{ padding: 12 }}>Money Demanded</th>
                <th style={{ padding: 12 }}>Driver Questions for Ops</th>
                <th style={{ padding: 12 }}>Summary</th>
              </tr>
            </thead>
            <tbody>
              {escalations.map((e) => (
                <tr key={e.id} style={{ borderBottom: '1px solid var(--border-subtle, #1f2937)' }}>
                  <td style={{ padding: 12 }}>{priorityBadge(e.priority)}</td>
                  <td style={{ padding: 12 }}>
                    <div style={{ fontWeight: 600 }}>{e.driver_name} ({e.driver_phone})</div>
                    <div style={{ fontSize: 12, opacity: 0.7 }}>{e.vehicle_number} · {e.lr_number}</div>
                  </td>
                  <td style={{ padding: 12 }}>{e.issue_details || '-'}</td>
                  <td style={{ padding: 12 }}>{e.money_demanded_amount || '-'}</td>
                  <td style={{ padding: 12 }}>{e.driver_questions_for_ops || '-'}</td>
                  <td style={{ padding: 12, maxWidth: 260 }}>{e.summary_in_english || '-'}</td>
                </tr>
              ))}
              {escalations.length === 0 && (
                <tr><td colSpan={6} style={{ padding: 24, textAlign: 'center', opacity: 0.6 }}>No active escalations.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <CreateTripModal
        isOpen={isCreateModalOpen}
        onClose={() => setIsCreateModalOpen(false)}
        onSaveTrip={handleSaveTrip}
      />

      <LogisticsCallDetailModal
        call={selectedCall}
        onClose={() => setSelectedCall(null)}
      />
    </div>
  );
};
