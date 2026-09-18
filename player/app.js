/* Chitrayaan test player: plain browser JS, no build step. hls.js and dash.js are loaded as
   UMD globals (`Hls`, `dashjs`) by index.html. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const store = {
    get(key) {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, value);
      } catch {
        /* private mode etc. */
      }
    },
  };

  const state = { video: null, hls: null, dash: null, pollTimer: null, statsTimer: null };

  const apiBase = () => ($('api-base').value.trim() || window.location.origin).replace(/\/+$/, '');
  const apiKey = () => $('api-key').value.trim();
  const absolute = (path) => apiBase() + path;

  async function api(path) {
    const res = await fetch(absolute(path), { headers: { 'X-API-Key': apiKey() } });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${path}`);
    return res.json();
  }

  function setStatus(text, kind) {
    const el = $('connection-status');
    el.textContent = text;
    el.className = `status ${kind || ''}`;
  }

  function log(which, message) {
    const el = $(`${which}-log`);
    el.textContent += `${new Date().toISOString().slice(11, 23)} ${message}\n`;
    el.scrollTop = el.scrollHeight;
  }

  function fmtKbps(bps) {
    return `${Math.round(bps / 1000)}k`;
  }

  // ---------- connection + video list ----------

  async function connect() {
    store.set('chitrayaan.apiBase', $('api-base').value.trim());
    store.set('chitrayaan.apiKey', apiKey());
    try {
      const page = await api('/api/videos?status=ready&limit=200');
      const select = $('video-list');
      select.innerHTML = '';
      if (page.items.length === 0) {
        select.append(new Option('(no ready videos yet)', ''));
      }
      for (const v of page.items) {
        const label = `${v.title || v.originalFilename || v.id} (${v.width}x${v.height}, ${Math.round(v.durationSeconds || 0)}s)`;
        select.append(new Option(label, v.id));
      }
      setStatus(`Connected to ${apiBase()}: ${page.total} ready video(s)`, 'ok');
    } catch (err) {
      setStatus(`Connection failed: ${err.message}`, 'err');
    }
  }

  // ---------- video details ----------

  function renderDetails(v) {
    $('video-details').hidden = false;
    $('d-status').textContent = v.status + (v.error ? ` - ${v.error}` : '');
    $('d-source').textContent =
      `${v.originalFilename || '-'} ${v.width || '?'}x${v.height || '?'}, ${
        v.durationSeconds ? v.durationSeconds.toFixed(2) : '?'
      }s, ${v.sizeBytes ? (v.sizeBytes / 1048576).toFixed(1) : '?'} MiB`;
    const job = v.jobs && v.jobs[0];
    $('d-job').textContent = job
      ? `${job.status} ${job.progress}%${job.error ? ` - ${job.error}` : ''}`
      : '-';
    $('d-hls').textContent = v.manifests.hls ? absolute(v.manifests.hls) : '(not published)';
    $('d-dash').textContent = v.manifests.dash ? absolute(v.manifests.dash) : '(not published)';

    const tbody = $('renditions').querySelector('tbody');
    tbody.innerHTML = '';
    for (const r of v.renditions) {
      const tr = document.createElement('tr');
      for (const cell of [
        r.name,
        `${r.width}x${r.height}`,
        r.videoBitrateKbps,
        r.audioBitrateKbps ?? '-',
        r.segmentCount,
        r.sizeBytes ? (r.sizeBytes / 1024).toFixed(0) + ' KiB' : '-',
      ]) {
        const td = document.createElement('td');
        td.textContent = String(cell);
        tr.append(td);
      }
      tbody.append(tr);
    }
  }

  async function loadVideo(id) {
    clearTimeout(state.pollTimer);
    try {
      const v = await api(`/api/videos/${encodeURIComponent(id)}`);
      state.video = v;
      renderDetails(v);
      if (v.status === 'ready') {
        if (v.manifests.hls) setupHls(absolute(v.manifests.hls));
        else log('hls', 'no HLS manifest published for this video');
        if (v.manifests.dash) setupDash(absolute(v.manifests.dash));
        else log('dash', 'no DASH manifest published for this video');
      } else if (v.status === 'failed') {
        setStatus(`Video ${id} failed: ${v.error || 'unknown error'}`, 'err');
      } else {
        setStatus(`Video ${id} is ${v.status}; refreshing every 2s`, 'warn');
        state.pollTimer = setTimeout(() => loadVideo(id), 2000);
      }
    } catch (err) {
      setStatus(`Load failed: ${err.message}`, 'err');
    }
  }

  // ---------- HLS (hls.js) ----------

  function setupHls(url) {
    const video = $('hls-video');
    if (state.hls) {
      state.hls.destroy();
      state.hls = null;
    }
    $('hls-log').textContent = '';
    $('hls-play').disabled = true;
    $('hls-quality').disabled = true;

    if (!window.Hls || !Hls.isSupported()) {
      log('hls', 'hls.js is not supported in this browser (no MediaSource)');
      return;
    }
    const hls = new Hls({
      xhrSetup: (xhr) => xhr.setRequestHeader('X-API-Key', apiKey()),
    });
    state.hls = hls;
    log('hls', `loading ${url}`);

    hls.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
      const select = $('hls-quality');
      select.innerHTML = '';
      select.append(new Option('auto', '-1'));
      data.levels.forEach((level, index) => {
        select.append(new Option(`${level.height}p ${fmtKbps(level.bitrate)}`, String(index)));
      });
      select.disabled = false;
      $('hls-play').disabled = false;
      log(
        'hls',
        `manifest parsed: ${data.levels.length} level(s), ${data.audioTracks.length} audio track(s)`,
      );
    });
    hls.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => {
      const level = hls.levels[data.level];
      if (level) {
        $('hls-current').textContent = `${level.height}p @${fmtKbps(level.bitrate)}`;
        log('hls', `level switched -> ${level.height}p`);
      }
    });
    hls.on(Hls.Events.ERROR, (_event, data) => {
      log(
        'hls',
        `ERROR ${data.type}/${data.details}${data.fatal ? ' (fatal)' : ''}${data.response ? ` HTTP ${data.response.code}` : ''}`,
      );
    });

    hls.loadSource(url);
    hls.attachMedia(video);
  }

  $('hls-quality').addEventListener('change', (event) => {
    if (!state.hls) return;
    const level = Number(event.target.value);
    state.hls.currentLevel = level;
    log('hls', level === -1 ? 'quality: auto' : `quality pinned to level ${level}`);
  });
  $('hls-play').addEventListener('click', () => {
    $('hls-video')
      .play()
      .catch((err) => log('hls', `play() rejected: ${err.message}`));
  });

  // ---------- DASH (dash.js) ----------

  function setupDash(url) {
    const video = $('dash-video');
    if (state.dash) {
      state.dash.destroy();
      state.dash = null;
    }
    $('dash-log').textContent = '';
    $('dash-play').disabled = true;
    $('dash-quality').disabled = true;

    if (!window.dashjs) {
      log('dash', 'dash.js failed to load');
      return;
    }
    const player = dashjs.MediaPlayer().create();
    state.dash = player;
    const events = dashjs.MediaPlayer.events;

    if (typeof player.addRequestInterceptor === 'function') {
      player.addRequestInterceptor((request) => {
        request.headers = Object.assign({}, request.headers, { 'X-API-Key': apiKey() });
        if (
          request.customData &&
          request.customData.request &&
          request.customData.request.headers
        ) {
          request.customData.request.headers['X-API-Key'] = apiKey();
        }
        return Promise.resolve(request);
      });
    } else {
      player.extend(
        'RequestModifier',
        () => ({
          modifyRequestHeader: (xhr) => {
            xhr.setRequestHeader('X-API-Key', apiKey());
            return xhr;
          },
          modifyRequestURL: (u) => u,
        }),
        true,
      );
    }

    player.updateSettings({ streaming: { abr: { autoSwitchBitrate: { video: true } } } });
    log('dash', `loading ${url}`);

    player.on(events.STREAM_INITIALIZED, () => {
      const reps = player.getRepresentationsByType('video');
      const select = $('dash-quality');
      select.innerHTML = '';
      select.append(new Option('auto', 'auto'));
      for (const rep of reps) {
        select.append(new Option(`${rep.height}p ${fmtKbps(rep.bandwidth)}`, rep.id));
      }
      select.disabled = false;
      $('dash-play').disabled = false;
      log('dash', `stream initialized: ${reps.length} video representation(s)`);
    });
    player.on(events.QUALITY_CHANGE_RENDERED, (e) => {
      if (e.mediaType !== 'video' || !e.newRepresentation) return;
      const r = e.newRepresentation;
      $('dash-current').textContent = `${r.height}p @${fmtKbps(r.bandwidth)}`;
      log('dash', `quality rendered -> ${r.height}p`);
    });
    player.on(events.ERROR, (e) => {
      const err = e.error || {};
      log('dash', `ERROR ${err.code || ''} ${err.message || JSON.stringify(err)}`);
    });
    player.on(events.PLAYBACK_ERROR, (e) =>
      log('dash', `PLAYBACK_ERROR ${JSON.stringify(e.error)}`),
    );

    player.initialize(video, url, false);
  }

  $('dash-quality').addEventListener('change', (event) => {
    if (!state.dash) return;
    const value = event.target.value;
    if (value === 'auto') {
      state.dash.updateSettings({ streaming: { abr: { autoSwitchBitrate: { video: true } } } });
      log('dash', 'quality: auto');
    } else {
      state.dash.updateSettings({ streaming: { abr: { autoSwitchBitrate: { video: false } } } });
      state.dash.setRepresentationForTypeById('video', value, true);
      log('dash', `quality pinned to representation ${value}`);
    }
  });
  $('dash-play').addEventListener('click', () => {
    $('dash-video')
      .play()
      .catch((err) => log('dash', `play() rejected: ${err.message}`));
  });

  // ---------- live stats ----------

  function bufferAhead(video) {
    const t = video.currentTime;
    for (let i = 0; i < video.buffered.length; i += 1) {
      if (video.buffered.start(i) <= t && t <= video.buffered.end(i)) {
        return video.buffered.end(i) - t;
      }
    }
    return 0;
  }

  state.statsTimer = setInterval(() => {
    for (const which of ['hls', 'dash']) {
      const video = $(`${which}-video`);
      $(`${which}-buffer`).textContent = bufferAhead(video).toFixed(1);
      $(`${which}-position`).textContent = video.currentTime.toFixed(1);
    }
  }, 500);

  // ---------- wiring ----------

  // Deep links: /player/?key=...&video=<id>&autoplay=1 (the key is moved into local storage
  // and stripped from the address bar so it does not linger in history).
  const params = new URLSearchParams(window.location.search);
  if (params.get('key')) store.set('chitrayaan.apiKey', params.get('key'));
  if (params.get('base')) store.set('chitrayaan.apiBase', params.get('base'));
  const deepLinkVideo = params.get('video');
  const autoplay = params.get('autoplay') === '1';
  if (params.has('key')) {
    params.delete('key');
    const rest = params.toString();
    window.history.replaceState(null, '', window.location.pathname + (rest ? `?${rest}` : ''));
  }

  $('api-base').value = store.get('chitrayaan.apiBase') || '';
  $('api-key').value = store.get('chitrayaan.apiKey') || '';
  $('hls-version').textContent = window.Hls ? `v${Hls.version || '?'}` : '(not loaded)';
  $('dash-version').textContent = window.dashjs
    ? `v${typeof dashjs.Version === 'function' ? dashjs.Version() : dashjs.Version || '?'}`
    : '(not loaded)';

  $('connect').addEventListener('click', connect);
  $('load').addEventListener('click', () => {
    const id = $('video-id').value.trim() || $('video-list').value;
    if (id) loadVideo(id);
    else setStatus('Pick a video or paste an id', 'warn');
  });
  $('refresh').addEventListener('click', () => {
    if (state.video) loadVideo(state.video.id);
  });
  $('video-list').addEventListener('change', (event) => {
    $('video-id').value = '';
    if (event.target.value) loadVideo(event.target.value);
  });

  if (apiKey()) {
    connect().then(() => {
      if (deepLinkVideo) {
        $('video-id').value = deepLinkVideo;
        return loadVideo(deepLinkVideo);
      }
      return undefined;
    });
  }

  if (autoplay) {
    // Start both players as soon as their manifests are parsed (videos are muted, so
    // autoplay policies allow it).
    for (const which of ['hls', 'dash']) {
      const button = $(`${which}-play`);
      new MutationObserver(() => {
        if (!button.disabled) button.click();
      }).observe(button, { attributes: true, attributeFilter: ['disabled'] });
    }
  }
})();
