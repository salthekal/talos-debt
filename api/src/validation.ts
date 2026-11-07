import type { FastifyReply } from 'fastify';
import { z } from 'zod';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export const idParam = z.object({ id: z.string().regex(UUID_RE, 'must be a UUID') });

/** Parse input with a zod schema, or send a 400 and return undefined. */
export function parseOr400<T extends z.ZodType>(
  schema: T,
  input: unknown,
  reply: FastifyReply,
): z.infer<T> | undefined {
  const result = schema.safeParse(input);
  if (!result.success) {
    void reply.code(400).send({
      error: 'bad_request',
      message: result.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '),
    });
    return undefined;
  }
  return result.data;
}
