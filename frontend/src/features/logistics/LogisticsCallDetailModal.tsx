import React from 'react';
import { X, AlertTriangle, CheckCircle2 } from 'lucide-react';
import type { LogisticsCallRecord } from '../../types/logistics';

interface Props {
  call: LogisticsCallRecord | null;
  onClose: () => void;
}

export const LogisticsCallDetailModal: React.FC<Props> = ({ call, onClose }) => {
  if (!call) return null;

  const transcript = Array.isArray(call.transcript) ? call.transcript : [];

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(15, 23, 42, 0.72)', zIndex: 1000,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    }}>
      <div style={{
        background: 'var(--bg-card, #111827)', border: '1px solid var(--border-subtle, #1f2937)',
        borderRadius: 12, width: '100%', maxWidth: 780, maxHeight: '90vh', overflowY: 'auto', padding: 24,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 18 }}>
              {call.driver_name || 'Driver'} — {call.vehicle_number || ''} ({call.lr_number || ''})
            </h2>
            <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>
              Call ID: {call.id} · Status: {call.logistics_call_status || call.status} · Priority: {call.priority || 'normal'}
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer' }}>
            <X size={20} />
          </button>
        </div>

        {call.summary_in_english && (
          <div style={{
            padding: 12, borderRadius: 8, marginBottom: 16,
            background: call.escalate_to_human === 'yes' ? 'rgba(239,68,68,0.12)' : 'rgba(16,185,129,0.12)',
            border: `1px solid ${call.escalate_to_human === 'yes' ? 'rgba(239,68,68,0.35)' : 'rgba(16,185,129,0.35)'}`,
            display: 'flex', gap: 10, alignItems: 'flex-start',
          }}>
            {call.escalate_to_human === 'yes' ? <AlertTriangle size={18} color="#f87171" /> : <CheckCircle2 size={18} color="#34d399" />}
            <div style={{ fontSize: 13 }}>{call.summary_in_english}</div>
          </div>
        )}

        {call.recording_url && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Call Recording</div>
            <audio controls src={call.recording_url} style={{ width: '100%' }} />
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 18, fontSize: 13 }}>
          <div className="card" style={{ padding: 10 }}><strong>Unloaded:</strong> {call.unloaded || 'unknown'}</div>
          <div className="card" style={{ padding: 10 }}><strong>Location:</strong> {call.current_location || '-'}</div>
          <div className="card" style={{ padding: 10 }}><strong>Delay Reason:</strong> {call.unloading_delay_reason || 'none'}</div>
          <div className="card" style={{ padding: 10 }}><strong>Waiting Hours:</strong> {call.waiting_hours || '-'}</div>
          <div className="card" style={{ padding: 10 }}><strong>POD Signed:</strong> {call.pod_signed_received || 'na'}</div>
          <div className="card" style={{ padding: 10 }}><strong>Shortage/Damage:</strong> {call.shortage_or_damage_reported || 'no'}</div>
          <div className="card" style={{ padding: 10 }}><strong>Next Plan Given:</strong> {call.next_assignment_communicated || 'no'}</div>
          <div className="card" style={{ padding: 10 }}><strong>Accepted Next Plan:</strong> {call.driver_accepted_next_assignment || 'no'}</div>
          <div className="card" style={{ padding: 10 }}><strong>Departure ETA:</strong> {call.driver_departure_eta || '-'}</div>
          <div className="card" style={{ padding: 10 }}><strong>Money Demanded:</strong> {call.money_demanded_amount || '-'}</div>
          <div className="card" style={{ padding: 10 }}><strong>Callback Time:</strong> {call.callback_time || '-'}</div>
          <div className="card" style={{ padding: 10 }}><strong>Escalate to Ops:</strong> {call.escalate_to_human || 'no'}</div>
        </div>

        {(call.issue_details || call.driver_questions_for_ops) && (
          <div style={{ marginBottom: 18, fontSize: 13, display: 'grid', gap: 8 }}>
            {call.issue_details && (
              <div className="card" style={{ padding: 10 }}>
                <strong>Issue Details:</strong> {call.issue_details}
              </div>
            )}
            {call.driver_questions_for_ops && (
              <div className="card" style={{ padding: 10 }}>
                <strong>Driver Questions for Ops:</strong> {call.driver_questions_for_ops}
              </div>
            )}
          </div>
        )}

        <div>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Transcript</div>
          <div style={{
            maxHeight: 260, overflowY: 'auto', background: 'rgba(0,0,0,0.2)',
            borderRadius: 8, padding: 12, display: 'flex', flexDirection: 'column', gap: 8,
          }}>
            {transcript.length === 0 ? (
              <div style={{ opacity: 0.6, fontSize: 13 }}>No transcript recorded.</div>
            ) : (
              transcript.map((t, i) => (
                <div key={i} style={{ fontSize: 13 }}>
                  <strong style={{ color: t.role === 'assistant' ? '#60a5fa' : '#34d399' }}>
                    {t.role === 'assistant' ? 'Mittal AI' : 'Driver'}:
                  </strong>{' '}
                  {t.text}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
