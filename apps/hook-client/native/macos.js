/* global ObjC, $, ADI */
/* exported run */
ObjC.import('Foundation');
ObjC.bindFunction('kill', ['int', ['int', 'int']]);
ObjC.bindFunction('__error', ['int *', []]);
ObjC.bindFunction('exit', ['void', ['int']]);

/* global Ref -- JXA typed pointer used with the SDK sysctlbyname ABI. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- JXA host entry point
function run(argv) {
  var fm = $.NSFileManager.defaultManager, startedAt = Number($.NSProcessInfo.processInfo.systemUptime) * 1000;
  var source = argv.shift();
  function text(value) { return ObjC.unwrap(value); }
  function kind(path) { var attrs = fm.attributesOfItemAtPathError($(path), null); return attrs.isNil() ? null : text(attrs.objectForKey('NSFileType')); }
  function read(path, maximum) {
    var type = kind(path); if (type === null) return null;
    if (type !== 'NSFileTypeRegular') ADI.fail('unsafe_installation_path');
    var attrs = fm.attributesOfItemAtPathError($(path), null);
    if (Number(text(attrs.objectForKey('NSFileSize'))) > maximum) ADI.fail('oversized_file');
    var bytes = $.NSData.dataWithContentsOfFile($(path));
    if (bytes.isNil() || Number(bytes.length) > maximum) ADI.fail('invalid_file');
    var value = $.NSString.alloc.initWithDataEncoding(bytes, $.NSUTF8StringEncoding);
    if (value.isNil()) ADI.fail('invalid_utf8'); return text(value);
  }
  function attrs() { return $({ NSFilePosixPermissions: 448 }); }
  function protect(path, mode) { if (!fm.setAttributesOfItemAtPathError($({ NSFilePosixPermissions: mode }), $(path), null)) ADI.fail('private_permissions_failed'); }
  function directory(path, privatePath) {
    var type = kind(path);
    if (type === null) { if (!fm.createDirectoryAtPathWithIntermediateDirectoriesAttributesError($(path), true, attrs(), null)) ADI.fail('directory_failed'); }
    else if (type !== 'NSFileTypeDirectory') ADI.fail('unsafe_installation_path');
    if (privatePath) protect(path, 448);
  }
  function write(path, value, replace) {
    if (typeof value !== 'string') ADI.fail('missing_release_file');
    var type = kind(path);
    if (type !== null && (type !== 'NSFileTypeRegular' || !replace)) ADI.fail('unsafe_installation_path');
    var data = $(value).dataUsingEncoding($.NSUTF8StringEncoding);
    if (!data.writeToFileOptionsError($(path), replace ? 1 : 2, null)) ADI.fail('write_failed');
    protect(path, 384);
  }
  function unlink(path) { var type = kind(path); if (type === null) return; if (type !== 'NSFileTypeRegular') ADI.fail('unsafe_installation_path'); if (!fm.removeItemAtPathError($(path), null)) ADI.fail('remove_failed'); }
  function rmdir(path) { if (kind(path) === null) return; if (kind(path) !== 'NSFileTypeDirectory') ADI.fail('unsafe_installation_path'); var files = fm.contentsOfDirectoryAtPathError($(path), null); if (!files.isNil() && Number(files.count) === 0 && !fm.removeItemAtPathError($(path), null)) ADI.fail('remove_failed'); }
  function validUrl(value) {
    var url = $.NSURLComponents.componentsWithString($(value));
    if (url.isNil()) return false;
    return ['http', 'https'].indexOf(text(url.scheme)) !== -1 && !!text(url.host) && text(url.path) === '/hooks' && url.user.isNil() && url.password.isNil() && url.query.isNil() && url.fragment.isNil();
  }
  var diagnostic = null;
  function diagnosticStart(settings) {
    try {
      var home = text($.NSProcessInfo.processInfo.environment.objectForKey('HOME')) || text($.NSHomeDirectory()), path = home + '/.trae-cn/adi-plugin-control/verification.json';
      var info = fm.attributesOfItemAtPathError($(path), null);
      if (info.isNil() || (Number(text(info.objectForKey('NSFilePosixPermissions'))) & 63) !== 0) return;
      var marker = JSON.parse(read(path, 1024) || 'null'), now = Date.now();
      if (!marker || !/^[a-f0-9-]{36}$/.test(marker.verification) || !Number.isInteger(marker.port) || marker.port < 1024 || marker.port > 65535 || !Number.isSafeInteger(marker.deadline) || marker.deadline <= now || marker.deadline - now > 1800000 || marker.owner !== settings.runtime_owner) return;
      diagnostic = { verification: marker.verification, port: marker.port, operation: uuid() };
      ObjC.bindFunction('socket', ['int', ['int', 'int', 'int']]);
      ObjC.bindFunction('sendto', ['long', ['int', 'void *', 'unsigned long', 'int', 'void *', 'unsigned int']]);
      ObjC.bindFunction('close', ['int', ['int']]);
      diagnosticEmit('hook.entry', 'start');
    } catch { diagnostic = null; }
  }
  function diagnosticEmit(stage, phase, code) {
    if (!diagnostic || Number($.NSProcessInfo.processInfo.systemUptime) * 1000 - startedAt >= 700) return;
    try {
      var event = { verification: diagnostic.verification, operation: diagnostic.operation, stage: stage, phase: phase, elapsed_ms: Math.round(Number($.NSProcessInfo.processInfo.systemUptime) * 1000 - startedAt) };
      if (code) event.code = code;
      var bytes = $(JSON.stringify(event)).dataUsingEncoding($.NSUTF8StringEncoding), port = diagnostic.port;
      // Darwin sockaddr_in; MSG_DONTWAIT drops on pressure, never waits for logging.
      var address = $(String.fromCharCode(16, 2, port >>> 8, port & 255, 127, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0)).dataUsingEncoding($.NSISOLatin1StringEncoding);
      var fd = $.socket(2, 2, 0); if (fd < 0) return;
      try { $.sendto(fd, bytes.bytes, Number(bytes.length), 128, address.bytes, 16); } finally { $.close(fd); }
    } catch { /* Diagnostic loss never changes delivery. */ }
  }
  var runtimeBootScope = null;
  function runtimeClock() {
    if (runtimeBootScope === null) {
      ObjC.bindFunction('sysctlbyname', ['int', ['char *', 'void *', 'unsigned long *', 'void *', 'unsigned long']]);
      var size = Ref();
      if ($.sysctlbyname('kern.bootsessionuuid', null, size, null, 0) !== 0 || Number(size[0]) !== 37) return null;
      var bytes = $.NSMutableData.dataWithLength(Number(size[0]));
      if ($.sysctlbyname('kern.bootsessionuuid', bytes.mutableBytes, size, null, 0) !== 0) return null;
      var id = $.NSString.alloc.initWithDataEncoding(bytes, $.NSUTF8StringEncoding);
      if (id.isNil()) return null;
      runtimeBootScope = 'macos:' + text(id).split(String.fromCharCode(0))[0].toLowerCase();
      ObjC.bindFunction('clock_gettime_nsec_np', ['uint64_t', ['int']]);
    }
    // CLOCK_MONOTONIC_RAW (4) uses continuous boot time, including sleep.
    return { kind: 'macos-continuous-v1', scope: runtimeBootScope, monotonic_ms: Math.floor(Number($.clock_gettime_nsec_np(4)) / 1000000) };
  }
  function runtimeGeneration(settings) {
    var home = text($.NSProcessInfo.processInfo.environment.objectForKey('HOME')) || text($.NSHomeDirectory());
    if (typeof home !== 'string' || home[0] !== '/') return null;
    var profile = home.replace(/\/+$/, '') + '/.trae-cn', directoryPath = profile + '/adi-plugin-control', path = directoryPath + '/control.json';
    if (kind(profile) !== 'NSFileTypeDirectory' || kind(directoryPath) !== 'NSFileTypeDirectory') return null;
    var info = fm.attributesOfItemAtPathError($(path), null);
    if (info.isNil() || (Number(text(info.objectForKey('NSFilePosixPermissions'))) & 63) !== 0) return null;
    return ADI.runtimeGeneration(JSON.parse(read(path, 32768) || 'null'), settings.runtime_owner, Date.now(), runtimeClock());
  }
  function uuid() { return text($.NSUUID.UUID.UUIDString).toLowerCase(); }
  function quote(value) { return "'" + value.replace(/'/g, "'\\''") + "'"; }
  function lock(base) {
    var path = base + '/install.lock';
    for (var attempt = 0; attempt < 2; attempt++) {
      if (fm.createDirectoryAtPathWithIntermediateDirectoriesAttributesError($(path), false, attrs(), null)) {
        var owner = path + '/owner-' + uuid(); write(owner, String($.NSProcessInfo.processInfo.processIdentifier), false);
        return function () { unlink(owner); rmdir(path); };
      }
      if (kind(path) !== 'NSFileTypeDirectory') ADI.fail('installation_busy');
      var names = ObjC.deepUnwrap(fm.contentsOfDirectoryAtPathError($(path), null));
      if (!names || names.length !== 1 || !/^owner-[0-9a-f-]{36}$/.test(names[0])) ADI.fail('installation_busy');
      var pid = Number(read(path + '/' + names[0], 32));
      if (!Number.isSafeInteger(pid) || pid <= 0) ADI.fail('installation_busy');
      if ($.kill(pid, 0) === 0 || $.__error()[0] !== 3) ADI.fail('installation_busy');
      unlink(path + '/' + names[0]); rmdir(path);
    }
    ADI.fail('installation_busy');
  }
  function projectObservation(configPath, settings, payload) {
    var release = text($(configPath).stringByDeletingLastPathComponent), base = text($(release).stringByDeletingLastPathComponent);
    if (!/^[0-9a-f-]{36}$/.test(text($(release).lastPathComponent)) || read(base + '/.owned', 128) !== 'adi-native-client-v2') return null;
    ObjC.bindFunction('CC_SHA256', ['void *', ['void *', 'unsigned int', 'void *']]);
    ObjC.bindFunction('open', ['int', ['char *', 'int']]);
    ObjC.bindFunction('close', ['int', ['int']]); ObjC.bindFunction('fsync', ['int', ['int']]);
    ObjC.bindFunction('flock', ['int', ['int', 'int']]);
    ObjC.bindFunction('poll', ['int', ['void *', 'unsigned int', 'int']]);
    ObjC.bindFunction('getpgid', ['int', ['int']]);
    ObjC.bindFunction('read', ['long', ['int', 'void *', 'unsigned long']]);
    var root = base + '/project-state';
    function hash(value) {
      var input = $(value).dataUsingEncoding($.NSUTF8StringEncoding), digest = $.NSMutableData.dataWithLength(32);
      $.CC_SHA256(input.bytes, Number(input.length), digest.mutableBytes);
      var encoded = text(digest.base64EncodedStringWithOptions(0)), alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', bits = 0, buffer = 0, result = '';
      for (var i = 0; i < encoded.length && encoded[i] !== '='; i++) { buffer = (buffer << 6) | alphabet.indexOf(encoded[i]); bits += 6; if (bits >= 8) { bits -= 8; var byte = (buffer >>> bits) & 255; result += ('0' + byte.toString(16)).slice(-2); } }
      return result;
    }
    function tick() { return Number($.NSProcessInfo.processInfo.systemUptime) * 1000; }
    function privateRead(path, limit) {
      var info = fm.attributesOfItemAtPathError($(path), null);
      if (!info.isNil() && (Number(text(info.objectForKey('NSFilePosixPermissions'))) & 63) !== 0) ADI.fail('unsafe_state_permissions');
      return read(path, limit);
    }
    function atomic(path, value) {
      write(path, value, true);
      var file = $.NSFileHandle.fileHandleForWritingAtPath($(path)); if (file.isNil()) ADI.fail('state_sync_failed');
      void file.synchronizeFile; void file.closeFile;
      var fd = $.open(text($(path).stringByDeletingLastPathComponent), 0);
      if (fd < 0) ADI.fail('state_sync_failed'); try { if ($.fsync(fd) !== 0) ADI.fail('state_sync_failed'); } finally { $.close(fd); }
    }
    function stateLock() {
      var path = root + '/state.lock';
      // Avoid the variadic open(O_CREAT, mode) ABI through JXA. Foundation's
      // no-overwrite creation is atomic; flock itself is released on process exit.
      if (kind(path) === null) { try { write(path, '', false); } catch (error) { if (kind(path) !== 'NSFileTypeRegular') throw error; } }
      if (kind(path) !== 'NSFileTypeRegular') ADI.fail('unsafe_state_lock');
      protect(path, 384);
      var fd = $.open(path, 258); // Darwin O_RDWR|O_NOFOLLOW, existing private file.
      if (fd < 0) ADI.fail('state_lock_failed');
      if ($.flock(fd, 6) !== 0) { $.close(fd); ADI.fail('state_busy'); }
      return function () { $.flock(fd, 8); $.close(fd); };
    }
    var environment = ObjC.deepUnwrap($.NSProcessInfo.processInfo.environment);
    Object.keys(environment).forEach(function (key) { if (/^GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|CEILING_DIRECTORIES|CONFIG|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_.*|CONFIG_VALUE_.*|TRACE.*|CURL_VERBOSE)$/.test(key)) delete environment[key]; });
    environment.GIT_TERMINAL_PROMPT = '0'; environment.GIT_OPTIONAL_LOCKS = '0'; environment.LC_ALL = 'C';
    function findGit() {
      var paths = (environment.PATH || '/usr/bin:/bin').split(':');
      for (var i = 0; i < paths.length; i++) {
        if (paths[i][0] !== '/') continue;
        var candidate = paths[i].replace(/\/+$/, '') + '/git';
        if (candidate === '/usr/bin/git') {
          var direct = [environment.DEVELOPER_DIR ? environment.DEVELOPER_DIR + '/usr/bin/git' : '', '/Library/Developer/CommandLineTools/usr/bin/git', '/Applications/Xcode.app/Contents/Developer/usr/bin/git'];
          for (var j = 0; j < direct.length; j++) if (direct[j] && fm.isExecutableFileAtPath($(direct[j]))) return direct[j];
        } else if (fm.isExecutableFileAtPath($(candidate))) return candidate;
      }return null;
    }
    function probe(workspace) {
      if (runtimeGeneration(settings) !== settings.runtime_generation) throw new Error('runtime_unavailable');
      var executable = findGit(), deadline = tick() + 180;
      function failed(reason) { return { state: 'failed', reason: reason, git_root: null, remotes: [] }; }
      if (!executable) return failed('git_missing');
      function command(args) {
        if (tick() >= deadline) throw new Error('timeout');
        var task = $.NSTask.alloc.init, out = $.NSPipe.pipe, err = $.NSPipe.pipe, output = $.NSMutableData.data, errors = $.NSMutableData.data, buffer = $.NSMutableData.dataWithLength(65536), group = null;
        // Launch the already available system shell so the child group is known
        // before macOS assesses a newly installed Git executable. The command is
        // fixed, all Git arguments remain separate argv, and -p ignores BASH_ENV.
        task.launchPath = '/bin/bash'; task.arguments = $(['--noprofile', '--norc', '-p', '-c', 'exec "$@"', 'adi-project-git', executable, '-C', workspace].concat(args)); task.environment = $(environment); task.standardOutput = out; task.standardError = err;
        function descriptor(pipe) {
          var fd = Number(pipe.fileHandleForReading.fileDescriptor);
          // Darwin pollfd is { int fd; short events; short revents; } on both
          // supported architectures. A mutable buffer lets poll write revents.
          return $(String.fromCharCode(fd & 255, (fd >>> 8) & 255, (fd >>> 16) & 255, (fd >>> 24) & 255, 1, 0, 0, 0)).dataUsingEncoding($.NSISOLatin1StringEncoding).mutableCopy;
        }
        var outPoll = descriptor(out), errPoll = descriptor(err);
        function drain(pipe, bytes) {
          var ready, count, pollDescriptor = pipe === out ? outPoll : errPoll;
          // fcntl's variadic F_SETFL argument cannot be passed reliably through
          // JXA's fixed-argument bridge on Apple Silicon. poll is non-variadic;
          // read only when this single-reader pipe has bytes or EOF available.
          while ((ready = $.poll(pollDescriptor.mutableBytes, 1, 0)) > 0) {
            if (tick() >= deadline) throw new Error('timeout');
            count = Number($.read(Number(pipe.fileHandleForReading.fileDescriptor), buffer.mutableBytes, 65536));
            if (count <= 0) break;
            if (Number(bytes.length) + count > 262144) throw new Error('output_limit'); bytes.appendBytesLength(buffer.bytes, count);
          }
          if (ready < 0) throw new Error('git_error');
        }
        try {
          void task.launch;
          var pid = Number(task.processIdentifier); if ($.getpgid(pid) === pid) group = pid;
          void out.fileHandleForWriting.closeFile; void err.fileHandleForWriting.closeFile;
          while (task.isRunning) { drain(out, output); drain(err, errors); if (tick() >= deadline) throw new Error('timeout'); $.NSThread.sleepForTimeInterval(0.002); }
          drain(out, output); drain(err, errors);
          var stdout = $.NSString.alloc.initWithDataEncoding(output, $.NSUTF8StringEncoding), stderr = $.NSString.alloc.initWithDataEncoding(errors, $.NSUTF8StringEncoding);
          if (stdout.isNil() || stderr.isNil()) throw new Error('invalid_git_output');
          return { code: Number(task.terminationStatus), out: text(stdout), err: text(stderr) };
        } finally {
          // NSTask creates its own process group; the outer sender group alone
          // cannot reach a Git wrapper's surviving children, even after exit.
          if (group !== null) $.kill(-group, 9);
          if (task.isRunning) { void task.terminate; $.kill(Number(task.processIdentifier), 9); }
          try { void out.fileHandleForReading.closeFile; void err.fileHandleForReading.closeFile; } catch { /* Already closed. */ }
        }
      }
      try {
        var top = command(['rev-parse', '--show-toplevel']);
        if (top.code !== 0) return /(^|\n)fatal: not a git repository/.test(top.err) ? { state: 'not_git', reason: null, git_root: null, remotes: [] } : failed(/cannot change to|Permission denied/.test(top.err) ? 'inaccessible' : 'git_error');
        var gitRoot = top.out.replace(/\n$/, ''); if (!ADI.projectPath(gitRoot, 'macos')) return failed('invalid_git_output');
        var config = command(['config', '--null', '--get-regexp', '^remote\\..*\\.(url|pushurl)$']);
        if (config.code === 1 && !config.out) return { state: 'no_remote', reason: null, git_root: gitRoot, remotes: [] };
        if (config.code !== 0 || !config.out || config.out[config.out.length - 1] !== '\0') return failed('git_error');
        var names = [], entries = Object.create(null), invalid = false;
        config.out.slice(0, -1).split('\0').forEach(function (line) {
          var separator = line.indexOf('\n'), match = /^remote\.(.+)\.(url|pushurl)$/.exec(line.slice(0, separator)), value = line.slice(separator + 1);
          // eslint-disable-next-line no-control-regex -- Git config values containing controls cannot be framed as URL lines.
          if (separator < 0 || !match || !value || match[1].length > 128 || /[\u0000-\u001f\u007f]/.test(match[1] + value)) { invalid = true; return; }
          if (!entries[match[1]]) { entries[match[1]] = { url: [], pushurl: [] }; names.push(match[1]); } entries[match[1]][match[2]].push(value);
        });
        if (invalid) return failed('invalid_git_output');
        var remotes = []; names.sort();
        for (var n = 0; n < names.length; n++) {
          var name = names[n], entry = entries[name];
          for (var direction = 0; direction < 2; direction++) {
            var expected = direction ? entry.pushurl.length || entry.url.length : entry.url.length; if (!expected) continue;
            if (remotes.length + expected > 64) return failed('output_limit');
            var urls = command(['remote', 'get-url'].concat(direction ? ['--push'] : []).concat(['--all', '--', name]));
            if (urls.code !== 0 || !urls.out.endsWith('\n')) return failed('git_error');
            var values = urls.out.slice(0, -1).split('\n'); if (values.length !== expected) return failed('invalid_git_output');
            values.forEach(function (value) { remotes.push({ address: value }); });
          }
        }
        return { state: remotes.length ? 'repository' : 'no_remote', reason: null, git_root: gitRoot, remotes: ADI.projectRemotes(remotes) };
      } catch (error) { return failed(['timeout', 'output_limit', 'invalid_git_output'].indexOf(error.message) !== -1 ? error.message : 'git_error'); }
    }
    return ADI.project({ root: root, platform: 'macos', uuid: uuid, hash: hash, tick: tick, now: Date.now, read: privateRead, atomic: atomic, directory: function (path) { directory(path, true); }, lock: stateLock, probe: probe }, settings, payload);
  }
  // Optional filesystem/Git work runs separately so a blocked state read
  // cannot prevent the ordinary Hook from reaching curl. No spool is created.
  function boundedProject(configPath, raw) {
    ObjC.bindFunction('poll', ['int', ['void *', 'unsigned int', 'int']]);
    ObjC.bindFunction('read', ['long', ['int', 'void *', 'unsigned long']]);
    ObjC.bindFunction('getpgid', ['int', ['int']]);
    function tick() { return Number($.NSProcessInfo.processInfo.systemUptime) * 1000; }
    var budget = 450 - (tick() - startedAt); if (budget <= 0) return null;
    var task = $.NSTask.alloc.init, output = $.NSPipe.pipe, inputPipe = $.NSPipe.pipe;
    // This child's independent guard also ends it if the sender is interrupted.
    var wrapper = "set +m\ncleanup() {\n  result=$?\n  trap - EXIT HUP INT TERM\n  # Freeze the owned project process before discovering its live descendants.\n  # It cannot create another Git group between discovery and termination.\n  parent=$(/bin/ps -o ppid= -p \"$child\" 2>/dev/null)\n  if [ \"${parent//[[:space:]]/}\" = \"$$\" ]; then\n    kill -STOP \"$child\" 2>/dev/null || :\n    groups=$(/bin/ps -axo pid=,ppid=,pgid= | /usr/bin/awk -v root=\"$$\" '\n      { p[NR]=$1; parent[NR]=$2; group[NR]=$3 }\n      END {\n        owned[root]=1\n        for(pass=0;pass<NR;pass++) {\n          changed=0\n          for(i=1;i<=NR;i++) if(!owned[p[i]]&&owned[parent[i]]) { owned[p[i]]=1; changed=1 }\n          if(!changed)break\n        }\n        for(i=1;i<=NR;i++) if(owned[p[i]]&&group[i]>1&&group[i]!=root) groups[group[i]]=1\n        for(g in groups)print g\n      }')\n    for group in $groups; do kill -TERM -- \"-$group\" 2>/dev/null || :; kill -KILL -- \"-$group\" 2>/dev/null || :; done\n    kill -KILL \"$child\" 2>/dev/null || :\n  fi\n  kill -TERM \"$timer\" 2>/dev/null || :\n  wait \"$child\" 2>/dev/null || :\n  wait \"$timer\" 2>/dev/null || :\n  exit \"$result\"\n}\nexec 3<&0\n\"$@\" <&3 & child=$!\n( /bin/sleep 0.5; kill -TERM \"$$\" 2>/dev/null ) & timer=$!\ntrap cleanup EXIT HUP INT TERM\nwait \"$child\"\nexit $?";
    task.launchPath = '/bin/bash';
    task.arguments = $(['--noprofile', '--norc', '-c', wrapper, 'adi-project', '/usr/bin/osascript', '-l', 'JavaScript', source + '/native-macos.js', source, '--project', configPath]);
    task.standardInput = inputPipe; task.standardOutput = output; task.standardError = $.NSFileHandle.fileHandleWithNullDevice;
    var pid = null, data = $.NSMutableData.data, fd = Number(output.fileHandleForReading.fileDescriptor), deadline = tick() + budget;
    function drain() {
      var descriptor = $(String.fromCharCode(fd & 255, (fd >>> 8) & 255, (fd >>> 16) & 255, (fd >>> 24) & 255, 1, 0, 0, 0)).dataUsingEncoding($.NSISOLatin1StringEncoding).mutableCopy;
      while ($.poll(descriptor.mutableBytes, 1, 0) > 0) {
        var buffer = $.NSMutableData.dataWithLength(8192), count = Number($.read(fd, buffer.mutableBytes, 8192)); if (count <= 0) break;
        data.appendBytesLength(buffer.bytes, count); if (Number(data.length) > 262144) throw new Error('output_limit');
      }
    }
    try {
      void task.launch; pid = Number(task.processIdentifier); void output.fileHandleForWriting.closeFile;
      inputPipe.fileHandleForWriting.writeData($(raw).dataUsingEncoding($.NSUTF8StringEncoding)); void inputPipe.fileHandleForWriting.closeFile;
      while (task.isRunning) { drain(); if (tick() >= deadline) return null; $.NSThread.sleepForTimeInterval(0.002); }
      drain(); if (Number(task.terminationStatus) !== 0) return null;
      var value = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding); return value.isNil() ? null : JSON.parse(text(value));
    } finally {
      if (pid && task.isRunning) {
        // Let the wrapper freeze/reap separately grouped Git descendants first.
        $.kill(pid, 15); var cleanupDeadline = tick() + 50;
        while (task.isRunning && tick() < cleanupDeadline) $.NSThread.sleepForTimeInterval(0.002);
      }
      if (pid && $.getpgid(pid) === pid) $.kill(-pid, 9);
      if (task.isRunning) { void task.terminate; void task.waitUntilExit; }
      try { void inputPipe.fileHandleForWriting.closeFile; } catch { /* already closed */ }
    }
  }
  try {
    if (argv[0] === '--project') {
      if (argv.length !== 2) return;
      var projectConfig = argv[1], projectSettings = ADI.config(JSON.parse(read(projectConfig, 16384) || 'null'), null, validUrl);
      var projectGeneration = runtimeGeneration(projectSettings); if (!projectGeneration) return;
      projectSettings.runtime_generation = projectGeneration;
      var projectBytes = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
      if (Number(projectBytes.length) >= 1700000) return;
      var projectRaw = $.NSString.alloc.initWithDataEncoding(projectBytes, $.NSUTF8StringEncoding); if (projectRaw.isNil()) return;
      return JSON.stringify(projectObservation(projectConfig, projectSettings, JSON.parse(text(projectRaw))));
    }
    if (argv[0] === '--send') {
      var observedAt = new Date().toISOString();
      if (argv.length !== 2) return;
      var configPath = argv[1], configAttrs = fm.attributesOfItemAtPathError($(configPath), null);
      if (configAttrs.isNil() || (Number(text(configAttrs.objectForKey('NSFilePosixPermissions'))) & 63) !== 0) return;
      var settings = ADI.config(JSON.parse(read(configPath, 16384) || 'null'), null, validUrl);
      diagnosticStart(settings);
      var generation = runtimeGeneration(settings); if (!generation) { diagnosticEmit('hook.runtime', 'skipped', 'runtime_unavailable'); return; }
      diagnosticEmit('hook.runtime', 'success');
      settings.runtime_generation = generation;
      diagnosticEmit('hook.payload', 'start');
      var input = $.NSFileHandle.fileHandleWithStandardInput, bytes = $.NSMutableData.data;
      while (true) { var chunk = input.readDataOfLength(65536); if (Number(chunk.length) === 0) break; if (Number(bytes.length) + Number(chunk.length) > 2095104) { diagnosticEmit('hook.payload', 'skipped', 'invalid_payload'); return; } bytes.appendData(chunk); }
      var decoded = $.NSString.alloc.initWithDataEncoding(bytes, $.NSUTF8StringEncoding); if (decoded.isNil()) return;
      var body = ADI.envelope(text(decoded), settings, uuid(), observedAt);
      diagnosticEmit('hook.payload', 'success');
      var project = null;
      if (Number(bytes.length) < 1700000) { try { project = boundedProject(configPath, text(decoded)); } catch { /* Optional observation never prevents normal delivery. */ } }
      if (project) { var expanded = ADI.envelope(text(decoded), settings, uuid(), observedAt, project); if (Number($(expanded).lengthOfBytesUsingEncoding($.NSUTF8StringEncoding)) <= 2097152) body = expanded; }
      if (runtimeGeneration(settings) !== generation) { diagnosticEmit('hook.send', 'skipped', 'runtime_changed'); return; }
      diagnosticEmit('hook.send', 'start');
      // Feed curl configuration via stdin: credentials and payload are never argv.
      function curlQuote(value) { return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\t/g, '\\t') + '"'; }
      var comment = diagnostic ? '# adi-diagnostic ' + diagnostic.port + ' ' + diagnostic.verification + ' ' + diagnostic.operation + '\n' : '';
      return comment + 'silent\nshow-error\nmax-time = ' + (project ? '0.35' : '0.65') + '\nconnect-timeout = 0.25\nrequest = "POST"\nurl = ' + curlQuote(settings.endpoint) + '\nheader = "Content-Type: application/json"\nheader = ' + curlQuote('Authorization: Bearer ' + settings.token) + '\ndata-binary = ' + curlQuote(body) + '\n';
    }
    var io = { home: text($.NSHomeDirectory()), source: source, platform: 'macos-system', uuid: uuid, validUrl: validUrl, read: read, directory: directory, lock: lock, unlink: unlink, rmdir: rmdir,
      emptyDirectory: function (path) { var type = kind(path); if (type === null) return true; if (type !== 'NSFileTypeDirectory') return false; return Number(fm.contentsOfDirectoryAtPathError($(path), null).count) === 0; },
      safeDirectory: function (path) { var type = kind(path); if (type !== null && type !== 'NSFileTypeDirectory') ADI.fail('unsafe_installation_path'); },
      absolute: function (path) { var value = $(path).stringByExpandingTildeInPath; if (!value.isAbsolutePath) value = $(text(fm.currentDirectoryPath) + '/' + text(value)); return text(value.stringByStandardizingPath); },
      create: function (path, value) { write(path, value, false); }, atomic: function (path, value) { write(path, value, true); },
      releaseFiles: ['native-macos.js', 'send-hook.sh'],
      command: function (release) { return '/bin/bash ' + quote(release + '/send-hook.sh') + ' ' + quote(release + '/config.json') + ' >/dev/null 2>&1; exit 0'; }
    };
    return JSON.stringify(ADI.install(io, argv));
  } catch (error) {
    if (argv[0] === '--send') diagnosticEmit('hook.error', 'failed', 'hook_failed');
    if (argv[0] === '--send' || argv[0] === '--project') return;
    // Do not include arbitrary Foundation errors, file contents or credentials.
    var code = /^[a-z_]{3,64}$/.test(error.message) ? error.message : 'installation_failed';
    $.NSFileHandle.fileHandleWithStandardOutput.writeData($(JSON.stringify({ error: code }) + '\n').dataUsingEncoding($.NSUTF8StringEncoding));
    $.exit(1);
  }
}
