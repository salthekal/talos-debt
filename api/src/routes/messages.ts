import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { REVIEWER_ROLES, requireRole, tenantOf } from '../auth.js';
import { idParam, parseOr400 } from '../validation.js';
import { SendBlocked, sendReminder, type OutboundDeps } from '../whatsapp/outbound.js';

const sendBody = z.object({
  purpose: z.enum(['first_reminder', 'follow_up', 'final_notice']).default('follow_up'),
});

const BLOCKED_STATUS: Record<SendBlocked['code'], number> = {
  not_found: 404,
  debt_not_active: 409,
  debtor_not_contactable: 409,
  no_active_phone: 409,
  outside_working_hours: 409,
  no_template: 409,
  not_configured: 503,
};

/** Manual sending by staff from the dashboard. */
export function messageRoutes(app: FastifyInstance, deps: OutboundDeps) {
  app.post('/api/debts/:id/send-reminder', { preHandler: requireRole(REVIEWER_ROLES) }, async (req, reply) => {
    const p = parseOr400(idParam, req.params, reply);
    if (!p) return;
    const body = parseOr400(sendBody, req.body ?? {}, reply);
    if (!body) return;
    try {
      const result = await sendReminder(deps, tenantOf(req.user!), p.id, body.purpose);
      if (result.status === 'failed') return reply.code(502).send(result);
      return result;
    } catch (err) {
      if (err instanceof SendBlocked) {
        return reply.code(BLOCKED_STATUS[err.code]).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });
}
