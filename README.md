# Serverless PubSub

Simple pub/sub configuration with queuing for the Serverless Framework

## Motivation

[Publish/subscribe](https://en.wikipedia.org/wiki/Publish%E2%80%93subscribe_pattern) is a pattern used in message mediated architectures that is meant to decouple logical units in a codebase or software system. Serverless computing, or more specifically, Function-as-a-Service computing, caters rather well to a messaging infrastructure, since "serverless" functions are configured and priced to be ephemeral units of execution that allow for easy chaining.

Many of the major platforms offer their own tooling and services for implementing pub/sub in your serverless stacks. In the AWS landscape, pub/sub is made possible through the Simple Notification Service, which exposes topics to which functions can either publish or subscribe. As one of AWS's older offerings, SNS is well-understood, feature-rich, and has a native integration with the Serverless framework.

However, there are a number of headaches that one encounters when using SNS as a serverless pub/sub engine, particularly when used with the Serverless framework:

- Permissions for publishers (and sometimes for subscribers) must be configured manually, either on a topic-by-topic basis or using wildcarding
- Queuing (through SQS) is an absolute nightmare to set up in conjunction with SNS
- The Serverless configuration inevitably ends up littered with verbose intrinsic Cloudformation functions
- The Serverless Cloudformation logical ID normalization process leads to confused configuration, where references to topics on one line look very different than references to the same topic in another line
- Redundant, last-in-wins, declarations of topic configuration
- Absence of a local runtime for testing pub/sub functions

With those limitations in mind, this plugin aims to provide the following for those looking to implement easy and readable pub/sub into their configurations:

- Consistent naming of topics across the configuration
- Easy injection of topic Arns into a function's runtime environment
- Common configuration of shared topic configuration in a single location
- Easy queuing configuration for throttling incoming messages using Amazon SQS
- Simple creation of topics, even if they do not have subscribers
- Syntax that blends in seamlessly by following commonly used Serverless config syntaxes
- A high-degree of customization, when desired, so that the developer can take advantage of all the features AWS has to offer
- Automatic permission generation that aims for least-privilege topic/queue/function access (no wild-carding!)
- A [local runtime](#offline-mode) for executing pub/sub functions

## Installation

Install the plugin with:

```console
npm install --save-dev serverless-plugin-pubsub
```

And add the following to your Serverless confing:

```yaml
plugins:
  - serverless-plugin-pubsub
```

## Usage

### Subscriber

#### Topics

To add a pub/sub event, simply use the `pubSub` event syntax on a new or existing function. In its simplest form, all you need to provide is a topic name:

```yaml
functions:
  myTopicConsumer:
    handler: mymodule.myhandler
    events:
      - pubSub: my-first-topic
```

You can also use the `topic` key to provide the name:

```yaml
functions:
  myTopicConsumer:
    handler: mymodule.myhandler
    events:
      - pubSub:
          topic: my-first-topic
```

#### External Topics

You may also have need to subscribe to a topic that is managed outside of this service. For this use-case, simply provide a hard coded `arn` value for the topic (in addition to a unique topic `name`).

```yaml
functions:
  myExternalTopicConsumer:
    handler: mymodule.myhandler
    events:
      - pubSub:
          topic:
            name: my-external-topic
            arn: arn:aws:sns:us-east-1:12345:my-external-topic
            # You may also use intrinsic functions as well:
            # arn:
            #   Fn::Join
            #     - ':'
            #     - - arn:aws:sns:us-east-1
            #       - AWS::AccountId
            #       - my-external-topic
          queue: true
```

#### Queues

It is often advantageous to have a message queue as an intermediary between your topic and your function. This can be used to throttle message activity (using reserved function concurrency) or toggle message consumption without losing incoming messages.

To place a queue as an intermediary between your topic and your function, simply set the `queue` or `queue.name` parameter to `true` (it is `false`, by default) or to the desired name of the queue. If you do not specify a queue name, one will be generated based on the function name.

```yaml
functions:
  myTopicConsumer:
    handler: mymodule.myhandler
    events:
      - pubSub:
          topic: my-first-topic
          queue: true # resolves to myTopicConsumer-queue
```


### Publisher

To inject a SNS topic Arn into the runtime environment of a function, simply use the `${pubSubTopic:<topic key>}` syntax in the `environment` section of the function config.

```yaml
functions:
  myPublisher:
    handler: mymodule.myhandler
    environment:
      PUBLISH_TOPIC_ARN: ${pubSubTopic:my-first-topic}
```

In the Lambda runtime, this will resolve as the SNS Topic Arn. The following is an example of using in a NodeJS publisher:

```javascript
//handler.js
const AWS = require('aws-sdk');

const SNS = new AWS.SNS();

module.exports = {
  handler: async () => {
    await SNS.publish({
      Message: 'hello world',
      TopicArn: process.env.PUBLISH_TOPIC_ARN // e.g. arn:aws:sns:us-east-1:123456789:my-first-topic
    }).promise()
  }
};
```


Note: if a topic is referenced with the `pubSubTopic` anywhere in the stack, it will be created as a part of the stack regardless of whether it has a corresponding subscriber. This allows for a lot of important configurations, such as cross-service subscription and future extensibility, and it ensures your Lambda doesn't fail trying to publish to a non-existent topic.

### Advanced Configuration

More detailed CloudFormation configuration can be added to both topics and queues in order to tweak the performance or behavior of the service. These are configured in the `custom` section of the serverless configuration, and _not_ at the `function` level. This ensures that if a topic or queue is referenced in multiple places, they will be deployed using only one configuration. The `topic` and `queue` accept parameters for `AWS::SNS::Topic` and `AWS::SQS::Queue` respectively.

```yaml
functions:
  myTopicConsumer:
    handler: mymodule.myhandler
    events:
      - pubSub:
          topic: my-first-topic
          queue: myTopicConsumer-queue
  myPublisher:
    handler: mymodule.myhandler
    environment:
      PUBLISH_TOPIC_ARN: ${pubSubTopic:my-first-topic}

custom:
  pubSub:
    topics:
      my-first-topic:
        DisplayName: MyFirstTopic
    queues:
      myTopicConsumer-queue:
        MessageRetentionPeriod: 60
```


Cloudformation configuration can also be added to the topic/queue _subscriptions_, by using the `subscription` keyword. This _should_ be specified at the `functions` since a subscription is inherently unique. The `topic.subscription` and `queue.subscription` accept Cloudformation properties for `AWS::SNS::Subscription` and `AWS::Lambda::EventSourceMapping` respectively. Note that if a queue is not specified, the `AWS::SNS::Subscription` will use the `lambda` protocol, not the `sqs` protocol.

```
functions:
  myTopicConsumer:
    handler: mymodule.myhandler
    events:
      - pubSub:
          topic:
            name: my-first-topic
            subscription:
              DeliveryPolicy:
                throttlePolicy:
                  maxReceivesPerSecond: 3
          queue:
            name: myTopicConsumer-queue
            subscription:
              BatchSize: 1
```

It is often the case that you want to set default values for Cloudformation configuration across the entire service. You can do that using `custom.pubSub.defaults.(queues|topics|queueSubscriptions|topicSubscriptions)`. Note that defaults will be overwritten if defined at the resource level.

```
custom:
  pubSub:
    defaults:
      topics:
        KmsMasterKeyId: my-key-id
      queues:
        MessageRetentionPeriod: 60
      queueSubscriptions:
        BatchSize: 1
      topicSubscriptions:
        DeliveryPolicy:
          throttlePolicy:
            maxReceivesPerSecond: 3
```

## Offline Mode

This plugin features an offline mode, which spins up a local server for testing your integration offline:

```console
serverless pubSub offline
```

The command setups up a mock SNS server to receive SNS::Publish requests and directs them to the configured pubSub functions using `serverless invoke local`.

Additionally, when the plugin is installed, the `SNS_ENDPOINT_URL` variable will be injected into the runtime environment for publishing to the mock SNS server. You can use this to direct an AWS SDK to use this SNS endpoint instead of the real one.

```javascript
const AWS = require('aws-sdk');

const SNS_ENDPOINT_URL = process.env.SNS_ENDPOINT_URL || undefined;
const SNS = new AWS.SNS({endpoint: SNS_ENDPOINT_URL});
```

The following options are configurable under `custom.pubSub.offline`:

- `host` the host name of the server _(default: localhost)_
- `port` the port where the server should be exposed _(default: 3100)_


## Contributing

Please open a Github issue with any bug reports or feature suggestions.

Feel free to open a pull request with any additions or enhancements. A failing test would be appreciated to understand the issue better and prevent it from recurring in the future.

To install:

```console
npm install
```

To run tests:
```console
npm test
# or
npm test --- --watch
```
