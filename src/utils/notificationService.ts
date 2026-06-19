// src/utils/notificationService.ts

/**
 * Simple wrapper around OneSignal REST API for sending escalation alerts.
 * Expects ONE_SIGNAL_APP_ID and ONE_SIGNAL_API_KEY in environment variables.
 */
export async function sendEscalationAlert(message: string, heading: string = 'KPI Escalation') {
  const appId = import.meta.env.VITE_ONE_SIGNAL_APP_ID;
  const apiKey = import.meta.env.VITE_ONE_SIGNAL_API_KEY;
  if (!appId || !apiKey) {
    console.warn('OneSignal credentials missing in environment');
    return;
  }
  const payload = {
    app_id: appId,
    headings: { en: heading },
    contents: { en: message },
    included_segments: ['All'],
  };
  try {
    const res = await fetch('https://onesignal.com/api/v1/notifications', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${apiKey}`,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error('OneSignal error:', err);
    }
  } catch (e) {
    console.error('Failed to send OneSignal alert', e);
  }
}
