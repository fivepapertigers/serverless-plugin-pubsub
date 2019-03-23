/**
 * Subscription model
 */

const PubSub = require('pubsub-js');

const { randomId } = require('../helpers');

class Subscription {

  constructor({origin, subscriber, vendorConfig}) {
    this.origin = origin;
    this.subscriber = subscriber;
    this.vendorConfig = vendorConfig;
  }

  subscribe() {
    PubSub.subscribe(this.origin.name, (_, {messageId, message}) => {
      const encoded = this.encodeMessage(messageId, message);
      this.subscriber.execute(encoded);
    });
    this.subscriber.log(`Subscribed to ${this.origin.type} ${this.origin.name}`);
  }
}

class QueueToFuncSubscription extends Subscription {
  encodeMessage(messageId, message) {
    return JSON.stringify({
      Records: [{
        messageId: messageId,
        receiptHandle: '',
        body: message,
        attributes: {
          ApproximateReceiveCount: 1,
          SentTimestamp: Date.now(),
          SenderId: randomId(),
          ApproximateFirstReceiveTimestamp: Date.now()
        },
        messageAttributes: {},
        md5OfBody: '9bb58f26192e4ba00f01e2e7b136bbd8',
        eventSource: 'aws:sqs',
        eventSourceARN: `arn:aws:sqs:us-east-1:1234567890123:${this.name}`,
        awsRegion: 'us-east-1'
      }]
    });
  }
}

class TopicToQueueSubscription extends Subscription {
  encodeMessage(messageId, message) {
    return JSON.stringify(this.origin.formatMessageDetails(messageId, message));
  }

}
class TopicToFuncSubscription extends Subscription {
  encodeMessage(messageId, message) {
    return JSON.stringify({
      Records: [{
        EventVersion: '1.0',
        EventSource: 'aws:sns',
        Sns: this.origin.formatMessageDetails(messageId, message),
      }]
    });
  }
}


module.exports = {
  Subscription,
  QueueToFuncSubscription,
  TopicToQueueSubscription,
  TopicToFuncSubscription,
};
