/**
 * Queue model
 *
 * A queue can have multiple subscriptions and can also be subscribed to topics
 */

const Subscription = require('./subscription');


class Queue {
  constructor({name, vendorConfig}) {
    this.name = name;
    this.vendorConfig = vendorConfig;
    // The subscriptions to this queue
    this.subscriptions = [];
  }

  addSubscriber(subscriber, config) {
    const subscription = new Subscription(this, subscriber, config);
    this.subscriptions.push(subscription);
    return subscription;
  }

}

module.exports = Queue;
