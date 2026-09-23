(function () {
  'use strict';

  const AUTOPLAY_NOTICE = 'Clique em reproduzir no player para liberar o áudio e a sincronização.';
  const EVENTS = ['play', 'pause', 'seeking', 'seeked', 'ratechange', 'waiting', 'playing', 'loadedmetadata'];
  let role = null;
  let video = null;
  let lastState = null;
  let notice = null;
  let buffering = false;
  let pendingPlay = null;
  // Play/pause the extension caused, so its events are not mistaken for the viewer's.
  let expected = null;
  // A guest's own play/pause, kept while the host catches up.
  let intent = null;
  const INTENT_MS = 4000;
  // An ad is playing here; the party waits for it to finish.
  let ad = false;
  // Host only: paused while a guest watches an ad, resuming afterwards if it was playing.
  let held = false;
  let resumeAfterHold = false;
  let roleVersion = 0;
  let stopped = false;
  let lastScan = -Infinity;
  let scanTimer = null;
  let reportTimer = null;
  let syncTimer = null;
  let observer = null;

  function stop() {
    if (stopped) return;
    stopped = true;
    clearTimeout(scanTimer);
    clearInterval(reportTimer);
    clearInterval(syncTimer);
    if (observer) observer.disconnect();
    EVENTS.forEach((event) => document.removeEventListener(event, onVideoEvent, true));
    try {
      chrome.runtime.onMessage.removeListener(onMessage);
    } catch (_) {
      // An invalidated extension can no longer access the runtime.
    }
  }

  function handleRuntimeError(error) {
    if (/context invalidated|extension.*(?:invalid|unloaded)/i.test(String(error && (error.message || error)))) {
      stop();
    }
  }

  function visibleArea(candidate) {
    if (!(candidate instanceof HTMLVideoElement) || candidate.readyState < 1 ||
        !Number.isFinite(candidate.duration) || candidate.duration <= 0) return 0;
    const style = getComputedStyle(candidate);
    if (style.display === 'none' || style.visibility === 'hidden' ||
        style.visibility === 'collapse' || Number(style.opacity) === 0) return 0;
    const rect = candidate.getBoundingClientRect();
    const width = Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0));
    const height = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
    return width * height;
  }

  function detectAd() {
    if (!video) return false;
    // YouTube plays ads in the same <video> and flags its player container. Other players
    // (Crunchyroll uses Google IMA) are not detected: a false positive would stop sync entirely.
    const player = typeof video.closest === 'function' ? video.closest('.html5-video-player') : null;
    return !!player && (player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting'));
  }

  function hasUserActivation() {
    return typeof navigator !== 'undefined' && !!navigator.userActivation && navigator.userActivation.isActive;
  }

  function sendIntent(paused) {
    try {
      if (!chrome.runtime || !chrome.runtime.id) {
        stop();
        return;
      }
      const result = chrome.runtime.sendMessage({
        target: 'broker', action: 'PLAYER_INTENT', payload: { paused },
      }, function () {
        try {
          const error = chrome.runtime.lastError;
          if (error) handleRuntimeError(error);
        } catch (error) {
          handleRuntimeError(error);
        }
      });
      if (result && typeof result.catch === 'function') result.catch(handleRuntimeError);
    } catch (error) {
      handleRuntimeError(error);
    }
  }

  function onPlayPause(paused) {
    const now = performance.now();
    if (expected && expected.paused === paused && now - expected.at < 1500) {
      expected = null;
      return;
    }
    if (role !== 'guest' || !lastState || ad || video.ended || now - lastState.receivedAt >= 8000) return;
    // Sites pause and resume on their own (autoplay, idle prompts); only a click or key counts.
    if (!hasUserActivation()) return;
    if (paused === (intent ? intent.paused : lastState.state.paused)) return;
    intent = { paused, at: now };
    sendIntent(paused);
  }

  function report() {
    if (stopped) return;
    const area = video ? visibleArea(video) : 0;
    const available = area > 0;
    ad = available && detectAd();
    const state = available ? {
      time: Number.isFinite(video.currentTime) ? video.currentTime : 0,
      paused: video.paused,
      rate: Number.isFinite(video.playbackRate) ? video.playbackRate : 1,
      duration: video.duration,
      buffering: buffering || (!video.paused && video.readyState < 3),
    } : { time: 0, paused: true, rate: 1, duration: 0, buffering: false };
    try {
      if (!chrome.runtime || !chrome.runtime.id) {
        stop();
        return;
      }
      const result = chrome.runtime.sendMessage({
        target: 'broker',
        action: 'PLAYER_REPORT',
        payload: { available, area, state, notice, ad },
      }, function () {
        try {
          const error = chrome.runtime.lastError;
          if (error) handleRuntimeError(error);
        } catch (error) {
          handleRuntimeError(error);
        }
      });
      if (result && typeof result.catch === 'function') result.catch(handleRuntimeError);
    } catch (error) {
      handleRuntimeError(error);
    }
  }

  // Host-side play on behalf of the party; a blocked autoplay surfaces the usual notice.
  function play(player) {
    try {
      const result = player.play();
      if (result && typeof result.catch === 'function') {
        result.catch(() => {
          notice = AUTOPLAY_NOTICE;
          report();
        });
      }
    } catch (_) {
      notice = AUTOPLAY_NOTICE;
    }
  }

  function applyState() {
    if (stopped || role !== 'guest' || !lastState || ad || !video || !visibleArea(video)) return;
    const player = video;
    const state = lastState.state;
    const now = performance.now();
    if (intent && (now - intent.at >= INTENT_MS || intent.paused === state.paused)) intent = null;
    if (intent) return;
    const shouldPause = state.paused || state.buffering;
    const elapsed = Math.max(0, now - lastState.receivedAt);
    if (elapsed >= 8000) return;
    const advance = shouldPause ? 0 : (elapsed + lastState.delayMs) / 1000 * state.rate;
    const target = Math.max(0, Math.min(state.time + advance, player.duration - 0.1));

    if (shouldPause && !player.paused) {
      expected = { paused: true, at: now };
      player.pause();
    }
    try {
      if (player.playbackRate !== state.rate) player.playbackRate = state.rate;
    } catch (_) {
      // Some site players reject otherwise valid playback rates.
    }
    if (!player.seeking && Math.abs(player.currentTime - target) > (shouldPause ? 0.3 : 1) + 1e-6) {
      try {
        player.currentTime = target;
      } catch (_) {
        // Metadata can disappear while an SPA replaces the media source.
      }
    }
    if (shouldPause || !player.paused || (pendingPlay && pendingPlay.player === player)) return;

    const attempt = { player, roleVersion };
    pendingPlay = attempt;
    function finish(error) {
      if (pendingPlay === attempt) pendingPlay = null;
      if (stopped || video !== player || role !== 'guest' || roleVersion !== attempt.roleVersion ||
          !lastState || lastState.state.paused || lastState.state.buffering) return;
      notice = error ? AUTOPLAY_NOTICE : null;
      report();
    }
    expected = { paused: false, at: now };
    try {
      const result = player.play();
      if (result && typeof result.then === 'function') result.then(() => finish(null), finish);
      else finish(null);
    } catch (error) {
      finish(error);
    }
  }

  function scan() {
    if (stopped) return;
    lastScan = performance.now();
    let largest = null;
    let largestArea = 0;
    document.querySelectorAll('video').forEach((candidate) => {
      const area = visibleArea(candidate);
      if (area > largestArea) {
        largest = candidate;
        largestArea = area;
      }
    });
    if (largest !== video) {
      video = largest;
      buffering = !!video && !video.paused && video.readyState < 3;
      notice = null;
      applyState();
      report();
    } else if (!!video && visibleArea(video) > 0 && detectAd() !== ad) {
      report();
    }
  }

  function requestScan() {
    if (stopped || scanTimer !== null) return;
    const delay = Math.max(0, 250 - (performance.now() - lastScan));
    if (!delay) scan();
    else scanTimer = setTimeout(() => {
      scanTimer = null;
      scan();
    }, delay);
  }

  function onVideoEvent(event) {
    if (stopped || !(event.target instanceof HTMLVideoElement)) return;
    requestScan();
    if (event.target === video) {
      if (event.type === 'waiting') buffering = true;
      if (event.type === 'playing' || event.type === 'loadedmetadata') buffering = false;
      if (event.type === 'playing') notice = null;
      if (event.type === 'play' || event.type === 'pause') onPlayPause(event.type === 'pause');
    }
    report();
  }

  function onMessage(message) {
    if (stopped || !message || typeof message !== 'object' || message.target !== 'player') return;
    const payload = message.payload;
    if (message.action === 'SET_ROLE') {
      if (!payload || !['host', 'guest', null].includes(payload.role)) return;
      if (role !== payload.role) {
        roleVersion += 1;
        role = payload.role;
        lastState = null;
        intent = null;
        held = resumeAfterHold = false;
        notice = null;
      }
      report();
    } else if (message.action === 'RESET') {
      roleVersion += 1;
      role = null;
      lastState = null;
      intent = null;
      held = resumeAfterHold = false;
      notice = null;
      report();
    } else if (message.action === 'HOLD' && role === 'host') {
      if (!payload || typeof payload.active !== 'boolean' || !video || ad) return;
      if (payload.active === held) return;
      held = payload.active;
      if (held) {
        resumeAfterHold = !video.paused;
        video.pause();
      } else if (resumeAfterHold) {
        resumeAfterHold = false;
        play(video);
      }
      report();
    } else if (message.action === 'RATE' && role === 'host') {
      if (!payload || !Number.isFinite(payload.rate) || payload.rate <= 0 || payload.rate > 16 || !video || ad) return;
      try {
        video.playbackRate = payload.rate;
      } catch (_) {
        // Some site players reject otherwise valid playback rates.
      }
      report();
    } else if (message.action === 'CONTROL' && role === 'host') {
      if (!payload || typeof payload.paused !== 'boolean' || !video || ad) return;
      // During a hold, remember what the guest asked for and apply it when the ad ends.
      if (held) resumeAfterHold = !payload.paused;
      else if (payload.paused) video.pause();
      else play(video);
      report();
    } else if (message.action === 'REPORT_REQUEST') {
      scan();
      report();
    } else if (message.action === 'APPLY_STATE' && role === 'guest') {
      const state = payload && payload.state;
      if (!state || typeof state !== 'object' ||
          !Number.isFinite(state.time) || state.time < 0 ||
          !Number.isFinite(state.rate) || state.rate <= 0 || state.rate > 16 ||
          !Number.isFinite(state.duration) || state.duration <= 0 ||
          typeof state.paused !== 'boolean' || typeof state.buffering !== 'boolean' ||
          !Number.isFinite(payload.delayMs) || payload.delayMs < 0) return;
      lastState = {
        state: { time: state.time, paused: state.paused, rate: state.rate,
          duration: state.duration, buffering: state.buffering },
        delayMs: Math.min(payload.delayMs, 2000),
        receivedAt: performance.now(),
      };
      applyState();
      report();
    }
  }

  try {
    chrome.runtime.onMessage.addListener(onMessage);
    EVENTS.forEach((event) => document.addEventListener(event, onVideoEvent, true));
    observer = new MutationObserver(requestScan);
    observer.observe(document, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ['src', 'style', 'class', 'hidden'],
    });
    reportTimer = setInterval(() => { scan(); report(); }, 1500);
    syncTimer = setInterval(applyState, 500);
    scan();
    report();
  } catch (error) {
    stop();
  }
})();
