-- 031_tts_provider.sql: Add selectable TTS provider column to campaigns and calls (default: sarvam)

ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS tts_provider VARCHAR(64) DEFAULT 'sarvam';
ALTER TABLE calls ADD COLUMN IF NOT EXISTS tts_provider VARCHAR(64) DEFAULT 'sarvam';
