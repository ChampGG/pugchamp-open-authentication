'use strict';

const _ = require('lodash');
const bluebird = require('bluebird');
const Botkit = require('botkit');
const co = require('co');
const config = require('config');
const debug = require('debug')('pugchamp:open-authorization');
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

const AUTHORIZATION_CACHE_TIME = ms(config.get('authorizationCacheTime'));
const CHECK_RULES = config.get('checkRules');
const MAX_RECENT_THRESHOLD = ms('14d');
const OVERRIDES = config.has('overrides') ? config.get('overrides') : {};
const STEAM_API_KEY = config.get('steam.apiKey');

var app = express();
var client = redis.createClient(config.get('redis'));
var server = http.Server(app);
var sendToSlack;
var steam;

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

Steam.key = STEAM_API_KEY;

function postUserAlert(steamID, denied, flags) {
    return co(function*() {
        let message = `${steamID} was ${denied ? 'DENIED' : 'flagged'}: ${_(flags).map(flag => `${flag.title}: ${flag.value}`).join(', ')}`;

        debug(message);

        if (sendToSlack) {
            let slackMessage = {
                attachments: [{
                    fallback: message,
                    color: denied ? 'danger' : 'warning',
                    title: steamID,
                    title_link: `http://steamcommunity.com/profiles/${steamID}`,
                    text: `${denied ? 'DENIED' : 'flagged'}`,
                    fields: _.map(flags, flag => ({
                        title: flag.title,
                        value: flag.value,
                        short: true
                    }))
                }]
            };

            yield sendToSlack(_.defaultsDeep(slackMessage, config.get('slack.messageDefaults')));
        }
    });
}

function performChecks(user) {
    return co(function*() {
        try {
            let checks = {};

            let steamID = new SteamID(user);
            if (!steamID.isValid()) {
                throw new Error('invalid Steam ID');
            }

            let steam64 = steamID.getSteamID64();

            if (!steam) {
                throw new Error('Steam ID not available');
            }

            let summaryResult = yield steam.getPlayerSummariesAsync({
                steamids: steam64
            });

            if (!summaryResult || !summaryResult.players || !summaryResult.players[0] || summaryResult.players[0].steamid !== steam64) {
                throw new Error('failed to retrieve summary from Steam API');
            }

            let playerSummary = summaryResult.players[0];

            checks.profileSetUp = !!playerSummary.profilestate;
            checks.profileVisibility = playerSummary.communityvisibilitystate === 3;

            let gameResult = yield steam.getOwnedGamesAsync({
                steamid: steam64,
                include_appinfo: false,
                include_played_free_games: true,
                appids_filter: [440]
            });

            if (!gameResult) {
                throw new Error('failed to retrieve games from Steam API');
            }

            checks.gameOwned = gameResult.game_count > 0 && gameResult.games[0].appid === 440;
            if (checks.gameOwned) {
                checks.recentPlaytime = gameResult.games[0].playtime_2weeks;
                checks.totalPlaytime = gameResult.games[0].playtime_forever;
            }

            let bansResult = yield steam.getPlayerBansAsync({
                steamids: steam64
            });

            if (!bansResult || !bansResult.players || !bansResult.players[0] || bansResult.players[0].SteamId !== steam64) {
                throw new Error('failed to retrieve bans from Steam API');
            }

            let playerBans = bansResult.players[0];

            checks.vacBans = playerBans.NumberOfVACBans;
            checks.gameBans = playerBans.NumberOfGameBans;
            checks.communityBan = playerBans.CommunityBanned;
            checks.economyBan = playerBans.EconomyBan;

            return checks;
        }
        catch (err) {
            debug(`error while performing checks for ${user}: ${err.stack}`);
            return null;
        }
    });
}

function getAction(condition, rule) {
    if (condition) {
        return rule.action;
    }
    else {
        return 'pass';
    }
}

function calculateCheckFlags(checks, rules) {
    let flags = [];

    flags.push({
        type: 'profileSetUp',
        action: getAction(!checks.profileSetUp, rules.profileSetUp),
        title: 'Profile Set Up',
        value: checks.profileSetUp ? 'yes' : 'no'
    });

    flags.push({
        type: 'profileVisibility',
        action: getAction(!checks.profileVisibility, rules.profileVisibility),
        title: 'Profile Visibility',
        value: checks.profileVisibility ? 'public' : 'private'
    });

    flags.push({
        type: 'gameOwned',
        action: getAction(!checks.gameOwned, rules.gameOwned),
        title: 'Game Owned',
        value: checks.gameOwned ? 'yes' : 'no'
    });

    flags.push({
        type: 'recentPlaytime',
        action: getAction(ms(`${checks.recentPlaytime}m`) > MAX_RECENT_THRESHOLD, rules.recentPlaytime),
        title: 'Recent Playtime (last two weeks)',
        value: moment.duration(checks.recentPlaytime, 'minutes').format('w[w] d[d] h:mm')
    });

    flags.push({
        type: 'totalPlaytime',
        action: getAction(ms(`${checks.totalPlaytime}m`) < ms(rules.totalPlaytime.threshold), rules.totalPlaytime),
        title: 'Total Playtime',
        value: moment.duration(checks.totalPlaytime, 'minutes').format('h:mm', {
            trim: false
        })
    });

    flags.push({
        type: 'vacBans',
        action: getAction(checks.vacBans > rules.vacBans.threshold, rules.vacBans),
        title: 'VAC Bans',
        value: checks.vacBans
    });

    flags.push({
        type: 'gameBans',
        action: getAction(checks.gameBans > rules.gameBans.threshold, rules.gameBans),
        title: 'Game Bans',
        value: checks.gameBans
    });

    flags.push({
        type: 'communityBan',
        action: getAction(checks.communityBan, rules.communityBan),
        title: 'Community Banned',
        value: checks.communityBan ? 'yes' : 'no'
    });

    flags.push({
        type: 'economyBan',
        action: getAction(checks.economyBan !== 'none', rules.economyBan),
        title: 'Economy Ban Status',
        value: checks.economyBan
    });

    return flags;
}

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

        let playerOverride = OVERRIDES[steam64];

        let checkResults = yield performChecks(req.query.user);
        let checkRules = _.defaultsDeep({}, _.get(playerOverride, 'checkRules', {}), CHECK_RULES);

        let flags = calculateCheckFlags(checkResults, checkRules);
        let authorized = !_.some(flags, ['action', 'fail']);

        let alert = false;

        for (let flag of flags) {
            if (flag.action === 'warn' || flag.action === 'fail') {
                let previousValueResult = yield client.getAsync(`open-authorization-${steam64}-${flag.type}`);

                try {
                    let previousValue = JSON.parse(previousValueResult);

                    if (previousValue !== flag.value) {
                        alert = true;
                    }
                }
                catch (err) {
                    alert = true;
                }

                client.setAsync(`open-authorization-${steam64}-${flag.type}`, JSON.stringify(flag.value));
            }
        }

        if (alert) {
            postUserAlert(steam64, !authorized, _.filter(flags, flag => flag.action === 'warn' || flag.action === 'fail'));
        }

        if (_.has(playerOverride, 'authorized')) {
            authorized = playerOverride.authorized;
        }

        client.set(`open-authorization-${steam64}`, authorized, 'PX', AUTHORIZATION_CACHE_TIME);
        res.sendStatus(authorized ? 200 : 403);
    }
    catch (err) {
        debug(err.stack);
        res.sendStatus(500);
        return;
    }
}));

Steam.ready(function(err) {
    if (err) {
        throw err;
    }

    bluebird.promisifyAll(Steam.prototype);

    steam = new Steam();
});

try {
    fs.unlinkSync(config.get('listen'));
}
catch (err) {
    // ignore
}

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
