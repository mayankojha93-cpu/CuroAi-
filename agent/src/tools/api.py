import logging
import requests
from src.config import BACKEND_URL, INTERNAL_SECRET
from src.state import ConversationState

logger = logging.getLogger("agent-api")

def post_outcome_to_backend(state: ConversationState) -> bool:
    """Posts the finalized call outcome, transcript, and dates to Express backend."""
    if not state.call_id:
        logger.warning("No call_id present in state, skipping backend HTTP post.")
        return False

    url = f"{BACKEND_URL}/internal/calls/{state.call_id}/outcome"

    payload = {
        "outcome": state.outcome or "no_response",
        "pickup_date": state.pickup_date,
        "address_confirmed": state.address_confirmed,
        "corrected_address": state.corrected_address,
        "transcript": state.transcript,
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
            logger.info(f"✅ Successfully saved outcome to backend for call {state.call_id} (Outcome: {state.outcome})")
            return True
        else:
            logger.error(f"❌ Failed to save outcome ({res.status_code}): {res.text}")
            return False
    except Exception as e:
        logger.error(f"❌ Exception posting outcome to backend: {e}")
        return False
