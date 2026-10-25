import React, { useState, useEffect, useMemo, useRef } from 'react';
import { 
  ChevronLeft, 
  Download, 
  Users, 
  Phone, 
  Check, 
  X, 
  Clock, 
  Timer,
  Headphones,
  Search, 
  ChevronDown, 
  Upload,
  Play,
  Pause,
  Filter,
  CheckCircle2,
  AlertTriangle,
  RotateCcw
} from 'lucide-react';
import type { CampaignItem, CallRecord } from '../../types';
import { 
  fetchCampaignCalls, 
  startCampaignCalls, 
  uploadCampaignContacts, 
  fetchCampaignDispositions,
  updateCampaignStatus,
  fetchCampaignContacts,
  fetchCampaignReport,
  initiateCall,
  updateCampaignRetry,
  type CampaignContactRecord,
  type CampaignReportRow,
  type DispositionBreakdownItem 
} from '../../services';

const formatTalkTime = (totalSeconds?: number): string => {
  if (!totalSeconds || isNaN(totalSeconds) || totalSeconds <= 0) return '0:00';
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);

  const padSec = seconds < 10 ? `0${seconds}` : `${seconds}`;
  if (hours > 0) {
    const padMin = minutes < 10 ? `0${minutes}` : `${minutes}`;
    return `${hours}:${padMin}:${padSec}`;
  }
  return `${minutes}:${padSec}`;
};

const formatDispositionLabel = (key: string): string => {
  return key
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
};

const formatContactDuration = (seconds?: number): string => {
  if (!seconds || seconds <= 0) return '-';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s < 10 ? '0' : ''}${s}`;
};

const formatLastCalled = (isoString?: string): string => {
  if (!isoString) return '—';
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return isoString;
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const month = months[d.getMonth()];
    const day = d.getDate();
    let hours = d.getHours();
    const minutes = d.getMinutes();
    const ampm = hours >= 12 ? 'pm' : 'am';
    hours = hours % 12;
    hours = hours ? hours : 12;
    const minStr = minutes < 10 ? `0${minutes}` : `${minutes}`;
    return `${day} ${month}, ${hours < 10 ? '0' : ''}${hours}:${minStr} ${ampm}`;
  } catch {
    return isoString;
  }
};

const formatCleanPhone = (phone?: string): string => {
  if (!phone) return '—';
  const clean = phone.trim();
  const digits = clean.replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) {
    return digits.slice(2);
  }
  if (digits.length === 10) {
    return digits;
  }
  return clean;
};

export const CANONICAL_DISPOSITIONS = [
  'Confirmed For Pickup',
  'Willing To Pickup',
  'Schedule Callback',
  'Already Returned Device',
  'Refused To Return',
  'Willing To Recharge',
  'Already Recharged',
  'Wrong Number',
  'Language Barrier',
  'Do Not Call',
  'Abruptly Disconnected Call',
  'Voicemail or IVR Detected',
  'Not Connected (No Answer)',
  'Not Connected (Failed)',
] as const;

export const matchCanonicalDisposition = (
  rawInput?: string | null,
  durationSeconds?: number,
  callStatus?: string | null
): string => {
  const text = (rawInput || '').trim();
  const upper = text.toUpperCase().replace(/[-_]/g, ' ');
  const statusUpper = (callStatus || '').toUpperCase().replace(/[-_]/g, ' ');
  const duration = Number(durationSeconds) || 0;

  const exactMatch = CANONICAL_DISPOSITIONS.find(
    (c) => c.toLowerCase() === text.toLowerCase() || c.toUpperCase() === upper
  );
  if (exactMatch) return exactMatch;

  // 8. Wrong Number (Check early so 'IDENTITY NOT CONFIRMED' does not trigger 'CONFIRMED')
  if (
    upper.includes('WRONG NUMBER') ||
    upper.includes('WRONG PERSON') ||
    upper.includes('NOT CONFIRMED') ||
    upper.includes('IDENTITY NOT CONFIRMED') ||
    upper.includes('NOT SUBSCRIBER') ||
    upper.includes('INVALID NUMBER') ||
    upper.includes('NOT ME') ||
    upper.includes('DOES NOT BELONG')
  ) {
    return 'Wrong Number';
  }

  // 10. Do Not Call
  if (
    upper.includes('DO NOT CALL') ||
    upper.includes('DND') ||
    upper.includes('STOP CALLING') ||
    upper.includes('UNSUBSCRIBE') ||
    upper.includes('DONOTCALL') ||
    upper.includes('NEVER CALL')
  ) {
    return 'Do Not Call';
  }

  // 9. Language Barrier
  if (
    upper.includes('LANGUAGE BARRIER') ||
    upper.includes('LANGUAGE') ||
    upper.includes('BARRIER') ||
    upper.includes('NOT UNDERSTAND') ||
    upper.includes('SPEAK TAMIL') ||
    upper.includes('SPEAK TELUGU') ||
    upper.includes('SPEAK BENGALI') ||
    upper.includes('SPEAK MARATHI') ||
    upper.includes('SPEAK KANNADA') ||
    upper.includes('SPEAK MALAYALAM')
  ) {
    return 'Language Barrier';
  }

  // 12. Voicemail or IVR Detected
  if (
    upper.includes('VOICEMAIL') ||
    upper.includes('IVR') ||
    upper.includes('ANSWERING MACHINE') ||
    upper.includes('MACHINE DETECTED') ||
    upper.includes('CARRIER MESSAGE') ||
    upper.includes('AUTOMATED MESSAGE')
  ) {
    return 'Voicemail or IVR Detected';
  }

  // 4. Already Returned Device
  if (
    upper.includes('ALREADY RETURNED') ||
    upper.includes('ALREADY PICKED UP') ||
    upper.includes('DEVICE RETURNED') ||
    upper.includes('RETURNED DEVICE') ||
    upper.includes('HANDED OVER') ||
    upper.includes('DEPOSITED') ||
    upper.includes('ALREADY SUBMITTED')
  ) {
    return 'Already Returned Device';
  }

  // 6. Willing To Recharge
  if (
    upper.includes('WILLING TO RECHARGE') ||
    upper.includes('WILL RECHARGE') ||
    upper.includes('PROMISED RECHARGE') ||
    upper.includes('RECHARGE PROMISED') ||
    upper.includes('WILL PAY') ||
    upper.includes('PROMISE TO PAY')
  ) {
    return 'Willing To Recharge';
  }

  // 7. Already Recharged
  if (
    upper.includes('ALREADY RECHARGED') ||
    upper.includes('RECHARGED DEVICE') ||
    upper.includes('RECHARGED') ||
    upper.includes('ALREADY PAID') ||
    upper.includes('ACCOUNT ACTIVE') ||
    upper.includes('PAYMENT DONE') ||
    upper.includes('ALREADY USING') ||
    upper.includes('STILL USING')
  ) {
    return 'Already Recharged';
  }

  // 1. Confirmed For Pickup
  if (
    upper.includes('CONFIRMED FOR PICKUP') ||
    upper.includes('PICKUP CONFIRMED') ||
    upper.includes('CONFIRMED PICKUP') ||
    upper.includes('GOAL COMPLETED') ||
    upper.includes('PICKUP SCHEDULED') ||
    upper.includes('SCHEDULED PICKUP') ||
    upper.includes('CONFIRMED DATE') ||
    upper.includes('PICKUP ACCEPTED') ||
    (upper.includes('CONFIRMED') && !upper.includes('NOT CONFIRMED'))
  ) {
    return 'Confirmed For Pickup';
  }

  // 2. Willing To Pickup
  if (
    upper.includes('WILLING TO PICKUP') ||
    upper.includes('WILLING PICKUP') ||
    upper.includes('TENTATIVE PICKUP') ||
    upper.includes('WILLING TO RETURN') ||
    upper.includes('AGREED TO RETURN') ||
    upper.includes('WILL RETURN') ||
    upper.includes('RECORD WILLING NO DATE') ||
    upper.includes('WILLING NO DATE')
  ) {
    return 'Willing To Pickup';
  }

  // 5. Refused To Return
  if (
    upper.includes('REFUSED TO RETURN') ||
    upper.includes('PICKUP DECLINED') ||
    upper.includes('REFUSED') ||
    upper.includes('DECLINED') ||
    upper.includes('NOT GIVING') ||
    upper.includes('DENIED') ||
    upper.includes('DECLINED PICKUP') ||
    upper.includes('DAMAGED DEVICE') ||
    upper.includes('LOST DEVICE') ||
    upper.includes('REFUND OR OWNERSHIP')
  ) {
    return 'Refused To Return';
  }

  // 3. Schedule Callback
  if (
    upper.includes('SCHEDULE CALLBACK') ||
    upper.includes('CALLBACK REQUESTED') ||
    upper.includes('CALL LATER') ||
    upper.includes('CALLBACK') ||
    upper.includes('BUSY CALL LATER') ||
    upper.includes('SCHEDULED CALLBACK') ||
    upper.includes('CALL ME BACK') ||
    upper.includes('CALL AFTER') ||
    upper.includes('SHIFTED') ||
    upper.includes('NEEDS AIRTEL SUPPORT')
  ) {
    return 'Schedule Callback';
  }

  // 13. Not Connected (No Answer)
  if (
    upper.includes('NO ANSWER') ||
    upper.includes('NO_ANSWER') ||
    upper.includes('NOT CONNECTED NO ANSWER') ||
    upper.includes('NOT CONNECTED (NO ANSWER)') ||
    upper.includes('NO RESPONSE') ||
    upper.includes('TIMEOUT') ||
    upper.includes('RINGING TIMEOUT') ||
    upper.includes('UNANSWERED') ||
    statusUpper === 'NO ANSWER' ||
    statusUpper === 'NO_ANSWER'
  ) {
    return 'Not Connected (No Answer)';
  }

  // 11. Abruptly Disconnected Call
  if (
    upper.includes('ABRUPTLY DISCONNECTED') ||
    upper.includes('DISCONNECTED') ||
    upper.includes('CALL DROPPED') ||
    upper.includes('DROPPED') ||
    upper.includes('HANGUP') ||
    upper.includes('HUNG UP') ||
    upper.includes('CALL CUT') ||
    (duration >= 5 && (statusUpper === 'COMPLETED' || upper.includes('DISCONNECT')))
  ) {
    return 'Abruptly Disconnected Call';
  }

  // 14. Not Connected (Failed)
  if (
    upper.includes('FAILED') ||
    upper.includes('NOT CONNECTED FAILED') ||
    upper.includes('NOT CONNECTED (FAILED)') ||
    upper.includes('BUSY') ||
    upper.includes('UNREACHABLE') ||
    upper.includes('SWITCHED OFF') ||
    upper.includes('OUT OF SERVICE') ||
    upper.includes('NETWORK FAILURE') ||
    statusUpper === 'FAILED' ||
    statusUpper === 'BUSY'
  ) {
    return 'Not Connected (Failed)';
  }

  if (duration >= 5) return 'Abruptly Disconnected Call';
  if (statusUpper.includes('ANSWER') || duration === 0) return 'Not Connected (No Answer)';
  return 'Not Connected (Failed)';
};

const normalizeContactStatus = (callStatus?: string, disposition?: string): 'COMPLETED' | 'NO_ANSWER' | 'FAILED' | 'PENDING' => {
  if (!callStatus && !disposition) return 'PENDING';
  const canonical = matchCanonicalDisposition(disposition || callStatus);
  if (
    canonical === 'Confirmed For Pickup' ||
    canonical === 'Already Returned Device' ||
    canonical === 'Already Recharged' ||
    canonical === 'Willing To Pickup' ||
    canonical === 'Willing To Recharge'
  ) {
    return 'COMPLETED';
  }
  if (canonical === 'Not Connected (No Answer)' || canonical === 'Voicemail or IVR Detected') {
    return 'NO_ANSWER';
  }
  return 'FAILED';
};

const formatContactDisposition = (c: CampaignContactRecord): string => {
  if (c.final_disposition) {
    return matchCanonicalDisposition(c.final_disposition, c.duration_seconds, c.call_status);
  }
  if (c.current_disposition) {
    return matchCanonicalDisposition(c.current_disposition, c.duration_seconds, c.call_status);
  }
  const s = (c.call_status || '').toLowerCase();
  if (s === 'no_answer' || s === 'busy') return 'Not Connected (No Answer)';
  if (s === 'failed') return 'Not Connected (Failed)';
  if (s === 'completed') return 'Abruptly Disconnected Call';
  return 'Pending Call';
};

const getDispositionColor = (key: string): string => {
  const norm = key.toUpperCase();
  if (norm.includes('CONFIRMED FOR PICKUP')) return '#10B981'; // Emerald Green
  if (norm.includes('WILLING TO PICKUP')) return '#06B6D4'; // Cyan
  if (norm.includes('SCHEDULE CALLBACK')) return '#F59E0B'; // Amber
  if (norm.includes('ALREADY RETURNED')) return '#6366F1'; // Indigo
  if (norm.includes('REFUSED TO RETURN')) return '#EF4444'; // Red
  if (norm.includes('WILLING TO RECHARGE')) return '#14B8A6'; // Teal
  if (norm.includes('ALREADY RECHARGED')) return '#8B5CF6'; // Purple
  if (norm.includes('WRONG NUMBER')) return '#EC4899'; // Pink
  if (norm.includes('LANGUAGE BARRIER')) return '#D946EF'; // Fuchsia
  if (norm.includes('DO NOT CALL')) return '#DC2626'; // Dark Red
  if (norm.includes('ABRUPTLY DISCONNECTED')) return '#F97316'; // Orange
  if (norm.includes('VOICEMAIL')) return '#84CC16'; // Lime
  if (norm.includes('NO ANSWER')) return '#64748B'; // Slate
  if (norm.includes('FAILED')) return '#991B1B'; // Crimson
  return '#3B82F6';
};

interface CampaignDetailViewProps {
  campaign: CampaignItem;
  onBack: () => void;
  onSelectCall?: (call: CallRecord) => void;
}

type SubTab = 'OVERVIEW' | 'CONTACTS' | 'DETAILS';

export const CampaignDetailView: React.FC<CampaignDetailViewProps> = ({
  campaign,
  onBack,
  onSelectCall,
}) => {
  const [currentCampaign, setCurrentCampaign] = useState<CampaignItem>(campaign);
  const [activeTab, setActiveTab] = useState<SubTab>('OVERVIEW');
  const [calls, setCalls] = useState<CallRecord[]>([]);
  const [contacts, setContacts] = useState<CampaignContactRecord[]>([]);
  const [loadingContacts, setLoadingContacts] = useState(false);
  const [contactSearchTerm, setContactSearchTerm] = useState('');
  const [contactFilter, setContactFilter] = useState<'ALL' | 'COMPLETED' | 'NO_ANSWER' | 'FAILED' | 'PENDING'>('ALL');
  const [dialingContactId, setDialingContactId] = useState<string | null>(null);

  // Dispositions breakdown state
  const [dispositionData, setDispositionData] = useState<{
    expected: string[];
    dispositions: DispositionBreakdownItem[];
    totalCalls: number;
  } | null>(null);

  // Action states
  const [isStartingCalls, setIsStartingCalls] = useState(false);
  const [isPausing, setIsPausing] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [isUploadingAudience, setIsUploadingAudience] = useState(false);
  const [actionNotification, setActionNotification] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Retry policy modal state
  const [isRetryModalOpen, setIsRetryModalOpen] = useState(false);
  const [editRetryAttempts, setEditRetryAttempts] = useState<number>(campaign.retry_attempts || 3);
  const [editRetryDelayMinutes, setEditRetryDelayMinutes] = useState<number>(campaign.retry_delay_minutes || 180);
  const [savingRetry, setSavingRetry] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setCurrentCampaign(campaign);
    setEditRetryAttempts(campaign.retry_attempts || 3);
    setEditRetryDelayMinutes(campaign.retry_delay_minutes || 180);
  }, [campaign]);

  const loadData = async () => {
    setLoadingContacts(true);
    try {
      const [callsData, dispData, contactsData] = await Promise.all([
        fetchCampaignCalls(currentCampaign.id),
        fetchCampaignDispositions(currentCampaign.id).catch(() => null),
        fetchCampaignContacts(currentCampaign.id).catch(() => []),
      ]);
      setCalls(callsData || []);
      setContacts(contactsData || []);
      if (dispData) {
        setDispositionData(dispData);
      }
    } catch {
      setCalls([]);
      setContacts([]);
    } finally {
      setLoadingContacts(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [currentCampaign.id]);

  // Dial individual contact action
  const handleCallSingleContact = async (c: CampaignContactRecord) => {
    try {
      setDialingContactId(c.contact_id);
      await initiateCall(c.contact_id);
      setActionNotification({
        type: 'success',
        message: `Dispatched outbound call to ${c.contact_phone} with Priya AI agent.`,
      });
      await loadData();
    } catch (err: any) {
      setActionNotification({
        type: 'error',
        message: err.message || `Failed to initiate call to ${c.contact_phone}`,
      });
    } finally {
      setDialingContactId(null);
    }
  };

  // Handle "Start Campaign" call dispatch
  const handleStartCampaign = async () => {
    setActionNotification(null);
    setIsStartingCalls(true);
    try {
      const res = await startCampaignCalls(currentCampaign.id);
      setCurrentCampaign(res.campaign);
      setActionNotification({
        type: 'success',
        message: res.dispatchedCount > 0
          ? `Campaign started! Dispatched ${res.dispatchedCount} outbound calls to AI voice agent Priya.`
          : 'Campaign is now RUNNING. Any pending contacts within operating hours will be dialed automatically.',
      });
      // Refresh calls and dispositions
      await loadData();
    } catch (err: any) {
      setActionNotification({
        type: 'error',
        message: err.message || 'Failed to start campaign calls.',
      });
    } finally {
      setIsStartingCalls(false);
    }
  };

  // Handle Pause Campaign
  const handlePauseCampaign = async () => {
    setActionNotification(null);
    setIsPausing(true);
    try {
      const updated = await updateCampaignStatus(currentCampaign.id, 'PAUSED');
      setCurrentCampaign(updated);
      setActionNotification({
        type: 'success',
        message: 'Campaign has been paused.',
      });
      await loadData();
    } catch (err: any) {
      setActionNotification({
        type: 'error',
        message: err.message || 'Failed to pause campaign.',
      });
    } finally {
      setIsPausing(false);
    }
  };

  // Handle Cancel Campaign (stop)
  const handleCancelCampaign = async () => {
    setActionNotification(null);
    setIsCancelling(true);
    try {
      const updated = await updateCampaignStatus(currentCampaign.id, 'STOPPED');
      setCurrentCampaign(updated);
      setActionNotification({
        type: 'success',
        message: 'Campaign has been cancelled.',
      });
      await loadData();
    } catch (err: any) {
      setActionNotification({
        type: 'error',
        message: err.message || 'Failed to cancel campaign.',
      });
    } finally {
      setIsCancelling(false);
    }
  };

  // Handle Resume Campaign
  const handleResumeCampaign = async () => {
    await handleStartCampaign();
  };

  // Handle Target Audience CSV upload
  const handleAudienceCsvUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsUploadingAudience(true);
    setActionNotification(null);

    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const text = event.target?.result as string;
        if (!text) {
          throw new Error('Selected CSV file is empty.');
        }

        const lines = text
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean);

        if (lines.length === 0) {
          throw new Error('No contact records found in CSV.');
        }

        let phoneCol = 0;
        let nameCol = -1;
        let dataStart = 0;

        const headers = lines[0].split(',').map((h) => h.trim().toLowerCase().replace(/^["']|["']$/g, ''));
        const hasHeader = headers.some((h) => 
          h.includes('phone') || h.includes('mobile') || h.includes('number') || h.includes('contact')
        );

        if (hasHeader) {
          dataStart = 1;
          headers.forEach((h, idx) => {
            if (h.includes('phone') || h.includes('mobile') || h.includes('number') || h.includes('contact')) {
              phoneCol = idx;
            } else if (h.includes('name') || h.includes('customer') || h.includes('subscriber')) {
              nameCol = idx;
            }
          });
        }

        const parsedContacts: { phone: string; name?: string }[] = [];
        for (let i = dataStart; i < lines.length; i++) {
          const cols = lines[i].split(',').map((c) => c.trim().replace(/^["']|["']$/g, ''));
          const p = cols[phoneCol];
          const n = nameCol >= 0 ? cols[nameCol] : undefined;
          if (p) {
            parsedContacts.push({ phone: p, name: n });
          }
        }

        if (parsedContacts.length === 0) {
          throw new Error('No valid phone numbers found in CSV.');
        }

        const res = await uploadCampaignContacts(currentCampaign.id, parsedContacts);
        setCurrentCampaign(res.campaign);
        setActionNotification({
          type: 'success',
          message: `Target audience updated! Successfully imported ${res.addedCount} contacts (${res.duplicatesCount} duplicates and ${res.invalidCount} invalid numbers skipped).`,
        });
      } catch (err: any) {
        setActionNotification({
          type: 'error',
          message: err.message || 'Failed to upload CSV file.',
        });
      } finally {
        setIsUploadingAudience(false);
        if (fileInputRef.current) {
          fileInputRef.current.value = '';
        }
      }
    };
    reader.readAsText(file);
  };

  // Handle Save Retry Policy
  const handleSaveRetry = async () => {
    try {
      setSavingRetry(true);
      const res = await updateCampaignRetry(currentCampaign.id, editRetryAttempts, editRetryDelayMinutes);
      setCurrentCampaign(res.campaign);
      setIsRetryModalOpen(false);
      setActionNotification({
        type: 'success',
        message: `Retry settings updated to ${editRetryAttempts} attempts (${editRetryDelayMinutes} min delay). ${res.eligibleForRetryCount} leads eligible for calls.`,
      });
      await loadData();
    } catch (err: any) {
      setActionNotification({
        type: 'error',
        message: err.message || 'Failed to update retry settings.',
      });
    } finally {
      setSavingRetry(false);
    }
  };

  // Filtered contacts matching search and status filter
  const filteredContacts = useMemo(() => {
    return contacts.filter((c) => {
      const phone = c.contact_phone || '';
      const name = c.contact_name || '';
      const disp = c.final_disposition || c.current_disposition || '';
      const matchesSearch =
        phone.toLowerCase().includes(contactSearchTerm.toLowerCase()) ||
        name.toLowerCase().includes(contactSearchTerm.toLowerCase()) ||
        disp.toLowerCase().includes(contactSearchTerm.toLowerCase());

      const norm = normalizeContactStatus(c.call_status, c.final_disposition);
      const matchesFilter =
        contactFilter === 'ALL' ||
        norm === contactFilter;

      return matchesSearch && matchesFilter;
    });
  }, [contacts, contactSearchTerm, contactFilter]);

  // Compute dispositions breakdown for display (All 14 standard dispositions)
  const computedDispositions = useMemo(() => {
    const counts = new Map<string, number>();

    // Seed all 14 canonical dispositions with 0
    CANONICAL_DISPOSITIONS.forEach((name) => counts.set(name, 0));

    // Populate from dispositionData if loaded
    if (dispositionData && Array.isArray(dispositionData.dispositions)) {
      dispositionData.dispositions.forEach((d) => {
        const canonical = matchCanonicalDisposition(d.name);
        counts.set(canonical, (counts.get(canonical) || 0) + (d.count || 0));
      });
    }

    // Also scan calls in state to catch any freshly placed or updated calls
    calls.forEach((c) => {
      const raw =
        (c as any).final_disposition ||
        (c as any).call_result ||
        (c as any).disposition ||
        (c as any).call_status ||
        c.status ||
        '';
      if (raw && raw !== 'INITIATED' && raw !== 'IN_PROGRESS' && raw !== 'RINGING') {
        const canonical = matchCanonicalDisposition(raw, c.duration_seconds, c.status);
        if (!dispositionData || dispositionData.dispositions.length === 0) {
          counts.set(canonical, (counts.get(canonical) || 0) + 1);
        }
      }
    });

    // Also scan contacts in state
    contacts.forEach((ct) => {
      const raw = ct.final_disposition || ct.current_disposition || '';
      if (raw && raw !== 'PENDING' && raw !== 'NOT_STARTED') {
        const canonical = matchCanonicalDisposition(raw);
        if (!counts.has(canonical)) {
          counts.set(canonical, 0);
        }
      }
    });

    const totalOccurrences = Array.from(counts.values()).reduce((sum, val) => sum + val, 0);
    const totalCalls = dispositionData?.totalCalls || calls.length || totalOccurrences;
    const denominator = totalCalls > 0 ? totalCalls : (totalOccurrences > 0 ? totalOccurrences : 1);

    return Array.from(counts.entries())
      .map(([name, count]) => ({
        name,
        count,
        percentage: denominator > 0 ? Math.round((count / denominator) * 100) : 0,
      }))
      .sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count;
        return a.name.localeCompare(b.name);
      });
  }, [dispositionData, calls, contacts]);

  // Compute real metrics from calls data and campaign DB values
  const computedStats = useMemo(() => {
    if (calls && calls.length > 0) {
      const uniquePhoneSet = new Set<string>();
      let succCount = 0;
      let failCount = 0;
      let totalDuration = 0;
      let connectedCount = 0;

      calls.forEach((c) => {
        const phone = (c as any).customer_phone || (c as any).phone || c.id;
        if (phone) uniquePhoneSet.add(phone);

        const dur = Number((c as any).duration_seconds) || 0;
        totalDuration += dur;
        if (dur > 0) {
          connectedCount += 1;
        }

        const res = ((c as any).call_result || (c as any).disposition || '').toUpperCase();
        const st = (c.status || '').toLowerCase();
        if (
          st === 'completed' ||
          res.includes('PICKUP') ||
          res.includes('SUCCESS') ||
          res.includes('CONFIRMED')
        ) {
          succCount += 1;
        } else if (
          st === 'failed' ||
          res.includes('FAIL') ||
          res.includes('REFUS') ||
          res.includes('BUSY') ||
          res.includes('NO_ANSWER')
        ) {
          failCount += 1;
        }
      });

      const totContacts = Math.max(currentCampaign.total_contacts || 0, uniquePhoneSet.size);
      const uCalled = Math.max(currentCampaign.unique_called || 0, uniquePhoneSet.size);
      const sCalls = Math.max(currentCampaign.successful_calls || 0, succCount);
      const fCalls = Math.max(currentCampaign.failed_calls || 0, failCount);
      const remCalls = Math.max(0, totContacts - uCalled);

      return {
        totalContacts: totContacts,
        uniqueCalled: uCalled,
        successful: sCalls,
        failed: fCalls,
        remaining: remCalls,
        totalTalkTimeSeconds: totalDuration,
        avgDurationSeconds: connectedCount > 0 ? Math.round(totalDuration / connectedCount) : 0,
      };
    }

    const totContacts = currentCampaign.total_contacts || 0;
    const uCalled = currentCampaign.unique_called || 0;
    const sCalls = currentCampaign.successful_calls || 0;
    const fCalls = currentCampaign.failed_calls || 0;
    const remCalls = currentCampaign.remaining_calls ?? Math.max(0, totContacts - uCalled);

    return {
      totalContacts: totContacts,
      uniqueCalled: uCalled,
      successful: sCalls,
      failed: fCalls,
      remaining: remCalls,
      totalTalkTimeSeconds: Number((currentCampaign as any).total_talk_time_seconds) || 0,
      avgDurationSeconds: Number((currentCampaign as any).avg_duration_seconds) || 0,
    };
  }, [calls, currentCampaign]);

  const totalContacts = computedStats.totalContacts;
  const successful = computedStats.successful;
  const failed = computedStats.failed;
  const remaining = computedStats.remaining;
  const uniqueCalled = computedStats.uniqueCalled;
  const totalTalkTimeSeconds = computedStats.totalTalkTimeSeconds;
  const avgDurationSeconds = computedStats.avgDurationSeconds;

  const progressPercent = currentCampaign.progress_percent ?? (totalContacts > 0 ? Math.min(100, Math.round(((successful + failed) / totalContacts) * 100)) : 0);

  // Count how many contacts have call attempts available
  const retryStats = useMemo(() => {
    const maxAtt = currentCampaign.retry_attempts || 3;
    let leadsWithAttemptsLeft = 0;
    let leadsExhausted = 0;
    let leadsCompleted = 0;

    contacts.forEach((c) => {
      const norm = normalizeContactStatus(c.call_status, c.final_disposition);
      if (norm === 'COMPLETED') {
        leadsCompleted++;
      } else if (c.attempts >= maxAtt) {
        leadsExhausted++;
      } else {
        leadsWithAttemptsLeft++;
      }
    });

    const hasAttemptsAvailable = leadsWithAttemptsLeft > 0 || currentCampaign.status !== 'COMPLETED';

    return {
      maxAttempts: maxAtt,
      retryDelayMinutes: currentCampaign.retry_delay_minutes || 180,
      leadsWithAttemptsLeft,
      leadsExhausted,
      leadsCompleted,
      hasAttemptsAvailable,
    };
  }, [contacts, currentCampaign.retry_attempts, currentCampaign.retry_delay_minutes, currentCampaign.status]);

  const normalizeStatus = (status: string) => {
    const s = (status || '').toUpperCase();
    if (s.includes('RUN')) return 'RUNNING';
    if (s.includes('PAUS')) return 'PAUSED';
    if (s.includes('COMPLET')) return 'COMPLETED';
    if (s.includes('STOP')) return 'STOPPED';
    return 'RUNNING';
  };

  const normStatus = normalizeStatus(currentCampaign.status);

  const handleDownloadCsv = async () => {
    try {
      const reportData: CampaignReportRow[] = await fetchCampaignReport(currentCampaign.id);

      const headers = [
        'S.No.',
        'Lead Id',
        'SUBS DEL NO',
        'Mobile',
        'Customer Name',
        'Product Name',
        'Address',
        'Status',
        'Attempts Count',
        'Connected Attempts Count',
        'Last Call Time',
        'Attempt 1 Disposition',
        'Attempt 2 Disposition',
        'Attempt 3 Disposition',
        'Attempt 4 Disposition',
        'Attempt 5 Disposition',
        'Attempt 6 Disposition',
        'Attempt 7 Disposition',
        'Attempt 8 Disposition',
        'Final Disposition',
        'Conclusion Date',
        'Recording',
      ];

      const escapeCsvField = (field: string | number | null | undefined): string => {
        const str = String(field ?? '');
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
          return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
      };

      const csvRows = [headers.join(',')];
      for (const row of reportData) {
        csvRows.push([
          escapeCsvField(row.sno),
          escapeCsvField(row.lead_id),
          escapeCsvField(row.subs_del_no),
          escapeCsvField(row.mobile),
          escapeCsvField(row.customer_name),
          escapeCsvField(row.product_name),
          escapeCsvField(row.address),
          escapeCsvField(row.status),
          escapeCsvField(row.attempts_count),
          escapeCsvField(row.connected_attempts_count),
          escapeCsvField(row.last_call_time),
          escapeCsvField(row.attempt_1_disposition),
          escapeCsvField(row.attempt_2_disposition),
          escapeCsvField(row.attempt_3_disposition),
          escapeCsvField(row.attempt_4_disposition),
          escapeCsvField(row.attempt_5_disposition),
          escapeCsvField(row.attempt_6_disposition),
          escapeCsvField(row.attempt_7_disposition),
          escapeCsvField(row.attempt_8_disposition),
          escapeCsvField(row.final_disposition),
          escapeCsvField(row.conclusion_date),
          escapeCsvField(row.recording),
        ].join(','));
      }

      const csvContent = csvRows.join('\n');
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.setAttribute('href', url);
      link.setAttribute('download', `${currentCampaign.name.replace(/\s+/g, '_')}_Report.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Failed to download report:', err);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24, paddingBottom: 40 }}>
      {/* Action Notification Banner */}
      {actionNotification && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '12px 18px',
            borderRadius: 10,
            background: actionNotification.type === 'success' ? 'rgba(16, 185, 129, 0.12)' : 'rgba(239, 68, 68, 0.12)',
            border: `1px solid ${actionNotification.type === 'success' ? 'rgba(16, 185, 129, 0.3)' : 'rgba(239, 68, 68, 0.3)'}`,
            color: actionNotification.type === 'success' ? '#34D399' : '#F87171',
            fontSize: '0.85rem',
            animation: 'fadeIn 0.2s ease',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {actionNotification.type === 'success' ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
            <span>{actionNotification.message}</span>
          </div>
          <button
            onClick={() => setActionNotification(null)}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'inherit',
              cursor: 'pointer',
              padding: 2,
              display: 'flex',
              alignItems: 'center',
            }}
          >
            <X size={15} />
          </button>
        </div>
      )}

      {/* Top Header: Back Button, Title, Badge, and Action Buttons */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: 16,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          {/* Back button */}
          <button
            onClick={onBack}
            style={{
              width: 38,
              height: 38,
              borderRadius: 8,
              background: '#0E121B',
              border: '1px solid rgba(255, 255, 255, 0.1)',
              color: '#94A3B8',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              transition: 'all 0.15s ease',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = '#FFFFFF';
              e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.25)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = '#94A3B8';
              e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.1)';
            }}
            title="Back to Campaigns"
            aria-label="Back to Campaigns"
          >
            <ChevronLeft size={18} />
          </button>

          {/* Title & Status Badge */}
          <div>
            <h1 style={{
              fontSize: '1.45rem',
              fontWeight: 700,
              color: '#FFFFFF',
              letterSpacing: '-0.02em',
              margin: '0 0 6px 0',
              lineHeight: 1.25,
            }}>
              {currentCampaign.name}
            </h1>

            <div>
              {normStatus === 'COMPLETED' && (
                <span style={{
                  display: 'inline-block',
                  padding: '2px 8px',
                  borderRadius: 4,
                  background: 'rgba(168, 85, 247, 0.14)',
                  border: '1px solid rgba(168, 85, 247, 0.35)',
                  color: '#C084FC',
                  fontSize: '0.68rem',
                  fontWeight: 700,
                  letterSpacing: '0.04em',
                }}>
                  COMPLETED
                </span>
              )}
              {normStatus === 'RUNNING' && (
                <span style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                  padding: '2px 8px',
                  borderRadius: 4,
                  background: 'rgba(16, 185, 129, 0.14)',
                  border: '1px solid rgba(16, 185, 129, 0.35)',
                  color: '#10B981',
                  fontSize: '0.68rem',
                  fontWeight: 700,
                  letterSpacing: '0.04em',
                }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#10B981', display: 'inline-block' }} />
                  RUNNING
                </span>
              )}
              {normStatus === 'PAUSED' && (
                <span style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                  padding: '2px 8px',
                  borderRadius: 4,
                  background: 'rgba(245, 158, 11, 0.14)',
                  border: '1px solid rgba(245, 158, 11, 0.35)',
                  color: '#F59E0B',
                  fontSize: '0.68rem',
                  fontWeight: 700,
                  letterSpacing: '0.04em',
                }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#F59E0B', display: 'inline-block' }} />
                  PAUSED
                </span>
              )}
              {normStatus === 'STOPPED' && (
                <span style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                  padding: '2px 8px',
                  borderRadius: 4,
                  background: 'rgba(239, 68, 68, 0.14)',
                  border: '1px solid rgba(239, 68, 68, 0.35)',
                  color: '#EF4444',
                  fontSize: '0.68rem',
                  fontWeight: 700,
                  letterSpacing: '0.04em',
                }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#EF4444', display: 'inline-block' }} />
                  STOPPED
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Action Buttons: Condition-based for Completed vs In-Progress */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {/* If COMPLETED: ONLY show Download Report (CSV) */}
          {normStatus === 'COMPLETED' ? (
            <button
              onClick={handleDownloadCsv}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '9px 18px',
                borderRadius: 8,
                background: '#0E121B',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                color: '#FFFFFF',
                fontSize: '0.84rem',
                fontWeight: 600,
                cursor: 'pointer',
                transition: 'all 0.15s ease',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = '#161B26';
                e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.2)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = '#0E121B';
                e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.1)';
              }}
            >
              <Download size={14} />
              <span>Report (CSV)</span>
            </button>
          ) : (
            <>
              {/* Hidden File Input for Audience CSV Upload */}
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,.txt"
                onChange={handleAudienceCsvUpload}
                style={{ display: 'none' }}
              />

              {/* Edit Retry button on left side of Upload Audience */}
              <button
                type="button"
                onClick={() => {
                  setEditRetryAttempts(currentCampaign.retry_attempts || 3);
                  setEditRetryDelayMinutes(currentCampaign.retry_delay_minutes || 180);
                  setIsRetryModalOpen(true);
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '9px 16px',
                  borderRadius: 8,
                  background: 'rgba(255, 255, 255, 0.06)',
                  border: '1px solid rgba(255, 255, 255, 0.14)',
                  color: '#FFFFFF',
                  fontSize: '0.84rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'rgba(255, 255, 255, 0.12)';
                  e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.25)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'rgba(255, 255, 255, 0.06)';
                  e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.14)';
                }}
                title="Edit Retry Attempts & Cooldown"
              >
                <RotateCcw size={14} />
                <span>Edit Retry</span>
              </button>

              {/* Upload Audience (CSV) button */}
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={isUploadingAudience}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '9px 16px',
                  borderRadius: 8,
                  background: 'rgba(56, 189, 248, 0.1)',
                  border: '1px solid rgba(56, 189, 248, 0.28)',
                  color: '#38BDF8',
                  fontSize: '0.84rem',
                  fontWeight: 600,
                  cursor: isUploadingAudience ? 'not-allowed' : 'pointer',
                  transition: 'all 0.15s ease',
                }}
                onMouseEnter={(e) => {
                  if (!isUploadingAudience) {
                    e.currentTarget.style.background = 'rgba(56, 189, 248, 0.18)';
                    e.currentTarget.style.borderColor = 'rgba(56, 189, 248, 0.45)';
                  }
                }}
                onMouseLeave={(e) => {
                  if (!isUploadingAudience) {
                    e.currentTarget.style.background = 'rgba(56, 189, 248, 0.1)';
                    e.currentTarget.style.borderColor = 'rgba(56, 189, 248, 0.28)';
                  }
                }}
              >
                <Upload size={14} />
                <span>{isUploadingAudience ? 'Uploading...' : 'Upload Audience (CSV)'}</span>
              </button>

              {/* 1. When RUNNING: Show ONLY "Pause" */}
              {normStatus === 'RUNNING' && (
                <button
                  onClick={handlePauseCampaign}
                  disabled={isPausing}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '9px 18px',
                    borderRadius: 8,
                    background: 'rgba(245, 158, 11, 0.14)',
                    border: '1px solid rgba(245, 158, 11, 0.35)',
                    color: '#F59E0B',
                    fontSize: '0.84rem',
                    fontWeight: 700,
                    cursor: isPausing ? 'not-allowed' : 'pointer',
                    transition: 'all 0.15s ease',
                  }}
                  onMouseEnter={(e) => {
                    if (!isPausing) {
                      e.currentTarget.style.background = 'rgba(245, 158, 11, 0.22)';
                      e.currentTarget.style.borderColor = 'rgba(245, 158, 11, 0.5)';
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (!isPausing) {
                      e.currentTarget.style.background = 'rgba(245, 158, 11, 0.14)';
                      e.currentTarget.style.borderColor = 'rgba(245, 158, 11, 0.35)';
                    }
                  }}
                >
                  <Pause size={14} fill="#F59E0B" />
                  <span>{isPausing ? 'Pausing...' : 'Pause'}</span>
                </button>
              )}

              {/* 2. When PAUSED: Show "Resume" and "Cancel" */}
              {normStatus === 'PAUSED' && (
                <>
                  <button
                    onClick={handleResumeCampaign}
                    disabled={isStartingCalls || (currentCampaign.remaining_calls === 0 && currentCampaign.total_contacts > 0)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '9px 18px',
                      borderRadius: 8,
                      background: '#10B981',
                      border: 'none',
                      color: '#FFFFFF',
                      fontSize: '0.84rem',
                      fontWeight: 700,
                      cursor: (isStartingCalls || (currentCampaign.remaining_calls === 0 && currentCampaign.total_contacts > 0)) ? 'not-allowed' : 'pointer',
                      boxShadow: '0 4px 14px rgba(16, 185, 129, 0.35)',
                      transition: 'all 0.15s ease, transform 0.15s ease',
                      opacity: isStartingCalls ? 0.7 : 1,
                    }}
                    onMouseEnter={(e) => {
                      if (!isStartingCalls && !(currentCampaign.remaining_calls === 0 && currentCampaign.total_contacts > 0)) {
                        e.currentTarget.style.background = '#059669';
                        e.currentTarget.style.transform = 'translateY(-1px)';
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (!isStartingCalls) {
                        e.currentTarget.style.background = '#10B981';
                        e.currentTarget.style.transform = 'translateY(0)';
                      }
                    }}
                  >
                    <Play size={13} fill="#FFFFFF" />
                    <span>{isStartingCalls ? 'Resuming...' : 'Resume'}</span>
                  </button>

                  <button
                    onClick={handleCancelCampaign}
                    disabled={isCancelling}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '9px 16px',
                      borderRadius: 8,
                      background: 'rgba(239, 68, 68, 0.12)',
                      border: '1px solid rgba(239, 68, 68, 0.35)',
                      color: '#EF4444',
                      fontSize: '0.84rem',
                      fontWeight: 600,
                      cursor: isCancelling ? 'not-allowed' : 'pointer',
                      transition: 'all 0.15s ease',
                    }}
                    onMouseEnter={(e) => {
                      if (!isCancelling) {
                        e.currentTarget.style.background = 'rgba(239, 68, 68, 0.22)';
                        e.currentTarget.style.borderColor = 'rgba(239, 68, 68, 0.5)';
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (!isCancelling) {
                        e.currentTarget.style.background = 'rgba(239, 68, 68, 0.12)';
                        e.currentTarget.style.borderColor = 'rgba(239, 68, 68, 0.35)';
                      }
                    }}
                  >
                    <X size={14} strokeWidth={2.5} />
                    <span>{isCancelling ? 'Cancelling...' : 'Cancel'}</span>
                  </button>
                </>
              )}

              {/* 3. Initial stage / STOPPED: Show "Start Campaign" */}
              {normStatus !== 'RUNNING' && normStatus !== 'PAUSED' && (
                <button
                  onClick={handleStartCampaign}
                  disabled={isStartingCalls || (currentCampaign.remaining_calls === 0 && currentCampaign.total_contacts > 0)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '9px 20px',
                    borderRadius: 8,
                    background: '#10B981',
                    border: 'none',
                    color: '#FFFFFF',
                    fontSize: '0.84rem',
                    fontWeight: 700,
                    cursor: (isStartingCalls || (currentCampaign.remaining_calls === 0 && currentCampaign.total_contacts > 0)) ? 'not-allowed' : 'pointer',
                    boxShadow: '0 4px 14px rgba(16, 185, 129, 0.35)',
                    transition: 'all 0.15s ease, transform 0.15s ease',
                    opacity: isStartingCalls ? 0.7 : 1,
                  }}
                  onMouseEnter={(e) => {
                    if (!isStartingCalls && !(currentCampaign.remaining_calls === 0 && currentCampaign.total_contacts > 0)) {
                      e.currentTarget.style.background = '#059669';
                      e.currentTarget.style.transform = 'translateY(-1px)';
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (!isStartingCalls) {
                      e.currentTarget.style.background = '#10B981';
                      e.currentTarget.style.transform = 'translateY(0)';
                    }
                  }}
                >
                  <Play size={13} fill="#FFFFFF" />
                  <span>{isStartingCalls ? 'Starting...' : 'Start Campaign'}</span>
                </button>
              )}

              {/* Report (CSV) button */}
              <button
                onClick={handleDownloadCsv}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '9px 18px',
                  borderRadius: 8,
                  background: '#0E121B',
                  border: '1px solid rgba(255, 255, 255, 0.1)',
                  color: '#FFFFFF',
                  fontSize: '0.84rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = '#161B26';
                  e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.2)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = '#0E121B';
                  e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.1)';
                }}
              >
                <Download size={14} />
                <span>Report (CSV)</span>
              </button>
            </>
          )}
        </div>
      </div>

      {/* Navigation Sub-Tabs: Overview, Contacts, Details */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 32,
        borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
        marginTop: 6,
      }}>
        {(['OVERVIEW', 'CONTACTS', 'DETAILS'] as SubTab[]).map((tab) => {
          const isActive = activeTab === tab;
          const label = tab === 'OVERVIEW' ? 'Overview' : tab === 'CONTACTS' ? 'Contacts' : 'Details';
          return (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              style={{
                background: 'none',
                border: 'none',
                padding: '12px 0',
                color: isActive ? '#FFFFFF' : '#64748B',
                fontSize: '0.92rem',
                fontWeight: isActive ? 600 : 500,
                cursor: 'pointer',
                position: 'relative',
                transition: 'color 0.15s ease',
              }}
            >
              {label}
              {isActive && (
                <div style={{
                  position: 'absolute',
                  bottom: -1,
                  left: 0,
                  right: 0,
                  height: 2,
                  background: '#38BDF8',
                  borderRadius: 1,
                }} />
              )}
            </button>
          );
        })}
      </div>

      {/* Tab Content: OVERVIEW matching screenshot */}
      {activeTab === 'OVERVIEW' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* Section 1: Progress Card */}
          {/* Section 1: Campaign Progress Card */}
          <div style={{
            background: '#0E121B',
            border: '1px solid rgba(255, 255, 255, 0.08)',
            borderRadius: 14,
            padding: '24px 28px',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <div>
                <div style={{ fontSize: '1.02rem', fontWeight: 700, color: '#FFFFFF' }}>
                  Campaign Progress
                </div>
                <div style={{ fontSize: '0.8rem', color: '#64748B', marginTop: 4 }}>
                  {uniqueCalled.toLocaleString()} unique contacts called; {remaining.toLocaleString()} remaining
                </div>
              </div>
              <span style={{
                fontSize: '0.74rem',
                fontWeight: 700,
                color: '#10B981',
                padding: '3px 8px',
                borderRadius: 4,
                background: 'rgba(16, 185, 129, 0.12)',
                border: '1px solid rgba(16, 185, 129, 0.28)',
              }}>
                {progressPercent}%
              </span>
            </div>

            {/* Custom styled progress bar */}
            <div style={{
              width: '100%',
              height: 6,
              background: 'rgba(255, 255, 255, 0.06)',
              borderRadius: 3,
              overflow: 'hidden',
            }}>
              <div style={{
                height: '100%',
                width: `${progressPercent}%`,
                background: '#10B981',
                borderRadius: 3,
                transition: 'width 0.3s ease',
              }} />
            </div>
          </div>

          {/* Section 2: Metric Cards Grid (7 Cards Matching Actual Data) */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
            gap: 12,
          }}>
            {/* 1. Unique Called */}
            <div style={{
              background: '#0E121B',
              border: '1px solid rgba(255, 255, 255, 0.08)',
              borderRadius: 12,
              padding: '16px 16px',
              display: 'flex',
              alignItems: 'center',
              gap: 12,
            }}>
              <div style={{
                width: 38,
                height: 38,
                borderRadius: 8,
                background: 'rgba(56, 189, 248, 0.16)',
                border: '1px solid rgba(56, 189, 248, 0.28)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#38BDF8',
                flexShrink: 0,
              }}>
                <Phone size={18} />
              </div>
              <div>
                <div style={{ fontSize: '0.78rem', color: '#94A3B8' }}>Unique Called</div>
                <div style={{ fontSize: '1.28rem', fontWeight: 700, color: '#FFFFFF', marginTop: 2 }}>
                  {uniqueCalled.toLocaleString()}
                </div>
              </div>
            </div>

            {/* 2. Total Contacts */}
            <div style={{
              background: '#0E121B',
              border: '1px solid rgba(255, 255, 255, 0.08)',
              borderRadius: 12,
              padding: '16px 16px',
              display: 'flex',
              alignItems: 'center',
              gap: 12,
            }}>
              <div style={{
                width: 38,
                height: 38,
                borderRadius: 8,
                background: 'rgba(59, 130, 246, 0.16)',
                border: '1px solid rgba(59, 130, 246, 0.28)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#3B82F6',
                flexShrink: 0,
              }}>
                <Users size={18} />
              </div>
              <div>
                <div style={{ fontSize: '0.78rem', color: '#94A3B8' }}>Total Contacts</div>
                <div style={{ fontSize: '1.28rem', fontWeight: 700, color: '#FFFFFF', marginTop: 2 }}>
                  {totalContacts.toLocaleString()}
                </div>
              </div>
            </div>

            {/* 3. Successful */}
            <div style={{
              background: '#0E121B',
              border: '1px solid rgba(255, 255, 255, 0.08)',
              borderRadius: 12,
              padding: '16px 16px',
              display: 'flex',
              alignItems: 'center',
              gap: 12,
            }}>
              <div style={{
                width: 38,
                height: 38,
                borderRadius: 8,
                background: 'rgba(16, 185, 129, 0.16)',
                border: '1px solid rgba(16, 185, 129, 0.28)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#10B981',
                flexShrink: 0,
              }}>
                <Check size={18} strokeWidth={2.5} />
              </div>
              <div>
                <div style={{ fontSize: '0.78rem', color: '#94A3B8' }}>Successful</div>
                <div style={{ fontSize: '1.28rem', fontWeight: 700, color: '#FFFFFF', marginTop: 2 }}>
                  {successful.toLocaleString()}
                </div>
              </div>
            </div>

            {/* 4. Failed */}
            <div style={{
              background: '#0E121B',
              border: '1px solid rgba(255, 255, 255, 0.08)',
              borderRadius: 12,
              padding: '16px 16px',
              display: 'flex',
              alignItems: 'center',
              gap: 12,
            }}>
              <div style={{
                width: 38,
                height: 38,
                borderRadius: 8,
                background: 'rgba(239, 68, 68, 0.16)',
                border: '1px solid rgba(239, 68, 68, 0.28)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#EF4444',
                flexShrink: 0,
              }}>
                <X size={18} strokeWidth={2.5} />
              </div>
              <div>
                <div style={{ fontSize: '0.78rem', color: '#94A3B8' }}>Failed</div>
                <div style={{ fontSize: '1.28rem', fontWeight: 700, color: '#FFFFFF', marginTop: 2 }}>
                  {failed.toLocaleString()}
                </div>
              </div>
            </div>

            {/* 5. Remaining */}
            <div style={{
              background: '#0E121B',
              border: '1px solid rgba(255, 255, 255, 0.08)',
              borderRadius: 12,
              padding: '16px 16px',
              display: 'flex',
              alignItems: 'center',
              gap: 12,
            }}>
              <div style={{
                width: 38,
                height: 38,
                borderRadius: 8,
                background: 'rgba(245, 158, 11, 0.16)',
                border: '1px solid rgba(245, 158, 11, 0.28)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#F59E0B',
                flexShrink: 0,
              }}>
                <Clock size={18} />
              </div>
              <div>
                <div style={{ fontSize: '0.78rem', color: '#94A3B8' }}>Remaining</div>
                <div style={{ fontSize: '1.28rem', fontWeight: 700, color: '#FFFFFF', marginTop: 2 }}>
                  {remaining.toLocaleString()}
                </div>
              </div>
            </div>

            {/* 6. Avg Duration */}
            <div style={{
              background: '#0E121B',
              border: '1px solid rgba(255, 255, 255, 0.08)',
              borderRadius: 12,
              padding: '16px 16px',
              display: 'flex',
              alignItems: 'center',
              gap: 12,
            }}>
              <div style={{
                width: 38,
                height: 38,
                borderRadius: 8,
                background: 'rgba(168, 85, 247, 0.16)',
                border: '1px solid rgba(168, 85, 247, 0.28)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#A855F7',
                flexShrink: 0,
              }}>
                <Timer size={18} />
              </div>
              <div>
                <div style={{ fontSize: '0.78rem', color: '#94A3B8' }}>Avg Duration</div>
                <div style={{ fontSize: '1.28rem', fontWeight: 700, color: '#FFFFFF', marginTop: 2 }}>
                  {formatTalkTime(avgDurationSeconds)}
                </div>
              </div>
            </div>

            {/* 7. Total Talk Time */}
            <div style={{
              background: '#0E121B',
              border: '1px solid rgba(255, 255, 255, 0.08)',
              borderRadius: 12,
              padding: '16px 16px',
              display: 'flex',
              alignItems: 'center',
              gap: 12,
            }}>
              <div style={{
                width: 38,
                height: 38,
                borderRadius: 8,
                background: 'rgba(236, 72, 153, 0.16)',
                border: '1px solid rgba(236, 72, 153, 0.28)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#EC4899',
                flexShrink: 0,
              }}>
                <Headphones size={18} />
              </div>
              <div>
                <div style={{ fontSize: '0.78rem', color: '#94A3B8' }}>Total Talk Time</div>
                <div style={{ fontSize: '1.28rem', fontWeight: 700, color: '#FFFFFF', marginTop: 2 }}>
                  {formatTalkTime(totalTalkTimeSeconds)}
                </div>
              </div>
            </div>
          </div>

          {/* Section 3: Call Dispositions Breakdown Card (Replaces Outcome Breakdown) */}
          <div style={{
            background: '#0E121B',
            border: '1px solid rgba(255, 255, 255, 0.08)',
            borderRadius: 14,
            padding: '24px 28px',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
              <div>
                <h2 style={{
                  fontSize: '1.02rem',
                  fontWeight: 700,
                  color: '#FFFFFF',
                  margin: '0 0 4px 0',
                }}>
                  Call Dispositions
                </h2>
                <p style={{ fontSize: '0.78rem', color: '#94A3B8', margin: 0 }}>
                  Categorized call results captured by Priya Voice AI agent across {dispositionData?.totalCalls || calls.length || (computedStats.successful + computedStats.failed) || 0} call{(dispositionData?.totalCalls || calls.length || (computedStats.successful + computedStats.failed) || 0) === 1 ? '' : 's'}.
                </p>
              </div>

              <span
                style={{
                  fontSize: '0.72rem',
                  padding: '3px 10px',
                  borderRadius: 6,
                  background: 'rgba(56, 189, 248, 0.12)',
                  border: '1px solid rgba(56, 189, 248, 0.3)',
                  color: '#38BDF8',
                  fontWeight: 600,
                }}
              >
                {computedDispositions.length} Dispositions
              </span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {computedDispositions.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '24px 0', color: '#64748B', fontSize: '0.82rem' }}>
                  No call outcomes yet. Dispositions will display automatically once calls are placed.
                </div>
              ) : (
                computedDispositions.map((item) => {
                  const barColor = getDispositionColor(item.name);
                  return (
                    <div key={item.name} style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
                      <div style={{ width: 220, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span
                          style={{
                            width: 8,
                            height: 8,
                            borderRadius: '50%',
                            background: barColor,
                            display: 'inline-block',
                            flexShrink: 0,
                          }}
                        />
                        <span
                          style={{
                            fontSize: '0.82rem',
                            color: '#E2E8F0',
                            fontWeight: 600,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                          title={item.name}
                        >
                          {formatDispositionLabel(item.name)}
                        </span>
                      </div>

                      <div style={{ flex: 1, height: 7, background: 'rgba(255, 255, 255, 0.06)', borderRadius: 4, overflow: 'hidden' }}>
                        <div
                          style={{
                            height: '100%',
                            width: `${item.percentage}%`,
                            background: barColor,
                            borderRadius: 4,
                            transition: 'width 0.4s ease',
                          }}
                        />
                      </div>

                      <span style={{ fontSize: '0.84rem', color: '#94A3B8', width: 90, textAlign: 'right', flexShrink: 0, fontWeight: 500 }}>
                        {item.count} ({item.percentage}%)
                      </span>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}

      {/* Tab Content: CONTACTS matching screenshot */}
      {activeTab === 'CONTACTS' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          {/* Top Search & Filter Bar */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 16,
          }}>
            {/* Search Input */}
            <div style={{ position: 'relative', width: 340, maxWidth: '100%' }}>
              <Search
                size={16}
                style={{
                  position: 'absolute',
                  left: 14,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  color: '#64748B',
                  pointerEvents: 'none',
                }}
              />
              <input
                type="text"
                placeholder="Search by phone or name..."
                value={contactSearchTerm}
                onChange={(e) => setContactSearchTerm(e.target.value)}
                style={{
                  width: '100%',
                  padding: '9px 16px 9px 40px',
                  borderRadius: 10,
                  background: '#0E121B',
                  border: '1px solid rgba(255, 255, 255, 0.1)',
                  color: '#FFFFFF',
                  fontSize: '0.86rem',
                  outline: 'none',
                  boxShadow: '0 4px 14px rgba(0, 0, 0, 0.3)',
                  transition: 'border-color 0.15s ease',
                }}
                onFocus={(e) => (e.currentTarget.style.borderColor = 'rgba(56, 189, 248, 0.5)')}
                onBlur={(e) => (e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.1)')}
              />
            </div>

            {/* Filter Dropdown */}
            <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
              <Filter
                size={14}
                style={{
                  position: 'absolute',
                  left: 14,
                  color: '#94A3B8',
                  pointerEvents: 'none',
                }}
              />
              <select
                value={contactFilter}
                onChange={(e) => setContactFilter(e.target.value as any)}
                style={{
                  padding: '9px 36px 9px 34px',
                  borderRadius: 10,
                  background: '#0E121B',
                  border: '1px solid rgba(255, 255, 255, 0.12)',
                  color: '#FFFFFF',
                  fontSize: '0.86rem',
                  fontWeight: 600,
                  appearance: 'none',
                  WebkitAppearance: 'none',
                  cursor: 'pointer',
                  outline: 'none',
                  boxShadow: '0 4px 14px rgba(0, 0, 0, 0.4)',
                }}
              >
                <option value="ALL">All</option>
                <option value="COMPLETED">Completed</option>
                <option value="NO_ANSWER">No Answer</option>
                <option value="FAILED">Failed</option>
                <option value="PENDING">Pending</option>
              </select>
              <ChevronDown
                size={14}
                style={{
                  position: 'absolute',
                  right: 12,
                  color: '#94A3B8',
                  pointerEvents: 'none',
                }}
              />
            </div>
          </div>

          {/* Table matching screenshot */}
          <div style={{ overflowX: 'auto', width: '100%' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
              <thead>
                <tr style={{
                  borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
                  color: '#8E95A5',
                  fontSize: '0.76rem',
                  fontWeight: 700,
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                }}>
                  <th style={{ padding: '14px 16px', width: '22%' }}>Contact</th>
                  <th style={{ padding: '14px 16px', width: '15%' }}>Status</th>
                  <th style={{ padding: '14px 16px', width: '22%' }}>Disposition</th>
                  <th style={{ padding: '14px 16px', width: '10%' }}>Duration</th>
                  <th style={{ padding: '14px 16px', width: '10%' }}>Attempts</th>
                  <th style={{ padding: '14px 16px', width: '13%' }}>Last Called</th>
                  <th style={{ padding: '14px 16px', width: '8%' }}>Recording</th>
                  <th style={{ padding: '14px 16px', width: '6%', textAlign: 'center' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredContacts.length === 0 ? (
                  <tr>
                    <td colSpan={8} style={{ padding: 48, textAlign: 'center', color: '#64748B' }}>
                      {loadingContacts ? 'Loading campaign contacts...' : 'No contacts found matching filter.'}
                    </td>
                  </tr>
                ) : (
                  filteredContacts.map((c) => {
                    const normStatusType = normalizeContactStatus(c.call_status, c.final_disposition);
                    const dispText = formatContactDisposition(c);
                    const durationText = formatContactDuration(c.duration_seconds);
                    const lastCalledText = formatLastCalled(c.last_called_at);
                    const phoneDisplay = formatCleanPhone(c.contact_phone);
                    const isDialing = dialingContactId === c.contact_id;

                    return (
                      <tr
                        key={c.contact_id}
                        onClick={() => {
                          if (onSelectCall && c.last_call_id) {
                            onSelectCall({ id: c.last_call_id, customer_id: c.contact_id, status: c.call_status || 'completed' } as any);
                          }
                        }}
                        style={{
                          borderBottom: '1px solid rgba(255, 255, 255, 0.04)',
                          cursor: c.last_call_id ? 'pointer' : 'default',
                          transition: 'background 0.15s ease',
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255, 255, 255, 0.02)')}
                        onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                      >
                        {/* 1. Contact: Phone (bold) & Name */}
                        <td style={{ padding: '14px 16px' }}>
                          <div style={{ color: '#FFFFFF', fontWeight: 700, fontSize: '0.9rem', letterSpacing: '0.01em' }}>
                            {phoneDisplay}
                          </div>
                          <div style={{ color: '#8E95A5', fontSize: '0.78rem', marginTop: 3 }}>
                            {c.contact_name || 'Subscriber On Record'}
                          </div>
                        </td>

                        {/* 2. Status Badge */}
                        <td style={{ padding: '14px 16px' }}>
                          {normStatusType === 'NO_ANSWER' && (
                            <span style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 6,
                              padding: '4px 10px',
                              borderRadius: 6,
                              fontSize: '0.75rem',
                              fontWeight: 600,
                              background: 'rgba(245, 158, 11, 0.12)',
                              border: '1px solid rgba(245, 158, 11, 0.3)',
                              color: '#F59E0B',
                            }}>
                              <AlertTriangle size={12} />
                              No Answer
                            </span>
                          )}
                          {normStatusType === 'FAILED' && (
                            <span style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 6,
                              padding: '4px 10px',
                              borderRadius: 6,
                              fontSize: '0.75rem',
                              fontWeight: 600,
                              background: 'rgba(239, 68, 68, 0.12)',
                              border: '1px solid rgba(239, 68, 68, 0.3)',
                              color: '#EF4444',
                            }}>
                              <X size={12} strokeWidth={2.5} />
                              Failed
                            </span>
                          )}
                          {normStatusType === 'COMPLETED' && (
                            <span style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 6,
                              padding: '4px 10px',
                              borderRadius: 6,
                              fontSize: '0.75rem',
                              fontWeight: 600,
                              background: 'rgba(16, 185, 129, 0.12)',
                              border: '1px solid rgba(16, 185, 129, 0.3)',
                              color: '#10B981',
                            }}>
                              <Check size={12} strokeWidth={2.5} />
                              Completed
                            </span>
                          )}
                          {normStatusType === 'PENDING' && (
                            <span style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 6,
                              padding: '4px 10px',
                              borderRadius: 6,
                              fontSize: '0.75rem',
                              fontWeight: 600,
                              background: 'rgba(148, 163, 184, 0.12)',
                              border: '1px solid rgba(148, 163, 184, 0.3)',
                              color: '#94A3B8',
                            }}>
                              <Clock size={12} />
                              Pending
                            </span>
                          )}
                        </td>

                        {/* 3. Disposition */}
                        <td style={{ padding: '14px 16px' }}>
                          <span style={{
                            fontSize: '0.84rem',
                            color: '#E2E8F0',
                            fontWeight: 500,
                          }}>
                            {dispText}
                          </span>
                        </td>

                        {/* 4. Duration */}
                        <td style={{ padding: '14px 16px', color: '#CBD5E1', fontSize: '0.84rem' }}>
                          {durationText}
                        </td>

                        {/* 5. Attempts */}
                        <td style={{ padding: '14px 16px', color: '#FFFFFF', fontSize: '0.86rem', fontWeight: 500 }}>
                          {c.attempts}
                        </td>

                        {/* 6. Last Called */}
                        <td style={{ padding: '14px 16px', color: '#94A3B8', fontSize: '0.82rem' }}>
                          {lastCalledText}
                        </td>

                        {/* 7. Recording */}
                        <td style={{ padding: '14px 16px' }}>
                          {c.recording_url ? (
                            <span style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 6,
                              color: '#10B981',
                            }}>
                              <Headphones size={14} />
                              <Download size={13} style={{ color: '#64748B' }} />
                            </span>
                          ) : (
                            <span style={{ color: '#64748B' }}>-</span>
                          )}
                        </td>

                        {/* 8. Actions (Play/Call button) */}
                        <td style={{ padding: '14px 16px', textAlign: 'center' }}>
                          <button
                            onClick={() => handleCallSingleContact(c)}
                            disabled={isDialing}
                            title={`Call ${c.contact_phone}`}
                            style={{
                              width: 32,
                              height: 32,
                              borderRadius: 6,
                              background: '#111622',
                              border: '1px solid rgba(255, 255, 255, 0.1)',
                              display: 'inline-flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              cursor: isDialing ? 'not-allowed' : 'pointer',
                              color: isDialing ? '#10B981' : '#94A3B8',
                              transition: 'all 0.15s ease',
                            }}
                            onMouseEnter={(e) => {
                              if (!isDialing) {
                                e.currentTarget.style.borderColor = 'rgba(56, 189, 248, 0.4)';
                                e.currentTarget.style.color = '#38BDF8';
                              }
                            }}
                            onMouseLeave={(e) => {
                              if (!isDialing) {
                                e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.1)';
                                e.currentTarget.style.color = '#94A3B8';
                              }
                            }}
                          >
                            <Play size={12} fill="currentColor" />
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Tab Content: DETAILS */}
      {activeTab === 'DETAILS' && (
        <div style={{
          background: '#0E121B',
          border: '1px solid rgba(255, 255, 255, 0.08)',
          borderRadius: 14,
          padding: '28px',
          display: 'flex',
          flexDirection: 'column',
          gap: 20,
        }}>
          <h2 style={{ fontSize: '1.05rem', fontWeight: 700, color: '#FFFFFF', margin: 0 }}>
            Campaign Configuration
          </h2>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 16 }}>
            <div style={{ background: '#080A10', padding: 14, borderRadius: 8, border: '1px solid rgba(255, 255, 255, 0.05)' }}>
              <div style={{ fontSize: '0.74rem', color: '#64748B' }}>Campaign Name</div>
              <div style={{ fontSize: '0.92rem', color: '#FFFFFF', fontWeight: 600, marginTop: 4 }}>{currentCampaign.name}</div>
            </div>

            <div style={{ background: '#080A10', padding: 14, borderRadius: 8, border: '1px solid rgba(255, 255, 255, 0.05)' }}>
              <div style={{ fontSize: '0.74rem', color: '#64748B' }}>Language & Voice Pipeline</div>
              <div style={{ fontSize: '0.92rem', color: '#FFFFFF', fontWeight: 600, marginTop: 4 }}>
                {currentCampaign.language || 'Hindi (hi-IN)'} • {currentCampaign.voice_pipeline || 'Sarvam AI (Priya - hi-IN)'}
              </div>
            </div>

            <div style={{ background: '#080A10', padding: 14, borderRadius: 8, border: '1px solid rgba(255, 255, 255, 0.05)' }}>
              <div style={{ fontSize: '0.74rem', color: '#64748B' }}>Operating Schedule</div>
              <div style={{ fontSize: '0.92rem', color: '#FFFFFF', fontWeight: 600, marginTop: 4 }}>
                {currentCampaign.schedule_start_time || '09:00'} to {currentCampaign.schedule_end_time || '20:00'}
              </div>
            </div>

            <div style={{ background: '#080A10', padding: 14, borderRadius: 8, border: '1px solid rgba(255, 255, 255, 0.05)' }}>
              <div style={{ fontSize: '0.74rem', color: '#64748B' }}>Rate Limits</div>
              <div style={{ fontSize: '0.92rem', color: '#FFFFFF', fontWeight: 600, marginTop: 4 }}>
                {currentCampaign.max_concurrent_calls || 5} concurrent • {currentCampaign.calls_per_minute || 30} calls/min
              </div>
            </div>

            <div style={{ background: '#080A10', padding: 14, borderRadius: 8, border: '1px solid rgba(255, 255, 255, 0.05)' }}>
              <div style={{ fontSize: '0.74rem', color: '#64748B' }}>Retry Settings</div>
              <div style={{ fontSize: '0.92rem', color: '#FFFFFF', fontWeight: 600, marginTop: 4 }}>
                {currentCampaign.retry_attempts || 3} attempts • {currentCampaign.retry_delay_minutes || 180} min delay
              </div>
            </div>

            <div style={{ background: '#080A10', padding: 14, borderRadius: 8, border: '1px solid rgba(255, 255, 255, 0.05)' }}>
              <div style={{ fontSize: '0.74rem', color: '#64748B' }}>Max Call Duration</div>
              <div style={{ fontSize: '0.92rem', color: '#FFFFFF', fontWeight: 600, marginTop: 4 }}>
                {currentCampaign.max_call_duration_minutes || 5} minutes
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Edit Retry Popup Modal */}
      {isRetryModalOpen && (
        <div style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0, 0, 0, 0.75)',
          backdropFilter: 'blur(6px)',
          zIndex: 9999,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 20,
        }}>
          <div style={{
            background: '#0E121B',
            border: '1px solid rgba(255, 255, 255, 0.12)',
            borderRadius: 16,
            boxShadow: '0 24px 60px rgba(0, 0, 0, 0.8)',
            width: 520,
            maxWidth: '100%',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
          }}>
            {/* Modal Header */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '20px 24px',
              borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
              background: '#080A10',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{
                  width: 36,
                  height: 36,
                  borderRadius: 8,
                  background: 'rgba(56, 189, 248, 0.12)',
                  border: '1px solid rgba(56, 189, 248, 0.3)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#38BDF8',
                  flexShrink: 0,
                }}>
                  <RotateCcw size={17} />
                </div>
                <div>
                  <h3 style={{ fontSize: '1.02rem', fontWeight: 700, color: '#FFFFFF', margin: 0 }}>
                    Edit Call Retry Policy
                  </h3>
                  <p style={{ fontSize: '0.78rem', color: '#94A3B8', margin: '2px 0 0 0' }}>
                    Configure automatic redial attempts & delays for this campaign.
                  </p>
                </div>
              </div>

              <button
                type="button"
                onClick={() => setIsRetryModalOpen(false)}
                disabled={savingRetry}
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#64748B',
                  cursor: 'pointer',
                  padding: 6,
                  borderRadius: 6,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  transition: 'color 0.15s ease',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.color = '#FFFFFF'; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = '#64748B'; }}
              >
                <X size={18} />
              </button>
            </div>

            {/* Modal Body */}
            <div style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: 20 }}>
              {/* Attempt Availability Status Banner */}
              <div style={{
                background: retryStats.hasAttemptsAvailable ? 'rgba(16, 185, 129, 0.08)' : 'rgba(245, 158, 11, 0.08)',
                border: `1px solid ${retryStats.hasAttemptsAvailable ? 'rgba(16, 185, 129, 0.25)' : 'rgba(245, 158, 11, 0.25)'}`,
                borderRadius: 10,
                padding: '14px 16px',
                display: 'flex',
                alignItems: 'flex-start',
                gap: 12,
              }}>
                <div style={{
                  width: 22,
                  height: 22,
                  borderRadius: '50%',
                  background: retryStats.hasAttemptsAvailable ? 'rgba(16, 185, 129, 0.2)' : 'rgba(245, 158, 11, 0.2)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: retryStats.hasAttemptsAvailable ? '#10B981' : '#F59E0B',
                  flexShrink: 0,
                  marginTop: 1,
                }}>
                  {retryStats.hasAttemptsAvailable ? <Check size={13} strokeWidth={2.5} /> : <AlertTriangle size={13} />}
                </div>
                <div>
                  <div style={{
                    fontSize: '0.84rem',
                    fontWeight: 600,
                    color: retryStats.hasAttemptsAvailable ? '#34D399' : '#FBBF24',
                  }}>
                    {retryStats.hasAttemptsAvailable
                      ? `${retryStats.leadsWithAttemptsLeft} Leads Have Call Attempts Available`
                      : 'Call Attempts Currently Exhausted for Incomplete Leads'}
                  </div>
                  <div style={{ fontSize: '0.78rem', color: '#94A3B8', marginTop: 3, lineHeight: 1.45 }}>
                    {retryStats.hasAttemptsAvailable
                      ? 'Unanswered, busy, or failed contacts can still be dialed automatically up to the max attempts limit.'
                      : 'Increasing max retry attempts below will immediately unlock additional dial attempts for leads that reached the previous limit.'}
                  </div>
                </div>
              </div>

              {/* Status metrics grid */}
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(3, 1fr)',
                gap: 10,
              }}>
                <div style={{ background: '#080A10', padding: '12px', borderRadius: 8, border: '1px solid rgba(255, 255, 255, 0.06)' }}>
                  <div style={{ fontSize: '0.72rem', color: '#64748B' }}>Total Leads</div>
                  <div style={{ fontSize: '1.1rem', fontWeight: 700, color: '#FFFFFF', marginTop: 3 }}>
                    {totalContacts.toLocaleString()}
                  </div>
                </div>
                <div style={{ background: '#080A10', padding: '12px', borderRadius: 8, border: '1px solid rgba(255, 255, 255, 0.06)' }}>
                  <div style={{ fontSize: '0.72rem', color: '#64748B' }}>Attempts Left</div>
                  <div style={{ fontSize: '1.1rem', fontWeight: 700, color: '#10B981', marginTop: 3 }}>
                    {retryStats.leadsWithAttemptsLeft.toLocaleString()}
                  </div>
                </div>
                <div style={{ background: '#080A10', padding: '12px', borderRadius: 8, border: '1px solid rgba(255, 255, 255, 0.06)' }}>
                  <div style={{ fontSize: '0.72rem', color: '#64748B' }}>Exhausted</div>
                  <div style={{ fontSize: '1.1rem', fontWeight: 700, color: retryStats.leadsExhausted > 0 ? '#F59E0B' : '#64748B', marginTop: 3 }}>
                    {retryStats.leadsExhausted.toLocaleString()}
                  </div>
                </div>
              </div>

              {/* Form Inputs */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                {/* Max Retry Attempts Stepper */}
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                    <label style={{ fontSize: '0.8rem', color: '#CBD5E1', fontWeight: 600 }}>
                      Max Retry Attempts (per Lead)
                    </label>
                    <span style={{ fontSize: '0.74rem', color: '#64748B' }}>Allowed range: 1 to 10</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <button
                      type="button"
                      onClick={() => setEditRetryAttempts((prev) => Math.max(1, prev - 1))}
                      disabled={editRetryAttempts <= 1 || savingRetry}
                      style={{
                        width: 40,
                        height: 40,
                        borderRadius: 8,
                        background: 'rgba(255, 255, 255, 0.06)',
                        border: '1px solid rgba(255, 255, 255, 0.12)',
                        color: '#FFFFFF',
                        fontSize: '1.2rem',
                        fontWeight: 700,
                        cursor: editRetryAttempts <= 1 ? 'not-allowed' : 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        transition: 'background 0.15s ease',
                      }}
                    >
                      -
                    </button>
                    <input
                      type="number"
                      min={1}
                      max={10}
                      value={editRetryAttempts}
                      onChange={(e) => {
                        const val = parseInt(e.target.value, 10);
                        if (!isNaN(val)) setEditRetryAttempts(Math.max(1, Math.min(10, val)));
                      }}
                      style={{
                        flex: 1,
                        height: 40,
                        borderRadius: 8,
                        background: '#080A10',
                        border: '1px solid rgba(255, 255, 255, 0.14)',
                        color: '#FFFFFF',
                        textAlign: 'center',
                        fontSize: '1.05rem',
                        fontWeight: 700,
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => setEditRetryAttempts((prev) => Math.min(10, prev + 1))}
                      disabled={editRetryAttempts >= 10 || savingRetry}
                      style={{
                        width: 40,
                        height: 40,
                        borderRadius: 8,
                        background: 'rgba(255, 255, 255, 0.06)',
                        border: '1px solid rgba(255, 255, 255, 0.12)',
                        color: '#FFFFFF',
                        fontSize: '1.2rem',
                        fontWeight: 700,
                        cursor: editRetryAttempts >= 10 ? 'not-allowed' : 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        transition: 'background 0.15s ease',
                      }}
                    >
                      +
                    </button>
                  </div>
                  <div style={{ fontSize: '0.74rem', color: '#64748B', marginTop: 5 }}>
                    Priya AI will attempt each phone number up to {editRetryAttempts} time{editRetryAttempts === 1 ? '' : 's'}.
                  </div>
                </div>

                {/* Retry Delay */}
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                    <label style={{ fontSize: '0.8rem', color: '#CBD5E1', fontWeight: 600 }}>
                      Retry Cooldown Delay (Minutes)
                    </label>
                    <span style={{ fontSize: '0.74rem', color: '#64748B' }}>e.g., 60, 180, 360</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <input
                      type="number"
                      min={5}
                      max={1440}
                      step={15}
                      value={editRetryDelayMinutes}
                      onChange={(e) => {
                        const val = parseInt(e.target.value, 10);
                        if (!isNaN(val)) setEditRetryDelayMinutes(Math.max(1, val));
                      }}
                      style={{
                        width: '100%',
                        height: 40,
                        borderRadius: 8,
                        background: '#080A10',
                        border: '1px solid rgba(255, 255, 255, 0.14)',
                        color: '#FFFFFF',
                        padding: '0 14px',
                        fontSize: '0.96rem',
                        fontWeight: 600,
                      }}
                    />
                  </div>
                  <div style={{ fontSize: '0.74rem', color: '#64748B', marginTop: 5 }}>
                    Minimum time to wait after an unanswered call before scheduling the next redial attempt.
                  </div>
                </div>
              </div>
            </div>

            {/* Modal Footer */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              gap: 12,
              padding: '16px 24px',
              borderTop: '1px solid rgba(255, 255, 255, 0.08)',
              background: '#080A10',
            }}>
              <button
                type="button"
                onClick={() => setIsRetryModalOpen(false)}
                disabled={savingRetry}
                style={{
                  padding: '9px 18px',
                  borderRadius: 8,
                  background: 'rgba(255, 255, 255, 0.06)',
                  border: '1px solid rgba(255, 255, 255, 0.12)',
                  color: '#94A3B8',
                  fontSize: '0.84rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>

              <button
                type="button"
                onClick={handleSaveRetry}
                disabled={savingRetry}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '9px 22px',
                  borderRadius: 8,
                  background: '#0284C7',
                  border: '1px solid #38BDF8',
                  color: '#FFFFFF',
                  fontSize: '0.84rem',
                  fontWeight: 700,
                  cursor: savingRetry ? 'wait' : 'pointer',
                  boxShadow: '0 4px 14px rgba(2, 132, 199, 0.4)',
                }}
              >
                {savingRetry ? (
                  'Saving...'
                ) : (
                  <>
                    <Check size={15} />
                    <span>Save Retry Policy</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
