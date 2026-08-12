import { Router } from 'express';
import { z } from 'zod';
import { SettingsService } from '../../services/SettingsService.js';

export const settingsRouter = Router();

settingsRouter.get('/', async (_req, res, next) => {
  try { res.json(await SettingsService.getAll()); } catch (e) { next(e); }
});

const PatchSchema = z.object({
  default_fallback_text: z.string().max(2000).optional(),
  welcome_enabled: z.boolean().optional(),
  bot_globally_enabled: z.boolean().optional(),
  media_text_delay_ms: z.number().int().min(0).max(60000).optional(),
  ignore_groups_default: z.boolean().optional(),
  per_contact_rate_per_min: z.number().int().min(1).max(120).optional(),
  per_contact_rate_per_hour: z.number().int().min(1).max(2000).optional(),
  emergency_stop: z.boolean().optional(),
  typing_simulation: z.boolean().optional(),
  read_receipts: z.boolean().optional(),
  min_send_delay_ms: z.number().int().min(0).max(60000).optional(),
  max_send_delay_ms: z.number().int().min(0).max(60000).optional(),
  cold_start_ignore_seconds: z.number().int().min(0).max(3600).optional(),
  burst_threshold_count: z.number().int().min(1).max(1000).optional(),
  burst_window_minutes: z.number().int().min(1).max(1440).optional(),
  burst_cooldown_seconds: z.number().int().min(0).max(600).optional(),
  auto_pause_on_manual_reply: z.boolean().optional(),
  auto_resume_after_hours: z.number().int().min(0).max(720).optional(),
  never_auto_resume_if_ordered_or_rejected: z.boolean().optional(),
  handover_keywords: z.array(z.string().min(1).max(200)).max(50).optional(),
  handover_message: z.string().max(2000).optional(),
  working_hours: z.object({
    enabled: z.boolean(),
    start: z.string().regex(/^\d{2}:\d{2}$/),
    end: z.string().regex(/^\d{2}:\d{2}$/),
    tz: z.string().min(1).max(80),
  }).optional(),
  auto_reject_calls: z.boolean().optional(),
  call_rejection_message_type: z.enum(['none', 'text', 'audio', 'image', 'video']).optional(),
  call_rejection_message_text: z.string().max(2000).optional(),
  call_rejection_media_id: z.string().nullable().optional(),
});

settingsRouter.patch('/', async (req, res, next) => {
  try {
    const data = PatchSchema.parse(req.body);
    res.json(await SettingsService.update(data));
  } catch (e) { next(e); }
});
