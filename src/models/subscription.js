/**
 * Subscription model
 */


class Subscription {

  constructor({origin, subscriber, vendorConfig}) {
    this.origin = origin;
    this.subscriber = subscriber;
    this.vendorConfig = vendorConfig;
  }
}

class QueueToFuncSubscription extends Subscription {}
class TopicToQueueSubscription extends Subscription {}
class TopicToFuncSubscription extends Subscription {}


module.exports = {
  Subscription,
  QueueToFuncSubscription,
  TopicToQueueSubscription,
  TopicToFuncSubscription,
};
