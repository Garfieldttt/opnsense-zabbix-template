// Zabbix webhook script: restart one WireGuard or AmneziaWG instance on OPNsense.
//
// Parameters (all strings):
//   host, port, key, secret  {HOST.CONN}, {$OPNS.PORT}, {$OPNS.KEY}, {$OPNS.SECRET}
//   instance  interface of the instance, e.g. wg1 or awg0. From the trigger tag
//             {EVENT.TAGS.vpn_if} in an action, or {MANUALINPUT} when run by hand.
//             A trailing " force" in the manual input skips the idle check.
//   idle      how long without any handshake counts as idle, e.g. 10m. From the trigger tag
//             {EVENT.TAGS.vpn_idle} (which carries {$OPNS.VPN.IDLE.TIME} for that interface)
//             or {$OPNS.VPN.IDLE.TIME} when run by hand.
//   force     1 to restart even if a peer completed a handshake within the idle time.
//
// Uses only what the REST API template already reads: wireguard/service/show,
// amneziawg/service/show and core/service (Status: Services privilege). The instance's
// service is found by its description ("WireGuard <name>" / "AmneziaWG <name>").
var p = JSON.parse(value);

function seconds(s) {
    var m = String(s).trim().match(/^(\d+)([smhdw]?)$/);
    if (!m) { throw 'Cannot read idle time "' + s + '": use seconds or a suffix s, m, h, d, w.'; }
    return parseInt(m[1], 10) * ({ '': 1, s: 1, m: 60, h: 3600, d: 86400, w: 604800 })[m[2]];
}

var words = String(p.instance || '').trim().split(/\s+/);
var ifname = words[0];
var force = String(p.force) === '1' || words[1] === 'force';
var type = /^awg\d+$/.test(ifname) ? 'amneziawg' : (/^wg\d+$/.test(ifname) ? 'wireguard' : null);
if (!type) { throw 'Not a WireGuard or AmneziaWG interface: "' + ifname + '". Expected e.g. wg1 or awg0.'; }
var label = type === 'wireguard' ? 'WireGuard' : 'AmneziaWG';
var idle = seconds(p.idle && p.idle.indexOf('{') !== 0 ? p.idle : '10m');

var api = 'https://' + p.host + ':' + p.port + '/api/';
function call(method, path) {
    var r = new HttpRequest();
    r.addHeader('Authorization: Basic ' + btoa(p.key + ':' + p.secret));
    var body;
    if (method === 'post') {
        r.addHeader('Content-Type: application/json');
        body = r.post(api + path, '{}');
    } else {
        body = r.get(api + path);
    }
    if (r.getStatus() !== 200) { throw path + ': HTTP ' + r.getStatus() + ' ' + body; }
    return JSON.parse(body);
}

// instance name and newest handshake
function state() {
    var rows = call('get', type + '/service/show').rows || [], name = null, newest = null;
    for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        if (r.if !== ifname) { continue; }
        if (r.type === 'interface') { name = r.name; }
        var a = r['latest-handshake-age'];
        if (r.type === 'peer' && a !== null && a !== undefined && a !== '') {
            a = parseInt(a, 10);
            if (newest === null || a < newest) { newest = a; }
        }
    }
    return { name: name, newest: newest };
}
var before = state();
if (before.name === null) { throw label + ' interface ' + ifname + ' not found on ' + p.host + '.'; }
if (!force && before.newest !== null && before.newest <= idle) {
    return 'Not restarted: ' + label + ' ' + before.name + ' (' + ifname + ') is active again, last handshake '
        + before.newest + ' s ago (idle limit ' + idle + ' s).';
}

// service id of the instance
var svc = call('get', 'core/service/search').rows || [], id = null;
for (var j = 0; j < svc.length; j++) {
    if (svc[j].id.indexOf(type + '/') === 0 && svc[j].description === label + ' ' + before.name) { id = svc[j].id; }
}
if (id === null) { throw 'No service "' + label + ' ' + before.name + '" in the service list of ' + p.host + '.'; }

call('post', 'core/service/restart/' + id);
var running = 'unknown';
svc = call('get', 'core/service/search').rows || [];
for (var k = 0; k < svc.length; k++) {
    if (svc[k].id === id) { running = svc[k].running ? 'running' : 'not running'; }
}
return 'Restarted ' + label + ' ' + before.name + ' (' + ifname + ') on ' + p.host + (force ? ' (forced)' : '')
    + ': last handshake was ' + (before.newest === null ? 'never' : before.newest + ' s ago') + ', service now ' + running + '.';
