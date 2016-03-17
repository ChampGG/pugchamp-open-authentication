/* jshint node: true, esversion: 6, eqeqeq: true, latedef: true, undef: true, unused: true */
"use strict";

const _ = require('lodash');
const bluebird = require('bluebird');
const Botkit = require('botkit');
const co = require('co');
const config = require('config');
const express = require('express');
const fs = require('fs');
const http = require('http');
const ms = require('ms');
const redis = require('redis');
const Steam = require('steam-webapi');
const SteamID = require('steamid');

bluebird.promisifyAll(redis.RedisClient.prototype);
bluebird.promisifyAll(redis.Multi.prototype);
bluebird.promisifyAll(Steam.prototype);

var app = express();
var client = redis.createClient(config.get('redis'));
var server = http.Server(app);

const AUTHORIZATIONS = config.has('authorizations') ? config.get('authorizations') : [];
const HOUR_THRESHOLD = config.get('hourThreshold');
const STEAM_API_KEY = config.get('steam.apiKey');

Steam.key = STEAM_API_KEY;

let sendToSlack;

if (config.has('slack')) {
    const SLACK_INCOMING_WEBHOOK_URL = config.get('slack.incomingWebhook');
    const SLACK_MESSAGE_DEFAULTS = config.get('slack.messageDefaults');

    let controller = Botkit.slackbot();
    let bot = controller.spawn({
        incoming_webhook: {
            url: SLACK_INCOMING_WEBHOOK_URL
        }
    });
    sendToSlack = bluebird.promisify(bot.sendWebhook, {
        context: bot
    });
}

function postUserAlert(steamID, denied, reason) {
    return co(function*() {
        let message = `${steamID} was ${denied ? 'DENIED' : 'flagged'}: ${reason}`;

        if (sendToSlack) {
            let message = {
                channel: '#user-alerts',
                attachments: [{
                    fallback: message,
                    color: denied ? 'danger' : 'warning',
                    author_name: steamID,
                    author_link: `http://steamcommunity.com/profiles/${steamID}`,
                    text: `${denied ? 'DENIED' : 'flagged'}: ${reason}`
                }]
            };

            yield sendToSlack(_.defaultsDeep(message, SLACK_MESSAGE_DEFAULTS));
        }
        else {
            console.log(message);
        }
    });
}

Steam.ready(function(err) {
    if (err) {
        throw err;
    }

    var steam = new Steam();

    app.get('/', co.wrap(function*(req, res) {
        try {
            if (!req.query.user) {
                res.sendStatus(403);
                return;
            }

            let steamID;

            try {
                steamID = new SteamID(req.query.user);
            }
            catch (err) {
                res.sendStatus(403);
                return;
            }

            if (!steamID.isValid()) {
                res.sendStatus(403);
                return;
            }

            let steam64 = steamID.getSteamID64();

            for (let authorization of AUTHORIZATIONS) {
                if (authorization.user === steam64) {
                    if (authorization.authorized) {
                        res.sendStatus(200);
                    }
                    else {
                        res.sendStatus(403);
                    }

                    return;
                }
            }

            try {
                let cacheResult = yield client.getAsync('open-authorization-' + steam64);

                if (cacheResult) {
                    let authorized = JSON.parse(cacheResult);

                    if (authorized) {
                        res.sendStatus(200);
                    }
                    else {
                        res.sendStatus(403);
                    }

                    return;
                }
            }
            catch (err) {
                // continue
            }

            let bansResult = yield steam.getPlayerBansAsync({
                steamids: steam64
            });

            if (!bansResult || !bansResult.players || !bansResult.players[0] || bansResult.players[0].SteamId !== steam64) {
                res.sendStatus(500);
                return;
            }

            let playerBans = bansResult.players[0];

            if (playerBans.VACBanned) {
                client.set('open-authorization-' + steam64, false);
                postUserAlert(steam64, true, 'VAC bans on record');
                res.sendStatus(403);
                return;
            }

            if (playerBans.NumberOfGameBans > 0) {
                client.set('open-authorization-' + steam64, false, 'PX', ms('1w'));
                postUserAlert(steam64, true, 'game bans on record');
                res.sendStatus(403);
                return;
            }

            if (playerBans.CommunityBanned) {
                postUserAlert(steam64, false, 'banned from Steam Community');
            }

            if (playerBans.EconomyBan !== 'none') {
                postUserAlert(steam64, false, `current trade status is ${playerBans.EconomyBan}`);
            }

            let gameResult = yield steam.getOwnedGamesAsync({
                input_json: JSON.stringify({
                    steamid: steam64,
                    include_appinfo: false,
                    include_played_free_games: true,
                    appids_filter: [440]
                })
            });

            if (!gameResult || !gameResult.games || !gameResult.games[0] || gameResult.games[0].appid !== 440) {
                res.sendStatus(500);
                return;
            }

            let gameInfo = gameResult.games[0];

            if (gameInfo.playtime_forever < HOUR_THRESHOLD) {
                postUserAlert(steam64, false, `has only ${gameInfo.playtime_forever} hours on record`);
            }

            if (gameInfo.playtime_2weeks > 336) {
                postUserAlert(steam64, false, `has an impossible ${gameInfo.playtime_2weeks} hours in the past two weeks`);
            }

            client.set('open-authorization-' + steam64, true, 'PX', ms('1d'));
            res.sendStatus(200);
            return;
        }
        catch (err) {
            console.log(err.stack);
            res.sendStatus(500);
            return;
        }
    }));
});

server.listen(config.get('listen'));

try {
    fs.chmodSync(config.get('listen'), '775');
}
catch (err) {
    // ignore
}

process.on('exit', function() {
    server.close();
});
