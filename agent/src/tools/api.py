import time
import logging
import requests
from src.config import BACKEND_URL, INTERNAL_SECRET
from src.state import ConversationState

logger = logging.getLogger("agent-api")

_HEADERS = {
    "X-Internal-Secret": INTERNAL_SECRET,
    "Content-Type": "application/json",
}


def post_outcome_to_backend(state: ConversationState) -> bool:
    """Posts the finalized call outcome, transcript, and audit measurements to Express backend.
    BLOCKING - always call via asyncio.to_thread() from async code."""
    if not state.call_id:
        logger.warning("No call_id present in state, skipping backend HTTP post.")
        return False

    url = f"{BACKEND_URL}/internal/calls/{state.call_id}/outcome"

    payload = {
        "final_disposition": state.final_disposition,
        "identity_confirmed": state.identity_confirmed,
        "pickup_accepted": state.pickup_accepted,
        "proposed_date": state.proposed_date,
        "confirmed_date": state.confirmed_date,
        "registered_address_confirmed": state.registered_address_confirmed,
        "new_address": state.new_address,
        "alternate_phone": state.alternate_phone,
        "customer_note": state.customer_note,
        "escalation_required": state.escalation_required,
        "transcript": state.transcript,
        "duration_seconds": state.get_duration_seconds(),
        "median_latency_ms": state.get_median_latency(),
        "cost_estimate_inr": state.get_estimated_cost_inr(),
    }

    # Backend endpoint is an idempotent upsert, so retrying is safe.
    # Retry only transient failures (network error / 5xx); a 4xx will not fix itself.
    attempts = 3
    for attempt in range(1, attempts + 1):
        try:
            res = requests.post(url, json=payload, headers=_HEADERS, timeout=5.0)
            if res.status_code in (200, 201):
                logger.info(
                    f"✅ Saved outcome for call {state.call_id} "
                    f"(Disposition: {state.final_disposition}, Latency: {payload['median_latency_ms']}ms)"
                )
                return True
            logger.error(f"❌ Failed to save outcome ({res.status_code}) attempt {attempt}/{attempts}: {res.text}")
            if res.status_code < 500:
                return False
        except Exception as e:
            logger.error(f"❌ Exception posting outcome to backend (attempt {attempt}/{attempts}): {e}")
        if attempt < attempts:
            time.sleep(0.5 * attempt)
    return False


def lookup_customer_by_phone(phone: str):
    """Queries backend database to find existing customer lead by incoming phone number. BLOCKING."""
    if not phone:
        return None
    url = f"{BACKEND_URL}/internal/customers/lookup"
    try:
        res = requests.get(url, params={"phone": phone}, headers={"X-Internal-Secret": INTERNAL_SECRET}, timeout=4.0)
        if res.status_code == 200:
            return res.json().get("customer")
    except Exception as e:
        logger.warning(f"Failed to lookup customer by phone {phone}: {e}")
    return None


def register_inbound_call_to_backend(room_name: str, phone: str = "", sip_call_id: str = ""):
    """Registers an inbound SIP call with the backend (idempotent per room) and returns
    {"call": {...}, "customer": {...}|None}. BLOCKING - call via asyncio.to_thread().
    Retries transient failures: without a call_id the whole call's outcome would be lost."""
    url = f"{BACKEND_URL}/internal/calls/inbound"
    payload = {"roomName": room_name, "phone": phone or "", "sipCallId": sip_call_id or ""}
    attempts = 3
    for attempt in range(1, attempts + 1):
        try:
            res = requests.post(url, json=payload, headers=_HEADERS, timeout=5.0)
            if res.status_code in (200, 201):
                return res.json()
            logger.warning(f"Failed to register inbound call ({res.status_code}) attempt {attempt}/{attempts}: {res.text}")
            if res.status_code < 500:
                return None
        except Exception as e:
            logger.error(f"Exception registering inbound call (attempt {attempt}/{attempts}): {e}")
        if attempt < attempts:
            time.sleep(0.5 * attempt)
    return None