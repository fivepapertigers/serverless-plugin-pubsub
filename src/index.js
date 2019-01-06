/**
 * A plugin for easier publish/subscribe patterns in the serverless framework
 */


const Promise = require('bluebird');

const { logWarning } = require('serverless/lib/classes/Error');

class ServerlessPluginPubSub {

  /**
   * Setup plugin using the standard plugin constructor
   */
  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options;
    this.naming = this.serverless.provider('aws').naming;

    // Note: getQueueLogicalId gets the event source mapping logical Id
    this.naming.getActualQueueLogicalId = (queueName) =>
        `SQSQueue${this.normalizeNameToAlphaNumericOnly(queueName)}`;

    this.naming.getQueueSubscriptionLogicalId = (topicName, queueName) =>
        `${this.getActualQueueLogicalId(queueName)}To${this.getTopicLogicalId(topicName)}Subscription`;

    this.commands = {};
    this.hooks = {
      'before:aws:package:finalize:mergeCustomProviderResources': this.generateResources.bind(this),
    };
  }



  /**
   * Generates custom resources for pubSub
   */
  generateResources(){
    const funcs = this.serverless.service.functions;
    const serviceResources = this.serverless.service.resources;


    const pubSubResources = {};
    const createTopicIfNotExists = (topicName) => {
        const topicLogicalId = this.naming.getTopicLogicalId(topicName);
        if (!pubSubResources[topicLogicalId]) {
            pubSubResources[topicLogicalId] = this.generateTopicResource(topicName);
        }
    };

    const createQueueIfNotExists = (queueName, warn) => {
        const queueLogicalId = this.naming.getActualQueueLogicalId(queueName);
        // If the queue has already been created, that indicates it has
        // multiple subscriptions, and we warn about competing polling.

        if (pubSubResources[queueLogicalId]) {
            if (warn) {
                logWarning(`[PubSub] ${queueName} has multiple subscriber functions that will compete for messages. Ignore this warning if that is intentional.`);
            }
        } else {
            pubSubResources[queueLogicalId] = this.generateQueueResource(queueName);
        }
    };

    const allowQueueSubscription = (topicName, queueName) => {
        const topicLogicalId = this.naming.getTopicLogicalId(topicName);
        const queueLogicalId = this.naming.getActualQueueLogicalId(queueName);
        const policy = pubSubResources.SNSToSQSPolicy || {
            Type: 'AWS::SQS::QueuePolicy',
            Properties: {
                Queues: [],
                PolicyDocument: {
                    Version: '2012-10-17',
                    Statement: [],
                }
            }
        };
        pubSubResources.SNSToSQSPolicy = policy;
        if (!policy.Properties.Queues.find(q => q.Ref === queueLogicalId)) {
            policy.Properties.Queues.push({Ref: queueLogicalId});
        }

        if (!policy.Properties.PolicyDocument.Statement.find(s => s.Condition.ArnEquals['aws:SourceArn'].Ref === topicLogicalId)) {
            policy.Properties.PolicyDocument.Statement.push({
                Effect: 'Allow',
                Principal: '*',
                Action: 'sqs:SendMessage',
                Resource: '*',
                Condition: {ArnEquals: {'aws:SourceArn': {Ref: topicLogicalId}}}
            });
        }

    };

    for (let funcKey in funcs) {
        const func = funcs[funcKey];
        for (let idx = 0; idx < (func.events || []).length; idx++) {
            let evt = func.events[idx],
                topic,
                queue = false,
                subscription,
                subLogicalId;
            // Skip events that are not pubSub
            if (!evt || !evt.pubSub) {
                continue;
            }


            // Pull pubsub config from event
            const {pubSub} = evt;

            // pubSub may be set to a string, in which case, we interpret
            // that as the topic name (and assume no queue config)
            if (typeof pubSub === 'string') {
                topic = pubSub;
            // If not, we pull topic and queue from their respective config
            } else {
                topic = pubSub.topic;
                queue = pubSub.queue;
                subscription = pubSub.subscription;
            }

            if (!topic) {
                throw Error(`No topic could be identified for pubSub subscription to ${funcKey}`);
            }

            createTopicIfNotExists(topic);

            if (queue) {
                let sourceMapping = {};
                if (queue === true) {
                    queue = `${funcKey}-queue`;
                } else if (typeof queue !== 'string') {
                    let {name, batchSize, enabled, startingPosition} = queue;
                    queue = name;
                    if (batchSize !== undefined) {
                        sourceMapping.BatchSize = batchSize;
                    }
                    if (enabled !== undefined) {
                        // Cast to string if boolean provided
                        if (typeof enabled === 'boolean') {
                            enabled = enabled ? 'True' : 'False';
                        }
                        sourceMapping.Enabled = enabled;
                    }
                    if (startingPosition !== undefined) {
                        sourceMapping.StartingPosition = startingPosition;
                    }
                }

                if (!queue) {
                    throw Error(`[PubSub] Invalid queue name for function ${funcKey} / topic ${topic}`);
                }

                // Generate the queue CFM resource if it doesn't already exist
                createQueueIfNotExists(queue, true);
                const evtSrcLogicalId = this.naming.getQueueLogicalId;
                pubSubResources[evtSrcLogicalId] = this.generateQueueEventMapping(queue, funcKey, sourceMapping);

                subLogicalId = this.getQueueSubscriptionLogicalId(topic, queue);
                pubSubResources[subLogicalId] = this.generateQueueSubscription(topic, queue, subscription);
                allowQueueSubscription(topic, queue);
            } else {
                subLogicalId = this.naming.getLambdaSnsSubscriptionLogicalId(funcKey, topic);
                pubSubResources[subLogicalId] =
                    this.generateLambdaSubscription(topic, funcKey, subscription);
            }

        }
    }

    // Create any orphaned topics
    for (let topic in this.topics) {
        createTopicIfNotExists(topic);
    }

    // Create any orphaned queues
    for (let queue in this.queues) {
        createQueueIfNotExists(queue, false);
    }

    Object.assign(serviceResources, pubSubResources);
    return Promise.resolve();
  }

  generateQueueEventMapping(queue, func, propOverrides) {
    const props = {
        EventSourceArn: {'Fn::GetAtt': [this.naming.getActualQueueLogicalId(queue), 'Arn']},
        FunctionName: {Ref: this.naming.getLambdaLogicalId(func)},
        Enabled: 'True',
        BatchSize: 10,
    };
    return {
        Type: 'AWS::Lambda::EventSourceMapping',
        Properties: Object.assign(props, propOverrides)
    };
  }

  generateQueueSubscription(topic, queue, propOverrides) {
    const props = {
        TopicArn: {Ref: this.naming.getTopicLogicalId(topic)},
        Protocol: 'sqs',
        Endpoint: {'Fn::GetAtt': [this.naming.getActualQueueLogicalId(queue), 'Arn']},
    };
    return {
        Type: 'AWS::SNS::Subscription',
        Properties: Object.assign(props, propOverrides)
    };
  }

  generateLambdaSubscription(topic, func, propOverrides) {
    const props = {
        TopicArn: {Ref: this.naming.getTopicLogicalId(topic)},
        Protocol: 'lambda',
        Endpoint: {'Fn::GetAtt': [this.naming.getLambdaLogicalId(func), 'Arn']},
    };
    return {
        Type: 'AWS::SNS::Subscription',
        Properties: Object.assign(props, propOverrides)
    };
  }

  generateQueueResource(queue) {
    const propOverrides = this.queueConfig(queue);
    const props = {
        QueueName: queue
    };

    return {
        Type: 'AWS::SQS::Queue',
        Properties: Object.assign(props, propOverrides),
    };

  }

  generateTopicResource(topic) {
    const propOverrides = this.topicConfig(topic);
    const props = {
        TopicName: topic
    };

    return {
        Type: 'AWS::SNS::Topic',
        Properties: Object.assign(props, propOverrides),
    };

  }

  get config () {
    return (
        this.serverless.service.custom
        && this.serverless.service.custom
        && this.serverless.custom.pubSub
    ) || {};
  }

  get topics () {
    return (this.config && this.config.topics) || {};
  }

  topicConfig(topicName) {
    return this.topics[topicName] || {};
  }

  queueConfig(queueName) {
    return this.queues[queueName] || {};
  }
}


module.exports = ServerlessPluginPubSub;
