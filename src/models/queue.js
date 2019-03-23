/**
 * Queue model
 *
 * A queue can have multiple subscriptions and can also be subscribed to topics
 */

const PubSub = require('pubsub-js');

const Subscription = require('./subscription');

const { randomId } = require('../helpers');

const logger = require('../logger');



class Queue {
  constructor({name, vendorConfig}) {
    this.name = name;
    this.vendorConfig = vendorConfig;
    // The subscriptions to this queue
    this.subscriptions = [];
    this.type = 'queue';
  }

  addSubscriber(subscriber, config) {
    const subscription = new Subscription(this, subscriber, config);
    this.subscriptions.push(subscription);
    return subscription;
  }

  execute(data) {
    PubSub.publish(this.name, {messageId: randomId(), message: data});
  }

  log(message) {
    logger.log(message, ['Queue', this.name]);
  }
}

module.exports = Queue;
