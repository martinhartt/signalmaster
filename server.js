/*global console*/
var yetify = require('yetify'),
    uuid = require('node-uuid'),
    crypto = require('crypto'),
    fs = require('fs'),
    port = parseInt(process.env.PORT, 10),
    server_handler = function (req, res) {
        res.writeHead(404);
        res.end();
    },
    server = null;

// Create an http(s) server instance to that socket.io can listen to
if (process.env.SECURE) {
    server = require('https').Server({
        key: fs.readFileSync(process.env.SERVER_KEY),
        cert: fs.readFileSync(process.env.SERVER_CERT),
        passphrase: process.env.SERVER_PASSWORD
    }, server_handler);
} else {
    server = require('http').Server(server_handler);
}
server.listen(port);

var io = require('socket.io').listen(server);
if (process.env.REDIS == 'true') {
    var redis = require('socket.io-redis');
    io.adapter(redis({ host: process.env.REDIS_HOST, port: process.env.REDIS_PORT }));
}

if (process.env.LOG_LEVEL) {
    // https://github.com/Automattic/socket.io/wiki/Configuring-Socket.IO
    io.set('log level', process.env.LOG_LEVEL);
}

function describeRoom(name) {
    var clients = io.sockets.clients(name);
    var result = {
        clients: {}
    };
    clients.forEach(function (client) {
        result.clients[client.id] = client.resources;
    });
    return result;
}

function clientsInRoom(name) {
    return io.sockets.clients(name).length;
}

function safeCb(cb) {
    if (typeof cb === 'function') {
        return cb;
    } else {
        return function () {};
    }
}

io.sockets.on('connection', function (client) {
    client.resources = {
        screen: false,
        video: false,
        audio: true
    };

    // pass a message to another id
    client.on('message', function (details) {
        if (!details) return;

        var otherClient = io.sockets.sockets[details.to];
        if (!otherClient) return;

        details.from = client.id;
        otherClient.emit('message', details);
    });

    client.on('shareScreen', function () {
        client.resources.screen = true;
    });

    client.on('unshareScreen', function (type) {
        client.resources.screen = false;
        removeFeed('screen');
    });

    client.on('join', join);

    function removeFeed(type) {
        if (client.room) {
            io.sockets.in(client.room).emit('remove', {
                id: client.id,
                type: type
            });
            if (!type) {
                client.leave(client.room);
                client.room = undefined;
            }
        }
    }

    function join(name, cb) {
        // sanity check
        if (typeof name !== 'string') return;
        // check if maximum number of clients reached
        var maxClients = process.env.MAX_CLIENTS;
        if (maxClients && maxClients > 0 &&
          clientsInRoom(name) >= maxClients) {
            safeCb(cb)('full');
            return;
        }
        // leave any existing rooms
        removeFeed();
        safeCb(cb)(null, describeRoom(name));
        client.join(name);
        client.room = name;
    }

    // we don't want to pass "leave" directly because the
    // event type string of "socket end" gets passed too.
    client.on('disconnect', function () {
        removeFeed();
    });
    client.on('leave', function () {
        removeFeed();
    });

    client.on('create', function (name, cb) {
        if (arguments.length == 2) {
            cb = (typeof cb == 'function') ? cb : function () {};
            name = name || uuid();
        } else {
            cb = name;
            name = uuid();
        }
        // check if exists
        if (io.sockets.clients(name).length) {
            safeCb(cb)('taken');
        } else {
            join(name);
            safeCb(cb)(null, name);
        }
    });

    // support for logging full webrtc traces to stdout
    // useful for large-scale error monitoring
    client.on('trace', function (data) {
        console.log('trace', JSON.stringify(
            [data.type, data.session, data.prefix, data.peer, data.time, data.value]
        ));
    });


    // tell client about stun and turn servers and generate nonces
    client.emit('stunservers', process.env.STUN_URL || []);

    // create shared secret nonces for TURN authentication
    // the process is described in draft-uberti-behave-turn-rest
    var credentials = [];

    if (process.env.TURN) {
        var hmac = crypto.createHmac('sha1', process.env.TURN_SECRET);
        // default to 86400 seconds timeout unless specified
        var username = Math.floor(new Date().getTime() / 1000) + (process.env.TURN_EXPIRY || 86400) + "";
        hmac.update(username);
        credentials.push({
            username: username,
            credential: hmac.digest('base64'),
            url: process.env.TURN_URL
        });
    }

    client.emit('turnservers', credentials);
});

if (process.env.UID) process.setuid(process.env.UID);

var httpUrl;
if (process.env.SECURE) {
    httpUrl = "https://localhost:" + port;
} else {
    httpUrl = "http://localhost:" + port;
}
console.log(yetify.logo() + ' -- signal master is running at: ' + httpUrl);
