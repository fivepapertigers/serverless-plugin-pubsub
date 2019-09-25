/**
 * Topic model
 */

const PubSub = require('pubsub-js');

const Subscription = require('./subscription');
const logger = require('../logger');

class Topic {

  constructor({name, vendorConfig, arn = null}) {
    this.name = name;
    this.vendorConfig = vendorConfig;
    this.subscriptions = [];
    this.type = 'topic';
    this.arn = arn;
  }

  addSubscriber(subscriber, config) {
    const subscription = new Subscription(this, subscriber, config);
    this.subscriptions.push(subscription);
    return subscription;
  }


  publish(messageId, message) {
    PubSub.publish(this.name, {message: message, messageId: messageId});
  }

  formatMessageDetails(messageId, message) {
    return {
      SignatureVersion: '1',
      Timestamp: (new Date()).toISOString(),
      Signature: 'EXAMPLE',
      SigningCertUrl: 'EXAMPLE',
      MessageId: messageId,
      Message: message,
      MessageAttributes: {},
      Type: 'Notification',
      UnsubscribeUrl: 'EXAMPLE',
      TopicArn: `arn:aws:sns:us-east-1:1234567890123:${this.name}`,
      Subject: 'TestInvoke'
    };
  }

  log(message) {
    logger.log(message, ['Topic', this.name]);
  }
}


module.exports = Topic;
