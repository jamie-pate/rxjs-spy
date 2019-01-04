/**
 * @license Use of this source code is governed by an MIT-style license that
 * can be found in the LICENSE file at https://github.com/cartant/rxjs-spy
 */

import {
    Notification,
    Observable,
    Subject,
    Subscription
} from "rxjs";

import { dematerialize, materialize } from "rxjs/operators";
import { defaultLogger, PartialLogger, toLogger } from "../logger";
import { Match, matches, read, toString as matchToString } from "../match";
import { hide } from "../operators";
import { getSubscriptionRecord } from "../subscription-record";
import { Teardown } from "../teardown";
import { BasePlugin, PluginHost } from "./plugin";

export interface DeckStats {
    notifications: number;
    paused: boolean;
}

interface State {
    notifications_: Notification<any>[];
    subject_: Subject<Notification<any>>;
    subscription_: Subscription | undefined;
    tag_: string | undefined;
}

export class Deck {

    public teardown: Teardown | undefined;

    private match_: Match;
    private paused_ = true;
    private states_ = new Map<Observable<any>, State>();
    private stats_: Subject<DeckStats>;

    constructor(match: Match) {

        this.match_ = match;
        this.stats_ = new Subject<DeckStats>();
    }

    get stats(): Observable<DeckStats> {

        return this.stats_.asObservable();
    }

    get paused(): boolean {

        return this.paused_;
    }

    clear(predicate: (notification: Notification<any>) => boolean = () => true): void {

        this.states_.forEach(state => {
            state.notifications_ = state.notifications_.filter(notification => !predicate(notification));
        });
        this.broadcast_();
    }

    getOperator(subscription: Subscription): (source: Observable<any>) => Observable<any> {

        const { observable } = getSubscriptionRecord(subscription);
        return (source: Observable<any>) => {

            let state = this.states_.get(observable);
            if (state) {
                state.subscription_!.unsubscribe();
            } else {
                state = {
                    notifications_: [],
                    subject_: new Subject<Notification<any>>(),
                    subscription_: undefined,
                    tag_: read(observable)
                };
                this.states_.set(observable, state);
            }

            state.subscription_ = source.pipe(
                materialize(),
                hide()
            ).subscribe({
                next: (notification: any) => {
                    if (this.paused_) {
                        state!.notifications_.push(notification);
                    } else {
                        state!.subject_.next(notification);
                    }
                    this.broadcast_();
                }
            });
            this.broadcast_();

            return state.subject_.asObservable().pipe(
                dematerialize()
            );
        };
    }

    log(partialLogger: PartialLogger = defaultLogger): void {

        const logger = toLogger(partialLogger);

        logger.group(`Deck matching ${matchToString(this.match_)}`);
        logger.log("Paused =", this.paused_);
        this.states_.forEach(state => {
            logger.group(`Observable; tag = ${state.tag_}`);
            logger.log("Notifications =", state.notifications_);
            logger.groupEnd();
        });
        logger.groupEnd();
    }

    pause(): void {

        this.paused_ = true;
        this.broadcast_();
    }

    resume(): void {

        this.states_.forEach(state => {
            while (state.notifications_.length > 0) {
                state.subject_.next(state.notifications_.shift());
            }
        });
        this.paused_ = false;
        this.broadcast_();
    }

    skip(): void {

        this.states_.forEach(state => {
            if (state.notifications_.length > 0) {
                state.notifications_.shift();
            }
        });
        this.broadcast_();
    }

    step(): void {

        this.states_.forEach(state => {
            if (state.notifications_.length > 0) {
                state.subject_.next(state.notifications_.shift());
            }
        });
        this.broadcast_();
    }

    unsubscribe(): void {
        this.states_.forEach(state => {
            if (state.subscription_) {
                state.subscription_.unsubscribe();
                state.subscription_ = undefined;
            }
        });
        this.broadcast_();
    }

    private broadcast_(): void {

        const { paused_, states_, stats_ } = this;

        let notifications = 0;
        states_.forEach(state => notifications += state.notifications_.length);

        stats_.next({
            notifications,
            paused: paused_
        });
    }
}

export class PausePlugin extends BasePlugin {

    private match_: Match;
    private deck_: Deck;

    constructor({ match, pluginHost }: { match: Match, pluginHost: PluginHost }) {

        super(`pause(${matchToString(match)})`);

        this.deck_ = new Deck(match);
        this.match_ = match;
    }

    get deck(): Deck {

        const { deck_ } = this;
        return deck_;
    }

    get match(): Match {

        const { match_ } = this;
        return match_;
    }

    getOperator(subscription: Subscription): ((source: Observable<any>) => Observable<any>) | undefined {

        const { deck_, match_ } = this;

        if (matches(subscription, match_)) {
            return deck_.getOperator(subscription);
        }
        return undefined;
    }

    teardown(): void {

        const { deck_ } = this;

        if (deck_) {
            deck_.resume();
            deck_.unsubscribe();
        }
    }
}
