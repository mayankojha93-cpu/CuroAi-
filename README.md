# AI Outbound Calling System (Wi-Fi Router Pickup)

An MVP outbound voice calling system for a telecom company that autonomously calls a customer to schedule the pickup of their Wi-Fi router, converses naturally in Hindi / Hinglish, and records the call outcome.

---

## Architecture Overview

```
                                      +------------------------+
                                      |   Customer Phone       |
                                      |   (E.164 +91...)       |
                                      +-----------+------------+
                                                  ^
                                                  | PSTN Call
                                                  v
                                      +-----------+------------+
                                      |   Exotel SIP Trunk     |
                                      |   (pstn.exotel.com)    |
                                      +-----------+------------+
                                                  ^
                                                  | SIP Signaling & RTP Audio
                                                  v
+--------------------------+          +-----------+------------+
|  Backend API             |          |   LiveKit Cloud        |
|  (Express + TypeScript)  | -------->|   (WebRTC / SIP)       |
+--------------------------+          +-----------+------------+
       |             ^                             ^
       | Dispatches  | /internal/calls/.../outcome  | Audio stream
       v             |                             v
+--------------+     |                +------------------------+
| PostgreSQL   |     +----------------+   LiveKit Agent Worker |
| (18 / Local) |                      |   (Python 3.11)        |
+--------------+                      |   Sarvam STT/TTS       |
                                      |   Groq Llama 3.1 8B    |
                                      +------------------------+
```

---

## 1. Exotel SIP Setup Guide (India Outbound Calling)

To place outbound PSTN calls through Exotel and LiveKit, configure the following on the Exotel console:

### A. Enable Outbound SIP Trunking on Exotel
1. Log in to your **Exotel Dashboard** (`my.exotel.com`).
2. Navigate to **App Marketplace / Add-ons** > **SIP Trunking**.
3. Create a new Outbound SIP Trunk. Exotel will generate:
   - **Account SID**: Your organization identifier.
   - **Termination Domain**: Logical trunk URI in the format `<account_sid>.pstn.exotel.com` (or regional gateway `pstn.in2.exotel.com`).
   - **SIP Signaling Port**: **Port 5070** (SIP over TCP or UDP).
   - **RTP Media Port Range**: UDP **10000–40000**.

### B. Authentication Method (IP Whitelist vs Credentials)
Exotel supports two methods for authorizing outbound SIP calls:
- **IP Access Control List (ACL) Whitelisting (Recommended for Cloud SIP)**:
  - If using LiveKit Cloud, obtain the LiveKit Cloud SIP outbound IP addresses for your region (e.g. Mumbai / India region) and whitelist them under your Exotel Trunk settings.
- **SIP Digest Credentials**:
  - In Exotel's SIP Trunk settings, generate a SIP Username and Password for the trunk.
  - Set `EXOTEL_SIP_USERNAME` and `EXOTEL_SIP_PASSWORD` in your `.env`.

### C. Caller ID / ExoPhone Allocation
- Telephony regulations require an active, allocated **ExoPhone** (virtual DID number) as the Caller ID for all outbound calls.
- The number must be in E.164 format (e.g., `+9180XXXXXXXX`).
- Set `EXOTEL_CALLER_ID` in your `.env`.

### D. India TRAI & DLT Regulatory Compliance
When making automated outbound calls in India:
- **Entity Registration**: Your business must be registered on a DLT portal (e.g., Vilpower, Jio DLT, Airtel DLT) with a registered Entity ID.
- **Calling Window**: Commercial/promotional outbound automated calls are restricted by TRAI to the window **09:00 AM – 09:00 PM IST**.
- **Service vs Promotional**: Router return calls are classified as **Service / Transactional** calls to an existing subscribed subscriber. Ensure the Caller ID mapped in Exotel has the appropriate service category enabled.
- **CLI Masking**: Use only allocated, verified Exophones. Unverified or spoofed CLIs are dropped by Indian telecom operator gateways.

---

## 2. Environment Configuration

Copy `.env.example` to `.env` and fill in your keys:

```bash
cp .env.example .env
```

Key variables:
```env
# Server & Database
PORT=3000
DATABASE_URL=postgresql://localhost:5434/ai_calling
BACKEND_URL=http://localhost:3000
INTERNAL_SECRET=dev-secret-key-12345

# LiveKit Cloud
LIVEKIT_URL=wss://your-project.livekit.cloud
LIVEKIT_API_KEY=your_key
LIVEKIT_API_SECRET=your_secret
AGENT_NAME=telecom-router-pickup-agent

# Exotel SIP Outbound Trunk
SIP_PROVIDER=exotel
SIP_OUTBOUND_TRUNK_ID=ST_xxxxxxxxxxxx
SIP_DOMAIN=curoai1.pstn.exotel.com:5070
SIP_CALLER_ID=+9109513886363
SIP_USERNAME=your_exotel_sip_username
SIP_PASSWORD=your_exotel_sip_password

# AI Providers
SARVAM_API_KEY=your_sarvam_api_key
GROQ_API_KEY=your_groq_api_key
LLM_MODEL=llama-3.1-8b-instant

# Test Customer
TEST_PHONE=+919876543210
TEST_CUSTOMER_NAME="Raja Nayak"
TEST_CUSTOMER_ADDRESS="Flat 402, Sunshine Heights, Koramangala 4th Block, Bengaluru, Karnataka 560034"
```

---

## 3. Quick Start & Running Locally

### Step 1: Run Database Migrations and Seed Customer
```bash
cd backend
npm run migrate
npm run seed
```

### Step 2: Provision LiveKit Outbound & Inbound SIP Trunks
```bash
cd backend
# Provision Outbound Trunk
npm run trunk:create

# Provision Inbound Trunk & SIP Dispatch Rule
npm run trunk:inbound:create
```
*(Trunk IDs `SIP_OUTBOUND_TRUNK_ID`, `SIP_INBOUND_TRUNK_ID`, and `SIP_DISPATCH_RULE_ID` are saved in `.env`)*

### Step 3: Start the Backend Express Server
```bash
cd backend
npm run dev
```

### Step 4: Start the LiveKit Voice Agent Worker
In a second terminal window:
```bash
cd agent
./venv/bin/python agent.py dev
```

### Step 5: Place an Outbound Call
```bash
curl -X POST http://localhost:3000/calls \
  -H "Content-Type: application/json" \
  -d '{"customerId": "<customer_id_from_seed>"}'
```

---

## 4. End-to-End Test Checklist (Milestone 6)

| Test Case | Scenario / Customer Response | Expected Behavior & Outcome | Verified |
| :--- | :--- | :--- | :---: |
| **1. Happy Path** | Confirms identity ("हाँ मैं राजा बोल रहा हूँ"), agrees to pickup ("हाँ कल ले जाओ"), confirms address ("हाँ पता सही है"). | Agent sets date to tomorrow in IST, reads address back, saves `pickup_scheduled` with date, address confirmed `true`, and hangs up cleanly. | ✅ |
| **2. Wrong Person** | Answers and says: "नहीं, गलत नंबर है" or "मैं वो नहीं हूँ". | Agent apologizes politely (*"माफ़ कीजिए, गलत नंबर डायल हो गया था"*), saves `wrong_person`, and disconnects cleanly. | ✅ |
| **3. Not Now / Callback** | Answers and says: "अभी मैं मीटिंग में हूँ, बाद में कॉल करो". | Agent acknowledges (*"जी ठीक है, हम आपसे बाद में संपर्क करेंगे"*), saves `callback_requested`, and disconnects cleanly. | ✅ |
| **4. Out of Scope / Escalation** | Asks unrelated complaint or billing question: "मेरा पिछला बिल गलत क्यों आया?". | Agent instructs caller (*"इसके लिए कृपया 121 पर कॉल करें"*), saves `escalated` with reason, and concludes. | ✅ |
| **5. Silence Watchdog** | Callee answers phone but remains silent. | After 9s, agent re-prompts once in Hindi (*"क्या आप मुझे सुन पा रहे हैं?"*). After another 9s of silence, speaks closing line, saves `no_response`, and hangs up. | ✅ |
| **6. Barge-in / Interruption** | Customer interrupts the agent mid-sentence. | Silero VAD detects speech instantly; agent stops TTS playback and listens to the customer. | ✅ |
| **7. Relative Dates in IST** | Customer says "parso subah", "agle somwar", or "25 tareekh". | Date is resolved to an upcoming calendar day in Asia/Kolkata timezone and formatted into natural Hindi. Past dates are rejected with a clarification prompt. | ✅ |
| **8. Unanswered / Busy Dial** | Customer rejects the call (486 Busy) or lets it ring out (408 No Answer). | Backend maps SIP status to `busy` or `no_answer`, stores failure reason, and closes call without leaving stuck rows. | ✅ |
| **9. Idempotency** | Duplicate calls to `POST /internal/calls/:callId/outcome`. | Returns `200 OK`, updates record, and does NOT generate duplicate rows in PostgreSQL. | ✅ |
| **10. Secret Protection** | Request to `/internal/calls/:callId/outcome` without secret. | Returns `401 Unauthorized`. | ✅ |

---

## 5. Deploying the Agent Worker to LiveKit Cloud

You can run the agent worker on LiveKit Cloud or on your own container infrastructure (e.g. AWS ECS, GCP Cloud Run, Fly.io, or DigitalOcean):

### Option A: LiveKit Cloud Hosted Agents
If using LiveKit Cloud's native agent hosting:
1. Install the LiveKit CLI:
   ```bash
   curl -sSL https://get.livekit.io/cli | bash
   ```
2. Authenticate:
   ```bash
   lk cloud auth
   ```
3. Deploy the agent package from `/agent`:
   ```bash
   cd agent
   lk agent deploy --name telecom-router-pickup-agent
   ```

### Option B: Docker Deployment
Use the included [`agent/Dockerfile`](file:///Users/rajanayak/Desktop/ai-calling-system/agent/Dockerfile):
```bash
cd agent
docker build -t ai-calling-agent:latest .
docker run -d \
  --name ai-calling-agent \
  --restart unless-stopped \
  -e LIVEKIT_URL="wss://your-project.livekit.cloud" \
  -e LIVEKIT_API_KEY="your_api_key" \
  -e LIVEKIT_API_SECRET="your_api_secret" \
  -e AGENT_NAME="telecom-router-pickup-agent" \
  -e SARVAM_API_KEY="your_sarvam_key" \
  -e GROQ_API_KEY="your_groq_key" \
  -e BACKEND_URL="https://your-backend-domain.com" \
  -e INTERNAL_SECRET="your_internal_secret" \
  ai-calling-agent:latest
```

---

## 6. Troubleshooting & Operational Guide

### 1. Telephony / SIP Status Errors
| SIP Status | Meaning | Resolution |
| :--- | :--- | :--- |
| **403 Forbidden** | Authentication or IP ACL failure on Exotel. | Check that `EXOTEL_SIP_USERNAME`/`PASSWORD` are correct or add LiveKit's outbound IP to your Exotel trunk ACL. |
| **404 Not Found** | Unallocated or misformatted phone number. | Ensure destination number is in strict E.164 format with country code (e.g. `+91XXXXXXXXXX`). |
| **486 Busy / 600 Rejected** | Customer declined the call or phone is busy. | Expected telephony behavior. Automatically mapped to `busy` with clean hangup. |
| **408 Timeout / 480 Unavailable** | Callee did not answer within 30s. | Handled automatically; mapped to `no_answer`. |

### 2. Audio & Speech Latency
- **Turn Latency:** Total assistant turn latency is logged in real-time in the agent console (`Turn Latency: ~500-800 ms`).
- **Narrowband Telephony (8 kHz vs 16 kHz):** Exotel SIP uses G.711 PCMA/PCMU (8 kHz). Silero VAD resamples automatically, and Sarvam TTS generates crystal-clear speech without clipping.
- **Microphone / Barge-in Sensitivity:** If the agent interrupts too easily due to line noise, increase `activation_threshold` from `0.45` to `0.55` in [`agent/agent.py`](file:///Users/rajanayak/Desktop/ai-calling-system/agent/agent.py).

### 3. Idempotency & Database Integrity
- `call_outcomes` enforces a unique constraint on `call_id`.
- Re-triggering outcomes via `/internal/calls/:callId/outcome` will never produce duplicate records or database integrity errors.

