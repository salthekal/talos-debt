/**
 * Send Meta's "hello_world" test template to your own phone, to check that the
 * WhatsApp token and phone number id work. Does not touch the database.
 *
 *   npm run whatsapp:ping
 *
 * Reads WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_DEV_REDIRECT_TO
 * (your number, added as a test recipient in Meta) and WHATSAPP_API_VERSION from .env.
 */
import 'dotenv/config';
import { MetaCloudSender } from '../src/whatsapp/client.js';

const { WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_DEV_REDIRECT_TO } = process.env;
const version = process.env.WHATSAPP_API_VERSION ?? 'v21.0';

const missing = Object.entries({ WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_DEV_REDIRECT_TO })
  .filter(([, v]) => !v)
  .map(([k]) => k);
if (missing.length) {
  console.error(`Missing in .env: ${missing.join(', ')}`);
  process.exit(1);
}

const result = await new MetaCloudSender(WHATSAPP_TOKEN!, version).sendTemplate({
  phoneNumberId: WHATSAPP_PHONE_NUMBER_ID!,
  to: WHATSAPP_DEV_REDIRECT_TO!,
  templateName: 'hello_world',
  languageCode: 'en_US',
  bodyParams: [],
});

if (result.ok) {
  console.log(`Sent. Check WhatsApp on ${WHATSAPP_DEV_REDIRECT_TO}. Message id: ${result.providerMessageId}`);
} else {
  console.error(`Not sent: ${result.errorCode} ${result.errorMessage}`);
  if (result.errorCode === 'meta_190') console.error('The access token is wrong or has expired. Generate a new one.');
  if (result.errorCode === 'meta_131030') console.error('Add this number as a test recipient in Meta (API Setup, "To").');
  process.exit(1);
}
