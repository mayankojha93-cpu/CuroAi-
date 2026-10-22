import logging
import requests
from src.config import BACKEND_URL, INTERNAL_SECRET
from src.state import ConversationState

logger = logging.getLogger("agent-api")

def post_outcome_to_backend(state: ConversationState) -> bool:
    """Posts the finalized call outcome, transcript, and audit measurements to Express backend."""
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

    try:
        res = requests.post(
            url,
            json=payload,
            headers={
                "X-Internal-Secret": INTERNAL_SECRET,
                "Content-Type": "application/json",
            },
            timeout=5.0
        )
        if res.status_code in [200, 201]:
            logger.info(
                f"✅ Successfully saved outcome to backend for call {state.call_id} "
                f"(Disposition: {state.final_disposition}, Latency: {payload['median_latency_ms']}ms)"
            )
            return True
        else:
            logger.error(f"❌ Failed to save outcome ({res.status_code}): {res.text}")
            return False
    except Exception as e:
        logger.error(f"❌ Exception posting outcome to backend: {e}")
        return False

def lookup_customer_by_phone(phone: str):
    """Queries backend database to find existing customer lead by incoming phone number."""
    if not phone:
        return None
    url = f"{BACKEND_URL}/internal/customers/lookup"
    try:
        res = requests.get(
            url,
            params={"phone": phone},
            headers={"X-Internal-Secret": INTERNAL_SECRET},
            timeout=4.0
        )
        if res.status_code == 200:
            data = res.json()
            return data.get("customer")
    except Exception as e:
        logger.warn(f"Failed to lookup customer by phone {phone}: {e}")
    return None

def register_inbound_call_to_backend(room_name: str, phone: str = "", sip_call_id: str = ""):
    """Registers an inbound SIP call session with the backend and retrieves customer info."""
    url = f"{BACKEND_URL}/internal/calls/inbound"
    payload = {
        "roomName": room_name,
        "phone": phone,
        "sipCallId": sip_call_id,
    }
    try:
        res = requests.post(
            url,
            json=payload,
            headers={
                "X-Internal-Secret": INTERNAL_SECRET,
                "Content-Type": "application/json",
            },
            timeout=5.0
        )
        if res.status_code in [200, 201]:
            return res.json()
        else:
            logger.warn(f"Failed to register inbound call: {res.status_code} - {res.text}")
    except Exception as e:
        logger.error(f"Exception registering inbound call to backend: {e}")
    return None
