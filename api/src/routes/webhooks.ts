import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { handleInbound, type InboundDeps, type InboundMessage } from '../agent/inbound.js';

/**
 * Meta WhatsApp webhook.
 *   GET  /webhooks/whatsapp  one-time check when the webhook is set up in Meta
 *   POST /webhooks/whatsapp  incoming messages and delivery status updates
 *
 * Every event is stored in app.webhook_events first (rule 7), with a unique
 * id so Meta's retries are ignored, then processed.
 */

interface MetaMessage {
  id: string;
  from: string;
  timestamp?: string;
  type: string;
  text?: { body?: string };
  image?: { caption?: string };
  document?: { caption?: string };
  button?: { text?: string };
  interactive?: { button_reply?: { title?: string }; list_reply?: { title?: string } };
}

interface MetaStatus {
  id: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  timestamp?: string;
  errors?: { code?: number }[];
}

interface MetaPayload {
  object?: string;
  entry?: { changes?: { value?: { messages?: MetaMessage[]; statuses?: MetaStatus[] } }[] }[];
}

export function verifySignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const given = header.slice('sha256='.length);
  if (given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(expected, 'hex'));
}

export function toInbound(m: MetaMessage): InboundMessage {
  const text =
    m.text?.body ??
    m.button?.text ??
    m.interactive?.button_reply?.title ??
    m.interactive?.list_reply?.title ??
    m.image?.caption ??
    m.document?.caption ??
    '';
  return {
    providerMessageId: m.id,
    from: m.from.startsWith('+') ? m.from : `+${m.from}`,
    text,
    hasMedia: m.type === 'image' || m.type === 'document',
    receivedAt: m.timestamp ? new Date(Number(m.timestamp) * 1000) : new Date(),
  };
}

export interface WebhookOptions {
  /** Process events before answering Meta (tests). Otherwise answer first, then process. */
  processInline?: boolean;
}

export function webhookRoutes(app: FastifyInstance, deps: InboundDeps, opts: WebhookOptions = {}) {
  const { config, workerPool } = deps;

  app.get('/webhooks/whatsapp', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    if (q['hub.mode'] === 'subscribe' && config.WHATSAPP_VERIFY_TOKEN && q['hub.verify_token'] === config.WHATSAPP_VERIFY_TOKEN) {
      return reply.type('text/plain').send(q['hub.challenge'] ?? '');
    }
    return reply.code(403).send({ error: 'forbidden' });
  });

  // Keep the raw body: the signature is computed over the exact bytes Meta sent.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  app.post('/webhooks/whatsapp', async (req: FastifyRequest, reply) => {
    const raw = req.body as Buffer;
    if (config.WHATSAPP_APP_SECRET) {
      if (!verifySignature(raw, req.headers['x-hub-signature-256'] as string | undefined, config.WHATSAPP_APP_SECRET)) {
        return reply.code(401).send({ error: 'bad_signature' });
      }
    } else if (config.NODE_ENV === 'production') {
      return reply.code(503).send({ error: 'not_configured' });
    }

    let payload: MetaPayload;
    try {
      payload = JSON.parse(raw.toString('utf8')) as MetaPayload;
    } catch {
      return reply.code(400).send({ error: 'bad_json' });
    }

    const stored: { id: string; kind: 'message' | 'status'; item: MetaMessage | MetaStatus }[] = [];
    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const items: ['message' | 'status', MetaMessage | MetaStatus, string][] = [
          ...(change.value?.messages ?? []).map((m) => ['message', m, `msg:${m.id}`] as ['message', MetaMessage, string]),
          ...(change.value?.statuses ?? []).map(
            (s) => ['status', s, `status:${s.id}:${s.status}`] as ['status', MetaStatus, string],
          ),
        ];
        for (const [kind, item, eventId] of items) {
          const { rows } = await workerPool.query<{ id: string }>(
            `INSERT INTO app.webhook_events (provider, event_id, payload) VALUES ('whatsapp', $1, $2)
             ON CONFLICT (provider, event_id) DO NOTHING RETURNING id`,
            [eventId, JSON.stringify(item)],
          );
          if (rows[0]) stored.push({ id: rows[0].id, kind, item });
        }
      }
    }

    const work = async () => {
      for (const ev of stored) {
        try {
          let note: string | null = null;
          if (ev.kind === 'message') {
            const result = await handleInbound(deps, toInbound(ev.item as MetaMessage));
            note = result.status === 'unknown_sender' ? 'unknown_sender' : null;
          } else {
            await applyStatus(deps, ev.item as MetaStatus);
          }
          await workerPool.query(`UPDATE app.webhook_events SET processed_at = now(), error = $2 WHERE id = $1`, [ev.id, note]);
        } catch (err) {
          req.log.error({ err, eventId: ev.id }, 'webhook processing failed');
          await workerPool
            .query(`UPDATE app.webhook_events SET error = $2 WHERE id = $1`, [ev.id, String(err).slice(0, 500)])
            .catch(() => undefined);
        }
      }
    };

    if (opts.processInline) {
      await work();
    } else {
      setImmediate(() => void work());
    }
    return { received: stored.length };
  });
}

/** Delivery updates from Meta. Status only moves forward (sent, delivered, read), or to failed. */
async function applyStatus(deps: InboundDeps, s: MetaStatus) {
  const at = s.timestamp ? new Date(Number(s.timestamp) * 1000) : new Date();
  await deps.workerPool.query(
    `UPDATE app.messages
        SET status = CASE
              WHEN $2 = 'failed' THEN 'failed'
              WHEN array_position(ARRAY['queued','sent','delivered','read'], $2)
                 > coalesce(array_position(ARRAY['queued','sent','delivered','read'], status), 0) THEN $2
              ELSE status END,
            delivered_at = CASE WHEN $2 IN ('delivered','read') THEN coalesce(delivered_at, $3) ELSE delivered_at END,
            read_at = CASE WHEN $2 = 'read' THEN coalesce(read_at, $3) ELSE read_at END,
            error_code = CASE WHEN $2 = 'failed' THEN $4 ELSE error_code END
      WHERE provider_message_id = $1 AND direction = 'outbound'`,
    [s.id, s.status, at, s.errors?.[0]?.code !== undefined ? `meta_${s.errors[0].code}` : null],
  );
}
