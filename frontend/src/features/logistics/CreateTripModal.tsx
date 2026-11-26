import React, { useState } from 'react';
import { X, Truck, PhoneCall } from 'lucide-react';
import type { LogisticsTripInput } from '../../types/logistics';

interface CreateTripModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSaveTrip: (data: LogisticsTripInput, callImmediately: boolean) => Promise<void>;
}

export const CreateTripModal: React.FC<CreateTripModalProps> = ({ isOpen, onClose, onSaveTrip }) => {
  const [form, setForm] = useState<LogisticsTripInput>({
    driver_name: '',
    driver_phone: '',
    vehicle_number: '',
    lr_number: '',
    origin: 'Kota Plant',
    destination: '',
    consignee: '',
    material: 'Pigment powder bags / drums',
    expected_unload_date: new Date().toISOString().slice(0, 10),
    current_call_round: 1,
    next_assignment: '',
    plant_contact_number: '',
    ops_number: '9800011122',
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleSubmit = async (callNow: boolean) => {
    setError(null);
    if (!form.driver_name.trim() || !form.driver_phone.trim() || !form.vehicle_number.trim() || !form.lr_number.trim()) {
      setError('Driver name, phone, vehicle number, and LR number are required.');
      return;
    }
    setSubmitting(true);
    try {
      await onSaveTrip(form, callNow);
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to save trip');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(15, 23, 42, 0.72)', zIndex: 1000,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    }}>
      <div style={{
        background: 'var(--bg-card, #111827)', border: '1px solid var(--border-subtle, #1f2937)',
        borderRadius: 12, width: '100%', maxWidth: 640, maxHeight: '90vh', overflowY: 'auto', padding: 24,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Truck size={20} />
            <h2 style={{ margin: 0, fontSize: 18 }}>New Trip / Driver Status Call</h2>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer' }}>
            <X size={20} />
          </button>
        </div>

        {error && (
          <div style={{ background: 'rgba(239,68,68,0.15)', color: '#fca5a5', padding: '10px 12px', borderRadius: 8, marginBottom: 14, fontSize: 13 }}>
            {error}
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <label style={{ fontSize: 13 }}>
            Driver Name *
            <input className="input" value={form.driver_name} onChange={(e) => setForm({ ...form, driver_name: e.target.value })} placeholder="e.g. Ramesh" />
          </label>
          <label style={{ fontSize: 13 }}>
            Driver Phone *
            <input className="input" value={form.driver_phone} onChange={(e) => setForm({ ...form, driver_phone: e.target.value })} placeholder="+919811122233" />
          </label>
          <label style={{ fontSize: 13 }}>
            Vehicle Number *
            <input className="input" value={form.vehicle_number} onChange={(e) => setForm({ ...form, vehicle_number: e.target.value })} placeholder="RJ14GA4521" />
          </label>
          <label style={{ fontSize: 13 }}>
            LR / Trip Number *
            <input className="input" value={form.lr_number} onChange={(e) => setForm({ ...form, lr_number: e.target.value })} placeholder="LR-88421" />
          </label>
          <label style={{ fontSize: 13 }}>
            Loaded From (Origin)
            <input className="input" value={form.origin} onChange={(e) => setForm({ ...form, origin: e.target.value })} />
          </label>
          <label style={{ fontSize: 13 }}>
            Delivery Destination
            <input className="input" value={form.destination} onChange={(e) => setForm({ ...form, destination: e.target.value })} placeholder="Ahmedabad" />
          </label>
          <label style={{ fontSize: 13 }}>
            Consignee (Party)
            <input className="input" value={form.consignee} onChange={(e) => setForm({ ...form, consignee: e.target.value })} placeholder="Shreeji Chemicals" />
          </label>
          <label style={{ fontSize: 13 }}>
            Material
            <input className="input" value={form.material} onChange={(e) => setForm({ ...form, material: e.target.value })} />
          </label>
          <label style={{ fontSize: 13 }}>
            Expected Unload Date
            <input className="input" type="date" value={form.expected_unload_date} onChange={(e) => setForm({ ...form, expected_unload_date: e.target.value })} />
          </label>
          <label style={{ fontSize: 13 }}>
            Call Round Today
            <select className="input" value={form.current_call_round} onChange={(e) => setForm({ ...form, current_call_round: Number(e.target.value) })}>
              <option value={1}>Round 1 (Morning)</option>
              <option value={2}>Round 2 (Evening)</option>
            </select>
          </label>
          <label style={{ fontSize: 13 }}>
            Plant Contact Number
            <input className="input" value={form.plant_contact_number} onChange={(e) => setForm({ ...form, plant_contact_number: e.target.value })} placeholder="9811100022" />
          </label>
          <label style={{ fontSize: 13 }}>
            Ops Callback Number
            <input className="input" value={form.ops_number} onChange={(e) => setForm({ ...form, ops_number: e.target.value })} />
          </label>
        </div>

        <label style={{ display: 'block', fontSize: 13, marginTop: 12 }}>
          Next Assignment (if unloaded)
          <textarea
            className="input"
            rows={3}
            value={form.next_assignment}
            onChange={(e) => setForm({ ...form, next_assignment: e.target.value })}
            placeholder="Jammu ke manufacturing plant (Mittal Pigments, Bari Brahmana industrial area) se agla maal uthana hai..."
          />
        </label>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 18 }}>
          <button className="btn btn-secondary" onClick={onClose} disabled={submitting}>Cancel</button>
          <button className="btn btn-secondary" onClick={() => handleSubmit(false)} disabled={submitting}>
            Save Trip Only
          </button>
          <button className="btn btn-primary" onClick={() => handleSubmit(true)} disabled={submitting} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <PhoneCall size={15} />
            {submitting ? 'Dialing...' : 'Save & Call Driver'}
          </button>
        </div>
      </div>
    </div>
  );
};
