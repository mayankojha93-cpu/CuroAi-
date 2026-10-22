import React, { useState } from 'react';
import { Search } from 'lucide-react';

interface Scenario {
  sNo: number;
  disposition: string;
  scenario: string;
  action: string;
  category: 'READY_PICKUP' | 'WILL_NOT_RETURN' | 'OTHER' | 'UNCONNECTED';
}

const SCENARIOS: Scenario[] = [
  {
    sNo: 1,
    disposition: 'DAMAGED_DEVICE',
    scenario: 'Customer confirms device is completely damaged',
    action: 'Do not arrange pickup. Update disposition as "Damaged - No Pickup Required" and close the case.',
    category: 'WILL_NOT_RETURN',
  },
  {
    sNo: 2,
    disposition: 'LOST_DEVICE',
    scenario: 'Customer confirms device is lost / not available',
    action: 'Do not arrange pickup. Update disposition as "Lost - No Pickup Required" and close the case.',
    category: 'WILL_NOT_RETURN',
  },
  {
    sNo: 3,
    disposition: 'REFUND_OR_OWNERSHIP_QUERY',
    scenario: 'Customer refuses to return device and asks for refund',
    action: 'Explain that the device is Airtel\'s intellectual property and subscription charges do not constitute ownership. Do not argue. Record refusal remarks and close the call.',
    category: 'WILL_NOT_RETURN',
  },
  {
    sNo: 4,
    disposition: 'CONFIRMED_FOR_PICKUP / SCHEDULE_CALLBACK',
    scenario: 'Customer is temporarily unavailable at registered address',
    action: 'Confirm whether device is available with customer at another location. If available elsewhere, capture alternate address/contact and arrange pickup. If no feasible location, schedule callback.',
    category: 'READY_PICKUP',
  },
  {
    sNo: 5,
    disposition: 'RECHARGED_DEVICE',
    scenario: 'Customer says the device has been recharged and therefore will not return it',
    action: 'Check when customer recharged the device. If recharge date is later than disconnection date, update "Recharged Device" disposition with remarks and close.',
    category: 'WILL_NOT_RETURN',
  },
  {
    sNo: 6,
    disposition: 'NEEDS_AIRTEL_SUPPORT',
    scenario: 'Customer wants to raise a complaint / inquiry outside approved FAQ',
    action: 'Say: "I\'m sorry, I don\'t want to give you incorrect information. Please contact Airtel at 121." Route to Airtel 121 and close the recovery call.',
    category: 'OTHER',
  },
  {
    sNo: 7,
    disposition: 'PICKUP_DECLINED',
    scenario: 'Customer believes device becomes free after 3–4 months',
    action: 'Explain that the device remains Airtel property and subscription duration does not transfer ownership. If customer continues to refuse, do not repeatedly argue. Record refusal and close.',
    category: 'WILL_NOT_RETURN',
  },
  {
    sNo: 8,
    disposition: 'SHIFTED_DEVICE_WITH_CUSTOMER',
    scenario: 'Customer has shifted but still has the device',
    action: 'Obtain complete new pickup address (house/flat number, street, city, pin code) and alternate contact. Read back to confirm and arrange pickup.',
    category: 'READY_PICKUP',
  },
  {
    sNo: 9,
    disposition: 'SHIFTED_DEVICE_WITH_RELATIVE',
    scenario: 'Device was left with a relative',
    action: 'Obtain relative\'s contact number and confirm device availability before scheduling pickup.',
    category: 'READY_PICKUP',
  },
  {
    sNo: 10,
    disposition: 'SHIFTED_DEVICE_LEFT_PREVIOUS',
    scenario: 'Customer shifted and left device at previous rented accommodation',
    action: 'Obtain current occupant/contact details. Do not arrange pickup without confirmed device availability.',
    category: 'READY_PICKUP',
  },
  {
    sNo: 11,
    disposition: 'NO_ANSWER',
    scenario: 'Customer does not answer the call',
    action: 'Retry as per calling logic using different time slot (3-hour cooldown). Do not mark final closure after first attempt.',
    category: 'UNCONNECTED',
  },
  {
    sNo: 12,
    disposition: 'DISCONNECTED',
    scenario: 'Customer disconnects mid-conversation',
    action: 'Keep captured data. Retry as per retry logic (3-hour cooldown).',
    category: 'UNCONNECTED',
  },
  {
    sNo: 13,
    disposition: 'VOICEMAIL / FAILED',
    scenario: 'Customer cannot be reached / Voicemail detected',
    action: 'Share no account details and hang up immediately. Queue for retry.',
    category: 'UNCONNECTED',
  },
  {
    sNo: 14,
    disposition: 'ALREADY_RETURNED',
    scenario: 'Customer confirms device has already been collected / returned',
    action: 'Obtain return date/reference if available. Update "Already Returned" disposition and close case without arguing.',
    category: 'WILL_NOT_RETURN',
  },
  {
    sNo: 15,
    disposition: 'DO_NOT_CALL',
    scenario: 'Customer is marked under DND or demands not to be called',
    action: 'Respect DND calling controls immediately. Update "Do Not Call" disposition and close.',
    category: 'OTHER',
  },
  {
    sNo: 16,
    disposition: 'WRONG_NUMBER_OR_IDENTITY_NOT_CONFIRMED',
    scenario: 'Customer says the number is incorrect / wrong person',
    action: 'Apologize politely, do not disclose account information, and end call cleanly.',
    category: 'OTHER',
  },
  {
    sNo: 17,
    disposition: 'ALREADY_USING_DEVICE',
    scenario: 'Customer says they are still actively using the device',
    action: 'Validate connection/service ID and disconnection status. Note active status for verification and close recovery call.',
    category: 'OTHER',
  },
];

export const SopReference: React.FC = () => {
  const [search, setSearch] = useState('');

  const filtered = SCENARIOS.filter(
    (s) =>
      s.disposition.toLowerCase().includes(search.toLowerCase()) ||
      s.scenario.toLowerCase().includes(search.toLowerCase()) ||
      s.action.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Search Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: 16,
      }}>
        <div>
          <h2 style={{ fontSize: '1.4rem', fontWeight: 800, color: '#fff' }}>
            Airtel & Beetel 17 Scenarios SOP & FAQ Guide
          </h2>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            Official customer objection rules and agent behavioral actions
          </p>
        </div>

        <div style={{ position: 'relative', width: 320 }}>
          <Search size={16} color="var(--text-muted)" style={{ position: 'absolute', left: 14, top: 12 }} />
          <input
            type="text"
            placeholder="Search scenarios or dispositions..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{
              width: '100%',
              padding: '9px 14px 9px 38px',
              borderRadius: 'var(--radius-md)',
              background: 'rgba(15, 23, 42, 0.8)',
              border: '1px solid var(--border-light)',
              color: '#fff',
              fontSize: '0.86rem',
              outline: 'none',
            }}
          />
        </div>
      </div>

      {/* Scenarios Grid */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))',
        gap: 16,
      }}>
        {filtered.map((s) => (
          <div
            key={s.sNo}
            className="glass-panel"
            style={{
              padding: 20,
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'space-between',
              gap: 14,
            }}
          >
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontSize: '0.74rem', color: 'var(--text-muted)', fontWeight: 700 }}>
                  SCENARIO #{s.sNo}
                </span>
                <span className="badge badge-red" style={{ fontSize: '0.7rem' }}>
                  {s.disposition}
                </span>
              </div>

              <h4 style={{ fontSize: '1rem', fontWeight: 700, color: '#fff', marginBottom: 8 }}>
                {s.scenario}
              </h4>

              <p style={{ fontSize: '0.84rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                {s.action}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
