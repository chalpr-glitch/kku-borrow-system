/**
 * KKU OAS Equipment Borrowing System - Email Gateway Dispatcher Module
 * Runtime: Node.js (Cloud Functions / Background Workers / CLI)
 * 
 * Supports:
 *  - GOOGLE_APPS_SCRIPT: Webhook to Google Apps Script (@kku.ac.th account)
 *  - BREVO: Brevo transactional email API
 *  - RESEND: Resend transactional email API
 *  - MOCK: In-memory simulation for staging / unit tests (opt-in only)
 * 
 * Security & Reliability Model:
 *  - Strictly fails closed if provider is NONE or credentials missing (CONFIGURATION_ERROR)
 *  - Treats network drops / timeouts / non-JSON responses as INDETERMINATE_ERROR
 *  - Prevents secret leakage in error logs
 */

/**
 * Check if MOCK email gateway is explicitly permitted
 */
export function isMockGatewayAllowed() {
  return (
    process.env.ALLOW_MOCK_GATEWAY === 'true' ||
    Boolean(process.env.FIRESTORE_EMULATOR_HOST)
  );
}

/**
 * Strict Gateway Dispatcher across All Supported Providers
 * 
 * @param {object} job MailJob document data
 * @param {object} gatewayConfig Gateway credentials and provider settings
 * @param {function|null} mockFetch Optional mock fetch function for testing
 * @param {object} options Additional options (allowMock, timeoutMs)
 * @returns {Promise<{success: boolean, status: string, message: string, messageId?: string}>}
 */
export async function dispatchViaGateway(job, gatewayConfig, mockFetch = null, options = {}) {
  const fetchFn = mockFetch || globalThis.fetch;
  const rawTo = Array.isArray(job.to) ? job.to : (job.to ? [job.to] : []);
  const validRecipients = Array.from(
    new Set(rawTo.map((e) => (typeof e === 'string' ? e.trim().toLowerCase() : '')).filter((e) => e.includes('@')))
  );

  if (!validRecipients.length) {
    return { success: false, status: 'FAILED', message: 'ไม่มีอีเมลผู้รับที่ถูกต้อง' };
  }

  // 1. Fail closed if Gateway Config is missing or provider is NONE
  if (!gatewayConfig || !gatewayConfig.provider || gatewayConfig.provider === 'NONE') {
    return {
      success: false,
      status: 'CONFIGURATION_ERROR',
      message: 'Email gateway is disabled or not configured (provider is NONE)',
    };
  }

  // 2. MOCK Gateway is restricted to tests/emulator with explicit opt-in
  if (!mockFetch && gatewayConfig.provider === 'MOCK') {
    const allowed = isMockGatewayAllowed() || options.allowMock;
    if (!allowed) {
      return {
        success: false,
        status: 'CONFIGURATION_ERROR',
        message: 'MOCK email gateway is only permitted in test/emulator environment with explicit opt-in (ALLOW_MOCK_GATEWAY=true)',
      };
    }

    return {
      success: true,
      status: 'SUCCESS',
      message: 'Processed by Mock/Staging Gateway (No actual email sent)',
      messageId: `mock_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
    };
  }

  const effectiveProvider =
    mockFetch && (gatewayConfig.provider === 'MOCK' || !gatewayConfig.provider)
      ? 'GOOGLE_APPS_SCRIPT'
      : gatewayConfig.provider;

  // 3. Google Apps Script Webhook
  if (effectiveProvider === 'GOOGLE_APPS_SCRIPT') {
    const webhookUrl = gatewayConfig.gasWebhookUrl;
    if (!webhookUrl && !mockFetch) {
      return {
        success: false,
        status: 'CONFIGURATION_ERROR',
        message: 'Google Apps Script Webhook URL is not configured',
      };
    }

    try {
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timeoutId = controller ? setTimeout(() => controller.abort(), options.timeoutMs || 25000) : null;

      const res = await fetchFn(webhookUrl || 'https://script.google.com/macros/s/MOCK/exec', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({
          to: validRecipients,
          cc: job.cc || [],
          subject: job.message?.subject || '',
          html: job.message?.html || '',
          text: job.message?.text || '',
          requestId: job.requestId || '',
          type: job.type || 'NOTIFICATION',
          senderName: gatewayConfig.gasSenderName || gatewayConfig.brevoSenderName || 'ระบบยืม-คืน ครุภัณฑ์ สำนักบริการวิชาการ มข.',
          senderEmail: gatewayConfig.gasSenderEmail || gatewayConfig.brevoSenderEmail || '',
          secretToken: gatewayConfig.gasSecretToken || '',
        }),
        signal: controller?.signal,
      }).finally(() => {
        if (timeoutId) clearTimeout(timeoutId);
      });

      if (!res.ok) {
        return {
          success: false,
          status: 'FAILED',
          message: `HTTP error from GAS: status ${res.status}`,
        };
      }

      const rawText = await res.text();
      let resData;
      try {
        resData = JSON.parse(rawText);
      } catch (e) {
        // NON-JSON / HTML response is an INDETERMINATE ERROR (do not blind retry)
        return {
          success: false,
          status: 'INDETERMINATE_ERROR',
          message: `Non-JSON payload returned from Gateway: ${rawText.slice(0, 100)}`,
        };
      }

      if (resData && resData.status === 'SUCCESS') {
        return {
          success: true,
          status: 'SUCCESS',
          message: 'Sent successfully via Google Apps Script',
          messageId: resData.messageId || `gas_${Date.now()}`,
        };
      }

      return {
        success: false,
        status: 'FAILED',
        message: resData?.message || 'Gateway returned non-success response schema',
      };
    } catch (err) {
      return {
        success: false,
        status: 'INDETERMINATE_ERROR',
        message: `Network/Fetch error: ${err.message}`,
      };
    }
  }

  // 4. Brevo API
  if (gatewayConfig.provider === 'BREVO') {
    if (!gatewayConfig.brevoApiKey) {
      return { success: false, status: 'CONFIGURATION_ERROR', message: 'Missing brevoApiKey' };
    }
    try {
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timeoutId = controller ? setTimeout(() => controller.abort(), options.timeoutMs || 20000) : null;

      const res = await fetchFn('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'api-key': gatewayConfig.brevoApiKey.trim(),
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          sender: {
            name: gatewayConfig.brevoSenderName || 'ระบบยืม-คืน ครุภัณฑ์ OAS KKU',
            email: gatewayConfig.brevoSenderEmail || 'noreply.oas@kku.ac.th',
          },
          to: validRecipients.map((email) => ({ email })),
          subject: job.message?.subject || '',
          htmlContent: job.message?.html || '',
          textContent: job.message?.text || '',
        }),
        signal: controller?.signal,
      }).finally(() => {
        if (timeoutId) clearTimeout(timeoutId);
      });

      const rawText = await res.text();
      let resData;
      try {
        resData = JSON.parse(rawText);
      } catch {
        resData = { message: rawText };
      }

      if (res.ok && resData.messageId) {
        return {
          success: true,
          status: 'SUCCESS',
          message: 'Sent successfully via Brevo',
          messageId: resData.messageId,
        };
      }

      return {
        success: false,
        status: 'FAILED',
        message: resData?.message || `Brevo HTTP error ${res.status}`,
      };
    } catch (err) {
      return {
        success: false,
        status: 'INDETERMINATE_ERROR',
        message: `Brevo Network error: ${err.message}`,
      };
    }
  }

  // 5. Resend API
  if (gatewayConfig.provider === 'RESEND') {
    if (!gatewayConfig.resendApiKey) {
      return { success: false, status: 'CONFIGURATION_ERROR', message: 'Missing resendApiKey' };
    }
    try {
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timeoutId = controller ? setTimeout(() => controller.abort(), options.timeoutMs || 20000) : null;

      const res = await fetchFn('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${gatewayConfig.resendApiKey.trim()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: gatewayConfig.resendSender || 'ระบบยืม-คืน ครุภัณฑ์ <onboarding@resend.dev>',
          to: validRecipients,
          subject: job.message?.subject || '',
          html: job.message?.html || '',
          text: job.message?.text || '',
        }),
        signal: controller?.signal,
      }).finally(() => {
        if (timeoutId) clearTimeout(timeoutId);
      });

      const rawText = await res.text();
      let resData;
      try {
        resData = JSON.parse(rawText);
      } catch {
        resData = { message: rawText };
      }

      if (res.ok && resData.id) {
        return {
          success: true,
          status: 'SUCCESS',
          message: 'Sent successfully via Resend',
          messageId: resData.id,
        };
      }

      return {
        success: false,
        status: 'FAILED',
        message: resData?.message || `Resend HTTP error ${res.status}`,
      };
    } catch (err) {
      return {
        success: false,
        status: 'INDETERMINATE_ERROR',
        message: `Resend Network error: ${err.message}`,
      };
    }
  }

  return { success: false, status: 'CONFIGURATION_ERROR', message: `Unsupported provider: ${gatewayConfig.provider}` };
}
