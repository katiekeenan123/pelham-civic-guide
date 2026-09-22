// Pelham Engagement Project — shared page script.
//
// Extracted from index.html so every page gets the same behaviour from one
// file. Hand-written; nothing in it is generated.
//
// Loaded with defer, so the DOM is parsed before this runs.

  /* SYSTEM_PROMPT moved server-side -> netlify/functions/ask-pelham.js */

  let conversationHistory = [];

  function usePrompt(btn) {
    document.getElementById('ai-input').value = btn.textContent;
    document.getElementById('ai-input').focus();
  }

  let feedbackCount = 0;

  // 👍/👎 on an answer. Like the two About forms, this used to fire and forget
  // and thank the reader unconditionally, so a vote that never reached the
  // database still looked recorded — and because the buttons were disabled on
  // the spot, there was no way to retry. The vote is only marked as cast once
  // the write is confirmed; on failure the buttons come back.
  async function submitFeedback(id, type, question, answer) {
    const row = document.getElementById('feedback-' + id);
    if (!row) return;
    const buttons = row.querySelectorAll('.feedback-btn');
    const note = row.querySelector('.feedback-thanks');

    buttons.forEach((b) => { b.disabled = true; });
    note.classList.remove('is-error');
    note.textContent = 'Saving…';
    note.style.display = 'inline';

    const ok = await postSubmission({
      type: 'feedback', vote: type, question, answer_snippet: answer,
    });

    if (ok) {
      const btn = row.querySelector(type === 'up' ? '.btn-up' : '.btn-down');
      btn.classList.add(type === 'up' ? 'selected-up' : 'selected-down');
      note.textContent = "Thanks — we'll use this to improve.";
      return;
    }

    buttons.forEach((b) => { b.disabled = false; });
    note.classList.add('is-error');
    note.textContent = "Couldn't save that — try again.";
  }

  function copyPrompt(btn, promptText) {
    navigator.clipboard.writeText(promptText).then(() => {
      const confirm = btn.nextElementSibling;
      confirm.style.display = 'inline';
      btn.textContent = 'Copied!';
      setTimeout(() => { confirm.style.display = 'none'; btn.textContent = 'Copy prompt'; }, 2000);
    });
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function addBubble(role, text, questionForFeedback) {
    const win = document.getElementById('chat-window');
    win.style.display = 'flex';
    const bubble = document.createElement('div');
    bubble.className = `chat-bubble ${role}`;
    const feedbackId = ++feedbackCount;

    // Parse out DEEPER_PROMPT marker if present
    let displayText = text;
    let deeperPrompt = null;
    const deeperMatch = text.match(/DEEPER_PROMPT:\s*(.+)$/s);
    if (deeperMatch) {
      deeperPrompt = deeperMatch[1].trim();
      displayText = text.replace(/\n?DEEPER_PROMPT:.+$/s, '').trim();
    }

    const claudeUrl = deeperPrompt
      ? 'https://claude.ai/new?q=' + encodeURIComponent(deeperPrompt)
      : 'https://claude.ai';

    const deeperHtml = deeperPrompt ? `
      <div class="go-deeper-block">
        <div class="go-deeper-label">✦ Want to go deeper?</div>
        <div class="go-deeper-prompt">"${escapeHtml(deeperPrompt)}"</div>
        <div class="go-deeper-actions">
          <button class="go-deeper-copy">Copy prompt</button>
          <span class="copy-confirm">✓ Copied</span>
          <a href="${claudeUrl}" target="_blank" class="go-deeper-link">→ Open in Claude.ai</a>
        </div>
      </div>` : '';

    const feedbackHtml = role === 'assistant' ? `
      <div class="feedback-row" id="feedback-${feedbackId}">
        <span class="feedback-label">Helpful?</span>
        <button class="feedback-btn btn-up">👍</button>
        <button class="feedback-btn btn-down">👎</button>
        <span class="feedback-thanks">Thanks — we'll use this to improve.</span>
      </div>` : '';

    bubble.innerHTML = `
      <div class="bubble-label">${role === 'user' ? 'You' : 'Pelham AI'}</div>
      <div class="bubble-text">${escapeHtml(displayText).replace(/\n/g, '<br>')}</div>
      ${deeperHtml}
      ${feedbackHtml}
    `;
    win.appendChild(bubble);

    // Wire the dynamically-created buttons (replaces the old inline onclick="").
    if (deeperPrompt) {
      const copyBtn = bubble.querySelector('.go-deeper-copy');
      if (copyBtn) copyBtn.addEventListener('click', function () { copyPrompt(this, deeperPrompt); });
    }
    if (role === 'assistant') {
      const fbQuestion = questionForFeedback || '';
      const fbAnswer = displayText.slice(0, 200);
      const upBtn = bubble.querySelector('.btn-up');
      const downBtn = bubble.querySelector('.btn-down');
      if (upBtn) upBtn.addEventListener('click', () => submitFeedback(feedbackId, 'up', fbQuestion, fbAnswer));
      if (downBtn) downBtn.addEventListener('click', () => submitFeedback(feedbackId, 'down', fbQuestion, fbAnswer));
    }

    win.scrollTop = win.scrollHeight;
    return bubble;
  }

  function addTyping() {
    const win = document.getElementById('chat-window');
    win.style.display = 'flex';
    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble assistant';
    bubble.id = 'typing-indicator';
    bubble.innerHTML = `
      <div class="bubble-label">Pelham AI</div>
      <div class="bubble-text typing-dots"><span></span><span></span><span></span></div>
    `;
    win.appendChild(bubble);
    win.scrollTop = win.scrollHeight;
  }

  function removeTyping() {
    const t = document.getElementById('typing-indicator');
    if (t) t.remove();
  }

  async function askClaude() {
    const input = document.getElementById('ai-input');
    const btn = document.getElementById('ask-btn');
    const question = input.value.trim();
    if (!question) return;

    input.value = '';
    btn.disabled = true;
    btn.textContent = '…';

    addBubble('user', question);
    conversationHistory.push({ role: 'user', content: question });
    addTyping();

    try {
      const response = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: conversationHistory })
      });

      if (!response.ok) {
        removeTyping();
        let msg;
        if (response.status === 429) {
          msg = 'The assistant is getting a lot of requests right now (rate limited). Please wait a minute and try again.';
        } else if (response.status >= 500) {
          msg = 'The assistant is temporarily unavailable (server error ' + response.status + '). Please try again in a few minutes.';
        } else {
          msg = 'That request could not be completed (error ' + response.status + '). Please try again.';
        }
        addBubble('assistant', msg);
        btn.disabled = false;
        btn.textContent = 'Ask →';
        return;
      }

      const data = await response.json();
      const answer = data.answer || data.content?.[0]?.text || 'Sorry, I couldn\'t get a response. Please try again.';

      removeTyping();
      addBubble('assistant', answer, question);
      conversationHistory.push({ role: 'assistant', content: answer });

    } catch (err) {
      removeTyping();
      addBubble('assistant', 'Something went wrong connecting to the AI. Please try again in a moment.');
    }

    btn.disabled = false;
    btn.textContent = 'Ask →';
  }

  // Shared tab-switcher: clear the active class from every button matching
  // btnSelector, set it on activeBtn, and (when panel args are given) move the
  // activePanel class from its siblings onto #panelId.
  function switchTab(activeBtn, btnSelector, activeClass, panelId, panelSelector, activePanel){
    document.querySelectorAll(btnSelector).forEach(b=>b.classList.remove(activeClass));
    activeBtn.classList.add(activeClass);
    if(panelId && panelSelector && activePanel){
      document.querySelectorAll(panelSelector).forEach(p=>p.classList.remove(activePanel));
      const panel=document.getElementById(panelId);
      if(panel) panel.classList.add(activePanel);
    }
  }

  function selectExplore(btn,panelId){
    switchTab(btn,'.explore-tab','active-explore-tab',panelId,'.explore-panel','active-panel');
    document.getElementById('explore').scrollIntoView({behavior:'smooth',block:'start'});
  }

  // Nav "Explore More" dropdown — works on click as well as CSS :hover.
  function toggleDropdown(event){
    event.preventDefault();
    event.stopPropagation();
    const wrap = document.querySelector('.nav-dropdown-wrap');
    if (wrap) wrap.classList.toggle('open');
  }
  function closeDropdown(){
    const wrap = document.querySelector('.nav-dropdown-wrap');
    if (wrap) wrap.classList.remove('open');
  }
  document.addEventListener('click', function(e){
    const wrap = document.querySelector('.nav-dropdown-wrap');
    if (wrap && !wrap.contains(e.target)) closeDropdown();
  });

  // ── Meetings page ─────────────────────────────────────────────────────
  // Two levels: a tab per governing body, then within a body one meeting
  // open at a time. Every summary is in the markup; this only shows and hides.
  // The URL hash names the meeting (/meetings#town-council-aug2026), which is
  // how the home digest's cards land on the right one.
  const TRANSCRIPT_PAGE = 50;

  function showBody(bodyId, focusTab) {
    document.querySelectorAll('.mtg-body-tab').forEach((t) => {
      const on = t.dataset.body === bodyId;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.tabIndex = on ? 0 : -1;
      if (on && focusTab) t.focus();
    });
    document.querySelectorAll('.mtg-body-panel').forEach((pnl) => {
      pnl.hidden = pnl.dataset.body !== bodyId;
    });
  }

  function showMeeting(id) {
    const set = document.querySelector('.mtg-set[data-meeting="' + id + '"]');
    if (!set) return false;
    const panel = set.closest('.mtg-body-panel');
    showBody(panel.dataset.body);
    panel.querySelectorAll('.mtg-set').forEach((s) => { s.hidden = s !== set; });
    // The date list offers every meeting except the one on screen.
    panel.querySelectorAll('.mtg-date-link').forEach((a) => {
      a.closest('li').hidden = a.dataset.meeting === id;
    });
    return true;
  }

  document.querySelectorAll('.mtg-body-tab').forEach((tab, i, all) => {
    tab.addEventListener('click', () => showBody(tab.dataset.body));
    // Arrow keys move between tabs, per the ARIA tabs pattern.
    tab.addEventListener('keydown', (e) => {
      const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!step) return;
      e.preventDefault();
      showBody(all[(i + step + all.length) % all.length].dataset.body, true);
    });
  });

  document.querySelectorAll('.mtg-date-link').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const id = a.dataset.meeting;
      if (!showMeeting(id)) return;
      history.replaceState(null, '', '#' + id);
      document.querySelector('.mtg-set[data-meeting="' + id + '"]')
        .scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });

  if (document.querySelector('.mtg-set')) {
    const fromHash = () => showMeeting(decodeURIComponent(location.hash.slice(1)));
    fromHash();
    window.addEventListener('hashchange', fromHash);
  }

  // Long transcripts show the first page of lines behind a "Load more"
  // button. Done here rather than at build time so the full text still reads
  // with scripts off.
  document.querySelectorAll('.transcript-body').forEach((body) => {
    const lines = Array.prototype.filter.call(body.querySelectorAll('.transcript-block'),
      (b) => !b.classList.contains('ts-ellipsis'));
    if (lines.length <= TRANSCRIPT_PAGE) return;
    let shown = TRANSCRIPT_PAGE;
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'transcript-more';
    const render = () => {
      lines.forEach((b, i) => { b.hidden = i >= shown; });
      if (shown >= lines.length) more.remove();
      else more.textContent = 'Load more (' + (lines.length - shown) + ' more lines)';
    };
    more.addEventListener('click', () => { shown += TRANSCRIPT_PAGE; render(); });
    body.after(more);
    render();
  });

  // Address shown in the failure messages below. Interim: a personal mailbox
  // until the project has its own. Published in the page source, so expect it
  // to be scraped — worth swapping for a project address before this gets much
  // traffic.
  const CONTACT_EMAIL = 'katherine.e.keenan@gmail.com';

  const contactClause = () => (CONTACT_EMAIL
    ? ` or email us at <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>`
    : '');

  // Report the real outcome of a submission. These forms previously swallowed
  // every failure and showed the success message regardless, so a resident
  // reporting a factual error could be told it was received when nothing was
  // written. A correction that silently vanishes is worse than a visible
  // failure the reader can retry.
  function reportSubmission(confirmEl, ok, successHtml) {
    confirmEl.classList.toggle('is-error', !ok);
    confirmEl.innerHTML = ok
      ? successHtml
      : `⚠ Something went wrong — your submission was not saved. Please try again${contactClause()}.`;
    confirmEl.style.display = 'block';
  }

  // POST a submission and resolve true only if the server actually accepted it.
  async function postSubmission(payload) {
    try {
      const res = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        console.warn('Submission rejected:', res.status);
        return false;
      }
      return true;
    } catch (err) {
      console.warn('Submission failed:', err);
      return false;
    }
  }

  async function submitError() {
    const section = document.getElementById('error-section').value;
    const desc = document.getElementById('error-desc').value.trim();
    if (!desc) { alert('Please describe the error.'); return; }
    const source = document.getElementById('error-source').value;
    // Optional. Matches the corrections.contact column; left empty it is
    // stored as null, so reporting an error never requires identifying yourself.
    const contactEl = document.getElementById('error-contact');
    const contact = contactEl ? contactEl.value.trim() : '';

    const btn = document.querySelector('.btn-submit-correction');
    const confirmEl = document.getElementById('error-confirm');
    if (btn) { btn.disabled = true; btn.textContent = 'Submitting…'; }

    const ok = await postSubmission({ type: 'correction', section, description: desc, source, contact });

    if (btn) { btn.disabled = false; btn.textContent = 'Submit correction →'; }
    // Only grey the form out once the correction is actually stored; leaving it
    // editable on failure is what makes "try again" possible.
    document.getElementById('error-form').style.opacity = ok ? '0.5' : '1';
    reportSubmission(confirmEl, ok,
      "✓ Correction received — we'll review it shortly.");
  }

  async function submitFeedbackForm() {
    const story = document.getElementById('fb-story').value.trim();
    const governingBody = document.getElementById('fb-body').value;
    const actions = [
      ['attended', 'fb-attended'],
      ['commented', 'fb-commented'],
      ['letter', 'fb-letter'],
      ['applied', 'fb-applied'],
    ].filter(([, elId]) => document.getElementById(elId).checked).map(([name]) => name);

    const btn = document.getElementById('fb-share-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Sharing…'; }

    const ok = await postSubmission({
      type: 'civic_engagement', actions, governing_body: governingBody, story,
    });

    if (btn) { btn.disabled = false; btn.textContent = 'Share my experience →'; }
    reportSubmission(document.getElementById('fb-confirm'), ok,
      "✓ Thanks for sharing — we're tracking this engagement.");
  }

  // ── Event wiring ──
  // All click handlers are bound here instead of inline onclick="" attributes.
  // Behavior and function names are unchanged. This script block sits at the end
  // of <body>, so every element referenced below is already in the DOM.

  document.querySelectorAll('.suggestion-chip').forEach(btn => {
    btn.addEventListener('click', () => usePrompt(btn));
  });

  const askBtn = document.getElementById('ask-btn');
  if (askBtn) askBtn.addEventListener('click', () => askClaude());

  document.querySelectorAll('.explore-tab').forEach(btn => {
    btn.addEventListener('click', () => selectExplore(btn, btn.dataset.panel));
  });

  const dropdownTrigger = document.querySelector('.nav-dropdown-trigger');
  if (dropdownTrigger) dropdownTrigger.addEventListener('click', toggleDropdown);

  document.querySelectorAll('.nav-dropdown a').forEach(link => {
    link.addEventListener('click', () => {
      const tab = document.querySelector('.explore-tab[data-panel="' + link.dataset.panel + '"]');
      if (tab) tab.click();
      closeDropdown();
    });
  });

  // Hero stats that carry data-panel behave like the dropdown items: activate
  // the matching Explore tab, then let selectExplore do the scrolling. The
  // href="#explore" fallback still works if this script never runs.
  document.querySelectorAll('a.stat[data-panel]').forEach(link => {
    link.addEventListener('click', (e) => {
      const tab = document.querySelector('.explore-tab[data-panel="' + link.dataset.panel + '"]');
      if (!tab) return;
      e.preventDefault();
      tab.click();
    });
  });

  const submitCorrectionBtn = document.querySelector('.btn-submit-correction');
  if (submitCorrectionBtn) submitCorrectionBtn.addEventListener('click', () => submitError());

  const shareFeedbackBtn = document.getElementById('fb-share-btn');
  if (shareFeedbackBtn) shareFeedbackBtn.addEventListener('click', () => submitFeedbackForm());

  // Fade-in on scroll
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(e => {
      if (e.isIntersecting) {
        e.target.classList.add('visible');
        observer.unobserve(e.target);
      }
    });
  }, { threshold: 0.1, rootMargin: '0px 0px -40px 0px' });

  document.querySelectorAll('.fade-in').forEach(el => observer.observe(el));

/* ══════════════════════════════════════════════════════════════════════
   SHARED NAVIGATION  (multi-page)
   Markup generated by generateNav() in scripts/build.js.
   ══════════════════════════════════════════════════════════════════════ */

(function initNav() {
  var burger = document.getElementById('nav-burger');
  var drawer = document.getElementById('nav-drawer');
  var scrim = document.getElementById('nav-scrim');
  var closeBtn = document.getElementById('nav-drawer-close');

  // ── Time-limited nav badges ────────────────────────────────────────────
  // The badge carries its own expiry date rather than being omitted at build
  // time. The site is only rebuilt when content changes, so a build-time
  // check would leave "Nov 3" showing into December if nobody edited
  // anything. Comparing here means the page corrects itself.
  var today = new Date().toISOString().slice(0, 10);
  Array.prototype.forEach.call(
    document.querySelectorAll('.nav-badge[data-hide-after]'),
    function (b) { if (today > b.dataset.hideAfter) b.remove(); },
  );

  // ── Mobile drawer ──────────────────────────────────────────────────────
  if (drawer && burger) {
    var lastFocus = null;

    var setOpen = function (open) {
      drawer.classList.toggle('open', open);
      burger.setAttribute('aria-expanded', open ? 'true' : 'false');
      burger.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
      // Toggle `hidden` around the transition so the drawer is out of the
      // accessibility tree when closed but still animates on the way out.
      if (open) {
        drawer.hidden = false;
        if (scrim) { scrim.hidden = false; requestAnimationFrame(function () { scrim.classList.add('open'); }); }
        requestAnimationFrame(function () { drawer.classList.add('open'); });
        document.body.style.overflow = 'hidden';
        lastFocus = document.activeElement;
        var first = drawer.querySelector('a, button');
        if (first) first.focus();
      } else {
        drawer.classList.remove('open');
        if (scrim) scrim.classList.remove('open');
        document.body.style.overflow = '';
        window.setTimeout(function () {
          if (!drawer.classList.contains('open')) {
            drawer.hidden = true;
            if (scrim) scrim.hidden = true;
          }
        }, 240);
        if (lastFocus && lastFocus.focus) lastFocus.focus();
      }
    };

    burger.addEventListener('click', function () {
      setOpen(burger.getAttribute('aria-expanded') !== 'true');
    });
    if (closeBtn) closeBtn.addEventListener('click', function () { setOpen(false); });
    if (scrim) scrim.addEventListener('click', function () { setOpen(false); });

    // Following a link inside the drawer navigates; close first so a
    // same-page anchor does not leave the drawer covering the content.
    Array.prototype.forEach.call(drawer.querySelectorAll('a'), function (a) {
      a.addEventListener('click', function () { setOpen(false); });
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && drawer.classList.contains('open')) setOpen(false);
    });

    // Reopening the bar past the breakpoint must not leave the drawer stuck
    // open behind a hamburger that is no longer visible.
    window.addEventListener('resize', function () {
      if (window.innerWidth > 860 && drawer.classList.contains('open')) setOpen(false);
    });
  }

  // ── "More" menu ────────────────────────────────────────────────────────
  var moreBtn = document.getElementById('nav-more');
  var moreWrap = moreBtn && moreBtn.closest('.nav-more-wrap');
  if (moreBtn && moreWrap) {
    var setMore = function (open) {
      moreWrap.classList.toggle('open', open);
      moreBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    moreBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      setMore(!moreWrap.classList.contains('open'));
    });
    document.addEventListener('click', function (e) {
      if (!moreWrap.contains(e.target)) setMore(false);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && moreWrap.classList.contains('open')) {
        setMore(false);
        moreBtn.focus();
      }
    });
  }
})();

// ── Collapsible race sections (Elections page) ─────────────────────────────
// Rendered expanded so the content is there without JS; this only adds the
// ability to fold a race away once the reader has read it.
(function initRaceToggles() {
  Array.prototype.forEach.call(document.querySelectorAll('.race-toggle'), function (btn) {
    var body = document.getElementById(btn.getAttribute('aria-controls'));
    if (!body) return;
    btn.addEventListener('click', function () {
      var open = btn.getAttribute('aria-expanded') === 'true';
      btn.setAttribute('aria-expanded', open ? 'false' : 'true');
      btn.setAttribute('aria-label', (open ? 'Expand ' : 'Collapse ')
        + (btn.getAttribute('aria-label') || '').replace(/^(Collapse|Expand) /, ''));
      body.hidden = open;
    });
  });
})();
