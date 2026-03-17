/**
 * @tranzmit/prechurn-widget
 * ─────────────────────────────────────────────────────────────────────────────
 * Drop this script into any website, web app, or iOS/Android WebView to enable
 * targeted pre-churn voice interview invites.
 *
 * HOW IT WORKS:
 *   1. The widget polls your Tranzmit backend every 5 seconds.
 *   2. When you trigger a widget for a user from the dashboard, a small invite
 *      popup appears on their screen.
 *   3. Clicking "Start Voice Interview" launches the full voice interview.
 *
 * SETUP (script tag):
 *   <script>
 *     window.TRANZMIT_WIDGET_CONFIG = {
 *       apiKey:     'eb_live_...',          // Your Tranzmit API key
 *       endpoint:   'https://api.tranzmitai.com', // Your Tranzmit backend URL
 *       distinctId: currentUser.id,         // The logged-in user's distinct ID
 *     };
 *   </script>
 *   <script src="https://api.tranzmitai.com/widget.js"></script>
 *
 * OPTIONAL CONFIG:
 *   pollInterval: 5000  — how often to check (ms, default 5000)
 *
 * STOP MANUALLY:
 *   window.TRANZMIT_WIDGET_STOP()
 * ─────────────────────────────────────────────────────────────────────────────
 */

export interface TranzmitWidgetConfig {
  /** Your Tranzmit project API key */
  apiKey: string;
  /** Your Tranzmit backend base URL (e.g. https://api.tranzmitai.com) */
  endpoint: string;
  /** The logged-in user's distinct ID */
  distinctId: string;
  /** Poll interval in ms (default 5000) */
  pollInterval?: number;
  /** URL of the voice interview embed script (defaults to {endpoint}/embed.js) */
  embedUrl?: string;
}

declare global {
  interface Window {
    TRANZMIT_WIDGET_CONFIG?: TranzmitWidgetConfig;
    TRANZMIT_WIDGET_STOP?: () => void;
  }
}

(function () {
  'use strict';

  /* ── Config ────────────────────────────────────────────────────────────── */
  const cfg = window.TRANZMIT_WIDGET_CONFIG;
  if (!cfg || !cfg.apiKey || !cfg.endpoint || !cfg.distinctId) {
    if (cfg) {
      console.warn('[Tranzmit Widget] Missing required config: apiKey, endpoint, and distinctId are all required.');
    }
    return;
  }

  const BASE        = cfg.endpoint.replace(/\/$/, '');
  const CHECK_URL   = BASE + '/api/widget/check';
  const DONE_URL    = BASE + '/api/widget/complete';
  const EMBED_URL   = cfg.embedUrl ?? (BASE + '/embed.js');
  const INTERVAL_MS = cfg.pollInterval ?? 5000;
  const WIDGET_ID   = '__tz_widget__';

  let shown             = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let interviewLaunched = false;

  /* ── Polling ────────────────────────────────────────────────────────────── */
  function poll(): void {
    if (shown) return;
    const url = CHECK_URL
      + '?key='        + encodeURIComponent(cfg.apiKey)
      + '&distinctId=' + encodeURIComponent(cfg.distinctId);

    fetch(url)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: any) => {
        if (data && data.show && !shown) {
          shown = true;
          if (pollTimer) clearInterval(pollTimer);
          showWidget(data);
        }
      })
      .catch(() => { /* fail silently — never break the host page */ });
  }

  /* ── Report outcome ─────────────────────────────────────────────────────── */
  function reportOutcome(triggerId: string, outcome: string): void {
    fetch(DONE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ triggerId, outcome }),
    }).catch(() => {});
  }

  /* ── Remove popup ───────────────────────────────────────────────────────── */
  function removeWidget(): void {
    const el = document.getElementById(WIDGET_ID);
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  /* ── Launch interview (loads embed.js from backend) ─────────────────────── */
  function launchInterview(interviewApiKey: string): void {
    if (interviewLaunched) return;
    interviewLaunched = true;

    // Create a hidden trigger button for embed.js to attach its click handler to
    const trigger = document.createElement('button');
    trigger.id = '__tz_interview_trigger__';
    trigger.style.display = 'none';
    document.body.appendChild(trigger);

    const s = document.createElement('script');
    s.src = EMBED_URL;
    s.setAttribute('data-api-key', interviewApiKey || cfg.apiKey);
    s.setAttribute('data-backend-url', BASE);
    s.setAttribute('data-attach', '#__tz_interview_trigger__');

    // Once embed.js loads and attaches, programmatically click the trigger
    s.onload = function () {
      setTimeout(() => trigger.click(), 100);
    };

    document.head.appendChild(s);
  }

  /* ── Escape HTML ────────────────────────────────────────────────────────── */
  function esc(str: string): string {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ── Render popup ───────────────────────────────────────────────────────── */
  function showWidget(data: { triggerId: string; userName?: string; interviewApiKey?: string }): void {
    const { triggerId, userName = 'there', interviewApiKey = '' } = data;

    /* Inject one-time keyframe + glass styles */
    if (!document.getElementById('__tz_style__')) {
      const style = document.createElement('style');
      style.id = '__tz_style__';
      style.textContent = [
        '@keyframes __tz_in{from{opacity:0;transform:translateY(16px) scale(0.96)}to{opacity:1;transform:translateY(0) scale(1)}}',
        '@keyframes __tz_pulse{0%,100%{opacity:0.6}50%{opacity:1}}',
        '#' + WIDGET_ID + ' button:hover{opacity:0.85}',
        '#__tz_start__:hover{background:#111!important}',
        '#__tz_close__:hover{background:rgba(0,0,0,0.08)!important}',
      ].join('\n');
      document.head.appendChild(style);
    }

    const root = document.createElement('div');
    root.id = WIDGET_ID;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Voice interview invite');
    root.style.cssText = [
      'position:fixed',
      'bottom:24px',
      'right:24px',
      'width:296px',
      'border-radius:20px',
      'overflow:hidden',
      'background:#ffffff',
      'border:1px solid rgba(0,0,0,0.08)',
      'box-shadow:0 8px 48px rgba(0,0,0,0.15),0 2px 16px rgba(0,0,0,0.08)',
      'z-index:2147483647',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif',
      'animation:__tz_in 0.35s cubic-bezier(0.34,1.56,0.64,1) both',
      'color:#000',
    ].join(';');

    root.innerHTML = [
      /* Header area */
      '<div style="padding:18px 18px 0;">',
      '  <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;">',
      '    <div style="display:flex;align-items:center;gap:12px;flex:1;min-width:0;">',
      /* Mic icon */
      '      <div style="flex-shrink:0;position:relative;">',
      '        <div style="width:40px;height:40px;background:rgba(0,0,0,0.06);border:1px solid rgba(0,0,0,0.1);border-radius:50%;display:flex;align-items:center;justify-content:center;">',
      '          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">',
      '            <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/>',
      '            <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>',
      '            <line x1="12" x2="12" y1="19" y2="22"/>',
      '          </svg>',
      '        </div>',
      '        <div style="position:absolute;top:-2px;right:-2px;width:10px;height:10px;background:#34d399;border-radius:50%;border:2px solid rgba(0,0,0,0.2);animation:__tz_pulse 2s ease-in-out infinite;"></div>',
      '      </div>',
      '      <div style="min-width:0;">',
      '        <div style="font-size:14px;font-weight:600;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#000;">',
      '          Hey ' + esc(userName) + ', got a minute?',
      '        </div>',
      '        <div style="color:rgba(0,0,0,0.5);font-size:11.5px;margin-top:2px;font-weight:400;">Quick 2-min voice chat</div>',
      '      </div>',
      '    </div>',
      '    <button id="__tz_close__" aria-label="Dismiss" style="flex-shrink:0;background:rgba(0,0,0,0.05);border:1px solid rgba(0,0,0,0.1);border-radius:50%;width:28px;height:28px;cursor:pointer;display:flex;align-items:center;justify-content:center;color:rgba(0,0,0,0.5);font-size:14px;line-height:1;padding:0;transition:all 0.2s ease;">',
      '      &#x2715;',
      '    </button>',
      '  </div>',
      '</div>',
      /* Divider */
      '<div style="margin:14px 18px 0;height:1px;background:rgba(0,0,0,0.08);"></div>',
      /* Body */
      '<div style="padding:14px 18px 18px;">',
      '  <p style="margin:0 0 14px;color:rgba(0,0,0,0.6);font-size:13px;line-height:1.55;font-weight:400;">',
      '    We\'d love to hear about your experience — it only takes a couple of minutes.',
      '  </p>',
      '  <button id="__tz_start__" style="display:block;width:100%;background:#000;color:#fff;border:none;border-radius:12px;padding:11px 16px;font-size:13.5px;font-weight:600;cursor:pointer;transition:all 0.2s ease;letter-spacing:0.01em;">',
      '    Start Voice Interview &rarr;',
      '  </button>',
      '</div>',
    ].join('');

    document.body.appendChild(root);

    (document.getElementById('__tz_close__') as HTMLButtonElement).addEventListener('click', () => {
      reportOutcome(triggerId, 'dismissed');
      removeWidget();
    });

    (document.getElementById('__tz_start__') as HTMLButtonElement).addEventListener('click', () => {
      reportOutcome(triggerId, 'clicked');
      removeWidget();
      launchInterview(interviewApiKey);
    });
  }

  /* ── Boot ───────────────────────────────────────────────────────────────── */
  function start(): void {
    poll();
    pollTimer = setInterval(poll, INTERVAL_MS);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  window.addEventListener('beforeunload', () => {
    if (pollTimer) clearInterval(pollTimer);
  });

  /* ── Public API ─────────────────────────────────────────────────────────── */
  window.TRANZMIT_WIDGET_STOP = function () {
    if (pollTimer) clearInterval(pollTimer);
    shown = true;
  };
})();
