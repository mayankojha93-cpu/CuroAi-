import path from 'path';
import dotenv from 'dotenv';
import { z } from 'zod';

// Load from local backend/.env first, then fallback to root .env
dotenv.config();
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().default('postgresql://localhost:5432/ai_calling'),
  BACKEND_URL: z.string().default('http://localhost:3000'),
  INTERNAL_SECRET: z.string().default('dev-secret-key-12345'),

  // LiveKit credentials
  LIVEKIT_URL: z.string().optional().default(''),
  LIVEKIT_API_KEY: z.string().optional().default(''),
  LIVEKIT_API_SECRET: z.string().optional().default(''),
  AGENT_NAME: z.string().default('telecom-router-pickup-agent'),

  // Exotel SIP Outbound & Inbound Trunk credentials
  SIP_PROVIDER: z.string().default('exotel'),
  SIP_OUTBOUND_TRUNK_ID: z.string().optional().default(''),
  SIP_INBOUND_TRUNK_ID: z.string().optional().default(''),
  SIP_DISPATCH_RULE_ID: z.string().optional().default(''),
  SIP_DOMAIN: z.string().optional().default(''),
  SIP_CALLER_ID: z.string().optional().default(''),
  SIP_USERNAME: z.string().optional().default(''),
  SIP_PASSWORD: z.string().optional().default(''),

  // Exotel specific credentials & aliases
  EXOTEL_ACCOUNT_SID: z.string().optional().default(''),
  EXOTEL_API_KEY: z.string().optional().default(''),
  EXOTEL_API_TOKEN: z.string().optional().default(''),
  EXOTEL_SUBDOMAIN: z.string().optional().default(''),
  EXOTEL_CALLER_ID: z.string().optional().default(''),
  EXOTEL_SIP_DOMAIN: z.string().optional().default(''),
  EXOTEL_SIP_USERNAME: z.string().optional().default(''),
  EXOTEL_SIP_PASSWORD: z.string().optional().default(''),
  EXOTEL_OUTBOUND_TRUNK_ID: z.string().optional().default(''),
  EXOTEL_INBOUND_TRUNK_ID: z.string().optional().default(''),
  // Exotel v1 REST API credentials for recording download (call-details API)
  EXOTEL_SID: z.string().optional().default(''),    // Same as EXOTEL_ACCOUNT_SID or separate API SID
  EXOTEL_TOKEN: z.string().optional().default(''),  // API token for Basic Auth on call-details API

  // Recording storage: local path for downloaded audio files (swap for S3/GCS bucket URL in prod)
  RECORDING_STORAGE_DIR: z.string().optional().default(''),

  // AI Providers
  SARVAM_API_KEY: z.string().optional().default(''),
  GROQ_API_KEY: z.string().optional().default(''),
  LLM_MODEL: z.string().default('meta-llama/llama-3.1-8b-instruct'),

  // Seed / Test customer
  TEST_PHONE: z.string().default('+919999999999'),
  TEST_CUSTOMER_NAME: z.string().default('Raja Nayak'),
  TEST_CUSTOMER_ADDRESS: z
    .string()
    .default('Flat 402, Sunshine Heights, Koramangala 4th Block, Bengaluru, Karnataka 560034'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Environment validation failed:', parsed.error.format());
  process.exit(1);
}

const rawEnv = parsed.data;

export const env = {
  ...rawEnv,
  SIP_PROVIDER: rawEnv.SIP_PROVIDER || 'exotel',
  SIP_OUTBOUND_TRUNK_ID: rawEnv.SIP_OUTBOUND_TRUNK_ID || rawEnv.EXOTEL_OUTBOUND_TRUNK_ID || '',
  SIP_INBOUND_TRUNK_ID: rawEnv.SIP_INBOUND_TRUNK_ID || rawEnv.EXOTEL_INBOUND_TRUNK_ID || '',
  SIP_DISPATCH_RULE_ID: rawEnv.SIP_DISPATCH_RULE_ID || '',
  SIP_DOMAIN: rawEnv.SIP_DOMAIN || rawEnv.EXOTEL_SIP_DOMAIN || '',
  SIP_CALLER_ID: rawEnv.SIP_CALLER_ID || rawEnv.EXOTEL_CALLER_ID || '',
  SIP_USERNAME: rawEnv.SIP_USERNAME || rawEnv.EXOTEL_SIP_USERNAME || '',
  SIP_PASSWORD: rawEnv.SIP_PASSWORD || rawEnv.EXOTEL_SIP_PASSWORD || '',
};
