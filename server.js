/* jshint node: true, esversion: 6, eqeqeq: true, latedef: true, undef: true, unused: true */
'use strict';

const _ = require('lodash');
const bluebird = require('bluebird');
const Botkit = require('botkit');
const co = require('co');
const config = require('config');
const express = require('express');
const fs = require('fs');
const http = require('http');
const moment = require('moment');
const ms = require('ms');
const redis = require('redis');
const Steam = require('steam-webapi');
const SteamID = require('steamid');

bluebird.promisifyAll(redis.RedisClient.prototype);
bluebird.promisifyAll(redis.Multi.prototype);
require('moment-duration-format');

var app = express();
var client = redis.createClient(config.get('redis'));
var server = http.Server(app);

const AUTHORIZATION_CACHE_TIME = ms(config.get('authorizationCacheTime'));
const AUTHORIZATIONS = config.has('authorizations') ? config.get('authorizations') : [];
const CHECKS = config.has('checks') ? config.get('checks') : [];
const HOUR_THRESHOLD = config.get('hourThreshold');
const STEAM_API_KEY = config.get('steam.apiKey');

Steam.key = STEAM_API_KEY;

let sendToSlack;

if (config.has('slack')) {
    const SLACK_INCOMING_WEBHOOK_URL = config.get('slack.incomingWebhook');

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
            let slackMessage = {
                channel: '#user-alerts',
                attachments: [{
                    fallback: message,
                    color: denied ? 'danger' : 'warning',
                    author_name: steamID,
                    author_link: `http://steamcommunity.com/profiles/${steamID}`,
                    text: `${denied ? 'DENIED' : 'flagged'}: ${reason}`
                }]
            };

            yield sendToSlack(_.defaultsDeep(slackMessage, config.get('slack.messageDefaults')));
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

    bluebird.promisifyAll(Steam.prototype);

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

            let playerAuthorization = _.find(AUTHORIZATIONS, authorization => authorization.user === steam64);

            try {
                let cacheResult = yield client.getAsync(`open-authorization-${steam64}`);

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

            let flags = new Map();

            if (!playerAuthorization || !_.has(playerAuthorization, 'performChecks') || playerAuthorization.performChecks) {
                let summaryResult = yield steam.getPlayerSummariesAsync({
                    steamids: steam64
                });

                if (!summaryResult || !summaryResult.players || !summaryResult.players[0] || summaryResult.players[0].steamid !== steam64) {
                    throw new Error('failed to retrieve summary from Steam API');
                }

                let playerSummary = summaryResult.players[0];

                if (!playerSummary.profilestate) {
                    flags.set('profileNotSetUp', {
                        type: 'profileNotSetUp',
                        detail: 'profile not set up'
                    });
                }

                if (playerSummary.communityvisibilitystate !== 3) {
                    flags.set('privateProfile', {
                        type: 'privateProfile',
                        detail: 'has a private profile'
                    });
                }

                let gameResult = yield steam.getOwnedGamesAsync({
                    steamid: steam64,
                    include_appinfo: false,
                    include_played_free_games: true,
                    appids_filter: [440]
                });

                if (!gameResult) {
                    throw new Error('failed to retrieve games from Steam API');
                }

                if (_.has(gameResult, 'game_count')) {
                    if (gameResult.game_count > 0) {
                        let gameInfo = gameResult.games[0];

                        if (gameInfo.appid !== 440) {
                            throw new Error('game returned was not TF2');
                        }

                        if (gameInfo.playtime_forever < (HOUR_THRESHOLD * 60)) {
                            let totalDuration = moment.duration(gameInfo.playtime_forever, 'minutes').format('h:mm');
                            flags.set('lowPlaytime', {
                                type: 'lowPlaytime',
                                detail: `has only ${totalDuration} on record for TF2`
                            });
                        }

                        if (gameInfo.playtime_2weeks > 20160) {
                            let recentDuration = moment.duration(gameInfo.playtime_2weeks, 'minutes').format('w[w] d[d] h:mm');
                            flags.set('impossiblePlaytime', {
                                type: 'impossiblePlaytime',
                                detail: `has an impossible ${recentDuration} in the past two weeks for TF2`
                            });
                        }
                    }
                    else {
                        flags.set('noOwnership', {
                            type: 'noOwnership',
                            detail: 'does not own TF2'
                        });
                    }
                }

                let bansResult = yield steam.getPlayerBansAsync({
                    steamids: steam64
                });

                if (!bansResult || !bansResult.players || !bansResult.players[0] || bansResult.players[0].SteamId !== steam64) {
                    throw new Error('failed to retrieve bans from Steam API');
                }

                let playerBans = bansResult.players[0];

                if (playerBans.VACBanned) {
                    flags.set('vacBans', {
                        type: 'vacBans',
                        detail: 'VAC bans on record'
                    });
                }

                if (playerBans.NumberOfGameBans > 0) {
                    flags.set('gameBans', {
                        type: 'gameBans',
                        detail: `${playerBans.NumberOfGameBans} game bans on record`
                    });
                }

                if (playerBans.CommunityBanned) {
                    flags.set('communityBan', {
                        type: 'communityBan',
                        detail: 'banned from Steam Community'
                    });
                }

                if (playerBans.EconomyBan !== 'none') {
                    flags.set('economyBan', {
                        type: 'economyBan',
                        detail: `current trade status is ${playerBans.EconomyBan}`
                    });
                }
            }

            let authorized = true;
            let details = [];

            for (let check of CHECKS) {
                if (check.ignore) {
                    if (!playerAuthorization || !_.has(playerAuthorization, 'forceChecks') || !_.includes(playerAuthorization.forceChecks, check.type)) {
                        continue;
                    }
                }
                else {
                    if (playerAuthorization && _.has(playerAuthorization, 'ignoreChecks') && _.includes(playerAuthorization.ignoreChecks, check.type)) {
                        continue;
                    }
                }

                if (flags.has(check.type)) {
                    let flagInfo = flags.get(check.type);

                    if (_.has(check, 'authorized')) {
                        authorized = check.authorized;
                    }

                    let warningResult = yield client.getAsync(`open-authorization-${steam64}-${check.type}`);

                    if (!warningResult) {
                        details.push(flagInfo.detail);

                        if (_.has(check, 'warnInterval') && check.warnInterval !== 'never') {
                            client.set(`open-authorization-${steam64}-${check.type}`, false, 'PX', ms(check.warnInterval));
                        }
                        else {
                            client.set(`open-authorization-${steam64}-${check.type}`, false);
                        }
                    }
                }
            }

            if (playerAuthorization && _.has(playerAuthorization, 'authorized')) {
                authorized = playerAuthorization.authorized;
            }

            if (_.size(details) > 0) {
                postUserAlert(steam64, authorized, _.join(details, '; '));
            }
            client.set(`open-authorization-${steam64}`, authorized, 'PX', AUTHORIZATION_CACHE_TIME);
            res.sendStatus(authorized ? 200 : 403);
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
