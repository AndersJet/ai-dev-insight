/* exported ADI */
// Platform-neutral logic; also executed by macOS JavaScript for Automation.
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- host entry point
var ADI = (function () {
  var events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'Notification'];
  var uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  function fail(code) { throw new Error(code); }
  function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
  function equal(a, b) {
    if (a === b) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
    var keys = Object.keys(a); return keys.length === Object.keys(b).length && keys.every(function (key) { return Object.prototype.hasOwnProperty.call(b, key) && equal(a[key], b[key]); });
  }
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function config(value, endpoint, validUrl) {
    if (!object(value) || !uuidPattern.test(value.installation_id) || typeof value.token !== 'string' || !/^adi_[A-Za-z0-9_-]{43}$/.test(value.token)) fail('invalid_credentials_file');
    if (value.protocol_version !== 2 || typeof value.runtime_owner !== 'string' || !/^[a-f0-9]{64}$/.test(value.runtime_owner)) fail('invalid_runtime_binding');
    endpoint = endpoint || value.endpoint;
    if (typeof endpoint !== 'string' || !validUrl(endpoint)) fail('invalid_collector_endpoint');
    return { installation_id: value.installation_id, token: value.token, endpoint: endpoint, protocol_version: 2, runtime_owner: value.runtime_owner };
  }
  function runtimeGeneration(value, owner, now, clock) {
    if (!object(clock) || clock.kind !== 'macos-continuous-v1' || typeof clock.scope !== 'string' || !/^macos:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(clock.scope) || !Number.isSafeInteger(clock.monotonic_ms) || clock.monotonic_ms < 0) return null;
    if (!object(value) || value.version !== 2 || value.clock_kind !== clock.kind || value.owner !== owner || value.enabled !== true || typeof value.generation !== 'string' || !uuidPattern.test(value.generation) || !Array.isArray(value.leases) || value.leases.length > 128) return null;
    return value.leases.some(function (lease) {
      return object(lease) && typeof lease.id === 'string' && uuidPattern.test(lease.id) && lease.clock_scope === clock.scope &&
        [lease.issued_at,lease.expires_at,lease.monotonic_issued_at,lease.monotonic_expires_at].every(Number.isSafeInteger) &&
        lease.issued_at <= now && lease.expires_at > now && lease.expires_at - lease.issued_at > 0 && lease.expires_at - lease.issued_at <= 30000 &&
        lease.monotonic_issued_at >= 0 && lease.monotonic_issued_at <= clock.monotonic_ms && lease.monotonic_expires_at > clock.monotonic_ms &&
        lease.monotonic_expires_at - lease.monotonic_issued_at > 0 && lease.monotonic_expires_at - lease.monotonic_issued_at <= 30000;
    }) ? value.generation : null;
  }
  function hooks(raw) {
    var value = raw === null || !raw.trim() ? { version: 1, hooks: {} } : JSON.parse(raw);
    if (object(value) && !Object.prototype.hasOwnProperty.call(value, 'hooks')) value.hooks = {};
    if (!object(value) || !object(value.hooks) || (value.version !== undefined && value.version !== 1) || !Object.keys(value.hooks).every(function (key) { return Array.isArray(value.hooks[key]); })) fail('unsupported_hooks_configuration');
    return value;
  }
  function manifest(raw) {
    if (raw === null) return null;
    var value = JSON.parse(raw);
    if (!object(value) || value.version !== 2 || !uuidPattern.test(value.release) || !Array.isArray(value.entries) || value.entries.length !== events.length || !value.entries.every(function (entry) { return object(entry) && events.indexOf(entry.event) !== -1 && object(entry.group); })) fail('invalid_installation_manifest');
    return value;
  }
  function merge(original, old, next) {
    var result = clone(original);
    (old ? old.entries : []).forEach(function (entry) {
      var groups = result.hooks[entry.event];
      if (!groups || groups.filter(function (group) { return equal(group, entry.group); }).length !== 1) fail('managed_hooks_modified');
      groups = groups.filter(function (group) { return !equal(group, entry.group); });
      if (groups.length) result.hooks[entry.event] = groups; else delete result.hooks[entry.event];
    });
    next.forEach(function (entry) { result.hooks[entry.event] = (result.hooks[entry.event] || []).concat([entry.group]); });
    return result;
  }
  function envelope(raw, settings, uuid, observedAt, project) {
    var value = JSON.parse(raw);
    if (!object(value) || typeof value.session_id !== 'string' || !value.session_id.trim() || value.session_id.length > 256 || events.indexOf(value.hook_event_name) === -1) fail('invalid_event');
    var queue = [{ value: value, depth: 0 }], count = 0;
    while (queue.length) {
      var item = queue.pop();
      if (++count > 19900 || item.depth > 31 || (Array.isArray(item.value) && item.value.length > 2048)) fail('invalid_event');
      if (item.value && typeof item.value === 'object') Object.keys(item.value).forEach(function (key) { if (queue.length + count > 19900) fail('invalid_event'); queue.push({ value: item.value[key], depth: item.depth + 1 }); });
    }
    if (project) {
      var extra = [project], additional = 0;
      while (extra.length) { var part = extra.pop(); additional++; if (part && typeof part === 'object') Object.keys(part).forEach(function (key) { extra.push(part[key]); }); }
      if (count + additional + 20 > 20000) project = null;
    }
    var header = { schema_version: 2, installation_id: settings.installation_id, client_event_id: uuid, occurred_at: observedAt, timestamp_source: 'client_observed', event_type: value.hook_event_name, source_session_id: value.session_id };
    if (project) header.project = project;
    var metadata = JSON.stringify(header);
    return metadata.slice(0, -1) + ',"payload":' + raw + '}';
  }
  function install(io, args) {
    var action = args.shift(), flags = Object.create(null);
    if (['plan', 'install', 'uninstall', 'status'].indexOf(action) === -1) fail('usage_required');
    while (args.length) {
      var key = args.shift();
      if (Object.prototype.hasOwnProperty.call(flags, key)) fail('invalid_arguments');
      if (key === '--replace-legacy') { flags[key] = true; continue; }
      if (['--credentials', '--endpoint', '--trae-dir'].indexOf(key) === -1 || !args.length) fail('invalid_arguments');
      flags[key] = args.shift();
    }
    var profile = io.absolute(flags['--trae-dir'] || io.home + '/.trae-cn'), base = profile + '/adi-native-collector', target = profile + '/hooks.json';
    var raw = io.read(target, 1048576), old = manifest(io.read(base + '/manifest.json', 1048576));
    hooks(raw);
    if (action === 'status') return { installed: !!old, pending_recovery: io.read(base + '/pending.json', 4194304) !== null, profile: profile };
    var settings = null;
    if (action !== 'uninstall') {
      if (!flags['--credentials']) fail('credentials_required');
      settings = config(JSON.parse(io.read(io.absolute(flags['--credentials']), 16384) || 'null'), flags['--endpoint'], io.validUrl);
    }
    function entries(id) {
      return events.map(function (event) { var group = { hooks: [{ type: 'command', command: io.command(base + '/' + id), timeout: 2 }] }; if (['PreToolUse', 'PostToolUse', 'Notification'].indexOf(event) !== -1) group.matcher = '*'; if (event === 'Stop') group.loop_limit = 1000; return { event: event, group: group }; });
    }
    function legacy(original) {
      var result = clone(original), count = 0, referenceCounts = Object.create(null);
      // Only exact commands owned by the reference installer can be replaced.
      var known = ['"' + profile + '/trae-hook-send.sh"', 'powershell -NoProfile -ExecutionPolicy Bypass -NonInteractive -File "' + profile.replace(/\//g, '\\') + '\\trae-hook-send.ps1"'];
      var nodeRaw = io.read(profile + '/adi-collector/manifest.json', 1048576);
      var node = nodeRaw ? JSON.parse(nodeRaw) : null;
      if (node && (node.version !== 1 || !uuidPattern.test(node.release) || !Array.isArray(node.entries) || node.entries.length > 6 || io.read(profile + '/adi-collector/.owned', 128) !== 'adi-hook-client-v1')) fail('legacy_hook_requires_migration');
      Object.keys(result.hooks).forEach(function (event) {
        var groups = [];
        result.hooks[event].forEach(function (group) {
          var ownedNode = node && node.entries.some(function (entry) { return entry.event === event && equal(entry.group, group); });
          if (ownedNode) { if (!flags['--replace-legacy']) fail('legacy_hook_requires_migration'); count++; return; }
          if (!object(group) || !Array.isArray(group.hooks)) { groups.push(group); return; }
          var remaining = group.hooks.filter(function (definition) {
            if (!object(definition) || typeof definition.command !== 'string' || !/trae-hook-send\.(sh|ps1)|adi-collector.*sender\.js/.test(definition.command)) return true;
            if (!flags['--replace-legacy'] || known.indexOf(definition.command) === -1) fail('legacy_hook_requires_migration');
            count++; referenceCounts[event] = (referenceCounts[event] || 0) + 1; return false;
          });
          if (remaining.length === group.hooks.length) groups.push(group);
          else if (remaining.length) { group.hooks = remaining; groups.push(group); }
        });
        if (groups.length) result.hooks[event] = groups; else delete result.hooks[event];
      });
      return { value: result, count: count, referenceCounts: referenceCounts };
    }
    function mergeInstallation(prepared, previous, next) {
      // A cleared configuration is an explicit reset. Keep the old manifest
      // for journal cleanup, but do not require its deleted hook entries.
      var original = hooks(raw);
      var cleared = Object.keys(original.hooks).every(function (event) { return original.hooks[event].length === 0; });
      // A complete overwrite by the known reference installer leaves a stale
      // native manifest. Only recover when all six events have one legacy
      // command and no native references survive; partial edits remain errors.
      var overwritten = previous && events.every(function (event) { return prepared.referenceCounts[event] === 1; }) &&
        JSON.stringify(prepared.value).toLowerCase().indexOf('adi-native-collector') === -1 &&
        previous.entries.every(function (entry) { return !(prepared.value.hooks[entry.event] || []).some(function (group) { return equal(group, entry.group); }); });
      return merge(prepared.value, cleared || overwritten ? null : previous, next);
    }
    if (action === 'plan') { var preview = legacy(hooks(raw)); mergeInstallation(preview, old, entries('preview')); return { action: action, profile: profile, legacy_commands_to_replace: preview.count, runtime: io.platform, events: events, command_deadline_ms: 750, hook_timeout_seconds: 2 }; }
    if (action === 'uninstall' && !old && io.read(base + '/pending.json', 4194304) === null) return { action: action, changed: false };
    var marker = io.read(base + '/.owned', 128);
    if (marker === null && !io.emptyDirectory(base)) fail('unsafe_installation_path');
    io.directory(profile, false); io.directory(base, true);
    if (marker === null) io.create(base + '/.owned', 'adi-native-client-v2'); else if (marker !== 'adi-native-client-v2') fail('unsafe_installation_path');
    var unlock = io.lock(base);
    function clean(id) {
      if (!uuidPattern.test(id)) fail('invalid_installation_journal');
      io.safeDirectory(base + '/' + id);
      io.releaseFiles.forEach(function (file) { io.unlink(base + '/' + id + '/' + file); });
      io.unlink(base + '/' + id + '/config.json'); io.rmdir(base + '/' + id);
    }
    function recover() {
      var saved = io.read(base + '/pending.json', 4194304); if (saved === null) return;
      var journal = JSON.parse(saved);
      if (!object(journal) || (journal.before !== null && typeof journal.before !== 'string') || typeof journal.after !== 'string' || !Array.isArray(journal.remove) || !journal.remove.every(function (id) { return uuidPattern.test(id); }) || (journal.created !== null && !uuidPattern.test(journal.created))) fail('invalid_installation_journal');
      var next = manifest(journal.manifest === null ? null : JSON.stringify(journal.manifest));
      var current = io.read(target, 1048576);
      if (current === journal.after) {
        if (next) io.atomic(base + '/manifest.json', JSON.stringify(next)); else io.unlink(base + '/manifest.json');
        journal.remove.forEach(clean);
      } else if (current === journal.before) { if (journal.created) clean(journal.created); }
      else fail('installation_recovery_conflict');
      io.unlink(base + '/pending.json');
    }
    try {
      recover(); raw = io.read(target, 1048576); old = manifest(io.read(base + '/manifest.json', 1048576));
      if (action === 'uninstall' && !old) return { action: action, changed: false };
      var prepared = action === 'install' ? legacy(hooks(raw)) : null;
      var id = io.uuid(), nextEntries = action === 'install' ? entries(id) : [];
      var next = action === 'install' ? { version: 2, release: id, entries: nextEntries } : null;
      var after = JSON.stringify(prepared ? mergeInstallation(prepared, old, nextEntries) : merge(hooks(raw), old, nextEntries), null, 2) + '\n';
      if (raw !== null) io.create(base + '/hooks-backup-' + io.uuid() + '.json', raw);
      io.atomic(base + '/pending.json', JSON.stringify({ before: raw, after: after, manifest: next, created: next ? id : null, remove: old ? [old.release] : [] }));
      if (next) {
        io.directory(base + '/' + id, true);
        io.releaseFiles.forEach(function (file) { io.create(base + '/' + id + '/' + file, io.read(io.source + '/' + file, 1048576)); });
        io.create(base + '/' + id + '/config.json', JSON.stringify(settings));
      }
      if (io.read(target, 1048576) !== raw) fail('hooks_changed_during_install');
      io.atomic(target, after); recover();
      return { action: action, changed: true, profile: profile, restart_trae_required: true };
    } finally { unlock(); }
  }
  function projectPath(value, platform) {
    // eslint-disable-next-line no-control-regex -- Reject control characters at the untrusted path/address boundary.
    if (typeof value !== 'string' || !value || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) return null;
    if (platform === 'macos') return value[0] === '/' ? value.replace(/\/+$/, '') || '/' : null;
    var path = value.replace(/\\/g, '/');
    return /^[a-z]:\//i.test(path) || /^\/\/[^/]+\/[^/]+/.test(path) ? path.replace(/^[a-z]:/, function (drive) { return drive.toUpperCase(); }).replace(/\/+$/, '') : null;
  }
  function projectAddress(raw) {
    // eslint-disable-next-line no-control-regex -- Reject control characters at the untrusted path/address boundary.
    if (typeof raw !== 'string' || !raw || raw.length > 4096 || /[\s\\\u0000-\u001f\u007f]/.test(raw)) return null;
    var match = /^(https?|ssh|git):\/\/([^/?#]+)(\/[^?#]*)(?:[?#].*)?$/i.exec(raw), host, port = '', path;
    if (match) {
      var authority = match[2].slice(match[2].lastIndexOf('@') + 1), parts = /^(\[[0-9a-f:.]+\]|[^:]+)(?::([0-9]{1,5}))?$/i.exec(authority);
      if (!parts || (parts[2] && (Number(parts[2]) < 1 || Number(parts[2]) > 65535))) return null;
      host = parts[1].toLowerCase(); port = parts[2] ? ':' + parts[2] : ''; path = match[3];
    } else {
      if (/^[a-z]:\//i.test(raw) || raw.indexOf('://') !== -1) return null;
      var scp = /^(?:[^:@/]+@)?(\[[0-9a-f:.]+\]|[^:/@]+):([^?#]+)(?:[?#].*)?$/i.exec(raw);
      if (!scp || scp[2][0] === ':') return null; host = scp[1].toLowerCase(); path = scp[2];
    }
    if (!host || host.length > 253 || /[\s\\/@?#%]/.test(host) || path === '/' || /[<>"']|%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(path)) return null;
    if (host[0] !== '[') {
      if (/^[0-9.]+$/.test(host)) { var octets = host.split('.'); if (octets.length !== 4 || !octets.every(function (part) { return /^(?:0|[1-9][0-9]{0,2})$/.test(part) && Number(part) <= 255; })) return null; }
      else if (!host.split('.').every(function (label) { return label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label); })) return null;
    }
    return match ? match[1].toLowerCase() + '://' + host + port + path : host + ':' + path;
  }
  function project(io, settings, payload) {
    function json(path, limit) { var raw; try { raw = io.read(path, limit); } catch (error) { if (error.message === 'oversized_file') return null; throw error; } try { return raw === null ? null : JSON.parse(raw); } catch { return null; } }
    function validState(state) { return object(state) && state.version === 1 && uuidPattern.test(state.collector_id) && typeof state.sequence === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(state.sequence) && state.sequence.length <= 19 && (state.sequence.length < 19 || state.sequence <= '9223372036854775807') && state.checksum === io.hash(JSON.stringify([state.collector_id, state.sequence])); }
    function increment(sequence) { var digits = sequence.split(''), at = digits.length - 1; while (at >= 0 && digits[at] === '9') { digits[at] = '0'; at--; } if (at < 0) digits.unshift('1'); else digits[at] = String(Number(digits[at]) + 1); return digits.join(''); }
    function saveState(state) { state.checksum = io.hash(JSON.stringify([state.collector_id, state.sequence])); io.atomic(io.root + '/identity.json', JSON.stringify(state)); }
    function cacheHash(cache) { return io.hash(JSON.stringify([cache.collector_id, cache.account, cache.workspace, cache.attempt_at, cache.attempt_tick, cache.reservation, cache.sequence, cache.observation])); }
    function saveCache(cache) { cache.checksum = cacheHash(cache); io.atomic(key, JSON.stringify(cache)); }
    var state, unlock, entry, key, context, reserved, fresh = false;
    try {
      io.directory(io.root); io.directory(io.root + '/cache');
      var roots = payload.workspace_roots, workspace = payload.cwd, reason = null;
      if (Array.isArray(roots) && roots.length > 1) { workspace = null; reason = 'ambiguous_workspace'; }
      else if (!projectPath(workspace, io.platform)) { workspace = Array.isArray(roots) && roots.length === 1 ? roots[0] : null; if (!projectPath(workspace, io.platform)) { reason = payload.cwd || workspace ? 'invalid_workspace' : 'missing_workspace'; workspace = null; } }
      var account = io.hash(JSON.stringify([settings.installation_id, settings.token, settings.endpoint, settings.runtime_generation]));
      var normalized = workspace === null ? null : projectPath(workspace, io.platform);
      key = io.root + '/cache/' + io.hash(JSON.stringify([account, io.platform, normalized])) + '.json';
      function cached() {
        var raw = io.read(key, 524288), cache; if (raw === null) return null;
        try { cache = JSON.parse(raw); } catch { return { invalid: true }; }
        if (object(cache) && uuidPattern.test(cache.collector_id) && cache.collector_id !== state.collector_id) return null;
        return object(cache) && cache.version === 1 && cache.collector_id === state.collector_id && cache.account === account && cache.workspace === normalized && cache.checksum === cacheHash(cache) ? cache : { invalid: true };
      }
      function output(observation) { return { collector_id: state.collector_id, platform: io.platform, workspace: workspace, unresolved_reason: reason, observation: observation || null }; }
      try { unlock = io.lock(); } catch {
        state = json(io.root + '/identity.json', 16384); if (!validState(state)) return null;
        entry = cached(); return output(entry && entry.observation);
      }
      try {
        state = json(io.root + '/identity.json', 16384);
        if (!validState(state)) { state = { version: 1, collector_id: io.uuid(), sequence: '0' }; saveState(state); fresh = true; }
        if (workspace === null) return output(null);
        entry = fresh ? null : cached(); var tick = io.tick(), now = io.now();
        if (entry && entry.invalid) {
          // An unreadable cache is not permission to probe repeatedly. Preserve
          // the instance and sequence, fence retries for five minutes, and send
          // the real Hook with no fabricated Git result.
          saveCache({ version: 1, collector_id: state.collector_id, account: account, workspace: normalized, attempt_at: now, attempt_tick: tick, reservation: io.uuid(), sequence: state.sequence, observation: null });
          return output(null);
        }
        if (entry && typeof entry.attempt_tick === 'number' && typeof entry.attempt_at === 'number') {
          var elapsed = tick >= entry.attempt_tick ? tick - entry.attempt_tick : now - entry.attempt_at;
          if (elapsed < 0) { entry.attempt_tick = tick; entry.attempt_at = now; saveCache(entry); return output(entry.observation); }
          if (elapsed < 300000) return output(entry.observation);
        }
        var sequence = increment(state.sequence);
        if (sequence.length > 19 || (sequence.length === 19 && sequence > '9223372036854775807')) { state = { version: 1, collector_id: io.uuid(), sequence: '0' }; sequence = '1'; entry = null; }
        state.sequence = sequence; saveState(state);
        reserved = { version: 1, collector_id: state.collector_id, account: account, workspace: normalized, attempt_at: now, attempt_tick: tick, reservation: io.uuid(), sequence: sequence, observation: entry && entry.observation || null };
        saveCache(reserved); context = output(null);
      } finally { unlock(); unlock = null; }
      var observation = { id: reserved.reservation, sequence: reserved.sequence, observed_at: new Date(reserved.attempt_at).toISOString(), state: 'failed', reason: 'git_error', git_root: null, remotes: [] };
      try { var found = io.probe(workspace); observation.state = found.state; observation.reason = found.reason; observation.git_root = found.git_root; observation.remotes = found.remotes; } catch { /* Normal Hook delivery still proceeds. */ }
      context.observation = observation;
      try { unlock = io.lock(); entry = cached(); if (entry && entry.reservation === reserved.reservation) { entry.observation = observation; saveCache(entry); } } finally { if (unlock) { unlock(); unlock = null; } }
      return context;
    } catch { return context || null; } finally { if (unlock) unlock(); }
  }
  function projectRemotes(remotes) {
    var result = [], addresses = [];
    remotes.forEach(function (remote) {
      var address = projectAddress(remote.address);
      if (addresses.indexOf(address) === -1) { addresses.push(address); result.push({ address: address }); }
    });
    return result;
  }
  return { install: install, config: config, runtimeGeneration: runtimeGeneration, envelope: envelope, project: project, projectAddress: projectAddress, projectRemotes: projectRemotes, projectPath: projectPath, fail: fail };
}());
