// yeh
var cluster = require('cluster'),
    util = require('util'),
    crypto = require('crypto'),
    md5 = require('md5'),
    chalk = require('chalk');

const GsUtil = require('../lib/GsUtil');
const GsSocket = require('../lib/GsSocket');

var db = GsUtil.dbConnect();

function Log() {
    console.log(chalk.cyan('ClientManager') + '\t\t' + Array.prototype.join.call(arguments, '\t\t'));
}

// Master Process!
if (cluster.isMaster) {
    console.log(chalk.green('Starting Client Manager (8 Forks)'));
    var playerStates = {}

    var newFork = function() {
        var worker = cluster.fork();
        var pid = worker.process.pid;
        playerStates[pid] = {};

        worker.on('message', function(payload) {
            if (payload.type == 'clientLogin') {
                playerStates[pid][payload.id] = true;
            }
        });

        worker.on('message', function(payload) {
            if (payload.type == 'clientLogout') {
                playerStates[pid][payload.id] = null;
                delete playerStates[pid][payload.id];
            }
        });
    }

    for (var i = 0; i < 8; i++) {
        newFork();
    }

    cluster.on('exit', (worker, code, signal) => {
        var pid = worker.process.pid;
        Log(chalk.red(`Worker ${pid} died!`));
        var playerIds = Object.keys(playerStates[pid]);
        Log('    Setting ' + playerIds.length + ' player(s) offline...');
        if (playerIds.length > 0) {
            var query = 'UPDATE web_users SET game_session = 0 WHERE ';
            for (var i = 0; i < playerIds.length; i++) {
                query += '`id`=' + playerIds[i];
                if ( i + 1 < playerIds.length ) query += ' OR ';
            }
            db.query(query, function(err, result) {
                if (err) throw err;
                Log('   ...OK! (Affected Rows: ' + result.affectedRows + ')');
                playerStates[pid] = null;
                delete playerStates[pid];
                newFork();
            });
        } else {
            newFork();
        }
    });

    return;
}

/*
    Child Processies - the SPORKS
*/

// Gamespy Login Server
var server = new GsSocket(chalk.cyan('CM'), 29900);

// When we get a new connection
server.on('newClient', (client) => {

    // Process Login Requests
    client.on('command.login', (payload) => {
        client.state.clientChallenge = payload['challenge'] || undefined;
        client.state.clientResponse = payload['response'] || undefined;
        if (!payload['uniquenick'] || !client.state.clientChallenge || !client.state.clientResponse) { return client.writeError(0, 'Login query missing a variable.') }

        db.query('SELECT id, pid, username, password, game_country, email FROM web_users WHERE username = ?', [payload['uniquenick']], (err, result) => {
            if (!result || result.length == 0) { return client.writeError(265, 'The username provided is not registered.') }
            result = result[0];

            client.state.battlelogId = result.id;
            client.state.plyName = result.username;
            client.state.plyEmail = result.email;
            client.state.plyCountry = result.game_country;
            client.state.plyPid = result.pid;

            var responseVerify = md5(result.password + Array(49).join(' ') + client.state.plyName + client.state.clientChallenge + client.state.serverChallenge + result.password);
            if (client.state.clientResponse !== responseVerify) {
                Log('Login Failure', client.socket.remoteAddress, client.state.plyName)
                return client.writeError(256, 'Incorrect password.');
            }

            // Generate a session key
            var len = client.state.plyName.length;
            var nameIndex = 0;
            var session = 0;
            while(len-- != 0) {
                session = GsUtil.crcLookup[((client.state.plyName.charCodeAt(nameIndex) ^ session) & 0xff) % 256] ^ (session >>= 8);
                nameIndex++;
            }

            Log('Login Success', client.socket.remoteAddress, client.state.plyName)
            client.write(util.format('\\lc\\2\\sesskey\\%d\\proof\\%s\\userid\\%d\\profileid\\%d\\uniquenick\\%s\\lt\\%s__\\id\\1\\final\\',
                session,
                md5(result.password + Array(49).join(' ') + client.state.plyName + client.state.serverChallenge + client.state.clientChallenge + result.password),
                client.state.plyPid, client.state.plyPid,
                client.state.plyName,
                GsUtil.bf2Random(22)
            ));

            db.query('UPDATE web_users SET game_session = 1 WHERE id=?', [result.id]);
            process.send({type: 'clientLogin', id: result.id});
            client.state.hasLogin = true;
        });
    })

    client.on('command.getprofile', (payload) => {
        Log('GetProfile',  client.socket.remoteAddress, client.state.plyName);
        client.write(util.format('\\pi\\\\profileid\\%d\\nick\\%s\\userid\\%d\\email\\%s\\sig\\%s\\uniquenick\\%s\\pid\\0\\firstname\\\\lastname\\' +
        '\\countrycode\\%s\\birthday\\16844722\\lon\\0.000000\\lat\\0.000000\\loc\\\\id\\%d\\\\final\\',
            client.state.plyPid,
            client.state.plyName,
            client.state.plyPid,
            client.state.plyEmail,
            GsUtil.bf2Random(32),
            client.state.plyName,
            client.state.plyCountry,
            (client.state.profileSent ? 5 : 2)
        ));
        client.state.profileSent = false;
    });

    client.on('command.updatepro', (payload) => {
        if (!payload.countrycode) { return child.writeError(0, 'Invalid query! No country code specified.'); }
        db.query('UPDATE web_users SET game_country=? WHERE id=?', [payload.countrycode, client.state.battlelogId], function(err, result) {
            Log('UpdateProfile', client.socket.remoteAddress, client.state.plyName);
        });
    });

    client.on('command.logout', (payload) => {
        client.close();
    })

    client.on('command.newuser', (payload) => {
        if (!payload.nick || !payload.email || !payload.passwordenc) return client.writeError(516, 'You are missing a name, email, or password.');
        Log('NewUser (Starting)', client.socket.remoteaddress, payload.nick, payload.passwordenc, payload.email.toLowerCase());
        db.query('SELECT id FROM web_users WHERE username=?', [payload.nick], function(err, result) {
            if (result.length == 0) {
                var pass = GsUtil.decodePassword(payload.passwordenc);
                var cc = 'US'; // Will resolve later...
                var passHash = md5(pass);
                db.query('SELECT COALESCE(MAX(pid), 500000000)+1 as newPid FROM web_users', function(err, result) {
                    var newPid = result[0].newPid;
                    db.query('INSERT INTO web_users SET ?', {
                        pid: newPid,
                        username: payload.nick,
                        password: passHash,
                        email: payload.email.toLowerCase(),
                        country: cc
                    }, function(err, result) {
                        Log('NewUser', client.socket.remoteaddress, payload.nick, pass, payload.email.toLowerCase(), cc);
                        client.write(util.format('\\nur\\\\userid\\%d\\profileid\\%d\\id\\1\\final\\', newPid, newPid));
                    });
                });
            } else {
                return client.writeError(516, 'Username already in use!');
            }
        })
    });

    client.on('close', () => {
        if (client.state.hasLogin) {
            Log('Logout', client.state.plyName, client.socket.remoteAddress);
            db.query('UPDATE web_users SET game_session = 0 WHERE id=?', [client.state.battlelogId]);
            process.send({type: 'clientLogout', id: client.state.battlelogId});
        } else {
            Log('Disconnect', client.socket.remoteAddress);
        }
        client = null;
        delete client;
        server.clients.length
    })

    // Send a challenge
    crypto.randomBytes(5, (err, buf) => {
      var token = buf.toString('hex');
      client.state.serverChallenge = token;
      client.write(util.format('\\lc\\1\\challenge\\%s\\id\\1\\final\\', token));
    })
});