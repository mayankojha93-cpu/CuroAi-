import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { campaignService } from '../services/campaignService.js';
import { validateRequest } from '../middleware/validate.js';

export const campaignsRouter = Router();

const createCampaignSchema = {
  body: z.object({
    name: z.string().min(1, { message: 'Campaign name is required' }),
    description: z.string().optional(),
    status: z.enum(['RUNNING', 'PAUSED', 'COMPLETED', 'STOPPED', 'Running', 'Paused', 'Completed', 'Stopped']).optional().default('RUNNING'),
    script: z.string().optional(),
    language: z.string().optional(),
    voice_pipeline: z.string().optional(),
    schedule_start_time: z.string().optional(),
    schedule_end_time: z.string().optional(),
    operating_days: z.array(z.string()).optional(),
    max_concurrent_calls: z.number().int().positive().optional(),
    calls_per_minute: z.number().int().positive().optional(),
    retry_attempts: z.number().int().nonnegative().optional(),
    retry_delay_minutes: z.number().int().positive().optional(),
    max_call_duration_minutes: z.number().int().positive().optional(),
    expected_dispositions: z.array(z.string()).optional(),
    total_contacts: z.number().int().nonnegative().optional().default(0),
    total_credits: z.number().int().nonnegative().optional(),
    contacts: z.array(z.string()).optional(),
  }),
};

const updateStatusSchema = {
  params: z.object({
    id: z.string().uuid({ message: 'Campaign ID must be a valid UUID' }),
  }),
  body: z.object({
    status: z.enum(['RUNNING', 'PAUSED', 'COMPLETED', 'STOPPED', 'Running', 'Paused', 'Completed', 'Stopped']),
  }),
};

const updateRetrySchema = {
  params: z.object({
    id: z.string().uuid({ message: 'Campaign ID must be a valid UUID' }),
  }),
  body: z.object({
    retry_attempts: z.number().int().min(1).max(10),
    retry_delay_minutes: z.number().int().positive().optional(),
  }),
};

/**
 * GET /api/campaigns - List all voice campaigns with optional status and search filtering
 */
campaignsRouter.get('/api/campaigns', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const status = req.query.status as string | undefined;
    const search = req.query.search as string | undefined;
    const campaigns = await campaignService.listCampaigns(status, search);
    return res.json({
      success: true,
      count: campaigns.length,
      campaigns,
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /api/campaigns/:id - Get specific voice campaign
 */
campaignsRouter.get('/api/campaigns/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const campaign = await campaignService.getCampaign(id);
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    return res.json({ success: true, campaign });
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /api/campaigns/:id/calls - Get calls for a specific voice campaign
 */
campaignsRouter.get('/api/campaigns/:id/calls', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const calls = await campaignService.getCampaignCalls(id);
    return res.json({ success: true, count: calls.length, calls });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /api/campaigns - Create a new voice campaign
 */
campaignsRouter.post(
  '/api/campaigns',
  validateRequest(createCampaignSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const campaign = await campaignService.createCampaign(req.body);
      return res.status(201).json({
        success: true,
        message: 'Campaign created successfully',
        campaign,
      });
    } catch (err) {
      return next(err);
    }
  }
);

/**
 * PATCH /api/campaigns/:id/status - Update campaign stage (Running, Paused, Completed, Stopped)
 */
campaignsRouter.patch(
  '/api/campaigns/:id/status',
  validateRequest(updateStatusSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = String(req.params.id);
      const { status } = req.body;
      const campaign = await campaignService.updateCampaignStatus(id, status);
      return res.json({
        success: true,
        message: `Campaign status updated to ${campaign.status}`,
        campaign,
      });
    } catch (err) {
      return next(err);
    }
  }
);

/**
 * PATCH /api/campaigns/:id/retry - Update campaign retry policy (attempts and delay)
 */
campaignsRouter.patch(
  '/api/campaigns/:id/retry',
  validateRequest(updateRetrySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = String(req.params.id);
      const { retry_attempts, retry_delay_minutes } = req.body;
      const result = await campaignService.updateCampaignRetry(id, retry_attempts, retry_delay_minutes);
      return res.json({
        success: true,
        message: `Retry settings updated to ${retry_attempts} attempts. ${result.eligibleForRetryCount} leads eligible for calls.`,
        campaign: result.campaign,
        eligibleForRetryCount: result.eligibleForRetryCount,
      });
    } catch (err) {
      return next(err);
    }
  }
);

/**
 * POST /api/campaigns/:id/start - Start campaign and dispatch pending calls according to rate limits
 */
campaignsRouter.post('/api/campaigns/:id/start', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const result = await campaignService.startCampaign(id);
    return res.json({
      success: true,
      message: `Campaign started. Dispatched ${result.dispatchedCount} calls.`,
      campaign: result.campaign,
      dispatchedCount: result.dispatchedCount,
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /api/campaigns/:id/contacts - Get all contacts for a campaign with latest call data
 */
campaignsRouter.get('/api/campaigns/:id/contacts', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const contacts = await campaignService.getCampaignContacts(id);
    return res.json({
      success: true,
      count: contacts.length,
      contacts,
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /api/campaigns/:id/contacts - Add contacts to campaign via CSV upload
 */
campaignsRouter.post('/api/campaigns/:id/contacts', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const contacts = Array.isArray(req.body.contacts) ? req.body.contacts : [];
    if (contacts.length === 0) {
      return res.status(400).json({ error: 'Please provide an array of contacts' });
    }
    const result = await campaignService.addContactsToCampaign(id, contacts);
    return res.json({
      success: true,
      message: `Added ${result.addedCount} contacts to campaign`,
      ...result,
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /api/campaigns/:id/dispositions - Get disposition breakdown for a campaign
 */
campaignsRouter.get('/api/campaigns/:id/dispositions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const data = await campaignService.getCampaignDispositions(id);
    return res.json({ success: true, ...data });
  } catch (err) {
    return next(err);
  }
});

/**
 * DELETE /api/campaigns/:id - Delete campaign
 */
campaignsRouter.delete('/api/campaigns/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const deleted = await campaignService.deleteCampaign(id);
    if (!deleted) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    return res.json({ success: true, message: 'Campaign deleted successfully' });
  } catch (err) {
    return next(err);
  }
});
