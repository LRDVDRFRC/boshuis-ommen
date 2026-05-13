// Send WhatsApp messages via CallMeBot.
// Env vars:
//   CALLMEBOT_PHONE  — your phone number with country code, e.g. 31612345678
//   CALLMEBOT_APIKEY — the API key you get after registering with CallMeBot

export async function sendWhatsApp(message) {
  const phone = process.env.CALLMEBOT_PHONE;
  const apikey = process.env.CALLMEBOT_APIKEY;
  if (!phone || !apikey) return;

  const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(phone)}&text=${encodeURIComponent(message)}&apikey=${encodeURIComponent(apikey)}`;

  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!resp.ok) {
      console.error(`CallMeBot ${resp.status}: ${await resp.text()}`);
    }
  } catch (err) {
    console.error('WhatsApp send failed (non-fatal):', err.message);
  }
}
