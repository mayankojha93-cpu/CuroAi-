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
