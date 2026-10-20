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

  // SIP Outbound Trunk credentials
  SIP_PROVIDER: z.string().default('twilio'),
  SIP_OUTBOUND_TRUNK_ID: z.string().optional().default(''),
  SIP_DOMAIN: z.string().optional().default(''),
  SIP_CALLER_ID: z.string().optional().default(''),
  SIP_USERNAME: z.string().optional().default(''),
  SIP_PASSWORD: z.string().optional().default(''),

  // AI Providers
  SARVAM_API_KEY: z.string().optional().default(''),
  GROQ_API_KEY: z.string().optional().default(''),
  LLM_MODEL: z.string().default('qwen/qwen3.8-27b'),

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

export const env = parsed.data;
