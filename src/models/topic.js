/**
 * Topic model
 */

const Subscription = require('./subscription');

class Topic {

  constructor({name, vendorConfig}) {
    this.name = name;
    this.vendorConfig = vendorConfig;
    this.subscriptions = [];
  }

  addSubscriber(subscriber, config) {
    const subscription = new Subscription(this, subscriber, config);
    this.subscriptions.push(subscription);
    return subscription;
  }
}


module.exports = Topic;
